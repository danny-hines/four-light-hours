// Jupiter atmosphere dynamics: zonal jet profile, per-latitude style parameters, the stretched-Mercator mapping of
// the turbulence tile, and the two flow clocks shared by every shader that draws the cloud deck.
//
// The zonal wind profile follows the Voyager/Cassini cloud-tracking profiles (Limaye 1986; Porco et al. 2003;
// Garcia-Melendo et al. 2011): System III speeds in m/s against PLANETOGRAPHIC latitude. Strongest prograde
// jet 23.7 N (NTBs), equatorial jets at +-7 deg with a slower equator, retrograde SEBs jet at ~18 S on the
// north edge of the Great Red Spot and the prograde STBn jet at ~26.5 S on its south edge, then alternating
// weaker jets poleward.
import * as THREE from 'three';

// [planetographic latitude deg, u m/s]
export const JETS = [
  [-90, 0], [-78, 4], [-72, 14], [-68, -6], [-64.5, 22], [-61, -6], [-57.5, 26], [-54, -12], [-49.8, 32],
  [-46.5, -8], [-43.2, 28], [-40.2, -18], [-36.6, 36], [-32.8, -16], [-30.0, -30], [-26.6, 46], [-24.0, 18],
  [-21.5, -20], [-18.6, -60], [-16.0, -28], [-13.0, 12], [-10.0, 60], [-7.2, 104], [-4.5, 80], [-1.5, 52],
  [1.0, 44], [3.5, 70], [6.8, 128], [9.0, 92], [12.0, 30], [15.0, -8], [17.6, -28], [20.0, 0], [21.8, 70],
  [23.7, 158], [25.4, 70], [27.4, 4], [30.8, -18], [33.4, 6], [35.6, 36], [38.0, 6], [39.6, -12], [43.0, 26],
  [46.0, -6], [48.6, 26], [52.0, -10], [55.8, 26], [59.0, -6], [61.6, 22], [65.0, -6], [68.4, 16], [74, 2], [90, 0],
];

// Turbulence / churn strength (1 = belt-like), "zoneness" (0 = belt, 1 = bright zone) and tracer contrast
// gain by latitude. [lat_g, turbulence, zoneness, contrast]
const STYLE = [
  [-90, 1.0, 0.6, 1.0], [-72, 1.0, 0.6, 1.0], [-64, 0.95, 0.5, 1.0], [-52, 0.8, 0.5, 0.9], [-42, 0.75, 0.6, 0.85],
  [-37, 0.6, 0.7, 0.8], [-33, 0.85, 0.3, 1.0], [-29, 0.75, 0.45, 0.9], [-26.5, 0.35, 0.55, 0.75], [-22, 0.5, 0.85, 0.7],
  [-19, 0.9, 0.4, 1.0], [-15, 1.15, 0.05, 1.15], [-10, 1.0, 0.1, 1.1], [-7.5, 0.55, 0.6, 0.85], [-3, 0.7, 0.85, 0.8],
  [3, 0.7, 0.85, 0.8], [6.5, 0.75, 0.5, 1.0], [9, 1.1, 0.05, 1.1], [13, 1.1, 0.0, 1.1], [17, 0.95, 0.2, 1.0],
  [20.5, 0.55, 0.8, 0.75], [23.7, 0.25, 0.4, 0.8], [26, 0.6, 0.3, 0.9], [30, 0.75, 0.6, 0.85], [35, 0.6, 0.5, 0.85],
  [42, 0.75, 0.5, 0.9], [52, 0.8, 0.5, 0.9], [62, 0.95, 0.5, 1.0], [72, 1.0, 0.6, 1.0], [90, 1.0, 0.6, 1.0],
];

function smoothTable(table, x, col = 1) {
  // Catmull-Rom through the table points (keeps jets smooth so the advected texture has no creases)
  let i = 0;
  while (i < table.length - 2 && x > table[i + 1][0]) i++;
  const p0 = table[Math.max(0, i - 1)], p1 = table[i], p2 = table[i + 1], p3 = table[Math.min(table.length - 1, i + 2)];
  const t = THREE.MathUtils.clamp((x - p1[0]) / (p2[0] - p1[0]), 0, 1);
  const m1 = (p2[col] - p0[col]) / Math.max(1e-6, p2[0] - p0[0]) * (p2[0] - p1[0]);
  const m2 = (p3[col] - p1[col]) / Math.max(1e-6, p3[0] - p1[0]) * (p2[0] - p1[0]);
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p1[col] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[col] + (t3 - t2) * m2;
}

