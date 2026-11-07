// dev: CPU port of the Earth shader's in-scattering march (marchSegment) for colour checks.
// node src/bodies/earth/dev/atmo-probe.mjs
import { earthAtmosphereParams, buildEarthLUTs, MS_N, T_W, T_H } from '../atmo-lut.js';

const KM = 1 / 6371;
const P = earthAtmosphereParams(6378.1 / 6371);
if (process.env.BR) P.betaR = process.env.BR.split(',').map((v) => +v * 1e-6 * 6.371e6);
if (process.env.BO) P.betaO = process.env.BO.split(',').map((v) => +v * 1e-6 * 6.371e6);
console.log('betaR', P.betaR.map((v) => (v / 6.371).toFixed(3)), 'betaO', P.betaO.map((v) => (v / 6.371).toFixed(3)));
const L = buildEarthLUTs(P);
const { T, M } = L.raw;
const Rp = P.Rp, Rt = P.Rt;

function distToTop(r, mu) { return Math.max(0, -r * mu + Math.sqrt(Math.max(r * r * (mu * mu - 1) + Rt * Rt, 0))); }
function transLUT(r, mu) {
  r = Math.min(Math.max(r, Rp), Rt);
  const H = Math.sqrt(Rt * Rt - Rp * Rp), rho = Math.sqrt(Math.max(r * r - Rp * Rp, 0));
  const d = distToTop(r, mu), dMin = Rt - r, dMax = rho + H;
  const xm = (d - dMin) / Math.max(dMax - dMin, 1e-12), xr = rho / H;
  const fx = Math.max(0, Math.min(1, xm)) * (T_W - 1), fy = Math.max(0, Math.min(1, xr)) * (T_H - 1);
  const x0 = Math.min(T_W - 2, Math.floor(fx)), y0 = Math.min(T_H - 2, Math.floor(fy)), ax = fx - x0, ay = fy - y0;
  const o = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = T[(y0 * T_W + x0) * 3 + c], b = T[(y0 * T_W + x0 + 1) * 3 + c], cc = T[((y0 + 1) * T_W + x0) * 3 + c], dd = T[((y0 + 1) * T_W + x0 + 1) * 3 + c];
    o[c] = (a * (1 - ax) + b * ax) * (1 - ay) + (cc * (1 - ax) + dd * ax) * ay;
  }
  return o;
}
function sunTrans(r, mu) {
  const ratio = Rp / Math.max(r, Rp);
  const muH = -Math.sqrt(Math.max(0, 1 - ratio * ratio));
  const vis = Math.min(1, Math.max(0, (mu - muH) / 0.0093 + 0.5));
  return transLUT(r, Math.max(mu, muH + 2e-4)).map((v) => v * vis);
}
function msLUT(r, muS) {
  const fx = Math.max(0, Math.min(MS_N - 1, ((muS + 1) / 2) * MS_N - 0.5));
  const fy = Math.max(0, Math.min(MS_N - 1, ((r - Rp) / (Rt - Rp)) * MS_N - 0.5));
  const x0 = Math.min(MS_N - 2, Math.floor(fx)), y0 = Math.min(MS_N - 2, Math.floor(fy)), ax = fx - x0, ay = fy - y0;
  const o = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = M[(y0 * MS_N + x0) * 3 + c], b = M[(y0 * MS_N + x0 + 1) * 3 + c], cc = M[((y0 + 1) * MS_N + x0) * 3 + c], dd = M[((y0 + 1) * MS_N + x0 + 1) * 3 + c];
    o[c] = (a * (1 - ax) + b * ax) * (1 - ay) + (cc * (1 - ax) + dd * ax) * ay;
  }
  return o;
}
const pR = (mu) => (3 / (16 * Math.PI)) * (1 + mu * mu);
const pM = (mu, g = 0.8) => (3 / (8 * Math.PI)) * ((1 - g * g) * (1 + mu * mu)) / ((2 + g * g) * Math.pow(Math.max(1 + g * g - 2 * g * mu, 1e-4), 1.5));

