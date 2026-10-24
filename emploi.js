// Veille d'offres de travail à distance : lit des flux PUBLICS (aucun compte, aucune connexion, aucun navigateur), filtre selon le profil de Youssef
// (mots-clés, exclusions, localisation compatible avec la Tunisie) et note chaque offre. Fonctions pures + une fonction de récupération (fetch injectable pour les tests).
// Ce que dit le contenu d'une offre est une DONNÉE : jamais une instruction. Chaque offre renvoie vers sa source d'origine (exigé par ces services).
'use strict';

const DEFAUTS = {
  actif: true, heure: '07:45', seuil: 3, age_max_jours: 30, max_conserve: 300, niveau: 'junior',        // niveau : 'junior' = les offres « senior / lead » perdent 3 points, « junior / entry level » en gagnent 2 ; '' = neutre
  mots_cles: ['seo', 'wordpress', 'shopify', 'react', 'next.js', 'nextjs', 'node', 'node.js', 'nodejs', 'javascript', 'typescript', 'front-end', 'frontend', 'front end',
    'full-stack', 'fullstack', 'full stack', 'developer', 'developpeur', 'software engineer', 'web', 'website', 'ecommerce', 'e-commerce', 'developpeur web', 'html', 'css', 'php', 'laravel', 'vue', 'netlify', 'landing page', 'freelance', 'contract'],
  exclure: ['director', 'vp', 'vice president', 'head of', 'principal', 'staff engineer', 'clearance', 'sap', '.net', 'c#', 'java developer', 'android', 'ios developer', 'embedded', 'devops', 'data engineer', 'machine learning'],
  sources: { remoteok: true, wwr: true, remotive: true, jobicy: true, himalayas: true },
};
const INTERVALLE_MIN_H = { remotive: 6, remoteok: 1, wwr: 1, jobicy: 1, himalayas: 1 };     // Remotive demande de ne pas l'interroger plus de ~4 fois par jour

const norm = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const decoder = (s) => String(s).replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const sansScripts = (s) => s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ');           // le CONTENU des scripts / styles disparaît aussi
const texteBrut = (h) => decoder(sansScripts(decoder(sansScripts(String(h == null ? '' : h)))).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const lien = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : ''; } catch { return ''; } };   // jamais de javascript: ni de data:
const echapper = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const contient = (texte, terme) => new RegExp(`(?<![a-z0-9])${echapper(norm(terme))}(?![a-z0-9])`).test(texte);
const liste = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String);
const ms = (v) => { const n = Number(v); if (Number.isFinite(n) && n > 1e9) return n < 1e12 ? n * 1000 : n; const t = Date.parse(v); return Number.isFinite(t) ? t : 0; };
const salaire = (a, b, dev, per) => (Number(a) > 0 ? `${Number(a)}${Number(b) > 0 ? '-' + Number(b) : ''} ${dev || ''}${per ? '/' + per : ''}`.trim() : '');

