// Fallback body (used when a body module fails to load): a Lambert-lit sphere. Do not edit.
import * as THREE from 'three';
import { bodyQuaternion } from '../core/astro.js';

export function placeholderBody(ctx, { id, radius, color = 0x888888, rot = id, emissive = false }) {
  const U = ctx.U;
  const object = new THREE.Group();
  object.name = id;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uSunPosW: U.uSunPosW, uColor: { value: new THREE.Color(color) }, uEmissive: { value: emissive ? 1 : 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vNormalW; varying vec3 vPosW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPosW = wp.xyz; vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunPosW; uniform vec3 uColor; uniform float uEmissive;
      varying vec3 vNormalW; varying vec3 vPosW;
      void main() {
        vec3 L = normalize(uSunPosW - vPosW);
        float d = max(dot(normalize(vNormalW), L), 0.0);
        vec3 c = uEmissive > 0.5 ? uColor * 40.0 : uColor * d;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 128, 64), mat);
  object.add(mesh);
  const q = new THREE.Quaternion();
  return {
    id,
    radius,
    object,
    moons: [],
    update(frame) {
      if (rot) mesh.quaternion.copy(bodyQuaternion(rot, frame.simDays, q));
    },
  };
}
