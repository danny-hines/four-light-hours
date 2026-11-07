// FALLBACK copy used by main.js when the real module fails to load. Do not edit.
// Owned by the director/integration builder (may be refined). Contract: see CONTRACT.md ("Glints").
import * as THREE from 'three';
import { JOURNEY_ORDER, BODIES } from '../core/bodies-data.js';

const ALBEDO = { mercury: 0.14, venus: 0.75, earth: 0.37, mars: 0.25, jupiter: 0.52, saturn: 0.47, uranus: 0.51, neptune: 0.41 };
const TINT = { mercury: 0x9a948c, venus: 0xfff0c8, earth: 0x9ec4ff, mars: 0xffa070, jupiter: 0xffe6c4, saturn: 0xffe2a8, uranus: 0xc8f4ff, neptune: 0x8fb0ff };

export async function create(ctx) {
  const ids = JOURNEY_ORDER.filter((id) => id !== 'sun');
  const pos = new Float32Array(ids.length * 3), rad = new Float32Array(ids.length), alb = new Float32Array(ids.length), col = new Float32Array(ids.length * 3);
  ids.forEach((id, i) => {
    ctx.positions[id].toArray(pos, i * 3);
    rad[i] = BODIES[id].radius;
    alb[i] = ALBEDO[id];
    new THREE.Color(TINT[id]).toArray(col, i * 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aRadius', new THREE.BufferAttribute(rad, 1));
  g.setAttribute('aAlbedo', new THREE.BufferAttribute(alb, 1));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  const m = new THREE.ShaderMaterial({
    uniforms: { uSunPosW: ctx.U.uSunPosW, uResolution: ctx.U.uResolution },
    vertexShader: /* glsl */ `
      attribute float aRadius; attribute float aAlbedo; attribute vec3 aColor;
      uniform vec3 uSunPosW; uniform vec2 uResolution;
      varying vec3 vC;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        float d = length(wp.xyz);
        float rpx = aRadius / d * projectionMatrix[1][1] * uResolution.y * 0.5;
        vec3 toSun = normalize(uSunPosW - wp.xyz), toCam = normalize(-wp.xyz);
        float a = acos(clamp(dot(toSun, toCam), -1.0, 1.0));
        float phase = (sin(a) + (3.14159265 - a) * cos(a)) / 3.14159265;
        float b = aAlbedo * phase * clamp(pow(max(rpx, 1e-6) / 1.5, 0.5), 0.02, 1.0) * 3.0;
        b *= 1.0 - smoothstep(1.5, 4.0, rpx);
        vC = aColor * b;
        gl_Position = projectionMatrix * viewMatrix * wp;
        gl_PointSize = 4.0;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vC;
      void main() { vec2 d = gl_PointCoord - 0.5; gl_FragColor = vec4(vC * exp(-dot(d, d) * 22.0), 1.0); }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(g, m);
  points.frustumCulled = false;
  points.renderOrder = 10;
  return { object: points, update(frame) {} };
}
