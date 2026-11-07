import { stub } from './variants-a.mjs';
const S = (sig, body) => (s) => stub(s, sig, body);
const all = (...fs) => (s) => fs.reduce((a, f) => f(a), s);
const noSn = S('float snoise(vec3 v)', 'return fract(dot(v, vec3(0.3,0.5,0.7)));');
const noSnd = S('vec4 snoised(vec3 v)', 'return fract(v.xyzx * 0.37);');
const noML = S('float cloudMapLod(', 'return lod;');
const noW = S('vec2 worleyD(', 'r1 = p; r2 = p; blob = vec4(p, 1.0); return p.xy;');
const noCL = S('vec3 cityLights(', 'return vec3(M);');
const noMS = S('void marchSegment(', 'L += vec3(ta); T *= 0.9;');
const noCF = S('float cloudField(', 'grad = vec3(0.0); R0mean = 0.0; hTop = 0.0; return 0.0;');
export default [
  { name: 'noise+ML', kind: 'radiance', frag: all(noSn, noSnd, noML) },
  { name: 'noise+ML+W+CL', kind: 'radiance', frag: all(noSn, noSnd, noML, noW, noCL) },
  { name: 'noise+ML+W+CL+MS', kind: 'radiance', frag: all(noSn, noSnd, noML, noW, noCL, noMS) },
  { name: 'only ML removed', kind: 'radiance', frag: noML },
  { name: 'ML+CF', kind: 'radiance', frag: all(noML, noCF) },
  { name: 'ML+CF+noise', kind: 'radiance', frag: all(noML, noCF, noSn, noSnd) },
];
