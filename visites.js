// Visites des liens de démonstration personnalisés (masnasoft.com/demo?p=<slug>) : synchro Upstash Redis en LECTURE SEULE.
// Le site écrit chaque « visite » et chaque « clic » dans la liste Redis `events:demo` ; ici on ne fait que la lire.
//   Format d'une entrée : {"slug":"...","type":"visite"|"clic","ts":<millisecondes>,"ua":"..."} — la plus récente en tête.
// Identifiants : config.json > upstash_url et upstash_token_ro (jeton Upstash en lecture seule). Jamais ailleurs.
// Ce module n'envoie JAMAIS de commande autre que LRANGE, ne touche pas à la liste de préproduction
// (preview:events:demo), n'écrit rien dans Redis, et n'affiche jamais le jeton (ni dans les erreurs ni dans les journaux).
'use strict';

const LISTE = 'events:demo';
const PAGE = 200;               // entrées lues par requête
const PAGES_MAX = 10;           // garde-fou : jamais une boucle sans fin (2 000 entrées au plus par synchro)
const DELAI_APRES_ENVOI_MS = 5 * 60 * 1000;   // antivirus des messageries : ils ouvrent le lien dès la réception du mail

const pad = (n) => String(n).padStart(2, '0');
// Date locale AAAA-MM-JJ (même format que dateKey() d'Atlas et que demoTesteLe).
const dateLocale = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// Une entrée lisible et bien formée, sinon null (les entrées illisibles sont ignorées, jamais une erreur).
function lireEntree(brut) {
  let e = brut;
  if (typeof brut === 'string') { try { e = JSON.parse(brut); } catch { return null; } }
  if (!e || typeof e !== 'object') return null;
  const ts = Number(e.ts);
  if (typeof e.slug !== 'string' || !e.slug || (e.type !== 'visite' && e.type !== 'clic') || !Number.isFinite(ts) || ts <= 0) return null;
  return { slug: e.slug, type: e.type, ts };
}

// « 2026-11-06 09:12 » (heure locale, comme envoiProgrammeLe) -> millisecondes, ou NaN.
function heureLocale(texte) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(String(texte || '').trim());
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0).getTime();
}
// Heures d'envoi connues d'un prospect (envois programmés : l'heure précise est enregistrée ; un envoi fait à la main
// n'a qu'une date, donc aucune fenêtre de 5 minutes ne peut s'appliquer pour lui).
function envoisMs(p) {
  const liste = [...(Array.isArray(p.envoisLe) ? p.envoisLe : []), p.envoiProgrammeLe];
  return liste.map(heureLocale).filter(Number.isFinite);
}
const dansFenetreEnvoi = (p, ts) => envoisMs(p).some((t) => ts >= t && ts <= t + DELAI_APRES_ENVOI_MS);

/**
 * Lit les entrées plus récentes que `depuisTs` (sans doublon avec la synchro précédente), de la plus ancienne à la plus récente.
 * `fetchImpl` est injectable pour les tests.
 */
async function lireNouveaux({ url, token, depuisTs = 0, fetchImpl = fetch }) {
  const base = String(url || '').replace(/\/+$/, '');
  const nouvelles = [];
  let atteint = false;
  for (let page = 0; page < PAGES_MAX && !atteint; page++) {
    const res = await fetchImpl(base, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(['LRANGE', LISTE, page * PAGE, page * PAGE + PAGE - 1]),
      signal: AbortSignal.timeout(10000),
    });
    // Le jeton ne figure jamais dans le message d'erreur ; le corps de la réponse non plus (il peut citer la requête).
    if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.error) throw new Error('Upstash : ' + String(data.error).replace(token, '***').slice(0, 120));
    const lot = Array.isArray(data && data.result) ? data.result : [];
    for (const brut of lot) {
      const e = lireEntree(brut);
      if (!e) continue;
      if (e.ts > depuisTs) nouvelles.push(e);
      else atteint = true;   // la liste est du plus récent au plus ancien : tout le reste est déjà traité
    }
    if (lot.length < PAGE) break;
  }
  return nouvelles.sort((a, b) => a.ts - b.ts);
}

/**
 * Rattache les événements aux prospects (par p.slugs) et met à jour p.visiteLe / p.clicLe (dernière date, AAAA-MM-JJ).
 * Ignorés : slugs inconnus, slugs de test (test-dexter, test-*), et visites dans les 5 minutes suivant un envoi de mail
 * (les clics, eux, ne sont jamais le fait d'un antivirus : ils comptent toujours).
 * Aucune notification, aucune note : la visite ne doit jamais se retrouver dans un texte (relance comprise).
 */
function appliquer(evenements, prospects) {
  const parSlug = new Map();
  for (const p of prospects || []) for (const s of (Array.isArray(p.slugs) ? p.slugs : [])) if (!parSlug.has(s)) parSlug.set(s, p);
  const bilan = { visites: 0, clics: 0, ignores: { test: 0, inconnu: 0, antivirus: 0 }, modifies: new Set(), dernierTs: 0 };
  for (const e of evenements) {
    bilan.dernierTs = Math.max(bilan.dernierTs, e.ts);
    if (/^test-/.test(e.slug)) { bilan.ignores.test++; continue; }
    const p = parSlug.get(e.slug);
    if (!p) { bilan.ignores.inconnu++; continue; }
    if (e.type === 'visite' && dansFenetreEnvoi(p, e.ts)) { bilan.ignores.antivirus++; continue; }
    const champ = e.type === 'visite' ? 'visiteLe' : 'clicLe';
    const jour = dateLocale(e.ts);
    if (!p[champ] || jour > p[champ]) { p[champ] = jour; bilan.modifies.add(p); }
    bilan[e.type === 'visite' ? 'visites' : 'clics']++;
  }
  return bilan;
}

// Priorité pour la prochaine relance : a testé la démo > a visité ou cliqué sans tester > les autres.
const prioriteRelance = (p) => (p.demoTesteLe ? 2 : (p.visiteLe || p.clicLe) ? 1 : 0);
// « a visité sans tester » : une visite ou un clic, mais aucun test de la démo.
const aVisiteSansTester = (p) => !!(p.visiteLe || p.clicLe) && !p.demoTesteLe;

module.exports = { LISTE, DELAI_APRES_ENVOI_MS, lireNouveaux, appliquer, lireEntree, heureLocale, envoisMs, prioriteRelance, aVisiteSansTester, dateLocale };
