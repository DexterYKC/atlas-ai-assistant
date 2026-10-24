# EXÉCUTEUR DÉMO : applique des règles décidées à l'avance (celles du laboratoire) sur un compte DÉMO MetaTrader 5, avec des garde-fous DURS écrits dans le code.
# Un « cycle » = un passage (Node l'appelle chaque minute). Rien ne tourne en continu ici, rien n'est décidé par une IA : les signaux sont calculés par labo.py, le MÊME code que le backtest.
#   python executeur.py cycle          -> évalue les signaux sur les bougies FERMÉES, ouvre / ferme au marché, renvoie un JSON
#   python executeur.py bilan          -> résultats réels du suivi (par stratégie)
#   python executeur.py fermer_tout    -> ferme les positions de JARVIS (jamais les tiennes) et pose le drapeau d'arrêt
#   python executeur.py ordre <symbole> <achat|vente>  -> ordre MANUEL demandé par lui (via une confirmation dans le tableau de bord/Telegram, jamais la voix) : stop ET objectif automatiques, mêmes garde-fous et mêmes limites que cycle()
# Configuration : variable d'environnement JARVIS_EXEC_CONFIG (JSON) ; dossier de travail : JARVIS_DOSSIER (F:\Jarvis) ; drapeau d'arrêt : <dossier>\trading\ARRET
import json, os, sys, time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import mt5_lecture as ml            # connexion + REFUS de tout compte qui n'est pas DÉMO (même code que la lecture)
import labo as L                    # les signaux : exactement ceux du backtest
mt5 = ml.mt5

# ---------------------------------------------------------------- LIMITES ABSOLUES : la configuration ne peut que les RÉDUIRE, jamais les dépasser
LOT_MAX_ABSOLU = 1.0
POSITIONS_MAX_ABSOLU = 6
ORDRES_MAX_JOUR_ABSOLU = 40
PERTE_JOUR_MAX_PCT_ABSOLU = 5.0
MAGIC_BASE, MAGIC_FIN = 77700000, 77709999          # les positions de Jarvis portent un « magic » dans cette plage : les autres ne sont JAMAIS touchées
MAGIC_MANUEL = 77700090                             # ordres manuels (demandés par lui, confirmés dans le tableau de bord) : magic à part, mais dans la même plage (comptés dans les mêmes limites, fermés par « Tout fermer »)
K_STOP_MANUEL = 2.5                                 # même prudence que la règle suivie sur l'or : stop obligatoire à 2,5×ATR
K_CIBLE_MANUEL = 1.5                                 # objectif AUTOMATIQUE (plus proche que le stop) : verrouille un petit gain tout seul, chez le courtier, même si personne n'y pense à temps
LOT_MANUEL_DEFAUT = {'XAUUSD.vx': 0.10, 'BTCUSD.vx': 0.01}
SPREAD_MAX_MANUEL = {'XAUUSD.vx': 100, 'BTCUSD.vx': 6000}   # le spread du Bitcoin est naturellement ~80× plus large que celui de l'or
SYMBOLES_PAR_DEFAUT = ['XAUUSD.vx']
DUREE_BOUGIE = {'M1': 60, 'M5': 300, 'M15': 900, 'M30': 1800, 'H1': 3600, 'H4': 14400}
DONE = 10009

def dossier():
    d = os.environ.get('JARVIS_DOSSIER', '')
    if not d: ml.sortir({'ok': False, 'raison': 'JARVIS_DOSSIER absent : aucune écriture possible'}, 5)
    t = os.path.join(d, 'trading'); os.makedirs(os.path.join(t, 'journal'), exist_ok=True); return t

def journal(t, evt, **k):
    try:
        f = os.path.join(t, 'journal', 'executeur.jsonl')
        if os.path.exists(f) and os.path.getsize(f) > 4_000_000: os.replace(f, f + '.old')
        with open(f, 'a', encoding='utf-8') as fh: fh.write(json.dumps({'t': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'evt': evt, **k}, ensure_ascii=False, default=str) + '\n')
    except Exception: pass

def lire_etat(t):
    try: return json.load(open(os.path.join(t, 'executeur_etat.json'), encoding='utf-8'))
    except Exception: return {}
def ecrire_etat(t, e):
    p = os.path.join(t, 'executeur_etat.json'); tmp = p + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh: json.dump(e, fh, ensure_ascii=False)
    os.replace(tmp, p)

