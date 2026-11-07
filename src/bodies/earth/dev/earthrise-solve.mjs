// Solve body-view (phase, el) with rel=earth so that the Sun is sunElev above the local horizontal and Earth sits
// eE above the geometric horizon, for a camera `altKm` above the Moon. Prints a shot.mjs query.
import * as THREE from 'three';
import { daysSinceJ2000, heliocentricPosition, moonGeocentric, DEG } from '../../../core/astro.js';
const [altKm = 15, sunElev = 8, eE = 1.0, days = 0] = process.argv.slice(2).map(Number);
const d = daysSinceJ2000(new Date('2026-11-02T12:00:00Z')) + days;
const E = heliocentricPosition('earth', d);
const M = E.clone().add(moonGeocentric(d));
const Rm = 1737.4 / 6371, dist = 1 + altKm / 1737.4;
const toEarth = E.clone().sub(M).normalize(), toSun = M.clone().negate().normalize();
const up = new THREE.Vector3(0, 1, 0);
const dip = Math.acos(1 / dist) / DEG;
let best = null;
for (let ph = -180; ph <= 180; ph += 0.25)
  for (let el = -89; el <= 89; el += 0.25) {
    const dir = toEarth.clone().applyAxisAngle(up, ph * DEG);
    const side = new THREE.Vector3().crossVectors(dir, up).normalize();
    dir.applyAxisAngle(side, el * DEG).normalize();
    const eEl = 90 - dir.angleTo(toEarth) / DEG + dip;  // Earth above the geometric horizon
    const sEl = 90 - dir.angleTo(toSun) / DEG;          // Sun above the local horizontal
    const err = (eEl - eE) ** 2 + (sEl - sunElev) ** 2 + 0.001 * el * el;
    if (!best || err < best.err) best = { err, ph, el, eEl, sEl };
  }
console.log(JSON.stringify(best));
console.log(`view=body&body=earth&target=moon&rel=earth&phase=${best.ph}&el=${best.el}&dist=${dist.toFixed(5)}&aim=earth&fov=12&days=${days}`);
