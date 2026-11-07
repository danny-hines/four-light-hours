// CPU side of Neptune's bright clouds: every frame, the list of filaments that exist at time t (days since T0) is
// built here as a pure function of t and uploaded as a flat uniform array, so the cloud shader is one short loop
// (all the band-cell bookkeeping, lifetimes and feature drift used to cost FXC ~0.4 s of compile time per program).
//
// Slot (3 x vec4): A = (lat0 rad, lon0 rad now, half-length rad of arc, sub-filament half-width rad),
//                  B = (opacity, seed, along-track noise offset, code = sub-filament count + 8 * envelope type),
//                  envelope type 0 = streak (blunt head, frayed tail), 1 = round blob, 2 = arc segment (cos^2 window,
//                  a partition of unity with its neighbours, so a segmented arc sums back to one continuous filament),
//                  C = (cos theta, sin theta, curvature, clump length rad): the filament's local frame is rotated by
//                  theta from east and bent into a parabola y' = curvature x'^2 (the GDS companion arcs).
import * as THREE from 'three';
import { windOmega } from './common.js';

const DEG = Math.PI / 180;
export const MAX_CLOUDS = 80;
const GDS_RATE = 360 * 24 * (1 / 18.3 - 1 / 16.11) * DEG;
const SC_RATE = 360 * 24 * (1 / 16.8 - 1 / 16.11) * DEG;
const DS2_RATE = 360 * 24 * (1 / 16.05 - 1 / 16.11) * DEG;
const SPF_RATE = 360 * 24 * (1 / 15.9663 - 1 / 16.11) * DEG;

// Persistent long cirrus streaks placed by hand (Voyager-like layout for the hero hemisphere): [lat deg, lon deg at T0,
// half-length deg of arc, half-width deg, opacity]. Each drifts with its latitude's wind.
const STREAKS = [
  [29.6, -112, 17, 0.42, 0.85],
  [31.9, -96, 10, 0.3, 0.6],
  [27.4, -42, 13, 0.36, 0.62],
  [30.6, -152, 8, 0.3, 0.5],
  [28.6, 40, 16, 0.4, 0.65],
  [31.2, 122, 12, 0.34, 0.55],
  [29.4, 175, 9, 0.3, 0.5],
  [43.6, -62, 7, 0.28, 0.42],
  [45.0, 100, 6, 0.25, 0.36],
  [-26.6, -122, 6, 0.24, 0.36],
  [-46.4, -58, 12, 0.34, 0.58],
  [-47.6, -104, 7, 0.25, 0.42],
  [-45.6, 62, 10, 0.3, 0.48],
  [-46.1, 160, 8, 0.3, 0.46],
  [-69.6, -92, 9, 0.3, 0.42],
  [-70.4, 92, 8, 0.28, 0.36],
  [62.0, -70, 7, 0.28, 0.26],
  [4.0, -40, 12, 0.4, 0.16],
];

// Active cloud bands: [lat deg, lat spread deg, cell width deg (divides 360), occupancy, opacity, max half-length deg,
// width scale]. Each band is cut into longitude cells drifting with the band's wind; a cell holds at most one streak,
// which lives 2-5 days and is then replaced; a slow activity wave along the band groups them with gaps.
const BANDS = [
  [29.5, 3.2, 20, 0.55, 0.6, 18, 1.0],
  [-46.5, 2.2, 24, 0.5, 0.5, 14, 0.9],
  [-69.8, 1.6, 30, 0.55, 0.42, 16, 0.85],
  [44.0, 2.2, 30, 0.42, 0.36, 10, 0.8],
  [-27.0, 2.5, 40, 0.28, 0.3, 9, 0.75],
  [4.0, 4.0, 45, 0.3, 0.13, 14, 1.1],
  [62.0, 3.0, 45, 0.35, 0.22, 9, 0.8],
  [-56.0, 2.0, 40, 0.22, 0.25, 6, 0.6],
];

