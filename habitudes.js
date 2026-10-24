// Habitudes apprises (fonctions pures, testées à part) : périodes de calme de la nuit, et façon de répondre aux « petits points ».
// Jarvis n'observe que ce qu'il voit : messages à Jarvis (voix, Telegram, appli) et clavier / souris du PC. Le CALME n'est donc pas du SOMMEIL : c'est un indice, jamais une certitude.
const SLOTS = 96;                                                   // un créneau = 15 minutes
const p2 = (n) => String(n).padStart(2, '0');
const cle = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const creneau = (d) => Math.floor((d.getHours() * 60 + d.getMinutes()) / 15);
const mod24 = (h) => ((h % 24) + 24) % 24;
const mediane = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const arrondi = (h) => Math.round(h * 4) / 4;                       // au quart d'heure

// activite[jour] = 96 caractères : '_' inconnu (Jarvis éteint), '0' Jarvis tournait et personne n'a rien fait, '1' activité. Renvoie true si quelque chose a changé.
function marquer(activite, d, actif) {
  const k = cle(d), i = creneau(d), s = activite[k] || '_'.repeat(SLOTS), c = s[i], n = actif ? '1' : (c === '1' ? '1' : '0');
  if (c === n) return false;
  activite[k] = s.slice(0, i) + n + s.slice(i + 1);
  return true;
}
function elaguer(activite, d, jours = 60) {
  const limite = cle(new Date(d.getTime() - jours * 86400000));
  for (const k of Object.keys(activite)) if (k < limite) delete activite[k];
}

// Plus longue période de calme entre 18 h et 14 h le lendemain, pour chaque nuit COMPLÈTE observée ; médiane sur les 14 dernières nuits.
// Le début est borné à 21 h-3 h et la fin à 5 h-12 h : une soirée tranquille sans PC ne doit pas devenir « la nuit ».
// Les périodes de calme ANNONCÉES par lui (« je dors jusqu'à 10h ») valent mieux que le calme deviné : elles remplacent la nuit déduite du même soir.
function nuitsDeclarees(declarees, min_h = 3) {
  const out = [];
  for (const d of declarees || []) {
    const dur = (d.fin - d.debut) / 3600000, dt = new Date(d.debut), h = dt.getHours() + dt.getMinutes() / 60;
    if (!(dur >= min_h) || (h >= 4 && h < 20)) continue;                                 // trop court, ou sieste de journée : pas une nuit
    const debut = h < 4 ? h + 24 : h;                                                     // heures linéaires (20 -> 28)
    out.push({ jour: h < 12 ? cle(new Date(d.debut - 86400000)) : cle(dt), debut, fin: debut + dur, declaree: true });
  }
  return out;
}
function nuitApprise(activite, now = new Date(), { min_h = 3, nuits_max = 14 } = {}, declarees = []) {
  let nuits = [];
  for (const k of Object.keys(activite).sort()) {
    const suiv = cle(new Date(new Date(k + 'T12:00:00').getTime() + 86400000));
    if (!activite[suiv]) continue;
    const fini = suiv < cle(now) || (suiv === cle(now) && now.getHours() >= 14);       // la matinée suivante doit être terminée
    if (!fini) continue;
    const seq = (activite[k].slice(72) + activite[suiv].slice(0, 56)).split('');       // 18:00 -> 14:00 (80 créneaux)
    if (seq.filter((c) => c === '_').length > seq.length * 0.15) continue;             // Jarvis éteint trop longtemps : nuit inexploitable
    const calme = seq.map((c, i) => c === '0' || (c === '1' && seq[i - 1] === '0' && seq[i + 1] === '0'));   // un créneau isolé d'activité (15 min) n'interrompt pas la nuit
    let best = { s: 0, l: 0 }, cur = null;
    calme.forEach((v, i) => { if (v) { if (!cur) cur = { s: i, l: 0 }; cur.l++; if (cur.l > best.l) best = { ...cur }; } else cur = null; });
    if (best.l < min_h * 4) continue;
    nuits.push({ jour: k, debut: 18 + best.s * 0.25, fin: 18 + (best.s + best.l) * 0.25 });
  }
  const parJour = new Map(nuits.map((n) => [n.jour, n]));
  for (const n of nuitsDeclarees(declarees, min_h)) parJour.set(n.jour, n);
  nuits = [...parJour.values()].sort((a, b) => (a.jour < b.jour ? -1 : 1));
  const recentes = nuits.slice(-nuits_max);
  if (!recentes.length) return { nuits: 0, fiable: false, declarees: 0 };
  const debut = Math.max(21, Math.min(27, mediane(recentes.map((n) => n.debut)))), fin = Math.max(29, Math.min(36, mediane(recentes.map((n) => n.fin))));   // heures linéaires depuis minuit de la veille (27 = 3 h, 29 = 5 h, 36 = 12 h)
  return { nuits: recentes.length, declarees: recentes.filter((n) => n.declaree).length, fiable: recentes.length >= 5, debut: arrondi(mod24(debut)), fin: arrondi(mod24(fin)), duree_h: Math.round((fin - debut) * 2) / 2,
    appels_debut: arrondi(mod24(debut - 0.5)), appels_fin: arrondi(mod24(fin)) };   // pas d'appel dès 30 min avant le début habituel, et jusqu'à l'heure habituelle du lever
}

// Réponses aux petits points : [{ t, h, issue: repondu | repondu_appel | sans_reponse | decroche_sans_parler, etape, delai_min, presence }]
function statsPoints(points) {
  const n = points.length;
  if (!n) return { n: 0 };
  const rep = points.filter((p) => /^repondu/.test(p.issue));
  const par_etape = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const p of rep) par_etape[Math.min(3, p.etape || 0)]++;
  const periodes = { matin: { n: 0, repondus: 0 }, apres_midi: { n: 0, repondus: 0 }, soir: { n: 0, repondus: 0 } };
  for (const p of points) { const k = p.h < 12 ? 'matin' : p.h < 18 ? 'apres_midi' : 'soir'; periodes[k].n++; if (/^repondu/.test(p.issue)) periodes[k].repondus++; }
  return { n, repondus: rep.length, taux: Math.round(100 * rep.length / n), delai_median_min: mediane(rep.map((p) => p.delai_min).filter(Number.isFinite)), par_etape, periodes };
}

const fmtHeure = (h) => `${p2(Math.floor(mod24(h)))}:${p2(Math.round((mod24(h) % 1) * 60))}`;
module.exports = { nuitsDeclarees, marquer, elaguer, nuitApprise, statsPoints, fmtHeure, cle, creneau, mediane };
