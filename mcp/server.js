#!/usr/bin/env node
// Serveur MCP local pour Claude Desktop : donne accès UNIQUEMENT aux prospects « Agents IA » et Business d'Atlas (prospection
// d'artisans, relances groupées sur un jour fixe par semaine, prospects sans email à contacter autrement, lot marqué
// « déjà contacté » hors cycle normal), en lecture, pour les trier/marquer, pour lire le site d'un prospect déjà
// enregistré, et pour préparer des brouillons Zoho Mail (premier contact ou relance dans le même fil). Aucun autre accès : pas de shell, pas de trading,
// pas de journal, pas d'agenda, et AUCUN outil de lecture de boîte mail (les appels de lecture Zoho — comptes, dossiers,
// messages — servent uniquement, en interne, à vérifier qu'un brouillon a bien été créé et à calculer l'indicateur a_repondu ;
// le CONTENU des mails reçus n'est jamais exposé, seulement un oui/non calculé côté serveur). Les données prospects (Agents IA
// et Business) passent par l'API locale d'Atlas (127.0.0.1:8765) — jamais d'écriture directe dans business.json ou state.json,
// pour ne jamais entrer en conflit avec le processus jarvis.js qui, lui, écrit ces fichiers en continu. lire_site sort sur le
// web, et seulement vers l'URL de site déjà enregistrée pour le prospect demandé — jamais une URL fournie en paramètre.
// creer_brouillon et creer_relance passent par l'API officielle Zoho Mail (OAuth, mcp/zoho_config.json) et n'enregistrent
// jamais que des BROUILLONS : aucune fonction d'envoi n'existe dans ce code (voir zoho.js).
// Donne aussi accès aux candidatures de la section Emploi (marquer « postulée », réponse reçue, relance) : mêmes
// garanties (API locale d'Atlas uniquement, jamais d'écriture directe dans state.json) — voir emploi.js.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { atlas, BASE_URL } from './atlas.js';
import { creerBrouillon } from './zoho.js';
import { listerRelances, marquerRelance, creerRelance, listerAContacterAutrement, listerBusiness, marquerContacte } from './relances.js';
import { listerCandidaturesARelancer, marquerCandidatureEnvoyee, marquerCandidatureReponse, marquerCandidatureRelancee } from './emploi.js';

// Jamais sur stdout : le transport stdio s'en sert pour le protocole MCP. Tous les logs vont sur stderr.
const log = (...a) => console.error('[atlas-prospects-mcp]', ...a);

const texte = (valeur) => ({ content: [{ type: 'text', text: typeof valeur === 'string' ? valeur : JSON.stringify(valeur, null, 2) }] });
const erreur = (e) => ({ content: [{ type: 'text', text: `Erreur : ${e.message || e}` }], isError: true });

// ---------- lire_site : lecture seule du site d'un prospect (jamais d'URL fournie par l'appelant) ----------
const LIMITE_CARACTERES = 15000;
// Hôtes locaux/privés interdits : le site vient de données stockées (Google Places/OSM via Atlas), pas directement de l'appelant,
// mais si business.json était un jour altéré, ça empêche l'outil de servir à sonder le réseau local (SSRF).
function urlInterdite(u) {
  let h;
  try { h = new URL(u).hostname.toLowerCase(); } catch { return true; }
  if (!h || h === 'localhost' || h === '0.0.0.0' || h === '::1' || h.endsWith('.local')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}
const ENTITES_HTML = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', auml: 'ä',
  ccedil: 'ç', ocirc: 'ô', ouml: 'ö', ugrave: 'ù', ucirc: 'û', uuml: 'ü', iuml: 'ï', icirc: 'î',
  oelig: 'œ', Eacute: 'É', Egrave: 'È', Agrave: 'À', Ccedil: 'Ç', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…',
  copy: '©', reg: '®', trade: '™', mdash: '—', ndash: '–', laquo: '«', raquo: '»', deg: '°', euro: '€', middot: '·', bull: '•' };
