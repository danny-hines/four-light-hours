// Create-time bakes for the Jupiter cloud shader. Everything here depends on position only, so it is computed once
// in JS (a few tens of ms) instead of per pixel in the shader: that keeps the fragment program small, and Chrome on
// Windows compiles a program through FXC in a time that grows ~quadratically with its instruction count.
//   packTile  : tracer tiles with their analytic-ish gradients (central differences, wrapped) in G/B, so one fetch
//               gives value + gradient (mip-mapping a gradient = the gradient of the filtered field, exactly)
//   correctMap: the Cassini map colour-corrected toward the true-colour portrait (was mapCorrect() per pixel)
//   endMembers: the local light/dark belt-zone end-members (soft max/min of the ~1,750 km low-passed corrected map over
//               +-1.15 and +-2.3 deg of latitude), the map's structure index, and the outbreak intermittency field
import * as THREE from 'three';

function pixels(img) {
  const w = img.width, h = img.height;
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return { w, h, d: g.getImageData(0, 0, w, h).data };
}

function dataTex(data, w, h, { type = THREE.UnsignedByteType, mip = true, srgb = false, wrapT = THREE.RepeatWrapping, aniso = 16 } = {}) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, type);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = wrapT;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.generateMipmaps = mip;
  t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

// value (R), gradient per tile unit (G, B: 0.5 + g / (2 gs)), optional second tile resampled into A.
// Image rows run DOWN; with flipY = false row 0 is texture t = 0, exactly as the shader's tiles were sampled before
// (three's TextureLoader flips images: t = 1 at the top), so rows are written bottom-up here.
export function packTile(img, img2 = null) {
  const a = pixels(img), b = img2 ? pixels(img2) : null;
  const { w, h } = a;
  const v = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) v[y * w + x] = a.d[((h - 1 - y) * w + x) * 4] / 255;
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  let gmax = 0;
  for (let y = 0; y < h; y++) {
    const yp = ((y + 1) % h) * w, ym = ((y - 1 + h) % h) * w;
    for (let x = 0; x < w; x++) {
      const xp = (x + 1) % w, xm = (x - 1 + w) % w;
      // d(2v - 1)/d(tile unit) = 2 dv/dx * w
      const i = y * w + x;
      gx[i] = (v[y * w + xp] - v[y * w + xm]) * w;
      gy[i] = (v[yp + x] - v[ym + x]) * h;
      gmax = Math.max(gmax, Math.abs(gx[i]), Math.abs(gy[i]));
    }
  }
  // scale so that the 99.9th percentile fits (rare extremes clip): a quick histogram
  const hist = new Uint32Array(1024);
  for (let i = 0; i < w * h; i++) {
    hist[Math.min(1023, Math.floor((Math.abs(gx[i]) / gmax) * 1023))]++;
    hist[Math.min(1023, Math.floor((Math.abs(gy[i]) / gmax) * 1023))]++;
  }
  let acc = 0, k = 1023;
  const lim = 2 * w * h * 0.999;
  for (let i = 0; i < 1024; i++) { acc += hist[i]; if (acc >= lim) { k = i; break; } }
  const gs = ((k + 1) / 1023) * gmax;
  const out = new Uint8Array(w * h * 4);
  const q = (x) => Math.max(0, Math.min(255, Math.round((0.5 + x / (2 * gs)) * 255)));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, o = i * 4;
    out[o] = a.d[((h - 1 - y) * w + x) * 4];
    out[o + 1] = q(gx[i]);
    out[o + 2] = q(gy[i]);
    if (b) {
      // bilinear resample of the second tile (different resolution), same orientation convention
      const fx = ((x + 0.5) / w) * b.w - 0.5, fy = ((y + 0.5) / h) * b.h - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const at = (xx, yy) => b.d[((b.h - 1 - ((yy + b.h) % b.h)) * b.w + ((xx + b.w) % b.w)) * 4];
      out[o + 3] = Math.round((at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty);
    } else out[o + 3] = 255;
  }
  // gradient decode in the shader: g = (texel - 0.5) * 2 gs   (per tile unit, of the [-1, 1] value)
  return { tex: dataTex(out, w, h), gs, data: out, w, h };
}

