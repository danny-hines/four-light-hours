// Astronomy core: units, time, ephemerides and body orientation.
//
// Units: 1 scene unit = 1 Earth radius = 6371 km. Everything is TRUE TO SCALE (sizes and distances).
// Frames:
//   ecliptic J2000 (X to vernal equinox, Z to ecliptic north)  ->  three.js world (x = X, y = Z, z = -Y)
//   so +y is ecliptic north and planets orbit counter-clockwise when seen from +y.
// Body-local frame (what a body's shader sees as object space after the orientation quaternion):
//   +y = north pole, +x = prime meridian (lon 0), -z = 90 deg East longitude.
//   lat = asin(p.y), lon = atan(-p.z, p.x)  -> matches three.js SphereGeometry UVs for an
//   equirectangular map with lon 0 at the horizontal centre and east to the right.
import * as THREE from 'three';

export const DEG = Math.PI / 180;
export const KM_PER_UNIT = 6371;
export const AU_KM = 149597870.7;
export const AU = AU_KM / KM_PER_UNIT; // 23481.07 scene units
export const C_KM_S = 299792.458;
export const LIGHT_SECONDS_PER_AU = AU_KM / C_KM_S; // ~499 s
export const OBLIQUITY = 23.4392911 * DEG;

// Simulated-clock acceleration used by the journey: 1 real second = TIME_SCALE simulated seconds.
export const TIME_SCALE = 1200;

export function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}
export function daysSinceJ2000(date) {
  return julianDay(date) - 2451545.0;
}
export function dateFromDays(d) {
  return new Date((d + 2451545.0 - 2440587.5) * 86400000);
}

