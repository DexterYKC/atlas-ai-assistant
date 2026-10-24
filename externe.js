// GitHub et Netlify pour le tableau de bord : LECTURE SEULE, mise en cache 5 min.
// Les jetons restent dans ce processus : ils ne sont jamais envoyés au navigateur ni écrits dans une réponse.
// Seuls les dépôts / sites déjà listés par les API sont consultables en détail (pas de chemin libre fourni par la page).
'use strict';
const tls = require('tls');
const net = require('net');
const dns = require('dns').promises;

const TTL = 5 * 60000;
const MIN_ENTRE_ACTUALISATIONS = 20000;      // le bouton "Actualiser" ne martèle pas les API
const coupe = (s, n) => String(s == null ? '' : s).slice(0, n);

// Adresse de dépôt normalisée : "https://github.com/proprio/depot" (sans .git, sans identifiants, en minuscules)
function normDepot(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  const ssh = s.match(/^git@([^:]+):(.+)$/);
  if (ssh) s = `https://${ssh[1]}/${ssh[2]}`;
  s = s.replace(/^git\+/, '').replace(/^ssh:\/\/git@/, 'https://').replace(/\/\/[^@/]+@/, '//').replace(/\.git$/, '').replace(/\/+$/, '');
  return s.toLowerCase();
}
const cle = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

