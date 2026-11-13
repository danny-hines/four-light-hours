// Venus — CPU bake of the planetary-scale cloud fields into one small equirectangular RGBA half-float texture
// (built once in create(), ~0.1-0.2 s; deterministic: fixed-seed noise, no Math.random()).
//
// Moving the planetary scale out of the fragment shader removes ~10 simplex-noise call sites that FXC (ANGLE's
// D3D compiler) would inline: the deck program compiles several times faster, and the bake can afford far richer,
// more coherent structure than per-pixel noise could.
//
//   R  planetary UV-absorber field in the wave frame (rigid, ~4-day super-rotation): zonal mean (absorber-rich
//      equatorial belt, dark band equatorward of the collar, bright polar collar at ~55-65 deg, bright polar hood)
//      plus the planetary-scale sideways "Y" (equatorial Kelvin-wave stem, mid-latitude Rossby-wave arms opening
//      westward) and the bright region opposite it
//   G  bright spiral arcs sweeping poleward-westward into the collar (arc frame: faster mid-latitude flow)
//   B  coarse streak field A (flow layer 0): long coherent streaks parallel to the equator (~2500-500 km),
//      stretched ~7x in longitude at low latitudes, tilting into spirals toward the collar
//   A  coarse streak field B (flow layer 1), independent seed
// Longitude 0 at u = 0.5, east (-z) toward larger u (three.js SphereGeometry convention).
import * as THREE from 'three';

// ---------------------------------------------------------------------------------- 3D simplex noise (Gustavson)
function makeNoise(seed) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  const pm12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; pm12[i] = perm[i] % 12; }
  const G = new Float32Array([1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1]);
  const F3 = 1 / 3, G3 = 1 / 6;
  return function noise3(x, y, z) {
    const sk = (x + y + z) * F3;
    const i = Math.floor(x + sk), j = Math.floor(y + sk), k = Math.floor(z + sk);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 0.5, y3 = y0 - 1 + 0.5, z3 = z0 - 1 + 0.5;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0, tt, g;
    tt = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (tt > 0) { g = pm12[ii + perm[jj + perm[kk]]] * 3; tt *= tt; n += tt * tt * (G[g] * x0 + G[g + 1] * y0 + G[g + 2] * z0); }
    tt = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (tt > 0) { g = pm12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3; tt *= tt; n += tt * tt * (G[g] * x1 + G[g + 1] * y1 + G[g + 2] * z1); }
    tt = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (tt > 0) { g = pm12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3; tt *= tt; n += tt * tt * (G[g] * x2 + G[g + 1] * y2 + G[g + 2] * z2); }
    tt = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (tt > 0) { g = pm12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3; tt *= tt; n += tt * tt * (G[g] * x3 + G[g + 1] * y3 + G[g + 2] * z3); }
    return 32 * n; // ~[-1, 1]
  };
}

const sq = (x) => x * x;
const smooth = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

// Parameters of the bake (exported so the notes and debug views can refer to them).
export const BAKE = {
  W: 512,
  H: 256,
  yAmp: 1.7,     // strength of the Y (absorber units; see deck.js for the colour mapping)
  collar: 1.2,   // strength of the bright collar
  stretch: 5.0,  // longitude stretch of the coarse streaks at low latitude
};

