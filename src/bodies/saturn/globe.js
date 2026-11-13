// Saturn's globe: an oblate spheroid (f = 0.098) ray-intersected per pixel, with planetographic latitude bands,
// zonally-stretched turbulence advected by the real zonal wind profile, the north-polar hexagon and polar vortices,
// the seasonal hemispheric tint, haze-softened terminator, analytic ring shadows (sun transmission through the
// real optical-depth profile, blurred by the solar disc), moon shadows and ringshine from a precomputed table.
import * as THREE from 'three';
import { NOISE_GLSL } from '../../glsl/noise.js';
import { RING_GLSL } from './rings-glsl.js';

const VERT = /* glsl */ `
uniform float uFlat;
varying vec3 vPosB;
void main() {
  vPosB = position * vec3(1.0, uFlat, 1.0);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}`;

// Band profile: planetographic latitude (deg), albedo luminance Y (Rec.709, linear) and the hue as it appears in
// Cassini ISS true-colour mosaics (sRGB 0-255, e.g. PIA11141 at equinox: equatorial zone ~ (232,208,152), belts
// tan-brown, B/R ~ 0.55-0.65). Only the hue's chromaticity is used: albedo = Y * linear(hue) / lum(linear(hue)), and
// satDisplay() (rings-glsl.js) makes the post's AgX curve display that chroma. Closely spaced stops are the sharp
// albedo edges at the westward jets (Cassini ISS: belt/zone boundaries are abrupt on the poleward flank of each
// eastward jet). Both hemispheres share this base; the seasonal (winter-blue) tint is applied in the shader.
const BANDS = [
  // south polar cap and high latitudes
  [-90, 0.30, 178, 156, 124], [-87.5, 0.33, 182, 160, 126], [-84, 0.37, 192, 170, 132], [-80.5, 0.40, 200, 178, 136],
  [-78.6, 0.355, 192, 168, 128], [-76.2, 0.42, 204, 181, 138], [-72.4, 0.44, 208, 184, 140], [-71.6, 0.385, 200, 174, 130],
  [-68.5, 0.40, 202, 177, 132], [-66.0, 0.46, 210, 186, 141], [-63.6, 0.47, 211, 187, 142], [-62.8, 0.395, 204, 176, 128],
  [-60.0, 0.41, 206, 178, 130], [-57.6, 0.485, 214, 190, 142], [-53.8, 0.50, 216, 192, 143], [-53.0, 0.415, 208, 178, 126],
  [-49.5, 0.43, 210, 181, 128], [-47.0, 0.505, 218, 194, 144], [-44.0, 0.515, 219, 195, 145], [-43.3, 0.43, 212, 182, 126],
  [-41.0, 0.445, 213, 185, 130],
  // storm alley (35 S) zone, the STB and the South Tropical Zone
  [-39.0, 0.50, 220, 196, 146], [-34.5, 0.53, 223, 199, 148], [-31.8, 0.515, 221, 196, 145], [-31.0, 0.44, 214, 182, 124],
  [-28.6, 0.455, 216, 185, 127], [-27.6, 0.535, 225, 199, 146], [-23.0, 0.56, 228, 203, 149], [-21.9, 0.53, 225, 198, 142],
  // South Equatorial Belt: two dark components split by a lighter line
  [-21.2, 0.385, 210, 167, 106], [-19.0, 0.375, 208, 165, 104], [-17.9, 0.425, 214, 175, 114], [-17.0, 0.43, 215, 176, 115],
  [-16.0, 0.38, 209, 166, 105], [-14.2, 0.40, 211, 170, 109], [-13.6, 0.50, 221, 191, 134],
  // equatorial zone (brightest), its edges, and the slightly darker equatorial band
  [-11.5, 0.575, 228, 201, 145], [-8.5, 0.625, 233, 208, 152], [-3.5, 0.64, 234, 210, 154], [-1.2, 0.60, 230, 205, 150],
  [1.2, 0.605, 230, 205, 150], [3.5, 0.645, 234, 210, 154], [8.5, 0.63, 233, 208, 152], [11.5, 0.58, 228, 201, 145],
  // North Equatorial Belt
  [13.8, 0.50, 221, 191, 134], [14.4, 0.395, 210, 168, 107], [16.2, 0.375, 208, 165, 104], [17.3, 0.42, 214, 174, 113],
  [18.2, 0.425, 214, 175, 114], [19.4, 0.37, 207, 164, 103], [21.0, 0.39, 210, 168, 107], [21.7, 0.53, 225, 198, 142],
  // North Tropical Zone, NTB, the 33-41 N zone (post-2011 Great White Spot latitudes: bright and disturbed)
  [23.0, 0.56, 228, 203, 149], [27.4, 0.54, 225, 199, 146], [28.3, 0.45, 215, 184, 126], [30.8, 0.44, 214, 182, 124],
  [31.6, 0.515, 221, 196, 145], [35.0, 0.535, 224, 200, 149], [38.5, 0.565, 227, 204, 153], [41.3, 0.545, 225, 201, 150],
  [42.0, 0.435, 213, 183, 128], [44.3, 0.45, 214, 185, 130], [46.0, 0.49, 218, 192, 140], [47.6, 0.47, 216, 189, 137],
  [48.5, 0.505, 219, 195, 145], [53.6, 0.50, 218, 194, 144], [54.4, 0.42, 209, 180, 128], [58.0, 0.43, 210, 182, 130],
  [59.0, 0.48, 214, 190, 142], [63.2, 0.47, 212, 188, 142], [64.0, 0.40, 204, 177, 130], [66.6, 0.415, 206, 180, 133],
  [67.5, 0.455, 210, 186, 140], [71.8, 0.45, 209, 185, 140], [72.6, 0.40, 202, 178, 134],
  // hexagon jet latitudes (the hexagon's own band is drawn in the shader), the polar cap
  [74.0, 0.41, 204, 180, 136], [78.5, 0.43, 205, 182, 140], [83.0, 0.40, 198, 176, 136], [87.5, 0.36, 190, 168, 130],
  [90, 0.33, 184, 162, 126],
];
const srgbToLin = (v) => {
  v /= 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
// Contrast and hue spread are then compressed toward a smooth envelope / the EZ hue: Saturn's banding is subtle
// (Cassini equinox mosaic PIA11141: the equatorial belts ~20 % darker than the EZ, mid-latitude bands only 3-8 %),
// and belts differ from zones far more in brightness than in hue.
const lumOf = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const chromaOf = (rgb) => {
  const c = rgb.map(srgbToLin);
  const y = lumOf(c);
  return c.map((v) => v / y);
};
const bandY = (lat) => {
  let i = 1;
  while (i < BANDS.length - 1 && BANDS[i][0] < lat) i++;
  const a = BANDS[i - 1], b = BANDS[i];
  const t = Math.min(1, Math.max(0, (lat - a[0]) / (b[0] - a[0])));
  return a[1] + (b[1] - a[1]) * t;
};
const envY = (lat) => {
  let acc = 0, w = 0;
  for (let d = -15; d <= 15; d += 0.25) {
    const k = Math.exp(-0.5 * (d / 5) ** 2);
    acc += k * bandY(Math.min(90, Math.max(-90, lat + d)));
    w += k;
  }
  return acc / w;
};
const REF_HUE = chromaOf([234, 211, 157]);
const STOPS = BANDS.map(([lat, Y, r, g, b]) => {
  const al = Math.abs(lat);
  // band-to-band contrast around the envelope: x0.8 for the two equatorial belts, x0.4 poleward of ~27 deg
  const kl = 0.8 - 0.4 * Math.min(1, Math.max(0, (al - 21) / 6));
  const env = envY(lat);
  const Yn = env + (Y - env) * kl;
  const ch = chromaOf([r, g, b]).map((v, i) => 1 + (REF_HUE[i] + (v - REF_HUE[i]) * 0.55 - 1) * 0.95);
  return [lat, ...ch.map((v) => v * Yn)];
});
// winter-hemisphere tint target (Cassini 2004-2009 northern winter, Hubble OPAL 2022-24: azure / blue-grey)
const WINTER = (() => {
  const c = [168, 182, 198].map(srgbToLin);
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return c.map((v) => v / y);
})();

const BAND_N = 4096; // texels over -90..+90 deg (0.044 deg each)
// minimum width of every albedo edge: the profile is convolved with a Gaussian of this sigma (deg) before the thin
// lines are applied, so the sharpest belt/zone boundary is a ~0.45 deg (10-90 %) ramp, never a cut-out step
const EDGE_SIGMA = 0.17;
// thin dark lines (Cassini ISS: narrow dark belts / jet-core filaments a few hundred km wide), [lat, sigma deg, depth]
const LINES = [
  [-72.0, 0.18, 0.05], [-63.2, 0.16, 0.06], [-53.4, 0.15, 0.06], [-43.6, 0.14, 0.06], [-31.4, 0.14, 0.05],
  [-21.5, 0.12, 0.05], [-13.9, 0.12, 0.05], [14.1, 0.12, 0.05], [21.3, 0.12, 0.05], [28.0, 0.13, 0.05],
  [41.7, 0.14, 0.06], [47.2, 0.12, 0.04], [54.0, 0.15, 0.06], [63.6, 0.15, 0.05], [72.3, 0.16, 0.05],
];

function buildBandTexture() {
  const base = new Float64Array(BAND_N * 3);
  const ss = (t) => t * t * (3 - 2 * t);
  for (let x = 0; x < BAND_N; x++) {
    // box average over the texel (8 sub-samples) so the finest mip is already an area average
    const acc = [0, 0, 0];
    for (let k = 0; k < 8; k++) {
      const lat = -90 + ((x + (k + 0.5) / 8) / BAND_N) * 180;
      let i = 1;
      while (i < STOPS.length - 1 && STOPS[i][0] < lat) i++;
      const a = STOPS[i - 1], b = STOPS[i];
      const t = ss(Math.min(1, Math.max(0, (lat - a[0]) / (b[0] - a[0]))));
      for (let c = 0; c < 3; c++) acc[c] += a[c + 1] + (b[c + 1] - a[c + 1]) * t;
    }
    for (let c = 0; c < 3; c++) base[x * 3 + c] = acc[c] / 8;
  }
  // minimum edge width (Gaussian, clamped at the poles)
  const sg = (EDGE_SIGMA / 180) * BAND_N, KR = Math.ceil(3 * sg);
  const kern = [];
  let ks = 0;
  for (let d = -KR; d <= KR; d++) { const w = Math.exp(-0.5 * (d / sg) ** 2); kern.push(w); ks += w; }
  const lv0 = new Float64Array(BAND_N * 4);
  // alpha: areal density of the anticyclonic vortices vs latitude (storm alley 35 S, 38 N, 50 and 62 deg)
  const vdens = (lat) => {
    const a = Math.abs(lat), g = (x, c, w) => Math.exp(-(((x - c) / w) ** 2));
    const t = Math.min(1, Math.max(0, (a - 9) / 7));
    return (0.06 + 0.4 * g(lat, -35, 3.5) + 0.32 * g(lat, 38, 5) + 0.22 * g(a, 62, 6) + 0.12 * g(a, 50, 4)) * t * t * (3 - 2 * t);
  };
  for (let x = 0; x < BAND_N; x++) {
    const lat = -90 + ((x + 0.5) / BAND_N) * 180;
    let dark = 1;
    for (const [l, sgl, d] of LINES) dark *= 1 - d * Math.exp(-0.5 * ((lat - l) / sgl) ** 2);
    lv0[x * 4 + 3] = vdens(lat);
    for (let c = 0; c < 3; c++) {
      let v = 0;
      for (let d = -KR; d <= KR; d++) v += kern[d + KR] * base[Math.min(BAND_N - 1, Math.max(0, x + d)) * 3 + c];
      lv0[x * 4 + c] = (v / ks) * dark;
    }
  }
  const mips = [];
  let cur = lv0, w = BAND_N;
  for (;;) {
    const data = new Uint16Array(w * 4);
    for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) data[x * 4 + c] = THREE.DataUtils.toHalfFloat(cur[x * 4 + c]);
    mips.push({ data, width: w, height: 1 });
    if (w === 1) break;
    const nw = w >> 1, nxt = new Float64Array(nw * 4);
    for (let x = 0; x < nw; x++) for (let c = 0; c < 4; c++) nxt[x * 4 + c] = 0.5 * (cur[2 * x * 4 + c] + cur[(2 * x + 1) * 4 + c]);
    cur = nxt;
    w = nw;
  }
  const tex = new THREE.DataTexture(null, BAND_N, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mipmaps = mips;
  tex.image = { data: mips[0].data, width: BAND_N, height: 1 };
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Latitude profiles baked into one 16384-texel RGBA16F strip with a hand-built mip chain:
//   R: fine zonal striations (albedo factor - 1): Cassini's disc is a stack of many thin streaks 0.04-1.5 deg wide,
//      each a few percent brighter or darker, rather than a few flat bands. Sampled at the flow-following latitude
//      with LOD from the pixel footprint, so it is box-filtered exactly (no shimmer) at every distance.
//   G: hue variation between bands;  B: zonal wind / 500 m/s;  A: belt weight / 2 (both read at LOD 0)
const STRI_N = 16384;
function buildStriationTexture() {
  const hash = (i) => {
    let x = Math.imul((i | 0) ^ 0x27d4eb2d, 0x165667b1);
    x ^= x >>> 15; x = Math.imul(x, 0x85ebca77); x ^= x >>> 13;
    return (x >>> 0) / 4294967296;
  };
  const gn = (x, seed) => { // 1D gradient noise in [-1, 1]
    const i = Math.floor(x), f = x - i;
    const g0 = hash(i * 7 + seed) * 2 - 1, g1 = hash((i + 1) * 7 + seed) * 2 - 1;
    const u = f * f * (3 - 2 * f);
    return 2 * (g0 * f + (g1 * (f - 1) - g0 * f) * u);
  };
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const wind = (lat) => {
    const a = Math.abs(lat), g = (x, c, w) => Math.exp(-(((x - c) / w) ** 2));
    return 430 * g(lat, 0, 21) + 90 * g(a, 41, 4) - 25 * g(a, 34, 3) + 60 * g(a, 47.5, 2.5) - 20 * g(a, 54, 3)
      + 110 * g(a, 61, 3) - 30 * g(a, 67, 3) + (lat > 0 ? 100 : 60) * g(a, 76, 2);
  };
  const beltW = (lat) => {
    const a = Math.abs(lat), g = (x, c, w) => Math.exp(-(((x - c) / w) ** 2));
    return g(a, 18, 5) + g(a, 35, 4) + 0.8 * g(lat, 41, 4) + 0.5 * g(a, 60, 5);
  };
  const lv0 = new Float64Array(STRI_N * 4);
  for (let x = 0; x < STRI_N; x++) {
    let fb = 0, hue = 0;
    for (let k = 0; k < 4; k++) { // area average over the texel
      const lat = -90 + ((x + (k + 0.5) / 4) / STRI_N) * 180;
      const b1 = gn(lat * 0.71 + 3.1, 11), b2 = gn(lat * 1.9 + 11.7, 23), b3 = gn(lat * 4.3 + 5.3, 37);
      const s1 = gn(lat * 2.9 + 1.7, 41), s2 = gn(lat * 5.6 + 6.1, 53), s3 = gn(lat * 9.7 + 4.4, 67), b5 = gn(lat * 27 + 8.1, 71);
      const f = 0.035 * b1 + 0.02 * b2 + 0.016 * b3 + 0.026 * s1 + 0.024 * s2 + 0.018 * s3 + 0.01 * b5;
      fb += f * (1 - 0.5 * sm(58, 76, Math.abs(lat)));
      hue += 0.05 * gn(lat * 1.37 + 21, 83) + 0.03 * b3;
    }
    const lat = -90 + ((x + 0.5) / STRI_N) * 180;
    lv0[x * 4] = fb / 4;
    lv0[x * 4 + 1] = hue / 4;
    lv0[x * 4 + 2] = wind(lat) / 500;
    lv0[x * 4 + 3] = beltW(lat) / 2;
  }
  const mips = [];
  let cur = lv0, w = STRI_N;
  for (;;) {
    const data = new Uint16Array(w * 4);
    for (let i = 0; i < w * 4; i++) data[i] = THREE.DataUtils.toHalfFloat(cur[i]);
    mips.push({ data, width: w, height: 1 });
    if (w === 1) break;
    const nw = w >> 1, nxt = new Float64Array(nw * 4);
    for (let i = 0; i < nw; i++) for (let c = 0; c < 4; c++) nxt[i * 4 + c] = 0.5 * (cur[2 * i * 4 + c] + cur[(2 * i + 1) * 4 + c]);
    cur = nxt;
    w = nw;
  }
  const tex = new THREE.DataTexture(null, STRI_N, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mipmaps = mips;
  tex.image = { data: mips[0].data, width: STRI_N, height: 1 };
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Noise table for the shader's single simplex call site. FXC (ANGLE's D3D11 back end) inlines every call and
// unrolls constant-bound loops, so the whole cloud stack goes through one snoise() inside one loop with a uniform
// bound. Entry i: n = snoise(vec3(sp.x, sp.y * a, sp.z) * f + o), skipped (0) when the pixel footprint fp > skip
// (every term using it is filtered out there) or, for type 6, equatorward of 56 deg.
//   types 0/1/2/3: meander / eddy / coarse texture / fine texture octaves (w = amplitude)
//   type 6/7: polar / other fields scattered into slot w;  type 4/5: filament pair (warp, length) of octave w
const NZ = (() => {
  const e = [];
  for (let i = 0; i < 3; i++) { const st = 9, fq = 2.5 * 2.3 ** i; e.push([st, fq, 0.5 / (st * fq), 0, 1.3 * i, 7.1, 3.7, 0.5 ** i]); }
  for (let j = 0; j < 3; j++) { const st = 2.5, fq = 14 * 2.2 ** j; e.push([st, fq, 0.5 / (st * fq), 1, 4.1, 2.2 * j, 8.3, 0.55 ** j]); }
  for (let j = 0; j < 10; j++) {
    const st = 7 + (2 - 7) * Math.min(1, j / 5), fq = 12 * 2.1 ** j;
    const amp = 0.5 * 0.62 ** Math.min(j, 2) * 0.8 ** Math.max(j - 2, 0);
    e.push([st, fq, 0.5 / (st * fq), j < 3 ? 2 : 3, 5.1, 1.7 * j, 9.3, amp]);
  }
  const m = (a, f, skip, polar, o, slot) => e.push([a, f, skip, polar ? 6 : 7, o, o, o, slot]);
  m(1, 60, 0.5 / 120, 1, 0, 0); // hjA
  m(1, 138, 0.5 / 120, 1, 5, 1); // hjB
  m(1, 140, 0.5 / 140, 1, 0, 2); // cap cells A
  m(1, 330, 0.5 / 140, 1, 2, 3); // cap cells B / eyewall towers
  m(1.6, 55, 0.5 / 90, 0, 0, 5); // convective A (slot 4 unused)
  m(1.6, 115.5, 0.5 / 90, 0, 3, 6); // convective B
  m(1.3, 230, 0.5 / 330, 0, 11, 7); // small convective cells
  m(1.4, 120, 0.5 / 150, 0, 31, 8); // dark ovals
  m(1.6, 260, 0.5 / 416, 0, 13, 9); // popcorn (abs)
  m(1.4, 640, 0.5 / 896, 0, 29, 10); // popcorn fine (abs)
  const fil0 = e.length;
  for (let k = 0; k < 6; k++) {
    const fl = 1.1 * Math.pow(2.2, k), sc = fl * 57.3, skip = 0.3 / (57.3 * fl);
    e.push([5, sc * 0.15, skip, 4, 1.7 * k, 3.1, 0, k]);
    e.push([14, sc * 0.045, skip, 5, 9, k, 4, k]);
  }
  const g = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(+v.toPrecision(7)));
  const A = e.map((r) => `vec4(${g(r[0])}, ${g(r[1])}, ${g(r[2])}, ${g(r[3])})`).join(', ');
  const O = e.map((r) => `vec4(${g(r[4])}, ${g(r[5])}, ${g(r[6])}, ${g(r[7])})`).join(', ');
  return { n: e.length, fil0, glsl: `const vec4 NZA[${e.length}] = vec4[${e.length}](${A});\nconst vec4 NZO[${e.length}] = vec4[${e.length}](${O});` };
})();

const FRAG = /* glsl */ `
${NOISE_GLSL}
${RING_GLSL}
uniform vec3 uCamB;     // camera in the body (spinning) frame, Saturn radii
uniform vec3 uSunB;     // sun direction, body frame
uniform vec3 uSunColor;
uniform float uFlat;
uniform float uDtDays;  // days since the film epoch (zonal-wind advection)
uniform sampler2D uRingshine; // irradiance from the rings: x = |lon - lonSun| / pi, y = lat/pi + 0.5
uniform vec4 uMoons[6]; // moon centre (body frame, radii) and radius (radii)
uniform float uGain;
uniform float uHeadlight; // dev: light from the camera
uniform float uNightLift; // display-latitude lift of the ringshine-lit night side (saturn.js)
varying vec3 vPosB;

uniform sampler2D uBand;   // band albedo vs latitude (-90..90), hand-mipped: footprint-filtered soft edges
uniform vec3 uWinter;      // winter-hemisphere chroma (blue-grey), unit luminance
uniform sampler2D uStri;   // R striations, G hue, B zonal wind / 500, A belt / 2 (see buildStriationTexture)
#define BAND_N ${BAND_N}.0
#define STRI_N ${STRI_N}.0
${NZ.glsl}

vec3 bandColour(float latDeg, float fpDeg) {
  float u = clamp((latDeg + 90.0) / 180.0, 0.0, 1.0);
  float lod = log2(max(fpDeg, 1e-4) * BAND_N / 180.0);
  return textureLod(uBand, vec2(u, 0.5), lod).rgb;
}

float fwt(float freq, float fp) { return 1.0 - smoothstep(0.22, 0.5, freq * fp); }
// stricter filter for terms that feed the relief bump (its derivative must stay well sampled)
float fwh(float freq, float fp) { return 1.0 - smoothstep(0.035, 0.09, freq * fp); }

// north-polar hexagon: colatitude stretched toward a rounded hexagon (vertices 17 deg E of System III lon 0)
float hexWarp(float latX, float lon, float wHex) {
  float colat = 90.0 - latX;
  float rel = mod(lon - radians(17.0) + 3.14159265 / 6.0, 3.14159265 / 3.0) - 3.14159265 / 6.0;
  float hexColat = colat * mix(cos(rel), 0.955, 0.22) / 0.955;
  return 90.0 - mix(colat, hexColat, wHex);
}

void main() {
  vec3 rd = normalize(vPosB - uCamB);
  float th = hitPlanet(uCamB, rd, uFlat);
  vec3 P = th > 0.0 ? uCamB + rd * th : vPosB;
  vec3 N = normalize(vec3(P.x, P.y / (uFlat * uFlat), P.z));
  vec3 V = -rd;
  vec3 S = (uHeadlight > 0.5 && uHeadlight < 1.5) ? normalize(uCamB) : uSunB;
  float fp = max(1.15 * max(length(dFdx(P)), length(dFdy(P))), 1e-6);   // pixel footprint, Saturn radii
  float fpDeg = fp * 57.2958;

  float lat = asin(clamp(N.y, -1.0, 1.0));
  float latDeg = degrees(lat);
  float lon = atan(-N.z, N.x);
  float clat = cos(lat);

  // --- zonal advection: features drift with the wind relative to System III. Zonal wind (m/s, eastward) vs
  // planetographic latitude (Cassini ISS, Garcia-Melendo et al. 2011): broad prograde equatorial jet (~430 m/s),
  // alternating mid-latitude jets, the hexagon jet near 76 N; with the belt weight, from the latitude strip
  vec4 lw = textureLod(uStri, vec2(clamp((latDeg + 90.0) / 180.0, 0.0, 1.0), 0.5), 0.0);
  float u = lw.b * 500.0;
  float belt = lw.a * 2.0;
  float shift = u * uDtDays * 86400.0 / (60268000.0 * max(clat, 0.05));
  float lonW = lon - shift;

  // --- vortices: sparse anticyclonic ovals (white, or dark-cored with a bright collar) concentrated at the storm
  // latitudes, and the 'string of pearls' at 33 N (Cassini 2008: ~25 small vortices 3.5 deg apart). Each one swirls
  // the cloud TEXTURE around itself (a domain rotation decaying with radius) and has its own albedo; the band
  // albedo profile itself is never deflected (that dragged the belt edges into hooks). Cells of 3 deg latitude x
  // ~7 deg longitude; a vortex fades out below ~1 px. One loop over the 3x3 neighbouring cells (uniform bound:
  // FXC keeps it a real loop).
  float vAlb = 0.0;
  vec2 vSw = vec2(0.0);     // swirl displacement, deg (x = east, physical; y = north)
  {
    float lonD = degrees(mod(lonW + 3.14159265, 6.2831853) - 3.14159265);
    float ci = floor(latDeg / 3.0);
    for (int c = 0; c < 9 + uSatZero; c++) {
      float row = ci + float(c / 3) - 1.0;
      float rlat = (row + 0.5) * 3.0;
      float arl = abs(rlat);
      if (arl > 73.0) continue;
      float dens = textureLod(uBand, vec2((rlat + 90.0) / 180.0, 0.5), 0.0).a;   // vortex density vs latitude
      float nrow = max(3.0, floor(360.0 * cos(radians(rlat)) / 7.0));
      float cw = 360.0 / nrow;
      float jj = floor(lonD / cw) + float(c - 3 * (c / 3)) - 1.0;
      float jw = mod(jj, nrow);
      vec3 h = hash33(vec3(row + 0.37, jw + 0.71, 7.13));
      if (h.x > dens) continue;
      vec3 h2 = hash33(vec3(row + 5.17, jw + 3.33, 19.7));
      float vlat = (row + 0.2 + 0.6 * h2.x) * 3.0;
      float vlon = (jj + 0.2 + 0.6 * h2.y) * cw;
      float a = 0.3 + 1.05 * h2.z * h2.z;         // semi-minor axis (latitude), deg
      float asp = 1.4 + 1.3 * h.y;
      vec2 dv = vec2((lonD - vlon) * cos(radians(vlat)), latDeg - vlat);
      vec2 e = vec2(dv.x / (a * asp), dv.y / a);
      float r2 = dot(e, e);
      if (r2 > 9.0) continue;
      float vis = 1.0 - smoothstep(0.35, 1.1, fpDeg / a);
      if (vis <= 0.0) continue;
      // C1-continuous falloff: rotation and albedo reach exactly zero with zero slope at r = 3 a
      float fall = pow(max(1.0 - r2 / 9.0, 0.0), 3.0);
      float ang = (vlat > 0.0 ? -1.0 : 1.0) * (1.6 + 1.4 * h.z) * exp(-0.7 * r2) * fall;
      float ca = cos(ang), sa = sin(ang);
      vSw += (vec2(ca * dv.x - sa * dv.y, sa * dv.x + ca * dv.y) - dv) * vis;
      float core = exp(-1.8 * r2);
      float collar = exp(-pow(sqrt(r2) - 1.1, 2.0) / 0.05) * fall;
      // full-disc views stay calm: the ovals' contrast builds up as they are resolved by many pixels
      float con = vis * (0.45 + 0.55 * smoothstep(4.0, 16.0, a / fpDeg));
      vAlb += con * (h.z < 0.62 ? 0.15 * core + 0.02 * collar : -0.10 * core + 0.045 * collar);
    }
    // string of pearls (33.3 N), spanning ~130 deg of longitude
    float dpl = latDeg - 33.3;
    if (abs(dpl) < 1.5) {
      float idx = floor((lonD + 180.0) / 3.5);
      float cl = (idx + 0.5) * 3.5 - 180.0 + 0.6 * (satHash1(idx * 1.7) - 0.5);
      float span = smoothstep(-60.0, -45.0, cl) * (1.0 - smoothstep(55.0, 70.0, cl));
      vec2 e = vec2((lonD - cl) * 0.836 / 0.55, dpl / 0.45);
      float r2 = dot(e, e);
      float vis = (1.0 - smoothstep(0.3, 0.9, fpDeg / 0.45)) * span;
      vAlb += vis * (-0.07 * exp(-2.5 * r2) + 0.045 * exp(-pow(sqrt(r2) - 1.0, 2.0) / 0.08));
    }
  }
  float latS = latDeg + vSw.y;
  float lonSw = lonW + radians(vSw.x) / max(clat, 0.05);
  float cS = cos(radians(latS));
  vec3 sp = vec3(cS * cos(lonSw), sin(radians(latS)), -cS * sin(lonSw));

  // --- all cloud noise goes through ONE simplex call site in one loop (table NZA/NZO, see NZ in JS): 16 octaves of
  // three zonally stretched stacks -- long meanders of a few tenths of a degree (types 0), small eddies in the belts
  // and storm latitudes (1), the cloud texture whose octaves continue down to the pixel footprint (2, 3) -- then the
  // polar / convective / popcorn fields (6, 7: scattered into slots read below), then the filament pairs (4, 5).
  float polarFade = 1.0 - 0.75 * smoothstep(84.0, 89.0, latDeg); // band edges stay wavy up to the vortex
  float meander = 0.0, eddy = 0.0, tex = 0.0, texF = 0.0;
  float hgt = 0.0; // cloud-top relief (Saturn radii), for grazing-light shading below
  float fil = 0.0, prevN = 0.0;
  vec4 nzA = vec4(0.0), nzB = vec4(0.0), nzC = vec4(0.0);
  float latB = latDeg, latW = latDeg, latEff = latDeg, latEffW = latDeg, wHex = 0.0;
  for (int i = 0; i < ${NZ.n} + uSatZero; i++) {
    vec4 A = NZA[i];
    vec4 O = NZO[i];
    int ty = int(A.w);
    if (i == ${NZ.fil0}) {
      // meanders/eddies are complete: the two latitudes. latB indexes the band albedo profile: nearly straight, only
      // a hint of meander, so belt edges are soft and continuous (Cassini). latW follows the flow (meanders, eddies,
      // the vortex swirl): it drives the fine striations and filaments, which really are deflected around eddies.
      latB = latDeg + 0.06 * meander * polarFade;
      latW = latDeg + vSw.y + (0.26 * meander + 0.18 * eddy * belt) * polarFade;
      // polar hexagon (north): a smooth rounded hexagon, no noise in its outline
      wHex = 1.0 - smoothstep(15.0, 22.0, 90.0 - latB);
      latEff = latDeg < -60.0 ? latB : hexWarp(latB, lon, wHex);
      latEffW = latDeg < -60.0 ? latW : hexWarp(latW, lon, wHex);
    }
    float n = 0.0;
    if (fp < A.z && (ty != 6 || latDeg > 56.0)) n = snoise(vec3(sp.x, sp.y * A.x, sp.z) * A.y + O.xyz);
    if (ty < 4) {
      float sf = A.x * A.y;
      float v = O.w * fwt(sf, fp) * n;
      if (ty == 0) meander += v; else if (ty == 1) eddy += v; else if (ty == 2) tex += v; else texF += v;
      if (i >= 8) hgt += O.w * n * (1.0 - smoothstep(0.06, 0.16, sf * fp)) / A.y;
    } else if (ty == 4) {
      prevN = n;
    } else if (ty == 5) {
      float fk = O.w;
      float fl = 1.1 * pow(2.2, fk);
      float wk = 1.0 - smoothstep(0.1, 0.3, fpDeg * fl);
      float nn = gnoise1(latEffW * fl + (1.1 + 0.9 * belt) * prevN + fk * 7.31);
      float rh = 1.0 - abs(nn);
      float r = rh * rh; r *= r;         // thin threads
      float len = smoothstep(-0.35, 0.45, n);
      float af = pow(0.82, fk) * (mod(fk, 2.0) < 0.5 ? 1.0 : -0.85);
      fil += af * wk * (r - 0.22) * len;
      // broad profile for the relief (the thin thread itself would alias in the bump)
      hgt += 0.25 * abs(af) * (1.0 - smoothstep(0.025, 0.07, fpDeg * fl)) * rh * rh * len / (fl * 57.3);
    } else {
      // branchless scatter into vec4 slots (an if-chain here cost FXC ~200 ms)
      int sl = int(O.w);
      vec4 oh = vec4(equal(ivec4(sl & 3), ivec4(0, 1, 2, 3))) * (sl >= 9 ? abs(n) : n);
      int q = sl >> 2;
      nzA += oh * float(q == 0); nzB += oh * float(q == 1); nzC += oh * float(q == 2);
    }
  }
  float hjA = nzA.x, hjB = nzA.y, cA = nzA.z, cB = nzA.w, sv = nzB.x, stA = nzB.y, stB = nzB.z, st2 = nzB.w;
  float ov = nzC.x, c1 = nzC.y, c2 = nzC.z;
  float hexColat = 90.0 - hexWarp(latB, lon, 1.0);

  float fpLat = max(fpDeg, min(length(vec2(dFdx(latEff), dFdy(latEff))), 4.0));
  vec3 col = bandColour(latEff, fpLat);

  // fine zonal striations and band hues (strip R, G) at the flow-following latitude, footprint-filtered by mip
  float fpLatW = max(fpDeg, min(length(vec2(dFdx(latEffW), dFdy(latEffW))), 4.0));
  vec2 fh = textureLod(uStri, vec2(clamp((latEffW + 90.0) / 180.0, 0.0, 1.0), 0.5), log2(fpLatW * STRI_N / 180.0)).rg;
  // (x1.9 / x1.7: at the old +-2-3 % the bands still read as flat fills between soft edges; Cassini's disc is a stack
  //  of hundreds of thin streaks, pale gold to butterscotch to a faintly pink tan)
  col *= (1.0 + 1.9 * fh.r) * vec3(1.0 + fh.g * 1.0, 1.0 - fh.g * 0.15, 1.0 - fh.g * 2.0);

  // cloud texture: streaks stretched along the flow, stronger in belts; the spectrum flattens below ~2 deg so the
  // deck keeps a few percent of local contrast when it fills the frame
  col *= 1.0 + tex * (0.045 + 0.035 * belt) * (0.75 + 0.25 * fwt(53.0 * 2.5, fp)) + texF * (0.24 + 0.1 * belt);
  // thin zonal filaments (Cassini close-ups: long bright and dark threads that meander around small eddies)
  col *= 1.0 + fil * (0.11 + 0.07 * belt);

  // zones: fine mottled "popcorn" texture of small convective cells (resolved only close up)
  {
    float zone = 1.0 - 0.6 * min(belt, 1.0);
    col *= 1.0 + zone * (0.10 * (0.45 - c1) * fwt(416.0, fp) + 0.07 * (0.45 - c2) * fwt(896.0, fp));
    hgt += zone * (0.12 * (1.0 - c1) / 260.0) * (1.0 - smoothstep(0.06, 0.16, 416.0 * fp));
  }

  // convective cells: small bright cumulus towers, common in storm alley (35 S) and the latitude of the 2010-11
  // Great White Spot (~38 N), sparse elsewhere; and a few small dark ovals (anticyclones) at mid-latitudes
  {
    float band = exp(-pow((latDeg + 35.5) / 1.6, 2.0)) + 0.7 * exp(-pow((latDeg - 38.5) / 2.2, 2.0));
    float dens = min(1.0, 0.2 + band);
    float st = stA * 0.6 + stB * 0.4;
    float spot = smoothstep(0.88 - 0.33 * dens, 1.02 - 0.17 * dens, st) * fwt(90.0, fp);
    float spot2 = smoothstep(0.80 - 0.22 * dens, 0.97, st2) * fwt(330.0, fp) * (0.35 + 0.65 * dens);
    float sc = clamp(spot + 0.8 * spot2, 0.0, 1.0);
    col = mix(col, vec3(0.80, 0.75, 0.62), sc * 0.62);
    hgt += spot * 0.4 / 55.0 * fwh(220.0, fp) + spot2 * 0.4 / 230.0 * fwh(900.0, fp);
    float midl = smoothstep(25.0, 35.0, abs(latDeg)) * (1.0 - smoothstep(62.0, 70.0, abs(latDeg)));
    float oval = smoothstep(0.86, 0.97, ov) * midl * fwt(150.0, fp);
    col *= 1.0 - 0.10 * oval;
  }

  // the "ribbon" wave at 47 N
  float rib = latDeg - (47.0 + 0.45 * sin(lonW * 26.0 + 1.3) + 0.2 * sin(lonW * 61.0));
  col *= 1.0 - 0.07 * exp(-rib * rib / 0.1) * fwt(80.0, fp) + 0.045 * exp(-pow(rib - 0.55, 2.0) / 0.1) * fwt(80.0, fp);

  // north polar region (Cassini 2012-2017): the hexagon is a ~2.5 deg wide eastward jet whose cloud band runs
  // laminar along the sides, with its own colour, lined by thin bright cloud ribbons; inside, a cap of finer bands
  // and small vortices around the polar vortex (clear reddish-brown eye ~2 deg, bright eyewall, spiral cloud
  // arms); outside, small storms and vortices between 60 and 75 N.
  if (latDeg > 56.0) {
    float hj = hjA * 0.6 + hjB * 0.4;
    float hb = hexColat - 10.74;                                     // deg from the jet axis, > 0 outside
    // long-wavelength meanders along the perimeter (packets of ~10-20 deg waves) and a slowly varying band width
    float pk = 0.55 + 0.45 * gnoise1p(lon / 6.2831853 * 6.0 + 0.3, 6.0);
    float hbW = hb + (0.30 * sin(lon * 19.0 + 1.7 + 0.8 * sin(lon * 3.0)) + 0.12 * sin(lon * 37.0 + 0.4)) * pk * fwt(27.0, fp)
              + 0.12 * hj * fwt(120.0, fp);
    float ew = 0.15 * sin(lon * 5.0 + 1.1) * pk;
    float ahb = abs(hbW + ew);
    float jb = (1.0 - smoothstep(0.85, 1.55, ahb)) * wHex;
    // laminar streaks parallel to the sides, and thin bright cloud ribbons lining both edges
    float ribH = exp(-pow((ahb - 1.7) / 0.25, 2.0));
    col *= mix(vec3(1.0), vec3(0.80, 0.86, 0.97) * (1.0 + 0.05 * sin(hbW * 11.0 + 0.6 * hj) * fwt(200.0, fp)), jb * 0.85)
         * (1.0 + 0.07 * ribH * wHex * fwt(120.0, fp));
    hgt += 0.25 * jb * fwh(120.0, fp) / 260.0;
    // inside: the cap, its colour following the season (blue-green in late winter / spring 2012-13, golden by the
    // 2017 solstice), with small cells
    float inside = (1.0 - smoothstep(-2.2, -1.2, hbW)) * wHex;
    vec3 capT = mix(vec3(0.93, 1.0, 1.03), vec3(1.05, 1.0, 0.90), smoothstep(0.07, 0.34, uSunB.y));
    col *= mix(vec3(1.0), capT * (1.0 + 0.10 * (cA * 0.5 + cB * 0.35 * fwt(330.0, fp)) * fwt(140.0, fp)), inside * 0.75);
    // polar vortex: eye ~2 deg across (~2,000 km) ringed by a clumpy eyewall of bright towers, four logarithmic
    // spiral cloud arms converging on it, and an outer cloud rim
    float c = 90.0 - latDeg;
    float spiral = sin(4.0 * lon + 7.0 * log(max(c, 0.05)) + 1.2 * hjA);
    float eye = 1.0 - smoothstep(0.85, 1.5, c);
    float wall = exp(-pow((c - 1.8) / 0.4, 2.0)) * (0.6 + 0.8 * smoothstep(-0.3, 0.6, cB));
    float arms = (1.0 - smoothstep(2.5, 8.0, c)) * smoothstep(1.8, 2.6, c);
    col *= mix(vec3(1.0), vec3(1.02, 0.84, 0.72), eye * 0.75)
         * (1.0 - 0.25 * eye + 0.32 * wall * fwt(300.0, fp) + 0.12 * spiral * arms * fwt(150.0, fp) + 0.08 * exp(-pow((c - 3.0) / 0.45, 2.0)) * fwt(200.0, fp));
    hgt += (0.8 * wall * fwh(250.0, fp) + 0.15 * arms * spiral * fwh(400.0, fp)) / 300.0;
  }
  // south polar vortex (eye ~ 2 deg): summer side, a darker brown eye ringed by bright cloud
  {
    float c = 90.0 + latDeg;
    float sp1 = sin(-2.0 * lon + 5.0 * log(max(c, 0.05)));
    float eye = 1.0 - smoothstep(1.0, 2.0, c);
    float wall = exp(-pow((c - 2.3) / 0.45, 2.0));
    float arms = (1.0 - smoothstep(2.0, 7.0, c)) * smoothstep(1.8, 2.6, c);
    col *= 1.0 - 0.22 * eye + 0.14 * wall * fwt(200.0, fp) + 0.06 * arms * sp1 * fwt(100.0, fp);
    hgt += 0.7 * wall / 200.0 * fwh(200.0, fp);
  }

  col *= 1.0 + vAlb;

  // seasonal tint. The winter hemisphere loses its photochemical haze and turns azure / blue-grey (Cassini
  // 2004-2009 north, Hubble OPAL 2022-24 north again as autumn approached); the summer one is hazier and more
  // golden. Driven by the sub-solar latitude B (with ~2 yr of lag folded into the thresholds): B = -8 deg in late
  // 2026 -> northern winter tint; the 2017 solstice (B = +27) -> golden north, slightly blue south.
  {
    float Bs = degrees(asin(clamp(uSunB.y, -1.0, 1.0)));
    float wN = smoothstep(9.0, -9.0, Bs), wS = smoothstep(-9.0, 9.0, Bs);
    float al = abs(latDeg);
    float wl = 0.14 * smoothstep(6.0, 22.0, al) + 0.36 * smoothstep(22.0, 50.0, al) + 0.17 * smoothstep(56.0, 74.0, al);
    float wint = wl * (latDeg > 0.0 ? wN : wS);
    float summ = smoothstep(18.0, 60.0, al) * (latDeg > 0.0 ? wS : wN);
    float Yc = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, Yc * uWinter, wint);
    col = Yc + (col - Yc) * (1.0 + 0.18 * summ);   // summer hemisphere: hazier, more golden
  }

  // --- illumination
  float mu0 = dot(N, S);
  float mu = max(dot(N, V), 0.0);
  float mu0c = max(mu0, 0.0);
  // Minnaert limb darkening. k must not be < 1: with pow(mu, k - 1) that BRIGHTENS the sunward limb and the globe
  // reads as a flat disc. Saturn's continuum k ~ 1.0-1.05; the absorbing haze column adds a view-limb falloff that is
  // steeper in the blue (the limb goes deeper tan). The view term fades out toward the crescent (forward scattering).
  float k = 1.03;
  vec3 limbV = pow(vec3(max(mu, 0.02)), vec3(0.24, 0.30, 0.42) * smoothstep(-0.2, 0.7, dot(S, V)));
  // cloud-top relief (derivative bump of the resolved texture): grazing sunlight near the terminator picks out
  // eddies, filaments and convective towers; the geometric terminator still bounds the light
  vec3 dPx = dFdx(P), dPy = dFdy(P);
  vec3 r1 = cross(dPy, N), r2 = cross(N, dPx);
  float det = dot(dPx, r1);
  vec3 gradH = (dFdx(hgt) * r1 + dFdy(hgt) * r2) * (det < 0.0 ? -1.0 : 1.0) / max(abs(det), 1e-24);
  vec3 gB = 0.032 * gradH;
  float gl = length(gB);
  gB = gl < 0.35 ? gB : (gl < 1e20 ? gB * (0.35 / gl) : vec3(0.0)); // bounded slopes; NaN/inf -> flat
  if (uHeadlight > 1.5) gB = vec3(0.0); // dev: no relief
  vec3 Nb = normalize(N - gB);
  float mu0b = max(dot(Nb, S), 0.0) * smoothstep(-0.01, 0.03, mu0);
  float minn = pow(mu0b, k) * pow(max(mu, 0.02), k - 1.0);
  // haze: reddened grazing sunlight near the terminator, twilight just past it
  vec3 tauH = vec3(0.016, 0.027, 0.055);
  vec3 tSun = exp(-tauH * (1.0 / max(mu0c, 0.03) - 1.0));
  // twilight: the upper haze (100-300 km) stays sunlit up to ~5 deg past the terminator
  float tw = smoothstep(-0.09, 0.01, mu0) * (1.0 - smoothstep(-0.01, 0.07, mu0));
  vec3 twilight = vec3(0.58, 0.44, 0.27) * 0.05 * tw * tw;

  // ring shadow: sun ray to the ring plane, filtered transmission, solar-disc blur
  float tR = -P.y / S.y;
  vec3 X = P + S * max(tR, 0.0);
  float rX = length(X.xz) * SAT_RKM;
  float fpS = length(vec2(dFdx(rX), dFdy(rX)));
  float blur = max(tR, 0.0) * SAT_RKM * 2.0 * uSunAngR;
  float Tr = ringSunT(rX, ringLod(max(fpS, blur)));
  Tr = tR > 0.0 ? Tr : 1.0;

  // moon shadows
  float msh = 1.0;
  for (int j = 0; j < 6 + uSatZero; j++) {
    vec3 c = uMoons[j].xyz - P;
    float tc = dot(c, S);
    if (tc > 0.0) {
      float d = length(c - S * tc);
      float rm = uMoons[j].w;
      float pen = max(tc * uSunAngR, 1e-6);
      float o = 1.0 - smoothstep(rm - pen, rm + pen, d);
      msh *= 1.0 - o * min(1.0, (rm * rm) / (pen * pen));
    }
  }

  vec3 direct = col * minn * limbV * tSun * Tr * msh;

  // ringshine
  float lonS = atan(-S.z, S.x);
  float dl = abs(mod(lon - lonS + 3.14159265, 6.2831853) - 3.14159265);
  vec3 Ering = textureLod(uRingshine, vec2(dl / 3.14159265, lat / 3.14159265 + 0.5), 0.0).rgb;
  // ring light is pale tan; times the tan cloud albedo the product would read deep orange, while Cassini's
  // ringshine-lit night side looks tan-grey (the ring spectrum is flatter in the red than the globe's)
  vec3 rsCol = mix(col, vec3(dot(col, vec3(0.30, 0.50, 0.20))), 0.35);
  vec3 ringshine = rsCol * Ering * (0.6 + 0.4 * pow(max(mu, 0.02), 0.1)) * uNightLift;

  vec3 L = (direct + col * twilight * Tr + ringshine) * uSunColor; // haze over the disc: atmo.js
  gl_FragColor = vec4(satDisplay(L * uGain), 1.0);
}`;

export function createGlobe(ctx, shared, ringData) {
  const R = ctx.data.radius;
  const flat = shared.uFlat.value;
  const geo = new THREE.SphereGeometry(1, 384, 192);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uCamB: shared.uCamB,
      uSunB: shared.uSunB,
      uSunColor: ctx.U.uSunColor,
      uFlat: shared.uFlat,
      uDtDays: shared.uDtDays,
      uRingshine: shared.uRingshine,
      uMoons: shared.uMoonsB,
      uRingProf: { value: ringData.prof },
      uRingAlb: { value: ringData.alb },
      uRingFine: { value: ringData.fine },
      uRingM0: { value: ringData.m0 },
      uRingFineN: { value: ringData.tau.length },
      uSunAngR: shared.uSunAngR,
      uGain: shared.uGain,
      uHeadlight: { value: 0 },
      uNightLift: shared.uNightLift,
      uExposure: ctx.U.uExposure,
      uBand: { value: buildBandTexture() },
      uWinter: { value: new THREE.Vector3(...WINTER) },
      uStri: { value: buildStriationTexture() },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(R, R * flat, R);
  mesh.name = 'saturn-globe';
  return mesh;
}