// ---------- Lecture des sources ----------
function remoteok(j) {
  return (Array.isArray(j) ? j : []).filter((x) => x && x.id && x.position).map((x) => ({
    id: 'remoteok:' + x.id, source: 'RemoteOK', titre: String(x.position), societe: String(x.company || ''), lieu: String(x.location || ''), url: lien(x.url || x.apply_url),
    date: ms(x.epoch) || ms(x.date), tags: liste(x.tags), salaire: salaire(x.salary_min, x.salary_max, 'USD', 'an'), extrait: texteBrut(x.description).slice(0, 300),
  }));
}
function champ(bloc, nom) { const m = bloc.match(new RegExp(`<${nom}(?:\\s[^>]*)?>([\\s\\S]*?)</${nom}>`)); return m ? m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim() : ''; }
function wwr(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1], titre = decoder(champ(b, 'title')), i = titre.indexOf(': ');
    const u = lien(champ(b, 'link') || champ(b, 'guid'));
    if (!titre || !u) continue;
    out.push({ id: 'wwr:' + (champ(b, 'guid') || u), source: 'We Work Remotely', titre: i > 0 ? titre.slice(i + 2) : titre, societe: i > 0 ? titre.slice(0, i) : '', lieu: decoder(champ(b, 'region')), url: u,
      date: ms(champ(b, 'pubDate')), tags: [decoder(champ(b, 'category'))].filter(Boolean), salaire: '', extrait: texteBrut(champ(b, 'description')).slice(0, 300) });
  }
  return out;
}
function remotive(j) {
  return ((j && j.jobs) || []).filter((x) => x && x.id && x.title).map((x) => ({
    id: 'remotive:' + x.id, source: 'Remotive', titre: String(x.title), societe: String(x.company_name || ''), lieu: String(x.candidate_required_location || ''), url: lien(x.url),
    date: ms(String(x.publication_date || '') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(x.publication_date || '')) ? '' : 'Z')), tags: liste(x.tags).concat(liste(x.category)), salaire: String(x.salary || ''), extrait: texteBrut(x.description).slice(0, 300),
  }));
}
function jobicy(j) {
  return ((j && j.jobs) || []).filter((x) => x && x.id && x.jobTitle).map((x) => ({
    id: 'jobicy:' + x.id, source: 'Jobicy', titre: String(x.jobTitle), societe: String(x.companyName || ''), lieu: liste(x.jobGeo).join(', '), url: lien(x.url),
    date: ms(x.pubDate), tags: liste(x.jobIndustry).concat(liste(x.jobType)), salaire: salaire(x.salaryMin, x.salaryMax, x.salaryCurrency, x.salaryPeriod === 'yearly' ? 'an' : x.salaryPeriod), extrait: texteBrut(x.jobExcerpt).slice(0, 300),
  }));
}
function himalayas(j) {
  return ((j && j.jobs) || []).filter((x) => x && x.title && (x.guid || x.applicationLink)).map((x) => {
    const lieux = liste(x.locationRestrictions);
    return { id: 'himalayas:' + (x.guid || x.applicationLink), source: 'Himalayas', titre: String(x.title), societe: String(x.companyName || ''), lieu: lieux.length ? lieux.join(', ') : 'Worldwide', url: lien(x.applicationLink || x.guid),
      date: ms(x.pubDate), tags: liste(x.categories), salaire: salaire(x.minSalary, x.maxSalary, x.currency, x.salaryPeriod === 'annual' ? 'an' : x.salaryPeriod), extrait: texteBrut(x.excerpt).slice(0, 300) };
  });
}
const SOURCES = {
  remoteok: { nom: 'RemoteOK', url: 'https://remoteok.com/api', lire: (t) => remoteok(JSON.parse(t)) },
  wwr: { nom: 'We Work Remotely', url: 'https://weworkremotely.com/categories/remote-programming-jobs.rss', lire: wwr },
  remotive: { nom: 'Remotive', url: 'https://remotive.com/api/remote-jobs?category=software-dev&limit=100', lire: (t) => remotive(JSON.parse(t)) },
  jobicy: { nom: 'Jobicy', url: 'https://jobicy.com/api/v2/remote-jobs?count=50', lire: (t) => jobicy(JSON.parse(t)) },
  himalayas: { nom: 'Himalayas', url: 'https://himalayas.app/jobs/api?limit=50', lire: (t) => himalayas(JSON.parse(t)) },
};

