// Mars, Phobos and Deimos.
//   surface:    Viking MDIM colour (corrected toward true colour) + MOLA relief (de-terraced on the GPU) with
//               displacement, height-derived normals, terrain cast shadows, procedural craters at close range,
//               seasonal CO2 frost from the real season (Ls), dusty-atmosphere extinction, sky fill, twilight.
//   atmosphere: thin dust haze (Mie, forward scattering, blue-absorbing) + detached ice haze layer + CO2.
//   moons:      procedural irregular Phobos (Stickney, grooves) and Deimos, tidally locked on real orbits.
// See notes/mars.md.
import * as THREE from 'three';
import { bodyQuaternion, poleQuaternion, circularOrbitOffset, heliocentricPosition, KM_PER_UNIT } from '../core/astro.js';
import { buildRelief } from './mars/relief.js';
import { bakeMarsMaps } from './mars/bake.js';
import { createSurfaceMaterial } from './mars/surface.js';
import { createAtmosphereMaterial } from './mars/atmosphere.js';
import { createMoon } from './mars/moons.js';

// Orbital longitude of each moon from the IAU (WGCCRE 2009) rotation model: both moons rotate synchronously
// with their long axis toward Mars (prime meridian = sub-Mars point), so the moon's orbital longitude measured
// from the node of Mars' equator on the ICRF equator (= our frame's +x) is W + 180 deg. W includes the secular
// acceleration (T^2, T in Julian centuries) and the largest periodic terms (node precession / libration).
// Phobos: W = 35.06 + 1128.8445850 d + 8.864 T^2 - 1.42 sin M1 - 0.78 sin M2
//   M1 = 169.51 - 0.4357640 d, M2 = 192.93 + 1128.4096700 d + 8.864 T^2
// Deimos: W = 79.41 + 285.1618970 d - 0.520 T^2 - 2.58 sin M3 + 0.19 cos M3,   M3 = 53.47 - 0.0181510 d
const D2R = Math.PI / 180;
const MOON_ORBITS = {
  phobos: {
    aKm: 9376,
    rate: 1128.844585,
    lambda: (d) => {
      const T = d / 36525;
      const M1 = (169.51 - 0.435764 * d) * D2R, M2 = (192.93 + 1128.40967 * d + 8.864 * T * T) * D2R;
      return 35.06 + 180 + 8.864 * T * T - 1.42 * Math.sin(M1) - 0.78 * Math.sin(M2);
    },
  },
  deimos: {
    aKm: 23458,
    rate: 285.161897,
    lambda: (d) => {
      const T = d / 36525;
      const M3 = (53.47 - 0.018151 * d) * D2R;
      return 79.41 + 180 - 0.52 * T * T - 2.58 * Math.sin(M3) + 0.19 * Math.cos(M3);
    },
  },
};

// Seasonal north-cap edge latitude (deg) as a function of solar longitude Ls (deg); the south cap uses Ls+180.
const CAP_TABLE = [
  [0, 59], [20, 61.5], [40, 65], [60, 70], [75, 76], [90, 84], [150, 88], [180, 76], [210, 66], [240, 58], [270, 55], [330, 56], [360, 59],
];
function capEdge(ls) {
  ls = ((ls % 360) + 360) % 360;
  for (let i = 1; i < CAP_TABLE.length; i++) {
    const [a, va] = CAP_TABLE[i - 1], [b, vb] = CAP_TABLE[i];
    if (ls <= b) return va + ((vb - va) * (ls - a)) / (b - a);
  }
  return 59;
}