// two velocity tiles (no mipmaps) -> one RG texture
export function packUV(imgU, imgV) {
  const a = pixels(imgU), b = pixels(imgV);
  const { w, h } = a;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((h - 1 - y) * w + x) * 4, o = (y * w + x) * 4;
    out[o] = a.d[s];
    out[o + 1] = b.d[s];
    out[o + 3] = 255;
  }
  return dataTex(out, w, h, { mip: false, aniso: 1 });
}

const s2l = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const l2s = (c) => { c = Math.max(0, Math.min(1, c)); return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255); };
const LW = [0.2126, 0.7152, 0.0722];

// the PIA07782 zones are bluish-white (its green is synthetic from 750/451 nm); the true-colour portrait (PIA04866)
// has warm cream zones: compress excess blue and green, warm the zones, expand luminance contrast ~1.22x
function mapCorrect(r, g, b, out) {
  const L = LW[0] * r + LW[1] * g + LW[2] * b;
  const rr = Math.max(r, 1e-4);
  let bR = b / rr; if (bR > 0.86) bR = 0.86 + 0.38 * (bR - 0.86);
  let gR = g / rr; if (gR > 0.93) gR = 0.93 + 0.4 * (gR - 0.93);
  let cr = rr, cg = rr * gR, cb = rr * bR;
  const t = THREE.MathUtils.smoothstep(L, 0.28, 0.48);
  cr *= 1 + 0.04 * t; cb *= 1 - 0.035 * t;
  const L2 = Math.max(0.33 + (L - 0.33) * 1.22, 0.25 * L);
  const k = L2 / Math.max(LW[0] * cr + LW[1] * cg + LW[2] * cb, 1e-5);
  out[0] = cr * k; out[1] = cg * k; out[2] = cb * k;
}

export function correctMap(img) {
  const a = pixels(img);
  const { w, h } = a;
  const out = new Uint8Array(w * h * 4);
  const lin = new Float32Array(w * h * 3);
  const c = [0, 0, 0];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((h - 1 - y) * w + x) * 4, i = y * w + x;
    mapCorrect(s2l[a.d[s]], s2l[a.d[s + 1]], s2l[a.d[s + 2]], c);
    lin[i * 3] = c[0]; lin[i * 3 + 1] = c[1]; lin[i * 3 + 2] = c[2];
    out[i * 4] = l2s(c[0]); out[i * 4 + 1] = l2s(c[1]); out[i * 4 + 2] = l2s(c[2]); out[i * 4 + 3] = 255;
  }
  return { tex: dataTex(out, w, h, { srgb: true, wrapT: THREE.ClampToEdgeWrapping }), lin, w, h };
}

// ---- 3-D simplex noise with hashed unit gradients (for the intermittency field; any smooth noise in [-1, 1] will do)
function grad(i, j, k) {
  const h = (n) => { const x = Math.sin(n) * 43758.5453123; return x - Math.floor(x); };
  const a = h(i * 127.1 + j * 311.7 + k * 74.7) * 2 - 1, b = h(i * 269.5 + j * 183.3 + k * 246.1) * 2 - 1, c = h(i * 113.5 + j * 271.9 + k * 124.6) * 2 - 1;
  const l = Math.hypot(a, b, c) || 1;
  return [a / l, b / l, c / l];
}
function snoise(x, y, z) {
  const F = 1 / 3, G = 1 / 6;
  const s = (x + y + z) * F;
  const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
  const t = (i + j + k) * G;
  const x0 = x - i + t, y0 = y - j + t, z0 = z - k + t;
  let o1, o2;
  if (x0 >= y0) {
    if (y0 >= z0) { o1 = [1, 0, 0]; o2 = [1, 1, 0]; }
    else if (x0 >= z0) { o1 = [1, 0, 0]; o2 = [1, 0, 1]; }
    else { o1 = [0, 0, 1]; o2 = [1, 0, 1]; }
  } else if (y0 < z0) { o1 = [0, 0, 1]; o2 = [0, 1, 1]; }
  else if (x0 < z0) { o1 = [0, 1, 0]; o2 = [0, 1, 1]; }
  else { o1 = [0, 1, 0]; o2 = [1, 1, 0]; }
  const corner = [[0, 0, 0], o1, o2, [1, 1, 1]];
  let n = 0;
  for (let c = 0; c < 4; c++) {
    const [a, b, cc] = corner[c];
    const px = x0 - a + c * G, py = y0 - b + c * G, pz = z0 - cc + c * G;
    let m = 0.6 - px * px - py * py - pz * pz;
    if (m <= 0) continue;
    const g = grad(i + a, j + b, k + cc);
    m *= m;
    n += m * m * (g[0] * px + g[1] * py + g[2] * pz);
  }
  return 32 * n;
}

