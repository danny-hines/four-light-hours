// compare the per-phase cloud noise (noise1.glsl in the scratchpad) against the interleaved one
import fs from 'node:fs';
const N1 = fs.readFileSync('C:/Users/danny/AppData/Local/Temp/claude/C--Users-danny-fun/6f6a9dda-209e-410f-8186-f810075dd4ce/scratchpad/noise1.glsl', 'utf8');
export function perPhase(s) {
  const i = s.indexOf('// procedural sub-texel field for BOTH flow phases');
  const j = s.indexOf('// Cloud layer reflectance R (0..1) at body-frame direction pb.');
  s = s.slice(0, i) + N1 + s.slice(j);
  const a = s.indexOf('  float varU, fine, ck;\n  vec3 gb;\n  vec4 n = cloudNoise2(');
  const b = s.indexOf('  // exact anti-aliasing: the field', a);
  const loop = `  vec4 n = vec4(0.0);
  vec3 gb = vec3(0.0);
  float varU = 0.0, fine = 0.0, ck = 0.0;
  for (int k = 0; k < uLoopMax; k++) {
    if (k >= 2) break;
    float wk = (k == 0 ? wA : wB) * nrm;
    float vU, fk, ckk; vec3 gbk;
    vec4 nk = cloudNoise(k == 0 ? q0 : q1, k == 0 ? uSeedA : uSeedB, k == 0 ? w0 : w1, fp, maxOct, cellW, open, dense, streak, t, sT, vU, gbk, fk, ckk);
    vec2 r = k == 0 ? r0 : r1;
    // back to the body frame (the phase sampled a longitude-rotated direction)
    n += wk * vec4(nk.x, r.x * nk.y - r.y * nk.w, nk.z, r.x * nk.w + r.y * nk.y);
    gb += wk * vec3(r.x * gbk.x - r.y * gbk.z, gbk.y, r.x * gbk.z + r.y * gbk.x);
    fine += wk * fk;
    ck += (k == 0 ? wA : wB) * ckk;
    varU += (k == 0 ? wA : wB) * vU;
  }
`;
  return s.slice(0, a) + loop + s.slice(b);
}
export default [{ name: 'C-perphase', kind: 'clouds', frag: perPhase }];
