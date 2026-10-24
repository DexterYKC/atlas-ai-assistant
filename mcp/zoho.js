// Création de brouillons Zoho Mail via l'API REST officielle (OAuth), configurée une seule fois avec zoho-setup.mjs :
// mcp/zoho_config.json (client_id, client_secret, refresh_token) sert à obtenir un access_token à chaque appel.
//
// GARDE-FOU (ne jamais affaiblir) : ce fichier n'appelle QUE des points d'API de lecture (comptes, dossiers, messages) et
// de création de BROUILLON (POST /messages avec mode:"draft" — il n'existe pas d'endpoint /drafts dédié, 404 vérifié).
// AUCUNE fonction d'envoi n'existe ici — pas d'appel à un endpoint d'envoi, jamais. N'ajoute jamais une telle fonction ici.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const FICHIER_CONFIG = path.join(ICI, 'zoho_config.json');
const FICHIER_SIGNATURE = path.join(ICI, 'signature.html');
const FICHIER_CACHE_JETON = path.join(ICI, 'zoho_token_cache.json');
const BASE = 'https://mail.zoho.com';
const ACCOUNTS = 'https://accounts.zoho.com';

function lireConfig() {
  try { return JSON.parse(readFileSync(FICHIER_CONFIG, 'utf8')); }
  catch { throw new Error("mcp/zoho_config.json introuvable : lance d'abord l'autorisation Zoho (node zoho-setup.mjs, voir le README du dossier mcp)."); }
}

// Mise en cache sur disque (pas seulement en mémoire) : Zoho limite le débit de rafraîchissement du jeton ("too many
// requests continuously"), et chaque lancement du serveur MCP par Claude Desktop est un nouveau process — sans ce fichier,
// chaque redémarrage referait un rafraîchissement pour rien tant que le précédent access_token est encore valide.
let jetonCache = { valeur: '', expire: 0 };
try { jetonCache = JSON.parse(readFileSync(FICHIER_CACHE_JETON, 'utf8')); } catch { /* pas encore de cache */ }

async function accessToken() {
  if (jetonCache.valeur && Date.now() < jetonCache.expire - 30000) return jetonCache.valeur;
  const { client_id, client_secret, refresh_token } = lireConfig();
  const params = new URLSearchParams({ grant_type: 'refresh_token', client_id, client_secret, refresh_token });
  const res = await fetch(`${ACCOUNTS}/oauth/v2/token`, { method: 'POST', body: params, signal: AbortSignal.timeout(15000) });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error('Impossible de rafraîchir le jeton Zoho : ' + (j.error_description || j.error || JSON.stringify(j)));
  jetonCache = { valeur: j.access_token, expire: Date.now() + (j.expires_in || 3600) * 1000 };
  try { writeFileSync(FICHIER_CACHE_JETON, JSON.stringify(jetonCache)); } catch { /* tant pis, ça retombera sur un rafraîchissement */ }
  return jetonCache.valeur;
}

