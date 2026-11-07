import { NOISE_GLSL } from '../../../glsl/noise.js';
import { NOISE_D_GLSL } from '../noise-d.js';
const head = `${NOISE_GLSL}\n${NOISE_D_GLSL}\nvarying vec3 vPosW;\n`;
function inl(n) {
  let b = 'vec4 s = vec4(0.0); vec3 p = vPosW;\n';
  for (let i = 0; i < n; i++) b += `s += snoised(p * ${(1 + i * 1.7).toFixed(2)} + s.yzw * 0.1);\n`;
  return `${head}void main(){ ${b} gl_FragColor = s; }`;
}
function loop(n) {
  return `${head}void main(){ vec4 s = vec4(0.0); vec3 p = vPosW; for (int i = 0; i < uLoopMax; i++) { if (i >= ${n}) break; s += snoised(p * (1.0 + float(i) * 1.7) + s.yzw * 0.1); } gl_FragColor = s; }`;
}
function inlLoops(n) { // n separate uniform loops (each one site)
  let b = 'vec4 s = vec4(0.0); vec3 p = vPosW;\n';
  for (let j = 0; j < n; j++) b += `for (int i = 0; i < uLoopMax; i++) { if (i >= 4) break; s += snoised(p * (${(1 + j).toFixed(1)} + float(i) * 1.7) + s.yzw * 0.1); }\n`;
  return `${head}void main(){ ${b} gl_FragColor = s; }`;
}
export default [
  { name: 'inline 1', kind: 'transmit', frag: () => inl(1) },
  { name: 'inline 5', kind: 'transmit', frag: () => inl(5) },
  { name: 'inline 10', kind: 'transmit', frag: () => inl(10) },
  { name: 'inline 20', kind: 'transmit', frag: () => inl(20) },
  { name: 'inline 40', kind: 'transmit', frag: () => inl(40) },
  { name: 'loop 20', kind: 'transmit', frag: () => loop(20) },
  { name: '5 loops', kind: 'transmit', frag: () => inlLoops(5) },
  { name: '10 loops', kind: 'transmit', frag: () => inlLoops(10) },
];
