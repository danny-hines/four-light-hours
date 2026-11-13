// First-run check: a fresh profile, the real page, Begin, then every frame of the first N seconds (or from --t).
// Reports load / warm-up time and every hitch over 40 ms with the film time it happened at.
// Usage: node tools/checks/start_check.mjs [--seconds 60] [--t 0] [--base http://localhost:5178 --page dev.html]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i < 0 ? d : argv[i + 1];
};
const W = Number(arg('w', 1600)), H = Number(arg('h', 900));
const seconds = Number(arg('seconds', 60)), t0 = Number(arg('t', 0));
const chrome = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((c) => fs.existsSync(c));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-'));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  userDataDir: dir,
  protocolTimeout: 0,
  defaultViewport: { width: W, height: H, deviceScaleFactor: Number(arg('dpr', 1)) },
  args: [process.platform === 'win32' ? '--use-angle=d3d11' : process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', `--window-size=${W},${H}`],
});
const errs = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warn') && errs.push(m.type() + ': ' + m.text()));
  const a = Date.now();
  await page.goto(`${arg('base', 'http://localhost:5178')}/${arg('page', 'dev.html')}?${arg('q', '')}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__app && (window.__app.isReady || window.__app.failed)', { timeout: 240000, polling: 100 });
  console.log(`ready (load + warm-up) in ${((Date.now() - a) / 1000).toFixed(1)} s`);
  await page.click('.sp-begin');
  const r = await page.evaluate(
    async (seconds, t0) => {
      const app = window.__app;
      if (t0 > 0) app.seek(t0);
      const hitches = [];
      app.prof();
      let n = 0, prev = performance.now();
      const end = prev + seconds * 1000;
      await new Promise((res) => {
        const f = (now) => {
          const dt = now - prev;
          prev = now;
          n++;
          if (dt > 40 && n > 1) hitches.push({ t: +app.t.toFixed(1), ms: Math.round(dt), mp: app.resolution().mp });
          now < end ? requestAnimationFrame(f) : res();
        };
        requestAnimationFrame(f);
      });
      return { frames: n, fps: +(n / seconds).toFixed(1), endT: +app.t.toFixed(1), res: app.resolution(), cpu: app.prof(), hudSlow: (window.__hud && window.__hud.slow ? window.__hud.slow.slice(-14) : null), hitches };
    },
    seconds,
    t0
  );
  console.log(JSON.stringify({ ...r, hudSlow: undefined, hitches: r.hitches.length }));
  if (r.hudSlow) for (const h of r.hudSlow) console.log('  hud slow', h[0], h[1]);
  for (const h of r.hitches) console.log(`  hitch ${h.ms} ms at t=${h.t} (${h.mp} MP)`);
} finally {
  if (errs.length) console.log('errors:\n' + errs.slice(0, 12).join('\n'));
  await browser.close();
}
