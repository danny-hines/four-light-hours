// Splash orrery: the real planet configuration for the epoch, seen from ecliptic north.
// Orbits are the true (Keplerian) ellipses projected onto the ecliptic; radial distance is logarithmic so that
// Mercury and Neptune fit on one page. The dashed line is the straight-line route of the film, planet to planet.
import { AU, heliocentricEclipticAU, orbitalElements } from '../core/astro.js';

const IDS = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
const COLORS = { mercury: '#bdb6ad', venus: '#efe2bf', earth: '#9cc3f2', mars: '#de9672', jupiter: '#e3cba6', saturn: '#e8d6a6', uranus: '#b2e3e8', neptune: '#8aa6f0' };
const SIZE = { mercury: 2.1, venus: 2.8, earth: 2.9, mars: 2.4, jupiter: 4.6, saturn: 4.2, uranus: 3.5, neptune: 3.5 };
const NAMES = { mercury: 'Mercury', venus: 'Venus', earth: 'Earth', mars: 'Mars', jupiter: 'Jupiter', saturn: 'Saturn', uranus: 'Uranus', neptune: 'Neptune' };

const R_IN = 0.3, R_OUT = 31.5; // AU mapped to radius fractions F_IN..F_OUT
const F_IN = 0.105, F_OUT = 0.955;
function radial(rAU) {
  if (rAU <= R_IN) return F_IN * (rAU / R_IN);
  return F_IN + (F_OUT - F_IN) * (Math.log(rAU / R_IN) / Math.log(R_OUT / R_IN));
}

