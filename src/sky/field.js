// Procedural faint star field (V ~ 6.6 .. 9.8): deterministic. Stars are placed where the starlight is (the
// unextincted background light S_bg of the Milky Way layers, with log-normal clumping on 0.2-1 deg scales) and are
// then dimmed and reddened by the dust column in front of them, so dark clouds such as the Coalsack visibly lose
// most of their field stars instead of just being greyed over.
import { bvToTemp } from './colour.js';

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rnd) {
  const u = Math.max(1e-9, rnd()), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// smooth 3D value noise in [-1, 1] (deterministic, for the clumping field)
function hash3(x, y, z) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  let v = 0;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
    const w = (dx ? sx : 1 - sx) * (dy ? sy : 1 - sy) * (dz ? sz : 1 - sz);
    v += w * hash3(xi + dx, yi + dy, zi + dz);
  }
  return v * 2 - 1;
}

function readImage(image, W, H) {
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(image, 0, 0, W, H);
  return g.getImageData(0, 0, W, H).data;
}

/**
 * @param image   HTMLImageElement / ImageBitmap of milkyway.webp (G = log S_bg), or null (analytic density)
 * @param dust    image of dust.webp (log tau_eff), or null (no extinction)
 * @param meta    milkyway.json
 * @param axes    { gC, gY, gN } galactic axes as THREE.Vector3 in world space
 */
