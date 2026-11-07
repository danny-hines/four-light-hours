import { stub } from './variants-a.mjs';
const S = (sig, body) => (s) => stub(s, sig, body);
const cut = (a, b, r = '') => (s) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('marker ' + a); return s.slice(0, i) + r + s.slice(j); };
export default [
  { name: 'C-worley', kind: 'clouds', frag: S('vec2 worleyD(', 'r1 = p; r2 = p; blob = vec4(p, 1.0); h1 = 0.0; return p.xy;') },
  { name: 'C-octaves', kind: 'clouds', frag: cut('  float sy = 1.0 + 1.6 * streak;', '  return s;\n}', '') },
  { name: 'C-cellblock', kind: 'clouds', frag: cut('    const float fc = 300.0;', '  float sy = 1.0', '  }\n') },
  { name: 'C-maploopwarp', kind: 'clouds', frag: cut('    if (warpW > 0.0) {', '    if (k == 0) { q0 = q;', '') },
  { name: 'C-dome', kind: 'clouds', frag: cut('  float Hc = KM * mix(', '  return R;\n}', '  hTop = 0.0; grad = gb;\n') },
  { name: 'C-cloudNoise', kind: 'clouds', frag: S('vec4 cloudNoise(', 'varU = 0.0; gBump = q; fineV = 0.0; cellK = 1.0; return vec4(q, fp);') },
  { name: 'C-cloudField', kind: 'clouds', frag: S('float cloudField(', 'grad = vec3(0.0); R0mean = 0.0; hTop = 0.0; return pb.x;') },
];
