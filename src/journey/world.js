// Director's view of the solar system: where every body and moon is at any simulated day, its radius,
// shot frames (sun-relative azimuth/elevation), ring planes, and the safety list used by the clip guard.
// Moon positions always come from the body modules' moons[].positionAt so the camera matches what is drawn;
// a fallback model is used only while a body module is still a placeholder.
import * as THREE from 'three';
import { AU, DEG, poleVector, poleQuaternion, moonGeocentric, circularOrbitOffset } from '../core/astro.js';
import { BODIES, JOURNEY_ORDER } from '../core/bodies-data.js';
import { hash1 } from './math.js';

const ECL_N = new THREE.Vector3(0, 1, 0);
const KM = (km) => km / 6371;

// Minimum altitude (in body radii) the clip guard enforces, per body. Atmosphere shells are kept outside.
const MIN_ALT = {
  sun: 0.04,
  mercury: 0.02,
  venus: 0.03,
  earth: 0.03,
  moon: 0.0025,
  mars: 0.025,
  jupiter: 0.03,
  saturn: 0.03,
  uranus: 0.03,
  neptune: 0.03,
  titan: 0.25,
  triton: 0.02,
};

export function makeWorld(ctx) {
  const { positions, bodies } = ctx;
  const moonFns = {}; // id -> { parent, radius, name, fn(simDays, out) }

  function fallbackMoonFn(parent, m) {
    if (m.id === 'moon') return (d, out) => moonGeocentric(d, out);
    const pq = poleQuaternion(parent);
    let plane = pq;
    if (m.inclinationDeg) plane = pq.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), m.inclinationDeg * DEG));
    const a = m.aKm / 6371;
    const phase = hash1(m.aKm * 0.001) * 360;
    const period = m.inclinationDeg && m.inclinationDeg > 90 ? Math.abs(m.periodDays) : m.periodDays;
    return (d, out) => circularOrbitOffset(a, period, phase, d, plane, out);
  }

  for (const pid of JOURNEY_ORDER) {
    const data = BODIES[pid].moons;
    if (!data) continue;
    const mod = bodies[pid];
    for (const mid in data) {
      const m = data[mid];
      const live = mod?.moons?.find((x) => x.id === mid);
      let fn;
      let live_ = false;
      if (live && typeof live.positionAt === 'function') {
        fn = (d, out) => out.copy(live.positionAt(d));
        live_ = true;
      } else fn = fallbackMoonFn(pid, m);
      moonFns[mid] = { parent: pid, radius: live?.radius ?? m.radius, name: m.name, fn, live: live_ };
    }
  }

  const _t = new THREE.Vector3();
  function pos(id, d, out = new THREE.Vector3()) {
    if (id === 'sun') return out.set(0, 0, 0);
    if (positions[id]) return out.copy(positions[id]);
    const m = moonFns[id];
    if (m) return m.fn(d, out).add(positions[m.parent]);
    throw new Error('director: unknown body ' + id);
  }
  function radius(id) {
    if (BODIES[id]) return bodies[id]?.radius ?? BODIES[id].radius;
    if (moonFns[id]) return moonFns[id].radius;
    return 1;
  }
  function name(id) {
    return BODIES[id]?.name ?? moonFns[id]?.name ?? id;
  }

  // ---- shot frame: X = toward the Sun (flattened against `up`), Y = up, Z = X x Y.
  // dir(az, el) = cos(el) (cos(az) X - sin(az) Z) + sin(el) Y   (az = phase-like angle from the Sun direction)
  function frame(id, d, up = ECL_N, out = { X: new THREE.Vector3(), Y: new THREE.Vector3(), Z: new THREE.Vector3() }) {
    pos(id, d, _t);
    out.Y.copy(up).normalize();
    if (id === 'sun' || _t.lengthSq() === 0) out.X.set(1, 0, 0);
    else out.X.copy(_t).negate().normalize();
    out.X.addScaledVector(out.Y, -out.X.dot(out.Y));
    if (out.X.lengthSq() < 1e-10) out.X.set(1, 0, 0).addScaledVector(out.Y, -out.Y.x);
    out.X.normalize();
    out.Z.crossVectors(out.X, out.Y);
    return out;
  }
  function dirFrom(F, azDeg, elDeg, out = new THREE.Vector3()) {
    const az = azDeg * DEG, el = elDeg * DEG;
    const ce = Math.cos(el);
    return out
      .copy(F.X)
      .multiplyScalar(ce * Math.cos(az))
      .addScaledVector(F.Z, -ce * Math.sin(az))
      .addScaledVector(F.Y, Math.sin(el));
  }
  function azElOf(F, dir) {
    const n = dir.clone().normalize();
    return { az: Math.atan2(-n.dot(F.Z), n.dot(F.X)) / DEG, el: Math.asin(Math.max(-1, Math.min(1, n.dot(F.Y)))) / DEG };
  }

  // ---- safety list: spheres (bodies + moons) and ring annuli
  const spheres = [];
  for (const id of JOURNEY_ORDER) spheres.push({ id, parent: null, r: radius(id), minAlt: MIN_ALT[id] ?? 0.03 });
  for (const mid in moonFns) spheres.push({ id: mid, parent: moonFns[mid].parent, r: radius(mid), minAlt: MIN_ALT[mid] ?? 0.05 });
  const rings = [];
  const ringOf = (id, rInKm, rOutKm, hKm) => rings.push({ id, n: poleVector(id), rIn: KM(rInKm), rOut: KM(rOutKm), h: KM(hKm) });
  ringOf('saturn', 66900 * 0.98, 140230 * 1.02, 900);
  ringOf('uranus', 41837 * 0.98, 51149 * 1.03, 150);
  ringOf('neptune', 41900 * 0.98, 62932 * 1.02, 150);

  const poleCache = {};
  const pole = (id) => (poleCache[id] ||= poleVector(id));
  return { positions, bodies, moonFns, pos, radius, name, frame, dirFrom, azElOf, spheres, rings, pole, ECL_N, AU };
}
