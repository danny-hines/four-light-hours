// URANUS — the ice giant on its side, its narrow dark rings, and the five major moons.
// Piece files: src/bodies/uranus.js, src/bodies/uranus/*. See notes/uranus.md.
//
// Geometry is exact: the 97.8 deg tilt and retrograde 17.24 h spin come from bodyQuaternion('uranus'); rings and
// moon orbits lie in the equatorial plane from poleQuaternion('uranus'). In late 2026 the north pole is turned
// ~74 deg toward the Sun, so seen from the inner Solar System the rings and moon orbits make a near-face-on
// bullseye around a globe whose bright seasonal north polar cap sits near the centre of the disc.
import * as THREE from 'three';
import { bodyQuaternion, poleQuaternion } from '../core/astro.js';
import { makeShared } from './uranus/shared.js';
import { createGlobe } from './uranus/globe.js';
import { addRingUniforms, updateRingUniforms, createRings } from './uranus/rings.js';
import { createMoons } from './uranus/moons.js';
import { HORIZONS_EPOCH } from './uranus/orbits.js';

export async function create(ctx) {
  const R = ctx.data.radius;
  const object = new THREE.Group();
  object.name = 'uranus';

  const S = makeShared(ctx);
  addRingUniforms(S);
  // creation order matters for the stable transparent sort (same centre): haze shell first, then rings
  const globe = createGlobe(ctx, S);
  const rings = createRings(ctx, S);
  const moons = createMoons(ctx, S);
  object.add(globe.mesh, globe.shell, rings.mesh);
  for (const m of moons) object.add(m.mesh);

  const poleQ = poleQuaternion('uranus');
  rings.mesh.quaternion.copy(poleQ);
  S.uPoleBasis.value.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(poleQ));

  const qSpin = new THREE.Quaternion();
  const m4 = new THREE.Matrix4();
  const planetU = new THREE.Vector3();
  const off = new THREE.Vector3();
  const qm = new THREE.Quaternion();

  function update(frame) {
    const d = frame.simDays;
    planetU.copy(frame.positions.uranus);
    S.uPlanetW.value.copy(planetU).sub(frame.camUniverse);
    S.uSunDirW.value.copy(planetU).negate().normalize();
    S.uDays.value = d - HORIZONS_EPOCH;

    bodyQuaternion('uranus', d, qSpin);
    globe.mesh.quaternion.copy(qSpin);
    S.uSpinBasis.value.setFromMatrix4(m4.makeRotationFromQuaternion(qSpin));

    updateRingUniforms(S, d);

    moons.forEach((m, i) => {
      m.orbit.positionAt(d, off);
      m.mesh.position.copy(off);
      m.orbit.quaternionAt(d, qm);
      m.mesh.quaternion.copy(qm);
      const u = m.mat.uniforms;
      u.uCenterW.value.copy(S.uPlanetW.value).add(off);
      u.uBasis.value.setFromMatrix4(m4.makeRotationFromQuaternion(qm));
      S.uMoonPos.value[i].set(u.uCenterW.value.x, u.uCenterW.value.y, u.uCenterW.value.z, m.radius);
    });
  }

  return {
    id: 'uranus',
    radius: R,
    object,
    moons: moons.map((m) => ({
      id: m.id,
      name: m.name,
      radius: m.radius,
      positionAt: (simDays) => m.orbit.positionAt(simDays, new THREE.Vector3()),
    })),
    update,
  };
}
