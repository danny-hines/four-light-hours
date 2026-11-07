// FALLBACK copy used by main.js when the real module fails to load. Do not edit.
import * as THREE from 'three';

export async function create(ctx) {
  const N = 6000;
  const pos = new Float32Array(N * 3), mag = new Float32Array(N);
  let s = 1234567;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < N; i++) {
    const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    pos.set([r * Math.cos(th) * 1e7, u * 1e7, r * Math.sin(th) * 1e7], i * 3);
    mag[i] = rnd();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uSkyGain: ctx.U.uSkyGain },
    vertexShader: `attribute float aMag; varying float vB; void main(){ vB = pow(aMag, 8.0); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = 2.0; }`,
    fragmentShader: `uniform float uSkyGain; varying float vB; void main(){ vec2 d = gl_PointCoord - 0.5; float a = exp(-dot(d,d)*18.0); gl_FragColor = vec4(vec3(0.05 + 2.0*vB) * a * uSkyGain, 1.0); }`,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    transparent: false, // opaque pass + renderOrder -1000 => drawn first, everything else covers it
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.renderOrder = -1000;
  return { object: pts, update(frame) {} };
}
