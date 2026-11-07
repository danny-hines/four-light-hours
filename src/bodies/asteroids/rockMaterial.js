// Rock surface shader (instanced). Linear HDR radiance out; unit solar irradiance (white Lambert facing the Sun = 1).
//
//  * Geometry: per-instance quaternion (tumble), non-uniform stretch and scale; continuous LOD morph coarse->fine.
//  * Photometry: lunar-Lambert (Lommel-Seeliger <-> Lambert by phase angle, McEwen 1991) x phase darkening x
//    opposition surge (shadow hiding), the way regolith-covered airless bodies actually scatter. Metal (M-type)
//    rocks add a rough GGX lobe. Almost no fill light: the Sun at 2.7 AU is a tiny hard source, shadows are black.
//  * Shadows: macro self-shadowing ray-marched through the shape's own octahedral radius map (lobes, ridges and
//    big craters cast crisp shadows); small craters get exact analytic parabolic-bowl shadows (plus bounce light);
//    buried dome boulders cast analytic shadows along the sun ray. Baked vertex AO darkens crevices and scales the faint fill.
//  * Detail: crater layers (5 octaves, 3-D cellular) + gradient-noise regolith, all filtered by pixel footprint
//    so nothing shimmers; albedo variation from space weathering, fresh crater ejecta, ponds and boulders.
import * as THREE from 'three';
import { fieldGLSL, MESH_PX } from './field.js';

const NOISE_GRAD_GLSL = /* glsl */ `
vec3 mod289v3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289v4(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute4(vec4 x) { return mod289v4(((x * 34.0) + 1.0) * x); }
vec4 tis4(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
// 3-D simplex noise with analytic gradient (Ashima / Stefan Gustavson, MIT)
float snoiseG(vec3 v, out vec3 grad) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289v3(i);
  vec4 p = permute4(permute4(permute4(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = tis4(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  vec4 m2 = m * m;
  vec4 m4 = m2 * m2;
  vec4 pdotx = vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3));
  vec4 temp = m2 * m * pdotx;
  grad = -8.0 * (temp.x * x0 + temp.y * x1 + temp.z * x2 + temp.w * x3);
  grad += m4.x * p0 + m4.y * p1 + m4.z * p2 + m4.w * p3;
  grad *= 42.0;
  return 42.0 * dot(m4, pdotx);
}
`;

