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
import { EARTH_RADIANCE_FRAG, EARTH_CLOUDS_FRAG, EARTH_GROUND_FRAG, EARTH_CLOUDLIGHT_FRAG, EARTH_CITY_FRAG } from './earth/earth-radiance.js';
import { createMoon } from './earth/moon.js';
import { getNoise3D } from './earth/noise3d.js';

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
  // upload every texture now (load time) rather than at its first draw inside the shader warm-up
  for (const t of [day, night, clouds, height, water, shelf, luts.transmittance, luts.multiScattering, luts.skyIrradiance]) ctx.renderer.initTexture(t);
  const noise3 = getNoise3D(ctx.renderer);
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
    uSeasonEdge: { value: new THREE.Vector3(72, -66, 58) },
    uPreC: { value: null },
    uPreG: { value: null },
    uPreS: { value: null },
    uShadowPass: { value: 0 },
    uTimeS: U.uTime,
    uRc: { value: Rp + 6.5 * KM },
    uAirglow: { value: 0.024 },
    uDebug: { value: Number(new URLSearchParams(globalThis.location?.search || "").get("earthDebug") || 0) },
    uDetail: { value: detail },
    uLoopMax: { value: 64 },
    uDay: { value: day },
    uNight: { value: night },
    uClouds: { value: clouds },
    uHeight: { value: height },
    uWater: { value: water },
    uShelf: { value: shelf },
    uNoise3: { value: noise3 },
  };

  const proxyR = (Rp + 290 * KM) * 1.002;
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

  // ---------------------------------------------------------------- prepasses (see earth/earth-radiance.js)
  // C: cloud field (packed half pairs, RGBA32F); C again as the shadow draw (-> S); G: ground radiance (reads C, S);
  // L: cloud radiance x coverage (reads C, overwrites S once G has consumed the shadow); Q: city lights (reads G,
  // overwrites C once G and L have consumed it). Drawn in update() with the
  // frame's camera at the drawing-buffer size, read by the radiance pass with texelFetch. Never-visible stand-ins in
  // the scene graph let the app's shader warm-up compile every program behind the splash.
  const preMat = (frag) => new THREE.ShaderMaterial({
    uniforms: radianceUniforms, vertexShader: EARTH_VERT, fragmentShader: frag,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
  const cloudMat = preMat(EARTH_CLOUDS_FRAG), groundMat = preMat(EARTH_GROUND_FRAG), lightMat = preMat(EARTH_CLOUDLIGHT_FRAG);
  const cityMat = preMat(EARTH_CITY_FRAG);
  for (const [m, n] of [[cloudMat, 'earth-clouds'], [groundMat, 'earth-ground'], [lightMat, 'earth-cloudlight'], [cityMat, 'earth-city']]) {
    const w = new THREE.Mesh(geo, m);
    w.name = n;
    w.visible = false;
    w.frustumCulled = false;
    object.add(w);
  }
  const preScene = new THREE.Scene();
  const preMesh = new THREE.Mesh(geo, cloudMat);
  preMesh.matrixAutoUpdate = false;
  preMesh.frustumCulled = false;
  preScene.add(preMesh);
  const rtOpts = (type) => ({ type, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
  const rtC = new THREE.WebGLRenderTarget(1, 1, rtOpts(THREE.FloatType));
  const rtG = new THREE.WebGLRenderTarget(1, 1, rtOpts(THREE.HalfFloatType));
  const rtS = new THREE.WebGLRenderTarget(1, 1, rtOpts(THREE.HalfFloatType));
  rtS.texture.name = 'earth.preS';
  radianceUniforms.uPreS.value = rtS.texture;
  rtC.texture.name = 'earth.preC';
  rtG.texture.name = 'earth.preG';
  radianceUniforms.uPreC.value = rtC.texture;
  radianceUniforms.uPreG.value = rtG.texture;
  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  const bsphere = new THREE.Sphere();
  const clearCol = new THREE.Color();
  function renderPrepasses(camera) {
    const res = U.uResolution.value;
    const w = Math.max(1, Math.round(res.x)), h = Math.max(1, Math.round(res.y));
    if (rtC.width !== w || rtC.height !== h) {
      rtC.setSize(w, h);
      rtG.setSize(w, h);
      rtS.setSize(w, h);
    }
    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView, camera.coordinateSystem, camera.reversedDepth);
    // off screen: skip the prepasses and the in-scene passes (the app's warm-up draws every object regardless, so no
    // program is compiled lazily)
    const inView = frustum.intersectsSphere(bsphere.set(centerW, proxyR));
    transmitMesh.visible = radianceMesh.visible = inView;
    if (!inView) return;
    preMesh.matrix.makeTranslation(centerW.x, centerW.y, centerW.z);
    preMesh.matrixWorld.copy(preMesh.matrix);
    const r = ctx.renderer;
    const prevRT = r.getRenderTarget();
    const prevAlpha = r.getClearAlpha();
    r.getClearColor(clearCol);
    r.setClearColor(0x000000, 0);
    for (const [rt, m, sp] of [[rtC, cloudMat, 0], [rtS, cloudMat, 1], [rtG, groundMat, 0], [rtS, lightMat, 0], [rtC, cityMat, 0]]) {
      preMesh.material = m;
      radianceUniforms.uShadowPass.value = sp;
      r.setRenderTarget(rt);
      r.clear(true, false, false);
      r.render(preScene, camera);
    }
    radianceUniforms.uShadowPass.value = 0;
    r.setClearColor(clearCol, prevAlpha);
    r.setRenderTarget(prevRT);
  }

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
      {
        // seasonal edges (the Blue Marble is a July map): Arctic ice 78N Sept .. 67N Mar, Antarctic 61S Sept .. 71S Feb,
        // NH snow line 41N Jan .. 75N Jul
        const sd = seasonDay(d), w = (2 * Math.PI) / 365.25;
        radianceUniforms.uSeasonEdge.value.set(72.5 + 5.5 * Math.cos(w * (sd - 255)), -66 + 5 * Math.cos(w * (sd - 263)), 58 - 17 * Math.cos(w * (sd - 20)));
      }
      radianceUniforms.uSunAngR.value = Math.asin(Math.min(1, U.uSunRadius.value / Math.max(object.position.length(), 1)));
      const camDist = centerW.length();
      const side = camDist < proxyR * 1.002 ? THREE.BackSide : THREE.FrontSide;
      if (transmitMat.side !== side) {
        transmitMat.side = side;
        radianceMat.side = side;
        cloudMat.side = side;
        groundMat.side = side;
        lightMat.side = side;
        cityMat.side = side;
      }
      moon.update(frame, { centerW, moonRel, earthQuatInv: qE });
      renderPrepasses(frame.camera);
    },
  };
}
