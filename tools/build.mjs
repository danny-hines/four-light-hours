// Builds the single-file deliverable: index.html with the bundled app and every asset inlined.
// Usage: node tools/build.mjs
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.bin': 'application/octet-stream', '.json': 'application/json', '.woff2': 'font/woff2' };

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (MIME[path.extname(e.name).toLowerCase()]) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

const result = await build({
  entryPoints: [path.join(root, 'src/main.js')],
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2022',
  write: false,
  legalComments: 'none',
  logLevel: 'warning',
});
let js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const assetDir = path.join(root, 'assets');
const files = walk(assetDir);
const inline = {};
let assetBytes = 0;
for (const f of files) {
  const buf = fs.readFileSync(path.join(assetDir, f));
  assetBytes += buf.length;
  inline[f] = `data:${MIME[path.extname(f).toLowerCase()]};base64,${buf.toString('base64')}`;
}

const dev = fs.readFileSync(path.join(root, 'dev.html'), 'utf8');
const title = (dev.match(/<title>([^<]*)<\/title>/) || [, 'Solar Voyage'])[1].replace(/\s*\(dev\)\s*/, '');
const style = (dev.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
const extraHead = (dev.match(/<!-- build:head -->([\s\S]*?)<!-- \/build:head -->/) || [, ''])[1];

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>${title}</title>
${extraHead.trim()}
<style>${style.trim()}</style>
</head>
<body>
<script>window.__INLINE_ASSETS__=${JSON.stringify(inline)};</script>
<script type="module">${js}</script>
</body>
</html>
`;
const out = path.join(root, 'index.html');
fs.writeFileSync(out, html);
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log(`index.html  ${kb(Buffer.byteLength(html))}  (js ${kb(js.length)}, ${files.length} assets ${kb(assetBytes)} raw)`);