export const PHOTOMETRY_GLSL = /* glsl */ `
// Airless regolith photometry. Returns I/F (radiance factor) for unit albedo, given cosines and phase angle.
float lunarL(float aDeg) {
  // lunar-Lambert weight L(alpha) (McEwen 1991/1996 lunar fits, ~exponential in phase): 1 at opposition,
  // ~0.4 at 60 deg, ~0.1 at 140 deg, so crescents keep the bright Lommel-Seeliger limb of real regolith
  return exp(-aDeg / 62.0);
}
float phaseDarkening(float alpha, float dark) {
  // regolith phase curve normalised to 1 at zero phase: exponential decline + shadow-hiding opposition surge
  float t = tan(0.5 * min(alpha, 3.0));
  float surge = (1.0 + 0.55 / (1.0 + t / 0.05)) / 1.55;
  return surge * exp(-(0.62 + 0.55 * dark) * alpha);
}
float airless(float mu0, float mu, float alpha, float dark) {
  float L = lunarL(degrees(alpha));
  float ls = 2.0 * mu0 / max(mu0 + mu, 1e-4);
  return phaseDarkening(alpha, dark) * (L * ls + (1.0 - L) * mu0);
}
// Hapke (1984) macroscopic roughness (mean slope tan = tb): effective cosines mu0e, mue and the shadowing
// function S, so that even at low phase a rough regolith keeps limb darkening and relief.
float hapkeE1(float x, float tb) { return exp(-2.0 / (3.14159265 * tb * max(tan(x), 1e-4))); }
float hapkeE2(float x, float tb) { float t = max(tan(x), 1e-4); return exp(-1.0 / (3.14159265 * tb * tb * t * t)); }
float hapkeRough(float mu0, float mu, float cosg, float tb, out float mu0e, out float mue) {
  float chi = 1.0 / sqrt(1.0 + 3.14159265 * tb * tb);
  float i = clamp(acos(clamp(mu0, 0.0, 1.0)), 1e-3, 1.569), e = clamp(acos(clamp(mu, 0.0, 1.0)), 1e-3, 1.569);
  float ci = cos(i), ce = cos(e), si = sin(i), se = sin(e);
  float cpsi = clamp((cosg - ci * ce) / max(si * se, 1e-4), -1.0, 1.0);
  float psi = acos(cpsi);
  float s2 = sin(0.5 * psi); s2 *= s2;
  float fpsi = exp(-2.0 * tan(min(0.5 * psi, 1.55)));
  float E1i = hapkeE1(i, tb), E1e = hapkeE1(e, tb), E2i = hapkeE2(i, tb), E2e = hapkeE2(e, tb);
  float eta0 = chi * (ci + si * tb * E2i / (2.0 - E1i));
  float etae = chi * (ce + se * tb * E2e / (2.0 - E1e));
  float S;
  if (i <= e) {
    float den = 2.0 - E1e - psi / 3.14159265 * E1i;
    mu0e = chi * (ci + si * tb * (cpsi * E2e + s2 * E2i) / den);
    mue = chi * (ce + se * tb * (E2e - s2 * E2i) / den);
    S = mue / etae * ci / eta0 * chi / (1.0 - fpsi + fpsi * chi * ci / eta0);
  } else {
    float den = 2.0 - E1i - psi / 3.14159265 * E1e;
    mu0e = chi * (ci + si * tb * (E2i - s2 * E2e) / den);
    mue = chi * (ce + se * tb * (cpsi * E2i + s2 * E2e) / den);
    S = mue / etae * ci / eta0 * chi / (1.0 - fpsi + fpsi * chi * ce / etae);
  }
  return clamp(S, 0.0, 1.0);
}
// resolved regolith: lunar-Lambert on the Hapke-roughened cosines, times the shadowing function
float airlessRough(float mu0, float mu, float alpha, float dark, float tb) {
  float mu0e, mue;
  float S = hapkeRough(mu0, mu, cos(alpha), tb, mu0e, mue);
  float chi = 1.0 / sqrt(1.0 + 3.14159265 * tb * tb);
  float L = lunarL(degrees(alpha));
  float ls = 2.0 * mu0e / max(mu0e + mue, 1e-4);
  // a weak forward lobe from the fine dust coating: a hairline bright limb on thin crescents
  float fwd = 0.5 * exp(-(3.14159265 - alpha) / 0.5) * ls * (1.0 - 0.6 * mu);
  return phaseDarkening(alpha, dark) * (L * ls + (1.0 - L) * mu0e / chi) * S + fwd * sqrt(S);
}
// Disc-integrated version for unresolved rocks (Lommel-Seeliger sphere integral x the same phase darkening)
float airlessDisc(float alpha, float dark) {
  float a = clamp(alpha, 1e-3, 3.1);
  float ls = 1.0 - sin(0.5 * a) * tan(0.5 * a) * log(1.0 / tan(0.25 * a));
  return max(ls, 0.0) * phaseDarkening(a, dark);
}
`;

const DEBUG = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get('astdbg') || '';
  } catch {
    return '';
  }
})();

