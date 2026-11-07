// Pixel-truth scan of the whole film (the real renderer, small frames): for every sample, the fraction of the frame
// brighter than the star level and the mean luminance; reports empty / black windows (> 1.5 s with < 0.5 % of the
// frame above the star level, outside fades) and blown frames.
//   node src/journey/dev/lumscan.mjs [--q "epoch=..."] [--step 0.5] [--from 0 --to 431] [--w 256 --h 144]
// Writes notes/director-lumscan-<epoch>.txt.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PORT = 5178;
const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const extraQ = arg('--q', '');
const step = Number(arg('--step', 0.5)), from = Number(arg('--from', 0)), to = Number(arg('--to', 1e9));
const W = Number(arg('--w', 256)), H = Number(arg('--h', 144));
async function up() {
  try {
    return (await fetch(`http://localhost:${PORT}/package.json`)).ok;
  } catch {
    return false;
  }
}
if (!(await up())) {
  const c = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(PORT)], { cwd: root, detached: true, stdio: 'ignore' });
  c.unref();
  for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 100));
}
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'lumscan-'));
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', protocolTimeout: 0, userDataDir: udd, defaultViewport: { width: W, height: H }, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', `--window-size=${W},${H}`] });
const lines = [];
try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/dev.html?capture=1&hud=0${extraQ ? '&' + extraQ : ''}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__app && (window.__app.isReady === true || window.__app.failed)', { timeout: 300000, polling: 200 });
  const dur = await page.evaluate('window.__app.director.duration');
  const t1 = Math.min(to, dur);
  const res = await page.evaluate(
    async (from, t1, step) => {
      const app = window.__app;
      const cv = document.getElementById('view');
      const c2 = document.createElement('canvas');
      const out = [];
      for (let t = from; t <= t1 + 1e-9; t += step) {
        app.seek(t);
        await app.renderFrame();
        c2.width = 64;
        c2.height = 36;
        const g = c2.getContext('2d', { willReadFrequently: true });
        g.drawImage(cv, 0, 0, 64, 36);
        const d = g.getImageData(0, 0, 64, 36).data;
        let lit = 0, sum = 0, blown = 0;
        for (let i = 0; i < d.length; i += 4) {
          const y = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
          sum += y;
          if (y > 0.09) lit++;
          if (y > 0.97) blown++;
        }
        const n = d.length / 4;
        const s = app.director.evaluate(t);
        out.push({ t: +t.toFixed(2), lit: lit / n, mean: sum / n, blown: blown / n, fade: s.fade, warp: s.warp, ch: s.chapter });
      }
      return out;
    },
    from,
    t1,
    step
  );
  const dead = [];
  let run = null;
  for (const r of res) {
    const isDead = r.lit < 0.005 && r.fade < 0.5 && r.t > 13;
    if (isDead) run ? (run.t1 = r.t) : (run = { t0: r.t, t1: r.t });
    else if (run) {
      if (run.t1 - run.t0 >= 1.5) dead.push(run);
      run = null;
    }
  }
  if (run && run.t1 - run.t0 >= 1.5) dead.push(run);
  lines.push(`# lumscan ${extraQ || 'default epoch'}  step ${step}s  (lit = fraction of a 64x36 downsample above display 0.09)`);
  lines.push(`empty windows (>= 1.5 s, < 0.5% lit, no fade): ${dead.length ? dead.map((d) => `${d.t0}-${d.t1}`).join('  ') : 'none'}  total ${dead.reduce((a, d) => a + d.t1 - d.t0, 0).toFixed(1)} s`);
  lines.push(`frames > 40% blown: ${res.filter((r) => r.blown > 0.4).map((r) => r.t).join(' ') || 'none'}`);
  for (const r of res) lines.push(`${r.t.toFixed(1).padStart(6)} ${r.ch.padEnd(9)} lit ${(r.lit * 100).toFixed(1).padStart(5)}%  mean ${r.mean.toFixed(3)}  blown ${(r.blown * 100).toFixed(1)}%  warp ${r.warp.toFixed(2)}  fade ${r.fade.toFixed(2)}`);
  const tag = (extraQ.match(/epoch=([0-9-]+)/) || [, '2026-11-02'])[1];
  const f = path.join(root, 'notes', `director-lumscan-${tag}.txt`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  console.log(lines.slice(0, 3).join('\n'));
  console.log('wrote', f);
} finally {
  await browser.close();
  try {
    fs.rmSync(udd, { recursive: true, force: true });
  } catch {}
}