function decoderEntites(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(code) ? String.fromCodePoint(code) : m; }
    return ENTITES_HTML[e] !== undefined ? ENTITES_HTML[e] : m;
  });
}
function nettoyerTexte(html) {
  const s = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decoderEntites(s).replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function extraireLiens(html, base) {
  const liens = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let url;
    try { url = new URL(m[1], base); } catch { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    liens.push({ url: url.toString(), texte: nettoyerTexte(m[2]) });
  }
  return liens;
}
function trouverLienContact(liens, base) {
  let baseHost; try { baseHost = new URL(base).host; } catch { return null; }
  const re = /contact/i;
  const meme = liens.filter((l) => { try { return new URL(l.url).host === baseHost; } catch { return false; } });
  const parChemin = meme.find((l) => re.test(new URL(l.url).pathname));
  if (parChemin) return parChemin.url;
  const parTexte = meme.find((l) => re.test(l.texte));
  return parTexte ? parTexte.url : null;
}
async function recupererPage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AtlasProspectBot/1.0)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { html: await res.text(), urlFinale: res.url || url };
}

const server = new McpServer({ name: 'atlas-prospects', version: '1.0.0' });

server.registerTool('lister_prospects', {
  title: 'Lister les prospects Agents IA',
  description: "Liste les prospects trouvés par l'outil de prospection d'artisans d'Atlas (Agents IA), avec filtres optionnels par statut, métier et ville. Renvoie pour chacun : id, nom, métier, ville, téléphone, email, site, note, nombre d'avis et avertissements (signaux négatifs détectés, ou motif de rejet).",
  inputSchema: {
    statut: z.enum(['a_trier', 'valide', 'rejete']).optional().describe("Filtre par statut : a_trier (pas encore trié), valide (marqué « Bon »), rejete (marqué « Pas bon », ou écarté automatiquement). Omis = les trois."),
    metier: z.string().trim().min(1).optional().describe('Filtre par métier (sous-chaîne, insensible à la casse et aux accents).'),
    ville: z.string().trim().min(1).optional().describe('Filtre par ville (sous-chaîne, insensible à la casse et aux accents).'),
  },
}, async ({ statut, metier, ville }) => {
  try { return texte((await atlas('GET', '/api/agentsia/prospects', { params: { statut, metier, ville } })).prospects); }
  catch (e) { return erreur(e); }
});

server.registerTool('voir_prospect', {
  title: 'Voir un prospect',
  description: "Détail complet d'un prospect Agents IA à partir de son id (renvoyé par lister_prospects).",
  inputSchema: { id: z.string().trim().min(1).describe('Id du prospect (champ « id » renvoyé par lister_prospects).') },
}, async ({ id }) => {
  try { return texte((await atlas('GET', '/api/agentsia/prospect', { params: { id } })).prospect); }
  catch (e) { return erreur(e); }
});

server.registerTool('marquer_prospect', {
  title: 'Marquer un prospect (Bon / Pas bon)',
  description: "Trie un prospect Agents IA exactement comme les boutons « Bon » et « Pas bon » du tableau de bord : « bon » le valide et le pousse en prospect Business (section Prospection) ; « pas_bon » l'écarte pour toujours, avec un motif optionnel qui sert à affiner les prochaines recherches.",
  inputSchema: {
    id: z.string().trim().min(1).describe('Id du prospect à trier (champ « id » renvoyé par lister_prospects).'),
    verdict: z.enum(['bon', 'pas_bon']).describe('« bon » ou « pas_bon », comme les deux boutons du tableau de bord.'),
    motif: z.string().trim().max(1000).optional().describe('Raison du rejet (facultatif, utile seulement pour « pas_bon »).'),
  },
}, async ({ id, verdict, motif }) => {
  try { return texte(await atlas('POST', '/api/agentsia/decider', { corps: { id, decision: verdict, motif } })); }
  catch (e) { return erreur(e); }
});

