#!/usr/bin/env node
// Nettoie un nouvel export d'Atlas avant publication : réapplique les remplacements connus (vie perso → texte
// générique) puis vérifie qu'il ne reste plus rien de sensible. S'arrête en erreur (code 1) si quelque chose
// reste — aucune donnée sensible ne doit jamais être commitée "parce que le script n'a rien dit".
//
//   node scripts/nettoyer-export.js [chemin-du-repo]   (par défaut : le dossier courant)
//
// Important : ce script REMPLACE du texte connu (étape 2) puis VÉRIFIE (étape 3) — il ne remplace pas tout ce qui
// pourrait être sensible. Toute nouvelle phrase personnelle ajoutée depuis la dernière passe de nettoyage doit être
// généralisée à la main, puis ajoutée à REMPLACEMENTS ci-dessous pour la prochaine fois. La vérification, elle,
// reste valable même pour du texte jamais vu : elle cherche des MOTIFS (secrets, mots-clés sensibles), pas du texte exact.

const fs = require('fs');
const path = require('path');

const RACINE = path.resolve(process.argv[2] || '.');
const EXTENSIONS = new Set(['.js', '.html', '.md', '.json']);
const DOSSIERS_IGNORES = new Set(['node_modules', '.git', 'docs', 'scripts']);

function listerFichiers(dir) {
  const out = [];
  for (const nom of fs.readdirSync(dir, { withFileTypes: true })) {
    if (DOSSIERS_IGNORES.has(nom.name)) continue;
    const p = path.join(dir, nom.name);
    if (nom.isDirectory()) out.push(...listerFichiers(p));
    else if (EXTENSIONS.has(path.extname(nom.name))) out.push(p);
  }
  return out;
}

// ========== ÉTAPE 2 (rejouée) : remplacements connus, texte exact → texte générique ==========
// Chaque règle ne s'applique qu'au fichier indiqué (évite qu'une correspondance fortuite ailleurs soit changée à tort).
const REMPLACEMENTS = [
  { fichier: 'jarvis.js', chercher: `et Youssef le croit`, remplacer: `et l'utilisateur le croit` },
  { fichier: 'jarvis.js', chercher: `(cfg.entreprise || {}).contact || 'Youssef Kacem'`, remplacer: `(cfg.entreprise || {}).contact || 'Votre nom'` },
  { fichier: 'jarvis.js', chercher: `pour Youssef Kacem, développeur web junior basé en Tunisie`, remplacer: `pour l'utilisateur, développeur web basé en télétravail` },
  { fichier: 'jarvis.js', chercher: `pour Youssef, développeur web junior en recherche de missions à distance`, remplacer: `pour l'utilisateur, développeur web en recherche de missions à distance` },
  { fichier: 'jarvis.js', chercher: `(JSON) pour Youssef Kacem, à partir`, remplacer: `(JSON) pour l'utilisateur, à partir` },
  { fichier: 'jarvis.js', chercher: `Dis simplement qu'il travaille à distance depuis la Tunisie (UTC+1).`, remplacer: `Dis simplement qu'il travaille à distance, dans son fuseau horaire (indiqué dans son profil si besoin).` },
  { fichier: 'jarvis.js', chercher: `(heure de Tunis, format 24 h :`, remplacer: `(heure locale, format 24 h :` },
  { fichier: 'jarvis.js', chercher: `t = t.replace(/\\n+\\s*(youssef kacem)\\s*$/i, '');`, remplacer: `const nomSignature = ((cfg.entreprise || {}).contact || 'Votre nom').replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');\n  t = t.replace(new RegExp(\`\\\\n+\\\\s*(\${nomSignature})\\\\s*$\`, 'i'), '');` },
  { fichier: 'jarvis.js', chercher: `const ROUTINE_IMPORTANTE = /m[ée]dicament|traitement|cachet|pilule|comprim[ée]|insuline|gouttes/i;`, remplacer: `const ROUTINE_IMPORTANTE = /\\bimportant(e)?\\b|\\burgent(e)?\\b|\\bobligatoire\\b|\\bne pas oublier\\b|\\bcritique\\b/i;` },
  { fichier: 'jarvis.js', chercher: `// ================= FAC (emploi du temps Amilcar University) =================`, remplacer: `// ================= PORTAIL TIERS (emploi du temps / calendrier, portail externe sans API publique) =================` },
  { fichier: 'jarvis.js', chercher: `"Identifiants Amilcar non configurés (config.json > fac)."`, remplacer: `"Identifiants du portail non configurés (config.json > fac)."` },
  { fichier: 'fac.js', chercher: `Amilcar University ("classrooms.amilcar-university.com")`, remplacer: `tiers (identité volontairement omise)` },
  { fichier: 'fac.js', chercher: `const BASE = 'https://classrooms.amilcar-university.com/espace';`, remplacer: `const BASE = process.env.FAC_BASE_URL || 'https://exemple-portail.invalid/espace';` },
  { fichier: 'emploi.js', chercher: `filtre selon le profil de Youssef`, remplacer: `filtre selon le profil de l'utilisateur` },
  { fichier: 'emploi.js', chercher: `localisation compatible avec la Tunisie`, remplacer: `localisation compatible` },
  { fichier: 'emploi.js', chercher: `localisation (Tunisie)`, remplacer: `localisation compatible` },
  { fichier: 'mcp/server.js', chercher: `un simple marqueur, posé par Youssef.`, remplacer: `un simple marqueur, posé par l'utilisateur.` },
  { fichier: 'ui/index.html', chercher: `Youssef Kacem (freelance)`, remplacer: `Freelance` },
  { fichier: 'ui/projets.html', chercher: `Tes routines (médicament…)`, remplacer: `Tes routines (importantes ou non)` },
  { fichier: 'ui/projets.html', chercher: `Confirmations (médicament…)`, remplacer: `Confirmations (routines importantes…)` },
  { fichier: 'ui/projets.html', chercher: `ligneCopie('youssef')`, remplacer: `ligneCopie('utilisateur')` },
];

