// HUD self-check (dev only): fonts, per-frame HUD cost, layout overflow and overlaps between HUD boxes.
//   node src/ui/dev/check.mjs [--page src/ui/dev/harness.html] [--w 1600 --h 900] [--q "only=hud"]
// Assumes the dev server on :5178 is running (tools/shot.mjs starts it).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const W = +arg('w', 1600), H = +arg('h', 900);
const page0 = arg('page', 'src/ui/dev/harness.html');
const q = arg('q', '');
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', protocolTimeout: 900000, defaultViewport: { width: W, height: H }, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`http://localhost:5178/${page0}?capture=1&hud=1&controls=1&${q}`, { waitUntil: 'load' });
await page.waitForFunction('window.__app && window.__app.isReady', { timeout: 120000 });
const res = await page.evaluate(async () => {
  const app = window.__app;
  const out = { fonts: window.__hud.fonts, frames: [], maxMs: 0, overlaps: [], overflow: [] };
  const fontsReady = [...document.fonts].filter((f) => f.family.startsWith('FLH')).map((f) => `${f.family}:${f.status}`);
  out.fontFaces = fontsReady;
  const boxes = (sel) => {
    const e = document.querySelector(sel);
    if (!e || e.hidden || e.offsetParent === null) return null;
    const op = +getComputedStyle(e).opacity;
    if (op < 0.05) return null;
    const rg = document.createRange();
    const tw = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (!n.textContent.trim() || n.parentElement.closest('[hidden]')) continue;
      rg.selectNodeContents(n);
      const b = rg.getBoundingClientRect();
      if (!b.width) continue;
      x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top); x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom);
    }
    return x1 > x0 ? { sel, x: x0, y: y0, r: x1, b: y1 } : null;
  };
  const D = app.director.duration;
  let ms = [];
  for (let t = 0; t <= D; t += D / 60) {
    app.seek(t);
    await app.renderFrame();
    ms.push(window.__hud.ms);
    out.frames.push([+t.toFixed(1), window.__hud.ms]);
    const bs = ['#flh-hud .flh-card', '#flh-hud .flh-caption', '#flh-hud .flh-open', '#flh-hud .flh-end', '#flh-hud .flh-tele', '#flh-hud .flh-row', '#flh-hud .flh-chap'].map(boxes).filter(Boolean);
    for (let i = 0; i < bs.length; i++)
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], b = bs[j];
        if (a.x < b.r && a.r > b.x && a.y < b.b && a.b > b.y) out.overlaps.push(`t=${t.toFixed(1)} ${a.sel} x ${b.sel}`);
      }
    for (const b of bs) if (b.x < -1 || b.y < -1 || b.r > innerWidth + 1 || b.b > innerHeight + 1) out.overflow.push(`t=${t.toFixed(1)} ${b.sel} ${JSON.stringify([b.x | 0, b.y | 0, b.r | 0, b.b | 0])}`);
  }
  ms.sort((a, b) => a - b);
  out.frames = out.frames.sort((a, b) => b[1] - a[1]).slice(0, 5);
  out.hudMs = { median: ms[ms.length >> 1], p95: ms[Math.floor(ms.length * 0.95)], max: ms[ms.length - 1] };
  out.scroll = [document.documentElement.scrollWidth, document.documentElement.scrollHeight, innerWidth, innerHeight];
  return out;
});
console.log(JSON.stringify({ ...res, errors }, null, 1));
await browser.close();
