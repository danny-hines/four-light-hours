// GPU time of one frame via EXT_disjoint_timer_query_webgl2 (dev server must be running on 5178, e.g. after any
// tools/shot.mjs run). usage: node assets-src/scripts/jupiter_gputime.mjs "view=body&body=jupiter&dist=1.6&only=jupiter"
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const puppeteer = require('puppeteer-core');
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const q = process.argv[2];
const url = `http://localhost:5178/dev.html?capture=1&hud=0&${q}`;
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'gput-'));
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: udd,
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--enable-webgl-draft-extensions', '--enable-privileged-webgl-extensions'] });
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction('window.__app && window.__app.isReady', { timeout: 120000 });
const r = await page.evaluate(async () => {
  const app = window.__app;
  const canvas = document.getElementById('view');
  const gl = canvas.getContext('webgl2');
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return 'no timer ext';
  const res = [];
  for (let i = 0; i < 40; i++) {
    const qq = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, qq);
    const p = app.renderFrame();
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    await p;
    let tries = 0;
    while (!gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE) && tries++ < 200) await new Promise((r) => setTimeout(r, 5));
    res.push(gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6);
  }
  res.sort((a, b) => a - b);
  return { p10Ms: +res[4].toFixed(3), medianMs: +res[20].toFixed(3), minMs: +res[0].toFixed(3) };
});
console.log(q, JSON.stringify(r));
await browser.close();
