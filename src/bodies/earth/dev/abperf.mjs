// dev: warm frame cost (CPU submit + gl.finish; median / min of N frames; default at 3200x1800 so the GPU, not the
// 60 Hz frame clock, sets the frame time: divide by ~4 for 1600x900) at several journey times in one browser.
// For A/B comparisons on a shared GPU run it alternately on the two code states and compare the minima.
// usage (project root): node src/bodies/earth/dev/abperf.mjs 78,88,112,126,150 [N] [width]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const times = (process.argv[2] || '112').split(',').map(Number);
const N = Number(process.argv[3] || 40);
const W = Number(process.argv[4] || 3200), H = Math.round((W * 9) / 16);
const chrome = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((c) => fs.existsSync(c));
const browser = await puppeteer.launch({
  executablePath: chrome, headless: 'new', defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args: [process.platform === 'win32' ? '--use-angle=d3d11' : process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', `--window-size=${W},${H}`],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await page.goto('http://localhost:5178/dev.html?capture=1&hud=0', { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction('window.__app && (window.__app.isReady === true || window.__app.failed)', { timeout: 600000, polling: 100 });
const out = [];
for (const t of times) {
  const r = await page.evaluate(async (t, N) => {
    const app = window.__app, gl = app.renderer.getContext();
    app.seek(t);
    for (let i = 0; i < 4; i++) { await app.renderFrame(); gl.finish(); }
    const a = [];
    for (let i = 0; i < N; i++) {
      const s = performance.now();
      await app.renderFrame();
      gl.finish();
      a.push(performance.now() - s);
    }
    a.sort((x, y) => x - y);
    return [a[N >> 1], a[0]];
  }, t, N);
  out.push(`t=${t} med ${r[0].toFixed(1)} min ${r[1].toFixed(1)}`);
}
console.log(out.join(' | '));
if (errs.length) console.log('errors:', errs.slice(0, 5).join('\n'));
await browser.close();