// hi (rgb light end-member, a = structure index) and lo (rgb dark end-member, a = intermittency), W x H float16
export function endMembers(mapLin, mw, mh, structImg, W = 512, H = 256) {
  // ~1,750 km low-pass: 8x8 box at the map resolution (the map's mip 3)
  const lw = mw / 8, lh = mh / 8;
  const lp = new Float32Array(lw * lh * 3);
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
    let r = 0, g = 0, b = 0;
    for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 8; xx++) {
      const i = ((y * 8 + yy) * mw + x * 8 + xx) * 3;
      r += mapLin[i]; g += mapLin[i + 1]; b += mapLin[i + 2];
    }
    const o = (y * lw + x) * 3;
    lp[o] = r / 64; lp[o + 1] = g / 64; lp[o + 2] = b / 64;
  }
  const sampleLP = (u, v, out) => {
    const fx = u * lw - 0.5, fy = Math.min(Math.max(v * lh - 0.5, 0), lh - 1.001);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    for (let c = 0; c < 3; c++) {
      const at = (xx, yy) => lp[(yy * lw + ((xx % lw) + lw) % lw) * 3 + c];
      out[c] = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
    }
  };
  const st = pixels(structImg);
  const hiD = new Uint16Array(W * H * 4), loD = new Uint16Array(W * H * 4);
  const hf = THREE.DataUtils.toHalfFloat;
  const OFF = [0, 0.02, -0.02, 0.04, -0.04];
  const c = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    const lat = (v - 0.5) * Math.PI;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      let l0 = 0, ks = 0, wh = 0, wl = 0;
      const hi = [0, 0, 0], lo = [0, 0, 0];
      for (let k = 0; k < 5; k++) {
        sampleLP(u, v + OFF[k] / Math.PI, c);
        const l = LW[0] * c[0] + LW[1] * c[1] + LW[2] * c[2];
        if (k === 0) { l0 = l; ks = 14 / Math.max(l, 0.05); }
        const e = Math.max(-60, Math.min(60, ks * (l - l0)));
        const a = Math.exp(e), b = Math.exp(-e);
        for (let q = 0; q < 3; q++) { hi[q] += c[q] * a; lo[q] += c[q] * b; }
        wh += a; wl += b;
      }
      const o = (y * W + x) * 4;
      for (let q = 0; q < 3; q++) {
        const H_ = hi[q] / wh, L_ = lo[q] / wl, dC = H_ - L_;
        hiD[o + q] = hf(H_ + dC * 0.15);
        loD[o + q] = hf(Math.max(L_ - dC * 0.15, 0.02));
      }
      // structure index (map frame, image rows run down)
      const sx = Math.min(st.w - 1, Math.floor(u * st.w)), sy = Math.min(st.h - 1, Math.floor((1 - v) * st.h));
      hiD[o + 3] = hf(st.d[(sy * st.w + sx) * 4] / 255);
      // intermittency: two simplex octaves on the sphere (outbreaks vs calm stretches); sampled at the advected point
      const lon = (u - 0.5) * 2 * Math.PI;
      const px = Math.cos(lat) * Math.cos(lon), py = Math.sin(lat), pz = -Math.cos(lat) * Math.sin(lon);
      const n = snoise(px * 5 + 3.1, py * 11 + 7.7, pz * 5 - 2.3) * 0.65 + snoise(px * 13 - 5, py * 27 + 1, pz * 13 + 9) * 0.35;
      loD[o + 3] = hf(n);
    }
  }
  const mk = (d) => dataTex(d, W, H, { type: THREE.HalfFloatType, mip: false, wrapT: THREE.ClampToEdgeWrapping, aniso: 1 });
  return { hi: mk(hiD), lo: mk(loD) };
}

