// dev: measure compile time of Earth/Moon program variants in one fresh-profile Chrome.
// usage: node src/bodies/earth/dev/compile-harness.mjs [kinds=radiance,moon,transmit] [reps=1] [variantsFile.mjs]
// A variants file exports default [{ name, kind, frag: (src) => src }] applied to the module source.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const kinds = (process.argv[2] || 'radiance,moon,transmit').split(',');
const reps = Number(process.argv[3] || 1);
let variants = [];
if (process.argv[4]) variants = (await import(pathToFileURL(path.resolve(process.argv[4])).href)).default;
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'earth-compile-')),
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text().slice(0, 600)); });
await page.goto('http://localhost:5178/src/bodies/earth/dev/compile.html', { waitUntil: 'load' });
await page.waitForFunction('window.ready === true', { timeout: 60000 });
// warm the driver with a trivial program
await page.evaluate(() => window.measure('transmit'));
for (const k of kinds.filter((k) => k !== 'none')) for (let r = 0; r < reps; r++) {
  const res = await page.evaluate((k) => window.measure(k), k);
  console.log(`${k.padEnd(10)} ${String(res.ms).padStart(7)} ms${res.err ? ' ERR ' + res.err.slice(0, 400) : ''}`);
}
for (const v of variants) {
  const src = await page.evaluate((k) => window.SRC[k][1], v.kind);
  const frag = v.frag ? v.frag(src) : src;
  const res = await page.evaluate((k, f) => window.measure(k, f), v.kind, frag);
  console.log(`${v.name.padEnd(28)} ${String(res.ms).padStart(7)} ms${res.err ? ' ERR ' + res.err.slice(0, 400) : ''}`);
}
await browser.close();
