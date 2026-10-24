// Tableau de bord des projets : données (projets.json), recherche par nom, infos git, dossiers candidats.
// "Projet" = n'importe quoi : idée, client, projet de code, dossier, site, apprentissage...
// Ce module ne lit que des NOMS de dossiers et l'état git ; jamais le contenu des fichiers. Chaque chemin passe par le garde-fou de securite.js.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const TYPES = ['idée', 'client', 'code', 'site', 'dossier', 'apprentissage', 'autre'];
const STATUTS = ['idée', 'en cours', 'en attente', 'terminé', 'archivé'];
const MARQUEURS_CODE = ['package.json', 'composer.json', 'requirements.txt', 'pyproject.toml', 'index.html', 'index.php', 'CLAUDE.md', 'Dockerfile', 'pom.xml'];

const sansAccent = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const cle = (s) => sansAccent(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const propre = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const aujourdhui = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const choix = (v, liste, defaut) => { const k = cle(v); return liste.find((x) => cle(x) === k) || defaut; };

module.exports = function creer({ dir, cheminAutorise, auditer, racines }) {
  const fichier = path.join(dir, 'projets.json');
  const dossierSauv = path.join(dir, 'journal', 'projets_sauvegardes');
  let data = { projets: [], prochain: 1 };
  try { data = { ...data, ...JSON.parse(fs.readFileSync(fichier, 'utf8')) }; } catch { /* premier démarrage */ }

  // ---------- Sauvegarde : écriture atomique + une copie par jour (14 gardées) ----------
  function sauver() {
    try {
      const tmp = fichier + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, fichier);
      fs.mkdirSync(dossierSauv, { recursive: true });
      fs.copyFileSync(fichier, path.join(dossierSauv, `projets-${aujourdhui()}.json`));
      fs.readdirSync(dossierSauv).filter((f) => /^projets-.*\.json$/.test(f)).sort().slice(0, -14).forEach((f) => { try { fs.unlinkSync(path.join(dossierSauv, f)); } catch { /* ignoré */ } });
    } catch (e) { console.error('projets.json :', e.message); }
  }
  const maj = (p) => { p.maj = aujourdhui(); sauver(); };

  // ---------- Recherche par nom (voix : "Anonstream", "le projet kaeditions"...) ----------
  function trouver(ref) {
    if (ref == null || ref === '') return { erreur: 'aucun projet indiqué' };
    const n = Number(String(ref).replace('#', ''));
    if (Number.isInteger(n) && String(ref).trim().replace('#', '') === String(n)) {
      const p = data.projets.find((x) => x.id === n);
      return p ? { p } : { erreur: `projet #${n} introuvable` };
    }
    const k = cle(String(ref).replace(/^(le |la |l')?projet\s+/i, ''));
    if (!k) return { erreur: 'aucun projet indiqué' };
    const exact = data.projets.filter((x) => cle(x.nom) === k);
    if (exact.length === 1) return { p: exact[0] };
    // Correspondance partielle seulement dans un sens (ce que tu dis est contenu dans le nom du projet), jamais l'inverse :
    // un nom inconnu qui ressemble à un projet ("Alpha-inexistant") ne doit jamais modifier "Alpha".
    const proches = k.length >= 3 ? data.projets.filter((x) => cle(x.nom).startsWith(k) || cle(x.nom).includes(k)) : [];
    if (proches.length === 1) return { p: proches[0] };
    if (proches.length > 1) return { erreur: `« ${ref} » correspond à plusieurs projets : ${proches.slice(0, 5).map((x) => x.nom).join(', ')}` };
    return { erreur: `aucun projet ne s'appelle « ${ref} »` };
  }

  // ---------- Création / modification ----------
  function creerProjet(o) {
    const nom = propre(o.nom, 80);
    if (!nom) return { ok: false, message: 'Il faut un nom.' };
    if (data.projets.some((x) => cle(x.nom) === cle(nom))) return { ok: false, message: `Un projet « ${nom} » existe déjà.` };
    const p = {
      id: data.prochain++, nom, type: choix(o.type, TYPES, 'autre'), statut: choix(o.statut, STATUTS, 'idée'),
      priorite: [1, 2, 3].includes(Number(o.priorite)) ? Number(o.priorite) : 2,
      resume: propre(o.resume, 300), dossiers: [], liens: [], taches: [], notes: [], externe: { github: '', netlify: '' }, outil: '', cree: aujourdhui(), maj: aujourdhui(),
    };
    data.projets.push(p);
    lierSans(p, o.externe);
    for (const l of Array.isArray(o.liens) ? o.liens.slice(0, 5) : []) ajouterLien(p, l.titre, l.url, true);
    for (const d of Array.isArray(o.dossiers) ? o.dossiers : []) ajouterDossier(p, d, true);
    sauver();
    return { ok: true, message: `Projet « ${p.nom} » créé (${p.type}, ${p.statut}).`, projet: p };
  }
  function modifier(p, champ, valeur) {
    const c = cle(champ);
    if (c === 'nom') {
      const v = propre(valeur, 80);
      if (!v) return { ok: false, message: 'Le nom ne peut pas être vide.' };
      if (data.projets.some((x) => x !== p && cle(x.nom) === cle(v))) return { ok: false, message: `Un projet « ${v} » existe déjà.` };
      p.nom = v;
    } else if (c === 'statut') p.statut = choix(valeur, STATUTS, p.statut);
    else if (c === 'type') p.type = choix(valeur, TYPES, p.type);
    else if (c === 'priorite') { const n = parseInt(valeur, 10); if ([1, 2, 3].includes(n)) p.priorite = n; else return { ok: false, message: 'La priorité va de 1 (haute) à 3 (basse).' }; }
    else if (c === 'resume') p.resume = propre(valeur, 300);
    else if (c === 'outil') {
      const v = String(valeur || '').trim().replace(/\/+$/, '');
      if (v && !/^https:\/\/[\w.-]+(:\d+)?$/.test(v)) return { ok: false, message: 'Adresse invalide (attendu : https://mon-outil.netlify.app).' };
      p.outil = v;
    }
    else return { ok: false, message: `Champ inconnu : ${champ}` };
    maj(p);
    return { ok: true, message: `« ${p.nom} » : ${c} → ${c === 'nom' ? p.nom : c === 'resume' ? 'mis à jour' : p[c]}`, projet: p };
  }
  function supprimer(p) {
    data.projets = data.projets.filter((x) => x !== p);
    sauver();
    return { ok: true, message: `Projet « ${p.nom} » supprimé.` };
  }

  // ---------- Tâches, notes, liens, dossiers ----------
  function ajouterTache(p, texte) {
    const t = propre(texte, 300);
    if (!t) return { ok: false, message: 'Tâche vide.' };
    const tache = { id: (p.taches.reduce((m, x) => Math.max(m, x.id), 0)) + 1, texte: t, fait: false, cree: aujourdhui() };
    p.taches.push(tache); maj(p);
    return { ok: true, message: `Tâche ajoutée à « ${p.nom} » : ${t}`, tache };
  }
  function trouverTache(p, ref) {
    const n = Number(ref);
    if (Number.isInteger(n) && String(ref).trim() === String(n)) { const t = p.taches.find((x) => x.id === n); if (t) return { t }; }
    const k = cle(ref);
    if (!k) return { erreur: 'aucune tâche indiquée' };
    const ouvertes = p.taches.filter((x) => !x.fait), pool = ouvertes.length ? ouvertes : p.taches;
    const ex = pool.filter((x) => cle(x.texte) === k);
    const proches = ex.length ? ex : pool.filter((x) => cle(x.texte).includes(k) || k.includes(cle(x.texte)));
    if (proches.length === 1) return { t: proches[0] };
    return { erreur: proches.length ? `plusieurs tâches correspondent à « ${ref} »` : `aucune tâche « ${ref} » dans « ${p.nom} »` };
  }
  function cocher(p, ref, fait = true) {
    const r = trouverTache(p, ref);
    if (r.erreur) return { ok: false, message: r.erreur };
    r.t.fait = !!fait; r.t.fini = fait ? aujourdhui() : undefined; maj(p);
    return { ok: true, message: `${fait ? '✔' : '↩'} « ${p.nom} » : ${r.t.texte}` };
  }
  function retirerTache(p, id) {
    const i = p.taches.findIndex((x) => x.id === Number(id));
    if (i < 0) return { ok: false, message: 'Tâche introuvable.' };
    p.taches.splice(i, 1); maj(p); return { ok: true, message: 'Tâche retirée.' };
  }
  function ajouterNote(p, texte) {
    const t = propre(texte, 1000);
    if (!t) return { ok: false, message: 'Note vide.' };
    const note = { id: (p.notes.reduce((m, x) => Math.max(m, x.id), 0)) + 1, texte: t, date: aujourdhui() };
    p.notes.push(note); maj(p);
    return { ok: true, message: `Note ajoutée à « ${p.nom} ».`, note };
  }
  function retirerNote(p, id) {
    const i = p.notes.findIndex((x) => x.id === Number(id));
    if (i < 0) return { ok: false, message: 'Note introuvable.' };
    p.notes.splice(i, 1); maj(p); return { ok: true, message: 'Note retirée.' };
  }
  // Lien vers un dépôt GitHub ("proprio/depot") et / ou un site Netlify (identifiant). Vide = délier. Formats stricts : rien d'autre n'est accepté.
  const RE_GH = /^[\w.-]{1,100}\/[\w.-]{1,100}$/, RE_NF = /^[0-9a-f-]{8,64}$/i;
  function lierSans(p, o) {
    p.externe = { github: '', netlify: '', ...(p.externe || {}) };
    if (!o) return { ok: true };
    if (o.github !== undefined) { const v = String(o.github || '').trim(); if (v && !RE_GH.test(v)) return { ok: false, message: 'Nom de dépôt invalide.' }; p.externe.github = v; }
    if (o.netlify !== undefined) { const v = String(o.netlify || '').trim(); if (v && !RE_NF.test(v)) return { ok: false, message: 'Identifiant de site invalide.' }; p.externe.netlify = v; }
    return { ok: true };
  }
  function lier(p, o) {
    const r = lierSans(p, o);
    if (!r.ok) return r;
    maj(p);
    return { ok: true, message: `« ${p.nom} » : ${p.externe.github ? 'GitHub ' + p.externe.github : 'sans GitHub'} · ${p.externe.netlify ? 'site Netlify lié' : 'sans Netlify'}` };
  }
  function ajouterLien(p, titre, url, sansSauver) {
    let u;
    try { u = new URL(String(url).trim()); } catch { return { ok: false, message: 'Adresse invalide.' }; }
    if (!/^https?:$/.test(u.protocol)) return { ok: false, message: 'Seuls les liens http(s) sont acceptés.' };
    p.liens.push({ titre: propre(titre, 80) || u.hostname, url: u.href }); if (!sansSauver) maj(p);
    return { ok: true, message: `Lien ajouté à « ${p.nom} ».` };
  }
  function retirerLien(p, i) {
    if (!p.liens[i]) return { ok: false, message: 'Lien introuvable.' };
    p.liens.splice(i, 1); maj(p); return { ok: true, message: 'Lien retiré.' };
  }
  function ajouterDossier(p, chemin, sansSauver) {
    const g = cheminAutorise(chemin);
    if (!g.ok) return { ok: false, message: `Dossier refusé (${g.raison}).` };
    let st; try { st = fs.statSync(g.chemin); } catch { return { ok: false, message: 'Dossier introuvable.' }; }
    if (!st.isDirectory()) return { ok: false, message: 'Ce n\'est pas un dossier.' };
    if (p.dossiers.some((d) => d.toLowerCase() === g.chemin.toLowerCase())) return { ok: true, message: 'Déjà associé.' };
    p.dossiers.push(g.chemin);
    if (!sansSauver) maj(p);
    return { ok: true, message: `Dossier associé à « ${p.nom} » : ${g.chemin}` };
  }
  function retirerDossier(p, i) {
    if (!p.dossiers[i]) return { ok: false, message: 'Dossier introuvable.' };
    p.dossiers.splice(i, 1); maj(p); return { ok: true, message: 'Dossier dissocié (rien n\'est supprimé sur le disque).' };
  }

  // ---------- Infos git (lecture seule, mises en cache 60 s) ----------
  const cacheGit = new Map();
  const git = (d, args) => new Promise((res) => {
    execFile('git', ['-C', d, ...args], { timeout: 4000, windowsHide: true, encoding: 'utf8' }, (err, out) => res(err ? '' : String(out).trim()));
  });
  async function infoGit(dossier) {
    const hit = cacheGit.get(dossier);
    if (hit && Date.now() - hit.at < 60000) return hit.v;
    let v = null;
    if (fs.existsSync(path.join(dossier, '.git'))) {
      const [branche, dernier, modifs, remote] = await Promise.all([
        git(dossier, ['rev-parse', '--abbrev-ref', 'HEAD']), git(dossier, ['log', '-1', '--format=%cI|%s']),
        git(dossier, ['status', '--porcelain']), git(dossier, ['remote', 'get-url', 'origin']),
      ]);
      const [date, ...sujet] = dernier.split('|');
      v = {
        branche, modifs: modifs ? modifs.split('\n').length : 0, dernier_commit: date || '', sujet: sujet.join('|').slice(0, 120),
        depot: (remote || '').replace(/\/\/[^@/]+@/, '//').replace(/\.git$/, ''),   // jamais d'identifiants dans l'adresse
      };
    }
    cacheGit.set(dossier, { at: Date.now(), v });
    return v;
  }
  async function activite(p) {
    const infos = [];
    for (const d of p.dossiers) {
      const g = cheminAutorise(d);
      if (!g.ok) { infos.push({ dossier: d, refuse: g.raison }); continue; }
      let mtime = 0; try { mtime = fs.statSync(g.chemin).mtimeMs; } catch { /* dossier déplacé */ }
      infos.push({ dossier: d, existe: mtime > 0, modifie: mtime ? new Date(mtime).toISOString() : '', git: mtime ? await infoGit(g.chemin) : null });
    }
    return infos;
  }

  // ---------- Dossiers candidats (noms seulement) ----------
  function candidats() {
    const deja = new Set(data.projets.flatMap((p) => p.dossiers.map((d) => d.toLowerCase())));
    const out = [];
    for (const racine of racines()) {
      const gr = cheminAutorise(racine);
      if (!gr.ok) continue;
      let entrees = [];
      try { entrees = fs.readdirSync(gr.chemin, { withFileTypes: true }); } catch { continue; }
      for (const e of entrees) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('$')) continue;
        const g = cheminAutorise(path.join(gr.chemin, e.name));
        if (!g.ok) continue;                                  // exclusions (dossiers sensibles) : jamais proposés
        if (deja.has(g.chemin.toLowerCase())) continue;
        let mtime = 0; try { mtime = fs.statSync(g.chemin).mtimeMs; } catch { /* ignoré */ }
        const git_ = fs.existsSync(path.join(g.chemin, '.git'));
        const code = git_ || MARQUEURS_CODE.some((m) => fs.existsSync(path.join(g.chemin, m)));
        const recent = mtime > Date.now() - 120 * 86400000;
        out.push({
          chemin: g.chemin, nom: e.name, racine: gr.chemin, modifie: mtime ? new Date(mtime).toISOString() : '', git: git_, code, recent,
          type: code ? 'code' : 'dossier', statut: recent ? 'en cours' : 'en attente',
        });
      }
    }
    return out.sort((a, b) => (b.git - a.git) || (b.recent - a.recent) || a.nom.localeCompare(b.nom));
  }
  function importer(liste) {
    const crees = [];
    for (const x of (Array.isArray(liste) ? liste : []).slice(0, 100)) {
      const r = creerProjet({ nom: x.nom, type: x.type, statut: x.statut, dossiers: [x.chemin] });
      if (r.ok) crees.push(r.projet.nom);
    }
    return { ok: true, crees, message: `${crees.length} projet(s) importé(s).` };
  }

  // ---------- Résumé pour l'IA : noms, statuts et tâches ouvertes seulement ----------
  function texteIA() {
    const actifs = data.projets.filter((p) => p.statut !== 'archivé');
    if (!actifs.length) return '(aucun projet dans le tableau de bord)';
    return actifs.slice(0, 60).map((p) => {
      const ouv = p.taches.filter((t) => !t.fait);
      return `- ${p.nom} [${p.type}, ${p.statut}, priorité ${p.priorite}]${p.externe && p.externe.github ? ' (GitHub ' + p.externe.github + ')' : ''}${p.resume ? ' : ' + p.resume.slice(0, 120) : ''}${ouv.length ? ` | à faire : ${ouv.slice(0, 4).map((t) => t.texte.slice(0, 60)).join(' ; ')}${ouv.length > 4 ? ` (+${ouv.length - 4})` : ''}` : ''}`;
    }).join('\n');
  }

  return {
    TYPES, STATUTS, cle, trouver, creerProjet, modifier, supprimer, ajouterTache, cocher, retirerTache, ajouterNote, retirerNote,
    ajouterLien, retirerLien, lier, ajouterDossier, retirerDossier, infoGit, activite, candidats, importer, texteIA,
    lister: () => data.projets,
  };
};
