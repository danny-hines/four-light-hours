// Opens the built index.html straight from disk (file://) and reports whether the app starts.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const browser = await puppeteer.launch({
  executablePath: [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((c) => fs.existsSync(c)),
  headless: 'new',
  args: [process.platform === 'win32' ? '--use-angle=d3d11' : process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?capture=1', { waitUntil: 'load' });
await page.waitForFunction('window.__app && (window.__app.isReady || window.__app.failed)', { timeout: 120000 });
console.log('ready:', await page.evaluate('window.__app.isReady'), 'failed:', await page.evaluate('window.__app.failed'), 'failures:', JSON.stringify(await page.evaluate('window.__app.failures')));
console.log('errors:', errs.length ? errs : 'none');
await browser.close();
