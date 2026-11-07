// FALLBACK copy used by main.js when the real module fails to load. Do not edit.
// Visits every body in order: hold near it, then travel to the next with log-distance easing.
import * as THREE from 'three';
import { AU, DEG, TIME_SCALE } from '../core/astro.js';
import { BODIES, JOURNEY_ORDER } from '../core/bodies-data.js';

export async function create(ctx) {
  const { positions, bodies, epochDays } = ctx;
  const HOLD = 10, TRAVEL = 6, INTRO = 3;
  const chapters = [{ id: 'intro', title: 'Intro', t0: 0, t1: INTRO }];
  let t = INTRO;
  for (const id of JOURNEY_ORDER) {
    chapters.push({ id, body: id, title: BODIES[id].name, t0: t, t1: t + HOLD + TRAVEL });
    t += HOLD + TRAVEL;
  }
  const duration = t;
  const up = new THREE.Vector3(0, 1, 0);

  function viewPos(id, a, out = new THREE.Vector3()) {
    const c = positions[id];
    const R = bodies[id].radius;
    const toSun = c.lengthSq() > 0 ? c.clone().negate().normalize() : new THREE.Vector3(1, 0, 0);
    const dir = toSun.applyAxisAngle(up, (35 + 50 * a) * DEG);
    dir.y += 0.12;
    dir.normalize();
    return out.copy(c).addScaledVector(dir, R * (id === 'sun' ? 4 : 3.4));
  }

  const beltPos = positions.mars.clone().lerp(positions.jupiter, 0.35);
  beltPos.setLength(2.7 * AU);
  const beltDir = positions.jupiter.clone().sub(positions.mars).normalize();

  function evaluate(t) {
    t = Math.max(0, Math.min(duration, t));
    let ci = chapters.findIndex((c) => t >= c.t0 && t < c.t1);
    if (ci < 0) ci = chapters.length - 1;
    const ch = chapters[ci];
    const id = ch.body || 'sun';
    const camPos = new THREE.Vector3();
    let look = positions[id].clone();
    let warp = 0;
    if (!ch.body) {
      viewPos('sun', 0, camPos);
    } else {
      const lt = t - ch.t0;
      const nextId = JOURNEY_ORDER[JOURNEY_ORDER.indexOf(id) + 1];
      if (lt < HOLD || !nextId) {
        viewPos(id, Math.min(1, lt / HOLD), camPos);
      } else {
        const s = (lt - HOLD) / TRAVEL;
        const e = s * s * (3 - 2 * s);
        const a = viewPos(id, 1), b = viewPos(nextId, 0);
        camPos.lerpVectors(a, b, e);
        look = positions[id].clone().lerp(positions[nextId], THREE.MathUtils.smoothstep(s, 0.0, 0.35));
        warp = Math.sin(Math.PI * s);
      }
    }
    const m = new THREE.Matrix4().lookAt(camPos, look, up);
    return {
      camPos,
      camQuat: new THREE.Quaternion().setFromRotationMatrix(m),
      fov: 35,
      simDays: epochDays + (t * TIME_SCALE) / 86400,
      exposure: 1,
      warp,
      speedC: warp * 50,
      skyGain: 1,
      focus: id,
      chapter: ch.id,
      chapterIndex: ci,
      fade: 0,
      letterbox: 0,
    };
  }

  return { duration, chapters, evaluate, beltCrossing: { position: beltPos, direction: beltDir } };
}
