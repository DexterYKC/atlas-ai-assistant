# Lecture SEULE de MetaTrader 5 : aucun ordre, aucune modification. Ce fichier n'importe et n'appelle AUCUNE fonction d'ordre (un test le vérifie).
#   python mt5_lecture.py etat                         -> compte, positions, ordres, transactions récentes (JSON)
#   python mt5_lecture.py export --symbole XAUUSD.vx --tf H1 --n 20000 --dest F:\Jarvis\trading\donnees   -> écrit un CSV de bougies
# GARDE-FOU : tout s'arrête si MetaTrader ne déclare pas le compte comme DÉMO (trade_mode == 0). Le NOM du serveur ne compte pas (« Live3 » peut héberger un démo) :
# on se fie au statut officiel renvoyé par le terminal.
import argparse, json, os, sys, time
from datetime import datetime, timedelta, timezone

try:
    import MetaTrader5 as mt5
except Exception as e:                                             # paquet absent
    print(json.dumps({'ok': False, 'raison': f'module MetaTrader5 indisponible : {e}'}, ensure_ascii=False)); sys.exit(2)

for _flux in (sys.stdout, sys.stderr):
    try: _flux.reconfigure(encoding='utf-8')            # accents corrects quel que soit l'environnement (Node lit en UTF-8)
    except Exception: pass

MODES = {0: 'démo', 1: 'concours', 2: 'RÉEL'}
TF = {'M1': mt5.TIMEFRAME_M1, 'M5': mt5.TIMEFRAME_M5, 'M15': mt5.TIMEFRAME_M15, 'M30': mt5.TIMEFRAME_M30, 'H1': mt5.TIMEFRAME_H1, 'H4': mt5.TIMEFRAME_H4, 'D1': mt5.TIMEFRAME_D1}

def sortir(o, code=0):
    print(json.dumps(o, ensure_ascii=False, default=str)); sys.exit(code)

def connecter():
    if not mt5.initialize():
        sortir({'ok': False, 'raison': f'connexion au terminal MetaTrader 5 impossible {mt5.last_error()} : est-il ouvert ?'}, 3)
    a = mt5.account_info()
    if a is None:
        mt5.shutdown(); sortir({'ok': False, 'raison': 'aucun compte connecté dans MetaTrader 5'}, 3)
    if a.trade_mode != 0:                                          # DÉMO SEULEMENT : sinon on ne lit RIEN d'autre que ce refus
        mode = MODES.get(a.trade_mode, str(a.trade_mode)); mt5.shutdown()
        sortir({'ok': False, 'refus_compte_reel': True, 'raison': f'Le compte connecté est un compte {mode} : Jarvis ne travaille QUE sur un compte démo.'}, 4)
    return a

def etat():
    a = connecter()
    try:
        t = mt5.terminal_info()
        pos = mt5.positions_get() or []
        ordres = mt5.orders_get() or []
        fin = datetime.now(timezone.utc) + timedelta(days=1)
        deals = mt5.history_deals_get(fin - timedelta(days=31), fin) or []
        sortir({'ok': True, 'compte': {'login': a.login, 'serveur': a.server, 'mode': 'démo', 'devise': a.currency, 'solde': a.balance, 'equite': a.equity, 'profit_flottant': a.profit, 'marge': a.margin, 'marge_libre': a.margin_free, 'levier': a.leverage},
                'terminal': {'connecte': bool(t.connected), 'algo_trading_autorise': bool(t.trade_allowed), 'ping_ms': round(t.ping_last / 1000, 1) if t.ping_last else None},
                'positions': [{'ticket': p.ticket, 'symbole': p.symbol, 'sens': 'achat' if p.type == 0 else 'vente', 'volume': p.volume, 'prix_ouverture': p.price_open, 'prix_actuel': p.price_current, 'sl': p.sl, 'tp': p.tp, 'profit': p.profit,
                              'ouverte_le': datetime.fromtimestamp(p.time, timezone.utc).isoformat(), 'commentaire': p.comment} for p in pos],
                'ordres_en_attente': len(ordres),
                'transactions_31j': [{'ticket': d.ticket, 'symbole': d.symbol, 'type': d.type, 'entree': d.entry, 'volume': d.volume, 'prix': d.price, 'profit': d.profit, 'commission': d.commission, 'swap': d.swap,
                                      'le': datetime.fromtimestamp(d.time, timezone.utc).isoformat(), 'commentaire': d.comment} for d in deals][-60:]})
    finally:
        mt5.shutdown()

