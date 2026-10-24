# Laboratoire de stratégies (or / XAUUSD) : cherche s'il existe un avantage RÉEL après coûts, en évitant de se tromper soi-même.
#   python labo.py --csv F:\Jarvis\trading\donnees\XAUUSD.vx_H1.csv --sortie F:\Jarvis\trading\rapports [--spread 0.33] [--slip 0.10]
# Protocole (chaque garde-fou existe parce que ce piège est classique) :
#   1. les données sont coupées dans le temps : ENTRAÎNEMENT (50 %), VALIDATION (25 %), TEST (25 %) ; on choisit sur l'entraînement, on confirme sur la validation, et le TEST n'est regardé qu'UNE fois ;
#   2. les COÛTS sont réels (spread + glissement à l'entrée ET à la sortie) ; ordre décidé à la clôture, exécuté à l'ouverture suivante (aucun regard vers le futur) ; si stop et objectif tombent dans la même bougie : le stop gagne ;
#   3. CONTRÔLE DE DÉRIVE : l'or a beaucoup monté, donc presque toute stratégie qui achète « marche ». On refait le test sur des prix SANS tendance : sans avantage réel, le résultat s'effondre ;
#   4. les coûts (spread, glissement ET frais de nuit / swap du courtier) sont majorés de 50 % (résistance aux mauvaises conditions) ;
#   5. TEST DE HASARD : le même nombre de signaux est décalé au hasard dans le temps ; un vrai avantage doit battre le hasard, avec un seuil CORRIGÉ du nombre de règles présentées (5 % / nombre de règles) ;
#   6. le nombre de combinaisons essayées est affiché : plus on essaie, plus on trouve du hasard.
import argparse, json, math, os, sys
from datetime import datetime
import numpy as np
import pandas as pd

FAMILLES = ('donchian', 'ema', 'rsi')

# ---------------------------------------------------------------- indicateurs
def atr(h, l, c, n=14):
    pc = np.roll(c, 1); pc[0] = c[0]
    tr = np.maximum(h - l, np.maximum(np.abs(h - pc), np.abs(l - pc)))
    return pd.Series(tr).rolling(n).mean().values

def rsi(c, n):
    d = np.diff(c, prepend=c[0]); g = np.where(d > 0, d, 0.0); p = np.where(d < 0, -d, 0.0)
    ag = pd.Series(g).ewm(alpha=1 / n, adjust=False).mean().values; ap = pd.Series(p).ewm(alpha=1 / n, adjust=False).mean().values
    with np.errstate(divide='ignore', invalid='ignore'):
        r = 100 - 100 / (1 + ag / ap)
    return np.where(ap == 0, 100.0, r)

class Prix:
    """OHLC + indicateurs mis en cache (calculés sur la série COMPLÈTE avec des données passées seulement)."""
    def __init__(self, o, h, l, c, poids=None):
        self.o, self.h, self.l, self.c = (np.asarray(x, dtype=float) for x in (o, h, l, c)); self.a = atr(self.h, self.l, self.c); self._k = {}; self.poids = poids
    def cache(self, cle, f):
        if cle not in self._k: self._k[cle] = f()
        return self._k[cle]
    def signaux(self, fam, p):
        """-> (entrees[+1/-1/0], sortie_longue[bool], sortie_courte[bool]) décidés à la CLÔTURE de la bougie i."""
        n = len(self.c); vide = np.zeros(n, dtype=bool)
        if fam == 'donchian':
            N = p['N']
            hh = self.cache(('hh', N), lambda: pd.Series(self.h).rolling(N).max().shift(1).values); ll = self.cache(('ll', N), lambda: pd.Series(self.l).rolling(N).min().shift(1).values)
            with np.errstate(invalid='ignore'):
                e = np.where(self.c > hh, 1, np.where(self.c < ll, -1, 0))
            return e, vide, vide
        if fam == 'ema':
            f = self.cache(('ema', p['rapide']), lambda: pd.Series(self.c).ewm(span=p['rapide'], adjust=False).mean().values); s = self.cache(('ema', p['lente']), lambda: pd.Series(self.c).ewm(span=p['lente'], adjust=False).mean().values)
            t = np.where(f > s, 1, -1); e = np.zeros(n, dtype=int); e[1:] = np.where(t[1:] != t[:-1], t[1:], 0); e[:p['lente']] = 0
            return e, t < 0, t > 0
        if fam == 'rsi':
            r = self.cache(('rsi', p['n']), lambda: rsi(self.c, p['n']))
            e = np.where(r < p['bas'], 1, np.where(r > p['haut'], -1, 0)); e[:p['n'] * 3] = 0
            return e, r >= 50, r <= 50
        raise ValueError(fam)

