// Relances de la section Business d'Atlas : lister (même filtre que le bandeau "urgent" de l'interface), marquer
// (même effet que les boutons "Relancé" / "Pas encore"), et préparer un brouillon de relance dans le même fil Zoho.
// Les données prospects passent par l'API locale d'Atlas (GET /business, POST /business/prospect — routes déjà
// existantes, aucune n'a été ajoutée pour ce fichier). a_repondu n'expose jamais le contenu des mails reçus : seulement
// un oui/non calculé côté serveur, jamais le texte ni l'objet d'un message reçu.
import { atlas } from './atlas.js';
import { compteEmail, idDossier, rechercherMessages, ajouterSignature, creerEtVerifierBrouillon } from './zoho.js';

const seoNorm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
// Date LOCALE, jamais UTC (toISOString() donne la date UTC : selon le fuseau, elle reste sur la veille pendant la
// première heure ou deux après minuit local, et une relance due "aujourd'hui" disparaissait de la liste pendant cette
// fenêtre). Merci à Matt Abate pour le signalement (issue #2), reproduit.
const dateLocale = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateDuJour = () => dateLocale();
// Même format que frDate() de ui/index.html (ex. "14 oct."), pour que la note ajoutée par l'outil ressemble à celle du bouton.
const frDateCourte = (iso) => (iso ? new Date(iso + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '');

// Cross-référence par nom normalisé avec les prospects "Agents IA" validés : seule source qui a métier/ville en champs
// structurés (business.json ne les garde pas séparément — parfois noyés dans "notes" en texte libre, ex. "Trouvé à Lyon").
async function metierVilleParNom() {
  const { prospects } = await atlas('GET', '/api/agentsia/prospects', { params: { statut: 'valide' } });
  const carte = new Map();
  for (const p of prospects) carte.set(seoNorm(p.nom), { metier: p.metier || null, ville: p.ville || null });
  return carte;
}

// "date du premier mail" / dernier mail (pour creer_relance) : messages ENVOYÉS à cette adresse (dossier Sent).
// L'opérateur "to:" a été vérifié fiable (vide sur une adresse bidon, correct sur une adresse réelle) ; "from:" ne l'est
// PAS (renvoie du bruit même pour une adresse bidon, testé en conditions réelles) — jamais utilisé pour décider quoi que ce soit.
async function mailsEnvoyesA(accountId, email) {
  const sentId = await idDossier(accountId, 'Sent');
  const envoyes = (await rechercherMessages(accountId, `to:${email}`, sentId, 50))
    .filter((m) => String(m.toAddress || '').toLowerCase().includes(email.toLowerCase())); // garde-fou client, même si to: a été vérifié fiable
  if (!envoyes.length) return { premier: null, dernier: null };
  const tries = envoyes.slice().sort((a, b) => Number(a.sentDateInGMT) - Number(b.sentDateInGMT));
  return { premier: tries[0], dernier: tries[tries.length - 1] };
}

// true/false seulement : ne renvoie et ne garde jamais le contenu des messages reçus.
async function aRepondu(accountId, email, depuisMs) {
  const inboxId = await idDossier(accountId, 'Inbox');
  const recus = await rechercherMessages(accountId, `sender:${email}`, inboxId, 50);
  return recus.some((m) => String(m.fromAddress || '').toLowerCase() === email.toLowerCase() && Number(m.receivedTime || m.sentDateInGMT || 0) >= depuisMs);
}

const EXCLUS_RELANCE = ['perdu', 'sans réponse'];

export async function listerRelances() {
  const { prospects } = await atlas('GET', '/business');
  const aujourdhui = dateDuJour();
  // Même filtre que le bandeau "urgent" de l'interface (index.html) : email requis (sinon le prospect appartient à "à
  // contacter autrement", lister_a_contacter_autrement), et hors perdu/sans réponse (une relance reste parfois posée par
  // erreur sur une fiche déjà close — en défense, même si ça ne devrait plus arriver depuis le correctif du jour fixe).
  const dus = prospects.filter((p) => p.email && p.relance && p.relance <= aujourdhui && !EXCLUS_RELANCE.includes(p.etape));
  const carteMetierVille = await metierVilleParNom().catch(() => new Map());
  const { accountId } = await compteEmail();

  return Promise.all(dus.map(async (p) => {
    // Depuis la correction du 14/10 (agentsIADecider copie metier/ville sur la fiche Business), les nouvelles fiches les
    // ont déjà en champs propres ; le recoupement par nom ne sert plus que pour les fiches créées avant ce correctif.
    const mv = (p.metier || p.ville) ? { metier: p.metier || null, ville: p.ville || null } : (carteMetierVille.get(seoNorm(p.nom)) || { metier: null, ville: null });
    // Depuis marquer_contacte (jarvis.js > /business/prospect/contacte), la date du premier mail peut déjà être stockée sur
    // la fiche : on l'utilise directement (une recherche Zoho de moins) et on ne retombe sur mailsEnvoyesA que si absente.
    let date_premier_mail = p.date_premier_mail || null;
    let depuisMs = date_premier_mail ? new Date(`${date_premier_mail}T00:00:00`).getTime() : null;
    let a_repondu = null; // null = pas d'email enregistré, donc impossible à vérifier (distinct de false)
    if (p.email) {
      try {
        if (!date_premier_mail) {
          const { premier } = await mailsEnvoyesA(accountId, p.email);
          if (premier) { date_premier_mail = dateLocale(new Date(Number(premier.sentDateInGMT))); depuisMs = Number(premier.sentDateInGMT); }
        }
        a_repondu = depuisMs ? await aRepondu(accountId, p.email, depuisMs) : false; // jamais envoyé : pas de réponse possible
      } catch { /* une recherche Zoho en échec pour ce prospect ne doit pas faire échouer toute la liste */ }
    }
    return {
      id: p.id, nom: p.nom, metier: mv.metier, ville: mv.ville, email: p.email || null, site: p.site || null,
      date_premier_mail, date_relance_prevue: p.relance, statut: p.etape, a_repondu,
    };
  }));
}

const dateOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !isNaN(new Date(`${v}T12:00:00`)); // même validation que /business/prospect (jarvis.js)

export async function marquerRelance(id, verdict, prochaineRelance) {
  if (verdict === 'pas_encore') {
    // Fidèle au vrai bouton "⏳ Pas encore" (ui/index.html) : il ne change RIEN côté serveur, il masque juste la relance
    // de LA SESSION DU NAVIGATEUR en cours (Set en mémoire JS), sans toucher à la date ni aux notes — elle revient au
    // prochain chargement de la page. Il n'y a donc rien à modifier ici : no-op assumé, fidèle au comportement réel.
    return { ok: true, message: "« Pas encore » : aucune donnée modifiée — le vrai bouton ne fait que masquer la relance pour la session en cours du tableau de bord ; elle revient au prochain chargement." };
  }
  if (verdict !== 'relance') throw new Error('verdict invalide (attendu : "relance" ou "pas_encore").');
  if (prochaineRelance !== undefined && !dateOk(prochaineRelance)) throw new Error('prochaine_relance invalide (format attendu : AAAA-MM-JJ).');

  // Même route que le bouton "✅ Relancé" (jarvis.js > /business/prospect/relance) : la règle de date (jour fixe
  // hebdomadaire, config.json > business.jour_relance) et le compteur/coupure après 2 relances sans réponse vivent à un
  // seul endroit, pas dupliqués ici.
  const r = await atlas('POST', '/business/prospect/relance', { corps: { id, prochaine_relance: prochaineRelance } });
  return r.etape === 'sans réponse'
    ? { ok: true, message: 'Trop de relances sans réponse : prospect passé au statut « sans réponse », retiré des relances.' }
    : { ok: true, message: `Relancé : prochaine relance programmée le ${r.relance}.` };
}

export async function creerRelance(id, corpsHtml) {
  if (!String(corpsHtml || '').trim()) throw new Error('corps du message manquant.');
  const { prospects } = await atlas('GET', '/business');
  const p = prospects.find((x) => String(x.id) === String(id));
  if (!p) throw new Error(`Prospect ${id} introuvable.`);
  if (!p.email) throw new Error(`Le prospect « ${p.nom} » (id ${id}) n'a pas d'adresse email enregistrée.`);

  const { accountId, fromAddress } = await compteEmail();
  const { dernier } = await mailsEnvoyesA(accountId, p.email);
  if (!dernier) throw new Error(`Aucun mail déjà envoyé à ${p.email} (dossier Sent) : rien à relancer. Utilise creer_brouillon pour un premier contact.`);

  const sujetOriginal = String(dernier.subject || '').trim();
  const sujetRelance = /^re\s*:/i.test(sujetOriginal) ? sujetOriginal : `Re: ${sujetOriginal}`;
  const contenuFinal = ajouterSignature(corpsHtml);
  const messageId = await creerEtVerifierBrouillon(accountId, fromAddress, p.email, sujetRelance, contenuFinal);

  return {
    ok: true,
    message: `Brouillon de relance créé et vérifié dans Brouillons (destinataire : ${p.email}, objet : ${sujetRelance}).`,
    avertissement: "L'API Zoho Mail ne permet pas de fixer les en-têtes RFC822 de réponse (In-Reply-To/References) : plusieurs variantes testées, toutes rejetées (clé non reconnue) ou endpoint inexistant. Le brouillon reprend le même destinataire et un objet « Re: ... » identique, ce qui regroupe en général la conversation dans Zoho Mail, mais ce n'est pas garanti au niveau des en-têtes comme le ferait un vrai « répondre ».",
    messageId,
  };
}

// Prospects sans email : pas de relance possible par ce canal (cf. agentsIADecider et /business/prospect/relance côté
// jarvis.js, qui ne programment jamais de date de relance pour eux). Lecture seule, même forme que lister_relances ;
// n'a rien à voir avec les mails, donc aucune donnée Zoho ici.
export async function listerAContacterAutrement() {
  const { prospects } = await atlas('GET', '/business');
  const carteMetierVille = await metierVilleParNom().catch(() => new Map());
  return prospects
    .filter((p) => !p.email && !p.contacteAutrementLe && !EXCLUS_RELANCE.includes(p.etape))
    .map((p) => {
      const mv = (p.metier || p.ville) ? { metier: p.metier || null, ville: p.ville || null } : (carteMetierVille.get(seoNorm(p.nom)) || { metier: null, ville: null });
      return { id: p.id, nom: p.nom, metier: mv.metier, ville: mv.ville, site: p.site || null, telephone: p.telephone || null, statut: p.etape };
    });
}

// Liste tous les prospects Business (filtrable par statut), pour retrouver un id à partir d'un nom/email sans passer par
// lister_relances (qui ne montre que les relances dues) ni lister_a_contacter_autrement (qui ne montre que ceux sans email).
export async function listerBusiness(statut) {
  const { prospects } = await atlas('GET', '/business');
  const carteMetierVille = await metierVilleParNom().catch(() => new Map());
  return prospects
    .filter((p) => !statut || p.etape === statut)
    .map((p) => {
      const mv = (p.metier || p.ville) ? { metier: p.metier || null, ville: p.ville || null } : (carteMetierVille.get(seoNorm(p.nom)) || { metier: null, ville: null });
      return {
        id: p.id, nom: p.nom, metier: mv.metier, ville: mv.ville, email: p.email || null, site: p.site || null,
        telephone: p.telephone || null, statut: p.etape, date_premier_mail: p.date_premier_mail || null, date_relance_prevue: p.relance || null,
      };
    });
}

// Marque un lot de prospects comme "premier mail déjà envoyé" (ex. envoi groupé fait à la main hors du cycle normal) :
// statut -> "contact", date du premier mail enregistrée, prochaine relance posée selon la règle du jour fixe. Passe par
// la même route que jarvis.js (/business/prospect/contacte), identifiée par id OU par email selon ce qui est fourni.
export async function marquerContacte(identifiants, dateEnvoi) {
  if (!Array.isArray(identifiants) || !identifiants.length) throw new Error('Liste d\'identifiants vide (emails ou ids).');
  if (dateEnvoi !== undefined && !dateOk(dateEnvoi)) throw new Error('date_envoi invalide (format attendu : AAAA-MM-JJ).');

  const resultats = [];
  for (const brut of identifiants) {
    const ident = String(brut).trim();
    const corps = ident.includes('@') ? { email: ident, date_envoi: dateEnvoi } : { id: ident, date_envoi: dateEnvoi };
    try {
      const r = await atlas('POST', '/business/prospect/contacte', { corps });
      resultats.push({ identifiant: ident, ok: true, id: r.id, prochaine_relance: r.relance });
    } catch (e) {
      resultats.push({ identifiant: ident, ok: false, erreur: e.message });
    }
  }
  return resultats;
}