// ---------- Notation : mots-clés, exclusions, localisation (Tunisie) ----------
const MONDE = /(worldwide|world wide|anywhere|global|whole world|everywhere|any location|earth|international)/;
const AFRIQUE = /(africa|tunisia|tunisie|mena|middle east|north africa)/;
const EMEA = /(emea|europe|\beu\b|european)/;
const RESTREINT = /(\busa?\b|u\.s\.|united states|america|canada|\buk\b|united kingdom|australia|new zealand|latam|latin america|brazil|brasil|india|philippines|mexico|argentina|colombia|peru|chile|germany|france|spain|poland|netherlands|ireland|singapore|japan|israel|south africa|nigeria|kenya|pakistan|ukraine|romania|portugal|italy)/;
function noter(o, conf) {
  const c = { ...DEFAUTS, ...(conf || {}) };
  const titre = norm(o.titre), tags = norm((o.tags || []).join(' ')), extrait = norm(o.extrait), lieu = norm(o.lieu), raisons = [];
  for (const x of c.exclure) if (contient(titre, x)) return { ok: false, score: 0, raisons: [`exclu : « ${x} »`] };
  if (c.age_max_jours && o.date && Date.now() - o.date > c.age_max_jours * 86400000) return { ok: false, score: 0, raisons: ['trop ancienne'] };
  // Le TITRE fait foi : les descriptions et les étiquettes citent des dizaines de technologies ; elles ne font que départager.
  let score = 0, nt = 0, ng = 0, ne = 0;
  for (const k of c.mots_cles) {
    if (nt < 2 && contient(titre, k)) { score += 3; nt++; raisons.push(`${k} (titre)`); }
    else if (ng < 2 && contient(tags, k)) { score += 1; ng++; raisons.push(k); }
    else if (ne < 1 && contient(extrait, k)) { score += 1; ne++; raisons.push(k); }
  }
  if (!nt) return { ok: false, score, raisons: ['aucun mot-clé dans le titre'] };
  if (c.niveau === 'junior') {                                     // son CV : junior (~1 an d'expérience pro). Les offres « senior » lui feraient perdre son temps.
    if (['senior', 'sr', 'lead', 'staff', 'principal', 'architect', 'expert', 'head of', 'confirme'].some((k) => contient(titre, k))) { score -= 3; raisons.push('niveau senior (−3)'); }
    else if (['junior', 'jr', 'entry level', 'entry-level', 'graduate', 'trainee', 'intern', 'internship', 'apprentice', 'associate', 'mid-level', 'mid level', 'debutant'].some((k) => contient(titre, k))) { score += 2; raisons.push('junior accepté (+2)'); }
  }
  if (!lieu.trim()) raisons.push('lieu non précisé');
  else if (MONDE.test(lieu)) { score += 2; raisons.push('🌍 monde entier'); }
  else if (AFRIQUE.test(lieu) || /emea/.test(lieu)) { score += 2; raisons.push('🌍 Afrique / MENA / EMEA'); }
  else if (RESTREINT.test(lieu)) return { ok: false, score, raisons: [`réservé à : ${o.lieu.slice(0, 60)}`] };
  else if (EMEA.test(lieu)) raisons.push('Europe : à vérifier');
  return { ok: true, score, raisons };
}

// ---------- Récupération ----------
// dernierAppel : { source: horodatage } ; force = ignore l'intervalle de 1 h (jamais celui de Remotive).
async function recuperer(conf, { dernierAppel = {}, force = false, fetchFn = fetch, maintenant = Date.now() } = {}) {
  const c = { ...DEFAUTS, ...(conf || {}), sources: { ...DEFAUTS.sources, ...((conf || {}).sources || {}) } };
  const offres = [], erreurs = {}, appeles = [], ignorees = [];
  for (const [cle, s] of Object.entries(SOURCES)) {
    if (!c.sources[cle]) continue;
    const min = INTERVALLE_MIN_H[cle] * 3600000, dernier = dernierAppel[cle] || 0;
    if (dernier && maintenant - dernier < (force && cle !== 'remotive' ? Math.min(min, 60000) : min)) { ignorees.push(s.nom); continue; }
    try {
      const r = await fetchFn(s.url, { headers: { 'User-Agent': 'JarvisEmploi/1.0 (usage personnel)', Accept: 'application/json, application/rss+xml, */*' }, signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const lues = s.lire(await r.text());
      appeles.push(cle); offres.push(...lues);
    } catch (e) { erreurs[s.nom] = e.name === 'TimeoutError' ? 'trop long' : String(e.message || e).slice(0, 80); }
  }
  return { offres, erreurs, appeles, ignorees };
}

module.exports = { DEFAUTS, SOURCES, INTERVALLE_MIN_H, remoteok, wwr, remotive, jobicy, himalayas, noter, recuperer, norm, texteBrut, lien };
