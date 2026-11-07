// Dev helper for the jupiter piece: sub-camera longitude for view=body shots, GRS framing days, and moon-shadow
// transit windows for the default capture epoch. Usage: node assets-src/scripts/jupiter_find.mjs [phase] [el]
import * as THREE from 'three';
import { bodyQuaternion, poleQuaternion, circularOrbitOffset, heliocentricPosition, daysSinceJ2000, DEG } from '../../src/core/astro.js';
import { BODIES } from '../../src/core/bodies-data.js';
import { MOON_DEFS } from '../../src/bodies/jupiter/moons.js';

const epoch = daysSinceJ2000(new Date('2026-11-02T12:00:00Z'));
const J = heliocentricPosition('jupiter', epoch);
const R = BODIES.jupiter.radius, f = BODIES.jupiter.flattening;
const phase = Number(process.argv[2] ?? 20), el = Number(process.argv[3] ?? 5);
const up = new THREE.Vector3(0, 1, 0);
function camDir(ph, e) {
  const toRef = J.clone().negate().normalize();
  const dir = toRef.clone().applyAxisAngle(up, ph * DEG);
  const side = new THREE.Vector3().crossVectors(dir, up).normalize();
  return dir.applyAxisAngle(side, e * DEG).normalize();
}
function lonlat(vWorld, d) {
  const q = bodyQuaternion('jupiter', epoch + d).invert();
  const p = vWorld.clone().applyQuaternion(q);
  return [Math.atan2(-p.z, p.x) / DEG, Math.asin(p.y / p.length()) / DEG];
}
const sunDir = J.clone().negate().normalize();
console.log('sub-solar lat (deg, body frame):', lonlat(sunDir, 0)[1].toFixed(2));
// GRS (map lon -48.2) facing the camera
const cd = camDir(phase, el);
const LON_OFF = 0; // must match uLonOff in src/bodies/jupiter.js (map lon = body lon + off)
const grsLon = -48.2 - LON_OFF;
const hits = [];
for (let d = -0.05; d < 1.0; d += 0.0005) {
  const [lon] = lonlat(cd, d);
  let dl = ((lon - grsLon + 540) % 360) - 180;
  if (Math.abs(dl) < 0.23) hits.push(d.toFixed(4));
}
console.log(`GRS centred for phase=${phase} el=${el} at days:`, hits.join(' '));
// moon shadow transits: shadow centre on the disc, and visible from the camera direction
const qPole = poleQuaternion('jupiter');
for (const m of MOON_DEFS) {
  const md = BODIES.jupiter.moons[m.id];
  const a = md.aKm / 6371;
  let inT = false, t0 = 0;
  const out = [];
  for (let d = 0; d < 6; d += 0.001) {
    const off = circularOrbitOffset(a, md.periodDays, m.phase, epoch + d, qPole);
    const along = off.dot(sunDir);
    const perp = off.clone().addScaledVector(sunDir, -along);
    // shadow point on the planet (sphere approx)
    let on = along > 0 && perp.length() < R * 0.985;
    if (on) {
      const h = Math.sqrt(R * R - perp.lengthSq());
      const pt = perp.clone().addScaledVector(sunDir, h).normalize();
      on = pt.dot(cd) > 0.25;
    }
    if (on && !inT) { inT = true; t0 = d; }
    if (!on && inT) { inT = false; out.push(`${t0.toFixed(3)}..${d.toFixed(3)} (mid ${((t0 + d) / 2).toFixed(3)})`); }
  }
    console.log(`${m.id} shadow visible (phase ${phase}, el ${el}):`, out.join(', '));
  // where is the GRS (body lon) relative to the sub-camera meridian at each transit mid-time
  for (const w of out) { const mid = Number(w.split('mid ')[1].replace(')', '')); const [lc] = lonlat(cd, mid); console.log('   GRS offset from central meridian at', mid, ':', (((grsLon - lc) + 540) % 360 - 180).toFixed(1), 'deg (+ = east/right)'); }
}