export function jetSpeed(latgDeg) {
  return smoothTable(JETS, latgDeg, 1);
}

// Turbulence tile ("octave A") repeats this many times around the equator (18,700 km period); octave B is 8x finer.
export const TILE_N = 24;
export const LAT_N = 2048;

/**
 * Float32 latitude table, LAT_N x 2 texels, indexed by PLANETOCENTRIC latitude (read with texelFetch + manual lerp):
 *   row 0: u (m/s, System III), turbulence, zoneness, contrast gain
 *   row 1: Y (stretched-Mercator tile coordinate of octave A, in tiles), E-W stretch s, shear vorticity sense, |shear|
 * The tile is mapped conformally (Mercator: x = lon * N / 2pi, seamless because N is an integer), then compressed in y
 * by the local stretch s (strong shear -> streakier), integrated so the mapping stays smooth: dY/dphi = s N / (2 pi cos phi).
 */
// Steady-state shear "age" of the small-scale cloud structure by latitude (days). Shear continuously draws eddies out
// into streaks while convection and instabilities keep making new round ones, so the tracer is drawn in a permanently
// sheared state: old (long streaks) in the zones and on the jet flanks, young (round eddies) in the chaotic belts.
// The streak aspect ratio grows like the strain age * du/dy, capped (STRAIN_MAX).
export const STRAIN_MAX = 4.5;
function shearAge(lg) {
  const turb = smoothTable(STYLE, lg, 1);
  return THREE.MathUtils.lerp(3.0, 0.7, THREE.MathUtils.smoothstep(turb, 0.8, 1.12));
}
// Planetocentric latitude of the Great Red Spot (GRS_BODY in ../jupiter.js): the pre-shear displacement is measured
// from it, so the vortex and the bands right around it are barely displaced (no compression ripple around the spot).
const GRS_LATC = -19.5;

