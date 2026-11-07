// Dev: evaluate an async JS snippet in the app (HUD + director only, fast) and print its JSON result.
//   node src/ui/dev/evalq.mjs "<async body; use app, hud, seek(t)>" [extra query] [W] [H]
// e.g. node src/ui/dev/evalq.mjs "await seek(127); return hud.state" "" 844 390
import puppeteer from 'puppeteer-core';
const body = process.argv[2] || 'return hud.state';
const q = process.argv[3] || '';
const W = +(process.argv[4] || 1600), H = +(process.argv[5] || 900);
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 600000, defaultViewport: { width: W, height: H }, args: ['--use-angle=d3d11'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log('[console.' + m.type() + ']', m.text()));
await page.goto(`http://localhost:5178/dev.html?capture=1&hud=1${/(^|&)(only=|full=1)/.test(q) ? "" : "&only=hud,director"}${q ? "&" + q : ""}`, { waitUntil: 'load' });
await page.waitForFunction('window.__app && window.__app.isReady', { timeout: 120000 });
const r = await page.evaluate(new Function(`return (async () => { const app = window.__app, hud = window.__hud; const seek = async (t) => { app.seek(t); await app.renderFrame(); }; ${body} })()`));
console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 1));
await browser.close();