export function makeField({ image, dust, meta, axes, count, mMin = 6.6, mMax = 9.8, seed = 20261102, densPow = 1 }) {
  const GW = 512, GH = 128;
  const K = meta?.latK ?? 2.6, sK = Math.sinh(K);
  let rad = null;
  const DW = 2048, DH = 512;
  let tauMap = null;
  if (image) {
    try {
      const px = readImage(image, GW, GH);
      const lo = Math.log(meta.radMin), hi = Math.log(meta.radMax);
      rad = new Float32Array(GW * GH);
      for (let i = 0; i < GW * GH; i++) rad[i] = Math.exp(lo + (hi - lo) * (px[i * 4 + 1] / 255));
      // ln tau = smooth layer (R of the Milky Way layers) + residual (dust map)
      const sm = readImage(image, DW, DH);
      const dpx = dust ? readImage(dust, DW, DH) : null;
      const tlo = Math.log(meta.tauMin), thi = Math.log(meta.tauMax);
      const rk = ((meta.resR ?? 3.5) * 255) / 127;
      tauMap = new Float32Array(DW * DH);
      for (let i = 0; i < DW * DH; i++) {
        const ls = tlo + (thi - tlo) * (sm[i * 4] / 255);
        const rr = dpx ? (dpx[i * 4] / 255 - 128 / 255) * rk : 0;
        tauMap[i] = (sm[i * 4 + 2] / 255) * Math.exp(ls + rr); // light-weighted column (rho tau_eff)
      }
    } catch (e) {
      rad = null;
      tauMap = null;
    }
  }
  const bOfY = (y) => (90 * Math.sinh(K * y)) / sK;
  const sinB = new Float64Array(GH + 1);
  for (let j = 0; j <= GH; j++) sinB[j] = Math.sin((bOfY(1 - (2 * j) / GH) * Math.PI) / 180);
  // cell weights = density x solid angle
  const cdf = new Float64Array(GW * GH);
  let acc = 0;
  for (let j = 0; j < GH; j++) {
    const dOm = Math.abs(sinB[j] - sinB[j + 1]);
    const bc = bOfY(1 - (2 * (j + 0.5)) / GH);
    for (let i = 0; i < GW; i++) {
      let dens;
      if (rad) {
        // star counts to V ~ 10.6 follow the starlight steeply: ~2/sq deg at the galactic poles, ~45 in Cygnus,
        // ~110 in the Large Sagittarius cloud and ~170 in Baade's window (Bahcall-Soneira-like contrast of ~50)
        const r = rad[j * GW + i];
        // (densPow < 1 flattens that contrast for a deep field: in the star clouds the instanced stars would pile up
        // several to a pixel; there the Milky Way shader's own star grain carries the crowding instead)
        dens = Math.pow(0.05 + Math.pow(r / 0.02, 0.65), densPow);
      } else {
        const l = Math.PI * (1 - (2 * (i + 0.5)) / GW);
        dens = 0.3 + 2.5 * Math.exp(-Math.abs(bc) / 10) * (1 + 0.8 * Math.exp(-(l * l) / 0.6));
      }
      acc += dens * dOm;
      cdf[j * GW + i] = acc;
    }
  }
  const tauAt = (l, b) => {
    if (!tauMap) return 0;
    const u = 0.5 - l / (2 * Math.PI);
    const y = Math.asinh(((b * 180) / Math.PI / 90) * sK) / K;
    const x = ((u * DW) % DW + DW) % DW;
    const r = Math.min(DH - 1, Math.max(0, Math.floor((1 - (0.5 + 0.5 * y)) * DH)));
    return tauMap[r * DW + Math.floor(x)];
  };
  const rnd = mulberry32(seed);
  const dir = new Float32Array(count * 3), mag = new Float32Array(count), temp = new Float32Array(count);
  const a = 0.42;
  const e0 = Math.pow(10, a * mMin), e1 = Math.pow(10, a * mMax);
  const { gC, gY, gN } = axes;
  for (let k = 0; k < count; k++) {
    // cell, then a position inside it; clumping by rejection against a log-normal field (0.2 - 1 deg)
    let x, y, z, l, sb;
    for (let tries = 0; tries < 6; tries++) {
      const t = rnd() * acc;
      let lo = 0, hi = cdf.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] < t) lo = mid + 1;
        else hi = mid;
      }
      const j = Math.floor(lo / GW), i = lo - j * GW;
      const u = (i + rnd()) / GW;
      l = 2 * Math.PI * (0.5 - u);
      sb = sinB[j + 1] + (sinB[j] - sinB[j + 1]) * rnd();
      const cb = Math.sqrt(Math.max(0, 1 - sb * sb));
      x = cb * Math.cos(l);
      y = cb * Math.sin(l);
      z = sb;
      // (stronger, finer clumping toward the plane: star clouds are grainy at 0.1-0.5 deg)
      const pl = Math.exp(-Math.abs(z) / 0.17);
      const c = Math.exp((0.7 + 0.25 * pl) * vnoise(x * 90 + 11.3, y * 90 - 4.1, z * 90 + 7.7) + (0.4 + 0.35 * pl) * vnoise(x * 260 - 3.9, y * 260 + 8.2, z * 260 - 1.6)
        + 0.3 * pl * vnoise(x * 600 + 2.1, y * 600 - 5.5, z * 600 + 9.3) - 0.35 - 0.2 * pl);
      if (rnd() * 2.2 < c) break;
    }
    dir[k * 3 + 0] = gC.x * x + gY.x * y + gN.x * z;
    dir[k * 3 + 1] = gC.y * x + gY.y * y + gN.y * z;
    dir[k * 3 + 2] = gC.z * x + gY.z * y + gN.z * z;
    // magnitude: N(<m) ~ 10^(0.42 m), then the foreground column (most field stars sit behind the near clouds)
    const b = Math.asin(sb);
    const tau = Math.min(tauAt(l, b), 4.0) * (0.75 + 0.5 * rnd());
    // (+0.3 mag toward the plane: a photographic hierarchy so the bright constellation stars stand out of the
    // crowded Milky Way fields, as they do to the eye)
    mag[k] = Math.log10(e0 + rnd() * (e1 - e0)) / a + 1.086 * tau + 0.3 * Math.exp(-Math.abs(b) / 0.14);
    // colour: mixture of the populations a V ~ 8 sample contains, plus the reddening of that column
    const p = rnd();
    let bv;
    if (p < 0.06) bv = -0.18 + 0.15 * rnd();
    else if (p < 0.3) bv = 0.05 + 0.35 * rnd();
    else if (p < 0.68) bv = 0.55 + 0.12 * gauss(rnd);
    else if (p < 0.95) bv = 1.12 + 0.18 * gauss(rnd);
    else bv = 1.55 + 0.12 * rnd();
    bv += 0.35 * tau;
    temp[k] = bvToTemp(bv);
  }
  return { dir, mag, temp, count };
}