def grille():
    g = []
    for N in (10, 20, 40, 80, 120):
        for ks in (1.5, 2.5):
            for kc in (None, 4.0):
                for mb in (48, 120): g.append(('donchian', {'N': N}, ks, kc, mb))
    for rap, len_ in ((8, 21), (12, 48), (20, 100), (50, 200)):
        for ks in (2.0, 3.0): g.append(('ema', {'rapide': rap, 'lente': len_}, ks, None, 500))
    for n_, bas, haut in ((14, 30, 70), (14, 25, 75), (7, 20, 80), (5, 15, 85)):
        for ks in (2.0, 3.0):
            for mb in (24, 48): g.append(('rsi', {'n': n_, 'bas': bas, 'haut': haut}, ks, None, mb))
    return g

def nom(cfg):
    fam, p, ks, kc, mb = cfg
    pp = ', '.join(f'{k}={v}' for k, v in p.items())
    return f"{fam}({pp}) stop {ks}×ATR" + (f" objectif {kc}×ATR" if kc else '') + f" max {mb} bougies"

# ---------------------------------------------------------------- moteur de simulation
def simuler(o, h, l, c, a, entrees, sortie_l, sortie_s, k_stop, k_cible, max_barres, demi, poids=None, swap=(0.0, 0.0, 0.0, 0.0)):
    """Un seul lot d'une once. demi = demi-spread + glissement, payé à l'entrée ET à la sortie. Renvoie la liste des gains/pertes NETS (en dollars par once)."""
    n = len(o); pnl = []; pos = 0; entree = stop = cible = 0.0; barres = 0; nuits = 0.0
    sw_l, sw_s, rel_l, rel_s = swap                              # frais de nuit par unité : fixes (prix) + proportionnels au prix d'entrée, pour un achat / une vente
    def nuit(p_, e_, nb): return nb * ((sw_l + rel_l * e_) if p_ == 1 else (sw_s + rel_s * e_))
    for i in range(1, n):
        if pos != 0 and poids is not None: nuits += poids[i]      # rollovers franchis depuis l'entrée (mercredi = x3 pour l'or)
        if pos != 0 and ((pos == 1 and sortie_l[i - 1]) or (pos == -1 and sortie_s[i - 1])):        # signal de sortie décidé à la clôture précédente : sortie à l'ouverture
            pnl.append(pos * ((o[i] - pos * demi) - entree) - nuit(pos, entree, nuits)); pos = 0; continue
        neuf = False
        if pos == 0:
            s = entrees[i - 1]
            if s != 0 and not math.isnan(a[i - 1]) and a[i - 1] > 0:
                pos = int(s); entree = o[i] + pos * demi; stop = entree - pos * k_stop * a[i - 1]; cible = entree + pos * k_cible * a[i - 1] if k_cible else None; barres = 0; neuf = True; nuits = 0.0
        if pos != 0:
            barres += 1
            if pos == 1: touche_stop = l[i] <= stop; touche_cible = cible is not None and h[i] >= cible
            else: touche_stop = h[i] >= stop; touche_cible = cible is not None and l[i] <= cible
            sortie = None
            if touche_stop: sortie = (o[i] if (not neuf and ((pos == 1 and o[i] <= stop) or (pos == -1 and o[i] >= stop))) else stop)          # le stop l'emporte si les deux tombent dans la même bougie
            elif touche_cible: sortie = (o[i] if (not neuf and ((pos == 1 and o[i] >= cible) or (pos == -1 and o[i] <= cible))) else cible)
            elif barres >= max_barres: sortie = c[i]
            if sortie is not None:
                pnl.append(pos * ((sortie - pos * demi) - entree) - nuit(pos, entree, nuits)); pos = 0
    if pos != 0: pnl.append(pos * ((c[-1] - pos * demi) - entree) - nuit(pos, entree, nuits))
    return pnl

