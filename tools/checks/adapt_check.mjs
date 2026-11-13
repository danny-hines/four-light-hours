// Adaptive-resolution check: runs the real page (splash, warm-up, Begin) at a Retina-like viewport, seeks to a
// few times and reports the megapixel level the loop settles on and the frame times there.
// Usage: node tools/checks/adapt_check.mjs [--w 1512 --h 982 --dpr 2] [--t 20,34,112,150,246,292] [--seconds 8] [--q "res=2"]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i < 0 ? d : argv[i + 1];
};
const W = Number(arg('w', 1512)), H = Number(arg('h', 982)), DPR = Number(arg('dpr', 2));
const times = String(arg('t', '20,34,112,150,246,292')).split(',').map(Number);
const seconds = Number(arg('seconds', 8));
const chrome = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((c) => fs.existsSync(c));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-'));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  userDataDir: dir,
  defaultViewport: { width: W, height: H, deviceScaleFactor: DPR },
  args: [process.platform === 'win32' ? '--use-angle=d3d11' : process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${W},${H}`],
});
try {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await page.goto(`${arg("base", "http://localhost:5178")}/${arg("page", "dev.html")}?${arg("q", "")}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__app && (window.__app.isReady || window.__app.failed)', { timeout: 240000, polling: 200 });
  await page.evaluate(() => window.__app.start());
  for (const t of times) {
    const r = await page.evaluate(
      async (t, seconds) => {
        const app = window.__app;
        app.seek(t);
        app.play();
        const dts = [];
        let prev = performance.now();
        const end = prev + seconds * 1000;
        const trail = [];
        await new Promise((res) => {
          const f = (now) => {
            dts.push(now - prev);
            prev = now;
            const mp = app.resolution().mp;
            if (!trail.length || trail[trail.length - 1] !== mp) trail.push(mp);
            now < end ? requestAnimationFrame(f) : res();
          };
          requestAnimationFrame(f);
        });
        const half = dts.slice(Math.floor(dts.length / 2)); const tail = half.slice().sort((a, b) => a - b); const fps = +(1000 / (half.reduce((a, b) => a + b, 0) / half.length)).toFixed(1);
        const cv = app.renderer.domElement, db = { x: cv.width, y: cv.height };
        return { t, trail, fps, buffer: `${db.x}x${db.y}`, tailMedMs: +tail[tail.length >> 1].toFixed(1), tailP95Ms: +tail[Math.floor(tail.length * 0.95)].toFixed(1), frames: dts.length };
      },
      t,
      seconds
    );
    console.log(JSON.stringify(r));
  }
  if (errs.length) console.log('errors:', errs.slice(0, 8).join('\n'));
} finally {
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
