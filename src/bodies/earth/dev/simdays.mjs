// dev: print the director's simDays (relative to the epoch) over a time range
import puppeteer from 'puppeteer-core';
const [a, b, st] = (process.argv[2] || '100:160:4').split(':').map(Number);
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: 400, height: 225 });
await page.goto(`http://localhost:5178/dev.html?capture=1&hud=0&only=director`);
await page.waitForFunction('window.__app && window.__app.isReady', { timeout: 120000 });
const r = await page.evaluate((a, b, st) => {
  const out = [];
  const d0 = window.__app.director.evaluate(0).simDays - 0;
  for (let t = a; t <= b; t += st) { const s = window.__app.director.evaluate(t); out.push([t, s.simDays, s.chapter, s.focus]); }
  return out;
}, a, b, st);
for (const x of r) console.log(x.join('  '));
await browser.close();
