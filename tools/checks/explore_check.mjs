// Drives the real page (splash, Begin) through look-around and Explore mode and writes screenshots.
// Usage: node tools/checks/explore_check.mjs [--out shots/explore/live] [--t 108]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i < 0 ? d : argv[i + 1];
};
const out = arg('out', 'shots/explore/live');
const W = Number(arg('w', 1600)), H = Number(arg('h', 900));
const chrome = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((c) => fs.existsSync(c));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-'));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  userDataDir: dir,
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args: [process.platform === 'win32' ? '--use-angle=d3d11' : process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H}`],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warn') && errs.push(m.type() + ': ' + m.text()));
  await page.goto(`${arg("base", "http://localhost:5178")}/${arg("page", "dev.html")}?${arg("q", "")}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__app && (window.__app.isReady || window.__app.failed)', { timeout: 240000, polling: 200 });
  const snap = async (name) => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: `${out}_${name}.png` });
    console.log('wrote', `${out}_${name}.png`, JSON.stringify(await page.evaluate(() => ({ t: +window.__app.t.toFixed(1), playing: window.__app.playing, exploring: !!window.__app.exploring, id: window.__app.explore?.id, res: window.__app.resolution().mp }))));
  };
  await page.click('.sp-begin');
  await sleep(600);
  await page.evaluate((t) => window.__app.seek(t), Number(arg('t', 108)));
  await sleep(2500);
  await snap('1_film');
  // look-around drag during the film
  await page.mouse.move(800, 450);
  await page.mouse.down();
  await page.mouse.move(500, 380, { steps: 12 });
  await sleep(400);
  await snap('2_look');
  await page.mouse.up();
  await sleep(300);
  console.log('after drag: playing =', await page.evaluate(() => window.__app.playing));
  await sleep(2500);
  await snap('3_look_back');
  // explore from the transport bar
  await page.mouse.move(800, 860);
  await sleep(300);
  await page.click('[data-k=explore]');
  await sleep(2200);
  await snap('4_explore');
  await page.mouse.move(800, 450);
  await page.mouse.down();
  await page.mouse.move(1100, 520, { steps: 15 });
  await page.mouse.up();
  await page.mouse.wheel({ deltaY: -700 });
  await sleep(1800);
  await snap('5_orbit_zoom');
  await page.keyboard.press('ArrowRight');
  await sleep(2200);
  await snap('6_next_world');
  const btns = await page.$$('.x-w');
  await btns[11].click();
  await sleep(2400);
  await snap('7_saturn');
  await page.keyboard.press('Escape');
  await sleep(2200);
  await snap('8_back');
} finally {
  if (errs.length) console.log('errors:\n' + errs.slice(0, 12).join('\n'));
  await browser.close();
}
