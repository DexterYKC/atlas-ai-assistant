// Candidatures (section Emploi d'Atlas) : marquer une offre « postulée » (date réelle d'envoi, PAS la date de
// rédaction du brouillon — il rédige souvent plusieurs jours avant d'envoyer lui-même), marquer une réponse reçue, et
// lister/relancer celles restées sans réponse après le délai configuré (config.json > emploi.relance_jours, jours OUVRÉS).
// Toutes les données passent par l'API locale d'Atlas (routes déjà existantes dans jarvis.js) — jamais d'écriture
// directe dans state.json, pour ne jamais entrer en conflit avec le processus jarvis.js qui l'écrit en continu.
import { atlas } from './atlas.js';

const dateOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !isNaN(new Date(`${v}T12:00:00`));

export async function listerCandidaturesARelancer() {
  const { offres, a_relancer } = await atlas('GET', '/api/emploi');
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const dus = offres.filter((o) => o.statut === 'postulee' && !o.reponse_le && o.relance_le && o.relance_le <= aujourdhui);
  return {
    total: a_relancer,
    candidatures: dus.map((o) => ({
      id: o.id, titre: o.titre, societe: o.societe, url: o.url,
      postulee_le: new Date(o.postule_le).toISOString().slice(0, 10),
      relance_prevue: o.relance_le, nb_relances_deja_faites: o.nb_relances || 0,
    })),
  };
}

// id = celui de l'OFFRE (section Emploi), pas du prospect Business — un autre champ, une autre liste.
export async function marquerCandidatureEnvoyee(id, dateEnvoi) {
  if (dateEnvoi !== undefined && !dateOk(dateEnvoi)) throw new Error('date_envoi invalide (format attendu : AAAA-MM-JJ).');
  // La route ne prend pas de date explicite (elle enregistre "maintenant") : si une date passée est donnée, on la pose
  // nous-mêmes après coup pour rester fidèle à "le mail est parti tel jour", pas au moment où on appelle l'outil.
  await atlas('POST', '/api/emploi/statut', { corps: { id, statut: 'postulee' } });
  if (dateEnvoi) await atlas('POST', '/api/emploi/candidature/date', { corps: { id, date: dateEnvoi } });
  return { ok: true, message: `Offre ${id} marquée postulée${dateEnvoi ? ` (envoyée le ${dateEnvoi})` : " (aujourd'hui)"}. Relance automatique programmée si pas de réponse.` };
}

export async function marquerCandidatureReponse(id) {
  const r = await atlas('POST', '/api/emploi/candidature/reponse', { corps: { id } });
  return { ok: true, message: `Réponse enregistrée pour l'offre ${id} : plus de relance automatique.`, ...r };
}

export async function marquerCandidatureRelancee(id) {
  const r = await atlas('POST', '/api/emploi/candidature/relance', { corps: { id } });
  return r.fini
    ? { ok: true, message: `Relance enregistrée pour l'offre ${id} : limite atteinte, plus de relance automatique après celle-ci.` }
    : { ok: true, message: `Relance enregistrée pour l'offre ${id} : prochaine relance le ${r.relance}.` };
}