function appliquerRemplacements() {
  let n = 0;
  for (const r of REMPLACEMENTS) {
    const p = path.join(RACINE, r.fichier);
    if (!fs.existsSync(p)) continue;
    const avant = fs.readFileSync(p, 'utf8');
    if (!avant.includes(r.chercher)) continue;
    fs.writeFileSync(p, avant.split(r.chercher).join(r.remplacer), 'utf8');
    n++;
    console.log(`✎ ${r.fichier} : remplacé « ${r.chercher.slice(0, 50)}${r.chercher.length > 50 ? '…' : ''} »`);
  }
  console.log(`Remplacements appliqués : ${n}/${REMPLACEMENTS.length} règle(s) ont trouvé une correspondance.`);
}

// ========== ÉTAPE 3 (rejouée) : vérification par motifs ==========
const MOTIFS_SECRETS = [
  { nom: 'clé Gemini (AQ.)', re: /AQ\.[A-Za-z0-9_-]{15,}/g },
  { nom: 'clé Google (AIza)', re: /AIza[A-Za-z0-9_-]{15,}/g },
  { nom: 'jeton GitHub (classic PAT)', re: /github_pat_[A-Za-z0-9_]{15,}/g },
  { nom: 'jeton GitHub (ghp_)', re: /ghp_[A-Za-z0-9]{15,}/g },
  { nom: 'jeton Netlify (nfp_)', re: /nfp_[A-Za-z0-9]{15,}/g },
  { nom: 'clé Groq (gsk_)', re: /gsk_[A-Za-z0-9]{15,}/g },
  { nom: 'clé style OpenAI (sk-)', re: /sk-[A-Za-z0-9]{15,}/g },
  { nom: 'jeton Telegram (id:secret)', re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g },
  { nom: 'email réel', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    exclu: (s) => /example\.(com|invalid|org)|yourbrand|your-?name|user@|a@b\.c|test@|noreply@anthropic/i.test(s) },
];
const MOTS_SENSIBLES = [
  { nom: 'mot-clé santé/médicament', re: /médicament|medicament|insuline|\bcachet\b|\bpilule\b|comprim[ée]/gi },
  { nom: 'nom de personne réel (Youssef/Kacem)', re: /\byoussef\b|\bkacem\b/gi },
  { nom: 'établissement réel (Amilcar)', re: /amilcar/gi },
];

function valeursSecretesNonVides(fichierJson) {
  const trouvees = [];
  let data;
  try { data = JSON.parse(fs.readFileSync(fichierJson, 'utf8')); } catch { return trouvees; }
  const CLE_SECRETE = /^(.*_)?(token|secret|key|password|mot_de_passe|api_key|client_secret|refresh_token)$/i;
  (function parcourir(obj, chemin) {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_aide')) continue;   // champs d'aide/documentation, pas des réglages
      const c = chemin ? `${chemin}.${k}` : k;
      if (typeof v === 'string' && CLE_SECRETE.test(k) && v.trim()) trouvees.push({ chemin: c, valeur: v });
      else if (v && typeof v === 'object') parcourir(v, c);
    }
  })(data, '');
  return trouvees;
}

function verifier() {
  const fichiers = listerFichiers(RACINE);
  const problemes = [];

  for (const f of fichiers) {
    const rel = path.relative(RACINE, f);
    const contenu = fs.readFileSync(f, 'utf8');

    for (const m of [...MOTIFS_SECRETS, ...MOTS_SENSIBLES]) {
      const trouves = contenu.match(m.re);
      if (!trouves) continue;
      for (const t of trouves) {
        if (m.exclu && m.exclu(t)) continue;
        problemes.push(`${rel} — ${m.nom} : "${t.slice(0, 60)}"`);
      }
    }

    // Config *.example.json : aucun champ secret ne doit avoir une vraie valeur (seuls les faux "YOUR_..."/"" sont tolérés).
    if (/\.example\.json$/.test(f)) {
      for (const s of valeursSecretesNonVides(f)) {
        if (/^(your_|votre_)/i.test(s.valeur) || s.valeur === '') continue;
        problemes.push(`${rel} — valeur non placeholder dans un champ secret : ${s.chemin} = "${s.valeur.slice(0, 40)}"`);
      }
    }
  }

  return problemes;
}

console.log(`Nettoyage de : ${RACINE}\n`);
appliquerRemplacements();
console.log('\nVérification...');
const problemes = verifier();

if (problemes.length) {
  console.error(`\n❌ ${problemes.length} problème(s) trouvé(s) — RIEN n'est publié tant que ce n'est pas corrigé :\n`);
  for (const p of problemes) console.error(`  - ${p}`);
  console.error('\nCorrige à la main (texte personnel → générique, secret → variable d\'environnement), puis relance ce script.');
  process.exit(1);
}

console.log('\n✅ Aucun problème trouvé.');
