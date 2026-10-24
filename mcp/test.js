#!/usr/bin/env node
// Test du serveur MCP : lance server.js comme un vrai client MCP le ferait (stdio), vérifie qu'il expose
// exactement les 3 outils attendus, puis exerce les lectures (lister_prospects, voir_prospect).
// marquer_prospect modifie de vraies données (business.json via Atlas) : il n'est appelé que si on le demande
// explicitement avec --marquer <id> <bon|pas_bon> [motif], jamais par défaut.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const ATTENDUS = ['lister_prospects', 'voir_prospect', 'marquer_prospect', 'lire_site', 'creer_brouillon', 'lister_relances', 'marquer_relance', 'creer_relance', 'lister_a_contacter_autrement', 'lister_business', 'marquer_contacte'];

function argMarquer(argv) {
  const i = argv.indexOf('--marquer');
  if (i === -1) return null;
  const [id, verdict, ...reste] = argv.slice(i + 1);
  if (!id || !['bon', 'pas_bon'].includes(verdict)) throw new Error('Usage : --marquer <id> <bon|pas_bon> [motif]');
  return { id, verdict, motif: reste.join(' ') || undefined };
}

function texteDe(resultat) {
  return (resultat.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

async function main() {
  const marquer = argMarquer(process.argv.slice(2));

  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ICI, 'server.js')], stderr: 'pipe' });
  const client = new Client({ name: 'atlas-prospects-mcp-test', version: '1.0.0' });
  // Le serveur logue sur stderr (jamais sur stdout, réservé au protocole MCP) : on le relaie tel quel, préfixé, pour la visibilité du test.
  transport.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));

  try {
    await client.connect(transport);
    await corps(client, marquer);
  } finally {
    await client.close().catch(() => {});
  }
}

async function corps(client, marquer) {
  console.log('Connecté au serveur MCP.\n');

  const { tools } = await client.listTools();
  const noms = tools.map((t) => t.name).sort();
  console.log('Outils exposés :', noms.join(', '));
  const manquants = ATTENDUS.filter((n) => !noms.includes(n));
  const enTrop = noms.filter((n) => !ATTENDUS.includes(n));
  if (manquants.length || enTrop.length) throw new Error(`Outils inattendus — manquants : ${manquants.join(', ') || 'aucun'} ; en trop : ${enTrop.join(', ') || 'aucun'}`);
  console.log(`✔ Exactement les ${ATTENDUS.length} outils attendus.\n`);

  console.log('--- lister_prospects (sans filtre) ---');
  const r1 = await client.callTool({ name: 'lister_prospects', arguments: {} });
  if (r1.isError) throw new Error('lister_prospects a échoué : ' + texteDe(r1));
  const prospects = JSON.parse(texteDe(r1));
  console.log(`✔ ${prospects.length} prospect(s) reçu(s).`);

  if (prospects.length) {
    const id = prospects[0].id;
    console.log(`\n--- voir_prospect (id=${id}) ---`);
    const r2 = await client.callTool({ name: 'voir_prospect', arguments: { id } });
    if (r2.isError) throw new Error('voir_prospect a échoué : ' + texteDe(r2));
    console.log(texteDe(r2));

    const avecSite = prospects.find((p) => p.site);
    if (avecSite) {
      console.log(`\n--- lire_site (id=${avecSite.id}, site=${avecSite.site}) ---`);
      const r5 = await client.callTool({ name: 'lire_site', arguments: { id: avecSite.id } });
      if (r5.isError) console.log('(lire_site a échoué, probablement un site injoignable — pas bloquant) : ' + texteDe(r5));
      else console.log(texteDe(r5).slice(0, 500) + '\n[…aperçu tronqué pour le test…]');
    } else {
      console.log('\n(aucun prospect avec un site : lire_site non testé)');
    }
  } else {
    console.log('(aucun prospect : voir_prospect / lire_site non testés — lance une recherche depuis Atlas pour en avoir)');
  }

  console.log('\n--- lister_prospects (filtré statut=a_trier) ---');
  const r3 = await client.callTool({ name: 'lister_prospects', arguments: { statut: 'a_trier' } });
  if (r3.isError) throw new Error('lister_prospects (filtré) a échoué : ' + texteDe(r3));
  console.log(`✔ ${JSON.parse(texteDe(r3)).length} prospect(s) à trier.`);

  if (marquer) {
    console.log(`\n--- marquer_prospect (id=${marquer.id}, verdict=${marquer.verdict}) ---`);
    const r4 = await client.callTool({ name: 'marquer_prospect', arguments: marquer });
    if (r4.isError) throw new Error('marquer_prospect a échoué : ' + texteDe(r4));
    console.log(texteDe(r4));
  } else {
    console.log('\n(marquer_prospect non appelé par défaut — relance avec --marquer <id> <bon|pas_bon> pour le tester)');
  }

  console.log('\n(creer_brouillon non appelé par défaut : il crée un vrai brouillon dans Zoho Mail — déjà validé manuellement)');

  console.log('\n--- lister_relances ---');
  const r6 = await client.callTool({ name: 'lister_relances', arguments: {} });
  if (r6.isError) throw new Error('lister_relances a échoué : ' + texteDe(r6));
  const relances = JSON.parse(texteDe(r6));
  console.log(`✔ ${relances.length} relance(s) due(s).`);
  if (relances.length) console.log(JSON.stringify(relances[0], null, 2));

  console.log('\n(marquer_relance / creer_relance non appelés par défaut — déjà validés manuellement)');

  console.log('\n--- lister_a_contacter_autrement ---');
  const r7 = await client.callTool({ name: 'lister_a_contacter_autrement', arguments: {} });
  if (r7.isError) throw new Error('lister_a_contacter_autrement a échoué : ' + texteDe(r7));
  const autrement = JSON.parse(texteDe(r7));
  console.log(`✔ ${autrement.length} prospect(s) à contacter autrement.`);
  if (autrement.length) console.log(JSON.stringify(autrement[0], null, 2));

  console.log('\n--- lister_business (sans filtre) ---');
  const r8 = await client.callTool({ name: 'lister_business', arguments: {} });
  if (r8.isError) throw new Error('lister_business a échoué : ' + texteDe(r8));
  const tous = JSON.parse(texteDe(r8));
  console.log(`✔ ${tous.length} prospect(s) Business au total.`);

  console.log('\n--- lister_business (filtré statut=contact) ---');
  const r9 = await client.callTool({ name: 'lister_business', arguments: { statut: 'contact' } });
  if (r9.isError) throw new Error('lister_business (filtré) a échoué : ' + texteDe(r9));
  console.log(`✔ ${JSON.parse(texteDe(r9)).length} prospect(s) au statut contact.`);

  console.log('\n(marquer_contacte non appelé par défaut : il modifie de vraies données — déjà validé manuellement)');

  console.log('\n✔ Test terminé.');
}

main().catch((e) => { console.error('\n✘ Échec :', e.message); process.exitCode = 1; });
