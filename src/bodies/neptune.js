// Neptune and Triton. See src/bodies/neptune/* for the shaders and notes/neptune.md for how to view them.
import * as THREE from 'three';
import { bodyQuaternion, poleQuaternion } from '../core/astro.js';
import { T0, positionSphere } from './neptune/common.js';
import { makeGlobeMaterials } from './neptune/globe.js';
import { makeHazeMaterial } from './neptune/haze.js';
import { makeRings, ADAMS_RATE_DEG_PER_DAY } from './neptune/rings.js';
import { makeTriton } from './neptune/triton.js';

const DEG = Math.PI / 180;

export async function create(ctx) {
  const { data } = ctx;
  const R = data.radius;
  const f = data.flattening || 0.0171;
  const object = new THREE.Group();
  object.name = 'neptune';

  // ---------------------------------------------------------------- globe
  // two passes over the same geometry: the opaque deck, then the bright clouds blended over it (which also lay their
  // shadows on the deck through the blend). Two half-size shaders compile far faster than one (FXC is superlinear).
  const mats = makeGlobeMaterials(ctx, { radius: R, flat: f });
  const globeMat = { uniforms: mats.uniforms };
  const seg = ctx.quality === 'low' ? 192 : 320; // silhouette error < 0.05 px even when the disc fills the frame
  const globeGeo = positionSphere(THREE, R, seg, seg / 2);
  const globe = new THREE.Mesh(globeGeo, mats.deck);
  globe.scale.set(1, 1 - f, 1);
  globe.name = 'neptune-globe';
  object.add(globe);
  const cloudMesh = new THREE.Mesh(globeGeo, mats.clouds);
  cloudMesh.name = 'neptune-clouds';
  cloudMesh.renderOrder = 0.5; // after the deck, before the haze shell (1), rings (2) and Triton's haze (3)
  globe.add(cloudMesh);

  // ---------------------------------------------------------------- upper-atmosphere haze shell
  const TOP = 1.05;
  const hazeMat = makeHazeMaterial(ctx, { radius: R, flat: f, top: TOP });
  const haze = new THREE.Mesh(positionSphere(THREE, R * TOP, 192, 96), hazeMat);
  haze.scale.set(1, 1 - f, 1);
  haze.renderOrder = 1;
  haze.name = 'neptune-haze';
  object.add(haze);

  // ---------------------------------------------------------------- rings (equatorial plane, no spin)
  const poleQ = poleQuaternion('neptune');
  const rings = makeRings(ctx, { radius: R, flat: f });
  rings.mesh.quaternion.copy(poleQ);
  object.add(rings.mesh);
  const poleRot = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(poleQ));
  rings.uniforms.uRotW.value.copy(poleRot);
  rings.uniforms.uPoleW.value.set(0, 1, 0).applyQuaternion(poleQ);

  // ---------------------------------------------------------------- Triton
  const triton = await makeTriton(ctx, { data: data.moons.triton, poleQuat: poleQ });
  object.add(triton.group);
  globeMat.uniforms.uTritonR.value = triton.radius;
  // upload every texture now (asset load time) instead of at the first draw, so the warm-up only pays for programs
  if (ctx.renderer && ctx.renderer.initTexture) {
    for (const t of [mats.uniforms.uNoiseTex.value, mats.uniforms.uBandLut.value, ...triton.textures]) ctx.renderer.initTexture(t);
  }

  // Adams-ring arc longitude at T0, chosen so the arcs sit on the sunlit far arm of the ring in the backlit portrait
  const ARC0 = 100 * DEG;
  const nepAlbedo = new THREE.Vector3(0.1, 0.25, 0.5); // disc-averaged colour for Neptune-shine

  // dev-only overrides for inspection: ?nepRingGain=<x>&nepArc=<deg>&nepHaze=<gain>&nepDbg=<1 graticule | 2 no clouds | 4 cloud opacity>
  const qs = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  if (qs && qs.has('nepRingGain')) rings.uniforms.uGain.value = Number(qs.get('nepRingGain'));
  if (qs && qs.has('nepHaze')) hazeMat.uniforms.uGain.value = Number(qs.get('nepHaze'));
  if (qs && qs.has('nepDbg')) globeMat.uniforms.uDbg.value = Number(qs.get('nepDbg'));
  if (qs && qs.has('nepBandK')) globeMat.uniforms.uBandK.value = Number(qs.get('nepBandK'));
  const arcOverride = qs && qs.has('nepArc') ? Number(qs.get('nepArc')) * DEG : null;

  const q = new THREE.Quaternion();
  const m4 = new THREE.Matrix4();
  const centerW = new THREE.Vector3();

  return {
    id: 'neptune',
    radius: R,
    object,
    moons: [
      {
        id: 'triton',
        name: 'Triton',
        radius: triton.radius,
        positionAt: (d) => triton.positionAt(d),
      },
    ],
    update(frame) {
      const d = frame.simDays;
      const t = d - T0;
      bodyQuaternion('neptune', d, q);
      globe.quaternion.copy(q);
      haze.quaternion.copy(q);
      const rot = globeMat.uniforms.uRotW.value.setFromMatrix4(m4.makeRotationFromQuaternion(q));
      hazeMat.uniforms.uRotW.value.copy(rot);
      globeMat.uniforms.uT.value = t;
      mats.setTime(t);

      // planet centre in camera-relative world space (floating origin)
      centerW.copy(frame.positions.neptune).sub(frame.camUniverse);
      hazeMat.uniforms.uCenterW.value.copy(centerW);
      rings.uniforms.uCenterW.value.copy(centerW);
      // camera inside the haze shell -> draw its back faces
      const camD = centerW.length();
      hazeMat.uniforms.uInside.value = camD < R * TOP * 1.01;

      // arcs co-rotate at the Adams-ring mean motion (prograde)
      const arc = ((arcOverride ?? ARC0) + ((ADAMS_RATE_DEG_PER_DAY * t) % 360) * DEG) % (2 * Math.PI);
      rings.uniforms.uArc.value = arc;

      triton.update(frame, centerW, nepAlbedo);
      globeMat.uniforms.uTritonPosW.value.copy(centerW).add(triton.group.position);
    },
  };
}
