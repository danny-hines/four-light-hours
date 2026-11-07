// Frame-cost probe: for each journey time, times the first (cold) frame after a seek, then a warm frame, then
// plays in real time for a few seconds. Cold-frame cost exposes shader compiles / texture uploads that would
// hitch real playback.
// Usage: node tools/checks/perf_probe.mjs [--page dev.html] [--t 30,64,120] [--seconds 3] [--w 1600 --h 900]
//        [--sequential]   play straight through the film instead of seeking (reports every hitch > 50 ms)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5178;
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const W = Number(arg('w', 1600)), H = Number(arg('h', 900));
const pageFile = arg('page', 'dev.html');
const seconds = Number(arg('seconds', 3));
const times = String(arg('t', '30,64,120,136,200,216,264,296,312,360,392,424')).split(',').map(Number);
const sequential = !!arg('sequential', false);
const extraQ = arg('q', '');

async function up() {
  try {
    return (await fetch(`http://localhost:${PORT}/package.json`)).ok;
  } catch {
    return false;
  }
}
if (!(await up())) {
  spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(PORT)], { cwd: root, detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 100));
}
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((c) => fs.existsSync(c));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'perf-chrome-')),
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${W},${H}`],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => (m.type() === 'error' || m.text().startsWith('[perf]') || m.text().startsWith('[app]')) && errs.push(m.text()));
const t0 = Date.now();
const file = pageFile.startsWith('file:') ? pageFile : `http://localhost:${PORT}/${pageFile}`;
await page.goto(`${file}?capture=1&hud=1${extraQ ? '&' + extraQ : ''}`, { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction('window.__app && (window.__app.isReady === true || window.__app.failed)', { timeout: 600000, polling: 100 });
console.log(`ready in ${Date.now() - t0} ms`);

const frameCost = () =>
  page.evaluate(async () => {
    const gl = window.__app.renderer?.getContext?.();
    const a = performance.now();
    await window.__app.renderFrame();
    if (gl) gl.finish();
    return performance.now() - a;
  });

if (sequential) {
  const r = await page.evaluate(async (dur) => {
    const app = window.__app;
    app.seek(0);
    const hitches = [];
    const all = [];
    let t = 0;
    const end = dur ?? app.director.duration;
    while (t < end) {
      const a = performance.now();
      app.t = t;
      await app.renderFrame();
      const ms = performance.now() - a;
      all.push(ms);
      if (ms > 50) hitches.push([+t.toFixed(2), Math.round(ms)]);
      t += 1 / 30;
    }
    const s = [...all].sort((x, y) => x - y);
    return { frames: all.length, medianMs: +s[s.length >> 1].toFixed(1), p95Ms: +s[Math.floor(s.length * 0.95)].toFixed(1), hitches };
  }, arg('dur') ? Number(arg('dur')) : null);
  console.log(JSON.stringify(r));
} else {
  for (const t of times) {
    await page.evaluate((t) => window.__app.seek(t), t);
    const cold = await frameCost();
    const warm = await frameCost();
    const p = await page.evaluate(async (t, s) => window.__app.perfTest({ t, seconds: s }), t, seconds);
    console.log(`t=${t}  cold ${cold.toFixed(0)} ms  warm ${warm.toFixed(1)} ms  play avg ${p.avgMs} p95 ${p.p95Ms} max ${p.maxMs} (${p.frames} frames)`);
  }
}
if (errs.length) console.log('errors:', errs.slice(0, 10).join('\n'));
await browser.close();
