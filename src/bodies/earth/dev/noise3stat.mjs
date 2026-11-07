// dev: std of the periodic Perlin noise baked by noise3d.js (JS replica of the bake shader) + an octave rotation
const imul = Math.imul;
function grad3(x, y, z) {
  x &= 31; y &= 31; z &= 31;
  let h = (imul(x, 73856093) ^ imul(y, 19349663) ^ imul(z, 83492791)) >>> 0;
  h ^= h >>> 16; h = imul(h, 0x7feb352d) >>> 0; h ^= h >>> 15; h = imul(h, 0x846ca68b) >>> 0; h ^= h >>> 16;
  let h2 = imul(h, 0x9e3779b9) >>> 0; h2 ^= h2 >>> 13; h2 = imul(h2, 0x85ebca6b) >>> 0; h2 ^= h2 >>> 16;
  const zz = 1 - 2 * (h & 0xffff) / 65535, ph = 6.2831853 * (h2 & 0xffff) / 65536, s = Math.sqrt(Math.max(0, 1 - zz * zz));
  return [s * Math.cos(ph), s * Math.sin(ph), zz];
}
function perlin(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const u = fade(fx), v = fade(fy), w = fade(fz);
  let r = 0;
  for (let c = 0; c < 8; c++) {
    const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
    const g = grad3(ix + dx, iy + dy, iz + dz);
    const d = g[0] * (fx - dx) + g[1] * (fy - dy) + g[2] * (fz - dz);
    r += d * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  }
  return r;
}
let s = 0, s2 = 0, n = 0, mx = 0;
let seed = 1;
const rnd = () => ((seed = (imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
for (let i = 0; i < 1 << 20; i++) { const v = perlin(rnd() * 32, rnd() * 32, rnd() * 32); s += v; s2 += v * v; n++; mx = Math.max(mx, Math.abs(v)); }
console.log('mean', (s / n).toFixed(4), 'std', Math.sqrt(s2 / n - (s / n) ** 2).toFixed(4), 'max', mx.toFixed(3));
// rotation: axis (1, 2, 0.5) normalised, angle 1.1 rad
const ax = [1, 2, 0.5], L = Math.hypot(...ax), [a, b, c] = ax.map((v) => v / L), th = 1.1, C = Math.cos(th), S = Math.sin(th), t = 1 - C;
const R = [[t * a * a + C, t * a * b - S * c, t * a * c + S * b], [t * a * b + S * c, t * b * b + C, t * b * c - S * a], [t * a * c - S * b, t * b * c + S * a, t * c * c + C]];
console.log('mat3(' + [0, 1, 2].map((j) => [0, 1, 2].map((i) => R[i][j].toFixed(6)).join(', ')).join(', ') + ')');