// A tileable 2-D gradient-noise tile for the moons' procedural relief (sampled tri-planar, one fetch per plane): Perlin
// noise on a C x C lattice (wrapping), quintic fade, analytic gradient. r = value, gb = gradient per lattice cell, a = a
// second, decorrelated noise. Replaces 3-D simplex noise in the moon shader (~5x fewer instructions per octave).
export function noiseTile(N = 256, C = 32, seed = 7) {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const mk = () => { const g = new Float32Array(C * C * 2); for (let i = 0; i < C * C; i++) { const a = rnd() * 2 * Math.PI; g[2 * i] = Math.cos(a); g[2 * i + 1] = Math.sin(a); } return g; };
  const G1 = mk(), G2 = mk();
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10), dfade = (t) => 30 * t * t * (t * (t - 2) + 1);
  const evalN = (G, x, y, out) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const gi = (i, j) => (((j % C) + C) % C) * C + (((i % C) + C) % C);
    const dot = (i, j, dx, dy) => { const k = gi(i, j) * 2; return G[k] * dx + G[k + 1] * dy; };
    const n00 = dot(xi, yi, fx, fy), n10 = dot(xi + 1, yi, fx - 1, fy), n01 = dot(xi, yi + 1, fx, fy - 1), n11 = dot(xi + 1, yi + 1, fx - 1, fy - 1);
    const u = fade(fx), v = fade(fy), du = dfade(fx), dv = dfade(fy);
    const k00 = gi(xi, yi) * 2, k10 = gi(xi + 1, yi) * 2, k01 = gi(xi, yi + 1) * 2, k11 = gi(xi + 1, yi + 1) * 2;
    const nx0 = n00 + u * (n10 - n00), nx1 = n01 + u * (n11 - n01);
    out[0] = nx0 + v * (nx1 - nx0);
    // gradient: d/dx of the bilinear blend of the corner dot products
    const gx0 = G[k00] + u * (G[k10] - G[k00]) + du * (n10 - n00), gx1 = G[k01] + u * (G[k11] - G[k01]) + du * (n11 - n01);
    const gy0 = G[k00 + 1] + u * (G[k10 + 1] - G[k00 + 1]), gy1 = G[k01 + 1] + u * (G[k11 + 1] - G[k01 + 1]);
    out[1] = gx0 + v * (gx1 - gx0);
    out[2] = gy0 + v * (gy1 - gy0) + dv * (nx1 - nx0);
  };
  const out = new Uint8Array(N * N * 4);
  const a = [0, 0, 0], b = [0, 0, 0];
  const q = (x) => Math.max(0, Math.min(255, Math.round((0.5 + 0.5 * x) * 255)));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    evalN(G1, ((x + 0.5) / N) * C, ((y + 0.5) / N) * C, a);
    evalN(G2, ((x + 0.5) / N) * C + 0.37, ((y + 0.5) / N) * C + 0.71, b);
    const o = (y * N + x) * 4;
    // Perlin 2-D range ~[-0.7, 0.7]: scale to ~[-1, 1]; gradient scale 1/2.5 (per lattice cell)
    out[o] = q(a[0] * 1.4); out[o + 1] = q(a[1] * 1.4 / 2.5); out[o + 2] = q(a[2] * 1.4 / 2.5); out[o + 3] = q(b[0] * 1.4);
  }
  // decode in the shader: value = r * 2 - 1, gradient (per lattice cell) = (gb * 2 - 1) * 2.5
  return dataTex(out, N, N);
}

