import { earthAtmosphereParams, buildEarthLUTs, T_W, T_H, MS_N, IRR_N } from '../atmo-lut.js';
const P = earthAtmosphereParams(6378.1 / 6371);
const t0 = performance.now();
const L = buildEarthLUTs(P);
console.log('ms', (performance.now() - t0).toFixed(1));
const { T, M, E } = L.raw;
// zenith transmittance at ground (x_mu=0 at row 0? row j = x_r, ground is j=0; mu=1 is x_mu=0)
const g = (i, j) => [T[(j * T_W + i) * 3], T[(j * T_W + i) * 3 + 1], T[(j * T_W + i) * 3 + 2]].map((v) => v.toFixed(4));
console.log('T ground zenith', g(0, 0), 'ground horizon', g(T_W - 1, 0));
console.log('MS ground sun zenith', [...M.slice(((0) * MS_N + MS_N - 1) * 3, ((0) * MS_N + MS_N - 1) * 3 + 3)].map((v) => v.toExponential(2)));
for (const i of [0, 16, 20, 24, 30, 40, 63]) console.log('E sky', (-0.35 + (1.35 * i) / (IRR_N - 1)).toFixed(3), [...E.slice(i * 3, i * 3 + 3)].map((v) => v.toFixed(4)));
