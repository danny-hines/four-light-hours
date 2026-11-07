const cut = (a, b, r = '') => (s) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('marker ' + a); return s.slice(0, i) + r + s.slice(j); };
let unrolled = '  float h = 0.0, hu = 0.0, hv = 0.0;\n  int txb = int(i0.x) - 1;\n';
for (let x = 0; x < 4; x++) unrolled += `  int tx${x} = txb + ${x}; tx${x} = tx${x} - sz.x * int(floor(float(tx${x}) / float(sz.x)));\n`;
for (let y = 0; y < 4; y++) {
  unrolled += `  { int ty = clamp(int(i0.y) - 1 + ${y}, 0, sz.y - 1); float r = 0.0, rd = 0.0;\n`;
  for (let x = 0; x < 4; x++) unrolled += `    { float v = texelFetch(uHeight, ivec2(tx${x}, ty), 0).r; r += v * wx.${'xyzw'[x]}; rd += v * dx.${'xyzw'[x]}; }\n`;
  unrolled += `    h += r * wy.${'xyzw'[y]}; hu += rd * wy.${'xyzw'[y]}; hv += r * dy.${'xyzw'[y]}; }\n`;
}
export default [
  { name: 'M-unrolledB', kind: 'moon', frag: cut('  float h = 0.0, hu = 0.0, hv = 0.0;\n  for (int k = 0; k < uLoopMax; k++) {\n    if (k >= 16) break;', '  float s = H_MAX - H_MIN;', unrolled) },
];
