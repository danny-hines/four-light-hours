// Node-side director context. Moons come from the live ephemeris table written by ephem-dump.mjs (the body
// modules' own positionAt, sampled in the browser), so the offline director is the film the browser builds.
// Without the table the director falls back to its own moon models (and says so).
import * as THREE from 'three';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { U } from '../../core/uniforms.js';
import { BODIES, JOURNEY_ORDER } from '../../core/bodies-data.js';
import { daysSinceJ2000, heliocentricPosition } from '../../core/astro.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let TABLE = null;
try {
  TABLE = JSON.parse(fs.readFileSync(path.join(here, '.ephem.json'), 'utf8'));
} catch {
  TABLE = null;
}

function tableFn(m) {
  // cubic Hermite (Catmull-Rom) through the samples of the segment that covers d
  return (d) => {
    const s = m.segs.find((g) => d >= g.a && d <= g.a + g.n * g.step) || m.segs[0];
    let u = (d - s.a) / s.step;
    let i = Math.floor(u);
    if (i < 1) i = 1;
    if (i > s.n - 2) i = s.n - 2;
    const f = u - i;
    const out = new THREE.Vector3();
    const X = s.xs;
    for (let c = 0; c < 3; c++) {
      const p0 = X[(i - 1) * 3 + c], p1 = X[i * 3 + c], p2 = X[(i + 1) * 3 + c], p3 = X[(i + 2) * 3 + c];
      const m1 = (p2 - p0) / 2, m2 = (p3 - p1) / 2;
      const f2 = f * f, f3 = f2 * f;
      out.setComponent(c, (2 * f3 - 3 * f2 + 1) * p1 + (f3 - 2 * f2 + f) * m1 + (-2 * f3 + 3 * f2) * p2 + (f3 - f2) * m2);
    }
    return out;
  };
}

export function makeNodeCtx(epochISO) {
  const epochDays = daysSinceJ2000(new Date(epochISO));
  const positions = { sun: new THREE.Vector3() };
  for (const id of JOURNEY_ORDER) if (id !== 'sun') positions[id] = heliocentricPosition(id, epochDays);
  const bodies = {};
  let live = false;
  for (const id of JOURNEY_ORDER) {
    const moons = [];
    if (TABLE) {
      for (const [mid, m] of Object.entries(TABLE.moons)) {
        if (m.parent !== id) continue;
        const covered = m.segs.some((g) => epochDays >= g.a && epochDays + 45 <= g.a + g.n * g.step);
        if (!covered) continue;
        moons.push({ id: mid, name: m.name, radius: m.radius, positionAt: tableFn(m) });
        live = true;
      }
    }
    bodies[id] = { id, radius: TABLE?.radii?.[id] ?? BODIES[id].radius, object: new THREE.Group(), moons };
  }
  if (!live) console.warn('[node-ctx] no live ephemeris table for this epoch: using the director fallback moons');
  return { THREE, U, BODIES, epochDays, positions, bodies, quality: 'high', capture: true, scene: new THREE.Scene(), world: new THREE.Group(), live };
}