module.exports = function creer({ getCfg }) {
  const c = { gh: { at: 0, tentative: 0, v: null, erreur: '' }, nf: { at: 0, tentative: 0, v: null, erreur: '' } };

  async function appel(url, entetes) {
    const r = await fetch(url, { headers: entetes, signal: AbortSignal.timeout(15000) });
    if (!r.ok) { const e = new Error(String(r.status)); e.statut = r.status; throw e; }
    return r.json();
  }
  const gh = (p) => appel(`https://api.github.com${p}`, { Authorization: `Bearer ${getCfg().github_token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mini-jarvis' });
  const nf = (p) => appel(`https://api.netlify.com/api/v1${p}`, { Authorization: `Bearer ${getCfg().netlify_token}`, 'User-Agent': 'mini-jarvis' });
  const messageErreur = (nom, e) => e.statut === 401 || e.statut === 403 ? `${nom} refuse le jeton (erreur ${e.statut}) : vérifie-le ou régénère-le.` : e.statut === 429 ? `${nom} : trop de requêtes, réessaie dans quelques minutes.` : `${nom} : ${e.name === 'TimeoutError' ? 'pas de réponse' : e.message}`;

  async function pool(items, n, f) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const x = items[i++]; await f(x); } }));
  }

  // Un seul appel réseau à la fois par source, données périmées gardées si l'API échoue.
  async function charger(cle_, actif, nomService, produire, force) {
    const k = c[cle_];
    if (!actif) return { ok: false, message: `Aucun jeton ${nomService} dans config.json.` };
    const frais = k.v && Date.now() - k.at < TTL;
    if (frais && !force) return { ok: true, at: k.at, ...k.v };
    if (force && k.v && Date.now() - k.tentative < MIN_ENTRE_ACTUALISATIONS) return { ok: true, at: k.at, ...k.v };
    if (k.enCours) return k.enCours;
    k.tentative = Date.now();
    k.enCours = (async () => {
      try {
        k.v = await produire(); k.at = Date.now(); k.erreur = '';
        return { ok: true, at: k.at, ...k.v };
      } catch (e) {
        k.erreur = messageErreur(nomService, e);
        return k.v ? { ok: true, at: k.at, ...k.v, avertissement: k.erreur } : { ok: false, message: k.erreur };
      } finally { k.enCours = null; }
    })();
    return k.enCours;
  }

  // ---------- GitHub ----------
  const depots = (force) => charger('gh', !!getCfg().github_token, 'GitHub', async () => {
    const tous = [];
    for (let page = 1; page <= 3; page++) {
      const l = await gh(`/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
      tous.push(...l);
      if (l.length < 100) break;
    }
    return {
      depots: tous.map((r) => ({
        nom: r.full_name, court: r.name, prive: !!r.private, fork: !!r.fork, archive: !!r.archived, description: coupe(r.description, 200), langage: r.language || '',
        url: r.html_url, pousse: r.pushed_at, ouvertes: r.open_issues_count || 0, branche: r.default_branch, site: coupe(r.homepage, 200), etoiles: r.stargazers_count || 0,
      })),
    };
  }, force);
  async function detailDepot(nom) {
    const liste = c.gh.v && c.gh.v.depots;
    if (!liste || !liste.some((d) => d.nom === nom)) return { ok: false, message: 'Dépôt inconnu (actualise la liste).' };
    const sur = async (f, defaut) => { try { return await f(); } catch { return defaut; } };
    const [commits, prs, issues, runs] = await Promise.all([
      sur(() => gh(`/repos/${nom}/commits?per_page=8`), []),
      sur(() => gh(`/repos/${nom}/pulls?state=open&per_page=8`), []),
      sur(() => gh(`/repos/${nom}/issues?state=open&per_page=10`), []),
      sur(() => gh(`/repos/${nom}/actions/runs?per_page=1`), { workflow_runs: [] }),
    ]);
    const run = (runs.workflow_runs || [])[0];
    return {
      ok: true, nom,
      commits: commits.map((x) => ({ date: x.commit && x.commit.author && x.commit.author.date, message: coupe((x.commit && x.commit.message || '').split('\n')[0], 140), auteur: coupe(x.commit && x.commit.author && x.commit.author.name, 40), url: x.html_url })),
      prs: prs.map((x) => ({ numero: x.number, titre: coupe(x.title, 140), auteur: x.user && x.user.login, date: x.created_at, brouillon: !!x.draft, url: x.html_url })),
      issues: issues.filter((x) => !x.pull_request).map((x) => ({ numero: x.number, titre: coupe(x.title, 140), auteur: x.user && x.user.login, date: x.created_at, url: x.html_url })),
      action: run ? { nom: coupe(run.name, 60), etat: run.status, resultat: run.conclusion || '', date: run.updated_at, url: run.html_url } : null,
    };
  }

  // ---------- Netlify ----------
  const deploiement = (d) => ({
    id: d.id, etat: d.state, cree: d.created_at, publie: d.published_at || '', erreur: coupe(d.error_message, 200), branche: d.branch || '',
    message: coupe(d.title, 120), contexte: d.context || '', duree: d.deploy_time || 0, commit: coupe(d.commit_ref, 7), url: d.ssl_url || d.deploy_ssl_url || '',
  });
  const sites = (force) => charger('nf', !!getCfg().netlify_token, 'Netlify', async () => {
    const liste = await nf('/sites?per_page=100&filter=all');
    const base = liste.map((s) => ({
      id: s.id, nom: s.name, url: s.ssl_url || s.url || '', domaine: s.custom_domain || '', admin: s.admin_url || '', compte: s.account_name || '',
      depot: (s.build_settings && s.build_settings.repo_url) || '', branche: (s.build_settings && s.build_settings.repo_branch) || '', maj: s.updated_at, cree: s.created_at,
      capture: /^https:\/\//.test(s.screenshot_url || '') ? s.screenshot_url : '',
    }));
    await pool(base.slice(0, 60), 5, async (s) => { try { const [d] = await nf(`/sites/${s.id}/deploys?per_page=1`); if (d) s.deploy = deploiement(d); } catch { /* état facultatif */ } });
    return { sites: base, compte: await compte().catch(() => null) };
  }, force);
  async function detailSite(id) {
    const liste = c.nf.v && c.nf.v.sites;
    if (!liste || !liste.some((s) => s.id === id)) return { ok: false, message: 'Site inconnu (actualise la liste).' };
    let d = [];
    try { d = await nf(`/sites/${id}/deploys?per_page=8`); } catch (e) { return { ok: false, message: messageErreur('Netlify', e) }; }
    return { ok: true, id, deploys: d.map(deploiement) };
  }

  // ---------- Compte Netlify : consommation du forfait ----------
  let cacheCompte = { at: 0, v: null };
  async function compte() {
    if (cacheCompte.v && Date.now() - cacheCompte.at < 10 * 60000) return cacheCompte.v;
    const a = (await nf('/accounts'))[0]; if (!a) return null;
    const cap = a.capabilities || {}, u = (x) => x ? { utilise: x.used || 0, inclus: x.included || 0 } : null;
    cacheCompte = { at: Date.now(), v: { offre: a.type_name || '', bande_passante: u(cap.bandwidth), minutes_build: u(cap.build_minutes), analytics: !!(cap.analytics && cap.analytics.included), fin_periode: a.next_billing_period_start || '' } };
    return cacheCompte.v;
  }

  // ---------- Vérifications directes des sites (lecture seule, adresses publiques uniquement) ----------
  const ipPrivee = (ip) => {
    // IPv6 : liste blanche. Seules les adresses publiques classiques (2000::/3) sont acceptées, hors 6to4 (2002::/16, qui peut cacher une IPv4 privée).
    // Tout le reste (::1, fe80::, fc00::/7, ::ffff:x.x.x.x, NAT64...) est refusé.
    if (net.isIPv6(ip)) { const premier = parseInt(ip.split(':')[0] || '0', 16); return !(premier >= 0x2000 && premier <= 0x3fff && premier !== 0x2002); }
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  };
  async function urlSure(u) {
    let x; try { x = new URL(u); } catch { throw new Error('adresse invalide'); }
    if (!/^https?:$/.test(x.protocol) || x.username || x.password) throw new Error('adresse refusée');
    const h = x.hostname.replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) throw new Error('adresse non publique');
    if (net.isIP(h)) { if (ipPrivee(h)) throw new Error('adresse non publique'); }
    else { const r = await dns.lookup(h, { all: true }); if (!r.length || r.some((a) => ipPrivee(a.address))) throw new Error('adresse non publique'); }
    return x;
  }
  // GET avec redirections suivies à la main (chacune revérifiée), corps limité en taille.
  async function requete(url, { max = 250000, timeout = 20000, corps = true, suivre = true } = {}) {
    let courant = url;
    for (let saut = 0; saut < 5; saut++) {
      await urlSure(courant);
      const t0 = Date.now();
      const r = await fetch(courant, { redirect: 'manual', signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'mini-jarvis-bilan/1.0', Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
      const ms = Date.now() - t0, loc = r.headers.get('location');
      if (suivre && [301, 302, 303, 307, 308].includes(r.status) && loc) { try { await r.body.cancel(); } catch { /* ignoré */ } courant = new URL(loc, courant).href; continue; }
      let texte = '';
      if (corps && r.body) {
        const rd = r.body.getReader(), parts = []; let n = 0;
        while (true) { const { done, value } = await rd.read(); if (done) break; parts.push(value); n += value.length; if (n >= max) { await rd.cancel(); break; } }
        texte = Buffer.concat(parts).toString('utf8');
      } else { try { await r.body.cancel(); } catch { /* ignoré */ } }
      return { statut: r.status, ms, entetes: Object.fromEntries(r.headers), texte, url: courant, location: loc || '' };
    }
    throw new Error('trop de redirections');
  }
  function certificat(host) {
    return new Promise((res) => {
      urlSure('https://' + host).then(() => {
        const s = tls.connect({ host, port: 443, servername: host, timeout: 6000 }, () => {
          const c = s.getPeerCertificate(); s.end();
          res(c && c.valid_to ? { jours: Math.floor((new Date(c.valid_to) - Date.now()) / 86400000), fin: c.valid_to } : null);
        });
        s.on('error', () => res(null)); s.on('timeout', () => { s.destroy(); res(null); });
      }).catch(() => res(null));
    });
  }
  const urlSite = (s) => (s.domaine ? 'https://' + s.domaine : s.url);

  // Santé rapide (pour les cartes) : en ligne ?, temps de réponse, certificat. Cache 5 min.
  const cacheSante = new Map();
  async function santeSite(s) {
    const hit = cacheSante.get(s.id);
    if (hit && Date.now() - hit.at < TTL) return hit.v;
    const base = urlSite(s); let v;
    try {
      const [r, cert] = await Promise.all([requete(base, { corps: false, timeout: 20000 }), certificat(new URL(base).hostname)]);
      v = { statut: r.statut, ms: r.ms, ssl_jours: cert ? cert.jours : null };
    } catch (e) { v = { statut: 0, ms: 0, erreur: e.name === 'TimeoutError' ? 'pas de réponse en 20 s' : e.message, ssl_jours: null }; }
    v.at = Date.now(); cacheSante.set(s.id, { at: Date.now(), v }); return v;
  }
  async function santeTous() {
    const out = {};
    await pool(cacheSites(), 3, async (s) => { out[s.id] = await santeSite(s); });
    return { ok: true, sante: out };
  }

  const attrs = (tag) => { const o = {}; for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) o[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3]; return o; };
  const OUTILS = [
    ['Google Analytics', /googletagmanager\.com\/gtag\/js\?id=([\w-]+)|gtag\(\s*['"]config['"]\s*,\s*['"]([\w-]+)|google-analytics\.com\/(?:analytics|ga)\.js/i],
    ['Google Tag Manager', /googletagmanager\.com\/gtm\.js\?id=(GTM-\w+)/i], ['Plausible', /plausible\.io\/js/i], ['Umami', /umami/i], ['Cloudflare Web Analytics', /static\.cloudflareinsights\.com\/beacon/i],
    ['Matomo', /matomo|piwik/i], ['Fathom', /usefathom\.com/i], ['GoatCounter', /gc\.zgo\.at/i], ['Microsoft Clarity', /clarity\.ms/i], ['Hotjar', /static\.hotjar\.com/i], ['Pixel Facebook', /connect\.facebook\.net[^"']*fbevents|fbq\(/i],
  ];
  function analyserPage(html) {
    const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrs(m[0]));
    const meta = (nom) => { const m = metas.find((x) => (x.name || x.property || '').toLowerCase() === nom); return m ? (m.content || '').trim() : ''; };
    const titre = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
    const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => attrs(m[0]));
    const texte = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, ' ').replace(/\s+/g, ' ').trim();
    return {
      titre, description: meta('description'), viewport: !!meta('viewport'), robots_meta: meta('robots').toLowerCase(), og: !!(meta('og:title') && meta('og:image')),
      h1: (html.match(/<h1\b/gi) || []).length, images: imgs.length, sans_alt: imgs.filter((i) => i.alt === undefined).length,
      langue: ((html.match(/<html[^>]*\blang=["']([^"']+)/i) || [])[1] || ''),
      texte_visible: texte.length, scripts: (html.match(/<script\b/gi) || []).length,
      outils: OUTILS.map(([nom, re]) => { const m = html.match(re); return m ? { nom, id: (m[1] || m[2] || '').slice(0, 30) } : null; }).filter(Boolean),
    };
  }
  const stats = (brut) => {
    const util = brut.filter((d) => !d.skipped && ['ready', 'error'].includes(d.state)), ok = util.filter((d) => d.state === 'ready');
    const echec = brut.find((d) => d.state === 'error');
    return {
      total: util.length, reussis: ok.length, taux: util.length ? Math.round(100 * ok.length / util.length) : null,
      duree_moy: ok.length ? Math.round(ok.reduce((n, d) => n + (d.deploy_time || 0), 0) / ok.length) : null,
      dernier: brut[0] ? deploiement(brut[0]) : null, dernier_echec: echec ? deploiement(echec) : null,
      serie: brut.slice().reverse().map((d) => ({ etat: d.state, duree: d.deploy_time || 0, cree: d.created_at, message: coupe(d.title, 80) })),
    };
  };
  async function formulaires(id) {
    const f = await nf(`/sites/${id}/forms`);
    if (!f.length) return { presents: false };
    const sub = await nf(`/sites/${id}/submissions?per_page=100`), lim = Date.now() - 30 * 86400000;
    // seulement des COMPTEURS : jamais le contenu des messages (données personnelles de tes visiteurs)
    return { presents: true, formulaires: f.map((x) => ({ nom: coupe(x.name, 60), envois: x.submission_count || 0 })), total: f.reduce((n, x) => n + (x.submission_count || 0), 0), derniers_30j: sub.filter((x) => new Date(x.created_at) > lim).length, dernier: sub[0] ? sub[0].created_at : '' };
  }
  async function activiteDepot(d) {
    const depuis = new Date(Date.now() - 56 * 86400000).toISOString();
    const [commits, detail] = await Promise.all([gh(`/repos/${d.nom}/commits?per_page=100&since=${depuis}`).catch(() => []), detailDepot(d.nom).catch(() => null)]);
    const semaines = Array(8).fill(0);
    for (const c of commits) { const dt = c.commit && c.commit.author && c.commit.author.date; if (dt) { const i = Math.floor((Date.now() - new Date(dt)) / (7 * 86400000)); if (i >= 0 && i < 8) semaines[7 - i]++; } }
    return { nom: d.nom, url: d.url, pousse: d.pousse, ouvertes: d.ouvertes, commits_56j: commits.length, semaines, prs: (detail && detail.prs) || [], issues: (detail && detail.issues) || [], action: (detail && detail.action) || null };
  }

  // Le verdict : ce qui marche, ce qu'il faut faire, ce qu'il faut éviter. Uniquement des règles appliquées à des mesures réelles (aucune invention).
  function verdict(b) {
    const marche = [], afaire = [], eviter = [];
    const ck = (id) => b.checks.find((c) => c.id === id) || {};
    for (const c of b.checks) if (c.niveau === 'ok') marche.push(c.label + (c.detail ? ' : ' + c.detail : ''));
    const d = b.deploys;
    if (d) {
      if (d.taux !== null && d.taux >= 90 && d.total >= 5) marche.push(`Déploiements fiables : ${d.reussis} réussis sur ${d.total}`);
      if (d.dernier && d.dernier.etat === 'error') {
        afaire.push(`Corriger le build en échec${d.dernier.erreur ? ' : ' + d.dernier.erreur : ''}. Le site en ligne reste la dernière version réussie.`);
        eviter.push('Relancer le même déploiement sans rien changer : il échouera de la même façon.');
      }
      if (d.taux !== null && d.total >= 8 && d.taux < 70) eviter.push(`Pousser sur la branche principale sans tester le build en local : ${d.total - d.reussis} échecs sur ${d.total} déploiements.`);
      if (d.dernier && d.dernier.etat === 'ready' && Date.now() - new Date(d.dernier.cree) > 180 * 86400000) afaire.push(`Site non mis à jour depuis ${Math.floor((Date.now() - new Date(d.dernier.cree)) / 2592000000)} mois : vérifier que le contenu (prix, coordonnées, offres) est toujours juste.`);
    }
    for (const id of ['en_ligne', 'ssl', 'https']) { const c = ck(id); if (c.niveau === 'ko') afaire.unshift(`${c.label} : ${c.detail}`); else if (c.niveau === 'attention') afaire.push(`${c.label} : ${c.detail}`); }
    const conseils = {
      titre: 'Ajouter un titre de page clair (30 à 60 caractères, avec le mot-clé principal).', description: "Écrire une meta description (70 à 160 caractères) : c'est le texte affiché sous ton lien dans Google.",
      h1: 'Avoir un seul titre H1 par page.', sitemap: "Publier un sitemap.xml et l'indiquer dans robots.txt pour aider Google à trouver tes pages.", mobile: "Ajouter la balise viewport : sans elle, le site s'affiche mal sur téléphone.",
      langue: 'Indiquer la langue du site (attribut lang de la balise html).', og: 'Ajouter les balises Open Graph (og:title, og:image) pour de beaux aperçus sur LinkedIn et WhatsApp.',
      alt: 'Ajouter un texte alternatif (alt) aux images : accessibilité et référencement.', js: "Le contenu n'apparaît qu'après exécution de JavaScript : prévoir un rendu côté serveur ou statique pour que Google le voie.",
      securite: 'Ajouter les en-têtes de sécurité (Strict-Transport-Security, X-Content-Type-Options) dans netlify.toml ou _headers.',
    };
    const ajuster = { titre: 'Ajuster la longueur du titre de page (15 à 65 caractères) : trop long, il est coupé dans Google.', description: "Ajuster la meta description (70 à 165 caractères) : trop longue, elle est coupée dans Google ; trop courte, elle est peu utile." };
    for (const [id, msg] of Object.entries(conseils)) { const c = ck(id); if (c.niveau === 'ko' || c.niveau === 'attention') afaire.push(c.niveau === 'attention' && ajuster[id] ? ajuster[id] : msg); }
    for (const id of ['indexation', 'robots']) { const c = ck(id); if (c.niveau === 'ko') { afaire.unshift(`${c.label} : ${c.detail}`); eviter.push('Laisser le site fermé aux moteurs de recherche si tu veux du trafic depuis Google.'); } }
    if (!b.analytics.length) { afaire.push("Installer un outil de mesure du trafic (Cloudflare Web Analytics est gratuit) : aujourd'hui aucune visite n'est mesurée."); eviter.push('Prendre des décisions sur le contenu ou la pub sans aucune mesure de trafic.'); }
    else if (b.analytics.some((o) => /Google/.test(o.nom))) afaire.push('Google Analytics est installé : il reste à le connecter à Jarvis pour voir les visites ici.');
    const f = b.formulaires; if (f && f.presents && f.derniers_30j === 0) afaire.push('Aucun message reçu par formulaire depuis 30 jours : tester le formulaire et la visibilité du bouton de contact.');
    const q = b.compte;
    if (q && q.minutes_build && q.minutes_build.inclus && q.minutes_build.utilise / q.minutes_build.inclus > 0.7) eviter.push('Multiplier les déploiements de test : plus de 70 % des minutes de build du mois sont utilisées.');
    if (q && q.bande_passante && q.bande_passante.inclus && q.bande_passante.utilise / q.bande_passante.inclus > 0.7) afaire.push('La bande passante du mois approche la limite du forfait : alléger les images et vidéos.');
    if (b.code) {
      if (b.code.action && b.code.action.resultat === 'failure') afaire.push('La dernière vérification automatique (GitHub Actions) est en échec : ouvrir le détail du dépôt.');
      if (b.code.commits_56j === 0) marche.push('Code stable : aucune modification depuis 8 semaines');
      if (b.code.prs.length) afaire.push(`${b.code.prs.length} pull request(s) ouverte(s) en attente de relecture.`);
    }
    return { marche, afaire, eviter };
  }
  const cacheBilan = new Map();
  async function bilan(id, force) {
    const s = cacheSites().find((x) => x.id === id);
    if (!s) return { ok: false, message: 'Site inconnu (actualise la liste).' };
    const hit = cacheBilan.get(id);
    if (hit && !force && Date.now() - hit.at < 10 * 60000) return hit.v;
    const base = urlSite(s); let host = '';
    try { host = new URL(base).hostname; } catch { return { ok: false, message: 'Adresse du site invalide.' }; }
    const sur = (f) => f().catch(() => null), erreurs = {};
    const dep = depotDuSite(s);
    const [page, robots, sitemap, http, cert, deploysBrut, forms, comp, code] = await Promise.all([
      requete(base).catch((e) => { erreurs.page = e.name === 'TimeoutError' ? 'pas de réponse en 20 s' : e.message; return null; }), sur(() => requete(new URL('/robots.txt', base).href, { max: 50000 })), sur(() => requete(new URL('/sitemap.xml', base).href, { max: 20000 })),
      sur(() => requete('http://' + host + '/', { corps: false, suivre: false })), sur(() => certificat(host)), sur(() => nf(`/sites/${id}/deploys?per_page=30`)),
      sur(() => formulaires(id)), sur(() => compte()), dep ? sur(() => activiteDepot(dep)) : Promise.resolve(null),
    ]);
    const checks = [], ck = (id_, label, niveau, detail) => checks.push({ id: id_, label, niveau, detail: detail || '' });
    const a = page && page.statut === 200 ? analyserPage(page.texte) : null;
    if (!page) ck('en_ligne', 'Site en ligne', 'ko', erreurs.page || 'aucune réponse');
    else ck('en_ligne', 'Site en ligne', page.statut === 200 ? 'ok' : 'ko', page.statut === 200 ? 'code 200' : `code ${page.statut}`);
    if (page) {
      // 1er accès (peut inclure un démarrage à froid) puis 2e accès : on juge sur le second, on signale un premier accès lent
      const chaud = await requete(base, { corps: false }).catch(() => null), ms2 = chaud ? chaud.ms : page.ms;
      const froid = page.ms > 3000 && ms2 < 1500;
      ck('vitesse', 'Temps de réponse', froid ? 'attention' : ms2 < 800 ? 'ok' : ms2 < 2000 ? 'attention' : 'ko',
        `1er accès ${page.ms} ms · 2e accès ${ms2} ms${froid ? ' : démarrage à froid lent (fonctions serveur ?)' : ''} (mesuré depuis ton PC)`);
    }
    if (cert) ck('ssl', 'Certificat HTTPS', cert.jours > 14 ? 'ok' : cert.jours > 0 ? 'attention' : 'ko', cert.jours > 0 ? `valide encore ${cert.jours} jours` : 'expiré');
    else ck('ssl', 'Certificat HTTPS', 'attention', 'impossible à lire');
    if (http) ck('https', 'Redirection http vers https', http.statut >= 300 && http.statut < 400 && /^https:/i.test(http.location) ? 'ok' : 'attention', http.statut >= 300 && http.statut < 400 ? 'active' : 'le site répond aussi en http non sécurisé');
    if (a) {
      ck('titre', 'Titre de la page', !a.titre ? 'ko' : a.titre.length >= 15 && a.titre.length <= 65 ? 'ok' : 'attention', a.titre ? `« ${a.titre.slice(0, 70)} » (${a.titre.length} car.)` : 'absent');
      ck('description', 'Meta description', !a.description ? 'ko' : a.description.length >= 70 && a.description.length <= 165 ? 'ok' : 'attention', a.description ? `${a.description.length} caractères` : 'absente');
      ck('h1', 'Titre principal (H1)', a.h1 === 1 ? 'ok' : 'attention', `${a.h1} trouvé(s)`);
      ck('mobile', 'Adapté au mobile (viewport)', a.viewport ? 'ok' : 'ko', a.viewport ? '' : 'balise absente');
      ck('langue', 'Langue déclarée', a.langue ? 'ok' : 'attention', a.langue || 'absente');
      ck('og', 'Aperçu de partage (Open Graph)', a.og ? 'ok' : 'attention', a.og ? '' : 'og:title / og:image absents');
      if (a.images) ck('alt', 'Images avec texte alternatif', a.sans_alt === 0 ? 'ok' : 'attention', a.sans_alt ? `${a.sans_alt} image(s) sur ${a.images} sans alt` : `${a.images} image(s)`);
      ck('indexation', 'Ouvert à Google (balise robots)', /noindex/.test(a.robots_meta) ? 'ko' : 'ok', /noindex/.test(a.robots_meta) ? 'la page demande à ne PAS être indexée (noindex)' : '');
      if (a.texte_visible < 200 && a.scripts > 0) ck('js', 'Contenu visible sans JavaScript', 'attention', `seulement ${a.texte_visible} caractères dans le HTML initial`);
    }
    const okRobots = !!(robots && robots.statut === 200 && /user-agent/i.test(robots.texte));
    const bloque = okRobots && /user-agent:\s*\*\s*[\r\n]+(?:\s*(?:allow|crawl-delay)[^\r\n]*[\r\n]+)*\s*disallow:\s*\/\s*(?:[\r\n]|$)/i.test(robots.texte);
    ck('robots', 'robots.txt', bloque ? 'ko' : okRobots ? 'ok' : 'attention', bloque ? 'interdit TOUT le site aux robots (Disallow: /)' : okRobots ? 'présent' : 'absent');
    const okMap = !!((sitemap && sitemap.statut === 200 && /<urlset|<sitemapindex/i.test(sitemap.texte)) || (okRobots && /^\s*sitemap:/im.test(robots.texte)));
    ck('sitemap', 'Sitemap', okMap ? 'ok' : 'attention', okMap ? 'présent' : 'sitemap.xml introuvable');
    if (page) { const e = page.entetes, n = ['strict-transport-security', 'x-content-type-options'].filter((h) => e[h]).length; ck('securite', 'En-têtes de sécurité', n === 2 ? 'ok' : 'attention', n === 2 ? 'HSTS + nosniff' : 'HSTS / nosniff manquants'); }
    const v = {
      ok: true, at: Date.now(), id, nom: s.nom, url: base, admin: s.admin, depot: s.depot, capture: s.capture, etat: s.deploy ? s.deploy.etat : '',
      reponse: page ? { statut: page.statut, ms: page.ms } : null, ssl_jours: cert ? cert.jours : null, checks, analytics: a ? a.outils : [],
      deploys: deploysBrut ? stats(deploysBrut) : null, formulaires: forms, compte: comp, code,
    };
    v.verdict = verdict(v);
    cacheBilan.set(id, { at: Date.now(), v });
    return v;
  }

  // Performance / SEO / accessibilité par Google PageSpeed (Lighthouse). Seule l'adresse PUBLIQUE du site est envoyée à Google. Cache 30 min.
  const cachePS = new Map();
  async function pagespeed(id, force) {
    const s = cacheSites().find((x) => x.id === id);
    if (!s) return { ok: false, message: 'Site inconnu (actualise la liste).' };
    const hit = cachePS.get(id);
    if (hit && !force && Date.now() - hit.at < 30 * 60000) return hit.v;
    const u = urlSite(s);
    try { await urlSure(u); } catch (e) { return { ok: false, message: e.message }; }
    const api = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?' + new URLSearchParams({ url: u, strategy: 'mobile', locale: 'fr' }).toString() + '&category=performance&category=seo&category=accessibility&category=best-practices';
    let r;
    try { r = await fetch(api, { signal: AbortSignal.timeout(100000), headers: { 'User-Agent': 'mini-jarvis' } }); } catch (e) { return { ok: false, message: 'PageSpeed ne répond pas (' + (e.name === 'TimeoutError' ? 'trop long' : e.message) + ').' }; }
    if (!r.ok) return { ok: false, message: r.status === 429 ? 'Quota gratuit de Google PageSpeed atteint : réessaie dans quelques minutes.' : `PageSpeed a répondu ${r.status}.` };
    const j = await r.json(), lh = j.lighthouseResult;
    if (!lh) return { ok: false, message: 'Réponse PageSpeed inattendue.' };
    const au = lh.audits || {}, cats = lh.categories || {};
    const echoues = (cat, n) => ((cats[cat] && cats[cat].auditRefs) || []).map((ref) => au[ref.id]).filter((x) => x && x.score === 0 && x.title).slice(0, n).map((x) => coupe(x.title, 110));
    const val = (k) => au[k] && au[k].displayValue;
    const v = {
      ok: true, at: Date.now(), scores: Object.fromEntries(Object.entries(cats).map(([k, x]) => [k, x.score == null ? null : Math.round(x.score * 100)])),
      metriques: { fcp: val('first-contentful-paint'), lcp: val('largest-contentful-paint'), cls: val('cumulative-layout-shift'), tbt: val('total-blocking-time') },
      opportunites: Object.values(au).filter((x) => x.details && x.details.type === 'opportunity' && x.details.overallSavingsMs > 300).sort((a, b) => b.details.overallSavingsMs - a.details.overallSavingsMs).slice(0, 4).map((x) => `${coupe(x.title, 90)}${x.displayValue ? ' (' + coupe(x.displayValue, 30) + ')' : ''}`),
      seo_a_corriger: echoues('seo', 5), accessibilite_a_corriger: echoues('accessibility', 4),
    };
    cachePS.set(id, { at: Date.now(), v }); return v;
  }

  // ---------- Liens entre les trois mondes : dossier git ↔ dépôt GitHub ↔ site Netlify ----------
  const cacheDepots = () => (c.gh.v && c.gh.v.depots) || [];
  const cacheSites = () => (c.nf.v && c.nf.v.sites) || [];
  function sitesDuDepot(urlDepot) { const n = normDepot(urlDepot); return n ? cacheSites().filter((s) => normDepot(s.depot) === n) : []; }
  function depotDuSite(site) { const n = normDepot(site.depot); return n ? cacheDepots().find((d) => normDepot(d.url) === n) || null : null; }
  // Suggestion pour un projet : d'après l'adresse git de ses dossiers, sinon d'après le nom. Jamais appliquée sans ton clic.
  function suggerer(nomProjet, adressesGit) {
    const adr = (adressesGit || []).map(normDepot).filter(Boolean);
    let d = cacheDepots().find((x) => adr.includes(normDepot(x.url)));
    let source = d ? 'dossier git' : '';
    if (!d) { const k = cle(nomProjet); if (k.length >= 3) { const m = cacheDepots().filter((x) => cle(x.court) === k); if (m.length === 1) { d = m[0]; source = 'nom'; } } }
    let s = d ? sitesDuDepot(d.url)[0] : null;
    if (!s) { const k = cle(nomProjet); if (k.length >= 3) { const m = cacheSites().filter((x) => cle(x.nom) === k); if (m.length === 1) s = m[0]; } }
    return { github: d ? d.nom : '', netlify: s ? s.id : '', source };
  }

  return { normDepot, depots, detailDepot, sites, detailSite, santeTous, bilan, pagespeed, _urlSure: urlSure, cacheDepots, cacheSites, sitesDuDepot, depotDuSite, suggerer };
};