// GDS companion arcs in the spot's ellipse-normalised frame: A = (centre angle, u per radian of angle, r0, r1),
// B = (opacity, seed, half-width in ellipse units, angular extent)
const ARCS = [
  { A: [-2.3, 5.5, 1.04, -0.06], B: [1.45, 1, 0.095, 0.55] }, // main hook along the south-west rim
  { A: [-1.9, 7.0, 1.2, 0], B: [0.6, 2, 0.04, 0.38] }, // thinner parallel arc just outside it
  { A: [2.8, 8.0, 0.82, 0], B: [0.45, 3, 0.05, 0.25] }, // curl of bright cloud inside the western end
  { A: [2.45, 6.0, 1.16, 0], B: [0.26, 6, 0.035, 0.3] }, // faint, broken cirrus arc on the N / NW edge
];

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
// integer hash -> [0, 1)
function hash(a, b, c) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ Math.imul(b | 0, 0xc2b2ae35), 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15) ^ Math.imul(c | 0, 0x165667b1), 0x85ebca6b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const wrapPi = (a) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
// sub-filament count of a streak: short streaks hold fewer (two converging filaments on a short streak close into an eye)
const subCount = (hl, wd, h) => {
  const nsMax = Math.min(4, Math.max(1, Math.floor(hl / (wd * 10))));
  return 1 + Math.floor(h * (nsMax - 0.01));
};