// deterministic hash for the belt dots
function hash(i) {
  let x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Returns an SVG string (viewBox -500..500). positions: universe coords (three axes); epochDays: days since J2000. */
export function orrerySVG(positions, epochDays, { animate = true } = {}) {
  const S = 500;
  const map = (X, Y) => {
    // ecliptic X,Y in AU -> SVG (ecliptic north toward the viewer: counter-clockwise orbits, +Y up)
    const r = Math.hypot(X, Y);
    const f = radial(r) * S;
    const a = Math.atan2(Y, X);
    return [f * Math.cos(a), -f * Math.sin(a)];
  };
  const fmt = (v) => v.toFixed(1);
  let orbits = '', planets = '', route = '';

  // true orbit shapes: sample one sidereal period
  IDS.forEach((id, k) => {
    const el = orbitalElements(id, epochDays);
    const period = 365.25 * Math.pow(el.a, 1.5);
    const N = 160;
    let d = '';
    for (let i = 0; i <= N; i++) {
      const [X, Y] = heliocentricEclipticAU(id, epochDays + (period * i) / N);
      const [x, y] = map(X, Y);
      d += (i ? 'L' : 'M') + fmt(x) + ' ' + fmt(y);
    }
    orbits += `<path class="orb${id === 'earth' ? ' earth' : ''}" pathLength="1" d="${d}Z" style="animation-delay:${(0.15 + k * 0.12).toFixed(2)}s"/>`;
  });

  // planet dots (names are an HTML layer so they stay legible at any orrery size; see layoutOrreryLabels)
  const pts = {};
  const labels = [];
  IDS.forEach((id, k) => {
    const p = positions[id];
    const X = p.x / AU, Y = -p.z / AU;
    const [x, y] = map(X, Y);
    pts[id] = [X, Y, p.y / AU];
    labels.push({ id, name: NAMES[id], x, y, r: SIZE[id], delay: 1.2 + k * 0.1 });
    const halo = id === 'earth' ? `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="10" fill="url(#flh-earthglow)"/>` : '';
    planets += `<g class="pl" style="animation-delay:${(1.2 + k * 0.1).toFixed(2)}s">${halo}<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${SIZE[id]}" fill="${COLORS[id]}"/></g>`;
  });

  // the route: straight 3-D segments Sun -> Mercury -> ... -> Neptune, mapped point by point
  const chain = [[0, 0, 0], ...IDS.map((id) => pts[id])];
  let d = '';
  for (let s = 0; s < chain.length - 1; s++) {
    const a = chain[s], b = chain[s + 1];
    const N = 48;
    for (let i = s === 0 ? 0 : 1; i <= N; i++) {
      const u = i / N;
      const [x, y] = map(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u);
      d += (d ? 'L' : 'M') + fmt(x) + ' ' + fmt(y);
    }
  }
  route = `<path class="route" d="${d}"/>`;

  // main belt: a scatter of faint dots between 2.1 and 3.3 AU
  let belt = '<g class="belt" style="animation-delay:1.0s">';
  for (let i = 0; i < 420; i++) {
    const r = 2.1 + 1.2 * Math.pow(hash(i), 0.9);
    const a = hash(i + 1000) * Math.PI * 2;
    const [x, y] = map(r * Math.cos(a), r * Math.sin(a));
    belt += `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${(0.5 + hash(i + 2000) * 0.6).toFixed(2)}"/>`;
  }
  belt += '</g>';

  const sun = `<circle r="26" fill="url(#flh-sunglow)"/><circle r="5.2" fill="#fff6e4"/>`;
  const svg = `<svg viewBox="-${S} -${S} ${2 * S} ${2 * S}" class="${animate ? 'anim' : ''}" role="img" aria-label="Planet positions seen from above the ecliptic">
<defs>
  <radialGradient id="flh-sunglow"><stop offset="0" stop-color="#fff3da" stop-opacity=".95"/><stop offset=".25" stop-color="#ffd9a0" stop-opacity=".35"/><stop offset="1" stop-color="#ffb060" stop-opacity="0"/></radialGradient>
  <radialGradient id="flh-earthglow"><stop offset="0" stop-color="#9cc3f2" stop-opacity=".55"/><stop offset="1" stop-color="#9cc3f2" stop-opacity="0"/></radialGradient>
</defs>
${belt}${orbits}${route}${sun}${planets}
</svg>`;
  const lab = labels
    .map((l) => `<span class="pl-name${animate ? ' anim-l' : ''}" data-id="${l.id}" style="left:${(50 + (l.x / S) * 50).toFixed(3)}%;top:${(50 + (l.y / S) * 50).toFixed(3)}%;animation-delay:${l.delay.toFixed(2)}s">${l.name}</span>`)
    .join('');
  return { html: svg + `<div class="sp-names">${lab}</div>`, labels, S };
}

/**
 * Place the planet names around their dots without overlaps (greedy, in rendered pixels). Call after layout and on resize.
 * Candidates: outward along the radius first, then the tangential sides, then inward.
 */
export function layoutOrreryLabels(fig, labels, S) {
  const box = fig.querySelector('svg').getBoundingClientRect();
  if (!box.width) return;
  // keep names on screen: allowed x range relative to the orrery centre
  const cxs = box.left + box.width / 2, cys = box.top + box.height / 2;
  const minX = 6 - cxs, maxX = window.innerWidth - 6 - cxs, minY = -box.height / 2 - 4, maxY = box.height / 2 + 4;
  const k = box.width / (2 * S);
  const placed = [];
  // the Sun's glow is off-limits
  placed.push({ x: -14, y: -14, w: 28, h: 28 });
  const order = [...labels].sort((a, b) => b.r - a.r); // giants first
  for (const l of order) {
    const span = fig.querySelector(`.pl-name[data-id="${l.id}"]`);
    if (!span) continue;
    const w = span.offsetWidth, h = span.offsetHeight;
    const px = l.x * k, py = l.y * k;
    const len = Math.hypot(px, py) || 1;
    const ux = px / len, uy = py / len; // outward
    const tx = -uy, ty = ux; // tangential
    const g = l.r * k + 7;
    const cands = [
      [ux, uy], [tx, ty], [-tx, -ty], [ux * 0.7 + tx * 0.7, uy * 0.7 + ty * 0.7], [ux * 0.7 - tx * 0.7, uy * 0.7 - ty * 0.7], [-ux, -uy],
    ];
    let best = null;
    for (const [dx, dy] of cands) {
      // anchor the label box so that its nearest edge sits g px from the dot in direction (dx, dy)
      const cx = px + dx * (g + w / 2), cy = py + dy * (g + h / 2);
      const r = { x: cx - w / 2, y: cy - h / 2, w, h };
      const hitDot = labels.some((o) => o !== l && Math.abs(o.x * k - cx) < w / 2 + 4 && Math.abs(o.y * k - cy) < h / 2 + 4);
      const off = r.x < minX || r.x + r.w > maxX || r.y < minY || r.y + r.h > maxY;
      if (!hitDot && !off && !placed.some((p) => r.x < p.x + p.w + 4 && r.x + r.w + 4 > p.x && r.y < p.y + p.h + 2 && r.y + r.h + 2 > p.y)) {
        best = r;
        break;
      }
    }
    if (!best) best = { x: px + g, y: py - h / 2, w, h };
    placed.push(best);
    span.style.transform = `translate(${(best.x - px).toFixed(1)}px, ${(best.y - py).toFixed(1)}px)`;
  }
}
