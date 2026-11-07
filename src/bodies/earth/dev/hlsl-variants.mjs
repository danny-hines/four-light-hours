// dev: translate Earth/Moon program variants to HLSL in one browser, then FXC-compile each offline (fxc.py).
// usage: node src/bodies/earth/dev/hlsl-variants.mjs <kinds e.g. radiance,moon> [variants.mjs]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const kinds = (process.argv[2] || 'radiance').split(',').filter((k) => k !== 'none');
let variants = [];
if (process.argv[3]) variants = (await import(pathToFileURL(path.resolve(process.argv[3])).href)).default;
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--enable-privileged-webgl-extensions'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto('http://localhost:5178/src/bodies/earth/dev/compile.html', { waitUntil: 'load' });
await page.waitForFunction('window.ready === true', { timeout: 60000 });
const dir = 'src/bodies/earth/dev/hlsl';
fs.mkdirSync(dir, { recursive: true });
const jobs = kinds.map((k) => ({ name: k, kind: k })).concat(variants);
for (const v of jobs) {
  const src = await page.evaluate((k) => window.SRC[k][1], v.kind);
  const frag = v.frag ? v.frag(src) : src;
  const out = await page.evaluate((k, f) => window.translate(k, f), v.kind, frag);
  const safe = v.name.replace(/[^\w.-]+/g, '_');
  const stages = [];
  out.forEach((o, i) => {
    if (o.log && /ERROR/.test(o.log)) console.log(v.name, 'GLSL', o.log.slice(0, 600));
    const isPS = o.hlsl.includes('@@ PIXEL OUTPUT @@');
    const f = `${dir}/${safe}.${isPS ? 'ps' : 'vs'}.hlsl`;
    fs.writeFileSync(f, o.hlsl);
    stages.push([f, isPS ? 'ps' : 'vs']);
  });
  for (const [f, st] of stages) {
    if (st === 'vs' && !v.vs) continue;
    try { process.stdout.write(execFileSync('python', ['src/bodies/earth/dev/fxc.py', f, st], { encoding: 'utf8' })); } catch (e) { console.log(v.name, 'fxc failed', String(e.stdout || e).slice(0, 800)); }
  }
}
await browser.close();
