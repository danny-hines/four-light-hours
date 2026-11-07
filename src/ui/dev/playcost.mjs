// Dev: HUD cost per frame during real playback (non-capture).  node src/ui/dev/playcost.mjs [startT] [seconds]
import puppeteer from 'puppeteer-core';
const t0 = +(process.argv[2] || 40), secs = +(process.argv[3] || 6), q = process.argv[4] || '';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', defaultViewport: { width: 1600, height: 900 }, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.goto('http://localhost:5178/dev.html?' + q, { waitUntil: 'load' });
await page.waitForFunction('window.__app && window.__app.isReady', { timeout: 120000 });
await page.waitForSelector('#flh-splash .sp-begin:not([disabled])');
await new Promise((r) => setTimeout(r, +(process.env.SPLASH_MS || 2500))); // a viewer reads the splash first
await page.click('#flh-splash .sp-begin');
const r = await page.evaluate(async (t0, secs) => {
  window.__app.seek(t0);
  const ms = [], frame = [], worst = [];
  let prev = performance.now();
  await new Promise((res) => {
    const end = prev + secs * 1000;
    const step = (now) => {
      ms.push(window.__hud.ms + (window.__hud.meterMs || 0));
      if (window.__hud.ms > 8) worst.push([+window.__app.t.toFixed(2), window.__hud.ms]);
      frame.push(now - prev);
      prev = now;
      if (now < end) requestAnimationFrame(step);
      else res();
    };
    requestAnimationFrame(step);
  });
  const q = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];
  return { frames: ms.length, hudMedian: q(ms, 0.5), hudP95: q(ms, 0.95), hudMax: Math.max(...ms), frameMedian: q(frame, 0.5), worst: worst.slice(0, 8), slow: window.__hud.slow, meter: window.__hud.state.meter };
}, t0, secs);
console.log(JSON.stringify(r));
await browser.close();
