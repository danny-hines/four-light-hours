import { stub } from './variants-a.mjs';
const S = (sig, body) => (s) => stub(s, sig, body);
const cut = (a, b, r = '') => (s) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('marker ' + a); return s.slice(0, i) + r + s.slice(j); };
const all = (...fs) => (s) => fs.reduce((a, f) => f(a), s);
const noCL = S('vec3 cityLights(', 'return vec3(M);');
const noLight = cut('    // ---------------- cloud radiance', '    // ---------------- composite', '    vec3 Lcl = vec3(Rcl);\n');
const noAir = cut('    vec3 pt = x.hit ?', '    outL += (1.0 - cov) * Lsky;', '');
const noMarch = cut('    for (int i = 0; i < uLoopMax; i++) {\n      if (i >= NA + NB + NC) break;', '  vec3 outL = vec3(0.0);', '  }\n');
export default [
  { name: 'A-CL', kind: 'radiance', frag: noCL },
  { name: 'A-light', kind: 'radiance', frag: noLight },
  { name: 'A-CL-light', kind: 'radiance', frag: all(noCL, noLight) },
  { name: 'A-air', kind: 'radiance', frag: noAir },
  { name: 'A-march', kind: 'radiance', frag: noMarch },
  { name: 'A-CL-light-air', kind: 'radiance', frag: all(noCL, noLight, noAir) },
];
