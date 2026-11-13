// Deterministic screenshot / filmstrip / perf tool (headless Chrome on the real GPU).
//
// Examples (run from the project root):
//   node tools/shot.mjs --t 30,95,180 --out shots/journey.png            -> shots/journey_t30.png ...
//   node tools/shot.mjs --q "view=body&body=jupiter&dist=3&phase=40" --out shots/jup.png
//   node tools/shot.mjs --t 100:110:1 --sheet shots/strip.png              -> one labeled contact sheet
//   node tools/shot.mjs --perf 6 --t 120                                   -> fps report while playing
//   node tools/shot.mjs --page index.html --t 60 --out shots/built.png    -> test the bundled file
//
// Flags:
//   --page <file>      page relative to project root (default dev.html)
//   --q "<query>"      extra query string (capture=1 is always added)
//   --t <list>         journey times in seconds: "a,b,c" or "start:end:step"
//   --out <png>        output path; with several times, _t<time> is appended (or use {t} in the name)
//   --sheet <png>      also/instead write a labeled contact sheet of all frames
//   --cols <n>         contact sheet columns (default 4)
//   --w/--h            viewport size (default 1600x900)
//   --hud 0|1          show the HUD overlay in shots (default 1)
//   --perf <seconds>   play in real time for N seconds and report frame timings (after seeking to first --t)
//   --wait <ms>        extra settle time per shot (default 0)
//   --keep-open        don't close the browser (debug)
//   --fresh            use a throwaway Chrome profile (no shader cache: cold-start timings)
// Prints console errors/warnings from the page. Exit code 2 if the page threw errors.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5178;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) a[key] = true;
    else {
      a[key] = next;
      i++;
    }
  }
  return a;
}

function parseTimes(s) {
  if (s === undefined || s === true) return [];
  if (String(s).includes(':')) {
    const [a, b, step] = String(s).split(':').map(Number);
    const out = [];
    for (let t = a; t <= b + 1e-9; t += step || 1) out.push(+t.toFixed(3));
    return out;
  }
  return String(s)
    .split(',')
    .filter(Boolean)
    .map(Number);
}

async function serverUp() {
  try {
    const r = await fetch(`http://localhost:${PORT}/package.json`);
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await serverUp()) return;
  const child = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(PORT)], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await serverUp()) return;
  }
  throw new Error('dev server did not start');
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('No Chrome/Edge found; set CHROME_PATH');
}

function outName(base, t, multi) {
  if (!base) return null;
  if (base.includes('{t}')) return base.replace('{t}', String(t));
  if (!multi) return base;
  const ext = path.extname(base) || '.png';
  return base.slice(0, base.length - ext.length) + `_t${t}` + ext;
}

const args = parseArgs(process.argv.slice(2));
const W = Number(args.w || 1600);
const H = Number(args.h || 900);
const times = parseTimes(args.t);
const pageFile = args.page || 'dev.html';
const extraQ = args.q && args.q !== true ? String(args.q) : '';
const hud = args.hud === undefined ? '1' : String(args.hud);
const query = ['capture=1', `hud=${hud}`, extraQ].filter(Boolean).join('&');
const url = `http://localhost:${PORT}/${pageFile}?${query}`;

await ensureServer();

// Chrome profiles are pooled so the GPU shader cache survives between runs: a fresh profile recompiles every
// shader (~40 s for the whole film on D3D11), a warm one starts in ~5 s. Each run takes an unlocked profile;
// --fresh uses a throwaway one (cold timings).
function acquireProfile() {
  const fresh = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-chrome-'));
    return { dir, release: () => fs.rmSync(dir, { recursive: true, force: true }) };
  };
  if (args.fresh) return fresh();
  const base = path.join(os.tmpdir(), 'fourlh-shot-profiles');
  fs.mkdirSync(base, { recursive: true });
  const take = (lock) => {
    const fd = fs.openSync(lock, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  };
  for (let i = 0; i < 32; i++) {
    const dir = path.join(base, 'p' + i);
    const lock = dir + '.lock';
    try {
      take(lock);
    } catch {
      let pid = 0;
      try {
        pid = Number(fs.readFileSync(lock, 'utf8'));
      } catch {}
      let alive = false;
      try {
        if (pid) alive = process.kill(pid, 0);
      } catch {}
      if (alive) continue;
      try {
        fs.rmSync(lock, { force: true });
        take(lock);
      } catch {
        continue;
      }
    }
    return { dir, release: () => fs.rmSync(lock, { force: true }) };
  }
  return fresh();
}