def config():
    try: c = json.loads(os.environ.get('JARVIS_EXEC_CONFIG', '') or '{}')
    except Exception: ml.sortir({'ok': False, 'raison': 'configuration illisible'}, 5)
    autorises = list(c.get('symboles_autorises') or SYMBOLES_PAR_DEFAUT)
    strat = []
    for s in c.get('strategies') or []:
        try:
            ok = (s.get('actif', True) and s['symbole'] in autorises and s['unite'] in DUREE_BOUGIE and s['fam'] in L.FAMILLES and 0 < float(s['k_stop']) <= 10 and MAGIC_BASE <= int(s['magic']) <= MAGIC_FIN and int(s['max_barres']) >= 1)
        except Exception: ok = False
        if ok: strat.append({**s, 'k_stop': float(s['k_stop']), 'k_cible': (float(s['k_cible']) if s.get('k_cible') else None), 'max_barres': int(s['max_barres']), 'magic': int(s['magic']), 'lot': min(float(s.get('lot', c.get('lot', 0.10))), LOT_MAX_ABSOLU)})
    return {'strategies': strat, 'autorises': autorises, 'positions_max': min(int(c.get('positions_max', 3)), POSITIONS_MAX_ABSOLU), 'ordres_max_jour': min(int(c.get('ordres_max_jour', 12)), ORDRES_MAX_JOUR_ABSOLU),
            'perte_jour_pct': min(float(c.get('perte_max_jour_pct', 2.0)), PERTE_JOUR_MAX_PCT_ABSOLU), 'spread_max_points': int(c.get('spread_max_points', 100)), 'delai_entree_s': int(c.get('delai_entree_s', 600)), 'rejets_max_jour': int(c.get('rejets_max_jour', 3))}

def remplissage(info):
    fm = info.filling_mode
    return mt5.ORDER_FILLING_FOK if fm & 1 else (mt5.ORDER_FILLING_IOC if fm & 2 else mt5.ORDER_FILLING_RETURN)

def mes_positions(symbole=None):
    r = mt5.positions_get(symbol=symbole) if symbole else mt5.positions_get()
    return [p for p in (r or []) if MAGIC_BASE <= p.magic <= MAGIC_FIN]

def fermer_position(p, raison, t):
    tk = mt5.symbol_info_tick(p.symbol); info = mt5.symbol_info(p.symbol)
    sens_ferme = mt5.ORDER_TYPE_SELL if p.type == 0 else mt5.ORDER_TYPE_BUY
    req = {'action': mt5.TRADE_ACTION_DEAL, 'symbol': p.symbol, 'volume': p.volume, 'type': sens_ferme, 'position': p.ticket, 'price': tk.bid if p.type == 0 else tk.ask, 'deviation': 30, 'magic': p.magic,
           'comment': ('jarvis:' + raison)[:30], 'type_time': mt5.ORDER_TIME_GTC, 'type_filling': remplissage(info)}
    r = mt5.order_send(req)
    ok = r is not None and r.retcode == DONE
    journal(t, 'fermeture' if ok else 'fermeture_refusee', ticket=p.ticket, symbole=p.symbol, raison=raison, retcode=getattr(r, 'retcode', None), profit=p.profit)
    return ok, getattr(r, 'retcode', None)

def pnl_jour(now_serveur, balance):
    t0 = now_serveur - now_serveur % 86400
    deals = mt5.history_deals_get(datetime.fromtimestamp(t0, timezone.utc), datetime.fromtimestamp(now_serveur + 86400, timezone.utc)) or []
    realise = sum(d.profit + d.commission + d.swap + getattr(d, 'fee', 0.0) for d in deals if MAGIC_BASE <= d.magic <= MAGIC_FIN)
    flottant = sum(p.profit + p.swap for p in mes_positions())
    return realise, flottant

