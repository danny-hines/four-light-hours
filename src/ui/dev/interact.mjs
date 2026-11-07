// HUD interaction test (dev only): drives the real, non-capture app like a viewer would.
//   node src/ui/dev/interact.mjs [--q "only=hud"] [--out shots/hud/interact]
// Splash -> Begin -> idle auto-hide -> keyboard (Space, arrows, M, H, L) -> click/drag scrubbing -> replay -> touch tap.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const q = arg('q', '');
const out = arg('out', 'shots/hud/interact');
fs.mkdirSync(out, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  defaultViewport: { width: 1600, height: 900, hasTouch: false },
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
const snap = (n) => page.screenshot({ path: path.join(out, n + '.png') });
const st = () =>
  page.evaluate(() => ({
    t: window.__app.t,
    playing: window.__app.playing,
    muted: window.__app.muted,
    ctl: !!document.querySelector('#flh-hud .flh-ctl.on'),
    clean: document.querySelector('#flh-hud').classList.contains('flh-clean'),
    idle: document.documentElement.classList.contains('flh-idle'),
    splash: !!document.querySelector('#flh-splash:not(.gone)'),
    ch: (window.__app.director.chapters || []).map((c) => c.t0),
    labels: document.querySelector('#flh-hud .flh-btn[data-k=labels]').getAttribute('aria-pressed') === 'true',
  }));

await page.goto(`http://localhost:5178/dev.html?${q}`, { waitUntil: 'load' });
await page.waitForFunction('window.__app && window.__app.isReady', { timeout: 120000 });
await page.waitForSelector('#flh-splash .sp-begin:not([disabled])', { timeout: 30000 });
await sleep(3200); // let the splash animations finish
await snap('01-splash');
let s = await st();
check('splash visible before Begin, film paused', s.splash && !s.playing);
await page.click('#flh-splash .sp-begin');
await sleep(400);
s = await st();
check('Begin starts playback', s.playing && !s.splash);
await sleep(1800);
await snap('02-after-begin');
await sleep(3000);
s = await st();
check('controls auto-hide after 3 s idle, cursor hidden', !s.ctl && s.idle, JSON.stringify({ ctl: s.ctl, idle: s.idle }));
await page.mouse.move(800, 450);
await page.mouse.move(820, 460);
await sleep(500);
s = await st();
check('mouse move shows controls', s.ctl);
await snap('03-controls');

await page.keyboard.press('Space');
await sleep(200);
s = await st();
check('Space pauses', !s.playing);
const tBefore = s.t;
await page.keyboard.press('ArrowRight');
await sleep(150);
s = await st();
const next = s.ch.find((t0) => t0 > tBefore + 1e-3);
check('ArrowRight jumps to next chapter start', Math.abs(s.t - next) < 0.05, `t ${tBefore.toFixed(2)} -> ${s.t.toFixed(2)}, expected ${next}`);
await page.keyboard.press('ArrowRight');
await sleep(150);
const t2 = (await st()).t;
await page.keyboard.press('ArrowLeft');
await sleep(150);
s = await st();
check('ArrowLeft goes back one chapter', s.t < t2 - 0.01, `${t2.toFixed(2)} -> ${s.t.toFixed(2)}`);
await page.keyboard.down('Shift');
await page.keyboard.press('ArrowRight');
await page.keyboard.up('Shift');
await sleep(150);
const s3 = await st();
check('Shift+ArrowRight seeks +10 s', Math.abs(s3.t - s.t - 10) < 0.3, `${s.t.toFixed(2)} -> ${s3.t.toFixed(2)}`);
await page.keyboard.press('KeyM');
await sleep(150);
check('M mutes', (await st()).muted);
await page.keyboard.press('KeyM');
await sleep(150);
check('M unmutes', !(await st()).muted);
await page.keyboard.press('KeyH');
await sleep(700);
check('H hides titles and telemetry', (await st()).clean);
await snap('04-hud-hidden');
await page.keyboard.press('KeyH');
await sleep(150);
check('H restores', !(await st()).clean);
await page.keyboard.press('KeyL');
// planets are only labelled where they are on screen: try a few moments of the film
let nl = 0;
for (const f of [0.15, 0.3, 0.45, 0.6, 0.75, 0.94, 0.96]) {
  await page.evaluate((f) => window.__app.seek(window.__app.director.duration * f), f);
  await sleep(500);
  nl = await page.evaluate(() => [...document.querySelectorAll('#flh-hud .flh-label')].filter((e) => +e.style.opacity > 0.05).length);
  if (nl > 0) break;
}
await snap('05-labels');
check('L shows planet labels', nl > 0, nl + ' visible');
await page.keyboard.press('KeyL');

const box = await page.evaluate(() => {
  const r = document.querySelector('#flh-hud .flh-track').getBoundingClientRect();
  return { x: r.left, y: r.top + r.height / 2, w: r.width };
});
await page.mouse.move(box.x + box.w * 0.5, box.y);
await sleep(250);
await snap('06-hover-tip');
await page.mouse.down();
await page.mouse.up();
await sleep(150);
const d = await page.evaluate(() => window.__app.director.duration);
s = await st();
check('click on timeline seeks', Math.abs(s.t - d * 0.5) < d * 0.01, `t=${s.t.toFixed(1)} of ${d.toFixed(1)}`);
await page.mouse.move(box.x + box.w * 0.2, box.y);
await page.mouse.down();
await page.mouse.move(box.x + box.w * 0.4, box.y, { steps: 8 });
await page.mouse.move(box.x + box.w * 0.7, box.y, { steps: 8 });
s = await st();
check('drag scrubs', Math.abs(s.t - d * 0.7) < d * 0.01, `t=${s.t.toFixed(1)}`);
await page.mouse.up();

// a mouse click on a control must not make Space act on that control
{
  const p0 = (await st()).playing;
  await page.click('#flh-hud .flh-btn[data-k=mute]');
  await sleep(200);
  const m1 = (await st()).muted;
  await page.keyboard.press('Space');
  await sleep(200);
  const s1 = await st();
  check('Space after clicking Mute toggles play, not mute', s1.playing !== p0 && s1.muted === m1, JSON.stringify({ p0, playing: s1.playing, m1, muted: s1.muted }));
  await page.keyboard.press('Space');
  await page.click('#flh-hud .flh-btn[data-k=mute]');
  await sleep(150);
  await page.focus('#flh-hud .flh-btn[data-k=labels]'); // keyboard focus (Tab) on a button: Space still means play/pause
  const p1 = (await st()).playing;
  await page.keyboard.press('Space');
  await sleep(200);
  const s2 = await st();
  check('Space with a focused button toggles play only', s2.playing !== p1 && !s2.labels, JSON.stringify({ p1, playing: s2.playing }));
  if (s2.playing !== p0) await page.keyboard.press('Space');
  await sleep(150);
}

await page.click('#flh-hud .flh-btn.play');
await sleep(200);
check('play button toggles', (await st()).playing);
await page.click('#flh-hud .flh-btn.play');
await sleep(200);
check('play button toggles back', !(await st()).playing);
await page.mouse.click(800, 300);
await sleep(450);
check('click on picture plays', (await st()).playing);
await page.mouse.click(800, 300);
await sleep(450);
check('click on picture pauses', !(await st()).playing);

await page.keyboard.press('End');
await sleep(300);
await snap('07-end');
const rep = await page.evaluate(() => {
  const b = document.querySelector('#flh-hud .flh-replay');
  return !!b && !b.classList.contains('off');
});
check('Watch again visible at the end', rep);
if (rep) {
  await page.click('#flh-hud .flh-replay');
  await sleep(300);
  s = await st();
  check('Watch again restarts', s.playing && s.t < 1.5, `t=${s.t.toFixed(2)}`);
}

// touch: a tap toggles the controls
await page.evaluate(() => {
  window.__app.seek(30);
  window.__app.play();
});
await sleep(3600);
const before = (await st()).ctl;
await page.touchscreen.tap(800, 400);
await sleep(300);
const after = (await st()).ctl;
check('tap shows hidden controls', !before && after, `${before} -> ${after}`);
await page.touchscreen.tap(800, 400);
await sleep(300);
check('second tap hides controls', !(await st()).ctl);
check('tap does not toggle playback', (await st()).playing);

console.log(results.join('\n'));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
