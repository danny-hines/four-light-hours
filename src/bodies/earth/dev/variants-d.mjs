import { stub } from './variants-a.mjs';
const S = (sig, body) => (s) => stub(s, sig, body);
const all = (...fs) => (s) => fs.reduce((a, f) => f(a), s);
const noSn = S('float snoise(vec3 v)', 'return fract(dot(v, vec3(0.3,0.5,0.7)));');
const noSnd = S('vec4 snoised(vec3 v)', 'return fract(v.xyzx * 0.37);');
const noML = S('float cloudMapLod(', 'return lod;');
const noCL = S('vec3 cityLights(', 'return vec3(M);');
const noMS = S('void marchSegment(', 'L += vec3(ta); T *= 0.9;');
const noCF = S('float cloudField(', 'grad = vec3(0.0); R0mean = 0.0; hTop = 0.0; return 0.0;');
const noMoonSh = S('float moonShadow(', 'return 1.0;');
const noST = S('vec3 sunTrans(', 'return vec3(r, mu, 1.0);');
const base = all(noML, noCF, noSn, noSnd);
export default [
  { name: 'skel', kind: 'radiance', frag: base },
  { name: 'skel-CL', kind: 'radiance', frag: all(base, noCL) },
  { name: 'skel-CL-MS', kind: 'radiance', frag: all(base, noCL, noMS) },
  { name: 'skel-CL-MS-moonSh-sunTrans', kind: 'radiance', frag: all(base, noCL, noMS, noMoonSh, noST) },
];
