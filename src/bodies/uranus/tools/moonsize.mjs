// Dev only: the largest on-screen radius (px at 1600x900) of each Uranian moon over the whole film, from the real
// director's shots. usage (from the project root): node src/bodies/uranus/tools/moonsize.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((c) => fs.existsSync(c));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'umoon-')),
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
});
const page = await browser.newPage();
await page.goto('http://localhost:5178/dev.html?capture=1&hud=0&only=uranus,director,post', { waitUntil: 'load' });
await page.waitForFunction('window.__app && (window.__app.isReady === true || window.__app.failed)', { timeout: 300000 });
const res = await page.evaluate(() => {
  const app = window.__app;
  const d = app.director;
  const U = app.bodies.uranus;
  const out = {};
  const pU = U.object.position.clone(); // universe position of Uranus (main.js sets object.position)
  for (let t = 0; t <= d.duration; t += 0.25) {
    const s = d.evaluate(t);
    for (const m of U.moons) {
      const pos = m.positionAt(s.simDays).add(app.bodies.uranus.object.parent ? pU : pU);
      const dist = pos.distanceTo(s.camPos);
      const px = (m.radius / dist / Math.tan((s.fov * Math.PI) / 360)) * 450;
      if (!out[m.id] || px > out[m.id].px) out[m.id] = { px: +px.toFixed(2), t: +t.toFixed(2), chapter: s.chapter };
    }
  }
  return { out, duration: d.duration };
});
console.log(JSON.stringify(res));
await browser.close();
