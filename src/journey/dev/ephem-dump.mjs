// Dump the body modules' live moon ephemerides (moons[].positionAt) to a table so the offline analyzer
// (analyze.mjs) builds exactly the film the browser builds. One browser session; samples absolute simDays ranges
// for the given epochs (positionAt is a function of absolute simDays, independent of the page's epoch).
//   node src/journey/dev/ephem-dump.mjs [epochISO ...]
// Writes src/journey/dev/.ephem.json (dev only, not shipped).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PORT = 5178;
const epochs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!epochs.length) epochs.push('2026-11-02T12:00:00Z', '2027-06-15T00:00:00Z', '2031-03-01T00:00:00Z');
const daysOf = (iso) => (new Date(iso).getTime() / 86400000 + 2440587.5) - 2451545.0;

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
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'ephem-chrome-'));
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', userDataDir: udd, defaultViewport: { width: 320, height: 180 }, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/dev.html?capture=1&hud=0`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__app && (window.__app.isReady === true || window.__app.failed)', { timeout: 240000, polling: 200 });
  const ranges = epochs.map((e) => [daysOf(e) - 1, daysOf(e) + 50]);
  const table = await page.evaluate((ranges) => {
    const out = { ranges, moons: {}, radii: {} };
    for (const [pid, b] of Object.entries(window.__app.bodies)) {
      out.radii[pid] = b.radius;
      for (const m of b.moons || []) {
        // period from the sampled motion is unknown here; use a fixed fine step per moon from a quick estimate
        const p0 = m.positionAt(ranges[0][0]).clone(), p1 = m.positionAt(ranges[0][0] + 0.01);
        const w = p1.clone().sub(p0).length() / Math.max(1e-9, p0.length()) / 0.01; // rad/day
        const P = (2 * Math.PI) / Math.max(w, 1e-6);
        const step = Math.min(0.05, P / 400);
        const segs = [];
        for (const [a, bb] of ranges) {
          const n = Math.ceil((bb - a) / step);
          const xs = new Float64Array((n + 1) * 3);
          for (let i = 0; i <= n; i++) {
            const v = m.positionAt(a + i * step);
            xs[i * 3] = v.x;
            xs[i * 3 + 1] = v.y;
            xs[i * 3 + 2] = v.z;
          }
          segs.push({ a, step, n, xs: Array.from(xs, (x) => +x.toPrecision(10)) });
        }
        out.moons[m.id] = { parent: pid, radius: m.radius, name: m.name, segs };
      }
    }
    return out;
  }, ranges);
  const f = path.join(root, 'src', 'journey', 'dev', '.ephem.json');
  fs.writeFileSync(f, JSON.stringify(table));
  console.log('wrote', f, Object.keys(table.moons).length, 'moons', (fs.statSync(f).size / 1e6).toFixed(1), 'MB');
} finally {
  await browser.close();
  try {
    fs.rmSync(udd, { recursive: true, force: true });
  } catch {}
}
