import { stub } from './variants-a.mjs';
const S = (sig, body) => (s) => stub(s, sig, body);
const cut = (a, b, r = '') => (s) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('marker ' + a); return s.slice(0, i) + r + s.slice(j); };
export default [
  { name: 'M-crater', kind: 'moon', frag: S('void craterField(', 'acc.alb = 0.0;') },
  { name: 'M-relief', kind: 'moon', frag: S('vec4 moonRelief(', 'return vec4(p, lmin);') },
  { name: 'M-march', kind: 'moon', frag: cut('    if (kl > 1e-4 && tanK < 0.6) {', '  float shS =', '  }\n') },
  { name: 'M-polar', kind: 'moon', frag: cut('  if (polar > 0.0) {', '  // footprint: the obliquity', '') },
  { name: 'M-bspline', kind: 'moon', frag: S('vec3 lolaBspline(', 'return vec3(uv, 1.0);') },
  { name: 'M-photo', kind: 'moon', frag: S('float lunarPhotometry(', 'return mu0 * mu;') },
];
