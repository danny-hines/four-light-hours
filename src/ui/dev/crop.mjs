// Dev: crop + scale a region of a PNG (for inspecting small HUD details).
//   node src/ui/dev/crop.mjs <in.png> <x> <y> <w> <h> <scale> <out.png>
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const [inp, x, y, w, h, sc, out] = process.argv.slice(2);
const b64 = fs.readFileSync(inp).toString('base64');
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new' });
const page = await browser.newPage();
const url = await page.evaluate(async (b64, x, y, w, h, sc) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w * sc; c.height = h * sc;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, x, y, w, h, 0, 0, w * sc, h * sc);
  return c.toDataURL('image/png');
}, b64, +x, +y, +w, +h, +sc);
fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
await browser.close();
