// The Moon: LRO colour + LOLA relief on a view-dependent displaced grid, lunar photometry, procedural craters,
// earthshine and Earth's shadow. positionAt() uses moonGeocentric(); orientation is bodyQuaternion('moon', d).
import * as THREE from 'three';
import { bodyQuaternion, moonGeocentric } from '../../core/astro.js';
import { MOON_VERT, MOON_FRAG } from './moon-glsl.js';

const KM = 1 / 6371;

// Polar grid: ring index (0..na+nt) x azimuth. Vertex positions are computed in the vertex shader.
function polarGrid(na, nt, naz) {
  const rings = na + nt + 1;
  const grid = new Float32Array(rings * (naz + 1) * 2);
  let o = 0;
  for (let i = 0; i < rings; i++)
    for (let j = 0; j <= naz; j++) {
      grid[o++] = i;
      grid[o++] = (j / naz) * Math.PI * 2;
    }
  const idx = new Uint32Array((rings - 1) * naz * 6);
  o = 0;
  for (let i = 0; i < rings - 1; i++)
    for (let j = 0; j < naz; j++) {
      const a = i * (naz + 1) + j, b = a + 1, c = a + naz + 1, d = c + 1;
      // winding: counter-clockwise seen from outside (azimuth runs counter-clockwise seen from the camera)
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('grid', new THREE.BufferAttribute(grid, 2));
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rings * (naz + 1) * 3), 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.userData = { na, nt };
  return g;
}