// Juno's circumpolar cyclones, baked: the static spiral twist each one winds into the polar-stereographic tracer
// coordinates (as offsets) and the cyclone-interior mask. cyc[i] = (unit centre xyz, radius rad), cycP[i] =
// (twist rad, -, centre in polar tile coords). The texture holds both caps: u in [0, 0.5) north, [0.5, 1) south, each
// covering the polar tile coords within +-EXT of the pole. rgba = (offset x, offset y, interior mask, 0), float16.
export const CYC_EXT = 0.9;
export function polarCyclones(cyc, cycP, NA, POLAR_K, W = 256) {
  const d = new Uint16Array(2 * W * W * 4);
  const hf = THREE.DataUtils.toHalfFloat;
  const k = NA / (2 * Math.PI) / POLAR_K;
  for (let pole = 0; pole < 2; pole++) {
    const sg = pole === 0 ? 1 : -1;
    const ox = sg * 17.31, oy = 5.77;
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const px = ((x + 0.5) / W * 2 - 1) * CYC_EXT, py = ((y + 0.5) / W * 2 - 1) * CYC_EXT;
      // the sphere point of this polar tile coordinate (inverse of polarUV)
      const rho = Math.hypot(px, py) / k;
      const co = 2 * Math.atan(rho / 2);
      const lat = sg * (Math.PI / 2 - co), lon = Math.atan2(sg * py, px);
      const w = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)];
      let ux = px + ox, uy = py + oy, inC = 0;
      for (let i = 0; i < cyc.length; i++) {
        const c = cyc[i], cp = cycP[i];
        if (Math.sign(c.y) !== sg) continue;
        const cr = w[0] * c.x + w[1] * c.y + w[2] * c.z;
        if (cr < Math.cos(c.w * 2.4)) continue;
        const r = Math.acos(Math.min(cr, 1)) / c.w;
        const s = THREE.MathUtils.smoothstep(r, 0, 0.5), e = 1 - THREE.MathUtils.smoothstep(r, 1.6, 2.4);
        const ang = cp.x * s * Math.exp(-r * r * 0.9) * e;
        const dx = ux - cp.z, dy = uy - cp.w, ca = Math.cos(ang), sa = Math.sin(ang);
        ux = cp.z + ca * dx - sa * dy;
        uy = cp.w + sa * dx + ca * dy;
        inC = Math.max(inC, 1 - THREE.MathUtils.smoothstep(r, 0.6, 1.25));
      }
      const o = (y * 2 * W + pole * W + x) * 4;
      d[o] = hf(ux - (px + ox)); d[o + 1] = hf(uy - (py + oy)); d[o + 2] = hf(inC); d[o + 3] = hf(0);
    }
  }
  const t = new THREE.DataTexture(d, 2 * W, W, THREE.RGBAFormat, THREE.HalfFloatType);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// A tileable crater-relief tile for Ganymede and Callisto (sampled tri-planar at three scales). Power-law size-frequency
