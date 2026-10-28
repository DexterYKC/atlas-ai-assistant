// Lecture SEULE de l'emploi du temps d'un portail tiers (identité volontairement omise : n'importe quel portail avec
// connexion email/mot de passe et sans API publique), via un navigateur Edge headless dédié (profil vide, jamais le
// profil perso de l'utilisateur) : la page est une SPA (rien en HTML brut sans JS), donc impossible à lire avec un
// simple fetch. On se connecte avec les identifiants fournis, puis on relit la grille "Emploi du temps" semaine par
// semaine (le site accepte une date dans l'URL de la vue semaine).
const BASE = process.env.FAC_BASE_URL || 'https://exemple-portail.invalid/espace';

function lundiDe(d) {
  const x = new Date(d);
  const j = (x.getDay() + 6) % 7; // lundi = 0
  x.setDate(x.getDate() - j);
  return x;
}
function iso(d) { return d.toISOString().slice(0, 10); }

// Retourne la liste des cours trouvés sur `nbSemaines` semaines à partir de celle en cours, dédupliqués par id.
// Chaque cours : { id, date (AAAA-MM-JJ), debut (HH:MM), fin (HH:MM), titre, enseignant }.
async function recupererSemaines(email, motdepasse, nbSemaines = 4) {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });

    if (await page.$('input[type="password"]')) {
      await page.fill('input[type="email"]', email);
      await page.fill('input[type="password"]', motdepasse);
      await page.click('button:has-text("Se connecter")');
      await page.waitForTimeout(2000);
      await page.waitForLoadState('networkidle').catch(() => {});
    }
    if (await page.$('input[type="password"]')) throw new Error('connexion refusée (identifiants invalides ?)');

    const lundi = lundiDe(new Date());
    const cours = [];
    for (let i = 0; i < nbSemaines; i++) {
      const d = new Date(lundi);
      d.setDate(d.getDate() + i * 7);
      await page.goto(`${BASE}#emploi-du-temps?vue=semaine&date=${iso(d)}`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1200);
      const lignes = await page.$$eval('.cal-col[data-date]', (cols) => cols.flatMap((col) => {
        const date = col.getAttribute('data-date');
        return [...col.querySelectorAll('.cal-event')].map((ev) => {
          const temps = ev.querySelectorAll('time');
          const titreEl = ev.querySelector('.cal-event__title');
          const metaEl = ev.querySelector('.cal-event__meta');
          return {
            id: ev.getAttribute('data-id') || '',
            date,
            debut: temps[0] ? temps[0].textContent.trim() : '',
            fin: temps[1] ? temps[1].textContent.trim() : '',
            titre: titreEl ? titreEl.textContent.trim() : '',
            enseignant: metaEl ? metaEl.textContent.trim() : '',
          };
        });
      }));
      cours.push(...lignes);
    }
    const vus = new Set();
    return cours.filter((c) => c.id && c.date && c.debut && !vus.has(c.id) && vus.add(c.id));
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { recupererSemaines };
