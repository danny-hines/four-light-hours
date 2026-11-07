// dev: dump ANGLE's translated HLSL for a program kind (radiance|moon|transmit) -> dev/hlsl/<kind>.{vs,ps}.hlsl
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
const kinds = (process.argv[2] || 'radiance').split(',');
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--enable-privileged-webgl-extensions'] });
const page = await browser.newPage();
await page.goto('http://localhost:5178/src/bodies/earth/dev/compile.html', { waitUntil: 'load' });
await page.waitForFunction('window.ready === true', { timeout: 60000 });
await page.evaluate(() => (window.WANT_HLSL = true));
fs.mkdirSync('src/bodies/earth/dev/hlsl', { recursive: true });
for (const k of kinds) {
  const r = await page.evaluate((k) => window.measure(k), k);
  if (!r.hlsl) { console.log(k, 'no hlsl', r.err); continue; }
  r.hlsl.forEach(([glsl, src], i) => { fs.writeFileSync(`src/bodies/earth/dev/hlsl/${k}.${i}.glsl`, glsl); fs.writeFileSync(`src/bodies/earth/dev/hlsl/${k}.${i}.hlsl`, src); });
  console.log(k, r.ms, 'ms', r.hlsl.map((s) => s[1].length));
}
await browser.close();
