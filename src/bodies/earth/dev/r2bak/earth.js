// Earth and the Moon.
//
// Earth: analytic ray-traced globe inside an atmosphere proxy sphere (see earth/earth-glsl.js):
//   Blue Marble NG surface + relief, GGX ocean glint, seasonal sea ice & snow, advected cloud layer with shadows,
//   Black Marble city lights, Rayleigh/Mie/ozone atmosphere with multiple scattering (LUTs built on the CPU),
//   airglow, solar-eclipse shadow of the Moon.
// Moon: LRO colour + LOLA relief on a view-dependent displaced grid, lunar-Lambert/Hapke photometry with opposition
//   surge, procedural multi-scale craters with analytic shadows, earthshine, Earth's umbra (see earth/moon.js).
import * as THREE from 'three';
import { bodyQuaternion, moonGeocentric, dateFromDays, AU } from '../core/astro.js';
import { earthAtmosphereParams, buildEarthLUTs } from './earth/atmo-lut.js';
import { EARTH_VERT, EARTH_TRANSMIT_FRAG } from './earth/earth-glsl.js';
import { EARTH_RADIANCE_FRAG } from './earth/earth-radiance.js';
import { createMoon } from './earth/moon.js';

const KM = 1 / 6371;

export async function create(ctx) {
  const { U, assets, data, quality } = ctx;
  const Rp = data.radius;
  const P = earthAtmosphereParams(Rp);
  const object = new THREE.Group();
  object.name = 'earth';

  const tex = (p, srgb) => assets.loadTexture(p, { srgb, anisotropy: 16 });
  const [day, night, clouds, height, water, shelf] = await Promise.all([
    tex('earth/day.webp', true),
    tex('earth/night.webp', false),
    tex('earth/clouds.webp', false),
    tex('earth/height.webp', false),
    tex('earth/water_mask.webp', false),
    tex('earth/shelf.webp', false),
  ]);

  const luts = buildEarthLUTs(P);
  const detail = { low: 0.0, med: 0.6, high: 1.0 }[quality] ?? 1.0;

  const common = {
    uRp: { value: Rp },
    uRt: { value: P.Rt },
    uTransLUT: { value: luts.transmittance },
    uMsLUT: { value: luts.multiScattering },
    uIrrLUT: { value: luts.skyIrradiance },
    uCenterW: { value: new THREE.Vector3() },
  };
  const radianceUniforms = {
    ...common,
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uW2B: { value: new THREE.Matrix3() },
    uMoonRel: { value: new THREE.Vector3() },
    uMoonR: { value: data.moons.moon.radius },
    uSunAngR: { value: 0.00465 },
    uDays: { value: 0 },
    uFlow: { value: new THREE.Vector4(0, 0, 0, 1) },
    uSeedA: { value: new THREE.Vector3() },
    uSeedB: { value: new THREE.Vector3() },
    uSeason: { value: 300 },
    uTimeS: U.uTime,
    uRc: { value: Rp + 6.5 * KM },
    uAirglow: { value: 0.011 },
    uDebug: { value: Number(new URLSearchParams(globalThis.location?.search || "").get("earthDebug") || 0) },
    uDetail: { value: detail },
    uLoopMax: { value: 64 },
    uDay: { value: day },
    uNight: { value: night },
    uClouds: { value: clouds },
    uHeight: { value: height },
    uWater: { value: water },
    uShelf: { value: shelf },
  };

  const proxyR = (Rp + 115 * KM) * 1.004;
  const geo = new THREE.SphereGeometry(proxyR, 192, 96);
  const transmitMat = new THREE.ShaderMaterial({
    uniforms: common,
    vertexShader: EARTH_VERT,
    fragmentShader: EARTH_TRANSMIT_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const radianceMat = new THREE.ShaderMaterial({
    uniforms: radianceUniforms,
    vertexShader: EARTH_VERT,
    fragmentShader: EARTH_RADIANCE_FRAG,
    transparent: true,
    depthWrite: true,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  // created in this order on purpose: equal renderOrder & depth => three.js sorts by id (transmit first)
  const transmitMesh = new THREE.Mesh(geo, transmitMat);
  const radianceMesh = new THREE.Mesh(geo, radianceMat);
  transmitMesh.name = 'earth-transmit';
  radianceMesh.name = 'earth-radiance';
  transmitMesh.frustumCulled = radianceMesh.frustumCulled = false; // cheap vertex work; avoids reversed-depth culling issues
  object.add(transmitMesh, radianceMesh);

  // --------------------------------------------------------------------------------------------- the Moon
  const moon = await createMoon(ctx, { earthRp: Rp, luts, P });
  object.add(moon.object);

  const qE = new THREE.Quaternion();
  const m4 = new THREE.Matrix4();
  const centerW = new THREE.Vector3();
  const moonRel = new THREE.Vector3();

  // Cloud advection (see earth/clouds-glsl.js): bounded long-term drift + two-phase flow map with period FLOW_P.
  // Pure function of the simulated time; every phase re-seeds its procedural detail while its weight is zero.
  const FLOW_P = 0.4; // days
  const seedVec = (k, out) => {
    const h = (x) => { const v = Math.sin(x * 12.9898 + k * 78.233) * 43758.5453; return v - Math.floor(v); };
    return out.set(h(k + 0.1) * 200 - 100, h(k + 0.2) * 200 - 100, h(k + 0.3) * 200 - 100);
  };
  function cloudFlow(rel) {
    const u = radianceUniforms;
    const drift = 0.5 * Math.tanh(rel / 0.5);
    const c = rel / FLOW_P;
    const fa = c - Math.floor(c), fb = c + 0.5 - Math.floor(c + 0.5);
    u.uFlow.value.set(drift, (fa - 0.5) * FLOW_P, (fb - 0.5) * FLOW_P, 1 - Math.abs(2 * fa - 1));
    seedVec(Math.floor(c) * 2, u.uSeedA.value);
    seedVec(Math.floor(c + 0.5) * 2 + 1, u.uSeedB.value);
  }

  function seasonDay(simDays) {
    const d = dateFromDays(simDays);
    const y0 = Date.UTC(d.getUTCFullYear(), 0, 1);
    return (d.getTime() - y0) / 86400000;
  }

  return {
    id: 'earth',
    radius: Rp,
    object,
    moons: [moon.moonDef],
    update(frame) {
      const d = frame.simDays;
      centerW.copy(object.position).sub(frame.camUniverse);
      common.uCenterW.value.copy(centerW);
      radianceUniforms.uSunDir.value.copy(object.position).negate().normalize();
      bodyQuaternion('earth', d, qE);
      m4.makeRotationFromQuaternion(qE.invert());
      radianceUniforms.uW2B.value.setFromMatrix4(m4);
      moonGeocentric(d, moonRel);
      radianceUniforms.uMoonRel.value.copy(moonRel);
      radianceUniforms.uDays.value = d - ctx.epochDays;
      cloudFlow(d - ctx.epochDays);
      radianceUniforms.uSeason.value = seasonDay(d);
      radianceUniforms.uSunAngR.value = Math.asin(Math.min(1, U.uSunRadius.value / Math.max(object.position.length(), 1)));
      const camDist = centerW.length();
      const side = camDist < proxyR * 1.002 ? THREE.BackSide : THREE.FrontSide;
      if (transmitMat.side !== side) {
        transmitMat.side = side;
        radianceMat.side = side;
      }
      moon.update(frame, { centerW, moonRel, earthQuatInv: qE });
    },
  };
}