def cycle():
    t = dossier(); cfg = config(); a = ml.connecter()                    # DÉMO ou rien
    etat = lire_etat(t); actions = []; prix_vus = {}; jour = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    if etat.get('jour') != jour: etat.update({'jour': jour, 'ordres': 0, 'rejets': 0})
    try:
        term = mt5.terminal_info(); arret = os.path.exists(os.path.join(t, 'ARRET'))
        entrees_ok, motif = True, ''
        if arret: entrees_ok, motif = False, "drapeau d'arrêt (ARRET) présent"
        elif os.environ.get('JARVIS_EXEC_ENTREES', '1') != '1': entrees_ok, motif = False, 'Jarvis est suspendu (les positions ouvertes restent gérées, aucune nouvelle entrée)'
        elif not term.trade_allowed: entrees_ok, motif = False, 'trading algorithmique désactivé dans MetaTrader (ton verrou)'
        elif not cfg['strategies']: entrees_ok, motif = False, 'aucune stratégie active'
        elif etat['ordres'] >= cfg['ordres_max_jour']: entrees_ok, motif = False, f"limite de {cfg['ordres_max_jour']} ordres par jour atteinte"
        elif etat['rejets'] >= cfg['rejets_max_jour']: entrees_ok, motif = False, f"{etat['rejets']} ordres refusés aujourd'hui : pause"
        tk0 = mt5.symbol_info_tick(cfg['strategies'][0]['symbole']) if cfg['strategies'] else None
        srv = tk0.time if tk0 is not None else int(time.time())
        realise, flottant = pnl_jour(srv, a.balance); perte_max = a.balance * cfg['perte_jour_pct'] / 100
        if entrees_ok and realise + flottant <= -perte_max: entrees_ok, motif = False, f"perte du jour {realise + flottant:.2f} au-delà de la limite -{perte_max:.2f}"
        derniere = etat.setdefault('derniere_barre', {})
        for s in cfg['strategies']:
            info = mt5.symbol_info(s['symbole'])
            if info is None: continue
            mt5.symbol_select(s['symbole'], True)
            tk = mt5.symbol_info_tick(s['symbole']); sec = DUREE_BOUGIE[s['unite']]
            if tk is None: actions.append({'type': 'ignore', 'id': s['id'], 'detail': 'aucun prix reçu'}); continue
            prix_vus[s['symbole']] = round(float(tk.bid), 2)
            r = None
            for _ in range(3):
                r = mt5.copy_rates_from_pos(s['symbole'], ml.TF[s['unite']], 0, 500)
                if r is not None and len(r) > 300: break
                time.sleep(1)
            if r is None or len(r) < 300: actions.append({'type': 'ignore', 'id': s['id'], 'detail': "historique insuffisant"}); continue
            fermees = r[:-1]                                              # la dernière bougie est EN COURS : jamais utilisée pour un signal
            P = L.Prix(fermees['open'], fermees['high'], fermees['low'], fermees['close'])
            e, sl_, ss_ = P.signaux(s['fam'], s['params']); idx = len(fermees) - 1; bar_t = int(fermees[-1]['time']); atr_ = P.a[idx]
            pos = mes_positions(s['symbole']); pos = [p for p in pos if p.magic == s['magic']]
            for p in pos:                                                  # ---- sorties : temps écoulé, ou signal de sortie de la règle
                ouverte = p.time - p.time % sec; raison = None
                if tk.time >= ouverte + s['max_barres'] * sec: raison = 'temps'
                elif (p.type == 0 and sl_[idx]) or (p.type == 1 and ss_[idx]): raison = 'signal'
                if raison:
                    ok, rc = fermer_position(p, raison, t); actions.append({'type': 'fermeture', 'id': s['id'], 'ticket': p.ticket, 'raison': raison, 'ok': ok, 'retcode': rc, 'profit': p.profit})
            if pos: continue                                              # une seule position par stratégie
            sens = int(e[idx])
            if sens == 0 or derniere.get(s['id']) == bar_t: continue
            derniere[s['id']] = bar_t                                     # ce signal est traité UNE fois, quoi qu'il arrive (pas de re-tentative sur la même bougie)
            ecart = tk.time - int(r[-1]['time'])
            if not entrees_ok: actions.append({'type': 'ignore', 'id': s['id'], 'detail': f'signal {"achat" if sens == 1 else "vente"} non suivi : {motif}'}); journal(t, 'signal_ignore', id=s['id'], sens=sens, motif=motif); continue
            if ecart > cfg['delai_entree_s']: actions.append({'type': 'ignore', 'id': s['id'], 'detail': f'signal trop ancien ({ecart} s après l\'ouverture de la bougie)'}); continue
            if info.trade_mode != 4: actions.append({'type': 'ignore', 'id': s['id'], 'detail': 'symbole non négociable en ce moment'}); continue
            lim_spread = int(s.get('spread_max_points') or cfg['spread_max_points'])
            if info.spread > lim_spread: actions.append({'type': 'ignore', 'id': s['id'], 'detail': f'spread trop large ({info.spread} points > {lim_spread})'}); continue
            if len(mes_positions()) >= cfg['positions_max']: actions.append({'type': 'ignore', 'id': s['id'], 'detail': 'nombre maximal de positions atteint'}); continue
            if np.isnan(atr_) or atr_ <= 0: continue
            prix = tk.ask if sens == 1 else tk.bid; stop = round(prix - sens * s['k_stop'] * atr_, info.digits); cible = round(prix + sens * s['k_cible'] * atr_, info.digits) if s['k_cible'] else 0.0
            if abs(prix - stop) < info.trade_stops_level * info.point: actions.append({'type': 'ignore', 'id': s['id'], 'detail': 'stop trop proche du prix (niveau minimal du courtier)'}); continue
            pas = info.volume_step or 0.01; vol = max(info.volume_min, min(s['lot'], info.volume_max, LOT_MAX_ABSOLU)); vol = round(round(vol / pas) * pas, 2)
            req = {'action': mt5.TRADE_ACTION_DEAL, 'symbol': s['symbole'], 'volume': vol, 'type': mt5.ORDER_TYPE_BUY if sens == 1 else mt5.ORDER_TYPE_SELL, 'price': prix, 'sl': stop, 'tp': cible, 'deviation': 30,
                   'magic': s['magic'], 'comment': ('jarvis:' + s['id'])[:30], 'type_time': mt5.ORDER_TIME_GTC, 'type_filling': remplissage(info)}
            chk = mt5.order_check(req)
            if chk is None or chk.retcode not in (0, DONE):
                etat['rejets'] += 1; journal(t, 'ordre_refuse_check', id=s['id'], retcode=getattr(chk, 'retcode', None)); actions.append({'type': 'refus', 'id': s['id'], 'detail': f"vérification refusée ({getattr(chk, 'retcode', None)})"}); continue
            res = mt5.order_send(req); etat['ordres'] += 1
            if res is not None and res.retcode == DONE:
                journal(t, 'ouverture', id=s['id'], sens=sens, symbole=s['symbole'], volume=vol, prix=prix, sl=stop, tp=cible, atr=float(atr_), barre=bar_t, ticket=getattr(res, 'order', None))
                actions.append({'type': 'ouverture', 'id': s['id'], 'sens': 'achat' if sens == 1 else 'vente', 'symbole': s['symbole'], 'volume': vol, 'prix': prix, 'sl': stop, 'tp': cible})
            else:
                etat['rejets'] += 1; journal(t, 'ordre_refuse', id=s['id'], retcode=getattr(res, 'retcode', None)); actions.append({'type': 'refus', 'id': s['id'], 'detail': f"ordre refusé par le courtier ({getattr(res, 'retcode', None)})"})
        ecrire_etat(t, etat)
        pos = mes_positions()
        ml.sortir({'ok': True, 'entrees_autorisees': entrees_ok, 'motif': motif, 'actions': actions, 'positions': [{'ticket': p.ticket, 'symbole': p.symbol, 'sens': 'achat' if p.type == 0 else 'vente', 'volume': p.volume, 'prix': p.price_open, 'sl': p.sl, 'tp': p.tp, 'profit': p.profit, 'magic': p.magic} for p in pos],
                   'prix': prix_vus, 'pnl_jour': round(realise + flottant, 2), 'perte_max_jour': round(perte_max, 2), 'ordres_jour': etat['ordres'], 'rejets_jour': etat['rejets']})
    finally:
        mt5.shutdown()

