// dev: print the sky-irradiance LUT and sun transmittance near the terminator
import { earthAtmosphereParams, buildEarthLUTs, IRR_N } from '../atmo-lut.js';
const P = earthAtmosphereParams(6378.1 / 6371);
const L = buildEarthLUTs(P);
const E = L.raw.E;
for (const muS of [0.5, 0.2, 0.1, 0.05, 0.02, 0, -0.02, -0.05, -0.1, -0.2]) {
  const x = Math.max(0, Math.min(1, (muS + 0.35) / 1.35)) * (IRR_N - 1);
  const i = Math.min(IRR_N - 2, Math.floor(x)), a = x - i;
  const v = [0, 1, 2].map((c) => E[i * 3 + c] * (1 - a) + E[(i + 1) * 3 + c] * a);
  console.log(muS.toFixed(2), v.map((x) => x.toExponential(2)).join(' '), ' b/r', (v[2] / v[0]).toFixed(2));
}