export async function zohoApi(methode, chemin, corpsJson) {
  const token = await accessToken();
  let res;
  try {
    res = await fetch(`${BASE}${chemin}`, {
      method: methode,
      headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
      body: corpsJson !== undefined ? JSON.stringify(corpsJson) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) { throw new Error(`Zoho Mail est injoignable (${e.message}).`); }
  let j; try { j = await res.json(); } catch { throw new Error(`Réponse Zoho illisible (HTTP ${res.status}).`); }
  const code = j && j.status && j.status.code;
  if (!res.ok || (code && Number(code) >= 400)) {
    throw new Error((j.data && j.data.errorMessage) || (j.status && j.status.description) || `Zoho a refusé la requête (HTTP ${res.status}).`);
  }
  return j;
}

let compteCache = null;
export async function compteEmail() {
  if (compteCache) return compteCache;
  const j = await zohoApi('GET', '/api/accounts');
  const c = (j.data || [])[0];
  if (!c) throw new Error('Aucun compte Zoho Mail trouvé pour ce jeton.');
  const envoi = (c.sendMailDetails || [])[0] || {};
  const fromAddress = envoi.fromAddress || c.primaryEmailAddress || c.mailboxAddress || c.accountName;
  if (!fromAddress) throw new Error("Impossible de déterminer l'adresse d'expédition du compte Zoho.");
  compteCache = { accountId: c.accountId, fromAddress };
  return compteCache;
}

const dossierCache = {};
// folderType : "Drafts" | "Inbox" | "Sent" ... (champ stable de l'API Zoho, indépendant du nom affiché/langue du dossier).
export async function idDossier(accountId, folderType) {
  if (dossierCache[folderType]) return dossierCache[folderType];
  const j = await zohoApi('GET', `/api/accounts/${accountId}/folders`);
  const d = (j.data || []).find((f) => f.folderType === folderType) || (j.data || []).find((f) => new RegExp(folderType, 'i').test(f.folderName || f.path || ''));
  if (!d) throw new Error(`Dossier « ${folderType} » introuvable pour ce compte.`);
  dossierCache[folderType] = d.folderId;
  return d.folderId;
}

async function brouillonPresent(accountId, folderId, messageId) {
  const j = await zohoApi('GET', `/api/accounts/${accountId}/messages/view?folderId=${folderId}&limit=20`);
  return (j.data || []).some((m) => String(m.messageId) === String(messageId));
}

// Recherche brute (lecture seule) dans un dossier. ATTENTION empirique (vérifié sur ce compte) : l'opérateur "sender:"
// filtre correctement (vide si aucun match, résultats corrects sinon) ; "from:" ne filtre PAS (renvoie n'importe quoi,
// y compris pour une adresse bidon) — ne jamais utiliser "from:" pour une décision. "to:" filtre correctement aussi.
export async function rechercherMessages(accountId, searchKey, folderId, limit = 20) {
  const j = await zohoApi('GET', `/api/accounts/${accountId}/messages/search?searchKey=${encodeURIComponent(searchKey)}&folderId=${folderId}&limit=${limit}`);
  return j.data || [];
}

let signatureCache;
function lireSignature() {
  if (signatureCache === undefined) {
    try { signatureCache = readFileSync(FICHIER_SIGNATURE, 'utf8').trim(); }
    catch { signatureCache = ''; }
  }
  return signatureCache;
}
// Détecte une signature déjà présente via un fragment qui lui est propre (son image), pour ne jamais la dupliquer —
// se base sur le fichier lui-même plutôt qu'une chaîne codée en dur, pour rester à jour si signature.html change.
function marqueurSignature(signature) {
  const m = signature.match(/src=["']([^"']+)["']/i);
  return m ? m[1] : signature.slice(0, 60);
}
export function ajouterSignature(corpsHtml) {
  const signature = lireSignature();
  if (!signature) return corpsHtml;
  if (corpsHtml.includes(marqueurSignature(signature))) return corpsHtml;
  return `${corpsHtml}<div><br></div>${signature}`;
}

// Primitive partagée par creerBrouillon et creerRelance : crée en BROUILLON (jamais autre chose) puis vérifie sa présence
// dans le dossier Brouillons. Pas d'endpoint /drafts dédié (404 URL_RULE_NOT_CONFIGURED, vérifié) : c'est /messages avec
// mode:"draft" qui enregistre sans envoyer. Ne jamais changer "draft" pour autre chose ici (retirer "mode" enverrait réellement).
export async function creerEtVerifierBrouillon(accountId, fromAddress, toAddress, subject, content) {
  const creation = await zohoApi('POST', `/api/accounts/${accountId}/messages`, {
    fromAddress, toAddress, subject, content, mailFormat: 'html', mode: 'draft',
  }).catch((e) => { throw new Error(`Échec de la création du brouillon : ${e.message}`); });

  const messageId = (creation.data || {}).messageId;
  if (!messageId) throw new Error("Zoho n'a renvoyé aucun identifiant de brouillon : impossible de vérifier sa présence dans le dossier Brouillons.");

  const folderId = await idDossier(accountId, 'Drafts').catch((e) => { throw new Error(`Brouillon créé (id ${messageId}) mais vérification impossible : ${e.message}`); });
  const present = await brouillonPresent(accountId, folderId, messageId).catch(() => false);
  if (!present) throw new Error(`Brouillon créé (id ${messageId}) mais introuvable dans le dossier Brouillons lors de la vérification.`);

  return messageId;
}

export async function creerBrouillon(destinataire, objet, corpsHtml) {
  const dest = String(destinataire || '').trim();
  const obj = String(objet || '').trim();
  if (!dest) throw new Error('destinataire manquant.');
  if (!obj) throw new Error('objet manquant.');
  if (!String(corpsHtml || '').trim()) throw new Error('corps du message manquant.');

  const { accountId, fromAddress } = await compteEmail();
  const contenuFinal = ajouterSignature(corpsHtml);
  const messageId = await creerEtVerifierBrouillon(accountId, fromAddress, dest.replace(/;/g, ','), obj, contenuFinal);

  return { ok: true, message: `Brouillon créé et vérifié dans le dossier Brouillons (destinataire : ${dest}, objet : ${obj}).`, messageId };
}