def bilan(jours=90):
    t = dossier(); cfg = config(); ml.connecter()
    try:
        fin = datetime.now(timezone.utc); d0 = datetime.fromtimestamp(fin.timestamp() - jours * 86400, timezone.utc)
        deals = [d for d in (mt5.history_deals_get(d0, datetime.fromtimestamp(fin.timestamp() + 86400, timezone.utc)) or []) if MAGIC_BASE <= d.magic <= MAGIC_FIN and d.entry in (1, 2, 3)]      # entry 1 = sortie : le résultat de la transaction
        par = {}
        for d in deals: par.setdefault(d.magic, []).append(d.profit + d.commission + d.swap + getattr(d, 'fee', 0.0))
        out = []
        for s in cfg['strategies']:
            x = np.array(par.get(s['magic'], []), dtype=float); g = float(x[x > 0].sum()) if len(x) else 0.0; p = float(-x[x < 0].sum()) if len(x) else 0.0
            out.append({'id': s['id'], 'symbole': s['symbole'], 'transactions': int(len(x)), 'net': round(float(x.sum()), 2) if len(x) else 0.0, 'facteur_de_profit': round(g / p, 2) if p > 0 else (None if not len(x) else 99.0),
                        'gagnantes_pct': round(100 * float((x > 0).mean()), 1) if len(x) else None, 'moyenne': round(float(x.mean()), 2) if len(x) else None, 'attendu': s.get('attendu')})
        ml.sortir({'ok': True, 'jours': jours, 'strategies': out, 'positions_ouvertes': len(mes_positions())})
    finally:
        mt5.shutdown()