server.registerTool('lire_site', {
  title: "Lire le site d'un prospect",
  description: "Récupère la page d'accueil et la page contact (si un lien contact est trouvé sur l'accueil) du site d'un prospect Agents IA, et renvoie leur texte nettoyé (sans HTML), limité à environ 15 000 caractères au total. Utilise TOUJOURS l'URL de site déjà enregistrée pour ce prospect (via lister_prospects / voir_prospect) : cet outil ne prend aucune URL en paramètre.",
  inputSchema: { id: z.string().trim().min(1).describe('Id du prospect (champ « id » renvoyé par lister_prospects) — pas une URL.') },
}, async ({ id }) => {
  try {
    const prospect = (await atlas('GET', '/api/agentsia/prospect', { params: { id } })).prospect;
    const site = String((prospect || {}).site || '').trim();
    if (!site) throw new Error(`Aucun site enregistré pour le prospect ${id}.`);
    const base = /^https?:\/\//i.test(site) ? site : 'https://' + site;
    if (urlInterdite(base)) throw new Error("Cette adresse n'est pas autorisée (hôte local/privé).");

    const accueil = await recupererPage(base).catch((e) => { throw new Error(`Page d'accueil injoignable (${e.message}).`); });
    const morceaux = [`=== Page d'accueil (${accueil.urlFinale}) ===\n${nettoyerTexte(accueil.html)}`];

    const lienContact = trouverLienContact(extraireLiens(accueil.html, accueil.urlFinale), accueil.urlFinale);
    if (!lienContact) {
      morceaux.push("\n=== Page contact ===\n(aucun lien de contact trouvé sur la page d'accueil)");
    } else if (urlInterdite(lienContact)) {
      morceaux.push('\n=== Page contact ===\n(lien ignoré : adresse non autorisée)');
    } else {
      try { const contact = await recupererPage(lienContact); morceaux.push(`\n=== Page contact (${contact.urlFinale}) ===\n${nettoyerTexte(contact.html)}`); }
      catch (e) { morceaux.push(`\n=== Page contact (${lienContact}) ===\n(injoignable : ${e.message})`); }
    }

    let out = morceaux.join('\n');
    if (out.length > LIMITE_CARACTERES) out = out.slice(0, LIMITE_CARACTERES) + '\n[...tronqué]';
    return texte(out);
  } catch (e) { return erreur(e); }
});

server.registerTool('creer_brouillon', {
  title: 'Créer un brouillon Zoho Mail',
  description: "Crée un brouillon dans Zoho Mail (destinataire, objet, corps HTML avec liens cliquables), via l'API officielle Zoho Mail (OAuth). La signature (mcp/signature.html) est ajoutée automatiquement à la fin, séparée par un saut de ligne — ne jamais l'inclure soi-même dans corps_html, elle ne sera pas dupliquée si on le fait quand même. Enregistre TOUJOURS en brouillon (mode « draft »), vérifie sa présence dans le dossier Brouillons, et ne l'envoie jamais : aucune fonction d'envoi n'existe dans cet outil.",
  inputSchema: {
    destinataire: z.string().trim().min(3).describe('Adresse email du destinataire (ou plusieurs, séparées par des virgules).'),
    objet: z.string().trim().min(1).describe('Objet du message.'),
    corps_html: z.string().trim().min(1).describe("Corps du message en HTML (les liens <a href=\"...\"> seront cliquables). N'inclut PAS la signature : elle est ajoutée automatiquement."),
  },
}, async ({ destinataire, objet, corps_html }) => {
  try { return texte(await creerBrouillon(destinataire, objet, corps_html)); }
  catch (e) { return erreur(e); }
});

server.registerTool('lister_relances', {
  title: 'Lister les relances Business dues',
  description: "Liste les prospects de la section Business à relancer aujourd'hui ou en retard (même filtre que le bandeau du tableau de bord : email enregistré, date de relance fixée et déjà passée ou du jour, hors perdu/sans réponse). Les relances sont désormais regroupées sur un seul jour fixe par semaine (config.json > business.jour_relance). Pour chacun : id, nom, métier, ville (cross-référencés depuis les prospects Agents IA validés quand possible), email, site, date du premier mail envoyé (dossier Sent Zoho), date de relance prévue, statut, et a_repondu (oui/non/inconnu — jamais le contenu des mails). Les prospects sans email n'ont jamais de relance programmée : voir lister_a_contacter_autrement.",
  inputSchema: {},
}, async () => {
  try { return texte(await listerRelances()); }
  catch (e) { return erreur(e); }
});