// JPL "Keplerian Elements for Approximate Positions of the Major Planets" (Standish), 1800-2050.
// [a (AU), e, I (deg), L (deg), long.peri (deg), long.node (deg)] and their rates per Julian century.
const KEPLER = {
  mercury: [
    [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593],
    [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  ],
  venus: [
    [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255],
    [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
  ],
  earth: [
    [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
  ],
  mars: [
    [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  ],
  jupiter: [
    [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  ],
  saturn: [
    [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    [-0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  ],
  uranus: [
    [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503],
    [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  ],
  neptune: [
    [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
  ],
};
export const PLANET_IDS = Object.keys(KEPLER);

function solveKepler(M, e) {
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 12; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

/** Heliocentric ecliptic-J2000 position in AU as [X, Y, Z] (astronomical axes). */
export function heliocentricEclipticAU(id, d) {
  const k = KEPLER[id];
  if (!k) throw new Error('no elements for ' + id);
  const T = d / 36525;
  const [a, e, I, L, wbar, Om] = k[0].map((v, i) => v + k[1][i] * T);
  const w = (wbar - Om) * DEG;
  const O = Om * DEG;
  const inc = I * DEG;
  let M = ((L - wbar) % 360) * DEG;
  if (M > Math.PI) M -= 2 * Math.PI;
  if (M < -Math.PI) M += 2 * Math.PI;
  const E = solveKepler(M, e);
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(inc), sI = Math.sin(inc);
  return [
    (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    sw * sI * xp + cw * sI * yp,
  ];
}

/** Orbital elements (for drawing orbit ellipses): returns {a, e, I, w, O} in AU / radians at day d. */
export function orbitalElements(id, d) {
  const k = KEPLER[id];
  const T = d / 36525;
  const [a, e, I, , wbar, Om] = k[0].map((v, i) => v + k[1][i] * T);
  return { a, e, I: I * DEG, w: (wbar - Om) * DEG, O: Om * DEG };
}

/** Ecliptic [X,Y,Z] -> three.js Vector3 (x=X, y=Z, z=-Y). */
export function eclToThree(x, y, z, out = new THREE.Vector3()) {
  return out.set(x, z, -y);
}

/** Equatorial J2000 unit vector from RA/Dec (radians), returned in three.js world axes. */
export function radecToThree(ra, dec, out = new THREE.Vector3()) {
  const xe = Math.cos(dec) * Math.cos(ra), ye = Math.cos(dec) * Math.sin(ra), ze = Math.sin(dec);
  const ce = Math.cos(OBLIQUITY), se = Math.sin(OBLIQUITY);
  const X = xe, Y = ce * ye + se * ze, Z = -se * ye + ce * ze;
  return eclToThree(X, Y, Z, out);
}

/** Heliocentric position in scene units (three.js axes) for a planet at day d. */
export function heliocentricPosition(id, d, out = new THREE.Vector3()) {
  const [X, Y, Z] = heliocentricEclipticAU(id, d);
  return eclToThree(X * AU, Y * AU, Z * AU, out);
}

// IAU WGCCRE rotational elements (J2000 equatorial pole RA/Dec in deg, W0 deg, Wdot deg/day).
export const ROTATION = {
  sun: { ra: 286.13, dec: 63.87, W0: 84.176, Wd: 14.1844 },
  mercury: { ra: 281.0103, dec: 61.4155, W0: 329.5988, Wd: 6.1385108 },
  venus: { ra: 272.76, dec: 67.16, W0: 160.2, Wd: -1.4813688 },
  earth: { ra: 0.0, dec: 90.0, W0: 190.147, Wd: 360.9856235 },
  moon: { ra: 269.9949, dec: 66.5392, W0: 38.3213, Wd: 13.17635815 },
  mars: { ra: 317.269202, dec: 54.432516, W0: 176.049863, Wd: 350.891982443297 },
  jupiter: { ra: 268.056595, dec: 64.495303, W0: 284.95, Wd: 870.536 },
  saturn: { ra: 40.589, dec: 83.537, W0: 38.9, Wd: 810.7939024 },
  uranus: { ra: 257.311, dec: -15.175, W0: 203.81, Wd: -501.1600928 },
  neptune: { ra: 299.36, dec: 43.46, W0: 249.978, Wd: 541.1397757 },
};

// P maps astronomical (X,Y,Z) to three.js (X, Z, -Y); used to conjugate rotations into three.js axes.
const _P = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
const _Pinv = _P.clone().transpose();
const _mA = new THREE.Matrix4(), _mB = new THREE.Matrix4(), _mC = new THREE.Matrix4();

function equatorialFrameMatrix(rot, Wdeg, out) {
  // body-fixed -> ICRF equatorial: Rz(ra + 90) * Rx(90 - dec) * Rz(W)
  out.makeRotationZ((rot.ra + 90) * DEG);
  _mA.makeRotationX((90 - rot.dec) * DEG);
  out.multiply(_mA);
  _mA.makeRotationZ(Wdeg * DEG);
  out.multiply(_mA);
  // equatorial -> ecliptic: Rx(-obliquity)
  _mB.makeRotationX(-OBLIQUITY);
  out.premultiply(_mB);
  // conjugate into three.js axes
  _mC.copy(_P).multiply(out).multiply(_Pinv);
  return out.copy(_mC);
}

/**
 * Orientation of a body's local frame in world axes at day d (includes spin).
 * Pass a custom {ra,dec,W0,Wd} as `rot` for bodies not in ROTATION (e.g. moons you define).
 */
export function bodyQuaternion(id, d, out = new THREE.Quaternion(), rot = ROTATION[id]) {
  const m = new THREE.Matrix4();
  equatorialFrameMatrix(rot, rot.W0 + rot.Wd * d, m);
  return out.setFromRotationMatrix(m);
}

/** Orientation of a body's equatorial frame WITHOUT spin (W = 0): +y = pole. Use for rings and moon orbits. */
export function poleQuaternion(id, out = new THREE.Quaternion(), rot = ROTATION[id]) {
  const m = new THREE.Matrix4();
  equatorialFrameMatrix(rot, 0, m);
  return out.setFromRotationMatrix(m);
}

/** World-space unit vector of a body's north pole. */
export function poleVector(id, out = new THREE.Vector3()) {
  return out.set(0, 1, 0).applyQuaternion(poleQuaternion(id));
}

/**
 * Circular orbit helper for moons: position offset (scene units, world axes) from the parent's centre.
 * Orbit lies in the parent's equatorial plane unless `planeQuat` is given. Prograde for period > 0.
 * phaseDeg = mean longitude at J2000 measured from the frame's +x axis.
 */
export function circularOrbitOffset(aUnits, periodDays, phaseDeg, d, planeQuat, out = new THREE.Vector3()) {
  const th = (phaseDeg * DEG) + (2 * Math.PI * d) / periodDays;
  out.set(aUnits * Math.cos(th), 0, -aUnits * Math.sin(th));
  if (planeQuat) out.applyQuaternion(planeQuat);
  return out;
}

/** Geocentric Moon position (scene units, world axes) — low-precision but phase-accurate (~1-2 deg). */
export function moonGeocentric(d, out = new THREE.Vector3()) {
  const L = (218.316 + 13.176396 * d) * DEG; // mean longitude
  const M = (134.963 + 13.064993 * d) * DEG; // mean anomaly
  const F = (93.272 + 13.22935 * d) * DEG; // argument of latitude
  const lon = L + 6.289 * DEG * Math.sin(M);
  const lat = 5.128 * DEG * Math.sin(F);
  const distKm = 385001 - 20905 * Math.cos(M);
  const r = distKm / KM_PER_UNIT;
  return eclToThree(r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat), out);
}