def ordre(symbole, sens):
    if sens not in ('achat', 'vente'): ml.sortir({'ok': False, 'raison': 'sens invalide (achat ou vente)'}, 2)
    t = dossier(); cfg = config(); a = ml.connecter()
    try:
        etat = lire_etat(t); jour = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        if etat.get('jour') != jour: etat.update({'jour': jour, 'ordres': 0, 'rejets': 0})
        if os.path.exists(os.path.join(t, 'ARRET')): ml.sortir({'ok': False, 'raison': "drapeau d'arrêt (ARRET) présent : lève l'arrêt avant un nouvel ordre"}, 5)
        if os.environ.get('JARVIS_EXEC_ENTREES', '1') != '1': ml.sortir({'ok': False, 'raison': 'Jarvis est suspendu : aucun ordre'}, 5)
        if not mt5.terminal_info().trade_allowed: ml.sortir({'ok': False, 'raison': 'trading algorithmique désactivé dans MetaTrader (ton verrou)'}, 5)
        if symbole not in cfg['autorises']: ml.sortir({'ok': False, 'raison': f'symbole non autorisé ({symbole})'}, 5)
        if etat['ordres'] >= cfg['ordres_max_jour']: ml.sortir({'ok': False, 'raison': f"limite de {cfg['ordres_max_jour']} ordres par jour atteinte"}, 5)
        if len(mes_positions()) >= cfg['positions_max']: ml.sortir({'ok': False, 'raison': 'nombre maximal de positions atteint'}, 5)
        mt5.symbol_select(symbole, True); info = mt5.symbol_info(symbole); tk = mt5.symbol_info_tick(symbole)
        if info is None or tk is None: ml.sortir({'ok': False, 'raison': 'prix indisponible pour ce symbole'}, 5)
        srv = tk.time
        realise, flottant = pnl_jour(srv, a.balance); perte_max = a.balance * cfg['perte_jour_pct'] / 100
        if realise + flottant <= -perte_max: ml.sortir({'ok': False, 'raison': f"perte du jour {realise + flottant:.2f} au-delà de la limite -{perte_max:.2f}"}, 5)
        if info.trade_mode != 4: ml.sortir({'ok': False, 'raison': 'symbole non négociable en ce moment (marché fermé)'}, 5)
        lim_spread = SPREAD_MAX_MANUEL.get(symbole, cfg['spread_max_points'])
        if info.spread > lim_spread: ml.sortir({'ok': False, 'raison': f'spread trop large ({info.spread} points > {lim_spread})'}, 5)
        r = None
        for _ in range(3):
            r = mt5.copy_rates_from_pos(symbole, mt5.TIMEFRAME_H1, 0, 30)
            if r is not None and len(r) >= 20: break
            time.sleep(1)
        if r is None or len(r) < 20: ml.sortir({'ok': False, 'raison': 'historique insuffisant pour calculer un stop'}, 5)
        P = L.Prix(r['open'], r['high'], r['low'], r['close']); atr = P.a[-1]
        if np.isnan(atr) or atr <= 0: ml.sortir({'ok': False, 'raison': 'stop impossible à calculer (ATR indisponible)'}, 5)
        sens_n = 1 if sens == 'achat' else -1
        prix = tk.ask if sens_n == 1 else tk.bid
        stop = round(prix - sens_n * K_STOP_MANUEL * atr, info.digits)
        cible = round(prix + sens_n * K_CIBLE_MANUEL * atr, info.digits)
        if abs(prix - stop) < info.trade_stops_level * info.point: ml.sortir({'ok': False, 'raison': 'stop trop proche du prix (niveau minimal du courtier)'}, 5)
        lot = min(float((cfg.get('lot_manuel') or {}).get(symbole, LOT_MANUEL_DEFAUT.get(symbole, 0.01))), LOT_MAX_ABSOLU)
        pas = info.volume_step or 0.01; vol = max(info.volume_min, min(lot, info.volume_max)); vol = round(round(vol / pas) * pas, 2)
        req = {'action': mt5.TRADE_ACTION_DEAL, 'symbol': symbole, 'volume': vol, 'type': mt5.ORDER_TYPE_BUY if sens_n == 1 else mt5.ORDER_TYPE_SELL, 'price': prix, 'sl': stop, 'tp': cible, 'deviation': 30,
               'magic': MAGIC_MANUEL, 'comment': 'jarvis:manuel', 'type_time': mt5.ORDER_TIME_GTC, 'type_filling': remplissage(info)}
        chk = mt5.order_check(req)
        if chk is None or chk.retcode not in (0, DONE):
            etat['rejets'] += 1; ecrire_etat(t, etat); journal(t, 'ordre_manuel_refuse_check', retcode=getattr(chk, 'retcode', None))
            ml.sortir({'ok': False, 'raison': f"vérification refusée par le courtier ({getattr(chk, 'retcode', None)})"}, 5)
        res = mt5.order_send(req); etat['ordres'] += 1; ecrire_etat(t, etat)
        if res is not None and res.retcode == DONE:
            journal(t, 'ouverture_manuelle', sens=sens, symbole=symbole, volume=vol, prix=prix, sl=stop, tp=cible, atr=float(atr), ticket=getattr(res, 'order', None))
            ml.sortir({'ok': True, 'sens': sens, 'symbole': symbole, 'volume': vol, 'prix': prix, 'sl': stop, 'tp': cible, 'ticket': getattr(res, 'order', None)})
        etat['rejets'] += 1; ecrire_etat(t, etat); journal(t, 'ordre_manuel_refuse', retcode=getattr(res, 'retcode', None))
        ml.sortir({'ok': False, 'raison': f"ordre refusé par le courtier ({getattr(res, 'retcode', None)})"}, 5)
    finally:
        mt5.shutdown()

