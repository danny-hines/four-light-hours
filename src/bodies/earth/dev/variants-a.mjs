// stub a function body (brace-matched) by its signature prefix
export function stub(src, sig, body) {
  const i = src.indexOf(sig);
  if (i < 0) throw new Error('no ' + sig);
  let j = src.indexOf('{', i), d = 0, k = j;
  for (; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) break; } }
  return src.slice(0, j) + '{ ' + body + ' }' + src.slice(k + 1);
}
const S = (sig, body) => (s) => stub(s, sig, body);
const all = (...fs) => (s) => fs.reduce((a, f) => f(a), s);
const noSn = S('float snoise(vec3 v)', 'return fract(dot(v, vec3(0.3,0.5,0.7)));');
const noSnd = S('vec4 snoised(vec3 v)', 'return fract(v.xyzx * 0.37);');
export default [
  { name: 'no snoise', kind: 'radiance', frag: noSn },
  { name: 'no snoised', kind: 'radiance', frag: noSnd },
  { name: 'no noise at all', kind: 'radiance', frag: all(noSn, noSnd) },
  { name: 'no marchSegment', kind: 'radiance', frag: S('void marchSegment(', 'L += vec3(ta); T *= 0.9;') },
  { name: 'no cloudField', kind: 'radiance', frag: S('float cloudField(', 'grad = vec3(0.0); R0mean = 0.0; hTop = 0.0; return 0.0;') },
  { name: 'no cityLights', kind: 'radiance', frag: S('vec3 cityLights(', 'return vec3(M);') },
  { name: 'no worleyD', kind: 'radiance', frag: S('vec2 worleyD(', 'r1 = p; r2 = p; blob = vec4(p, 1.0); return p.xy;') },
  { name: 'no cloudMapLod', kind: 'radiance', frag: S('float cloudMapLod(', 'return lod;') },
  { name: 'no fbmd2', kind: 'radiance', frag: S('vec4 fbmd2(', 'return vec4(p, fp);') },
  { name: 'moon: no craterField', kind: 'moon', frag: S('void craterField(', 'acc.h = 0.0;') },
  { name: 'moon: no lolaBspline', kind: 'moon', frag: S('vec3 lolaBspline(', 'return vec3(uv, 0.0);') },
];
