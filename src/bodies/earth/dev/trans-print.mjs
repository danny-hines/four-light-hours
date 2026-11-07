// dev: sun transmittance (LUT, as the shader samples it) at a few heights / sun zenith cosines
import { earthAtmosphereParams, buildEarthLUTs, T_W, T_H, ATMO } from '../atmo-lut.js';
const KM = 1 / 6371;
const P = earthAtmosphereParams(6378.1 / 6371);
const { T } = buildEarthLUTs(P).raw;
const Rp = P.Rp, Rt = P.Rt;
function distToTop(r, mu) { return Math.max(0, -r * mu + Math.sqrt(Math.max(r * r * (mu * mu - 1) + Rt * Rt, 0))); }
function transLUT(r, mu) {
  r = Math.min(Math.max(r, Rp), Rt);
  const H = Math.sqrt(Rt * Rt - Rp * Rp), rho = Math.sqrt(Math.max(r * r - Rp * Rp, 0));
  const d = distToTop(r, mu), dMin = Rt - r, dMax = rho + H;
  const xm = (d - dMin) / Math.max(dMax - dMin, 1e-12), xr = rho / H;
  const fx = Math.max(0, Math.min(1, xm)) * (T_W - 1), fy = Math.max(0, Math.min(1, xr)) * (T_H - 1);
  const x0 = Math.min(T_W - 2, Math.floor(fx)), y0 = Math.min(T_H - 2, Math.floor(fy)), ax = fx - x0, ay = fy - y0;
  return [0, 1, 2].map((c) => { const a = T[(y0 * T_W + x0) * 3 + c], b = T[(y0 * T_W + x0 + 1) * 3 + c], cc = T[((y0 + 1) * T_W + x0) * 3 + c], dd = T[((y0 + 1) * T_W + x0 + 1) * 3 + c]; return (a * (1 - ax) + b * ax) * (1 - ay) + (cc * (1 - ax) + dd * ax) * ay; });
}
function sunTrans(r, mu) {
  const ratio = Rp / Math.max(r, Rp), muH = -Math.sqrt(Math.max(0, 1 - ratio * ratio));
  const vis = Math.min(1, Math.max(0, (mu - muH) / 0.0093 + 0.5));
  return transLUT(r, Math.max(mu, muH + 2e-4)).map((v) => v * vis);
}
for (const hk of [0.02, 2, 5, 10]) {
  const r = Rp + hk * ATMO.S * KM;
  console.log('h', hk, 'km:', [0.3, 0.1, 0.05, 0.02, 0, -0.02, -0.04, -0.06].map((mu) => mu + ':' + sunTrans(r, mu).map((v) => v.toFixed(3)).join('/')).join('  '));
}
