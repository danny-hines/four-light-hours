// isolate the cloud code: keep everything before main(), replace main with a minimal caller
function cut(src, mainBody) {
  const i = src.indexOf('void main() {');
  return src.slice(0, i) + 'void main() {\n' + mainBody + '\n}\n';
}
const one = `vec3 pb = normalize(vPosW); vec3 g; float r0, h;
  float R = cloudField(pb, pb.xy, vec4(dFdx(pb.xy), dFdy(pb.xy)), 1e-4, dFdx(pb), dFdy(pb), 8, 1.0, g, r0, h);
  gl_FragColor = vec4(R, g + r0 + h);`;
const two = `vec3 pb = normalize(vPosW); vec3 acc = vec3(0.0); float rr = 0.0;
  for (int k = 0; k < uLoopMax; k++) { if (k >= 2) break; vec3 g; float r0, h;
  float R = cloudField(pb + float(k), pb.xy, vec4(dFdx(pb.xy), dFdy(pb.xy)), 1e-4, dFdx(pb), dFdy(pb), 8, 1.0, g, r0, h);
  acc += g; rr += R + r0 + h; }
  gl_FragColor = vec4(rr, acc);`;
const noisOnly = `vec3 pb = normalize(vPosW); float v; vec3 gb; float fv, ck;
  vec4 n = cloudNoise(pb, pb, pb, 1e-4, 8, 0.5, 1.0, 0.2, 0.1, 0.05, v, gb, fv, ck);
  gl_FragColor = n + vec4(gb, v + fv + ck);`;
const worleyOnly = `vec3 r1, r2; vec4 B; float h1; vec2 F = worleyD(vPosW * 300.0, r1, r2, B, h1); gl_FragColor = vec4(F, h1, 1.0) + B + vec4(r1 + r2, 0.0);`;
export default [
  { name: 'worley only', kind: 'radiance', frag: (s) => cut(s, worleyOnly) },
  { name: 'cloudNoise only', kind: 'radiance', frag: (s) => cut(s, noisOnly) },
  { name: 'cloudField x1', kind: 'radiance', frag: (s) => cut(s, one) },
  { name: 'cloudField in k loop', kind: 'radiance', frag: (s) => cut(s, two) },
];
