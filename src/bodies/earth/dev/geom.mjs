import * as THREE from 'three';
import { daysSinceJ2000, heliocentricPosition, moonGeocentric, bodyQuaternion, DEG } from '../../../core/astro.js';
const d = daysSinceJ2000(new Date('2026-11-02T12:00:00Z'));
const E = heliocentricPosition('earth', d);
const m = moonGeocentric(d);
const toSunFromMoon = E.clone().add(m).negate().normalize();
const toEarthFromMoon = m.clone().negate().normalize();
console.log('days', d, 'moon dist R', m.length());
console.log('angle sun-moon-earth (deg)', toSunFromMoon.angleTo(toEarthFromMoon)/DEG);
const toSunFromEarth = E.clone().negate().normalize();
console.log('elongation moon from sun seen from earth', toSunFromEarth.angleTo(m.clone().normalize())/DEG);
// camera for earthrise
const up = new THREE.Vector3(0,1,0);
for (const ph of [85,88,92]) {
  const dir = toEarthFromMoon.clone().applyAxisAngle(up, ph*DEG);
  console.log('phase', ph, 'sun elevation at sub-camera point (deg)', 90 - dir.angleTo(toSunFromMoon)/DEG);
}
// earth phase from moon: angle sun-earth-moon
console.log('earth phase angle seen from moon', toSunFromEarth.angleTo(m.clone().normalize())/DEG);
// earth sunlit hemisphere: sub-solar lon
const q = bodyQuaternion('earth', d);
const sLocal = toSunFromEarth.clone().applyQuaternion(q.clone().invert());
console.log('subsolar lat', Math.asin(sLocal.y)/DEG, 'lon', Math.atan2(-sLocal.z, sLocal.x)/DEG);
