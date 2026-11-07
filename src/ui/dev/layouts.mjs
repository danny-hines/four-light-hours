// Dev: which placement each title card / caption chose, with the candidate cost table.
//   node src/ui/dev/layouts.mjs [--w 1600 --h 900] [--all]
import puppeteer from 'puppeteer-core';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const W = +arg('w', 1600), H = +arg('h', 900);
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', defaultViewport: { width: W, height: H }, args: ['--use-angle=d3d11'] });
const page = await browser.newPage();
await page.goto('http://localhost:5178/dev.html?capture=1&hud=1&only=hud,director', { waitUntil: 'load' });
await page.waitForFunction('window.__app && window.__app.isReady', { timeout: 120000 });
const r = await page.evaluate(async () => {
  const d = window.__app.director;
  const times = [];
  for (const b of window.__hud.beats.cards) times.push(b[2] + 2);
  for (const c of d.captions || []) if (c.kind === 'note') times.push((c.t0 + c.t1) / 2);
  for (const t of times) { window.__app.seek(t); await window.__app.renderFrame(); }
  return { layout: window.__hud.layout, beats: window.__hud.beats };
});
for (const [k, v] of Object.entries(r.layout)) {
  console.log(`${k.slice(0, 40).padEnd(40)} -> ${v.spec.padEnd(7)} cost ${v.cost}`);
  if (process.argv.includes('--all')) console.log('     ' + v.table.map((x) => `${x[0]}:${x[1]}`).join('  '));
}
console.log('arrivals', JSON.stringify(r.beats.arrivals));
await browser.close();
