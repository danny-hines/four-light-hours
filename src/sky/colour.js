// Star colour: B-V -> effective temperature -> blackbody chromaticity in linear sRGB, normalised to unit luminance.
// The lookup table spans 1000 K .. 60000 K on a log scale so the shaders can also Doppler-shift temperatures
// (T' = delta * T) during warp.
import * as THREE from 'three';

export const T_MIN = 1000;
export const T_MAX = 60000;
export const LUT_SIZE = 256;
export const T_WHITE = 6000; // white balance: a ~G0 star renders neutral white (daylight-balanced photograph)

/** Ballesteros (2012) B-V -> T_eff (K). */
export function bvToTemp(bv) {
  const b = Math.min(2.0, Math.max(-0.4, bv));
  return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}

// CIE 1931 2-degree colour matching functions, multi-lobe Gaussian fit (Wyman, Sloan & Shirley 2013).
function g(x, mu, s1, s2) {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}
function cmf(lam) {
  return [
    1.056 * g(lam, 599.8, 37.9, 31.0) + 0.362 * g(lam, 442.0, 16.0, 26.7) - 0.065 * g(lam, 501.1, 20.4, 26.2),
    0.821 * g(lam, 568.8, 46.9, 40.5) + 0.286 * g(lam, 530.9, 16.3, 31.1),
    1.217 * g(lam, 437.0, 11.8, 36.0) + 0.681 * g(lam, 459.0, 26.0, 13.8),
  ];
}
function blackbodyXYZ(T) {
  let X = 0, Y = 0, Z = 0;
  for (let lam = 380; lam <= 780; lam += 5) {
    const B = Math.pow(lam, -5) / (Math.exp(1.4388e7 / (lam * T)) - 1);
    const [x, y, z] = cmf(lam);
    X += B * x;
    Y += B * y;
    Z += B * z;
  }
  return [X / Y, 1, Z / Y];
}
function xyzToLinearSRGB([X, Y, Z]) {
  return [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z];
}
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Linear sRGB colour of a blackbody at T, white-balanced to T_WHITE, luminance 1. `sat` scales chroma. */
export function tempToRGB(T, sat = 1) {
  const w = xyzToLinearSRGB(blackbodyXYZ(T_WHITE));
  const c = xyzToLinearSRGB(blackbodyXYZ(T)).map((v, i) => Math.max(0, v / w[i]));
  const L = lum(c) || 1;
  const n = c.map((v) => v / L);
  return n.map((v) => 1 + (v - 1) * sat);
}

/** 1-D LUT texture: u = ln(T/T_MIN)/ln(T_MAX/T_MIN). */
export function makeColourLUT(sat = 1) {
  const data = new Uint16Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const T = T_MIN * Math.pow(T_MAX / T_MIN, i / (LUT_SIZE - 1));
    const c = tempToRGB(T, sat);
    data[i * 4 + 0] = THREE.DataUtils.toHalfFloat(c[0]);
    data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(c[1]);
    data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(c[2]);
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const tex = new THREE.DataTexture(data, LUT_SIZE, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