const launchOpts = (userDataDir) => ({
  executablePath: findChrome(),
  headless: 'new',
  userDataDir,
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args: [
    process.platform === 'win32' ? '--use-angle=d3d11' : process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=default',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--disable-gpu-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--window-size=${W},${H}`,
  ],
});
let profile = acquireProfile();
process.on('exit', () => {
  try {
    profile.release();
  } catch {}
});
let browser;
try {
  browser = await puppeteer.launch(launchOpts(profile.dir));
} catch (e) {
  // a pooled profile left damaged by a crashed run: fall back to a throwaway one
  profile.release();
  profile = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'shot-chrome-')), release() {} };
  const dir = profile.dir;
  profile.release = () => fs.rmSync(dir, { recursive: true, force: true });
  browser = await puppeteer.launch(launchOpts(profile.dir));
}

let pageErrors = 0;
const logs = [];
try {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warn' || type === 'warning' || msg.text().startsWith('[app]'))
      logs.push(`[console.${type}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    pageErrors++;
    logs.push(`[pageerror] ${err.message}`);
  });
  page.on('requestfailed', (req) => logs.push(`[requestfailed] ${req.url()} ${req.failure()?.errorText}`));

  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__app && window.__app.isReady === true || window.__app && window.__app.failed', {
    timeout: 180000,
    polling: 100,
  });
  const failed = await page.evaluate('window.__app.failed || null');
  if (failed) throw new Error('app failed to start: ' + failed);
  const gl = await page.evaluate('window.__app.gpuInfo ? window.__app.gpuInfo() : "n/a"');
  console.log(`ready in ${Date.now() - t0} ms  gpu: ${gl}`);

  const shots = [];
  const list = times.length ? times : [null];
  if (!args.perf) {
    for (const t of list) {
      const st = await page.evaluate(
        async (t) => {
          if (t !== null) window.__app.seek(t);
          await window.__app.renderFrame();
          return window.__app.debugState ? window.__app.debugState() : null;
        },
        t
      );
      if (args.wait) await new Promise((r) => setTimeout(r, Number(args.wait)));
      const buf = await page.screenshot({ type: 'png' });
      const label = t === null ? 'frame' : `t=${t}s`;
      shots.push({ t, buf, label, st });
      const out = outName(args.out, t === null ? 0 : t, list.length > 1);
      if (out) {
        fs.mkdirSync(path.dirname(path.resolve(root, out)), { recursive: true });
        fs.writeFileSync(path.resolve(root, out), buf);
        console.log(`wrote ${out}${st ? '  ' + JSON.stringify(st) : ''}`);
      } else if (st) console.log(label, JSON.stringify(st));
    }
  }

  if (args.sheet && shots.length) {
    const cols = Number(args.cols || 4);
    const thumbW = Math.min(800, Math.floor(3200 / cols));
    const thumbH = Math.round((thumbW * H) / W);
    const rows = Math.ceil(shots.length / cols);
    const sheetPage = await browser.newPage();
    await sheetPage.setViewport({ width: cols * thumbW, height: rows * thumbH });
    await sheetPage.setContent('<html><body style="margin:0;background:#000"><canvas id=c></canvas></body></html>');
    await sheetPage.evaluate(
      (cols, tw, th, rows) => {
        const c = document.getElementById('c');
        c.width = cols * tw;
        c.height = rows * th;
      },
      cols,
      thumbW,
      thumbH,
      rows
    );
    // one image per call: a whole film's worth of PNGs in a single CDP message kills the target
    for (let i = 0; i < shots.length; i++) {
      await sheetPage.evaluate(
        async (src, label, i, cols, tw, th) => {
          const g = document.getElementById('c').getContext('2d');
          const im = new Image();
          im.src = src;
          await im.decode();
          const x = (i % cols) * tw,
            y = Math.floor(i / cols) * th;
          g.drawImage(im, x, y, tw, th);
          g.fillStyle = 'rgba(0,0,0,.6)';
          g.fillRect(x, y, 130, 26);
          g.fillStyle = '#fff';
          g.font = '16px monospace';
          g.fillText(label, x + 6, y + 18);
          g.strokeStyle = '#333';
          g.strokeRect(x + 0.5, y + 0.5, tw - 1, th - 1);
        },
        'data:image/png;base64,' + Buffer.from(shots[i].buf).toString('base64'),
        shots[i].label,
        i,
        cols,
        thumbW,
        thumbH
      );
    }
    const dataUrl = await sheetPage.evaluate(() => document.getElementById('c').toDataURL('image/jpeg', 0.9));
    const out = path.resolve(root, args.sheet);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`wrote sheet ${args.sheet} (${shots.length} frames)`);
  }

  if (args.perf) {
    const seconds = Number(args.perf) || 5;
    const r = await page.evaluate(
      async (t, seconds) => window.__app.perfTest({ t, seconds }),
      times.length ? times[0] : null,
      seconds
    );
    console.log('perf', JSON.stringify(r));
  }
} catch (e) {
  logs.push(`[shot.mjs] ${e.stack || e.message}`);
  pageErrors++;
} finally {
  for (const l of logs) console.log(l);
  if (!args['keep-open']) {
    await browser.close();
    try {
      profile.release();
    } catch {}
  }
}
process.exit(pageErrors ? 2 : 0);
