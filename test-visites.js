// Tests de visites.js (synchro Upstash en lecture seule) — aucun réseau, aucun serveur, aucun port : fetch est simulé.
//   node test-visites.js
'use strict';
const fs = require('fs');
const path = require('path');
const v = require('./visites');

let echecs = 0;
const check = (nom, ok, detail = '') => { if (!ok) echecs++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${nom}${detail ? ' - ' + detail : ''}`); };

const TOKEN = 'jeton-ro-SECRET-123';
const URL = 'https://exemple.upstash.io';
const MIN = 60 * 1000;
const T0 = new Date(2026, 10, 6, 9, 12, 0, 0).getTime();   // 2026-11-06 09:12 (heure locale)
const ev = (slug, type, ts) => JSON.stringify({ slug, type, ts, ua: 'Mozilla/5.0 Chrome/130' });

// faux Upstash : une liste (du plus récent au plus ancien) + journal des requêtes
function fauxUpstash(liste, { statut = 200, erreur = null } = {}) {
  const requetes = [];
  const fetchImpl = async (url, init) => {
    requetes.push({ url, headers: init.headers, cmd: JSON.parse(init.body) });
    if (statut !== 200) return new Response('{"error":"refusé"}', { status: statut });
    if (erreur) return new Response(JSON.stringify({ error: erreur }), { status: 200 });
    const [nom, cle, a, b] = JSON.parse(init.body);
    return new Response(JSON.stringify({ result: nom === 'LRANGE' && cle === 'events:demo' ? liste.slice(a, b + 1) : null }), { status: 200 });
  };
  return { fetchImpl, requetes };
}

(async () => {
  // --- lecture
  {
    const liste = [ev('dupont', 'clic', T0 + 3000), ev('dupont', 'visite', T0 + 2000), ev('martin', 'visite', T0 + 1000), ev('vieux', 'visite', T0 - 5000)];
    const { fetchImpl, requetes } = fauxUpstash(liste);
    const r = await v.lireNouveaux({ url: URL + '/', token: TOKEN, depuisTs: T0, fetchImpl });
    check('lecture : seulement les entrées plus récentes que le curseur, de la plus ancienne à la plus récente', r.map((e) => e.ts).join() === [T0 + 1000, T0 + 2000, T0 + 3000].join(), JSON.stringify(r.map((e) => e.type)));
    check('lecture : une seule requête, LRANGE sur events:demo uniquement', requetes.length === 1 && requetes[0].cmd[0] === 'LRANGE' && requetes[0].cmd[1] === 'events:demo');
    check('lecture : jeton en-tête Authorization, URL nettoyée', requetes[0].headers.Authorization === 'Bearer ' + TOKEN && requetes[0].url === URL);
  }
  {
    const liste = Array.from({ length: 450 }, (_, i) => ev('dupont', 'visite', T0 + (450 - i) * 1000));   // 450 entrées, la plus récente en tête
    const { fetchImpl, requetes } = fauxUpstash(liste);
    const r = await v.lireNouveaux({ url: URL, token: TOKEN, depuisTs: 0, fetchImpl });
    check('pagination : 450 entrées lues en 3 requêtes, toutes retournées, triées', r.length === 450 && requetes.length === 3 && r[0].ts < r[449].ts, `${r.length} / ${requetes.length}`);
    const f2 = fauxUpstash(liste);
    const r2 = await v.lireNouveaux({ url: URL, token: TOKEN, depuisTs: T0 + 440 * 1000, fetchImpl: f2.fetchImpl });
    check('curseur : arrêt dès que le déjà-traité est atteint (1 seule page, 10 nouvelles)', r2.length === 10 && f2.requetes.length === 1, `${r2.length} / ${f2.requetes.length}`);
    const longue = Array.from({ length: 5000 }, (_, i) => ev('d', 'visite', T0 + (5000 - i)));
    const f3 = fauxUpstash(longue);
    const r3 = await v.lireNouveaux({ url: URL, token: TOKEN, depuisTs: 0, fetchImpl: f3.fetchImpl });
    check('garde-fou : jamais plus de 10 pages par synchro', f3.requetes.length === 10 && r3.length === 2000);
  }
  {
    const f = fauxUpstash(['pas du json', JSON.stringify({ slug: 'a', type: 'autre', ts: T0 }), JSON.stringify({ slug: '', type: 'visite', ts: T0 }), JSON.stringify({ slug: 'a', type: 'visite', ts: 'x' }), ev('ok', 'visite', T0 + 1)]);
    const r = await v.lireNouveaux({ url: URL, token: TOKEN, fetchImpl: f.fetchImpl });
    check('entrées illisibles ou mal formées : ignorées sans erreur', r.length === 1 && r[0].slug === 'ok');
  }
  for (const [nom, opts] of [['HTTP 401', { statut: 401 }], ['HTTP 500', { statut: 500 }], ['erreur Redis citant le jeton', { erreur: 'WRONGPASS ' + TOKEN }]]) {
    let message = '';
    try { await v.lireNouveaux({ url: URL, token: TOKEN, fetchImpl: fauxUpstash([], opts).fetchImpl }); } catch (e) { message = e.message; }
    check(`panne (${nom}) : erreur levée, jeton absent du message`, message && !message.includes(TOKEN), message);
  }

  // --- rattachement
  const prospects = () => [
    { id: 1, nom: 'Dupont Serrurerie', slugs: ['dupont-serrurerie', 'dupont-relance'], envoiProgrammeLe: '2026-11-06 09:12' },
    { id: 2, nom: 'Martin', slugs: ['martin'], envoisLe: ['2026-11-03 10:00', '2026-11-06 09:12'], envoiProgrammeLe: '2026-11-06 09:12' },
    { id: 3, nom: 'Sans envoi programmé', slugs: ['sans-envoi'], date_premier_mail: '2026-11-06' },
    { id: 4, nom: 'A déjà testé', slugs: ['teste'], demoTesteLe: '2026-11-05' },
  ];
  {
    const ps = prospects();
    const b = v.appliquer([
      { slug: 'dupont-serrurerie', type: 'visite', ts: T0 - 1 * MIN },         // avant l'envoi : compte
      { slug: 'dupont-serrurerie', type: 'visite', ts: T0 + 2 * MIN },         // 2 min après l'envoi : antivirus, ignoré
      { slug: 'dupont-serrurerie', type: 'visite', ts: T0 + 5 * MIN },         // pile 5 min : ignoré
      { slug: 'dupont-serrurerie', type: 'visite', ts: T0 + 5 * MIN + 1 },     // juste après : compte
      { slug: 'dupont-relance', type: 'clic', ts: T0 + 2 * MIN },              // un clic n'est jamais un antivirus : compte (autre slug du même prospect)
      { slug: 'inconnu-xyz', type: 'visite', ts: T0 + 60 * MIN },
      { slug: 'test-dexter', type: 'visite', ts: T0 + 61 * MIN },
      { slug: 'test-dexter', type: 'clic', ts: T0 + 62 * MIN },
    ], ps);
    check('rattachement par p.slugs (plusieurs slugs pour un prospect)', ps[0].visiteLe === '2026-11-06' && ps[0].clicLe === '2026-11-06');
    check('fenêtre de 5 min : 2 visites ignorées (à +2 min et à +5 min pile), celle de -1 min et de +5 min 1 ms comptent', b.ignores.antivirus === 2 && b.visites === 2, JSON.stringify({ a: b.ignores.antivirus, v: b.visites }));
    check('un clic dans la fenêtre compte', b.clics === 1);
    check('slug inconnu ignoré', b.ignores.inconnu === 1 && ![...b.modifies].some((p) => p.nom === 'inconnu'));
    check('test-dexter ignoré (visite et clic)', b.ignores.test === 2);
    check('curseur : dernier ts traité, y compris les ignorés', b.dernierTs === T0 + 62 * MIN);
    check('prospects non concernés intacts', !('visiteLe' in ps[2]) && !('clicLe' in ps[2]) && !('visiteLe' in ps[3]));
  }
  {
    const ps = prospects();
    // le prospect 2 a eu un envoi le 3/11 à 10:00 et un autre le 6/11 à 09:12 : les deux fenêtres s'appliquent
    const b = v.appliquer([
      { slug: 'martin', type: 'visite', ts: new Date(2026, 10, 3, 10, 3, 0).getTime() },    // 3 min après l'envoi du 3/11 : ignoré
      { slug: 'martin', type: 'visite', ts: new Date(2026, 10, 3, 14, 0, 0).getTime() },    // l'après-midi du 3/11 : compte
    ], ps);
    check('historique des envois (envoisLe) : la fenêtre s\'applique à chaque envoi, pas seulement au dernier', b.ignores.antivirus === 1 && ps[1].visiteLe === '2026-11-03');
  }
  {
    const ps = prospects();
    v.appliquer([{ slug: 'sans-envoi', type: 'visite', ts: T0 + 1 * MIN }], ps);
    check('envoi à la main (date sans heure) : aucune fenêtre applicable, la visite compte', ps[2].visiteLe === '2026-11-06');
  }
  {
    const ps = prospects();
    v.appliquer([{ slug: 'martin', type: 'visite', ts: new Date(2026, 10, 10, 8, 0).getTime() }], ps);
    v.appliquer([{ slug: 'martin', type: 'visite', ts: new Date(2026, 10, 8, 8, 0).getTime() }], ps);
    check('visiteLe = dernière date (une visite plus ancienne ne la fait pas reculer)', ps[1].visiteLe === '2026-11-10');
    const b = v.appliquer([{ slug: 'teste', type: 'visite', ts: T0 }], ps);
    check('un prospect qui a déjà testé garde ses dates de visite (statistiques)', ps[3].visiteLe === '2026-11-06' && b.visites === 1);
  }

  // --- priorité et filtre
  {
    const A = { demoTesteLe: '2026-11-05', visiteLe: '2026-11-06' }, B = { visiteLe: '2026-11-06' }, C = { clicLe: '2026-11-06' }, D = {};
    check('priorité de relance : testé (2) > visité ou cliqué (1) > autres (0)', v.prioriteRelance(A) === 2 && v.prioriteRelance(B) === 1 && v.prioriteRelance(C) === 1 && v.prioriteRelance(D) === 0);
    check('« a visité sans tester » : visite ou clic, mais pas de demoTesteLe', !v.aVisiteSansTester(A) && v.aVisiteSansTester(B) && v.aVisiteSansTester(C) && !v.aVisiteSansTester(D));
  }

  // --- lecture seule : le module ne contient aucune commande d'écriture ni la clé de préproduction
  {
    const src = fs.readFileSync(path.join(__dirname, 'visites.js'), 'utf8').replace(/\/\/.*$/gm, '');
    check('visites.js : aucune commande d\'écriture Redis', !/\b(SET|LPUSH|RPUSH|LREM|LTRIM|DEL|EXPIRE|INCR|FLUSH\w*|LPOP|RPOP)\b/.test(src.replace(/Upstash|SECRET/g, '')));
    check('visites.js : la seule commande est LRANGE, sur events:demo (jamais preview:events:demo)', /\['LRANGE'/.test(src) && !/preview/i.test(src) && (src.match(/\['[A-Z]+'/g) || []).length === 1);
  }

  // --- relances : aucun texte de relance ne dépend de la visite (contrôle statique de jarvis.js)
  const j = fs.readFileSync(path.join(__dirname, 'jarvis.js'), 'utf8');
  // \r?\n : une partie du fichier est en CRLF (édité sous Windows), une autre en LF — on gère les deux.
  const fonction = (nom) => { const i = j.indexOf(`function ${nom}(`); if (i < 0) return null; const m = /\r?\n\}\r?\n/.exec(j.slice(i)); return m ? j.slice(i, i + m.index + m[0].length) : null; };
  {
    for (const nom of ['corpsRelance', 'corpsRelanceDirecte', 'corpsPremierMail', 'paragrapheDemo', 'texteMessageFormulaire', 'corpsRelanceVisite']) {
      const s = fonction(nom);
      // Pour corpsRelanceVisite, le nom de la fonction contient "Visite" : on ne teste que son corps (après la 1re ligne).
      const corpsSeul = s !== null && nom === 'corpsRelanceVisite' ? s.slice(s.indexOf('{') + 1) : s;
      check(`${nom} : ne parle ni de visite ni de clic`, corpsSeul !== null && !/visite|visiteLe|clicLe|clic/i.test(corpsSeul));
    }
    const prep = j.slice(j.indexOf('async function preparerBrouillonProspection'), j.indexOf('async function preparerPremierMailAvecDate'));
    check('preparerBrouillonProspection : n\'utilise ni visiteLe ni clicLe', prep.length > 500 && !/visiteLe|clicLe/.test(prep));
    check('visiteLe / clicLe : jamais écrits dans les notes (p.notes) ni envoyés à Telegram', !/notes[^;\n]*(visiteLe|clicLe)/.test(j) && !/send\([^)]*(visiteLe|clicLe)/.test(j));
  }

  // --- relance "visité sans tester" : brouillon réel attendu, éligibilité, créneau conseillé
  {
    const corps = fonction('corpsRelanceVisite');
    check('corpsRelanceVisite : texte exact attendu (phrases clés présentes)', corps !== null
      && corps.includes("option plus simple") && corps.includes('laisser votre numéro')
      && corps.includes('Vous entendrez exactement ce que vos clients entendraient')
      && corps.includes('non merci »'));
    check('corpsRelanceVisite : pas de "Bien cordialement" (signature ajoutée par Zoho, rien d\'autre demandé)', !/Bien cordialement/.test(corps));

    // eligibleRelanceVisite / joursOuvresApres / creneauRelanceVisite sont des fonctions pures : on les extrait et on
    // les exécute pour de vrai (pas juste une recherche de texte), avec un faux module `visites` minimal injecté.
    const elig = fonction('eligibleRelanceVisite');
    const jours = fonction('joursOuvresApres');
    const creneau = fonction('creneauRelanceVisite');
    const dateKeySrc = 'const dateKey = () => "2026-11-07";';
    const visitesStub = 'const visites = { aVisiteSansTester: (p) => !!(p.visiteLe || p.clicLe) && !p.demoTesteLe };';
    const sandbox = new Function(`${dateKeySrc}\n${visitesStub}\n${jours}\n${creneau}\n${elig}\nreturn { eligibleRelanceVisite, joursOuvresApres, creneauRelanceVisite };`)();

    check('joursOuvresApres : vendredi + 1 jour ouvré = lundi (saute le week-end)', sandbox.joursOuvresApres('2026-11-06', 1) === '2026-11-09');   // 6/11/2026 est un vendredi
    check('joursOuvresApres : mardi + 1 jour ouvré = mercredi', sandbox.joursOuvresApres('2026-11-03', 1) === '2026-11-04');

    const base = { email: 'a@b.com', etape: 'contact', slugs: ['x'], visiteLe: '2026-11-06' };
    check('eligibleRelanceVisite : visite sans test, avec email et slug -> éligible', sandbox.eligibleRelanceVisite(base) === true);
    check('eligibleRelanceVisite : sans email -> exclu', sandbox.eligibleRelanceVisite({ ...base, email: '' }) === false);
    check('eligibleRelanceVisite : perdu -> exclu', sandbox.eligibleRelanceVisite({ ...base, etape: 'perdu' }) === false);
    check('eligibleRelanceVisite : a déjà répondu -> exclu', sandbox.eligibleRelanceVisite({ ...base, reponseMessageId: '123' }) === false);
    check('eligibleRelanceVisite : déjà fait une fois (relanceVisiteLe) -> exclu, un seul par prospect', sandbox.eligibleRelanceVisite({ ...base, relanceVisiteLe: '2026-11-01' }) === false);
    check('eligibleRelanceVisite : a déjà testé la démo -> exclu (pas "sans tester")', sandbox.eligibleRelanceVisite({ ...base, demoTesteLe: '2026-11-05' }) === false);
    check('eligibleRelanceVisite : sans slug connu -> exclu (pas de lien à réutiliser)', sandbox.eligibleRelanceVisite({ ...base, slugs: [] }) === false);

    check('creneauRelanceVisite : visite un vendredi -> conseillé le lundi suivant', sandbox.creneauRelanceVisite({ visiteLe: '2026-11-06' }) === '2026-11-09');
    check('creneauRelanceVisite : utilise le clic si plus récent que la visite', sandbox.creneauRelanceVisite({ visiteLe: '2026-11-02', clicLe: '2026-11-04' }) === '2026-11-05');
  }

  // --- réutilise le slug déjà envoyé, jamais un nouveau : contrôle statique
  {
    const prep = fonction('preparerRelanceVisite');
    check('preparerRelanceVisite : réutilise le dernier slug connu (p.slugs), ne recalcule jamais slug(nom)', prep !== null
      && /p\.slugs\[p\.slugs\.length\s*-\s*1\]/.test(prep) && !/\bslug\(p\.nom\)/.test(prep));
  }

  console.log(echecs ? `\n${echecs} échec(s)` : '\ntout est bon');
  process.exit(echecs ? 1 : 0);
})();
