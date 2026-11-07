// dev: measure the compile+link time of the Earth radiance shader (clone the material with a unique define so
// ANGLE's program cache can't help, render once, read back a pixel to force completion)
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: 400, height: 225 });
await page.goto(`http://localhost:5178/dev.html?capture=1&hud=0&only=earth&view=body&body=earth&dist=3`);
await page.waitForFunction('window.__app && window.__app.isReady', { timeout: 300000 });
const r = await page.evaluate(async () => {
  const out = {};
  const e = window.__app.bodies.earth;
  const meshes = [];
  e.object.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const m of meshes) {
    const mat = m.material.clone();
    mat.defines = { ...(mat.defines || {}), UNIQ: Math.floor(Math.random() * 1e9) };
    const old = m.material;
    m.material = mat;
    const t0 = performance.now();
    await window.__app.renderFrame();
    const gl = document.querySelector('canvas').getContext('webgl2');
    const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    out[m.name] = Math.round(performance.now() - t0);
    m.material = old;
  }
  return out;
});
console.log(JSON.stringify(r));
await browser.close();
