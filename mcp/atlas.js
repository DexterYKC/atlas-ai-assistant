// Petit client HTTP vers l'API locale d'Atlas (127.0.0.1:8765), partagé par tous les outils du serveur MCP qui ont besoin
// de lire ou écrire des données d'Atlas (prospects Agents IA, prospects Business...). Jamais d'écriture directe dans les
// fichiers JSON d'Atlas : tout passe par cette API, pour ne jamais entrer en conflit avec jarvis.js qui les écrit en continu.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const RACINE_PROJET = path.join(ICI, '..');

const log = (...a) => console.error('[atlas-prospects-mcp]', ...a);

function lireConfig() {
  try { return JSON.parse(readFileSync(path.join(RACINE_PROJET, 'config.json'), 'utf8')); }
  catch (e) { log('Impossible de lire config.json :', e.message); return {}; }
}
const cfg = lireConfig();
export const BASE_URL = process.env.ATLAS_BASE_URL || `http://127.0.0.1:${cfg.voice_port || 8765}`;
const TOKEN = process.env.ATLAS_TOKEN || cfg.voice_token || '';
if (!TOKEN) log("Attention : aucun jeton trouvé (config.json > voice_token, ou variable d'environnement ATLAS_TOKEN). Les appels à Atlas échoueront.");

export async function atlas(methode, chemin, { params, corps } = {}) {
  const url = new URL(chemin, BASE_URL);
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, v);
  const options = {
    method: methode,
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(8000),
  };
  if (corps !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(corps); }
  let res;
  try { res = await fetch(url, options); }
  catch (e) { throw new Error(`Atlas est injoignable sur ${BASE_URL} (${e.message}). Le programme Jarvis tourne-t-il ?`); }
  if (res.status === 401) throw new Error("Jeton refusé par Atlas (config.json > voice_token a peut-être changé).");
  let j;
  try { j = await res.json(); } catch { throw new Error(`Réponse illisible d'Atlas (HTTP ${res.status}).`); }
  if (!res.ok || j.ok === false) throw new Error(j.message || `Atlas a refusé la requête (HTTP ${res.status}).`);
  return j;
}
