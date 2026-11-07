import { earthAtmosphereParams, buildEarthLUTs, MS_N } from '../atmo-lut.js';
for (const a of [0.3, 0.15, 0.08]) {
  const P = earthAtmosphereParams(6378.1 / 6371); P.groundAlbedo = a;
  const { M } = buildEarthLUTs(P).raw;
  const at = (j, i) => [...M.slice((j * MS_N + i) * 3, (j * MS_N + i) * 3 + 3)].map((v) => v.toExponential(2));
  console.log('albedo', a, 'ground sun-zenith', at(0, MS_N - 1), ' 10km', at(5, MS_N - 1));
}