def metriques(pnl):
    n = len(pnl)
    if n == 0: return {'n': 0, 'net': 0.0, 'moyenne': 0.0, 'gagnants': 0.0, 'pf': 0.0, 'dd_max': 0.0}
    g = sum(x for x in pnl if x > 0); pe = -sum(x for x in pnl if x < 0); cum = np.cumsum(pnl)
    pf = 99.0 if pe == 0 and g > 0 else (g / pe if pe > 0 else 0.0)
    return {'n': n, 'net': round(float(cum[-1]), 2), 'moyenne': round(float(cum[-1]) / n, 3), 'gagnants': round(sum(1 for x in pnl if x > 0) / n, 3), 'pf': round(min(pf, 99.0), 3), 'dd_max': round(float(np.max(np.maximum.accumulate(cum) - cum)), 2)}

def lancer(P, cfg, seg, demi, decal=0, swap=(0.0, 0.0, 0.0, 0.0)):
    fam, p, ks, kc, mb = cfg; a, b = seg
    e, sl, ss = P.signaux(fam, p)
    e, sl, ss = e[a:b], sl[a:b], ss[a:b]
    if decal: e, sl, ss = np.roll(e, decal), np.roll(sl, decal), np.roll(ss, decal)
    return simuler(P.o[a:b], P.h[a:b], P.l[a:b], P.c[a:b], P.a[a:b], e, sl, ss, ks, kc, mb, demi, None if P.poids is None else P.poids[a:b], swap)

def sans_tendance(P):
    """Mêmes bougies, mais la tendance de fond est retirée : un buy & hold y vaut ~0. Sert à démasquer les stratégies qui ne font que profiter de la hausse."""
    n = len(P.c); mu = float(np.mean(np.diff(np.log(P.c)))); f = np.exp(-mu * np.arange(n))
    return Prix(P.o * f, P.h * f, P.l * f, P.c * f, P.poids)

def poids_nuits(temps, vingt_quatre_sept, triple_jour=3):
    """Poids du rollover franchi en ENTRANT dans chaque bougie : 1 par nuit ; pour un marché fermé le week-end, le mercredi vaut 3 (il couvre le week-end) et vendredi / samedi / dimanche 0.
    triple_jour : convention MetaTrader (0 = dimanche ... 3 = mercredi). Marché 24/7 (crypto) : 1 chaque nuit, aucun triple."""
    t = pd.DatetimeIndex(pd.to_datetime(temps)); jours = t.normalize().values; n = len(t); w = np.zeros(n)          # accepte une liste, un index ou la colonne d'un tableau
    for i in range(1, n):
        if jours[i] != jours[i - 1]:
            wd = pd.Timestamp(jours[i - 1]).weekday()                    # jour qui se termine (0 = lundi ... 6 = dimanche)
            if vingt_quatre_sept: w[i] = 1.0
            else:
                mt5_wd = (wd + 1) % 7                                     # convention MT5 : 0 = dimanche
                w[i] = 3.0 if mt5_wd == triple_jour else (0.0 if wd >= 4 else 1.0)
    return w

def swap_par_unite(info, prix_ref):
    """Convertit le swap du courtier en (fixe par unité et par nuit, proportion du prix par nuit) pour un achat et une vente. Renvoie (swap, avertissement)."""
    mode = int(info.get('swap_mode', 0)); sl, ss = float(info.get('swap_long', 0)), float(info.get('swap_short', 0)); pt = float(info.get('point', 0.01)); ct = float(info.get('taille_contrat', 1)) or 1.0
    if mode == 0: return (0.0, 0.0, 0.0, 0.0), None
    if mode == 1: return (-sl * pt, -ss * pt, 0.0, 0.0), None                                  # en points
    if mode in (2, 3, 4): return (-sl / ct, -ss / ct, 0.0, 0.0), None                          # en monnaie par lot
    if mode == 5: return (0.0, 0.0, -sl / 100 / 365, -ss / 100 / 365), None                    # intérêt annuel en % de la valeur
    return (0.0, 0.0, 0.0, 0.0), f'mode de swap {mode} non géré : frais de nuit ignorés'

