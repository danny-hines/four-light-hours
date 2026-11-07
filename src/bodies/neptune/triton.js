// Triton: retrograde, inclined (156.9 deg), synchronously rotating; Voyager 2 colour mosaic for the imaged southern
// hemisphere (assets/triton/color.webp, colour-rebuilt to approximate true colour by assets-src/scripts/process_triton.py)
// and procedural terrain everywhere Voyager saw nothing or saw poorly (assets/triton/mask.webp: R = coverage, G = sharpness):
//  * cantaloupe terrain (dimpled cavi ~30 km across cut by long double ridges) in the unseen north,
//  * dark, NE-trending plume streaks on the pinkish-tan nitrogen-frost south polar cap where the mosaic is blurry,
//  * fine frost texture and bump relief that take over from the 4 km/px map at close range.
// Lighting: icy Hapke-like mix (Lambert + Lommel-Seeliger, opposition surge), analytic eclipse by Neptune with
// penumbra, faint blue Neptune-shine on the night side, and a thin forward-scattering N2/haze limb.
// The orbital node regresses with Triton's ~688-year precession and is set so the subsolar latitude is about
// -37 deg at the 2026 epoch (late southern summer), so the south polar cap faces the Sun as it really does now.
import * as THREE from 'three';
import { COMMON_GLSL, T0, noiseTexture, rng, positionSphere } from './common.js';
import { TRITON_SURFACE_FS } from './triton-surface.js';

const DEG = Math.PI / 180;