// fine reference march (N steps uniform), same physics as marchSegment; returns {L (contract units, x PI), T}
export function march(ro, rd, ta, tb, sun, N = 400, opts = {}) {
  const Lr = [0, 0, 0], Tr = [1, 1, 1];
  const nu = rd[0] * sun[0] + rd[1] * sun[1] + rd[2] * sun[2];
  const PR = pR(nu), PM = pM(nu);
  const dt = (tb - ta) / N;
  for (let i = 0; i < N; i++) {
    const t = ta + (i + 0.5) * dt;
    const p = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
    const r = Math.hypot(...p), h = r - Rp;
    const dR = Math.exp(-Math.max(h, 0) / P.HR);
    const hj = (h - 20 * KM) / (6 * KM);
    const dM = Math.exp(-Math.max(h, 0) / P.HM) + (opts.noJunge ? 0 : 0.118 * Math.exp(-hj * hj));
    const dO = opts.noOzone ? 0 : Math.max(0, 1 - Math.abs(h - P.hO) / P.wO);
    const muS = (p[0] * sun[0] + p[1] * sun[1] + p[2] * sun[2]) / r;
    const Ts = sunTrans(r, muS), ms = msLUT(r, muS);
    for (let c = 0; c < 3; c++) {
      const sR = P.betaR[c] * dR, sM = P.betaMs * dM;
      const ext = sR + P.betaMe * dM + P.betaO[c] * dO;
      const S = (sR * PR + sM * PM) * Ts[c] + (opts.noMS ? 0 : (sR + sM) * ms[c]);
      const e = Math.exp(-ext * dt);
      Lr[c] += Tr[c] * S * (1 - e) / Math.max(ext, 1e-9);
      Tr[c] *= e;
    }
  }
  return { L: Lr.map((v) => v * Math.PI), T: Tr };
}
function raySphere(ro, rd, R) {
  const b = ro[0] * rd[0] + ro[1] * rd[1] + ro[2] * rd[2];
  const q = [ro[0] - b * rd[0], ro[1] - b * rd[1], ro[2] - b * rd[2]];
  const h = R * R - (q[0] ** 2 + q[1] ** 2 + q[2] ** 2);
  if (h < 0) return null;
  return [-b - Math.sqrt(h), -b + Math.sqrt(h)];
}
const D = Math.PI / 180;
const fmt = (v) => v.map((x) => x.toFixed(4)).join(' ');
const rgbRatio = (v) => `R/G ${(v[0] / v[1]).toFixed(2)} B/G ${(v[2] / v[1]).toFixed(2)}`;