# ---------------------------------------------------------------- l'étude complète
def etude(df, spread=0.33, slip=0.10, n_perm=400, seed=0, unite='H1', alpha=0.05, swap_info=None, symbole=''):
    rng = np.random.default_rng(seed)
    ts = df['time']; jours_we = pd.to_datetime(ts).dt.weekday >= 5; v7 = bool(jours_we.mean() > 0.05)
    info = swap_info or {}; poids = poids_nuits(ts, v7, int(info.get('swap_triple_jour', 3))) if info else None
    P = Prix(df['open'], df['high'], df['low'], df['close'], poids); D = sans_tendance(P); n = len(P.c)
    swap, avert_swap = swap_par_unite(info, float(np.median(P.c))) if info else ((0.0, 0.0, 0.0, 0.0), 'frais de nuit non fournis : ignorés')
    i1, i2 = int(n * 0.5), int(n * 0.75)
    seg = {'entrainement': (0, i1), 'validation': (i1, i2), 'test': (i2, n)}
    demi = spread / 2 + slip; demi15 = demi * 1.5; swap15 = tuple(x * 1.5 for x in swap)
    tests = grille(); res = {'n_tests': len(tests), 'candidats': [], 'retenus_validation': [], 'familles': {}}
    bh = {k: round(float(P.c[b - 1] - P.c[a]) - 2 * demi, 2) for k, (a, b) in seg.items()}
    # étape 1 : entraînement
    train = [(cfg, metriques(lancer(P, cfg, seg['entrainement'], demi, swap=swap))) for cfg in tests]
    finalistes = []
    for fam in FAMILLES:
        ok = sorted([(c, m) for c, m in train if c[0] == fam and m['n'] >= 30 and m['net'] > 0], key=lambda x: -x[1]['pf'])[:1]                 # UN seul finaliste par famille : chaque finaliste supplémentaire est une chance de plus de se tromper
        res['familles'][fam] = {'meilleur_entrainement': ({'strategie': nom(ok[0][0]), 'entrainement': ok[0][1]} if ok else None), 'nb_correctes_entrainement': len([1 for c, m in train if c[0] == fam and m['n'] >= 30 and m['net'] > 0])}
        finalistes += ok
    # étape 2 : validation (confirmation sur des données jamais utilisées pour choisir)
    gardes = []
    for cfg, mt in finalistes:
        mv = metriques(lancer(P, cfg, seg['validation'], demi, swap=swap))
        if mv['n'] >= 15 and mv['net'] > 0 and mv['pf'] >= 1.15: gardes.append((cfg, mt, mv))
    res['retenus_validation'] = [{'strategie': nom(c), 'entrainement': mt, 'validation': mv} for c, mt, mv in gardes]
    # étape 3 : test (une seule fois) + contrôles. Seuil de hasard CORRIGÉ du nombre de règles présentées au test (Bonferroni) : présenter 3 règles = 3 chances de se tromper.
    seuil_p = alpha / max(1, len(gardes)); res['seuil_hasard'] = round(seuil_p, 4)
    for cfg, mt, mv in gardes:
        mtest = metriques(lancer(P, cfg, seg['test'], demi, swap=swap)); mdet = metriques(lancer(D, cfg, seg['test'], demi, swap=swap)); mc15 = metriques(lancer(P, cfg, seg['test'], demi15, swap=swap15))
        a, b = seg['test']; sup = 0
        for _ in range(n_perm):
            k = int(rng.integers(50, max(51, (b - a) - 50)))
            if sum(lancer(P, cfg, seg['test'], demi, decal=k, swap=swap)) >= mtest['net']: sup += 1
        p_val = (1 + sup) / (1 + n_perm)
        c = {'strategie': nom(cfg), 'famille': cfg[0], 'entrainement': mt, 'validation': mv, 'test': mtest, 'test_sans_tendance': mdet, 'test_couts_x1_5': mc15, 'p_hasard': round(p_val, 3)}
        c['raisons_echec'] = [r for ok_, r in (
            (mtest['n'] >= 15, 'trop peu de transactions sur le test'), (mtest['net'] > 0 and mtest['pf'] >= 1.1, 'test : facteur de profit < 1,1'),
            (mdet['pf'] >= 1.05 and mdet['net'] > 0, "s'effondre sans la tendance de fond (profite de la hausse)"), (mc15['pf'] >= 1.0 and mc15['net'] > 0, 'ne résiste pas à des coûts majorés de 50 %'),
            (p_val <= seuil_p, f'ne bat pas le hasard (p = {p_val:.3f} > seuil corrigé {seuil_p:.3f})')) if not ok_]
        c['candidat'] = not c['raisons_echec']
        if c['candidat']: res['candidats'].append(c)
        res.setdefault('examines_test', []).append(c)
    res['buy_hold_net_par_once'] = bh
    res['segments'] = {k: {'debut': str(df['time'].iloc[a])[:10], 'fin': str(df['time'].iloc[b - 1])[:10], 'barres': b - a} for k, (a, b) in seg.items()}
    res['donnees'] = {'barres': n, 'debut': str(df['time'].iloc[0])[:16], 'fin': str(df['time'].iloc[-1])[:16], 'unite': unite}
    res['couts'] = {'spread': round(spread, 4), 'glissement_par_cote': round(slip, 4), 'cout_aller_retour': round(spread + 2 * slip, 2), 'frais_de_nuit': {'achat_par_nuit': round(swap[0] + swap[2] * float(np.median(P.c)), 4), 'vente_par_nuit': round(swap[1] + swap[3] * float(np.median(P.c)), 4), 'marche_24_7': v7}}
    res['symbole'] = symbole
    res['verdict'] = ((f"{len(res['candidats'])} candidat(s) ont passé TOUS les contrôles. Ce n'est PAS une preuve : à confirmer en suivi réel sur le compte démo (petites tailles) avant toute confiance.") if res['candidats']
                      else "Aucun avantage fiable trouvé après coûts. C'est le résultat NORMAL : la plupart des règles simples n'ont pas d'avantage réel. Jarvis ne passera PAS d'ordres sur cette base.")
    res['avertissements'] = ([avert_swap] if avert_swap else []) + [f"{len(tests)} combinaisons essayées : plus on essaie, plus on trouve du hasard ; c'est pourquoi le test n'est regardé qu'une fois et doit battre le hasard.",
                             "L'or a beaucoup monté sur la période : le contrôle « sans tendance » démasque les stratégies qui ne font qu'acheter.",
                             "Un backtest n'est jamais une garantie : les conditions de marché changent, et l'exécution réelle est moins favorable que la simulation."]
    return res