export async function create(ctx) {
  const { assets, U, data, quality } = ctx;
  const R = data.radius;
  const Rkm = data.radiusKm;
  const flattening = data.flattening ?? 0.00589;

  const [colorTex, heightTex, ranges] = await Promise.all([
    assets.loadTexture('mars/color.webp', { srgb: true, anisotropy: 16 }),
    assets.loadTexture('mars/height.webp', { srgb: false, mipmaps: false }),
    assets.loadJSON('height_ranges.json'),
  ]);
  const hr = ranges.mars || { min_km: -8.2469, max_km: 21.1491 };
  const relief = buildRelief(ctx, heightTex, { minKm: hr.min_km, maxKm: hr.max_km, radiusKm: Rkm });

  // ---- season (solar longitude) at the epoch: drives the seasonal frost caps ----
  const marsPos = ctx.positions.mars;
  const pole = new THREE.Vector3(0, 1, 0).applyQuaternion(poleQuaternion('mars'));
  // orbit normal from the motion over one day (planets are static during the film; this is only geometry)
  const vel = heliocentricPosition('mars', ctx.epochDays + 1).sub(heliocentricPosition('mars', ctx.epochDays));
  const orbitN = new THREE.Vector3().crossVectors(marsPos, vel).normalize();
  const nodeV = new THREE.Vector3().crossVectors(pole, orbitN).normalize();
  const sunFromMars = marsPos.clone().negate().normalize();
  const ls = (Math.atan2(sunFromMars.dot(new THREE.Vector3().crossVectors(orbitN, nodeV)), sunFromMars.dot(nodeV)) * 180) / Math.PI;
  const lsDeg = (ls + 360) % 360;
  const frostLat = capEdge(lsDeg);
  const frostLatS = capEdge(lsDeg + 180);

  const params = {
    radius: R,
    radiusKm: Rkm,
    flattening,
    exaggeration: 2.2,
    tau0: 0.12, // clear northern spring (MCS 9-um column ~0.05 -> visible extinction ~0.12)
    extScale: 0.6, // delta-Eddington: tau' = tau (1 - omega g^2) for the strongly forward-scattering dust
    Hdust: 9.5,
    detail: 1,
    frostLat,
    frostLatS,
    ls: lsDeg,
    topKm: 95,
    debug: 0,
  };
  // dev-only overrides (view=body testing): mars_tau, mars_exag, mars_frost, mars_dbg
  const qp = new URLSearchParams(globalThis.location ? globalThis.location.search : '');
  if (qp.has('mars_tau')) params.tau0 = Number(qp.get('mars_tau'));
  if (qp.has('mars_exag')) params.exaggeration = Number(qp.get('mars_exag'));
  if (qp.has('mars_frost')) params.frostLat = Number(qp.get('mars_frost'));
  if (qp.has('mars_dbg')) params.debug = Number(qp.get('mars_dbg'));
  if (qp.has('mars_detail')) params.detail = Number(qp.get('mars_detail'));

  const object = new THREE.Group();
  object.name = 'mars';
  const spin = new THREE.Group(); // body-fixed frame
  object.add(spin);

  const seg = quality === 'low' ? [384, 192] : quality === 'med' ? [576, 288] : [960, 480];
  // load-time bakes: geologic-age map and the polar-stereographic seasonal-frost maps
  const baked = bakeMarsMaps(ctx, { relief, colorTex, frostLat: params.frostLat, frostLatS: params.frostLatS });
  const surfMat = createSurfaceMaterial(ctx, { colorTex, relief, params, baked });
  // distance LODs: the full tessellation (displaced limb profile) only when close
  const surface = new THREE.LOD();
  surface.name = 'mars-surface';
  [
    [seg[0], seg[1], 0],
    [320, 160, 4.5 * R],
    [128, 64, 14 * R],
  ].forEach(([w, h, dist], i) => {
    const sphere = new THREE.SphereGeometry(R, w, h);
    sphere.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R * 1.01);
    const m = new THREE.Mesh(sphere, surfMat);
    m.name = 'mars-surface-lod' + i;
    surface.addLevel(m, dist);
  });
  spin.add(surface);

  const atmoMat = createAtmosphereMaterial(ctx, { params, relief });
  const shellGeo = new THREE.SphereGeometry(Rkm + params.topKm, 192, 96);
  shellGeo.scale(1, 1 - flattening, 1);
  shellGeo.computeBoundingSphere();
  const shell = new THREE.Mesh(shellGeo, atmoMat);
  shell.name = 'mars-atmosphere';
  shell.scale.setScalar(1 / KM_PER_UNIT);
  shell.renderOrder = 1;
  if (qp.get('mars_atm') !== '0') spin.add(shell); // dev: mars_atm=0 hides the haze shell entirely

  // ---- moons ----
  const poleQ = poleQuaternion('mars');
  const moonDefs = ['phobos', 'deimos'].map((id) => {
    const d = data.moons[id];
    const orb = MOON_ORBITS[id];
    const built = createMoon(ctx, id, { quality });
    object.add(built.mesh);
    const aUnits = orb.aKm / KM_PER_UNIT;
    const period = 360 / orb.rate;
    const positionAt = (simDays, out = new THREE.Vector3()) => circularOrbitOffset(aUnits, period, orb.lambda(simDays), simDays, poleQ, out);
    return { id, name: d.name, radius: d.radius, positionAt, built, aUnits };
  });

  // ---- per-frame ----
  const q = new THREE.Quaternion(), qi = new THREE.Quaternion();
  const tmp = new THREE.Vector3(), camRel = new THREE.Vector3(), L = new THREE.Vector3();
  const mq = new THREE.Quaternion(), mqi = new THREE.Quaternion(), basis = new THREE.Matrix4();
  const bx = new THREE.Vector3(), by = new THREE.Vector3(), bz = new THREE.Vector3();
  const poleW = new THREE.Vector3(0, 1, 0).applyQuaternion(poleQ);
  const moonOff = [new THREE.Vector3(), new THREE.Vector3()];
  const PROBE = qp.has('mars_probe');
  let lastProbe = '';

  function update(frame) {
    const d = frame.simDays;
    bodyQuaternion('mars', d, q);
    spin.quaternion.copy(q);
    qi.copy(q).invert();
    const pos = frame.positions?.mars || marsPos;
    camRel.copy(frame.camUniverse).sub(pos); // camera relative to Mars centre, world axes, scene units
    L.copy(pos).negate().normalize();
    const sunDistKm = pos.length() * KM_PER_UNIT;
    const sunAng = 695700 / Math.max(sunDistKm, 1e6);
    const cam = frame.camera;
    const res = U.uResolution.value;
    const pixAngle = (2 * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(res.y, 1);

    const su = surfMat.uniforms;
    su.uSunDir.value.copy(L).applyQuaternion(qi);
    su.uCamPos.value.copy(camRel).applyQuaternion(qi).divideScalar(R);
    if (PROBE) {
      // dev: sub-camera / sub-solar points and the view direction's ground point (mars_probe=1)
      const c = su.uCamPos.value, s = su.uSunDir.value;
      const ll = (v) => `${((Math.asin(v.y / v.length()) * 180) / Math.PI).toFixed(2)}N ${((Math.atan2(-v.z, v.x) * 180) / Math.PI).toFixed(2)}E`;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).applyQuaternion(qi);
      const b = c.dot(fwd), cc = c.lengthSq() - 1, disc = b * b - cc;
      const hit = disc > 0 ? c.clone().addScaledVector(fwd, -b - Math.sqrt(disc)) : null;
      const key = ll(c) + (hit ? ll(hit) : '');
      if (key !== lastProbe) {
        lastProbe = key;
        console.warn(`[mars probe] subcam ${ll(c)} alt ${((c.length() - 1) * Rkm).toFixed(0)} km | subsolar ${ll(s)} | view centre ${hit ? ll(hit) : 'sky'}`);
      }
    }
    su.uPixAngle.value = pixAngle;
    su.uSunAng.value = sunAng;

    const au = atmoMat.uniforms;
    au.uSunDir.value.copy(su.uSunDir.value);
    tmp.copy(camRel).applyQuaternion(qi).multiplyScalar(KM_PER_UNIT);
    tmp.y /= 1 - flattening;
    au.uCamKm.value.copy(tmp);
    au.uSunAng.value = sunAng;
    au.uPixAngle.value = pixAngle;
    // inside the shell: draw back faces without depth test (the haze lies in front of everything we see)
    const inside = tmp.length() < Rkm + params.topKm;
    au.uInside.value = inside ? 1 : 0;
    atmoMat.depthTest = !inside;

    moonDefs.forEach((m, i) => {
      const off = m.positionAt(d, moonOff[i]);
      const mesh = m.built.mesh;
      mesh.position.copy(off);
      // tidally locked: +x toward Mars, +y orbit north, +z along the orbital motion (leading apex)
      bx.copy(off).negate().normalize();
      by.copy(poleW);
      bz.crossVectors(bx, by).normalize();
      by.crossVectors(bz, bx).normalize();
      basis.makeBasis(bx, by, bz);
      mq.setFromRotationMatrix(basis);
      mesh.quaternion.copy(mq);
      mqi.copy(mq).invert();
      const u = m.built.uniforms;
      u.uSunDir.value.copy(L).applyQuaternion(mqi);
      u.uCamKm.value.copy(camRel).sub(off).applyQuaternion(mqi).multiplyScalar(KM_PER_UNIT);
      u.uMarsKm.value.copy(off).negate().applyQuaternion(mqi).multiplyScalar(KM_PER_UNIT);
      u.uPixAngle.value = pixAngle;
      u.uSunAng.value = sunAng;
      // moon shadows on Mars (body-fixed frame, Mars radii)
      const mv = i === 0 ? su.uMoonA.value : su.uMoonB.value;
      tmp.copy(off).applyQuaternion(qi).divideScalar(R);
      mv.set(tmp.x, tmp.y, tmp.z, m.built.rMean / Rkm);
    });
  }

  return {
    id: 'mars',
    radius: R,
    object,
    update,
    moons: moonDefs.map((m) => ({ id: m.id, name: m.name, radius: m.radius, positionAt: (days) => m.positionAt(days) })),
    season: { ls: lsDeg, frostLat },
  };
}