export async function makeTriton(ctx, { data, poleQuat }) {
  const { U, assets } = ctx;
  const RT = data.radius;
  const a = data.aKm / 6371;
  const P = Math.abs(data.periodDays);
  const inc = data.inclinationDeg * DEG; // > 90 deg: retrograde (angular momentum ~opposite Neptune's spin)
  const NODE0 = 222 * DEG; // node in Neptune's equatorial frame at T0 (chosen for a -37 deg subsolar latitude)
  const NODE_RATE = (-2 * Math.PI) / (688 * 365.25); // rad/day, regression of the node
  const THETA0 = 186 * DEG; // orbital phase at T0 (not an ephemeris value; see notes/neptune.md)

  const _q = new THREE.Quaternion(),
    _qa = new THREE.Quaternion(),
    _qb = new THREE.Quaternion();
  const AX = new THREE.Vector3(1, 0, 0),
    AY = new THREE.Vector3(0, 1, 0);
  function orbitQuat(d, out) {
    const node = NODE0 + NODE_RATE * (d - T0);
    _qa.setFromAxisAngle(AY, node);
    _qb.setFromAxisAngle(AX, inc);
    return out.copy(poleQuat).multiply(_qa).multiply(_qb);
  }
  function positionAt(d, out = new THREE.Vector3()) {
    const th = THETA0 + (2 * Math.PI * (d - T0)) / P;
    out.set(a * Math.cos(th), 0, -a * Math.sin(th));
    return out.applyQuaternion(orbitQuat(d, _q));
  }
  const _r = new THREE.Vector3(),
    _n = new THREE.Vector3(),
    _x = new THREE.Vector3(),
    _y = new THREE.Vector3(),
    _z = new THREE.Vector3(),
    _m = new THREE.Matrix4();
  /** Body frame: +x toward Neptune (sub-Neptune point at 0 E), +y = IAU north (opposite the orbital angular momentum). */
  function orientation(d, out = new THREE.Quaternion()) {
    positionAt(d, _r);
    _n.set(0, 1, 0).applyQuaternion(orbitQuat(d, _q)); // orbital angular momentum direction
    _x.copy(_r).normalize().negate();
    _y.copy(_n).negate();
    _z.crossVectors(_x, _y).normalize();
    _y.crossVectors(_z, _x).normalize();
    _m.makeBasis(_x, _y, _z);
    return out.setFromRotationMatrix(_m);
  }

  const [map, mask] = await Promise.all([
    assets.loadTexture('triton/color.webp', { srgb: true, anisotropy: 8 }),
    assets.loadTexture('triton/mask.webp', { srgb: false, anisotropy: 4 }),
  ]);

  // dark plume / wind streaks on the south polar cap (Hansen et al. 1990: ~50 streaks, 20-150 km): vents spread over
  // 13-70 S, heavy-tailed lengths, widths and darkness, a dark head at the vent fading downwind, directions from a
  // smooth NE-trending wind field. They are static, so they are rasterised once here into a mipmapped R8 map of the cap
  // (lat -80..-8, ~2 km / px) instead of being searched per pixel in the shader.
  const plumeTex = (() => {
    const W = 4096, H = 820, LAT0 = -80 * DEG, LAT1 = -8 * DEG;
    const img = new Uint8Array(W * H);
    const r = rng(0x7a1701);
    const s0 = Math.sin(-70 * DEG), s1 = Math.sin(-13 * DEG);
    const px = (2 * Math.PI) / W; // pixel size (rad of longitude)
    for (let n = 0; n < 56; n++) {
      const lat = Math.asin(s0 + (s1 - s0) * r());
      const lon = r() * 2 * Math.PI - Math.PI;
      const cl = Math.cos(lat);
      const c = [cl * Math.cos(lon), Math.sin(lat), -cl * Math.sin(lon)];
      const east = [-Math.sin(lon), 0, -Math.cos(lon)];
      const north = [c[1] * east[2] - c[2] * east[1], c[2] * east[0] - c[0] * east[2], c[0] * east[1] - c[1] * east[0]];
      const an = (48 + 22 * Math.sin(2 * lon + 1.3) * Math.cos(3 * lat + 0.4) + 8 * (r() - 0.5)) * DEG;
      const dir = [0, 1, 2].map((k) => Math.cos(an) * east[k] + Math.sin(an) * north[k]);
      const side = [c[1] * dir[2] - c[2] * dir[1], c[2] * dir[0] - c[0] * dir[2], c[0] * dir[1] - c[1] * dir[0]];
      const len = 0.03 + 0.08 * r() ** 3; // 40 - 150 km
      const w0 = 0.0025 + 0.006 * r() ** 2;
      const dk = 0.35 + 0.65 * r() ** 2.5;
      // bounding box in lat / lon around the midpoint
      const ext = 0.6 * len + 3 * w0 * 2.2;
      const la0 = Math.max(LAT0, lat - ext), la1 = Math.min(LAT1, lat + ext);
      const dLon = ext / Math.max(Math.cos(Math.max(Math.abs(la0), Math.abs(la1))), 0.2);
      const y0 = Math.floor(((la0 - LAT0) / (LAT1 - LAT0)) * H), y1 = Math.ceil(((la1 - LAT0) / (LAT1 - LAT0)) * H);
      const x0 = Math.floor(((lon - dLon + Math.PI) / (2 * Math.PI)) * W), x1 = Math.ceil(((lon + dLon + Math.PI) / (2 * Math.PI)) * W);
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
        const la = LAT0 + ((y + 0.5) / H) * (LAT1 - LAT0);
        const ca = Math.cos(la), sa = Math.sin(la);
        const sgPx = px * ca; // pixel footprint (rad of arc)
        for (let xx = x0; xx < x1; xx++) {
          const x = ((xx % W) + W) % W;
          const lo = ((x + 0.5) / W) * 2 * Math.PI - Math.PI;
          const d = [ca * Math.cos(lo) - c[0], sa - c[1], -ca * Math.sin(lo) - c[2]];
          const al = d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2] + 0.5 * len; // 0 at the vent
          if (al < -0.012 || al > len * 1.05) continue;
          const ac = d[0] * side[0] + d[1] * side[1] + d[2] * side[2];
          const u = Math.min(1, Math.max(0, al / len));
          const w = w0 * (0.3 + 1.9 * u); // a fan widening downwind
          const sg = Math.sqrt(w * w + sgPx * sgPx);
          const ss = (e0, e1, v) => {
            const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
            return t * t * (3 - 2 * t);
          };
          const prof = ss(-0.004, 0.005, al) * (1 - ss(len * 0.35, len, al)) * Math.exp((-0.5 * ac * ac) / (sg * sg)) * (w / sg);
          const v = prof * dk * Math.min(1, Math.max(0, 1.2 - 0.9 * u));
          const i = y * W + x;
          img[i] = Math.max(img[i], Math.min(255, Math.round(v * 255)));
        }
      }
    }
    const t = new THREE.DataTexture(img, W, H, THREE.RedFormat, THREE.UnsignedByteType);
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    return t;
  })();

  // sulci: poles of the great circles their double ridges follow, plus a noise offset each
  const sulN = [];
  {
    const r = rng(0x51c1);
    for (let k = 0; k < 7; k++) {
      const v = new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize();
      sulN.push(new THREE.Vector4(v.x, v.y, v.z, 3.7 * k + 1.3));
    }
  }

  const uniforms = {
    uMap: { value: map },
    uSulN: { value: sulN },
    uPlume: { value: plumeTex },
    uMask: { value: mask },
    uSunPosW: U.uSunPosW,
    uSunColor: U.uSunColor,
    uSunRadius: U.uSunRadius,
    uRotW: { value: new THREE.Matrix3() },
    uResolution: U.uResolution,
    uNepPosW: { value: new THREE.Vector3() },
    uNepR: { value: 3.85 },
    uNepShine: { value: new THREE.Vector3() },
    uNepDirW: { value: new THREE.Vector3(1, 0, 0) },
    uRT: { value: RT },
    uAlbedoGain: { value: 0.93 },
    uNoiseTex: { value: noiseTexture(THREE) },
    // loop bounds as uniforms (keeps ANGLE/D3D from unrolling and inlining every iteration)
    uOctH: { value: ctx.quality === 'low' ? 9 : 12 },
    uOctA: { value: ctx.quality === 'low' ? 9 : 12 },
    uNCell: { value: 54 }, // 27 neighbouring cells x 2 cavi generations
    uNSulci: { value: 7 },
    uNTaps: { value: 5 },
  };

  const vertexShader = /* glsl */ `
    uniform vec2 uResolution;
    varying vec3 vPosL;
    varying vec3 vPosW;
    varying float vPx;
    void main() {
      vPx = 2.0 / (projectionMatrix[1][1] * uResolution.y);   // pixel angle (rad)
      vPosL = position;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vPosW = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`;

  const fragmentShader = TRITON_SURFACE_FS;

  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader });
  const segs = ctx.quality === 'low' ? 96 : 192;
  const mesh = new THREE.Mesh(positionSphere(THREE, RT, segs, segs / 2), mat);
  mesh.name = 'triton';

  // thin N2 atmosphere with haze: a faint forward-scattering ring at the limb
  const hazeU = {
    uSunPosW: U.uSunPosW,
    uSunColor: U.uSunColor,
    uCenterW: { value: new THREE.Vector3() },
    uRT: { value: RT },
    uH: { value: RT * 0.0074 }, // ~10 km
    uTau: { value: 0.004 },
    uInside: { value: false }, // camera inside the shell: draw its back faces (one program, no side switch)
  };
  const hazeMat = new THREE.ShaderMaterial({
    uniforms: hazeU,
    vertexShader: /* glsl */ `
      varying vec3 vPosW;
      void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vPosW = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uSunPosW, uSunColor, uCenterW;
      uniform float uRT, uH, uTau;
      uniform bool uInside;
      varying vec3 vPosW;
      ${COMMON_GLSL}
      void main() {
        if (gl_FrontFacing == uInside) discard;   // front faces from outside, back faces from inside
        vec3 ro = -uCenterW;
        vec3 rd = normalize(vPosW);
        vec3 L = normalize(uSunPosW - uCenterW);
        float tc = -dot(ro, rd);
        vec3 pc = ro + rd * tc;
        float b = length(pc);
        float cosT = dot(rd, L);
        float P = 0.8 * hg(cosT, 0.65) + 0.2 * hg(cosT, -0.2);
        vec3 alb = vec3(0.85, 0.92, 1.0);
        vec3 col;
        float T = 1.0;
        if (b < uRT && tc > 0.0) {
          // over the disc: vertical-ish column, lit where the surface below is lit
          vec2 hit = nepRaySphere(ro, rd, uRT);
          vec3 ph = ro + rd * hit.x;
          vec3 n = normalize(ph);
          float mu = max(dot(n, -rd), 0.05);
          float lit = smoothstep(-0.05, 0.08, dot(n, L));
          float tau = uTau / mu;
          col = alb * P * 0.25 * (1.0 - exp(-tau)) * lit;
          T = exp(-tau);
        } else {
          float h = max(b - uRT, 0.0);
          float tau = uTau * sqrt(TAU * uRT / uH) * exp(-h / uH);
          float lit = smoothstep(-0.12, 0.06, dot(pc / max(b, 1e-6), L));
          col = alb * P * 0.25 * (1.0 - exp(-tau)) * lit;
          T = exp(-tau);
        }
        gl_FragColor = vec4(col * uSunColor, T);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.SrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const haze = new THREE.Mesh(positionSphere(THREE, RT * 1.05, 96, 48), hazeMat);
  haze.renderOrder = 3;
  haze.name = 'triton-haze';

  const group = new THREE.Group();
  group.name = 'triton-system';
  group.add(mesh);
  group.add(haze);

  const _qo = new THREE.Quaternion();
  const _toSun = new THREE.Vector3();
  function update(frame, nepCenterW, nepAlbedo) {
    const d = frame.simDays;
    positionAt(d, group.position);
    orientation(d, _qo);
    mesh.quaternion.copy(_qo);
    uniforms.uRotW.value.setFromMatrix4(_m.makeRotationFromQuaternion(_qo));
    const triW = _r.copy(nepCenterW).add(group.position);
    hazeU.uCenterW.value.copy(triW);
    uniforms.uNepPosW.value.copy(nepCenterW);
    // Neptune-shine: Neptune's lit fraction as seen from Triton, times its solid angle (point-source approximation)
    const toNep = _x.copy(nepCenterW).sub(triW);
    const dist = toNep.length();
    toNep.divideScalar(dist);
    uniforms.uNepDirW.value.copy(toNep);
    _toSun.copy(ctx.U.uSunPosW.value).sub(nepCenterW).normalize();
    const lit = 0.5 * (1 + _toSun.dot(toNep.clone().negate()));
    const k = (uniforms.uNepR.value / dist) ** 2 * lit;
    uniforms.uNepShine.value.copy(nepAlbedo).multiplyScalar(k);
    // the haze shell is drawn from inside if the camera is that close
    const camD = triW.length();
    hazeU.uInside.value = camD < RT * 1.06;
  }

  return { group, mesh, update, positionAt, orientation, radius: RT, uniforms, textures: [map, mask, plumeTex] };
}