server.registerTool('marquer_relance', {
  title: 'Marquer une relance (Relancé / Pas encore)',
  description: "Marque une relance Business exactement comme les boutons « ✅ Relancé » et « ⏳ Pas encore » du tableau de bord. « relance » : programme la prochaine relance sur le prochain jour de relance fixe (au moins 5 jours plus tard — config.json > business.jour_relance), ou à la date donnée dans prochaine_relance si fournie, et ajoute une note « Relancé le ... ». Après 2 relances déjà faites sans réponse, la 3e tentative est automatiquement remplacée par un passage au statut « sans réponse » (plus de relance programmée). « pas_encore » : ne modifie RIEN — le vrai bouton ne fait que masquer la relance pour la session en cours du navigateur, elle revient au prochain chargement ; ce verdict reproduit fidèlement ce non-effet (prochaine_relance est ignoré si fourni avec « pas_encore »).",
  inputSchema: {
    id: z.string().trim().min(1).describe('Id du prospect Business (voir lister_relances).'),
    verdict: z.enum(['relance', 'pas_encore']).describe('« relance » ou « pas_encore », comme les deux boutons du tableau de bord.'),
    prochaine_relance: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format attendu : AAAA-MM-JJ').optional().describe("Date (AAAA-MM-JJ) de la prochaine relance, à la place du jour de relance fixe calculé automatiquement. Ignoré si verdict=\"pas_encore\"."),
  },
}, async ({ id, verdict, prochaine_relance }) => {
  try { return texte(await marquerRelance(id, verdict, prochaine_relance)); }
  catch (e) { return erreur(e); }
});

server.registerTool('lister_a_contacter_autrement', {
  title: 'Lister les prospects à contacter autrement',
  description: "Liste les prospects Business sans adresse email (pas de relance possible par ce canal, donc exclus de lister_relances), pas encore marqués « Contacté » ni perdus/sans réponse. Pour chacun : id, nom, métier, ville, site, téléphone (quand connus), statut. Lecture seule : pour marquer « Contacté » ou abandonner, utilise le tableau de bord (section Business, boutons sur la liste « à contacter autrement »).",
  inputSchema: {},
}, async () => {
  try { return texte(await listerAContacterAutrement()); }
  catch (e) { return erreur(e); }
});

server.registerTool('lister_business', {
  title: 'Lister les prospects Business',
  description: "Liste tous les prospects de la section Business, avec filtre optionnel par statut (contact, devis envoyé, négociation, gagné, perdu, sans réponse). Sert à retrouver l'id d'un prospect par nom/email avant d'appeler marquer_contacte ou marquer_relance — contrairement à lister_relances (seulement les relances dues) et lister_a_contacter_autrement (seulement ceux sans email), celui-ci montre tout. Pour chacun : id, nom, métier, ville, email, site, téléphone, statut, date du premier mail (si connue), date de relance prévue.",
  inputSchema: {
    statut: z.enum(['contact', 'devis envoyé', 'négociation', 'gagné', 'perdu', 'sans réponse']).optional().describe('Filtre par statut. Omis = tous les prospects.'),
  },
}, async ({ statut }) => {
  try { return texte(await listerBusiness(statut)); }
  catch (e) { return erreur(e); }
});

server.registerTool('marquer_contacte', {
  title: 'Marquer un lot de prospects comme contactés',
  description: "Pour un lot de prospects Business déjà contactés en dehors du cycle normal (ex. envoi groupé fait à la main) : passe leur statut à « contact », enregistre la date du premier mail, et programme la prochaine relance sur le prochain jour de relance fixe (config.json > business.jour_relance, au moins 5 jours après la date d'envoi). Identifie chaque prospect par email ou par id (voir lister_business pour les retrouver) — accepte un mélange des deux dans la même liste. Passe par l'API d'Atlas (/business/prospect/contacte), jamais d'écriture directe dans business.json.",
  inputSchema: {
    identifiants: z.array(z.string().trim().min(1)).min(1).describe("Liste d'emails et/ou d'ids (sous forme de texte) des prospects à marquer."),
    date_envoi: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format attendu : AAAA-MM-JJ').optional().describe("Date d'envoi du premier mail, par défaut aujourd'hui. Appliquée à tout le lot."),
  },
}, async ({ identifiants, date_envoi }) => {
  try { return texte(await marquerContacte(identifiants, date_envoi)); }
  catch (e) { return erreur(e); }
});

