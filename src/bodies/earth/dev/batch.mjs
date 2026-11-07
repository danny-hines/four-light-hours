// dev: render many views in ONE browser (much faster than one tools/shot.mjs process per view).
// usage: node src/bodies/earth/dev/batch.mjs <listfile>   (each line: <out.png> <query>; '#' comments)
//        node src/bodies/earth/dev/batch.mjs - "out.png|query" "out2.png|query2" ...
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
let jobs = [];
const W = Number(process.env.W || 1600), H = Number(process.env.H || 900);
if (args[0] === '-') jobs = args.slice(1).map((s) => s.split('|'));
else jobs = fs.readFileSync(args[0], 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).map((l) => { const i = l.indexOf(' '); return [l.slice(0, i), l.slice(i + 1).trim()]; });
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', `--window-size=${W},${H}`],
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warn' || t === 'warning') logs.push(`[${t}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
for (const [out, q] of jobs) {
  const t0 = Date.now();
  logs.length = 0;
  await page.goto(`http://localhost:5178/dev.html?capture=1&hud=0&${q}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__app && (window.__app.isReady === true || window.__app.failed)', { timeout: 180000, polling: 100 });
  const st = await page.evaluate(async () => { await window.__app.renderFrame(); return { f: window.__app.failures }; });
  const buf = await page.screenshot({ type: 'png' });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, buf);
  console.log(`${out}  ${Date.now() - t0} ms ${st.f && st.f.length ? 'FAIL ' + JSON.stringify(st.f) : ''}`);
  for (const l of logs) {
    if (/GPU stall|WEBGL_debug/.test(l)) continue;
    console.log('   ', l.split('\n').filter((x) => !x.startsWith('WARNING')).join('\n').slice(0, 1200));
  }
}
await browser.close();
