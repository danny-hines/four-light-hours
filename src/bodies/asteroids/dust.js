// Fine dust of the debris swarm: three lattice layers of motes around the camera (field-local cells, so they
// parallax correctly against the rocks), each an instanced quad that stretches into a motion streak along the
// camera's screen-space velocity (1/48 s shutter). Grains scatter sunlight with a strongly forward-peaked phase
// function (diffraction) plus a weak back lobe; tumbling flakes throw brief specular glints; motes inside the
// shadow of a hero rock go dark (shadow shafts through the dust when looking toward the Sun).
import * as THREE from 'three';
import { fieldGLSL, envelope } from './field.js';

export const DUST_LAYERS = [
  { cell: 0.0032, n: 7, gain: 1.0 },
  { cell: 0.011, n: 7, gain: 1.0 },
  { cell: 0.04, n: 7, gain: 1.0 },
];

export function createDust(ctx) {
  const { U } = ctx;
  const group = new THREE.Group();
  group.name = 'asteroid-dust';
  const quad = new THREE.InstancedBufferGeometry();
  quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0]), 3));
  quad.setIndex([0, 1, 2, 2, 1, 3]);
  const heroes = { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] };
  const layers = DUST_LAYERS.map((Ly, li) => {
    const side = 2 * Ly.n + 1;
    const geom = quad.clone();
    geom.instanceCount = side * side * side;
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    const uniforms = {
      uVN: { value: 8 }, // loop bound of the GLSL value noise (hash.js)
      uLayer: { value: li },
      uCell: { value: Ly.cell },
      uN: { value: Ly.n },
      uGain: { value: Ly.gain },
      uCamCell: { value: new THREE.Vector3() },
      uCamFrac: { value: new THREE.Vector3() },
      uBasis: { value: new THREE.Matrix3() },
      uSunPosW: U.uSunPosW,
      uSunColor: U.uSunColor,
      uTime: U.uTime,
      uCamVelW: U.uCamVelW,
      uResolution: U.uResolution,
      uHeroes: heroes,
      uFieldGain: { value: 1 },
      uEnvCam: { value: 0.5 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        ${fieldGLSL()}
        uniform int uLayer;
        uniform float uCell, uN, uGain, uTime, uFieldGain, uEnvCam;
        uniform vec3 uCamCell, uCamFrac, uSunPosW, uCamVelW;
        uniform vec2 uResolution;
        uniform mat3 uBasis;
        uniform vec4 uHeroes[4];
        out vec3 vCol;
        out vec2 vXY;
        out float vLen;
        out float vSig;
        void kill() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vCol = vec3(0.0); }
        float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }
        void main() {
          int side = int(uN) * 2 + 1;
          int id = gl_InstanceID;
          ivec3 off = ivec3(id % side, (id / side) % side, id / (side * side)) - int(uN);
          ivec3 c = ivec3(uCamCell) + off;
          uint h = hashCell(c, 0xd057u + uint(uLayer) * 7919u);
          vec3 jit = vec3(rnd(h, 0u), rnd(h, 1u), rnd(h, 2u));
          vec3 local = (vec3(c) + jit) * uCell;
          // the swarm's density at the camera (the motes live within ~0.3 units of it, where the envelope is
          // nearly constant): evaluated once per frame on the CPU (field.js envelope), not per mote
          float env = uEnvCam;
          // clumps and voids at the layer's own scale, so the motes are not a uniform snow
          float cl = sstep(-0.25, 0.35, vnoiseH(local / (uCell * 5.0) + float(uLayer) * 17.0, 0xc1a3u));
          if (rnd(h, 3u) > (0.15 + 0.85 * env * 1.6) * (0.15 + 1.1 * cl)) { kill(); return; }
          vec3 rel = uBasis * ((vec3(off) + jit) * uCell - uCamFrac);
          float d = length(rel);
          float R = uN * uCell;
          float fade = sstep(0.5 * uCell, 1.6 * uCell, d) * (1.0 - sstep(0.65 * R, R, d));
          if (fade <= 0.0) { kill(); return; }
          vec3 L = normalize(uSunPosW - rel);
          vec3 V = -rel / d;
          float cosT = dot(L, -V); // scattering angle cosine (1 = looking at the Sun through the grain)
          float ph = 0.85 * hg(cosT, 0.8) + 0.1 * hg(cosT, 0.97) + 0.05 * hg(cosT, -0.35);
          // grain size (power law) and glint
          float sz = pow(rnd(h, 4u), 4.0) * 1.2 + 0.05;
          vec3 ax = normalize(vec3(rnd(h, 5u), rnd(h, 6u), rnd(h, 7u)) - 0.5);
          float w = (0.6 + 2.6 * rnd(h, 8u)) * (rnd(h, 9u) < 0.5 ? 1.0 : -1.0);
          vec3 n0 = normalize(cross(ax, vec3(0.3, 0.7, 0.2)));
          float a = w * uTime + rnd(h, 10u) * 6.283;
          vec3 nf = n0 * cos(a) + cross(ax, n0) * sin(a);
          vec3 H = normalize(L + V);
          float glint = pow(abs(dot(nf, H)), 500.0) * (rnd(h, 11u) < 0.4 ? 1.0 : 0.0);
          // shadow of hero rocks
          float lit = 1.0;
          for (int i = 0; i < 4; i++) {
            vec4 hs = uHeroes[i];
            if (hs.w <= 0.0) continue;
            vec3 oc = rel - hs.xyz;
            float b = dot(oc, L);
            float cc = dot(oc, oc) - hs.w * hs.w;
            if (b < 0.0 && b * b - cc > 0.0) lit = 0.0;
          }
          float ang = 1.6 * uCell / d; // apparent brightness ~ 1/d^2, normalised to the layer's nearest motes
          // phase normalised to ~1 at 20 deg from the Sun (0.5 at 30, 0.03 at 90 deg); brighter toward the diffraction peak
          float flux = uGain * uFieldGain * sz * (ph / 0.42 * 0.8 + glint * 6.0) * ang * ang * fade * lit;
          if (flux < 1e-5) { kill(); return; }
          // streak endpoints in clip space
          vec3 rel1 = rel + uCamVelW * (1.0 / 48.0);
          vec4 c0 = projectionMatrix * viewMatrix * modelMatrix * vec4(rel, 1.0);
          vec4 c1 = projectionMatrix * viewMatrix * modelMatrix * vec4(rel1, 1.0);
          if (c0.w <= 1e-6 || c1.w <= 1e-6) { kill(); return; }
          vec2 s0 = c0.xy / c0.w * 0.5 * uResolution;
          vec2 s1 = c1.xy / c1.w * 0.5 * uResolution;
          vec2 dv = s1 - s0;
          float len = length(dv);
          vec2 dir = len > 1e-3 ? dv / len : vec2(1.0, 0.0);
          vec2 nrm = vec2(-dir.y, dir.x);
          float sig = 0.65;
          float pad = 3.0 * sig;
          // position.x in {0,1} along, position.y in {-1,1} across
          float along = position.x * (len + 2.0 * pad) - pad;
          vec2 sp = s0 + dir * along + nrm * position.y * pad;
          vXY = vec2(along, position.y * pad);
          vLen = len;
          vSig = sig;
          // flux spread along the streak
          vCol = vec3(flux / (2.5066 * sig * (len + 2.5066 * sig)));
          gl_Position = vec4(sp / (0.5 * uResolution) * c0.w, c0.z, c0.w);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uSunColor;
        in vec3 vCol;
        in vec2 vXY;
        in float vLen;
        in float vSig;
        out vec4 fragColor;
        void main() {
          float t = clamp(vXY.x, 0.0, vLen);
          vec2 dd = vec2(vXY.x - t, vXY.y);
          float w = exp(-dot(dd, dd) / (2.0 * vSig * vSig));
          fragColor = vec4(vCol * uSunColor * w, 1.0);
        }`,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false;
    mesh.name = 'asteroid-dust-' + li;
    group.add(mesh);
    return { mesh, uniforms, Ly };
  });

  function update(camLocal, basis, heroList, gain) {
    const envCam = envelope(camLocal.x, camLocal.y, camLocal.z);
    for (const { uniforms, Ly } of layers) {
      const cc = [Math.floor(camLocal.x / Ly.cell), Math.floor(camLocal.y / Ly.cell), Math.floor(camLocal.z / Ly.cell)];
      uniforms.uCamCell.value.set(cc[0], cc[1], cc[2]);
      uniforms.uCamFrac.value.set(camLocal.x - cc[0] * Ly.cell, camLocal.y - cc[1] * Ly.cell, camLocal.z - cc[2] * Ly.cell);
      uniforms.uBasis.value.copy(basis);
      uniforms.uFieldGain.value = gain;
      uniforms.uEnvCam.value = envCam;
    }
    for (let i = 0; i < 4; i++) {
      const hsrc = heroList[i];
      if (hsrc) heroes.value[i].copy(hsrc);
      else heroes.value[i].set(0, 0, 0, 0);
    }
  }
  return { object: group, update };
}