// distribution N(>r) ~ r^-2 from 2.5 px to 8 % of the tile; per crater an age that softens depth and rim, ellipticity,
// flat floors and central peaks for the large ones. r = height (normalised), gb = gradient per tile unit (scaled),
// a = 0.5 + 0.5 x (fresh ejecta - floor) mask. Overlapping craters add their relief.
export function craterTile(N = 512, seed = 11) {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const H = new Float32Array(N * N), M = new Float32Array(N * N);
  const rMin = 2.5 / N, rMax = 0.08;
  const count = Math.round(5 * (rMax / 2 / rMin) ** 2);
  for (let k = 0; k < count; k++) {
    // inverse-CDF sample of N(>r) ~ r^-2 between rMin and rMax
    const u = rnd();
    const r = 1 / Math.sqrt(1 / (rMin * rMin) - u * (1 / (rMin * rMin) - 1 / (rMax * rMax)));
    const cx = rnd(), cy = rnd(), age = Math.sqrt(rnd()), ell = 1 + 0.22 * rnd() ** 2, ang = rnd() * Math.PI;
    const big = r > 0.03;
    const depth = (0.2 - 0.165 * age * age) * 2 * r * (big ? 0.55 : 1), rim = (0.045 - 0.039 * age) * 2 * r;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const R = Math.ceil(2.4 * r * ell * N);
    const px0 = Math.floor(cx * N), py0 = Math.floor(cy * N);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const x = (((px0 + dx) % N) + N) % N, y = (((py0 + dy) % N) + N) % N;
      const ox = (px0 + dx + 0.5) / N - cx, oy = (py0 + dy + 0.5) / N - cy;
      const ex = (ox * ca + oy * sa) / ell, ey = -ox * sa + oy * ca;
      const d = Math.hypot(ex, ey) / r;
      if (d > 2.4) continue;
      let h, m = 0;
      if (d < 1) {
        const fl = big ? 0.55 : 0, dd = Math.max(d - fl, 0) / (1 - fl);
        h = -depth * (1 - dd * dd) + rim * d ** 4 + (big ? 0.45 * depth * Math.exp(-d * d / 0.018) : 0);
        m = -(1 - THREE.MathUtils.smoothstep(d, 0.75, 1)) * (1 - 0.6 * age) * 0.5;
      } else h = rim * Math.exp(-(d - 1) * (3 + 3 * age));
      if (age < 0.08) m = Math.max(m, (1 - age / 0.08) * (d < 1 ? 0.25 + 0.45 * d ** 4 : Math.exp(-(d - 1) * 1.6)));
      const i = y * N + x;
      H[i] += h;
      if (Math.abs(m) > Math.abs(M[i])) M[i] = m;
    }
  }
  let hmax = 1e-6, gmax = 1e-6;
  for (let i = 0; i < N * N; i++) hmax = Math.max(hmax, Math.abs(H[i]));
  const G = new Float32Array(N * N * 2);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const gx = ((H[y * N + ((x + 1) % N)] - H[y * N + ((x - 1 + N) % N)]) * N) / 2;
    const gy = ((H[((y + 1) % N) * N + x] - H[((y - 1 + N) % N) * N + x]) * N) / 2;
    G[2 * (y * N + x)] = gx;
    G[2 * (y * N + x) + 1] = gy;
    gmax = Math.max(gmax, Math.abs(gx), Math.abs(gy));
  }
  const out = new Uint8Array(N * N * 4);
  const q = (v) => Math.max(0, Math.min(255, Math.round((0.5 + 0.5 * v) * 255)));
  for (let i = 0; i < N * N; i++) {
    out[4 * i] = q(H[i] / hmax);
    out[4 * i + 1] = q(G[2 * i] / gmax);
    out[4 * i + 2] = q(G[2 * i + 1] / gmax);
    out[4 * i + 3] = q(M[i]);
  }
  // decode: height (tile units) = (r * 2 - 1) * hmax; gradient (per tile unit) = (gb * 2 - 1) * gmax
  return { tex: dataTex(out, N, N), hmax, gmax };
}