// Coarse streak field at the unit-sphere point (x, y, z); Ym = the remapped meridional coordinate of its latitude
// (see bakePlanetary). Returns ~zero-mean noise, std ~0.27 (same scale as one simplex octave).
function streakField(N, x, y, z, Ym, seedOff) {
  // large swirls: a low-frequency domain warp bends the streaks into long arcs
  const wx = 0.42 * N(x * 0.8 + seedOff, y * 0.8, z * 0.8);
  const wz = 0.42 * N(x * 0.8, y * 0.8 + seedOff, z * 0.8 + 3.1);
  const wy = 0.13 * N(x * 1.1 + 5.3, y * 1.1 - seedOff, z * 1.1) + 0.06 * N(x * 2.3 - 1.7, y * 2.3, z * 2.3 + seedOff);
  // intermittency: streaky regions alternate with calm, almost featureless sheets
  const env = 0.3 + 0.7 * smooth(-0.35, 0.35, N(x * 1.3 - seedOff, y * 1.3 + 7.7, z * 1.3));
  let v = 0, amp = 1, f = 1.7;
  for (let o = 0; o < 3; o++) {
    v += amp * N((x + wx) * f + seedOff + o * 1.7, (Ym + wy) * f + o * 9.2, (z + wz) * f + o * 3.1);
    amp *= 0.6;
    f *= 2.03;
  }
  // SPIRAL STREAKS (the Mariner 10 / Pioneer Venus look): poleward of ~15 deg the streaks are not zonal - they trail
  // poleward and westward at 15-30 deg to the latitude circles, the same sense in both hemispheres (a chevron about
  // the equator, the arms of the Y being its largest member). Noise stretched along latitude circles cannot tilt, so
  // this part is a sum of spiral wave trains cos(m lon + s g(|lat|) + phase) with integer zonal wavenumbers (seamless),
  // their phases bent and their amplitudes broken up by low-frequency noise so no train reads as a regular stripe.
  const lon = Math.atan2(-z, x), al = Math.abs(Math.asin(Math.max(-1, Math.min(1, y))));
  const g = al + 0.35 * al * al;                       // winds a little tighter toward the collar
  const pw = 2.6 * N(x * 1.5 + seedOff * 0.7, y * 1.5 + 2.2, z * 1.5 - 4.1) + 1.1 * N(x * 3.7 - 2.9, y * 3.7 + seedOff, z * 3.7 + 0.6);
  let sp = 0;
  for (let k = 0; k < 4; k++) {
    const m = SPIRAL_M[k], sk = SPIRAL_S[k];
    const a = 0.45 + 0.55 * smooth(-0.3, 0.4, N(x * 1.9 + 7.3 * k + seedOff, y * 1.9 - 3.3 * k, z * 1.9 + 1.7 * k));
    sp += SPIRAL_A[k] * a * Math.cos(m * lon + sk * g + 1.9 * k + seedOff + pw * (0.6 + 0.25 * k));
  }
  const spEnv = smooth(0.14, 0.42, al) * (1 - smooth(0.95, 1.2, al));
  v = v * (1 - 0.55 * spEnv) + 1.05 * sp * spEnv;
  // bright-skewed: the streaks are mostly thin white (absorber-poor, optically thicker) bands on a tan background
  v = v + 0.9 * Math.min(v, 0);
  return v * env * 0.5;
}
const SPIRAL_M = [3, 5, 8, 13], SPIRAL_S = [9, 15, 23, 36], SPIRAL_A = [0.5, 0.62, 0.5, 0.36];

