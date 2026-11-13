// Procedural tile textures for the Milky Way shader, generated once at start-up (deterministic, fixed seeds):
//   starTile  - a dense field of point stars with a power-law flux distribution (mean 1 at every mip level, so a
//               minified tile is exactly the smooth light and a pixel-matched one is a grain of faint stars)
//   noiseTile - tileable fBm (R, B) and ridged multifractal filaments (G, A) for the dust lanes
// Texture fetches at an explicit LOD replace many octaves of in-shader simplex noise (GPU cost, compile cost) and
// are filtered by construction: no aliasing, no twinkle when the camera pans.
import * as THREE from 'three';

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Star-dust tile. R = sqrt(flux / vmax) of field A, G = the same for an independent field B (decorrelated octaves,
 * colour jitter). Mips are box-filtered in linear flux and then encoded, so every level has mean 1.
 */
export function makeStarTile({ size = 1024, density = 0.2, alpha = 1.15, range = 60, sigma = 0.62, seed = 77123 } = {}) {
  const N = size * size;
  const fields = [];
  let vmax = 0;
  for (let ch = 0; ch < 2; ch++) {
    const rnd = mulberry32(seed + ch * 9173);
    const f = new Float32Array(N);
    const count = Math.round(N * density);
    const uMin = Math.pow(range, -alpha);
    const R = 2;
    const i2s = 1 / (2 * sigma * sigma);
    for (let k = 0; k < count; k++) {
      const x = rnd() * size, y = rnd() * size;
      // Pareto fluxes in [1, range]: N(>f) ~ f^-alpha (alpha = 2.5 x the slope of log N(<m))
      const flux = Math.pow(uMin + rnd() * (1 - uMin), -1 / alpha);
      const xi = Math.floor(x), yi = Math.floor(y);
      let wsum = 0;
      const w = [];
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const ex = xi + dx + 0.5 - x, ey = yi + dy + 0.5 - y;
          const v = Math.exp(-(ex * ex + ey * ey) * i2s);
          w.push(v);
          wsum += v;
        }
      let q = 0;
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const px = (xi + dx + size) % size, py = (yi + dy + size) % size;
          f[py * size + px] += (flux * w[q++]) / wsum;
        }
    }
    let sum = 0;
    for (let i = 0; i < N; i++) sum += f[i];
    const inv = N / sum;
    for (let i = 0; i < N; i++) {
      f[i] *= inv;
      if (f[i] > vmax) vmax = f[i];
    }
    fields.push(f);
  }
  const mips = [];
  let s = size, cur = fields;
  while (s >= 1) {
    const data = new Uint8Array(s * s * 4);
    for (let i = 0; i < s * s; i++) {
      data[i * 4] = Math.round(255 * Math.sqrt(Math.min(1, cur[0][i] / vmax)));
      data[i * 4 + 1] = Math.round(255 * Math.sqrt(Math.min(1, cur[1][i] / vmax)));
      data[i * 4 + 3] = 255;
    }
    mips.push({ data, width: s, height: s });
    if (s === 1) break;
    const h = s >> 1;
    cur = cur.map((f) => {
      const o = new Float32Array(h * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < h; x++) o[y * h + x] = 0.25 * (f[2 * y * s + 2 * x] + f[2 * y * s + 2 * x + 1] + f[(2 * y + 1) * s + 2 * x] + f[(2 * y + 1) * s + 2 * x + 1]);
      return o;
    });
    s = h;
  }
  const tex = new THREE.DataTexture(mips[0].data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = mips;
  tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return { tex, vmax, size };
}

// periodic 2-D gradient noise (period P lattice cells), ~[-1, 1]
function makePerlin(seed) {
  const rnd = mulberry32(seed);
  const perm = new Uint16Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const gx = new Float32Array(256), gy = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const a = rnd() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  return (x, y, P) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const x0 = ((xi % P) + P) % P, y0 = ((yi % P) + P) % P;
    const x1 = (x0 + 1) % P, y1 = (y0 + 1) % P;
    const h00 = perm[perm[x0 & 255] + (y0 & 255)], h10 = perm[perm[x1 & 255] + (y0 & 255)];
    const h01 = perm[perm[x0 & 255] + (y1 & 255)], h11 = perm[perm[x1 & 255] + (y1 & 255)];
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = gx[h00] * fx + gy[h00] * fy, b = gx[h10] * (fx - 1) + gy[h10] * fy;
    const c = gx[h01] * fx + gy[h01] * (fy - 1), d = gx[h11] * (fx - 1) + gy[h11] * (fy - 1);
    return 1.5 * (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v);
  };
}

/**
 * Noise tile (RGBA8, tileable, GPU mipmaps). R, B: fBm in [0, 1] (mean 0.5). G, A: ridged multifractal filaments
 * (thin bright ridges on a dark ground), domain-warped so they meander; returned with their means.
 */
export function makeNoiseTile({ size = 512, seed = 4421 } = {}) {
  const n1 = makePerlin(seed), n2 = makePerlin(seed + 101), n3 = makePerlin(seed + 211), n4 = makePerlin(seed + 307);
  const N = size * size;
  const fb = [new Float32Array(N), new Float32Array(N)];
  const rg = [new Float32Array(N), new Float32Array(N)];
  const fbm = (n, x, y, f0, oct) => {
    let s = 0, a = 0.5, f = f0;
    for (let o = 0; o < oct; o++) {
      s += a * n(x * f + o * 0.37, y * f - o * 0.21, f);
      f *= 2;
      a *= 0.5;
    }
    return s;
  };
  const ridged = (n, x, y, f0, oct) => {
    let s = 0, a = 0.5, f = f0, w = 1, norm = 0;
    for (let o = 0; o < oct; o++) {
      let r = 1 - Math.abs(n(x * f + o * 0.53, y * f + o * 0.19, f));
      r *= r * r;
      s += a * w * r;
      norm += a;
      w = Math.min(1, Math.max(0.15, r * 1.6)); // multifractal: detail gathers on the ridges
      f *= 2;
      a *= 0.55;
    }
    return s / norm;
  };
  for (let j = 0; j < size; j++) {
    const y = j / size;
    for (let i = 0; i < size; i++) {
      const x = i / size, k = j * size + i;
      const a = fbm(n1, x, y, 4, 5), b = fbm(n2, x, y, 4, 5);
      fb[0][k] = a;
      fb[1][k] = b;
      // meander: the ridges are evaluated in a warped (still periodic) domain
      const wx = x + 0.035 * a, wy = y + 0.035 * b;
      rg[0][k] = ridged(n3, wx, wy, 4, 6);
      rg[1][k] = ridged(n4, wx + 0.3, wy + 0.7, 6, 5);
    }
  }
  const data = new Uint8Array(N * 4);
  const mean = [0, 0];
  for (let c = 0; c < 2; c++) {
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < N; k++) {
      if (rg[c][k] < lo) lo = rg[c][k];
      if (rg[c][k] > hi) hi = rg[c][k];
    }
    let m = 0;
    for (let k = 0; k < N; k++) {
      const v = (rg[c][k] - lo) / (hi - lo);
      m += v;
      data[k * 4 + (c ? 3 : 1)] = Math.round(255 * v);
      data[k * 4 + (c ? 2 : 0)] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + 0.9 * fb[c][k])));
    }
    mean[c] = m / N;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return { tex, mean, size };
}
