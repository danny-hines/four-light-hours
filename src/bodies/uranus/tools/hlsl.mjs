// Dev only: dumps ANGLE's translated HLSL of every Uranus fragment shader (WEBGL_debug_shaders) and reports its
// size, so the FXC cost of a change can be predicted without timing noise.
// usage (from the project root): node src/bodies/uranus/tools/hlsl.mjs [outDir] [abl=...]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const outDir = process.argv[2] || 'shots/uranus/w2_dbg/hlsl';
const extra = process.argv[3] || '';
fs.mkdirSync(outDir, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((c) => fs.existsSync(c));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'uhlsl-')),
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--enable-privileged-webgl-extensions'],
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text()); });
await page.goto(`http://localhost:5178/src/bodies/uranus/tools/dump.html?${extra}`, { waitUntil: 'load' });
await page.waitForFunction('window.__app && window.__app.isReady', { timeout: 300000 });
const glsl = await page.evaluate(() => window.__glsl || {});
for (const [id, src] of Object.entries(glsl)) fs.writeFileSync(path.join(outDir, id + '.glsl'), src);
const dump = await page.evaluate(() => window.__hlsl || {});
for (const [id, src] of Object.entries(dump)) {
  fs.writeFileSync(path.join(outDir, id + '.hlsl'), src);
  const lines = src.split('\n').length;
  const loops = (src.match(/\bfor\s*\(|\bwhile\s*\(/g) || []).length;
  const unroll = (src.match(/\[unroll/g) || []).length;
  const loopAttr = (src.match(/\[loop\]/g) || []).length;
  console.log(`${id.padEnd(10)} ${String(src.length).padStart(7)} chars ${String(lines).padStart(5)} lines, loops ${loops} ([loop] ${loopAttr}, [unroll] ${unroll})`);
}
await browser.close();