export function makeLatitudeTexture(flat = 0.06487) {
  const N = LAT_N;
  const ROWS = 3;
  const data = new Float32Array(N * ROWS * 4);
  const k = 1 - flat;
  const latgOf = (latc) => Math.atan2(Math.sin(latc), Math.cos(latc) * k * k);
  // shear and stretch, smoothed in latitude (Gaussian, sigma ~1.2 deg) so the mapping has no creases
  const raw = new Float32Array(N);
  const sh = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const latc = (-0.5 + (i + 0.5) / N) * Math.PI;
    const lg = (latgOf(latc) * 180) / Math.PI;
    const dudy = (jetSpeed(lg + 0.4) - jetSpeed(lg - 0.4)) / 0.8; // m/s per degree
    sh[i] = dudy;
    raw[i] = Math.min(1, Math.abs(dudy) / 38);
  }
  const sig = (1.2 / 180) * N;
  const sm = new Float32Array(N);
  const smSh = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let a = 0, b = 0, w = 0;
    for (let j = Math.max(0, i - 4 * sig | 0); j <= Math.min(N - 1, i + 4 * sig | 0); j++) {
      const g = Math.exp(-0.5 * ((j - i) / sig) ** 2);
      a += raw[j] * g; b += sh[j] * g; w += g;
    }
    sm[i] = a / w;
    smSh[i] = b / w;
  }
  const stretchAt = (i, latc) => {
    const pol = THREE.MathUtils.smoothstep(Math.abs(latc), 1.0, 1.15); // isotropic toward the polar caps
    return THREE.MathUtils.lerp(1.5 + 1.5 * Math.pow(sm[i], 0.7), 1.0, pol);
  };
  // integrate Y from the equator outward (midpoint rule on the table grid), capped near the poles
  const Y = new Float64Array(N);
  const dphi = Math.PI / N;
  const half = N / 2;
  for (let dir = -1; dir <= 1; dir += 2) {
    let acc = 0;
    for (let s = 0; s < half; s++) {
      const i = dir > 0 ? half + s : half - 1 - s;
      const latc = (-0.5 + (i + 0.5) / N) * Math.PI;
      const c = Math.max(Math.cos(latc), Math.cos(1.45));
      acc += (stretchAt(i, latc) * TILE_N) / (2 * Math.PI * c) * dphi * (s === 0 ? 0.5 : 1);
      Y[i] = dir * acc;
    }
  }
  for (let i = 0; i < N; i++) {
    const latc = (-0.5 + (i + 0.5) / N) * Math.PI;
    const lg = (latgOf(latc) * 180) / Math.PI;
    const o0 = i * 4, o1 = (N + i) * 4;
    data[o0 + 0] = jetSpeed(lg);
    data[o0 + 1] = smoothTable(STYLE, lg, 1);
    data[o0 + 2] = THREE.MathUtils.clamp(smoothTable(STYLE, lg, 2), 0, 1);
    data[o0 + 3] = smoothTable(STYLE, lg, 3);
    data[o1 + 0] = Y[i];
    data[o1 + 1] = stretchAt(i, latc);
    // relative vorticity sense of the shear, -du/dy (+ = cyclonic in the north), clamped
    data[o1 + 2] = THREE.MathUtils.clamp(-smSh[i] / 6, -1, 1);
    data[o1 + 3] = sm[i];
  }
  // row 2: pre-shear displacement D(y) = integral of age(y) * du/dy dy (km, eastward), so that dD/dy = age * du/dy is the
  // steady-state strain of the small-scale structure; measured from the GRS latitude. g = the local strain (signed).
  const dyKm = (Math.PI / N) * 71492;
  const D = new Float64Array(N);
  const strain = new Float64Array(N);
  let iG = 0;
  for (let i = 1; i < N; i++) {
    const latc0 = (-0.5 + (i - 0.5) / N) * Math.PI, latc1 = (-0.5 + (i + 0.5) / N) * Math.PI;
    const lg0 = (latgOf(latc0) * 180) / Math.PI, lg1 = (latgOf(latc1) * 180) / Math.PI;
    const du = jetSpeed(lg1) - jetSpeed(lg0);                    // m/s per grid step
    const age = shearAge(0.5 * (lg0 + lg1)) * 86400;              // s
    const pol = 1 - THREE.MathUtils.smoothstep(Math.abs(latc1), 1.13, 1.25);
    let s = (age * du) / (dyKm * 1000);                           // dimensionless strain
    s = THREE.MathUtils.clamp(s, -STRAIN_MAX, STRAIN_MAX) * pol;
    strain[i] = s;
    D[i] = D[i - 1] + s * dyKm;
    if (((-0.5 + (i + 0.5) / N) * 180) <= GRS_LATC) iG = i;
  }
  const D0 = D[iG];
  for (let i = 0; i < N; i++) {
    const o2 = (2 * N + i) * 4;
    data[o2 + 0] = D[i] - D0;
    data[o2 + 1] = strain[i];
    data[o2 + 2] = 0;
    data[o2 + 3] = 0;
  }
  const tex = new THREE.DataTexture(data, N, ROWS, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function hash1(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/**
 * Two-phase bounded advection clock with a flat-topped partition of unity. Phase k rests (tau = 0) at
 * rest + (j + k/2) * cycle. Each phase is shown alone while |tau| < cycle (1 - 1/sharp) / 4 and the cross-fade
 * takes the remaining part of each half cycle, so for most of the time only one phase is visible (no ghosting, no
 * breathing) and the field streams monotonically. tau is bounded by cycle/2, so shear can never shred the field.
 *   out.tau[k] : signed advection time (days) of phase k
 *   out.w[k]   : weights (w0 + w1 = 1)
 *   out.n[k]   : integer cycle index of phase k (re-seeding)
 */
export function flowClock(days, rest, cycle, sharp, out) {
  for (let k = 0; k < 2; k++) {
    const y = (days - rest) / cycle + 0.5 - 0.5 * k;
    const c = Math.floor(y);
    const f = y - c;
    out.tau[k] = (f - 0.5) * cycle;
    out.n[k] = 2 * c + k;
    out.tri[k] = 1 - Math.abs(2 * f - 1);
  }
  const x = THREE.MathUtils.clamp((out.tri[0] - 0.5) * sharp + 0.5, 0, 1);
  const s = x * x * (3 - 2 * x);
  out.w[0] = s;
  out.w[1] = 1 - s;
  return out;
}

export function makeClock() {
  return { tau: [0, 0], w: [1, 0], n: [0, 1], tri: [1, 0] };
}

export function seedOf(n, k) {
  return hash1(n * 3.17 + k * 11.3) * 997.0;
}
