import { stub } from './variants-a.mjs';
const S = (sig, body) => (s) => stub(s, sig, body);
const all = (...fs) => (s) => fs.reduce((a, f) => f(a), s);
// replace the text between two markers (exclusive of b) with r
const cut = (a, b, r = '') => (s) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('marker ' + a); return s.slice(0, i) + r + s.slice(j); };
const noCF = S('float cloudField(', 'grad = vec3(0.0); R0mean = 0.0; hTop = 0.0; return pb.x;');
const noCL = S('vec3 cityLights(', 'return vec3(M);');
const base = all(noCF, noCL);
export default [
  { name: 'base', kind: 'radiance', frag: base },
  { name: 'base-cloudlight', kind: 'radiance', frag: all(base, cut('    // ---------------- cloud radiance', '    // ---------------- composite', '    vec3 Lcl = vec3(Rcl);\n')) },
  { name: 'base-ocean', kind: 'radiance', frag: all(base, cut('    vec3 Lsea = vec3(0.0);', '    vec3 Lg = mix(', '    vec3 Lsea = vec3(muS);\n')) },
  { name: 'base-season', kind: 'radiance', frag: all(base, cut('    // ---------------- seasonal', '    // ---------------- albedo', '    float seaIce = 0.0, floes = 0.0, snowCover = 0.0, canopy = 1.0;\n')) },
  { name: 'base-airglow', kind: 'radiance', frag: all(base, cut('    if (uAirglow > 0.0) {', '    outL += (1.0 - cov) * Lsky;', '')) },
  { name: 'base-detail', kind: 'radiance', frag: all(base, cut('    // ---------------- all fbm detail', '    vec3 Nl = transpose(uW2B)', '    float lift = 0.0; bool det = false; vec4 an = vec4(0.0), wn = an, sn = an, swn = an; float wRes = 0.0;\n')) },
];
