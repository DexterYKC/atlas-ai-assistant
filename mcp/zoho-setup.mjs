// Échange ponctuel du code d'autorisation Zoho (valable 10 minutes) contre un refresh_token durable, à partir de
// mcp/zoho_setup_input.json (client_id, client_secret, code). Le résultat est écrit dans mcp/zoho_config.json
// (client_id, client_secret, refresh_token), relu à chaque appel par l'outil creer_brouillon pour obtenir un
// access_token frais. Le fichier d'entrée est supprimé après usage (le code est de toute façon à usage unique).
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const FICHIER_ENTREE = path.join(ICI, 'zoho_setup_input.json');
const FICHIER_CONFIG = path.join(ICI, 'zoho_config.json');

const { client_id, client_secret, code } = JSON.parse(readFileSync(FICHIER_ENTREE, 'utf8'));

const params = new URLSearchParams({ grant_type: 'authorization_code', client_id, client_secret, code });
const res = await fetch('https://accounts.zoho.com/oauth/v2/token', { method: 'POST', body: params });
const j = await res.json();

if (!j.refresh_token) {
  console.error('Échec de l\'échange :', JSON.stringify(j));
  process.exit(1);
}

writeFileSync(FICHIER_CONFIG, JSON.stringify({ client_id, client_secret, refresh_token: j.refresh_token }, null, 2));
try { rmSync(FICHIER_ENTREE); } catch { /* pas grave */ }
console.error('OK : refresh_token obtenu et enregistré dans mcp/zoho_config.json. access_token (court) :', (j.access_token || '').slice(0, 12) + '…', 'expire dans', j.expires_in, 's.');
