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
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
const WEB = process.argv.includes('--web');
if (!WEB) {
  const out = path.join(root, 'index.html');
  fs.writeFileSync(out, html);
  console.log(`index.html  ${kb(Buffer.byteLength(html))}  (js ${kb(js.length)}, ${files.length} assets ${kb(assetBytes)} raw)`);
} else {
  // ---------------------------------------------------------------- web build: dist/ for static hosting
  // A small index.html that paints at once (title + a hairline), the bundle as one cacheable file, and the assets
  // as separate files that load in parallel behind the splash's progress bar. `--site <url>` sets the canonical /
  // social-card URLs. Hosting config (build command, cache headers) lives in the root vercel.json.
  const crypto = await import('node:crypto');
  const dist = path.join(root, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  for (const f of files) {
    const to = path.join(dist, 'assets', f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(assetDir, f), to);
  }
  const rawJs = result.outputFiles[0].text;
  const hash = crypto.createHash('sha256').update(rawJs).digest('hex').slice(0, 10);
  const jsName = `app.${hash}.js`;
  fs.writeFileSync(path.join(dist, jsName), rawJs);
  const si = process.argv.indexOf('--site');
  const site = si > 0 ? process.argv[si + 1].replace(/\/$/, '') : '';
  const desc = 'A real-time film in your browser: fly from the Sun past every planet at true scale, with each world where it really is today. Then take the camera and explore.';
  const ogFile = path.join(root, 'tools', 'web', 'og.jpg');
  const hasOg = fs.existsSync(ogFile);
  if (hasOg) fs.copyFileSync(ogFile, path.join(dist, 'og.jpg'));
  const icon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#04060a"/><circle cx="32" cy="32" r="9" fill="#ffd9a0"/><ellipse cx="32" cy="32" rx="24" ry="9" transform="rotate(-24 32 32)" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="2"/><circle cx="52.5" cy="20.5" r="3" fill="#8fc1ff"/></svg>')}`;
  const web = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} — a true-to-scale journey through the Solar System</title>
<meta name="description" content="${desc}">
<meta name="theme-color" content="#000000">
<meta name="color-scheme" content="dark">
<link rel="icon" href="${icon}">
${site ? `<link rel="canonical" href="${site}/">` : ''}
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
${site ? `<meta property="og:url" content="${site}/">` : ''}
${hasOg ? `<meta property="og:image" content="${site}/og.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${site}/og.jpg">` : ''}
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<link rel="modulepreload" href="./${jsName}">
<style>${style.trim()}
#boot{position:fixed;inset:0;z-index:5;display:grid;place-content:center;justify-items:center;gap:26px;background:#000;color:#fff;font:200 clamp(18px,3.2vw,40px)/1 Futura,'Avenir Next','Century Gothic','Segoe UI',system-ui,sans-serif;letter-spacing:.4em;text-transform:uppercase;transition:opacity .8s ease}
#boot span{margin-right:-.4em;opacity:.92}
#boot i{display:block;width:min(240px,50vw);height:1px;background:rgba(255,255,255,.16);overflow:hidden;position:relative}
#boot i::after{content:'';position:absolute;inset:0;background:rgba(255,255,255,.8);transform-origin:0 50%;animation:boot 1.6s ease-in-out infinite}
@keyframes boot{0%{transform:translateX(-100%) scaleX(.4)}100%{transform:translateX(100%) scaleX(.4)}}
#boot.gone{opacity:0;pointer-events:none}
#boot p{margin:0;max-width:30em;padding:0 24px;font:400 13px/1.6 system-ui,sans-serif;letter-spacing:.02em;text-transform:none;text-align:center;color:rgba(255,255,255,.7)}</style>
</head>
<body>
<div id="boot"><span>${title}</span><i></i><noscript><p>This film is rendered live in your browser and needs JavaScript and WebGL 2.</p></noscript></div>
<script>window.__ASSET_BASE__="./assets/";</script>
<script type="module" src="./${jsName}"></script>
</body>
</html>
`;
  fs.writeFileSync(path.join(dist, 'index.html'), web);
  console.log(`dist/  index.html ${kb(Buffer.byteLength(web))}, ${jsName} ${kb(rawJs.length)}, ${files.length} assets ${kb(assetBytes)}${hasOg ? ', og.jpg' : ''}`);
}
