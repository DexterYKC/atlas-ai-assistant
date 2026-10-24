// Fondations de sécurité de Jarvis : les règles sont appliquées PAR LE CODE, jamais par le prompt.
// L'IA propose, ce module décide : niveau de chaque action, confirmations à usage unique, journal, suspension d'urgence,
// limite de débit, et garde-fou de chemins (dossiers autorisés + liste d'exclusions) pour les futurs outils de fichiers.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Niveau de chaque action que l'IA peut demander. Toute action absente de cette table est INTERDITE.
//   libre     : s'exécute tout de suite (et est notée au journal)
//   confirmer : rien ne s'exécute avant ton accord (appli ou Telegram, jamais à la voix)
const NIVEAUX = {
  NOTE: 'libre', RAPPEL: 'libre', AGENDA_AJOUT: 'libre', AGENDA_MODIF: 'libre', AGENDA_SUPPR: 'libre', PAUSE: 'libre',
  PROSPECT: 'libre', DOC: 'libre', APPEL: 'libre', OUVRIR: 'libre', SPOTIFY: 'libre', SECTION: 'libre',
  PROJET_AJOUT: 'libre', PROJET_MODIF: 'libre', TACHE_AJOUT: 'libre', TACHE_FAIT: 'libre', PROJET_NOTE: 'libre',   // tableau de bord des projets
  ROUTINE_AJOUT: 'libre', ROUTINE_MODIF: 'libre', ROUTINE_SUPPR: 'libre', ROUTINE_FAIT: 'libre', POINT: 'libre', PRESENCE: 'libre', CALME: 'libre',                                        // rappels / appels répétés (tous les jours à 21h...)
  EMPLOI: 'libre', CANDIDATURE: 'libre', TRADING: 'libre',        // TRADING : compte DÉMO uniquement (refus par le code Python sinon) : lecture, étude, et exécuteur à règles fixes (trading/executeur.py) avec limites absolues
  TRADING_ORDRE: 'confirmer',                                     // ordre MANUEL sur le compte démo (demandé par lui, jamais décidé par l'IA) : toujours à confirmer dans le tableau de bord ou Telegram, JAMAIS par la voix
  MAIL: 'libre',                                                  // lecture SEULE de Proton (sur demande uniquement) + tri par le modèle local : aucun envoi, aucune suppression possible
  TRADING_FERMER: 'libre',                                        // fermer une position MANUELLE (démo) : réduit le risque, jamais ne l'augmente -> comme "Tout fermer", toujours permis tout de suite
  AUTOMATISATION: 'libre',                                        // démarrer/arrêter N8N en local (à la demande, jamais en fond) : aucun ordre/argent/donnée sensible, le code refuse déjà si la RAM est trop basse
  AUTOMATISATION_CREER: 'libre',                                  // crée un workflow N8N simple via son API — TOUJOURS désactivé (active:false) : lui seul l'active après vérification dans N8N
  AUDIT_SEO: 'libre', RECHERCHE_SEO: 'libre', MAIL_SEO: 'libre', EVALUER_PDF_SEO: 'libre',  // outil SEO (audit + prospection + brouillon de mail + lecture d'un PDF déjà déposé par lui) : aucun mail n'est jamais envoyé par le code
  RECHERCHE_ARTISANS: 'libre',                                    // prospection d'artisans pour les agents IA téléphoniques : recherche Google Maps + email, met en attente de tri — jamais de mail, jamais d'envoi
            // CANDIDATURE : prépare un BROUILLON (rien n'est envoyé)
                                                                                               // veille d'offres d'emploi (flux publics, lecture seule)
  APP: 'confirmer',                                                                                             // ouvrir une application installée : à valider la 1re fois (ensuite « autorisée » par le code, jamais par l'IA)
  PROJET_SUPPR: 'confirmer',                                                                                    // supprimer un projet : à valider
  PERSO: 'confirmer', NOM: 'confirmer',   // elles changent durablement qui est Jarvis : à valider
};
// Ces actions deviennent "confirmer" quand la réponse s'appuie sur du contenu venu d'internet (risque d'injection).
const SENSIBLES_SI_EXTERNE = new Set(['OUVRIR', 'APPEL', 'ROUTINE_AJOUT', 'ROUTINE_MODIF']);
// Actions « confirmer » qui passent en « libre » quand LE CODE sait que TOI tu as déjà validé exactement cet objet (ex. une application déjà autorisée) — jamais quand la demande s'appuie sur du contenu externe.
const AUTORISABLES = new Set(['APP']);