export async function createMoon(ctx, opts) {
  const { U, assets, data, quality, camera } = ctx;
  const md = data.moons.moon;
  const R = md.radius;
  const Rp = opts.earthRp;
  const [color, height] = await Promise.all([
    assets.loadTexture('moon/color.webp', { srgb: true, anisotropy: 16 }),
    assets.loadTexture('moon/height.webp', { srgb: false, anisotropy: 4 }),
  ]);
  const detail = { low: 0.0, med: 0.7, high: 1.0 }[quality] ?? 1.0;
  const hi = polarGrid(quality === 'low' ? 160 : 260, quality === 'low' ? 80 : 140, quality === 'low' ? 512 : 1024);
  const lo = polarGrid(48, 32, 192);
  const bs = new THREE.Sphere(new THREE.Vector3(), R * 1.02);
  hi.boundingSphere = bs;
  lo.boundingSphere = bs;

  const uniforms = {
    uHeight: { value: height },
    uColor: { value: color },
    uR: { value: R },
    uCamB: { value: new THREE.Vector3(0, 0, 3 * R) },
    uB2W: { value: new THREE.Matrix3() },
    uCenterW: { value: new THREE.Vector3() },
    uNa: { value: hi.userData.na },
    uNt: { value: hi.userData.nt },
    uAlphaA: { value: 0.3 },
    uThetaS: { value: 0.5 },
    uThetaMax: { value: 1.4 },
    uSunDirB: { value: new THREE.Vector3(1, 0, 0) },
    uEarthPosB: { value: new THREE.Vector3() },
    uEarthR: { value: Rp },
    uEarthshine: { value: new THREE.Vector3() },
    uSunAngR: { value: 0.00465 },
    uDetail: { value: detail },
    uResolution: U.uResolution,
    uDebugV: { value: Number(new URLSearchParams(globalThis.location?.search || '').get('earthDebug') || 0) },
    uLoopMax: { value: 64 },
    uDebug: { value: Number(new URLSearchParams(globalThis.location?.search || '').get('earthDebug') || 0) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: MOON_VERT,
    fragmentShader: MOON_FRAG,
    // double-sided: at grazing views a few displaced triangles behind ridge crests fold over; culling them left
    // 1-px holes (black dashes) along ridge lines. The grid only spans the visible cap, so this costs little.
    side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(hi, mat);
  mesh.name = 'moon-surface';
  mesh.frustumCulled = false; // the grid follows the camera; the bounding sphere test is not meaningful
  const object = new THREE.Group();
  object.name = 'moon';
  object.add(mesh);

  // Earthshine: Earth's reflected sunlight at the Moon (geometric albedo ~0.37, Lambert-sphere phase law),
  // with an artistic gain so the night side reads as a faint ashen glow (physically ~1e-4 of sunlight).
  // (gain 2500: the night side with Earth high in the sky reads as a dim ashen grey ~5% of the sunlit ground; with
  // Earth low on the horizon the grazing incidence keeps it very dark, as in reality)
  const EARTHSHINE_GAIN = 150;
  const earthTint = new THREE.Vector3(0.86, 0.93, 1.0);

  const q = new THREE.Quaternion();
  const qi = new THREE.Quaternion();
  const m4 = new THREE.Matrix4();
  const tmp = new THREE.Vector3();
  const centerW = new THREE.Vector3();
  const moonU = new THREE.Vector3();
  let warmed = false;
  const moonDef = {
    id: 'moon',
    name: md.name,
    radius: R,
    positionAt: (d) => moonGeocentric(d, new THREE.Vector3()),
    // The Moon's true albedo (maria ~0.07, highlands ~0.16) under the contract's unit-irradiance exposure reads as
    // charcoal; photographers expose it ~1-1.5 EV up. Optional hint for the director (not required by the contract).
    exposureEV: 0.8,
  };

  return {
    object,
    moonDef,
    update(frame, { centerW: earthCenterW, moonRel }) {
      const d = frame.simDays;
      object.position.copy(moonRel);
      centerW.copy(earthCenterW).add(moonRel);
      uniforms.uCenterW.value.copy(centerW);
      bodyQuaternion('moon', d, q);
      m4.makeRotationFromQuaternion(q);
      uniforms.uB2W.value.setFromMatrix4(m4);
      qi.copy(q).invert();
      uniforms.uCamB.value.copy(centerW).negate().applyQuaternion(qi);
      // sun / earth directions in the body frame
      moonU.copy(frame.positions.earth).add(moonRel);          // Moon in universe coords (Sun at origin)
      uniforms.uSunDirB.value.copy(moonU).negate().normalize().applyQuaternion(qi);
      uniforms.uEarthPosB.value.copy(moonRel).negate().applyQuaternion(qi);
      uniforms.uSunAngR.value = Math.asin(Math.min(1, U.uSunRadius.value / moonU.length()));
      // earthshine irradiance (Earth phase angle = Sun-Earth-Moon)
      const toSunE = tmp.copy(frame.positions.earth).negate().normalize();
      const cosA = toSunE.dot(moonRel.clone().normalize());
      const a = Math.acos(Math.max(-1, Math.min(1, cosA)));
      const phi = (Math.sin(a) + (Math.PI - a) * Math.cos(a)) / Math.PI;
      const dist = moonRel.length();
      const E = 0.37 * (Rp / dist) ** 2 * phi * EARTHSHINE_GAIN;
      uniforms.uEarthshine.value.copy(earthTint).multiplyScalar(E);

      // view-dependent grid parameters
      const D = uniforms.uCamB.value.length();
      const ratio = Math.min(R / D, 0.99999);
      const thH = Math.acos(ratio);
      const margin = Math.sqrt((2 * 12 * KM) / R);
      const thMax = Math.min(thH + margin, Math.PI * 0.97);
      const thS = 0.55 * thH;
      uniforms.uThetaS.value = thS;
      uniforms.uThetaMax.value = thMax;
      uniforms.uAlphaA.value = Math.atan2(R * Math.sin(thS), D - R * Math.cos(thS));
      // LOD: projected radius in pixels
      const cam = frame.camera;
      const rPx = (Math.asin(ratio) / ((cam.fov * Math.PI) / 360)) * (U.uResolution.value.y * 0.5);
      // the very first frame (rendered during boot) always uses the dense grid so it is uploaded up front
      // and a later close approach never hitches
      const g = rPx > 90 || !warmed ? hi : lo;
      warmed = true;
      if (mesh.geometry !== g) {
        mesh.geometry = g;
        uniforms.uNa.value = g.userData.na;
        uniforms.uNt.value = g.userData.nt;
      }
    },
  };
}
