// Dev helper for the jupiter piece: every interval in [d0, d1] days after the 2026-11-02T12:00Z epoch during which a
// Galilean moon's shadow centre lies on Jupiter's disc (any hemisphere). Usage: node jupiter_shadows.mjs [d0] [d1]
import * as THREE from 'three';
import { poleQuaternion, circularOrbitOffset, heliocentricPosition, daysSinceJ2000 } from '../../src/core/astro.js';
import { BODIES } from '../../src/core/bodies-data.js';
import { MOON_DEFS } from '../../src/bodies/jupiter/moons.js';
const epoch = daysSinceJ2000(new Date('2026-11-02T12:00:00Z'));
const J = heliocentricPosition('jupiter', epoch);
const R = BODIES.jupiter.radius;
const qP = poleQuaternion('jupiter');
const d0 = Number(process.argv[2] ?? 0), d1 = Number(process.argv[3] ?? 14);
const sun = J.clone().negate().normalize();      // direction to the Sun from Jupiter
for (const m of MOON_DEFS) {
  const md = BODIES.jupiter.moons[m.id];
  const a = md.aKm / 6371;
  let on = false, t0 = 0;
  const out = [];
  for (let d = d0; d <= d1; d += 0.001) {
    const p = circularOrbitOffset(a, md.periodDays, m.phase, epoch + d, qP, new THREE.Vector3());
    const along = p.dot(sun);
    const perp = p.clone().addScaledVector(sun, -along).length();
    const hit = along > 0 && perp < R;
    if (hit && !on) { on = true; t0 = d; }
    if (!hit && on) { on = false; out.push(`${t0.toFixed(3)}..${d.toFixed(3)}`); }
  }
  console.log(m.id.padEnd(9), out.join('  '));
}
