// dev: GPU time of one frame via EXT_disjoint_timer_query_webgl2 (median of N). usage: node gputime.mjs "<query>"
import puppeteer from 'puppeteer-core';
const q = process.argv[2];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', defaultViewport: { width: 1600, height: 900 }, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900'] });
const page = await browser.newPage();
await page.goto(`http://localhost:5178/dev.html?capture=1&hud=0&${q}`);
await page.waitForFunction('window.__app && window.__app.isReady', { timeout: 300000 });
const r = await page.evaluate(async () => {
  const gl = document.querySelector('canvas').getContext('webgl2');
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return 'no timer ext';
  const out = [];
  for (let i = 0; i < 24; i++) {
    const qq = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, qq);
    await window.__app.renderFrame();
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    await new Promise((r) => setTimeout(r, 30));
    for (let k = 0; k < 50 && !gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE); k++) await new Promise((r) => setTimeout(r, 10));
    out.push(gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6);
  }
  out.sort((a, b) => a - b);
  return { median: out[12].toFixed(2), min: out[0].toFixed(2), max: out[23].toFixed(2) };
});
console.log(q, JSON.stringify(r));
await browser.close();
