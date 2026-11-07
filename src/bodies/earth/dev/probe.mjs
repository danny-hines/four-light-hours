// dev probe: load a view in headless Chrome and dump Earth/Moon uniforms
import puppeteer from 'puppeteer-core';
const q = process.argv[2];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: 800, height: 450 });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') console.log('[console]', m.text()); });
await page.goto(`http://localhost:5178/dev.html?capture=1&hud=0&${q}`);
await page.waitForFunction('window.__app && window.__app.isReady', { timeout: 120000 });
const r = await page.evaluate(async () => {
  await window.__app.renderFrame();
  const e = window.__app.bodies.earth;
  let moonMesh;
  e.object.traverse((o) => { if (o.name === 'moon-surface') moonMesh = o; });
  const u = moonMesh.material.uniforms;
  const out = {};
  for (const k of ['uCamB', 'uCenterW', 'uNa', 'uNt', 'uAlphaA', 'uThetaS', 'uThetaMax', 'uR', 'uSunDirB']) out[k] = u[k].value.toArray ? u[k].value.toArray() : u[k].value;
  out.geomVerts = moonMesh.geometry.attributes.grid.count;
  out.near = window.__app.director ? null : null;
  return out;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