def rapport_md(r):
    L = [f"# Étude de stratégies — {r.get('symbole') or 'or'} ({r['donnees']['unite']})", '',
         f"Données : {r['donnees']['barres']} bougies du {r['donnees']['debut']} au {r['donnees']['fin']}. Coût d'un aller-retour : {r['couts']['cout_aller_retour']} $ par unité (spread {r['couts']['spread']} + glissement {r['couts']['glissement_par_cote']} ×2). Frais de nuit : achat {r['couts']['frais_de_nuit']['achat_par_nuit']} $ / vente {r['couts']['frais_de_nuit']['vente_par_nuit']} $ par unité et par nuit (positif = coût, négatif = gain).", '',
         '## Verdict', '', r['verdict'], '', '## Périodes', '']
    for k, s in r['segments'].items(): L.append(f"- {k} : {s['debut']} → {s['fin']} ({s['barres']} bougies) — buy & hold : {r['buy_hold_net_par_once'][k]} $/once")
    L += ['', f"## Ce qui a été essayé ({r['n_tests']} combinaisons)", '']
    for fam, f in r['familles'].items():
        m = f['meilleur_entrainement']
        L.append(f"- **{fam}** : {f['nb_correctes_entrainement']} réglages rentables à l'entraînement" + (f" ; meilleur : {m['strategie']} (facteur de profit {m['entrainement']['pf']}, {m['entrainement']['n']} transactions)" if m else ''))
    L += ['', f"## Confirmés sur la validation : {len(r['retenus_validation'])}", '']
    for x in r.get('examines_test', []):
        t = x['test']; L += [f"### {x['strategie']}", f"- entraînement : PF {x['entrainement']['pf']}, net {x['entrainement']['net']} $ ({x['entrainement']['n']} tr.) · validation : PF {x['validation']['pf']}, net {x['validation']['net']} $",
                             f"- **test** : PF {t['pf']}, net {t['net']} $/once, {t['n']} transactions, {int(t['gagnants'] * 100)} % gagnantes, baisse max {t['dd_max']} $",
                             f"- sans tendance : PF {x['test_sans_tendance']['pf']} · coûts +50 % : PF {x['test_couts_x1_5']['pf']} · probabilité de hasard : {x['p_hasard']} (seuil corrigé : {r.get('seuil_hasard')})",
                             ('- ✅ **candidat** (tous les contrôles passés)' if x['candidat'] else '- ❌ écarté : ' + ' ; '.join(x['raisons_echec'])), '']
    if not r.get('examines_test'): L += ["Aucune règle ne s'est confirmée sur la validation : rien n'a même été présenté au test.", '']
    L += ['## À garder en tête', ''] + [f'- {a}' for a in r['avertissements']]
    return '\n'.join(L) + '\n'