def fermer_manuel(symbole=None):
    # Ferme SES positions manuelles (magic MAGIC_MANUEL) sur un symbole donné — jamais les positions des règles automatiques, jamais ses propres positions à lui (magic 0).
    t = dossier(); ml.connecter()
    try:
        positions = [p for p in mes_positions(symbole) if p.magic == MAGIC_MANUEL]
        if not positions: ml.sortir({'ok': False, 'raison': f"aucune position manuelle ouverte{' sur ' + symbole if symbole else ''}"}, 5)
        res = []
        for p in positions:
            ok, rc = fermer_position(p, 'manuel', t); res.append({'ticket': p.ticket, 'symbole': p.symbol, 'ok': ok, 'retcode': rc, 'profit': round(p.profit, 2)})
        ml.sortir({'ok': True, 'fermees': sum(1 for r in res if r['ok']), 'echecs': sum(1 for r in res if not r['ok']), 'detail': res})
    finally:
        mt5.shutdown()

def fermer_tout():
    t = dossier(); ml.connecter()
    try:
        open(os.path.join(t, 'ARRET'), 'w', encoding='utf-8').write(datetime.now(timezone.utc).isoformat())          # plus aucune nouvelle entrée tant que l'arrêt n'est pas levé
        res = []
        for p in mes_positions():
            ok, rc = fermer_position(p, 'arret', t); res.append({'ticket': p.ticket, 'symbole': p.symbol, 'ok': ok, 'retcode': rc})
        journal(t, 'fermer_tout', positions=len(res))
        ml.sortir({'ok': True, 'fermees': sum(1 for r in res if r['ok']), 'echecs': sum(1 for r in res if not r['ok']), 'detail': res})
    finally:
        mt5.shutdown()

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'cycle': cycle()
    elif cmd == 'bilan': bilan()
    elif cmd == 'fermer_tout': fermer_tout()
    elif cmd == 'ordre' and len(sys.argv) >= 4: ordre(sys.argv[2], sys.argv[3])
    elif cmd == 'fermer_manuel': fermer_manuel(sys.argv[2] if len(sys.argv) > 2 else None)
    else: ml.sortir({'ok': False, 'raison': 'commande inconnue (cycle | bilan | fermer_tout | ordre <symbole> <achat|vente> | fermer_manuel [symbole])'}, 2)
