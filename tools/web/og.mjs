// Social card (tools/web/og.jpg, 1200x630): a frame of the film with the title set in the film's own type.
// Usage: node tools/web/og.mjs [--t 296] [--q "<extra query>"]     (the dev server must be reachable; shot.mjs starts it)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i < 0 ? d : argv[i + 1];
};
const t = Number(arg('t', 296));
const W = 1200, H = 630;
const chrome = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((c) => fs.existsSync(c));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-'));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  userDataDir: dir,
  defaultViewport: { width: W, height: H, deviceScaleFactor: 2 },
  args: [process.platform === 'win32' ? '--use-angle=d3d11' : process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', `--window-size=${W},${H}`],
});
try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:5178/dev.html?capture=1&hud=0&${arg('q', '')}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__app && (window.__app.isReady || window.__app.failed)', { timeout: 240000, polling: 200 });
  await page.evaluate(async (t) => {
    window.__app.seek(t);
    await window.__app.renderFrame();
    await window.__app.renderFrame();
  }, t);
  const frame = Buffer.from(await page.screenshot({ type: 'png' })).toString('base64');
  const { JOST, CORMORANT_ITALIC } = await import(path.join(root, 'src/ui/fonts-data.js'));
  const card = await browser.newPage();
  await card.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await card.setContent(`<!doctype html><html><head><style>
    @font-face { font-family: J; src: url(data:font/woff2;base64,${JOST}); font-weight: 200 600; }
    @font-face { font-family: C; src: url(data:font/woff2;base64,${CORMORANT_ITALIC}); font-style: italic; font-weight: 400 600; }
    html, body { margin: 0; width: ${W}px; height: ${H}px; background: #000; overflow: hidden; }
    img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .sh { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,.5) 0%, rgba(0,0,0,0) 34%, rgba(0,0,0,0) 62%, rgba(0,0,0,.72) 100%); }
    .k { position: absolute; left: 64px; top: 54px; font: 400 14px/1 J; letter-spacing: .36em; text-transform: uppercase; color: rgba(255,255,255,.78); }
    h1 { position: absolute; left: 62px; bottom: 96px; margin: 0; font: 200 62px/1 J; letter-spacing: .38em; text-transform: uppercase; color: #fff; text-shadow: 0 2px 30px rgba(0,0,0,.6); }
    p { position: absolute; left: 64px; bottom: 50px; margin: 0; font: italic 500 25px/1 C; color: rgba(255,255,255,.9); text-shadow: 0 1px 16px rgba(0,0,0,.7); }
  </style></head><body><img src="data:image/png;base64,${frame}"><div class="sh"></div>
  <div class="k">A real-time film · true to scale</div><h1>Four Light-Hours</h1><p>Sunlight takes about four hours to reach the last planet. Follow it.</p></body></html>`);
  await card.evaluate(() => document.fonts.ready);
  const out = path.join(root, 'tools', 'web', 'og.jpg');
  fs.writeFileSync(out, await card.screenshot({ type: 'jpeg', quality: 88 }));
  console.log('wrote', path.relative(root, out));
} finally {
  await browser.close();
}