if (import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  // 1) ground observer: zenith sky with the sun at 30 deg elevation
  const ro = [0, Rp + 1e-5, 0];
  for (const el of [30, 10, 2]) {
    const sun = [Math.cos(el * D), Math.sin(el * D), 0];
    const z = march(ro, [0, 1, 0], 0, distToTop(Rp, 1), sun);
    const hz = [-Math.cos(3 * D), Math.sin(3 * D), 0]; // near-horizon, opposite the sun azimuth
    const h = march(ro, hz, 0, distToTop(Rp + 1e-5, Math.sin(3 * D)), sun);
    console.log(`ground sun ${el}: zenith ${fmt(z.L)} (${rgbRatio(z.L)})   anti-sun horizon ${fmt(h.L)} (${rgbRatio(h.L)})`);
  }
  // 2) orbit (400 km) looking down at the ground at view zenith angles, toward the sun azimuth, sun elevation at the ground
  for (const [vz, sunEl] of [[0, 45], [60, 30], [80, 20], [85, 15], [85, 5], [88, 10]]) {
    // ground point at origin-top; camera placed along the reversed view direction at 400 km altitude
    const g = [0, Rp, 0];
    const v = [Math.sin(vz * D), Math.cos(vz * D), 0];            // from ground toward camera (camera on the +x side)
    // sun toward -x (so we look toward the sun: forward scattering) and also toward +x (backscatter)
    for (const side of [-1, 1]) {
      const sun = [side * Math.cos(sunEl * D), Math.sin(sunEl * D), 0];
      const tc = raySphere(g, v, Rt)[1];
      const cam = [g[0] + v[0] * tc, g[1] + v[1] * tc, g[2] + v[2] * tc];
      const rd = v.map((x) => -x);
      const m = march(cam, rd, 0, tc, sun);
      const albedo = 0.06;    // ocean-ish
      const mu0 = Math.max(0, sun[1]);
      const Ts = sunTrans(Rp, sun[1]);
      const ground = Ts.map((x, c) => x * mu0 * albedo * m.T[c]);
      console.log(`view zen ${vz} sunEl ${sunEl} ${side < 0 ? 'toward sun ' : 'away       '}: path ${fmt(m.L)} (${rgbRatio(m.L)})  T ${fmt(m.T)}  ground(a=.06) ${fmt(ground)} total ${rgbRatio(m.L.map((x, c) => x + ground[c]))}`);
    }
  }
}
if (process.env.TANGENT) {
  // transmittance of a full tangent ray through the limb at tangent height h (both halves): T(h, mu=0)^2
  for (const h of [2, 5, 8, 12, 16, 20, 25, 30, 40]) {
    const t = transLUT(Rp + h * KM, 0).map((v) => v * v);
    const n = t.map((v) => v / Math.max(...t));
    console.log(`tangent ${h} km: T ${t.map((v) => v.toExponential(2)).join(' ')}  norm ${n.map((v) => v.toFixed(3)).join(' ')}`);
  }
  for (const el of [0, 2, 5, 10]) { const t = sunTrans(Rp + 1e-5, Math.sin(el * D)); console.log(`ground sun ${el} deg: ${fmt(t)} (G/R ${(t[1] / t[0]).toFixed(2)}, B/R ${(t[2] / t[0]).toFixed(2)})`); }
}
// the shader's quadratic-spaced march (marchSegment), for comparison with the fine reference
function marchQ(ro, rd, ta, tb, towardEnd, N, sun, acc) {
  const nu = rd[0] * sun[0] + rd[1] * sun[1] + rd[2] * sun[2];
  const PR = pR(nu), PM = pM(nu);
  const len = tb - ta; let prevX = 0;
  for (let i = 0; i < N; i++) {
    const s1 = (i + 1) / N;
    const x1 = towardEnd ? 1 - (1 - s1) * (1 - s1) : s1 * s1;
    const xm = 0.5 * (prevX + x1), dt = (x1 - prevX) * len; prevX = x1;
    const t = ta + xm * len;
    const p = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
    const r = Math.hypot(...p), h = r - Rp;
    const dR = Math.exp(-Math.max(h, 0) / P.HR), hj = (h - 20 * KM) / (6 * KM);
    const dM = Math.exp(-Math.max(h, 0) / P.HM) + 0.118 * Math.exp(-hj * hj);
    const dO = Math.max(0, 1 - Math.abs(h - P.hO) / P.wO);
    const muS = (p[0] * sun[0] + p[1] * sun[1] + p[2] * sun[2]) / r;
    const Ts = sunTrans(r, muS), ms = msLUT(r, muS);
    for (let c = 0; c < 3; c++) {
      const sR = P.betaR[c] * dR, sM = P.betaMs * dM, ext = sR + P.betaMe * dM + P.betaO[c] * dO;
      const S = (sR * PR + sM * PM) * Ts[c] + (sR + sM) * ms[c];
      const e = Math.exp(-ext * dt);
      acc.L[c] += acc.T[c] * S * (1 - e) / Math.max(ext, 1e-9); acc.T[c] *= e;
    }
  }
}
if (process.env.STEPS) {
  for (const [vz, sunEl] of [[60, 30], [80, 20], [85, 15], [85, 5], [88, 10]]) {
    const g = [0, Rp, 0], v = [Math.sin(vz * D), Math.cos(vz * D), 0];
    const sun = [-Math.cos(sunEl * D), Math.sin(sunEl * D), 0];
    const tc = raySphere(g, v, Rt)[1];
    const cam = [g[0] + v[0] * tc, g[1] + v[1] * tc, g[2] + v[2] * tc], rd = v.map((x) => -x);
    const ref = march(cam, rd, 0, tc, sun, 2000);
    const acc = { L: [0, 0, 0], T: [1, 1, 1] };
    const tCl = tc - 6.5 * KM / Math.cos(vz * D) * 0.0 - 0; // split near ground like the shader (cloud layer ~6.5 km)
    // find t where altitude = 6.5 km
    let tS = tc; for (let t = tc; t > 0; t -= 1e-5) { const p = [cam[0] + rd[0] * t, cam[1] + rd[1] * t, cam[2] + rd[2] * t]; if (Math.hypot(...p) - Rp > 6.5 * KM) { tS = t; break; } }
    marchQ(cam, rd, 0, tS, true, 18, sun, acc); const a2 = { L: [0, 0, 0], T: [1, 1, 1] }; marchQ(cam, rd, tS, tc, true, 6, sun, a2);
    const L = acc.L.map((x, c) => (x + acc.T[c] * a2.L[c]) * Math.PI), T = acc.T.map((x, c) => x * a2.T[c]);
    console.log(`vz ${vz} sun ${sunEl}: ref L ${fmt(ref.L)} T ${fmt(ref.T)} | shader L ${fmt(L)} T ${fmt(T)}`);
  }
}
if (process.env.CLOUDT) {
  for (const hk of [0, 2, 6.5]) for (const mu of [0.0, 0.02, 0.05, 0.1, 0.2]) { const t = sunTrans(Rp + hk * KM + 1e-6, mu); console.log(`h ${hk} km mu ${mu}: ${fmt(t)}  R/G ${(t[0] / t[1]).toFixed(2)}`); }
}
