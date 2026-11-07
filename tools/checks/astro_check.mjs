// Sanity checks for src/core/astro.js (run: node tools/checks/astro_check.mjs)
import * as THREE from 'three';
import * as A from '../../src/core/astro.js';
const d = A.daysSinceJ2000(new Date('2026-11-02T12:00:00Z'));
const up = new THREE.Vector3(0, 1, 0);
for (const id of ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']) {
  const pole = A.poleVector(id);
  const pos = A.heliocentricPosition(id, d);
  const toSun = pos.clone().negate().normalize();
  const subsolarLat = 90 - pole.angleTo(toSun) / A.DEG;
  const lon = (Math.atan2(-pos.z, pos.x) / A.DEG + 360) % 360;
  console.log(id.padEnd(8), 'r', (pos.length() / A.AU).toFixed(3), 'AU  helio-lon', lon.toFixed(1), ' pole-vs-eclN', (pole.angleTo(up) / A.DEG).toFixed(2), ' subsolar-lat', subsolarLat.toFixed(1));
}
const q = A.bodyQuaternion('earth', 0);
const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
const X = x.x, Y = -x.z, Z = x.y, e = A.OBLIQUITY;
console.log('Earth prime meridian RA at J2000 (expect ~280.5):', ((Math.atan2(Math.cos(e) * Y - Math.sin(e) * Z, X) / A.DEG + 360) % 360).toFixed(2));
const qe = A.bodyQuaternion('earth', d).invert();
const s = A.heliocentricPosition('earth', d).negate().normalize().applyQuaternion(qe);
console.log('Earth subsolar lon/lat at 2026-11-02 12:00Z (expect ~ -4, -15):', (Math.atan2(-s.z, s.x) / A.DEG).toFixed(2), (Math.asin(s.y) / A.DEG).toFixed(2));
const m = A.moonGeocentric(d), sunDir = A.heliocentricPosition('earth', d).negate().normalize();
console.log('Moon elongation (deg):', (m.clone().normalize().angleTo(sunDir) / A.DEG).toFixed(1), ' dist (RE):', m.length().toFixed(1));