// The polar caps' octave-A tracer, baked: the isotropic tile laid on a polar-stereographic frame around each pole (no
// pole pinching), wound into spirals by Juno's circumpolar cyclones (static twist), with its gradient per km
// (east, north) for the relief normals. The caps barely shear (the zonal advection is faded out above ~65 deg), so the
// shader rotates the baked cap rigidly at the local drift rate instead of evaluating the frame every pixel.
// Atlas: u in [0, 0.5) north cap, [0.5, 1) south; each covers polar tile coords within +-POLAR_EXT of its pole.
// rgba = (0.5 + 0.5 tracer, 0.5 + grad_east / (2 gs), 0.5 + grad_north / (2 gs), cyclone-interior mask).
export const POLAR_EXT = 2.9;
export function polarTracer(tile, cyc, cycP, NA, POLAR_K, R_KM = 71492, W = 512) {
  const { data, w: tw, h: th, gs: tgs } = tile;
  const k = NA / (2 * Math.PI) / POLAR_K;          // polar tile units per unit stereographic radius
  const kp = k / R_KM;
  const samp = (u, v, c) => {
    const fx = (u - Math.floor(u)) * tw - 0.5, fy = (v - Math.floor(v)) * th - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const at = (xx, yy) => data[((((yy % th) + th) % th) * tw + (((xx % tw) + tw) % tw)) * 4 + c];
    return ((at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty) / 255;
  };
  const vals = new Float32Array(2 * W * W * 3), inCs = new Float32Array(2 * W * W);
  let gmax = 1e-6;
  for (let pole = 0; pole < 2; pole++) {
    const sg = pole === 0 ? 1 : -1, ox = sg * 17.31, oy = 5.77;
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const px = ((x + 0.5) / W * 2 - 1) * POLAR_EXT, py = ((y + 0.5) / W * 2 - 1) * POLAR_EXT;
      const rho = Math.hypot(px, py) / k;
      const co = 2 * Math.atan(rho / 2);
      const lat = sg * (Math.PI / 2 - co), lon = Math.atan2(sg * py, px);
      const cl = Math.cos(lat);
      const wv = [cl * Math.cos(lon), Math.sin(lat), -cl * Math.sin(lon)];
      let ux = px + ox, uy = py + oy, inC = 0;
      for (let i = 0; i < cyc.length; i++) {
        const c = cyc[i], cp = cycP[i];
        if (Math.sign(c.y) !== sg) continue;
        const cr = wv[0] * c.x + wv[1] * c.y + wv[2] * c.z;
        if (cr < Math.cos(c.w * 2.4)) continue;
        const r = Math.acos(Math.min(cr, 1)) / c.w;
        const ang = cp.x * THREE.MathUtils.smoothstep(r, 0, 0.5) * Math.exp(-r * r * 0.9) * (1 - THREE.MathUtils.smoothstep(r, 1.6, 2.4));
        const dx = ux - cp.z, dy = uy - cp.w, ca = Math.cos(ang), sa = Math.sin(ang);
        ux = cp.z + ca * dx - sa * dy;
        uy = cp.w + sa * dx + ca * dy;
        inC = Math.max(inC, 1 - THREE.MathUtils.smoothstep(r, 0.6, 1.25));
      }
      // tracer and its gradient per tile unit, then per km east / north through the frame's Jacobian
      const v = samp(ux, uy, 0) * 2 - 1;
      const gx = (samp(ux, uy, 1) - 0.5) * 2 * tgs, gy = (samp(ux, uy, 2) - 0.5) * 2 * tgs;
      const cphi = Math.max(cl, 1e-3), c2 = Math.cos(0.5 * co) ** 2;
      const sl = Math.sin(lon), cn = Math.cos(lon);
      const Je = [-sl * rho * kp / cphi, sg * cn * rho * kp / cphi], Jn = [-sg * cn * kp / c2, -sl * kp / c2];
      const ge = gx * Je[0] + gy * Je[1], gn = gx * Jn[0] + gy * Jn[1];
      const o = (y * 2 * W + pole * W + x) * 3;
      vals[o] = v; vals[o + 1] = ge; vals[o + 2] = gn;
      gmax = Math.max(gmax, Math.abs(ge), Math.abs(gn));
      vals[o] = v;
      inCs[(y * 2 * W + pole * W + x)] = inC;
    }
  }
  const gs = gmax * 0.6;
  const out = new Uint8Array(2 * W * W * 4);
  const q = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
  for (let i = 0; i < 2 * W * W; i++) {
    out[4 * i] = q(0.5 + 0.5 * vals[3 * i]);
    out[4 * i + 1] = q(0.5 + vals[3 * i + 1] / (2 * gs));
    out[4 * i + 2] = q(0.5 + vals[3 * i + 2] / (2 * gs));
    out[4 * i + 3] = q(inCs[i]);
  }
  const t = dataTex(out, 2 * W, W, { wrapT: THREE.ClampToEdgeWrapping });
  t.wrapS = THREE.ClampToEdgeWrapping;
  return { tex: t, gs };
}
