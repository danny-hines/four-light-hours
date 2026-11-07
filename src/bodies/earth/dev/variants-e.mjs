import { stub } from './variants-a.mjs';
const S = (sig, body) => (s) => stub(s, sig, body);
const all = (...fs) => (s) => fs.reduce((a, f) => f(a), s);
const noCF = S('float cloudField(', 'grad = vec3(0.0); R0mean = 0.0; hTop = 0.0; return pb.x;');
const noCN = S('vec4 cloudNoise(', 'varU = 0.0; gBump = q; fineV = 0.0; cellK = 1.0; return vec4(q, fp);');
const noW = S('vec2 worleyD(', 'r1 = p; r2 = p; blob = vec4(p, 1.0); h1 = 0.0; return p.xy;');
const noSnd = S('vec4 snoised(vec3 v)', 'return fract(v.xyzx * 0.37);');
const noCL = S('vec3 cityLights(', 'return vec3(M);');
const noFbm = S('vec4 fbmT(', 'return vec4(p, fp);');
const noMS = S('float moonShadow(', 'return 1.0;');
export default [
  { name: 'no cloudField', kind: 'radiance', frag: noCF },
  { name: 'no cloudNoise', kind: 'radiance', frag: noCN },
  { name: 'no worley', kind: 'radiance', frag: noW },
  { name: 'no snoised', kind: 'radiance', frag: noSnd },
  { name: 'no cityLights', kind: 'radiance', frag: noCL },
  { name: 'no fbmT', kind: 'radiance', frag: noFbm },
  { name: 'no CF, CL', kind: 'radiance', frag: all(noCF, noCL) },
  { name: 'no CF, CL, fbmT', kind: 'radiance', frag: all(noCF, noCL, noFbm) },
];