export function makeCloudList() {
  const A = Array.from({ length: MAX_CLOUDS }, () => new THREE.Vector4());
  const B = Array.from({ length: MAX_CLOUDS }, () => new THREE.Vector4());
  const C = Array.from({ length: MAX_CLOUDS }, () => new THREE.Vector4());
  const streakOm = STREAKS.map(([lat]) => windOmega(lat));
  const bandOm = BANDS.map(([lat]) => windOmega(lat));
  let n = 0;
  // theta: direction of the filament from east (rad); curv: y' = curv x'^2; wu: clump length (default 9 half-widths)
  const push = (lat, lon, hl, wd, op, seed, theta, ns, envType = 0, curv = 0, wu = 9 * wd, uoff = 0) => {
    if (n >= MAX_CLOUDS || op < 0.01) return;
    const ct = Math.cos(theta), st = Math.sin(theta);
    A[n].set(lat, wrapPi(lon), hl, wd);
    B[n].set(op, seed, uoff, ns + 8 * envType);
    C[n].set(ct, st, curv, wu);
    n++;
  };

  /** Fill the list for time t (days since T0); returns the slot count. Pure function of t. */
  function build(t) {
    n = 0;
    // ---- discrete features first (they must never be dropped)
    // GDS south-flank streaks, defined in the spot's tilted frame
    const latc = -17.5 * DEG;
    const lonc = -78 * DEG + GDS_RATE * t;
    const osc = Math.sin((2 * Math.PI * t) / 8);
    const tilt = 0.06 * osc - 0.04;
    const ay = 0.108 * (1 - 0.07 * osc);
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    const ax = 0.232 * (1 + 0.07 * osc);
    const toLL = (gx, gy) => [ct * gx + st * gy, -st * gx + ct * gy]; // tilted frame -> (east, north)
    for (const [gx, hl, wd, k0, op, seed] of [
      [-0.3, 0.4, 0.0085, 0.006, 1.0, 4], // broad bright streak under the spot's western half
      [-0.278, 0.232, 0.0035, -0.024, 0.45, 5],
    ]) {
      const slopeT = -0.0259;
      const [x0, y0] = toLL(gx, -1.12 * ay + slopeT * gx + k0);
      const [dx, dy] = toLL(1, slopeT);
      push(latc + y0, lonc + x0 / Math.cos(latc), hl, wd, op, seed, Math.atan2(dy, dx), 1);
    }
    // companion arcs: the curve r(d) = r0 + r1 d at angle a0 + d in the spot's ellipse frame, cut into segments
    // 0.3 rad of angle apart, each a rotated parabola with a cos^2 window reaching to its neighbours' centres (the
    // windows sum to one; segments share the seed and a continuous along-track noise coordinate)
    const sc = 0.5 * (ax + ay);
    const P = (a, r) => toLL(r * Math.cos(a) * ax, r * Math.sin(a) * ay);
    const SEG = 0.3;
    for (const { A: [a0, K, r0, r1], B: [op, seed, w, aws] } of ARCS) {
      const m = Math.ceil((2.2 * aws) / SEG);
      for (let k = -m; k <= m; k++) {
        const d = k * SEG;
        const wk = op * Math.exp(-0.5 * (d / aws) ** 2);
        if (wk < 0.02) continue;
        const a = a0 + d, rr = r0 + r1 * d, h = 0.02;
        const p0 = P(a, rr), pm = P(a - h, rr - r1 * h), pp = P(a + h, rr + r1 * h);
        const vx = (pp[0] - pm[0]) / (2 * h), vy = (pp[1] - pm[1]) / (2 * h);
        const axx = (pp[0] - 2 * p0[0] + pm[0]) / (h * h), ayy = (pp[1] - 2 * p0[1] + pm[1]) / (h * h);
        const sp = Math.hypot(vx, vy);
        const kappa = (vx * ayy - vy * axx) / (sp * sp * sp);
        push(latc + p0[1], lonc + p0[0] / Math.cos(latc), SEG * sp, w * sc, wk, seed, Math.atan2(vy, vx), 1, 2, 0.5 * kappa, sp / K, d * K);
      }
    }
    // the Scooter: lumpy core and two short tails trailing east (42 S, 16.8 h)
    const scLat = -42 * DEG, scLon = -120 * DEG + SC_RATE * t, cs = Math.cos(scLat);
    push(scLat, scLon, 0.026, 0.0095, 0.95, 21, 0, 1, 1);
    push(scLat + 0.006, scLon + 0.055 / cs, 0.055, 0.003, 0.5, 7, 0, 1);
    push(scLat - 0.009, scLon + 0.0375 / cs, 0.043, 0.0025, 0.4, 8, 0, 1);
    // Dark Spot 2's bright convective core (54 S, 16.05 h)
    const d2Lat = -54 * DEG;
    push(d2Lat + 0.0017, -142 * DEG + DS2_RATE * t + 0.008 / Math.cos(d2Lat), 0.015, 0.0068, 0.88, 33, 0, 1, 1);
    // South Polar Feature: small bright clouds near 70 S (15.966 h)
    for (let k = 0; k < 3; k++)
      push((-70.4 + 0.6 * k) * DEG, (-30 + 118 * k) * DEG + SPF_RATE * t, 0.04, 0.0045 + 0.0015 * k, 0.55 - 0.12 * k, 9 + k, 0, 1);
    // ---- persistent hand-placed streaks
    STREAKS.forEach(([lat, lon, hl, hw, op], i) => {
      const seed = 17.3 + i * 7.31;
      push(lat * DEG, lon * DEG + streakOm[i] * t, hl * DEG, hw * 0.5 * DEG, op, seed, Math.atan(-0.012), subCount(hl * DEG, hw * 0.5 * DEG, hash(i, 91, 7)));
    });
    // ---- procedural band streaks
    BANDS.forEach(([lat, spread, cell, occ, op, hlMax, ws], b) => {
      const nC = Math.round(360 / cell);
      const cellR = cell * DEG;
      const coslat = Math.cos(lat * DEG);
      for (let c = 0; c < nC; c++) {
        const lonCell = (c + 0.5) * cellR - Math.PI;
        const wave = 0.55 * Math.sin(2 * lonCell + 1.7 * b + 0.03 * t) + 0.45 * Math.sin(3 * lonCell - 2.3 * b - 0.021 * t);
        const act = 0.3 + 0.7 * smooth(-0.3, 0.3, wave);
        const h0 = hash(c, b, 1);
        const life = 2 + 3 * h0;
        const ph = t / life + h0;
        const ep = Math.floor(ph), fa = ph - ep;
        const hx = hash(c, b * 31 + 7, ep * 3 + 1);
        if (hx > occ * act) continue;
        const hy = hash(c, b * 31 + 8, ep * 3 + 2), hz = hash(c, b * 31 + 9, ep * 3 + 3);
        const h2x = hash(c + 101, b, ep), h2y = hash(c + 202, b, ep), h2z = hash(c + 303, b, ep);
        const fade = smooth(0, 0.12, fa) * smooth(1, 0.82, fa);
        const hl = mix(2, hlMax, hy * hy) * DEG * coslat;
        const lc = (c + 0.5 + (hz - 0.5) * 0.7) * cellR - Math.PI;
        const wd = mix(0.12, 0.45, h2y) * DEG * ws;
        const seed = ((hx * 13.1 + h2y * 7.7) % 1) * 89 + b;
        push((lat + (h2x - 0.5) * 2 * spread) * DEG, lc + bandOm[b] * t, hl, wd, op * fade * (0.6 + 0.4 * h2z), seed, Math.atan(-(h2z - 0.5) * 0.05), subCount(hl, wd, hash(c, b, ep * 7 + 5)));
      }
    });
    return n;
  }
  return { A, B, C, build };
}
const mix = (a, b, t) => a + (b - a) * t;