server.registerTool('creer_relance', {
  title: 'Créer un brouillon de relance',
  description: "Prépare un brouillon de relance pour un prospect Business : retrouve le dernier mail envoyé à son adresse (dossier Sent Zoho), reprend son objet en « Re: ... », et crée un brouillon adressé à la même personne avec le corps HTML fourni (signature ajoutée automatiquement, comme creer_brouillon). Enregistre TOUJOURS en brouillon, vérifie sa présence dans Brouillons, et ne l'envoie jamais. Limite connue : l'API Zoho ne permet pas de fixer les en-têtes RFC822 de réponse (In-Reply-To/References) — le brouillon reprend le même destinataire et objet, ce qui regroupe généralement la conversation côté Zoho Mail, mais sans garantie au niveau des en-têtes.",
  inputSchema: {
    id: z.string().trim().min(1).describe('Id du prospect Business (voir lister_relances) — doit avoir un email enregistré et un mail déjà envoyé.'),
    corps_html: z.string().trim().min(1).describe("Corps du message de relance en HTML. N'inclut PAS la signature : elle est ajoutée automatiquement."),
  },
}, async ({ id, corps_html }) => {
  try { return texte(await creerRelance(id, corps_html)); }
  catch (e) { return erreur(e); }
});

server.registerTool('lister_candidatures_a_relancer', {
  title: 'Lister les candidatures à relancer',
  description: "Liste les offres de la section Emploi marquées « postulée » depuis au moins le délai configuré (config.json > emploi.relance_jours, en jours OUVRÉS — 10 par défaut) sans réponse enregistrée. Pour chacune : id (celui de l'offre, pas d'un prospect Business), titre, société, url, date réelle d'envoi, date de relance prévue, nombre de relances déjà faites. Au-delà de 2 relances sans réponse, une offre n'apparaît plus ici (plus de relance automatique).",
  inputSchema: {},
}, async () => {
  try { return texte(await listerCandidaturesARelancer()); }
  catch (e) { return erreur(e); }
});

server.registerTool('marquer_candidature_envoyee', {
  title: 'Marquer une candidature comme envoyée',
  description: "Marque une offre de la section Emploi comme « postulée » (même effet que le bouton « ✔ Marquer postulée » du tableau de bord), avec la date RÉELLE d'envoi du mail — à utiliser quand le mail part réellement, pas quand le brouillon est rédigé (souvent plusieurs jours avant). Programme automatiquement la prochaine relance (config.json > emploi.relance_jours, jours ouvrés) si aucune réponse n'est enregistrée d'ici là.",
  inputSchema: {
    id: z.string().trim().min(1).describe("Id de l'offre Emploi (pas un id de prospect Business)."),
    date_envoi: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format attendu : AAAA-MM-JJ').optional().describe("Date réelle d'envoi, si ce n'est pas aujourd'hui (ex. dit après coup). Omis = aujourd'hui."),
  },
}, async ({ id, date_envoi }) => {
  try { return texte(await marquerCandidatureEnvoyee(id, date_envoi)); }
  catch (e) { return erreur(e); }
});

server.registerTool('marquer_candidature_reponse', {
  title: 'Marquer une réponse reçue',
  description: "Enregistre qu'une réponse a été reçue pour une candidature (section Emploi) : arrête les relances automatiques pour cette offre. N'enregistre ni ne lit jamais le contenu d'un mail — un simple marqueur, posé par Youssef.",
  inputSchema: { id: z.string().trim().min(1).describe("Id de l'offre Emploi (voir lister_candidatures_a_relancer).") },
}, async ({ id }) => {
  try { return texte(await marquerCandidatureReponse(id)); }
  catch (e) { return erreur(e); }
});

server.registerTool('marquer_candidature_relancee', {
  title: 'Marquer une candidature relancée',
  description: "Enregistre qu'une relance a été envoyée pour une candidature déjà « postulée » (section Emploi) : reprogramme la prochaine relance (config.json > emploi.relance_jours, jours ouvrés), sauf après 2 relances déjà faites — la limite est alors atteinte et plus aucune relance n'est programmée.",
  inputSchema: { id: z.string().trim().min(1).describe("Id de l'offre Emploi (voir lister_candidatures_a_relancer).") },
}, async ({ id }) => {
  try { return texte(await marquerCandidatureRelancee(id)); }
  catch (e) { return erreur(e); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`Prêt. Atlas : ${BASE_URL}`);
