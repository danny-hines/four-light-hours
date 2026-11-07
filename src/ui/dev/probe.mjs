import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 600000, defaultViewport: { width: 1600, height: 900 }, args: ['--use-angle=d3d11'] });
const page = await browser.newPage();
await page.goto('http://localhost:5178/dev.html?capture=1&hud=1&only=hud,director', { waitUntil: 'load' });
await page.waitForFunction('window.__app && window.__app.isReady', { timeout: 120000 });
const r = await page.evaluate(async () => {
  for (const b of window.__hud.beats.cards) { window.__app.seek(b[2] + 2); await window.__app.renderFrame(); }
  return Object.entries(window.__hud.layout).map(([k, v]) => `${k.slice(0, 24)} ${v.ms} ms (coverage ${v.covMs})`);
});
console.log(r.join('\n'));
await browser.close();
