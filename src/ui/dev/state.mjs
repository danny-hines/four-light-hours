// Dev: print the HUD's per-frame state (card/caption/scrim/meter) at given journey times.
//   node src/ui/dev/state.mjs "416,79" ["view=body&body=venus&dist=2.2&phase=10"]
import puppeteer from 'puppeteer-core';
const times = (process.argv[2] || '0').split(',').map(Number);
const q = process.argv[3] || '';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', defaultViewport: { width: 1600, height: 900 }, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.goto(`http://localhost:5178/dev.html?capture=1&hud=1&${q}`, { waitUntil: 'load' });
await page.waitForFunction('window.__app && window.__app.isReady', { timeout: 120000 });
for (const t of times) {
  const st = await page.evaluate(async (t) => {
    window.__app.seek(t);
    await window.__app.renderFrame();
    return { ...window.__hud.state, ms: window.__hud.ms };
  }, t);
  console.log(JSON.stringify(st));
}
await browser.close();
