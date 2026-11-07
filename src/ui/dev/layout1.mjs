// Dev: the layout table for the card/caption visible at given times, each in a fresh page.  node src/ui/dev/layout1.mjs 105.5,108 [query]
import puppeteer from 'puppeteer-core';
const times = (process.argv[2] || '108').split(',').map(Number);
const q = process.argv[3] || '';
const W = +(process.env.W || 1600), H = +(process.env.H || 900);
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', defaultViewport: { width: W, height: H }, args: ['--use-angle=d3d11'] });
for (const t of times) {
  const page = await browser.newPage();
  await page.goto(`http://localhost:5178/dev.html?capture=1&hud=1&only=hud,director&${q}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__app && window.__app.isReady', { timeout: 120000 });
  const r = await page.evaluate(async (t) => { window.__app.seek(t); await window.__app.renderFrame(); return window.__hud.layout; }, t);
  for (const [k, v] of Object.entries(r || {})) console.log(t, k.slice(0, 30), '->', v.spec, v.cost, '\n   ', v.table.map((x) => `${x[0]}:${x[1]}`).join('  '));
  await page.close();
}
await browser.close();
