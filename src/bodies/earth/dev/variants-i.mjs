const rep = (a, b) => (s) => { if (!s.includes(a)) throw new Error('no ' + a); return s.replace(a, b); };
export default [
  { name: 'C-noKloop', kind: 'clouds', frag: rep('  for (int k = 0; k < uLoopMax; k++) {\n    if (k >= 2) break;\n    bool sh = k == 1;', '  { int k = 0; bool sh = false;') },
  { name: 'C-noPhaseLoop', kind: 'clouds', frag: rep('  for (int k = 0; k < uLoopMax; k++) {\n    if (k >= 2) break;\n    float wk = (k == 0 ? wA : wB) * nrm;', '  { int k = 0; float wk = 1.0;') },
];
