// Derives the J2000 mean-longitude phases (in the frame of poleQuaternion('jupiter')) of the Galilean moons
// from JPL Horizons state vectors (Jupiter-centred, ecliptic J2000, km) at two dates, and reports the drift.
// Usage: node assets-src/scripts/jupiter_moon_phases.mjs
import * as THREE from 'three';
import { poleQuaternion, eclToThree, KM_PER_UNIT } from '../../src/core/astro.js';

// JPL Horizons API, CENTER=500@599, REF_PLANE=ECLIPTIC, REF_SYSTEM=ICRF, fetched 2026-11-03.
const H = {
  io:       { P: 1.769138, v: [[2461347.0, -3.386612567334967E+05, -2.533161928079829E+05, -1.402401375781406E+04], [2461357.0, -1.829978827029464E+04, 4.214420028095226E+05, 1.499484022292984E+04]] },
  europa:   { P: 3.551181, v: [[2461347.0, 2.170765420355333E+05, -6.370253611478491E+05, -1.478358695795765E+04], [2461357.0, -4.924835516966698E+05, -4.493589598496960E+05, -2.337988437007571E+04]] },
  ganymede: { P: 7.154553, v: [[2461347.0, -6.448755737591612E+05, -8.545727415274448E+05, -4.210110299749591E+04], [2461357.0, 1.023571990745173E+06, 3.040113570146132E+05, 2.659973262293653E+04]] },
  callisto: { P: 16.689017, v: [[2461347.0, -1.795737729142798E+06, -6.080398088672210E+05, -4.320773662506815E+04], [2461357.0, 1.070272449400234E+06, 1.536075201828657E+06, 6.251406116487330E+04]] },
};
const qInv = poleQuaternion('jupiter').invert();
for (const [id, { P, v }] of Object.entries(H)) {
  const out = [];
  for (const [jd, X, Y, Z] of v) {
    const d = jd - 2451545.0;
    const p = eclToThree(X, Y, Z).applyQuaternion(qInv);
    const th = Math.atan2(-p.z, p.x) * 180 / Math.PI;
    const lat = Math.asin(p.y / p.length()) * 180 / Math.PI;
    let phase = (th - 360 * d / P) % 360; if (phase < 0) phase += 360;
    out.push({ d, th: +th.toFixed(3), latDeg: +lat.toFixed(3), rKm: +p.length().toFixed(0), phase: +phase.toFixed(3) });
  }
  console.log(id, JSON.stringify(out));
}