def exporter(symbole, tf, n, dest):
    dossier_ok = os.environ.get('JARVIS_DOSSIER', '')
    if not dossier_ok or not os.path.abspath(dest).lower().startswith(os.path.abspath(dossier_ok).lower() + os.sep):
        sortir({'ok': False, 'raison': "destination refusée : elle doit être DANS le dossier Jarvis (variable JARVIS_DOSSIER)"}, 5)
    if tf not in TF: sortir({'ok': False, 'raison': f'unité de temps inconnue : {tf}'}, 5)
    a = connecter()
    try:
        info = mt5.symbol_info(symbole)
        if info is None: sortir({'ok': False, 'raison': f'symbole introuvable : {symbole}'}, 5)
        mt5.symbol_select(symbole, True)
        r = None
        for _ in range(6):                                          # le terminal télécharge l'historique à la 1re demande : on réessaie
            r = mt5.copy_rates_from_pos(symbole, TF[tf], 0, int(min(max(n, 100), 50000)))
            if r is not None and len(r) > 0: break
            time.sleep(1.5)
        if r is None or len(r) == 0: sortir({'ok': False, 'raison': f'aucune donnée reçue {mt5.last_error()}'}, 5)
        os.makedirs(dest, exist_ok=True)
        chemin = os.path.join(dest, f'{symbole}_{tf}.csv')
        with open(chemin, 'w', encoding='utf-8', newline='') as f:
            f.write('time,open,high,low,close,tick_volume,spread\n')
            for x in r:
                f.write(f"{datetime.fromtimestamp(int(x['time']), timezone.utc).strftime('%Y-%m-%d %H:%M:%S')},{x['open']},{x['high']},{x['low']},{x['close']},{int(x['tick_volume'])},{int(x['spread'])}\n")
        sortir({'ok': True, 'fichier': chemin, 'barres': int(len(r)), 'debut': datetime.fromtimestamp(int(r[0]['time']), timezone.utc).isoformat(), 'fin': datetime.fromtimestamp(int(r[-1]['time']), timezone.utc).isoformat(),
                'spread_points': info.spread, 'point': info.point, 'spread_prix': round(info.spread * info.point, 5), 'taille_contrat': info.trade_contract_size, 'volume_min': info.volume_min, 'volume_pas': info.volume_step,
                'swap_mode': info.swap_mode, 'swap_long': info.swap_long, 'swap_short': info.swap_short, 'swap_triple_jour': info.swap_rollover3days, 'stops_level': info.trade_stops_level})
    finally:
        mt5.shutdown()

def cours(symboles):
    a = connecter()
    try:
        out = {}
        for sym in symboles:
            mt5.symbol_select(sym, True)
            info = mt5.symbol_info_tick(sym)
            if info: out[sym] = {'bid': info.bid, 'ask': info.ask, 'heure': datetime.fromtimestamp(info.time, timezone.utc).isoformat()}
        sortir({'ok': True, 'cours': out})
    finally:
        mt5.shutdown()

if __name__ == '__main__':
    p = argparse.ArgumentParser(); sp = p.add_subparsers(dest='cmd', required=True)
    sp.add_parser('etat')
    e = sp.add_parser('export'); e.add_argument('--symbole', default='XAUUSD.vx'); e.add_argument('--tf', default='H1'); e.add_argument('--n', type=int, default=20000); e.add_argument('--dest', required=True)
    c = sp.add_parser('cours'); c.add_argument('--symboles', default='XAUUSD.vx,BTCUSD.vx')
    a = p.parse_args()
    if a.cmd == 'etat': etat()
    elif a.cmd == 'cours': cours([s.strip() for s in a.symboles.split(',') if s.strip()])
    else: exporter(a.symbole, a.tf, a.n, a.dest)