// Secrets à ne jamais écrire dans le journal ni montrer.
const SECRET_RE = /(gsk_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|nfp_[A-Za-z0-9]{20,}|AQ\.[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|\d{8,10}:[A-Za-z0-9_-]{30,}|\b[a-f0-9]{32,}\b|sk-[A-Za-z0-9]{20,})/g;
const masquer = (s) => String(s == null ? '' : s).replace(SECRET_RE, '[secret]');

// Fichiers de Jarvis lui-même : JAMAIS accessibles, aucune exception possible.
const NOMS_CRITIQUES = /^(config\.json|spotify\.json|state\.json|securite_etat\.json)$/i;
// Autres fichiers sensibles, où qu'ils soient. Seul TOI peux en autoriser un précis, à la main, dans config.json > securite.exceptions.
const NOMS_INTERDITS = /^(\.env(\..*)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|pfx|p12|ppk|kdbx|keystore|ovpn)|\.npmrc|\.git-credentials|\.netrc|credentials(\..*)?|secrets?(\..*)?|.*\.session(-journal)?)$/i;
// Zones jamais accessibles : système, profils d'applications (navigateurs, mots de passe), clés.
const SYSTEME_RE = /^[a-z]:\\(windows|program files( \(x86\))?|programdata|\$recycle\.bin|system volume information)\\/;
const SEGMENTS_INTERDITS = ['\\.ssh\\', '\\.aws\\', '\\.azure\\', '\\.kube\\', '\\.gnupg\\', '\\appdata\\'];
const EXT_ECRITURE_INTERDITES = ['.exe', '.dll', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.wsf', '.msi', '.reg', '.scr', '.lnk', '.com', '.jar', '.hta', '.cpl'];

module.exports = function creer({ dir, getCfg }) {
  const conf = () => ((getCfg && getCfg()) || {}).securite || {};
  const dossierJournal = path.join(dir, 'journal');
  const fichierAudit = path.join(dossierJournal, 'actions.jsonl');
  const fichierEtat = path.join(dir, 'securite_etat.json');
  let etat = { suspendu: false, depuis: null };
  try { etat = { ...etat, ...JSON.parse(fs.readFileSync(fichierEtat, 'utf8')) }; } catch { /* premier démarrage */ }

  // ---------- Journal des actions (une ligne JSON par action, sans secrets) ----------
  function auditer(e) {
    try {
      fs.mkdirSync(dossierJournal, { recursive: true });
      if (fs.existsSync(fichierAudit) && fs.statSync(fichierAudit).size > 5e6) fs.renameSync(fichierAudit, fichierAudit + '.old');
      fs.appendFileSync(fichierAudit, JSON.stringify({
        t: new Date().toISOString(), source: e.source || '?', action: e.action, niveau: e.niveau || '', statut: e.statut, resume: masquer(e.resume).slice(0, 300),
      }) + '\n');
    } catch { /* le journal ne doit jamais faire tomber Jarvis */ }
  }
  function derniers(n = 20) {
    try { return fs.readFileSync(fichierAudit, 'utf8').trim().split('\n').slice(-n).map((l) => JSON.parse(l)).reverse(); } catch { return []; }
  }

  // ---------- Interrupteur d'urgence ----------
  const suspendu = () => !!etat.suspendu;
  function suspendre(valeur, qui) {
    etat = { suspendu: !!valeur, depuis: valeur ? Date.now() : null };
    try { fs.writeFileSync(fichierEtat, JSON.stringify(etat)); } catch { /* ignoré */ }
    auditer({ source: qui, action: 'SECURITE', statut: valeur ? 'actions suspendues' : 'actions reprises', resume: '' });
  }

  // ---------- Limite de débit : pas de rafale d'actions ----------
  const fenetre = [];
  function tentative(n = 1) {
    const now = Date.now();
    while (fenetre.length && now - fenetre[0] > 60000) fenetre.shift();
    if (fenetre.length + n > (conf().actions_par_minute ?? 8)) return false;
    for (let i = 0; i < n; i++) fenetre.push(now);
    return true;
  }

  // ---------- Niveau d'une action ----------
  function decider(action, ctx = {}) {
    if (!Object.prototype.hasOwnProperty.call(NIVEAUX, action)) return { niveau: 'interdit', raison: 'action inconnue' };
    if (suspendu()) return { niveau: 'interdit', raison: 'actions suspendues' };
    let niveau = NIVEAUX[action], raison = '';
    if (niveau === 'confirmer' && ctx.dejaAutorise === true && !ctx.contenuExterne && AUTORISABLES.has(action)) niveau = 'libre';
    if (niveau === 'libre' && ctx.contenuExterne && SENSIBLES_SI_EXTERNE.has(action)) { niveau = 'confirmer'; raison = 'appuyé sur du contenu venu d\'internet'; }
    return { niveau, raison };
  }

  // ---------- Confirmations à usage unique ----------
  const attente = new Map();
  let surDemande = null;
  const publique = (p) => ({ id: p.id, action: p.action, resume: p.resume, details: p.details, expire: p.expire });
  function nettoyer() {
    const now = Date.now();
    for (const [id, p] of attente) if (p.expire < now) { attente.delete(id); auditer({ source: p.source, action: p.action, niveau: 'confirmer', statut: 'expirée', resume: p.resume }); }
  }
  function demander({ action, resume, details, source, executer }) {
    nettoyer();
    if (attente.size >= 10) return null;                      // pas de déluge de demandes
    const id = crypto.randomBytes(4).toString('hex');
    const p = { id, action, resume: masquer(resume).slice(0, 400), details: masquer(details).slice(0, 1500), source, expire: Date.now() + (conf().confirmation_expire_s || 300) * 1000, executer };
    attente.set(id, p);
    auditer({ source, action, niveau: 'confirmer', statut: 'en attente', resume: p.resume });
    if (surDemande) { try { surDemande(publique(p)); } catch { /* notification facultative */ } }
    return id;
  }
  const enAttente = () => { nettoyer(); return [...attente.values()].map(publique); };
  async function confirmer(id, par) {
    nettoyer();
    const p = attente.get(String(id));
    if (!p) return { ok: false, message: 'Demande introuvable ou expirée.' };
    attente.delete(p.id);                                     // usage unique : impossible de la rejouer
    if (suspendu()) { auditer({ source: par, action: p.action, niveau: 'confirmer', statut: 'refusée (actions suspendues)', resume: p.resume }); return { ok: false, message: 'Les actions sont suspendues.' }; }
    try {
      await p.executer();
      auditer({ source: par, action: p.action, niveau: 'confirmer', statut: 'confirmée et exécutée', resume: p.resume });
      return { ok: true, message: 'Fait.' };
    } catch (e) {
      auditer({ source: par, action: p.action, niveau: 'confirmer', statut: 'confirmée, échec : ' + e.message, resume: p.resume });
      return { ok: false, message: 'Échec : ' + e.message };
    }
  }
  function refuser(id, par) {
    nettoyer();
    const p = attente.get(String(id));
    if (!p) return { ok: false, message: 'Demande introuvable ou expirée.' };
    attente.delete(p.id);
    auditer({ source: par, action: p.action, niveau: 'confirmer', statut: 'refusée', resume: p.resume });
    return { ok: true, message: 'Refusé, rien n\'a été fait.' };
  }

  // ---------- Garde-fou de chemins (pour les futurs outils de fichiers) ----------
  // Un chemin n'est accepté que s'il est DANS un dossier autorisé (securite.dossiers_lecture / dossiers_ecriture) après résolution
  // des raccourcis et des ".." ; et jamais s'il est secret, système, ou dans un profil d'application. Par défaut : aucun dossier autorisé.
  function reel(p) {
    const r = path.resolve(p);
    try { return fs.realpathSync.native(r); } catch { /* n'existe pas encore : on résout le plus proche parent existant */ }
    let cur = r; const reste = [];
    while (!fs.existsSync(cur)) { const par = path.dirname(cur); if (par === cur) break; reste.unshift(path.basename(cur)); cur = par; }
    try { return path.join(fs.realpathSync.native(cur), ...reste); } catch { return r; }
  }
  const norm = (p) => p.toLowerCase().replace(/\//g, '\\');
  function cheminAutorise(p, { ecriture = false } = {}) {
    if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return { ok: false, raison: 'chemin invalide' };
    const c = reel(p);
    const n = norm(c) + '\\';
    if (SYSTEME_RE.test(n) || SEGMENTS_INTERDITS.some((s) => n.includes(s))) return { ok: false, raison: 'zone protégée' };
    if (NOMS_CRITIQUES.test(path.basename(c))) return { ok: false, raison: 'fichier secret' };
    // Exceptions : chemins EXACTS que tu as autorisés à la main dans config.json (jamais modifiable par Jarvis : config.json lui est interdit).
    const exception = (conf().exceptions || []).some((e) => norm(reel(e)) + '\\' === n);
    if (!exception) {
      if (NOMS_INTERDITS.test(path.basename(c))) return { ok: false, raison: 'fichier secret' };
      if ((conf().exclusions_perso || []).some((x) => x && n.includes(norm(String(x))))) return { ok: false, raison: 'exclu par tes réglages' };
    }
    const racines = (ecriture ? conf().dossiers_ecriture : conf().dossiers_lecture) || [];
    const dedans = racines.some((r) => { const rr = norm(reel(r)).replace(/\\+$/, '') + '\\'; return n === rr || n.startsWith(rr); });
    if (!dedans) return { ok: false, raison: 'hors des dossiers autorisés' };
    if (ecriture && (conf().extensions_ecriture_interdites || EXT_ECRITURE_INTERDITES).includes(path.extname(c).toLowerCase())) return { ok: false, raison: 'type de fichier interdit en écriture' };
    return { ok: true, chemin: c };
  }

  return {
    NIVEAUX, masquer, auditer, derniers, suspendu, suspendre, tentative, decider, demander, enAttente, confirmer, refuser, cheminAutorise,
    set surDemande(f) { surDemande = f; },
  };
};
