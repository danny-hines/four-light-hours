// Dump ANGLE-translated HLSL of every program on a page (fresh profile), for offline FXC timing.
// usage: node hlsl.mjs "<query>" <outdir>
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const q = process.argv[2] || 'view=body&body=jupiter&dist=3.5&only=jupiter';
const out = process.argv[3] || 'hlsl_out';
fs.mkdirSync(out, { recursive: true });
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await puppeteer.launch({
  executablePath: chrome, headless: 'new',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hlsl-chrome-')),
  defaultViewport: { width: 800, height: 450 },
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--enable-privileged-webgl-extensions'],
});
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => { WebGL2RenderingContext.prototype.deleteShader = function () {}; });
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.text().slice(0, 400)); });
await page.goto(`http://localhost:5178/dev.html?capture=1&hud=0&${q}`, { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction('window.__app && (window.__app.isReady === true || window.__app.failed)', { timeout: 600000, polling: 100 });
const res = await page.evaluate(async () => {
  const app = window.__app;
  if (app.warmup) await app.warmup({ report: false, serial: true });
  const r = app.renderer;
  const gl = r.getContext();
  const ext = gl.getExtension('WEBGL_debug_shaders');
  return r.info.programs.map((p) => {
    const sh = gl.getAttachedShaders(p.program);
    return { name: p.name, cacheKey: String(p.cacheKey).slice(0, 40), vs: ext.getTranslatedShaderSource(sh[0]), fs: ext.getTranslatedShaderSource(sh[1]) };
  });
});
res.forEach((p, i) => {
  fs.writeFileSync(path.join(out, `p${i}_${p.name}_fs.hlsl`), p.fs);
  fs.writeFileSync(path.join(out, `p${i}_${p.name}_vs.hlsl`), p.vs);
  console.log(i, p.name, 'fs', p.fs.length, 'chars', (p.fs.match(/\n/g) || []).length, 'lines');
});
await browser.close();
