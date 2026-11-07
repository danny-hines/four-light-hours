// Mercury — MESSENGER-grade airless world.
// Base data: USGS MESSENGER MDIS MD3 mosaic (natural-colour albedo) and USGS MESSENGER DEM v2, both under
// assets/mercury/ (see assets-src/scripts/mercury_assets.py). Procedural craters and micro-relief take over below
// the map resolution, so a pass a few tens of km above the surface stays crisp. See src/bodies/mercury/shaders.js.
import * as THREE from 'three';
import { bodyQuaternion } from '../core/astro.js';
import { MERCURY_VERT_RELIEF, MERCURY_FRAG, MERCURY_AUX_FRAG } from './mercury/shaders.js';

const DEM_SPHERE_KM = 2439.4; // DEM / mosaic reference sphere

export async function create(ctx) {
  const { U, assets, data, quality } = ctx;
  const R = data.radius;
  const object = new THREE.Group();
  object.name = 'mercury';

  const [meta, albedo, tint, density, dem, detail] = await Promise.all([
    assets.loadJSON('mercury/meta.json'),
    assets.loadTexture('mercury/albedo.webp', { srgb: false, anisotropy: 16 }),
    assets.loadTexture('mercury/tint.webp', { srgb: true, anisotropy: 4 }),
    assets.loadTexture('mercury/density.webp', { srgb: false, anisotropy: 1 }),
    assets.loadTexture('mercury/dem.webp', { srgb: false, anisotropy: 1 }),
    assets.loadTexture('mercury/detail.webp', { srgb: false, anisotropy: 8, wrapT: THREE.RepeatWrapping }),
  ]);

  // upload now (load time), not at the first frame that draws Mercury
  if (ctx.renderer.initTexture) for (const t of [albedo, tint, density, dem, detail]) ctx.renderer.initTexture(t);

  // Packed DEM for the exact float B-spline (see bsplineDem in shaders.js): texel (X, Y) of a (W, H + 3) RGBA8
  // target holds the coefficients c(X-1, Y-2), c(X, Y-2), c(X-1, Y-1), c(X, Y-1) (longitude wrapped, rows clamped).
  // Built once on the GPU; 8-bit values pass through exactly.
  const demP = (() => {
    const W = dem.image.width, H = dem.image.height;
    const rt = new THREE.WebGLRenderTarget(W, H + 3, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    rt.texture.name = 'mercury.demPacked';
    const mat = new THREE.ShaderMaterial({
      uniforms: { uDem: { value: dem } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D uDem;
        float c(int x, int y, ivec2 sz) {
          x = x < 0 ? x + sz.x : (x >= sz.x ? x - sz.x : x);
          return texelFetch(uDem, ivec2(x, clamp(y, 0, sz.y - 1)), 0).r;
        }
        void main() {
          ivec2 sz = textureSize(uDem, 0);
          ivec2 p = ivec2(gl_FragCoord.xy);
          gl_FragColor = vec4(c(p.x - 1, p.y - 2, sz), c(p.x, p.y - 2, sz), c(p.x - 1, p.y - 1, sz), c(p.x, p.y - 1, sz));
        }`,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    const sc = new THREE.Scene();
    sc.add(quad);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const r = ctx.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(rt);
    r.render(sc, cam);
    r.setRenderTarget(prev);
    mat.dispose();
    quad.geometry.dispose();
    return rt.texture;
  })();

  // Aux map (equirectangular 2048x1024, RGBA8): r = crater patchiness noise (was two value noises per pixel in both the
  // march and the shading), g = the crater-density map. Built once on the GPU; the march and the shading read the same
  // texels (textureLod 0), so their crater acceptance agrees exactly.
  const aux = (() => {
    const W = 2048, H = 1024;
    const rt = new THREE.WebGLRenderTarget(W, H, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping,
    });
    rt.texture.name = 'mercury.aux';
    const mat = new THREE.ShaderMaterial({
      uniforms: { uDensity: { value: density }, uSize: { value: new THREE.Vector2(W, H) } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: MERCURY_AUX_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    const sc = new THREE.Scene();
    sc.add(quad);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const r = ctx.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(rt);
    r.render(sc, cam);
    r.setRenderTarget(prev);
    mat.dispose();
    quad.geometry.dispose();
    return rt.texture;
  })();

  // Tileable 3D value noise (lattice period 16, 4 voxels per cell, quintic fade, deterministic): the value-only noise of
  // the crater clumping and the crest roughness as one texture fetch (see tnoise in shaders.js)
  const noise3 = (() => {
    const P = 16, V = 4, S = P * V;
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
      return seed / 4294967296;
    };
    const lat = new Float32Array(P * P * P);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    const L = (x, y, z) => lat[((z % P) * P + (y % P)) * P + (x % P)];
    const fade = (w) => w * w * w * (w * (w * 6 - 15) + 10);
    const data = new Uint8Array(S * S * S);
    for (let z = 0; z < S; z++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const px = (x + 0.5) / V, py = (y + 0.5) / V, pz = (z + 0.5) / V;
      const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
      const ux = fade(px - ix), uy = fade(py - iy), uz = fade(pz - iz);
      const m = (a, b, t) => a + (b - a) * t;
      const v = m(m(m(L(ix, iy, iz), L(ix + 1, iy, iz), ux), m(L(ix, iy + 1, iz), L(ix + 1, iy + 1, iz), ux), uy),
                  m(m(L(ix, iy, iz + 1), L(ix + 1, iy, iz + 1), ux), m(L(ix, iy + 1, iz + 1), L(ix + 1, iy + 1, iz + 1), ux), uy), uz);
      data[(z * S + y) * S + x] = Math.round(v * 255);
    }
    const t = new THREE.Data3DTexture(data, S, S, S);
    t.format = THREE.RedFormat;
    t.type = THREE.UnsignedByteType;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
    t.generateMipmaps = false;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    if (ctx.renderer.initTexture) ctx.renderer.initTexture(t);
    return t;
  })();

  const kmToR = 1 / DEM_SPHERE_KM;
  const demMin = meta.dem.min_km * kmToR;
  const demScale = (meta.dem.max_km - meta.dem.min_km) * kmToR;

  // warm, slightly brownish grey (Mercury's reflectance rises toward the red), luminance-normalised
  const base = new THREE.Vector3(1.0, 0.94, 0.87);
  base.divideScalar(0.2126 * base.x + 0.7152 * base.y + 0.0722 * base.z);

  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  const uniforms = {
    uZero: { value: 0 }, // loop-bound offset: keeps FXC from unrolling the loops (shader compile budget)
    uDem: { value: dem },
    uDemP: { value: demP },
    uDemSize: { value: new THREE.Vector2(dem.image.width, dem.image.height) },
    uDemMin: { value: demMin },
    uDemScale: { value: demScale },
    uAux: { value: aux },
    uNoise3: { value: noise3 },
    uAlbedo: { value: albedo },
    uAlbedoSize: { value: new THREE.Vector2(albedo.image.width, albedo.image.height) },
    uAlbedoRange: { value: new THREE.Vector2(meta.albedo.lo, meta.albedo.hi - meta.albedo.lo) },
    uTint: { value: tint },
    uDetailTex: { value: detail },
    uDetailRange: { value: meta.detail.range },
    uTileR: { value: meta.detail.tile_km / DEM_SPHERE_KM },
    uSunL: { value: new THREE.Vector3(1, 0, 0) },
    uCamL: { value: new THREE.Vector3(3, 0, 0) },
    uCamF: { value: new THREE.Vector3(0, 0, -1) },
    uPixX: { value: new THREE.Vector3(1e-3, 0, 0) },
    uPixY: { value: new THREE.Vector3(0, 1e-3, 0) },
    uSunColor: U.uSunColor,
    uSunAng: { value: 0.0118 },
    uMeanAlbedo: { value: 0.142 }, // V-band geometric albedo == normal albedo for a Lommel-Seeliger disc
    uBaseColor: { value: base },
    uGain: { value: 1.0 }, // photographic gain x phase compensation (set per frame, see update)
    uDetail: { value: 1.0 },
    uCraterS0: { value: 0.034 }, // cell size of the largest procedural crater octave (r <= 0.24 cell: ~20 km)
    uDebug: { value: 0 },
    uFpScale: { value: 1 },
    uDetailFp: { value: quality === 'low' ? 2.6 : quality === 'med' ? 1.6 : 1 },
    // relief shell: B-spline DEM values never exceed the largest coefficient; procedural crater rims add at most
    // sum_o 0.08 * 0.24 * s_o (x 0.75 for octave 0) = 1.1e-3 R, central massifs and overlaps ~ +0.7e-3; plus the facet sag
    uHG: { value: meta.dem.max_km * kmToR + 1.8e-3 + 2e-4 },
    uMarchOct: { value: params && params.has('moct') ? Number(params.get('moct')) : 2 },
    uTileK: { value: params && params.has('mtile') ? Number(params.get('mtile')) : 1.4 },
    uAniso: { value: params && params.has('maniso') ? Number(params.get('maniso')) : quality === 'low' ? 1 : quality === 'med' ? 2 : 4 },
    uSkip: { value: params && params.has('mskip') ? Number(params.get('mskip')) : 0 },
    uFpLong: { value: params && params.has('mfpl') ? Number(params.get('mfpl')) : 0.55 },
    uFpGCap: { value: params && params.has('mfpg') ? Number(params.get('mfpg')) : 4.5 },
    uStepK: { value: params && params.has('mstep') ? Number(params.get('mstep')) : 3.0 },
  };
  if (params && params.has('mdebug')) uniforms.uDebug.value = Number(params.get('mdebug'));
  if (params && params.has('mfp')) uniforms.uFpScale.value = Number(params.get('mfp'));

  // Every distance: a bounding shell (radius 1 + uHG) drawn with its back faces. Four small programs (the D3D shader
  // compiler that Chrome on Windows runs at first draw is superlinear in program size; see shaders.js):
  //   MARCH   pre-pass: each view ray against the DEM + procedural crater height field (t, coverage, height, kind);
  //   TERRAIN pre-pass: DEM normal, depression depth, DEM cast shadow;
  //   LIGHT   pre-pass: roughness, crater relief and shadows, photometry (anisotropic taps);
  //   FINAL   the visible mesh: albedo textures, crater albedo, composition, depth (misses discarded: the horizon,
  //           crater rims and central peaks are real geometry) and analytic skyline coverage.
  // All four are in the scene graph from create() on (the app's warm-up compiles them behind the splash).
  const debugDefs = params && params.has('mdebug') ? { MDEBUG: '' } : {};
  uniforms.uPre = { value: null };
  uniforms.uTerr = { value: null };
  uniforms.uLight = { value: null };
  uniforms.uLocalToClip = { value: new THREE.Matrix4() };
  uniforms.uTap = { value: 0 };
  uniforms.uSinSun = { value: 0.0118 };
  // fill light's backscatter weight: mean albedo x the photometric phase function at g = 1.2 rad (see phaseS)
  uniforms.uFillS = {
    value: (() => {
      const g = 1.2, gd = (g * 180) / Math.PI;
      const surge = (1 + 1.95 / (1 + Math.tan(0.5 * g) / 0.12)) / 2.95;
      return 0.142 * surge * Math.exp(-0.008 * gd + 4.0e-5 * gd * gd);
    })(),
  };
  const reliefGeo = new THREE.SphereGeometry(1, 256, 128);
  const reliefMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: MERCURY_VERT_RELIEF,
    fragmentShader: MERCURY_FRAG,
    defines: { PASS_FINAL: '', ...debugDefs },
    side: THREE.BackSide,
    // anti-aliased silhouettes: alpha = analytic sub-pixel coverage of the skyline (from the ray's closest approach),
    // blended over the sky drawn before it (smooth, unlike 4-level alpha-to-coverage with its dither pattern); the
    // skyline pixel still writes its depth, so anything behind it fails the depth test. Opaque draw order.
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const reliefMesh = new THREE.Mesh(reliefGeo, reliefMat);
  reliefMesh.name = 'mercury-relief';
  reliefMesh.scale.setScalar(R);
  reliefMesh.frustumCulled = false;
  reliefMesh.onBeforeRender = (renderer, scene, camera) => {
    uniforms.uLocalToClip.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(reliefMesh.matrixWorld);
  };
  object.add(reliefMesh);

  // pre-passes: same shell, own program and float target each
  const passMat = (define, additive) => new THREE.ShaderMaterial({
    uniforms,
    vertexShader: MERCURY_VERT_RELIEF,
    fragmentShader: MERCURY_FRAG,
    defines: { [define]: '', ...debugDefs },
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    ...(additive
      ? { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor }
      : { blending: THREE.NoBlending }),
  });
  const passes = [
    { mat: passMat('MARCH_PASS'), type: THREE.FloatType, uniform: 'uPre', clear: true, name: 'march' },
    { mat: passMat('PASS_TERRAIN'), type: THREE.HalfFloatType, uniform: 'uTerr', clear: false, name: 'terrain' },
    // (one additive draw per anisotropic tap: a loop around the crater field would cost the D3D compiler a loop level)
    { mat: passMat('PASS_LIGHT', true), type: THREE.HalfFloatType, uniform: 'uLight', clear: true, name: 'light', taps: true },
  ];
  const passScene = new THREE.Scene();
  for (const p of passes) {
    p.mesh = new THREE.Mesh(reliefGeo, p.mat);
    p.mesh.matrixAutoUpdate = false;
    p.mesh.frustumCulled = false;
    p.mesh.visible = false;
    passScene.add(p.mesh);
    // (a never-visible stand-in in the scene graph, so the app's shader warm-up compiles this program behind the
    // splash instead of at the first frame of the film that shows Mercury)
    const warm = new THREE.Mesh(reliefGeo, p.mat);
    warm.name = 'mercury-' + p.name;
    warm.visible = false;
    warm.frustumCulled = false;
    warm.scale.setScalar(R);
    object.add(warm);
  }
  const clearCol = new THREE.Color();
  const renderPasses = (camera) => {
    const res = U.uResolution.value;
    const w = Math.max(1, Math.round(res.x)), h = Math.max(1, Math.round(res.y));
    const renderer = ctx.renderer;
    const prevRT = renderer.getRenderTarget();
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(clearCol);
    renderer.setClearColor(0x000000, 0);
    reliefMesh.updateWorldMatrix(true, false);
    for (const p of passes) {
      if (!p.rt || p.rt.width !== w || p.rt.height !== h) {
        if (p.rt) p.rt.dispose();
        p.rt = new THREE.WebGLRenderTarget(w, h, {
          type: p.type, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
          minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
        });
        p.rt.texture.name = 'mercury.' + p.name;
        uniforms[p.uniform].value = p.rt.texture;
      }
      // (passScene is the identity, so the scene's world-matrix update reproduces this)
      p.mesh.matrix.copy(reliefMesh.matrixWorld);
      p.mesh.matrixWorld.copy(reliefMesh.matrixWorld);
      p.mesh.visible = true;
      renderer.setRenderTarget(p.rt);
      if (p.clear) renderer.clear(true, false, false);
      const n = p.taps ? Math.max(1, uniforms.uAniso.value) : 1;
      for (let k = 0; k < n; k++) {
        uniforms.uTap.value = k;
        renderer.render(passScene, camera);
      }
      uniforms.uTap.value = 0;
      p.mesh.visible = false;
    }
    renderer.setClearColor(clearCol, prevAlpha);
    renderer.setRenderTarget(prevRT);
  };

  // Exposure. Physically Mercury is a dark body (normal albedo 0.14) and its regolith backscatters strongly:
  // a half-lit Mercury is 8x fainter than a full one, a 140-deg crescent 100x. A camera metering on Mercury would
  // open up (by that ratio to the power 0.6, here), so the surface carries a smooth photographic compensation that depends only on the phase angle
  // at the planet's centre (pure function of camera position). Set autoExposure=false to get bare I/F radiance.
  let autoExposure = true;
  const BASE_GAIN = 1.5;
  // disc-integrated phase law of Mercury (Mallama et al. 2002, V band, valid 2..170 deg): flux relative to g = 0
  const phi = (g) => {
    const a = THREE.MathUtils.clamp((g * 180) / Math.PI, 2, 170);
    const dV = 6.328e-2 * a - 1.6336e-3 * a ** 2 + 3.3644e-5 * a ** 3 - 3.4265e-7 * a ** 4 + 1.6893e-9 * a ** 5 - 3.0334e-12 * a ** 6;
    return Math.pow(10, -0.4 * dV);
  };
  const PHI8 = phi((8 * Math.PI) / 180);
  const toCam = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const hit = new THREE.Vector3();
  const gainOverride = params && params.has('mgain') ? Number(params.get('mgain')) : null;

  const q = new THREE.Quaternion();
  const qi = new THREE.Quaternion();
  const tmp = new THREE.Vector3();
  const sunU = new THREE.Vector3(); // Sun at the universe origin

  return {
    id: 'mercury',
    radius: R,
    object,
    moons: [],
    update(frame) {
      bodyQuaternion('mercury', frame.simDays, q);
      reliefMesh.quaternion.copy(q);
      qi.copy(q).invert();
      const pos = frame.positions.mercury;
      // Sun direction in the body-fixed frame
      tmp.copy(sunU).sub(pos);
      const dSun = tmp.length();
      uniforms.uSunL.value.copy(tmp).divideScalar(dSun).applyQuaternion(qi);
      uniforms.uSunAng.value = Math.asin(Math.min(1, U.uSunRadius.value / dSun));
      uniforms.uSinSun.value = Math.sin(uniforms.uSunAng.value);
      // camera in the body-fixed frame, in Mercury radii
      uniforms.uCamL.value.copy(frame.camUniverse).sub(pos).applyQuaternion(qi).divideScalar(R);
      // camera axes in the body frame and the per-pixel change of the view ray (analytic ray differentials)
      {
        const cam = frame.camera;
        const res = U.uResolution.value;
        const th = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / (cam.zoom || 1);
        const sx = (2 * th * cam.aspect) / Math.max(res.x, 1), sy = (2 * th) / Math.max(res.y, 1);
        uniforms.uCamF.value.set(0, 0, -1).applyQuaternion(cam.quaternion).applyQuaternion(qi);
        uniforms.uPixX.value.set(sx, 0, 0).applyQuaternion(cam.quaternion).applyQuaternion(qi);
        uniforms.uPixY.value.set(0, sy, 0).applyQuaternion(cam.quaternion).applyQuaternion(qi);
      }
      // exposure: (1) phase angle at the centre (disc-integrated phase law), (2) when Mercury fills the frame, the
      // solar incidence where the view axis meets the ground (a photographer metering on the lit rims of a terminator)
      const sunDir = tmp.copy(sunU).sub(pos).normalize();
      const camRel = toCam.copy(frame.camUniverse).sub(pos);
      const dist = camRel.length() / R;
      // skip both passes while the shell is outside the view (its angular radius vs the view cone's half-diagonal)
      fwd.set(0, 0, -1).applyQuaternion(frame.camera.quaternion);
      const cam = frame.camera;
      const halfDiag = Math.atan(Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * Math.sqrt(1 + cam.aspect * cam.aspect));
      const shellR = 1 + uniforms.uHG.value;
      const angR = dist > shellR ? Math.asin(shellR / dist) : Math.PI;
      const off = Math.acos(THREE.MathUtils.clamp(-camRel.dot(fwd) / (dist * R), -1, 1)); // (camRel points away from Mercury)
      const relief = off - angR < halfDiag + 0.02;
      reliefMesh.visible = relief;
      const gc = Math.acos(THREE.MathUtils.clamp(camRel.dot(sunDir) / (dist * R), -1, 1));
      let comp = THREE.MathUtils.clamp(Math.pow(PHI8 / phi(gc), 0.6), 1, 16);
      if (dist < 2.2) {
        const o = camRel.divideScalar(R); // camera, in Mercury radii, Mercury-centred
        const b = o.dot(fwd);
        const c = o.lengthSq() - 1;
        const disc = b * b - c;
        // view-axis hit point, or the horizon point nearest the axis when it misses
        const t = disc > 0 ? -b - Math.sqrt(disc) : Math.max(-b, 0);
        hit.copy(o).addScaledVector(fwd, t).normalize();
        const mu0 = hit.dot(sunDir);
        const local = THREE.MathUtils.clamp(Math.sqrt(0.3 / Math.max(mu0, 0.03)), 1, 2.6);
        const near = THREE.MathUtils.smoothstep(2.2 - dist, 0, 0.9);
        comp *= 1 + (local - 1) * near;
      }
      uniforms.uGain.value = gainOverride ?? (autoExposure ? BASE_GAIN * comp : 1);
      if (relief) renderPasses(frame.camera);
    },
    setAutoExposure(on) {
      autoExposure = !!on;
    },
  };
}
