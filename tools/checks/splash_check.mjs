// Normal (non-capture) start: splash, loading, GPU warm-up, Begin enabled, then play a few seconds.
// Usage: node tools/checks/splash_check.mjs [--page dev.html|index.html] [--fresh]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5178;
const argv = process.argv.slice(2);
const pageFile = argv.includes('--page') ? argv[argv.indexOf('--page') + 1] : 'dev.html';
async function up() {
  try {
    return (await fetch(`http://localhost:${PORT}/package.json`)).ok;
  } catch {
    return false;
  }
}
if (pageFile === 'dev.html' && !(await up())) {
  spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(PORT)], { cwd: root, detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 100));
}
const url = pageFile === 'dev.html' ? `http://localhost:${PORT}/dev.html` : pathToFileURL(path.join(root, pageFile)).href;
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((c) => fs.existsSync(c));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'splash-chrome-')),
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required', '--window-size=1600,900'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push('console.error ' + m.text());
  if (m.text().startsWith('[app]')) console.log(m.text());
});
const t0 = Date.now();
await page.goto(url, { waitUntil: 'load', timeout: 300000 });
const statuses = [];
let last = '';
while (Date.now() - t0 < 600000) {
  const st = await page.evaluate(() => {
    const s = document.querySelector('.sp-status, [class*="status"]');
    const b = document.querySelector('.sp-begin');
    return { text: s ? s.textContent : '', ready: !!(window.__app && window.__app.isReady), begin: b ? !b.disabled : null };
  });
  const key = st.text.replace(/\d+%/, '');
  if (key !== last) {
    statuses.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${st.text}`);
    last = key;
  }
  if (st.ready && st.begin) break;
  await new Promise((r) => setTimeout(r, 250));
}
console.log('splash timeline:', statuses.join(' | '));
console.log(`ready + Begin enabled after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await page.screenshot({ path: path.join(root, 'shots/lead/splash_ready.png') });
await page.click('.sp-begin').catch((e) => errs.push('click ' + e.message));
await new Promise((r) => setTimeout(r, 6000));
const after = await page.evaluate(() => ({ t: window.__app.t, playing: window.__app.playing }));
console.log('after Begin + 6 s:', JSON.stringify(after));
await page.screenshot({ path: path.join(root, 'shots/lead/after_begin.png') });
console.log(errs.length ? 'errors:\n' + errs.slice(0, 15).join('\n') : 'errors: none');
await browser.close();