export function bakePlanetary() {
  const { W, H } = BAKE;
  const N1 = makeNoise(0x5eed1), N2 = makeNoise(0x5eed2), N3 = makeNoise(0x5eed3);
  const data = new Uint16Array(W * H * 4);
  // meridional remap of the streak noise: Ym(lat) = integral of S(lat) dy with the stretch S tapering from
  // BAKE.stretch at low latitudes to ~1.3 poleward of ~55 deg (zonal streaks near the pole would close into rings;
  // there the wind shear draws near-isotropic features into spirals instead). Integrating keeps dYm/dy = S exactly.
  const Ym = new Float64Array(H);
  {
    const S = (al) => 1.3 + (BAKE.stretch - 1.3) * (1 - smooth(0.35, 1.0, al));
    const n = 64;
    for (let j = 0; j < H; j++) {
      const lat = ((j + 0.5) / H - 0.5) * Math.PI;
      let acc = 0;
      for (let k = 0; k < n; k++) {
        const l = (lat * (k + 0.5)) / n;
        acc += S(Math.abs(l)) * Math.cos(l) * (lat / n);
      }
      Ym[j] = acc;
    }
  }
  const toH = THREE.DataUtils.toHalfFloat;
  for (let j = 0; j < H; j++) {
    const lat = ((j + 0.5) / H - 0.5) * Math.PI;
    const cl = Math.cos(lat), y = Math.sin(lat);
    const al0 = Math.abs(lat);
    for (let i = 0; i < W; i++) {
      const lon = ((i + 0.5) / W - 0.5) * 2 * Math.PI;
      const x = cl * Math.cos(lon), z = -cl * Math.sin(lon);

      // ---------------- R: zonal mean + Y (wave frame)
      const wob = 0.05 * N1(x * 2.3 + 7, y * 2.3 + 2, z * 2.3 + 5) + 0.025 * N1(x * 5.1, y * 5.1 + 3, z * 5.1);
      const al = al0 + wob;
      let zonal = 0.26 * Math.exp(-sq(lat / 0.5))             // absorber-rich equatorial belt
        + 0.42 * Math.exp(-sq((al - 0.80) / 0.105))           // darker band just equatorward of the collar (~46 deg)
        - 1.05 * BAKE.collar * Math.exp(-sq((al - 1.02) / 0.095)) // bright polar collar (~58 deg)
        - 0.45 * smooth(1.08, 1.40, al);                     // bright, hazy polar hood
      // Y: the stem (equatorial Kelvin wave) lies along the equator east of the vertex; the arms (Rossby waves at
      // mid-latitudes) run west of it and diverge poleward, so the dark "Y" lies on its side and opens westward
      const w1 = N2(x * 1.8 + 3.1, y * 1.8, z * 1.8 + 7.7), w2 = N2(x * 1.9 - 5.2, y * 1.9 + 2, z * 1.9 + 1.3);
      const la = lat + 0.05 * w1;
      const lo = lon + 0.16 * w2;
      const stem = Math.exp(-sq(la / 0.19)) * smooth(-0.3, 0.05, lo) * (1 - smooth(0.7, 1.8, lo));
      const aw = Math.max(-lo, 0);
      const pa = 0.05 + 0.36 * aw;            // arm latitude grows westward
      const sa = 0.11 + 0.065 * aw;           // and the arm broadens
      const armEnv = smooth(0.25, -0.12, lo) * (1 - smooth(1.4, 2.5, aw));
      const arms = (Math.exp(-sq((la - pa) / sa)) + Math.exp(-sq((la + pa) / sa))) * armEnv;
      let Yf = 1 - (1 - stem) * (1 - 0.9 * Math.min(arms, 1));
      // streaky (longitude-stretched) internal structure, not isotropic blotches
      const ys = N3(x * 3.0 + 1.3, y * 3.0 * 4.5 + 4.1, z * 3.0 - 2.2);
      Yf *= 0.78 + 0.3 * ys;
      const bright = Math.exp(-sq(la / 0.42)) * smooth(1.9, 2.9, Math.abs(lo)); // bright region opposite the Y
      const R = zonal + BAKE.yAmp * 1.2 * Yf - 0.45 * bright;

      // ---------------- G: spiral arcs into the collar (arc frame; the shader samples it with its own rotation)
      const al2 = al0 + 0.04 * N1(x * 3 + 2, y * 3 + 9, z * 3 + 4);
      const ph = 3 * lon + 19 * al2 + Math.sign(lat) * 1.7 + 2.0 * N2(x * 1.4 + 5, y * 1.4 + 1, z * 1.4 + 8);
      const env = smooth(0.45, 0.72, al2) * (1 - smooth(0.98, 1.12, al2));
      const arcs = env * Math.pow(0.5 + 0.5 * Math.cos(ph), 3) * (0.35 + 0.65 * smooth(-0.5, 0.4, N3(x * 1.9 + 3, y * 1.9 + 3, z * 1.9 + 7)));
      const Gc = -1.1 * arcs;

      // ---------------- B, A: coarse streak fields for the two flow-map layers
      const B = streakField(N1, x, y, z, Ym[j], 11.3);
      const A = streakField(N3, x, y, z, Ym[j], -27.9);

      const o = (j * W + i) * 4;
      data[o] = toH(R); data[o + 1] = toH(Gc); data[o + 2] = toH(B); data[o + 3] = toH(A);
    }
  }
  // zero-mean streak channels (the bright skew shifted their mean)
  for (const c of [2, 3]) {
    let m = 0, wsum = 0;
    for (let j = 0; j < H; j++) {
      const wl = Math.cos(((j + 0.5) / H - 0.5) * Math.PI);
      for (let i = 0; i < W; i++) { m += wl * THREE.DataUtils.fromHalfFloat(data[(j * W + i) * 4 + c]); wsum += wl; }
    }
    m /= wsum;
    for (let k = c; k < data.length; k += 4) data[k] = toH(THREE.DataUtils.fromHalfFloat(data[k]) - m);
  }
  // mip chain on the CPU (box filter in float): the shader picks the level from the pixel footprint (textureLod),
  // so the field never aliases on a small disc and the longitude seam has no derivative jump
  const mips = [];
  let lw = W, lh = H, cur = Float32Array.from(data, (h) => THREE.DataUtils.fromHalfFloat(h));
  mips.push({ data, width: W, height: H });
  while (lw > 1 || lh > 1) {
    const nw = Math.max(1, lw >> 1), nh = Math.max(1, lh >> 1);
    const nxt = new Float32Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let c = 0; c < 4; c++) {
      const y0 = Math.min(2 * y, lh - 1), y1 = Math.min(2 * y + 1, lh - 1), x0 = Math.min(2 * x, lw - 1), x1 = Math.min(2 * x + 1, lw - 1);
      nxt[(y * nw + x) * 4 + c] = 0.25 * (cur[(y0 * lw + x0) * 4 + c] + cur[(y0 * lw + x1) * 4 + c] + cur[(y1 * lw + x0) * 4 + c] + cur[(y1 * lw + x1) * 4 + c]);
    }
    const h16 = new Uint16Array(nxt.length);
    for (let k = 0; k < nxt.length; k++) h16[k] = toH(nxt[k]);
    mips.push({ data: h16, width: nw, height: nh });
    cur = nxt; lw = nw; lh = nh;
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mipmaps = mips;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
