// Shader compile cost per material: compiles every material in the scene one object at a time (forcing it
// visible), blocks on each new program's link status, and reports the slowest programs with their owner.
// Usage: node tools/checks/shader_cost.mjs [--top 30] [--q "only=neptune,post"] [--parallel]
// Default (serial): each object's first draw is timed on its own, which is the per-piece compile budget.
// --parallel: the film's real warm-up (KHR_parallel_shader_compile phase first), i.e. the splash wait.
// (with only=..., the other bodies are cheap placeholders, so the report is that piece's own cost)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5178;
const argv = process.argv.slice(2);
const top = Number(argv[argv.indexOf('--top') + 1]) || 30;
const extraQ = argv.includes('--q') ? argv[argv.indexOf('--q') + 1] : '';
const parallelMode = argv.includes('--parallel');
const idle = argv.includes('--idle') ? Number(argv[argv.indexOf('--idle') + 1]) : 0; // seconds to wait after boot (lets async links finish)
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
const chrome = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((c) => fs.existsSync(c));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'shader-chrome-')),
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
  args: [process.platform === 'win32' ? '--use-angle=d3d11' : process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--window-size=1600,900'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
const t0 = Date.now();
await page.goto(`http://localhost:${PORT}/dev.html?capture=1&hud=1${extraQ ? '&' + extraQ : ''}`, { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction('window.__app && (window.__app.isReady === true || window.__app.failed)', { timeout: 600000, polling: 100 });
console.log(`ready in ${Date.now() - t0} ms`);
console.log('KHR_parallel_shader_compile:', await page.evaluate(() => window.__app.renderer.extensions.has('KHR_parallel_shader_compile')));
if (idle) {
  const done = await page.evaluate(async (idle) => {
    const gl = window.__app.renderer.getContext();
    const progs = window.__app.renderer.info.programs;
    const a = performance.now();
    const ready = () => progs.filter((p) => gl.getProgramParameter(p.program, 0x91b1)).length;
    const log = [];
    while (performance.now() - a < idle * 1000) {
      log.push([Math.round(performance.now() - a), ready(), progs.length]);
      await new Promise((r) => setTimeout(r, 2000));
    }
    return log;
  }, idle);
  console.log('link completion over time [ms, ready, total]:', JSON.stringify(done));
}
const res = await page.evaluate(async (parallelMode) => {
  const r = await window.__app.warmup({ report: true, serial: !parallelMode });
  return { out: r.objects, frames: r.frames, compileMs: r.compileMs, programs: r.programs, total: window.__app.renderer.info.programs.length };
}, parallelMode);
if (parallelMode) console.log(`parallel compile phase: ${res.compileMs} ms wall (programs ${res.programs[0]} -> ${res.programs[1]}); per-object draws below are what remains after it`);
else console.log('serial mode: per-object first-draw cost (the compile budget measure)');
res.out.sort((a, b) => b.ms - a.ms);
const byOwner = {};
for (const r of res.out) {
  const k = r.owner.split(':')[0];
  byOwner[k] = (byOwner[k] || 0) + r.ms;
}
console.log('programs total', res.total, 'objects drawn', res.out.length, 'sum ms', res.out.reduce((a, r) => a + r.ms, 0));
console.log('by owner (ms):', JSON.stringify(byOwner));
for (const r of res.out.slice(0, top)) console.log(String(r.ms).padStart(7), 'ms ', r.owner, '|', r.type, r.name);
const slowFrames = res.frames.filter((f) => f.ms > 40);
console.log('film frames after object warm-up:', res.frames.length, 'sum ms', res.frames.reduce((a, f) => a + f.ms, 0), 'slow (>40 ms):', JSON.stringify(slowFrames));
await browser.close();
