// Dev: print the director's chapters and captions, and the HUD beats derived from them.  node src/ui/dev/dump.mjs
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--use-angle=d3d11'] });
const page = await browser.newPage();
await page.goto('http://localhost:5178/dev.html?capture=1&hud=1&only=hud,director', { waitUntil: 'load' });
await page.waitForFunction('window.__app && window.__app.isReady', { timeout: 120000 });
const r = await page.evaluate(async () => {
  const d = window.__app.director;
  const ch = d.chapters.map((c) => `${c.id} | ${c.title} | ${c.body || ''} | ${c.t0.toFixed(1)}-${c.t1.toFixed(1)}`);
  const cap = (d.captions || []).map((c) => `${c.t0.toFixed(1)}-${c.t1.toFixed(1)} ${c.kind} ${c.id || ''} | ${c.title} | ${c.subtitle || ''} | ${(c.lines || []).join(' / ')}`);
  const cards = [];
  for (const b of window.__hud.beats.cards) {
    window.__app.seek(b[2] + 4);
    await window.__app.renderFrame();
    const data = document.querySelector('#flh-hud .flh-card .flh-data');
    cards.push(`${b[0]} pre=${b[1]} ${b[2]}-${b[3]} data="${data ? data.textContent : ''}"`);
  }
  return { duration: d.duration, ch, cap, open: window.__hud.beats.open, end: window.__hud.beats.end, cards };
});
console.log(r.duration); console.log(r.ch.join('\n')); console.log('--- captions'); console.log(r.cap.join('\n'));
console.log('--- hud beats  open', r.open, ' end', r.end); console.log(r.cards.join('\n'));
await browser.close();
