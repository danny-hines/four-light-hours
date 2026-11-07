const cut = (a, b, r = '') => (s) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('marker ' + a); return s.slice(0, i) + r + s.slice(j); };
const all = (...fs) => (s) => fs.reduce((a, f) => f(a), s);
export default [
  { name: 'G-ocean', kind: 'ground', frag: cut('  if (oceanW > 0.0) {\n    float shelf', '  gl_FragColor = vec4(Lg, water);', '') },
  { name: 'G-jobs', kind: 'ground', frag: cut('  // one flattened loop over (job, octave)', '  float lift = 0.0;', '  vec4 rn = vec4(0.0), dn = rn, an = rn, wn = rn, sn = rn, swn = rn;\n') },
  { name: 'G-season', kind: 'ground', frag: cut('  // ---------------- seasonal sea ice', '  // ---------------- albedo', '  float seaIce = 0.0, floes = 0.0, snowCover = 0.0, canopy = 1.0;\n') },
  { name: 'G-relief', kind: 'ground', frag: cut('  // ---------------- relief from the height map', '  // ---------------- all fbm detail', '  vec3 gradB = vec3(0.0); float mtn = 0.0, sand = 0.0;\n') },
  { name: 'G-jitter', kind: 'ground', frag: cut('  float jw = smoothstep(DAY_TEXEL * 0.8', '  vec3 day = textureGrad', '') },
];
