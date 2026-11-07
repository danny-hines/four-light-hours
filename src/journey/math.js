// Director math: Hermite splines (PCHIP / cardinal with tension), easing, direction slerp, camera basis.
// Everything here is pure and allocation-light; evaluate(t) calls these several times per frame.
import * as THREE from 'three';

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const smootherstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export const sigmoid = (x) => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)));

// ---------------------------------------------------------------------------------------------- Hermite track
// A scalar track through keys {t, v, m?}. Tangents: explicit m wins; otherwise 'pchip' (monotone, never
// overshoots: safe for altitudes, exposure, FOV) or 'cardinal' (Catmull-Rom with tension 0..1).
// Outside the key range the value is held constant (C1 when the end tangent is 0) or, with extrapolate,
// continued linearly along the end tangent.
export class Track {
  constructor(keys, { mode = 'pchip', tension = 0, extrapolate = false, c2 = false } = {}) {
    this.k = keys.slice().sort((a, b) => a.t - b.t);
    this.mode = mode;
    this.tension = tension;
    this.extrapolate = extrapolate;
    this.c2 = c2;
    this._tangents();
    if (c2) this._accels();
  }
  // C2 option: quintic Hermite segments with a second derivative at each key. The cubic segments on either side
  // of a key disagree about the acceleration there (the jump that reads as a kick when a held shot starts to
  // move); a minmod of the two (0 when they disagree in sign, 0 at the end keys) is continuous and never adds
  // overshoot the cubic did not have.
  _accels() {
    const k = this.k, n = k.length, m = this.m;
    const A = new Array(n).fill(0);
    const aL = (i) => {
      const h = k[i + 1].t - k[i].t;
      return (6 * (k[i + 1].v - k[i].v) / h - 4 * m[i] - 2 * m[i + 1]) / h;
    };
    const aR = (i) => {
      const h = k[i + 1].t - k[i].t;
      return (-6 * (k[i + 1].v - k[i].v) / h + 2 * m[i] + 4 * m[i + 1]) / h;
    };
    for (let i = 1; i < n - 1; i++) {
      const a = aR(i - 1), b = aL(i);
      A[i] = a * b <= 0 ? 0 : Math.sign(a) * Math.min(Math.abs(a), Math.abs(b));
      if (k[i].a !== undefined) A[i] = k[i].a;
    }
    if (n > 0 && k[0].a !== undefined) A[0] = k[0].a;
    if (n > 1 && k[n - 1].a !== undefined) A[n - 1] = k[n - 1].a;
    this.A = A;
  }
  _tangents() {
    const k = this.k, n = k.length;
    const m = new Array(n).fill(0);
    const hasM = (key) => key.m !== undefined && key.m !== null;
    if (n >= 2) {
      const d = [];
      for (let i = 0; i < n - 1; i++) d.push((k[i + 1].v - k[i].v) / Math.max(1e-9, k[i + 1].t - k[i].t));
      for (let i = 0; i < n; i++) {
        if (hasM(k[i])) {
          m[i] = k[i].m;
          continue;
        }
        if (i === 0 || i === n - 1) {
          m[i] = 0; // ease in/out at the ends unless told otherwise
          continue;
        }
        const h0 = k[i].t - k[i - 1].t, h1 = k[i + 1].t - k[i].t;
        if (this.mode === 'pchip') {
          if (d[i - 1] * d[i] <= 0) m[i] = 0;
          else {
            const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
          }
        } else {
          // non-uniform Catmull-Rom (weighted slope average), scaled by (1 - tension)
          m[i] = (1 - this.tension) * ((d[i - 1] * h1 + d[i] * h0) / (h0 + h1));
        }
      }
      // keep explicit-tangent neighbours monotone too
      if (this.mode === 'pchip') {
        for (let i = 0; i < n - 1; i++) {
          if (Math.abs(d[i]) < 1e-12) continue;
          const a = m[i] / d[i], b = m[i + 1] / d[i];
          const s = a * a + b * b;
          if (s > 9 && !hasM(k[i]) && !hasM(k[i + 1])) {
            const tau = 3 / Math.sqrt(s);
            m[i] = tau * a * d[i];
            m[i + 1] = tau * b * d[i];
          }
        }
      }
    }
    this.m = m;
  }
  get t0() {
    return this.k[0].t;
  }
  get t1() {
    return this.k[this.k.length - 1].t;
  }
  value(t) {
    const k = this.k, n = k.length;
    if (n === 1) return k[0].v;
    if (t <= k[0].t) return this.extrapolate ? k[0].v + this.m[0] * (t - k[0].t) : k[0].v;
    if (t >= k[n - 1].t) return this.extrapolate ? k[n - 1].v + this.m[n - 1] * (t - k[n - 1].t) : k[n - 1].v;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (k[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = k[lo], b = k[hi];
    const h = b.t - a.t;
    const s = (t - a.t) / h;
    const s2 = s * s, s3 = s2 * s;
    if (this.c2) {
      // quintic Hermite basis (position, slope, acceleration at both ends)
      const s4 = s3 * s, s5 = s4 * s;
      const H0 = 1 - 10 * s3 + 15 * s4 - 6 * s5, H1 = s - 6 * s3 + 8 * s4 - 3 * s5, H2 = 0.5 * (s2 - 3 * s3 + 3 * s4 - s5);
      const H3 = 10 * s3 - 15 * s4 + 6 * s5, H4 = -4 * s3 + 7 * s4 - 3 * s5, H5 = 0.5 * (s3 - 2 * s4 + s5);
      return H0 * a.v + H1 * h * this.m[lo] + H2 * h * h * this.A[lo] + H3 * b.v + H4 * h * this.m[hi] + H5 * h * h * this.A[hi];
    }
    return (2 * s3 - 3 * s2 + 1) * a.v + (s3 - 2 * s2 + s) * h * this.m[lo] + (-2 * s3 + 3 * s2) * b.v + (s3 - s2) * h * this.m[hi];
  }
  slope(t, dt = 1e-3) {
    return (this.value(t + dt) - this.value(t - dt)) / (2 * dt);
  }
}

// ---------------------------------------------------------------------------------------------- warp easing
// Normalised progress q(u) on [0,1] whose derivative ramps smoothly from m0 to a cruise value and back to m1:
// accelerate over [0, ua], cruise, decelerate over [1 - ub, 1]. q(0) = 0, q(1) = 1, q'(0) = m0, q'(1) = m1.
export function cruiseEase(u, m0, m1, ua, ub) {
  const c = (1 - (m0 * ua + m1 * ub) / 2) / (1 - (ua + ub) / 2);
  const I = (x) => x * x * x - (x * x * x * x) / 2; // integral of smoothstep on [0, x]
  if (u <= 0) return m0 * u;
  if (u >= 1) return 1 + m1 * (u - 1);
  let q = 0;
  // ramp-up part
  const x1 = Math.min(u, ua);
  q += m0 * x1 + (c - m0) * ua * I(x1 / ua);
  if (u <= ua) return q;
  const x2 = Math.min(u, 1 - ub);
  q += c * (x2 - ua);
  if (u <= 1 - ub) return q;
  // ramp-down: velocity = m1 + (c - m1) * S((1 - u)/ub)
  const y = (1 - u) / ub; // 1 -> 0
  // integral from (1-ub) to u of [m1 + (c-m1) S((1-x)/ub)] dx = m1 (u - (1-ub)) + (c - m1) ub (I(1) - I(y))
  q += m1 * (u - (1 - ub)) + (c - m1) * ub * (I(1) - I(y));
  return q;
}
export function cruiseEaseRate(u, m0, m1, ua, ub) {
  const c = (1 - (m0 * ua + m1 * ub) / 2) / (1 - (ua + ub) / 2);
  const S = (x) => x * x * (3 - 2 * x);
  if (u <= 0) return m0;
  if (u >= 1) return m1;
  if (u < ua) return m0 + (c - m0) * S(u / ua);
  if (u > 1 - ub) return m1 + (c - m1) * S((1 - u) / ub);
  return c;
}

// ---------------------------------------------------------------------------------------------- vectors
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

/** Spherical slerp of unit vectors a -> b by w; `axisHint` is used when they are (nearly) antipodal. */
export function slerpDir(a, b, w, out = new THREE.Vector3(), axisHint = null) {
  const d = clamp(a.dot(b), -1, 1);
  if (d > 0.999999) return out.copy(a).lerp(b, w).normalize();
  let axis = _a.crossVectors(a, b);
  const ang = Math.acos(d);
  if (axis.lengthSq() < 1e-10) {
    axis = _a.copy(axisHint || new THREE.Vector3(0, 1, 0));
    axis.addScaledVector(a, -axis.dot(a));
    if (axis.lengthSq() < 1e-10) axis.set(1, 0, 0).addScaledVector(a, -a.x);
  }
  axis.normalize();
  if (w >= 1) return out.copy(b);
  return out.copy(a).applyAxisAngle(axis, ang * w);
}

/**
 * Pan-style interpolation for wide swings (look back -> look ahead): longitude about `up` (in a fixed turning
 * direction `sign` = +1 / -1, or the short way when 0) and latitude interpolated separately. Unlike a
 * great-circle slerp it stays well defined when a and b are (nearly) opposite. Ends exactly on b.
 */
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _u = new THREE.Vector3();
export function panSlerp(a, b, w, up, refLon = 0, out = new THREE.Vector3()) {
  const u = _u.copy(up).normalize();
  _e1.copy(a).addScaledVector(u, -a.dot(u));
  if (_e1.lengthSq() < 1e-10) return slerpDir(a, b, w, out, up);
  _e1.normalize();
  _e2.crossVectors(u, _e1);
  const lat0 = Math.asin(clamp(a.dot(u), -1, 1)), lat1 = Math.asin(clamp(b.dot(u), -1, 1));
  // branch of the turning angle closest to the one measured at build time (refLon): continuous unless the
  // target jumps half way round during the blend
  let lon1 = Math.atan2(b.dot(_e2), b.dot(_e1));
  while (lon1 - refLon > Math.PI) lon1 -= 2 * Math.PI;
  while (lon1 - refLon < -Math.PI) lon1 += 2 * Math.PI;
  if (w >= 1) return out.copy(b);
  const lon = lon1 * w, lat = lat0 + (lat1 - lat0) * w;
  return out
    .copy(_e1)
    .multiplyScalar(Math.cos(lat) * Math.cos(lon))
    .addScaledVector(_e2, Math.cos(lat) * Math.sin(lon))
    .addScaledVector(u, Math.sin(lat));
}

/** Camera quaternion looking along `fwd` with `up` as the vertical reference (three.js cameras look down -z). */
const _m = new THREE.Matrix4();
export function lookQuat(fwd, up, out = new THREE.Quaternion()) {
  const z = _a.copy(fwd).normalize().negate();
  let x = _b.crossVectors(up, z);
  if (x.lengthSq() < 1e-8) {
    // up parallel to view: pick any perpendicular
    x = _b.crossVectors(Math.abs(z.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0), z);
  }
  x.normalize();
  const y = _c.crossVectors(z, x);
  _m.makeBasis(x, y, z);
  return out.setFromRotationMatrix(_m);
}

/** Wrap an angle (deg) to the branch nearest `ref`. */
export function unwrapDeg(a, ref) {
  while (a - ref > 180) a -= 360;
  while (a - ref < -180) a += 360;
  return a;
}

/** Cheap deterministic hash in [0,1). */
export function hash1(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}