export function rockMaterial(ctx, { shape, lod, radiusMap, rubble = 0, t1 = 4.0 }) {
  // LODs that are drawn while the lattice impostor cross-fades (8..12 px) dissolve in with alpha-to-coverage
  const fadeLod = lod <= 1 + Math.log2((MESH_PX * 1.5) / t1);
  const { U } = ctx;
  const dbg = DEBUG.split(',').filter(Boolean).map((k) => `#define DBG_${k.toUpperCase()}`).join(String.fromCharCode(10));
  const uniforms = {
    uVN: { value: 8 }, // loop bound of the GLSL value noise (hash.js): a uniform so FXC keeps a real loop
    uSunPosW: U.uSunPosW,
    uSunColor: U.uSunColor,
    uTime: U.uTime,
    uK: ctx.sharedK,
    uLod: { value: lod },
    uT1: { value: t1 },
    uBoundR: { value: shape.boundR },
    uAxes: { value: new THREE.Vector3(...shape.axes) },
    uRadiusMap: { value: radiusMap },
    uMapSize: { value: shape.S },
    uRubble: { value: rubble },
    uCraterDensity: { value: 1.0 * (1 - 0.6 * Math.min(1, rubble)) },
    uBoulders: { value: shape.hero ? (shape.kind === 'vesta' ? 0 : Math.max(rubble, 0.35)) : rubble },
    uMaxLod: { value: shape.level },
    uMapTexel: { value: 1.6 / shape.S },
    uLodSp: { value: 1.1 / Math.pow(2, lod) },
    uN8: { value: 8 },
    uN6: { value: 8 },
    uNCrater: { value: 7 },
    uNBoulder: { value: 4 },
    uNShadow: { value: 40 },
    uNNoise: { value: 7 },
    uNCand: { value: 4 },
    // LODs drawn while the lattice impostor cross-fades (8..12 px) dissolve in with alpha-to-coverage. Every rock
    // material enables alpha-to-coverage (alpha 1 elsewhere = full coverage), so all 155 (shape, LOD) materials
    // share ONE program: alphaToCoverage is a program parameter in three.js and used to split them into two.
    uFade: { value: fadeLod ? 1 : 0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    glslVersion: THREE.GLSL3,
    alphaToCoverage: true,
    vertexShader: /* glsl */ `
      ${fieldGLSL()}
      in vec3 aPosC;
      in vec3 aNorC;
      in vec4 aAO;
      in vec4 aAOC;
      in vec4 iA; // camera-relative centre (world axes), scale
      in vec4 iQ; // orientation
      in vec4 iB; // stretch xyz, seed
      in vec4 iC; // albedo colour, type
      uniform float uK, uLod, uT1, uBoundR, uMaxLod;
      out vec3 vPo;
      out vec3 vNo;
      out vec4 vAO;
      out vec3 vPosW;
      flat out vec4 vQ;
      flat out vec4 vB;
      flat out vec4 vC;
      flat out vec2 vPx;
      void main() {
        float scale = iA.w;
        vec3 st = iB.xyz;
        float dist = max(length(iA.xyz), 1e-9);
        float pB = uBoundR * max(st.x, max(st.y, st.z)) * scale * uK / dist;
        float m = uLod < 0.5 ? 1.0 : clamp(log2(pB / (uT1 * exp2(uLod - 1.0))), 0.0, 1.0);
        if (uLod >= uMaxLod - 0.5) m = clamp(m, 0.0, 1.0);
        vec3 po = mix(aPosC, position, m);
        vec3 no = mix(aNorC, normal, m);
        vAO = mix(aAOC, aAO, m);
        vPo = po;
        vNo = no;
        vec3 pw = qrot(iQ, po * st) * scale + iA.xyz;
        vec4 wp = modelMatrix * vec4(pw, 1.0);
        vPosW = wp.xyz;
        vQ = iQ;
        vB = iB;
        vC = iC;
        // lattice rocks fade in over 8..12 px as their GPU impostor fades out; heroes (type >= 10) never fade
        vPx = vec2(pB, iC.w >= 9.5 ? 1.0 : sstep(${MESH_PX.toFixed(1)}, ${(MESH_PX * 1.5).toFixed(1)}, pB));
        vC.w = iC.w >= 9.5 ? iC.w - 10.0 : iC.w;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      ${dbg}
      ${fieldGLSL()}
      ${PHOTOMETRY_GLSL}
      uniform vec3 uSunPosW;
      uniform vec3 uSunColor;
      uniform float uBoundR, uMapSize, uRubble, uTime, uCraterDensity, uBoulders, uMapTexel, uLodSp, uLod, uMaxLod;
      uniform vec3 uAxes;
      // loop counts come from uniforms so the D3D compiler (ANGLE) keeps them as loops instead of unrolling
      uniform int uN8, uNCrater, uNBoulder, uNShadow, uN6, uNNoise, uNCand;
      uniform float uFade;
      uniform sampler2D uRadiusMap;
      in vec3 vPo;
      in vec3 vNo;
      in vec4 vAO;
      in vec3 vPosW;
      flat in vec4 vQ;
      flat in vec4 vB;
      flat in vec4 vC;
      flat in vec2 vPx;
      out vec4 fragColor;

      vec3 qrotInv(vec4 q, vec3 v) { return qrot(vec4(-q.xyz, q.w), v); }

      vec2 octEncode(vec3 n) {
        n /= (abs(n.x) + abs(n.y) + abs(n.z));
        vec2 e = n.xy;
        if (n.z < 0.0) e = (1.0 - abs(e.yx)) * vec2(e.x >= 0.0 ? 1.0 : -1.0, e.y >= 0.0 ? 1.0 : -1.0);
        return e * 0.5 + 0.5;
      }
      // textureLod: no implicit derivatives inside loops (FXC would try to unroll them); the map has no mips
      float radiusAt(vec3 d) { return textureLod(uRadiusMap, octEncode(d), 0.0).r; }

      // Macro self-shadow: march toward the Sun through the shape's octahedral radius map (shape space).
      // Penumbra of the 0.1-degree Sun at 2.7 AU (0.0018 x distance to the occluder) plus the map's resolution and
      // the pixel footprint; coarse LODs (smoother than the map) get a bias so they don't self-shadow.
      float shapeShadow(vec3 p, vec3 L, float fp) {
        float t = 0.004 + 2.0 * fp;
        float sh = 1.0;
        float bias = (uLod < uMaxLod - 0.5 ? 0.22 : 0.06) * uLodSp;
        for (int i = 0; i < uNShadow; i++) {
          vec3 q = p + L * t;
          float lq = length(q);
          if (lq > uBoundR * 1.02) break;
          float d = lq - radiusAt(q / lq) + bias;
          float w = 0.0018 * t + uMapTexel + 1.0 * fp;
          sh = min(sh, clamp(d / w + 0.5, 0.0, 1.0));
          if (sh <= 0.0) break;
          t += clamp(0.5 * abs(d) + 0.002, 0.004, 0.08);
        }
        return sh;
      }

      // One octave of craters (3-D cellular, so it is seamless on any shape). Simple-crater morphology in units of
      // the crater radius r: a paraboloid bowl from -D0 to the rim crest (+R0) at x = 1, an ejecta flank thinning
      // as x^-3; the crest is knife-sharp when fresh and rounds off (and the bowl shallows) with age. Fresh
      // craters have bright walls and ejecta; old floors collect darker fines. The bowl's cast shadow is exact
      // for the paraboloid (ray vs. convex bowl, in the local tangent plane).
      void craterLayer(vec3 p, float cell, uint salt, float dens, float pBoul, float ageExp, float fp, vec3 n, vec3 Lt, float tanE, float amp,
                       inout float h, inout vec3 g, inout float shadow, inout float fresh, inout float fines, inout float cavAO,
                       inout float bh, inout vec3 bg, inout float bcov, inout float albMod) {
        vec3 q = p / cell;
        vec3 fq = floor(q);
        vec3 f = q - fq;
        ivec3 base = ivec3(fq) + ivec3(step(0.5, f)) - 1;
        // uNCand (4) candidate craters per cell: one cell hash, then ONE pcg round per candidate whose bits give
        // its position (3 x 10 bits) and existence; size and state come from a second round only for hits. With
        // radii 0.13..0.32 cell each octave covers ~15% of the surface, so 7 octaves reach saturation (craters on
        // craters, as on Ida or the lunar highlands) instead of sparse stamped pocks.
        // one flat loop over 8 cells x uNCand candidates (FXC compiles a single loop far faster than a nest)
        uint hcell = 0u;
        ivec3 c = base;
        int nK = uN8 * uNCand;
        int kc = 0, j = -1; // (cell, candidate) counters instead of an integer division per iteration
        for (int k = 0; k < nK; k++) {
          j++;
          if (j == uNCand) { j = 0; kc++; }
          if (j == 0) {
            c = base + ivec3(kc & 1, (kc >> 1) & 1, (kc >> 2) & 1);
            hcell = hashCell(c, salt);
          }
          uint hp = pcg(hcell + uint(j) * 0x9e3779b9u);
          float uE = float(hp & 1023u) * (1.0 / 1024.0);
          // a few candidates are boulders instead (rubble piles, heroes): uE < pBoul
          bool isB = uE < pBoul;
          if (!isB && uE > dens) continue;
          vec3 cpos = (vec3(c) + (vec3(uvec3(hp >> 22u, (hp >> 12u) & 1023u, (hp >> 2u) & 1023u)) + 0.5) * (1.0 / 1024.0)) * cell;
          vec3 dv = p - cpos;
          float d0 = length(dv);
          if (d0 > 0.5 * cell) continue; // beyond the largest crater's reach (1.55 x 0.32 cell)
          uint hh = pcg(hp ^ 0x5bd1e995u);
          float r = cell * (0.13 + 0.19 * pow(rnd(hh, 4u), 1.4));
          float d = length(dv);
          float x = d / r;
          if (x > 1.55) continue;
          // irregular, slightly polygonal rims (impacts into fractured targets)
          vec3 dn = dv / max(d, 1e-7);
          float ra1 = rnd(hh, 6u) * 6.2832, ra2 = rnd(hh, 7u) * 6.2832;
          float irr = 0.07 * sin(5.0 * dot(dn, vec3(0.8, 0.5, 0.33)) + ra1) + 0.05 * sin(9.0 * dot(dn, vec3(-0.3, 0.7, 0.65)) + ra2);
          if (isB) {
            // Boulder: a sub-angular block (irregular polygon-ish footprint from the same rim modulation, x3),
            // a dome of random flatness, 30-60% buried in the regolith, albedo within +-10% of the regolith;
            // hard cast shadow along the sun ray in the tangent plane. N(>D) follows the crater octaves.
            float rb = r * 0.62;
            float xb = d / rb * (1.0 + 2.6 * irr);
            float Hb = rb * (0.45 + 0.5 * rnd(hh, 8u));
            float ex = 0.45 + 0.35 * rnd(hh, 10u);
            float bu = 0.3 + 0.3 * rnd(hh, 9u);
            float q2 = 1.0 - xb * xb;
            float hv = q2 > 0.0 ? Hb * (pow(q2, ex) - bu) / (1.0 - bu) : -1.0;
            if (hv > 0.0 && hv > bh) {
              bh = hv;
              float dd = -2.0 * ex * pow(max(q2, 0.04), ex - 1.0) * xb / rb;
              bg = (Hb / (1.0 - bu)) * dd * dn;
              bcov = clamp(hv / max(1.5 * fp * (Hb / rb + 0.3), 1e-7), 0.0, 1.0);
              albMod = 0.9 + 0.2 * rnd(hh, 5u);
            } else if (hv <= 0.0) {
              vec3 o = dv - n * dot(dv, n);
              float sStar = -dot(o, Lt);
              if (sStar > 0.0) {
                vec3 oc = o + sStar * Lt;
                float Pm = length(oc) / (rb * 0.85);
                float qm = 1.0 - Pm * Pm;
                if (qm > 0.0) {
                  float hm = Hb * (pow(qm, ex) - bu) / (1.0 - bu);
                  float w = 1.5 * fp + 0.0018 * sStar;
                  #ifndef DBG_NOCS
                  shadow *= sstep(-w, w, sStar * tanE - hm);
                  #endif
                }
              }
            }
            continue;
          }
          x *= 1.0 + sstep(0.55, 1.0, x) * irr;
          // degradation state: fresh bowls d/D ~0.21 with a sharp crest ~0.045 D high; gardened ones shallow
          // (d/D ~0.05) and soft. Smaller octaves are older on average (ageExp < 1: seismic shaking and
          // regolith gardening erase small craters first)
          float age = pow(rnd(hh, 5u), ageExp);
          float D0 = (0.42 - 0.33 * age) * amp;
          float R0 = (0.09 - 0.065 * age) * amp;
          float hin = -D0 + (D0 + R0) * x * x, din = 2.0 * (D0 + R0) * x;
          float xo = max(x, 0.5);
          float hout = R0 / (xo * xo * xo), dout = x > 0.5 ? -3.0 * R0 / (xo * xo * xo * xo) : 0.0;
          float kk = (0.012 + 0.2 * age) * (D0 + R0) + 1e-5;
          float hm = clamp(0.5 + 0.5 * (hout - hin) / kk, 0.0, 1.0);
          float hx = mix(hout, hin, hm) - kk * hm * (1.0 - hm);
          float dx = mix(dout, din, hm);
          float tw = clamp((x - 1.15) / 0.4, 0.0, 1.0);
          float win = 1.0 - tw * tw * (3.0 - 2.0 * tw);
          float dwin = -6.0 * tw * (1.0 - tw) / 0.4;
          h += hx * win * r;
          g += (dx * win + hx * dwin) * dv / max(d, 1e-7);
          float fr = (1.0 - age) * (1.0 - age);
          fresh += fr * (1.0 - sstep(0.75, 1.5, x)) * 0.85;
          fines += age * (1.0 - sstep(0.2, 0.8, x)) * 0.35 * amp;
          // sky-view factor inside the bowl (a paraboloid of depth/radius k sees ~1/(1+k^2) of the sky at its floor)
          float kap0 = (D0 + R0);
          cavAO = min(cavAO, 1.0 - (kap0 * kap0 / (1.0 + kap0 * kap0)) * (1.0 - sstep(0.1, 1.0, x)));
          // cast shadow inside the paraboloid bowl
          float hc = dot(cpos - p, n);
          float reff2 = r * r - hc * hc;
          if (reff2 > 0.0 && tanE < 8.0) {
            float reff = sqrt(reff2);
            vec3 qv = (p - (cpos - n * hc)) / reff;
            float rho2 = dot(qv, qv);
            if (rho2 < 1.0) {
              float ql = dot(qv, Lt);
              float sExit = -ql + sqrt(max(ql * ql + 1.0 - rho2, 0.0));
              float kap = (D0 + R0) * reff / r;
              float clear = tanE / max(kap, 1e-4) - 2.0 * ql - sExit;
              float w = 1.2 * fp / reff + 0.003;
              #ifndef DBG_NOCS
              shadow *= sstep(-w, w, clear);
              #endif
            }
          }
        }
      }

      void main() {
        vec3 st = vB.xyz;
        float seedF = vB.w;
        vec3 albedoC = vC.rgb;
        float type = vC.w;
        float pB = vPx.x;

        vec3 posW = vPosW;
        vec3 Lw = normalize(uSunPosW - posW);
        vec3 Vw = normalize(-posW);
        vec3 no = normalize(vNo);
        vec3 p = vPo;
        // shape-space light direction (exact for the stretched shape: shadows are affine-invariant)
        vec3 Lo = normalize(qrotInv(vQ, Lw) / st);
        float fp = max(length(fwidth(p)) * 0.75, 1e-5);

        float h = 0.0;
        vec3 g = vec3(0.0);
        float shadow = 1.0;
        float fresh = 0.0, fines = 0.0;
        float albMod = 1.0;
        float cavAO = 1.0;
        float pond = clamp(vAO.z, 0.0, 1.0);
        uint salt = pcg(uint(seedF * 16777216.0) + 77u);
        vec3 po = p + vec3(seedF * 31.7, seedF * 17.3, seedF * 23.9); // decorrelate instances of one mesh

        float NoL = dot(no, Lo);
        vec3 Lt = Lo - no * NoL;
        float ltLen = length(Lt);
        Lt = ltLen > 1e-5 ? Lt / ltLen : vec3(0.0);
        float tanE = NoL / max(ltLen, 1e-4);

        // ---- one noise loop, one vnoiseH call site (FXC inlines every call site; the loop bound is a uniform):
        // entries 0..2 = albedo (space-weathering patches at 1.6 and 4.2 cycles per radius, mottling at 11),
        // entries 3.. = regolith grain (albedo mottling of the resolved regolith), faded by the pixel footprint.
        // (The relief at those scales comes from the saturated crater octaves and boulders below.)
        float n1 = 0.0, n2 = 0.0, n3 = 0.0, grain = 0.0;
        {
          float fr = 60.0, gw = 0.07;
          int nN = pB > 10.0 ? uNNoise : 3;
          for (int i = 0; i < nN; i++) {
            vec3 q;
            float wf = 1.0;
            if (i == 0) q = p * 1.6 + seedF * 13.0;
            else if (i == 1) q = p * 4.2 - seedF * 7.0;
            else if (i == 2) { q = p * 11.0 + seedF; wf = 1.0 - sstep(0.15, 0.35, fp * 11.0); }
            else {
              wf = 1.0 - sstep(0.12, 0.3, fp * fr);
              if (wf <= 0.0) break;
              q = po * fr + float(i) * 7.31;
            }
            float nv = vnoiseH(q, 0x0a1bu + uint(i) * 7u) * 1.4;
            if (i == 0) n1 = nv;
            else if (i == 1) n2 = nv;
            else if (i == 2) n3 = nv * wf;
            else {
              grain += nv * gw * wf;
              fr *= 2.3;
              gw *= 0.8;
            }
          }
        }

        if (pB > 10.0) {
          // crater octaves (shape units, body mean radius 1): cells 0.2 * 2^-i, radii 0.13..0.32 cell, four
          // candidates per cell, N(>D) ~ D^-2 across octaves (each octave covers a similar area fraction); the
          // mesh carries the larger craters (to ~0.36). Finer octaves are older (gardened) and a little shallower.
          // On rubble piles and heroes some candidates are boulders (N(>D) ~ D^-2 .. -3 with the occupancy).
          float bh = 0.0, bcov = 0.0;
          vec3 bg = vec3(0.0);
          #ifdef DBG_NOCRATER
          for (int i = 0; i < 0; i++) {
          #else
          for (int i = 0; i < uNCrater; i++) {
          #endif
            float oct = float(i);
            float cell = 0.2 * exp2(-oct);
            float w = sstep(1.2 * fp, 3.5 * fp, cell * 0.15);
            if (w <= 0.0) break;
            float hh = 0.0, sh = 1.0, fr = 0.0, fn = 0.0, ca = 1.0;
            vec3 gg = vec3(0.0);
            float dens = uCraterDensity * (1.0 - 0.06 * max(oct - 2.0, 0.0));
            float amp = (1.0 - 0.8 * pond) * (1.0 - 0.12 * max(oct - 1.0, 0.0));
            float ageExp = max(0.18, 0.6 - 0.07 * oct);
            #ifdef DBG_NOBOULDER
            float pBoul = 0.0;
            #else
            float pBoul = uBoulders * (1.0 - pond) * mix(0.12, 0.3, sstep(1.0, 4.0, oct));
            #endif
            float bc0 = bcov;
            craterLayer(po, cell, salt + uint(i) * 101u, dens, pBoul, ageExp, fp, no, Lt, tanE, amp, hh, gg, sh, fr, fn, ca, bh, bg, bcov, albMod);
            bcov = mix(bc0, bcov, w);
            h += hh * w;
            g += gg * w;
            shadow *= mix(1.0, sh, w);
            fresh += fr * w;
            fines += fn * w;
            cavAO = min(cavAO, mix(1.0, ca, w));
          }
          g = mix(g, bg, bcov);
        }
        // perturbed normal (shape space) -> world. The detail normal is shortened by the footprint-faded detail
        // energy (Toksvig-like): where relief is sub-pixel, the lobe widens instead of aliasing.
        vec3 gt = g - no * dot(g, no);
        vec3 nd = normalize(no - gt);
        vec3 Nw = normalize(qrot(vQ, nd / st));
        vec3 Ngw = normalize(qrot(vQ, no / st));

        // macro self-shadow
        float macro = 1.0;
        #ifndef DBG_NOMACRO
        if (pB > 6.0 && NoL > -0.05) macro = shapeShadow(p + no * (0.002 + fp), Lo, fp);
        #endif
        // terminator of the geometric surface
        float geoLit = sstep(-0.02, 0.05, dot(Ngw, Lw));

        float mu0 = dot(Nw, Lw);
        float mu = max(dot(Nw, Vw), 0.02);
        float alpha = acos(clamp(dot(Lw, Vw), -1.0, 1.0));
        float dark = type < 0.5 || type > 3.5 ? 1.0 : 0.0; // C, B, D types have steeper phase curves
        float I = mu0 > 0.0 ? airlessRough(mu0, mu, alpha, dark, 0.58) : 0.0; // Hapke mean slope ~30 deg (Eros, Itokawa)

        // ---- albedo. What makes airless bodies legible at low phase is albedo tied to topography, not noise:
        //  * space weathering: broad maturity patches (+-10%; mature S-type regolith is darker and redder)
        //  * fresh exposures: crater walls and ejecta of young craters, steep slopes (regolith creeps downhill,
        //    exposing fresher material on walls and scarps), convex edges: brighter and, on S-types, less red
        //  * fines: old crater floors and macro concavities collect darker, finer, more weathered regolith
        //  * grain: small-scale mottling of the resolved regolith (+-6%, footprint-filtered)
        float wthr = sstep(-0.45, 0.45, 0.65 * n1 + 0.35 * n2);
        float cav = vAO.y;
        float aoM = clamp(vAO.x, 0.0, 1.0);
        vec3 alb = albedoC * mix(1.1, 0.9, wthr) * (1.0 + 0.07 * n3 + grain) * mix(0.82, 1.0, sstep(0.45, 0.9, aoM)) * albMod;
        bool sType = type > 0.5 && type < 1.5;
        if (sType || type > 3.5) alb *= mix(vec3(0.97, 1.0, 1.04), vec3(1.03, 1.0, 0.95), wthr);
        vec3 lev = normalize(p / (uAxes * uAxes));
        float slope = 1.0 - dot(nd, lev);
        float fr = clamp(fresh, 0.0, 1.0) + clamp(-cav * 0.35, 0.0, 0.12) + vAO.w * 0.9 + sstep(0.05, 0.25, slope) * 0.45;
        vec3 freshTint = (sType || type > 3.5) ? vec3(0.93, 1.0, 1.12) : vec3(1.0, 1.0, 1.02);
        alb *= mix(vec3(1.0), freshTint * 1.75, clamp(fr, 0.0, 1.0) * 0.55);
        alb *= mix(vec3(1.0), vec3(0.78, 0.75, 0.71), clamp(cav * 2.0 + fines, 0.0, 1.0) * 0.55);
        alb *= mix(1.0, 1.12, pond);
        float ao = clamp(vAO.x, 0.0, 1.0);

        float lit = macro * geoLit;
        // cavities lose a little light whatever the Sun's elevation (fewer illuminated facets seen inside a bowl,
        // shadow hiding works less there): keeps craters legible in front-lit views
        float cavL = mix(1.0, cavAO, 0.6) * mix(1.0, ao, 0.3);
        vec3 col = alb * I * shadow * lit * cavL;
        // light bounced inside craters and between blocks: a cast-shadowed floor still sees the sunlit walls
        // (view factor ~0.3 x the wall albedo), so shadows on bright S-types are deep grey, on C-types near black
        float aMean = dot(albedoC, vec3(0.3333));
        col += alb * I * (1.0 - shadow) * lit * 0.3 * aMean * 1.6;
        // macro shadows inside concavities (bites, necks, big craters) see their own sunlit walls: bounce scaled
        // by how enclosed the point is (1 - vertex AO) and the wall albedo; convex shadowed sides stay black
        // (only on the day side of the body: the night side has no sunlit walls nearby)
        float sunUp = sstep(-0.1, 0.35, dot(Ngw, Lw));
        col += alb * aMean * 0.6 * (1.0 - lit * sstep(0.0, 0.15, mu0)) * (1.0 - aoM) * sunUp;
        // metal-rich (M-type): a broad GGX lobe (F0 ~0.2 under a thin regolith, roughness 0.65), carried by
        // scattered bare facets only and fading at grazing angles where the regolith dominates
        if (type > 1.5 && type < 2.5 && mu0 > 0.0) {
          vec3 H = normalize(Lw + Vw);
          float NoH = max(dot(Nw, H), 0.0);
          float a2 = 0.42 * 0.42;
          float dd = NoH * NoH * (a2 - 1.0) + 1.0;
          float D = a2 / (3.14159 * dd * dd);
          float k = 0.45;
          float G = mu0 / (mu0 * (1.0 - k) + k) * mu / (mu * (1.0 - k) + k);
          float F = 0.2 + 0.8 * pow(1.0 - max(dot(H, Vw), 0.0), 5.0);
          float facets = mix(0.35, sstep(0.0, 0.6, n3), 1.0 - sstep(0.15, 0.35, fp * 11.0));
          float graze = 1.0 - pow(1.0 - min(mu, mu0), 4.0);
          col += vec3(0.2 * D * G * F / (4.0 * mu)) * shadow * lit * facets * graze * vec3(1.0, 0.97, 0.93);
        }
        // backlit limb: at high phase the outermost regolith grains on the sunward limb, seen at grazing
        // incidence, forward-scatter sunlight (fine-dust coating): a 2-3 px rim that outlines backlit rocks against
        // the haze. Driven by the MACRO normal (the radius map sampled 0.12 rad apart, i.e. the smoothed body),
        // never by the detail normal, so ridges and crater rims inside the disc do not light up as contour lines.
        float fwdA = exp(-(3.14159265 - alpha) / 0.5);
        if (fwdA > 0.01) {
          vec3 dn = normalize(p);
          vec3 b1 = normalize(cross(dn, abs(dn.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
          vec3 b2 = cross(dn, b1);
          float e = 0.12;
          float R0 = radiusAt(dn);
          vec3 nM = normalize(dn - ((radiusAt(normalize(dn + e * b1)) - R0) / e * b1 + (radiusAt(normalize(dn + e * b2)) - R0) / e * b2) / R0);
          vec3 nMw = normalize(qrot(vQ, nM / st));
          float muM = max(dot(nMw, Vw), 0.0);
          float muG = max(dot(Ngw, Vw), 0.0);
          // near a limb mu ~ sqrt(2 x / R) at x px inside a disc of R px. The rim lights where the mesh surface
          // faces away from the viewer ((1 - mu)^2) AND only inside the smoothed body's limb zone (~15 px:
          // mu_macro < sqrt(30 / R)), so ridges and crater rims in the interior of the disc never light up
          float bandG = (1.0 - muG) * (1.0 - muG);
          float bandM = 1.0 - sstep(0.0, clamp(sqrt(30.0 / max(pB, 1.0)), 0.1, 0.9), muM);
          float rimW = bandG * bandM * sstep(-0.2, 0.25, dot(nMw, Lw)) * mix(0.5, 1.0, macro);
          col += (alb + vec3(0.15)) * fwdA * rimW * 6.0;
          #ifdef DBG_RIM
          col = vec3(rimW * fwdA, bandG, bandM) * 0.3;
          #endif
        }
        // faint fill: sunlight scattered off the surrounding swarm (keeps shadowed sides from pure 0)
        col += alb * 0.0025 * ao * (0.5 + 0.5 * dot(Nw, -Lw));
        col *= uSunColor;
        fragColor = vec4(col, mix(1.0, vPx.y, uFade));
      }`,
  });
  return mat;
}