def charger(csv):
    df = pd.read_csv(csv, parse_dates=['time'])
    df = df.dropna(subset=['open', 'high', 'low', 'close']).sort_values('time').reset_index(drop=True)
    return df

if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--csv', required=True); p.add_argument('--sortie', required=True); p.add_argument('--spread', type=float, default=0.33); p.add_argument('--slip', type=float, default=None); p.add_argument('--slip-rel', type=float, default=0.000025, dest='slip_rel'); p.add_argument('--symbole', default='')
    p.add_argument('--swap-mode', type=int, default=None); p.add_argument('--swap-long', type=float, default=0.0); p.add_argument('--swap-short', type=float, default=0.0); p.add_argument('--triple-jour', type=int, default=3)
    p.add_argument('--point', type=float, default=0.01); p.add_argument('--contrat', type=float, default=1.0)
    p.add_argument('--seed', type=int, default=0); p.add_argument('--perm', type=int, default=400); a = p.parse_args()
    df = charger(a.csv)
    if len(df) < 1500: print(json.dumps({'ok': False, 'raison': f'pas assez de données ({len(df)} bougies, 1500 minimum)'}, ensure_ascii=False)); sys.exit(2)
    unite = os.path.basename(a.csv).rsplit('_', 1)[-1].replace('.csv', '')
    slip = a.slip if a.slip is not None else a.slip_rel * float(np.median(df['close']))          # glissement proportionnel au prix (0,10 $ pour l'or à 4000 $)
    info = None if a.swap_mode is None else {'swap_mode': a.swap_mode, 'swap_long': a.swap_long, 'swap_short': a.swap_short, 'swap_triple_jour': a.triple_jour, 'point': a.point, 'taille_contrat': a.contrat}
    r = etude(df, a.spread, slip, a.perm, a.seed, unite, swap_info=info, symbole=a.symbole)
    os.makedirs(a.sortie, exist_ok=True)
    base = os.path.join(a.sortie, f"etude_{datetime.now().strftime('%Y-%m-%d_%H%M')}_{(a.symbole or 'XAU').split('.')[0].replace('USD', '')}_{unite}")
    with open(base + '.json', 'w', encoding='utf-8') as f: json.dump(r, f, ensure_ascii=False, indent=1)
    with open(base + '.md', 'w', encoding='utf-8') as f: f.write(rapport_md(r))
    print(json.dumps({'ok': True, 'rapport': base + '.md', 'json': base + '.json', 'verdict': r['verdict'], 'candidats': len(r['candidats']), 'retenus_validation': len(r['retenus_validation']), 'n_tests': r['n_tests']}, ensure_ascii=False))
