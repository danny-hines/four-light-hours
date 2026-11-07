// Triton surface fragment shader (used by triton.js).
//
// Albedo: the Voyager 2 mosaic (assets/triton/color.webp, rebuilt to approximate true colour) where it exists,
// handed over to procedural terrain where Voyager saw nothing (the north) or saw coarsely. The coverage weight comes
// from a lightly blurred copy of the coverage / sharpness mask (~1.5 deg feather), so no tile edge or lat/lon box
// shows and no wide featureless seam is left. In the coarse tiles the brightness offsets between Voyager frames are
// flattened (local mean at ~4 deg matched to the ~16 deg mean), which removes the rectangular blocks.
// Procedural terrain:
//  * cantaloupe terrain (Bubembe Regio style): overlapping circular depressions (cavi, ~30 km across with +-40 % size
//    variance) with raised rims and darker floors, a second generation of ~13 km pits, a large-scale density mask
//    that gives way to smooth plains with a few dark maculae and bright aureoles, and long double ridges (sulci);
//  * the south polar cap: pinkish-peach N2/CH4 frost with sparse dark plume / wind streaks (rasterised once in
//    triton.js: fans 40-150 km long, heavy-tailed, NE-trending; Hansen et al. 1990: ~50 streaks);
//  * footprint-filtered micro-variation of albedo and relief so detail survives at 0.1-0.2 R altitude.
// Lighting: relief feeds a surface-gradient bump that is footprint-filtered and faded only toward the limb, so low sun
// shows it most (the terminator is ragged: ridge tops catch light just past it, pits fall dark before it), plus
// horizon shadowing near the terminator: a few height-field taps toward the Sun darken points below the local horizon.
//
// Compile cost (ANGLE / FXC inlines every call site): one simplex call (the relief octave loop), every other noise is a
// fetch of the shared 4-channel value-noise texture, every cell search is a dynamic loop, and relief() has one call
// site that serves the shading point and the horizon taps.
import { NOISE_GLSL } from '../../glsl/noise.js';
import { COMMON_GLSL, VNOISE_GLSL } from './common.js';

export const TRITON_SURFACE_FS = /* glsl */ `
    precision highp float;
    precision highp sampler3D;
    uniform sampler2D uMap, uMask;
    uniform vec3 uSunPosW, uSunColor, uNepPosW, uNepShine, uNepDirW;
    uniform float uSunRadius, uNepR, uRT, uAlbedoGain;
    uniform mat3 uRotW;
    uniform int uOctH, uOctA, uNCell, uNSulci, uNTaps;
    uniform vec4 uSulN[7];
    uniform sampler2D uPlume;   // dark plume streaks on the cap, rasterised in triton.js (lat -80..-8)
    varying vec3 vPosL;
    varying vec3 vPosW;
    varying float vPx;
    ${NOISE_GLSL}
    ${VNOISE_GLSL}
    ${COMMON_GLSL}

    float lod(float f, float fw) { return 1.0 - smoothstep(0.2, 0.5, f * fw); }
    // stricter filter for anything that feeds the bump derivatives
    float lodB(float f, float fw) { return 1.0 - smoothstep(0.08, 0.28, f * fw); }
    // rotation between octaves (keeps the value-noise lattice axes from lining up)
    const mat3 ROT = mat3(0.788, 0.366, -0.495, -0.341, 0.930, 0.135, 0.510, 0.059, 0.858);

    // Relief (relative radius units) at a unit-sphere point: regional undulation, the sub-texel cascade and the cap's
    // sublimation relief (one simplex octave loop) and the cantaloupe cavi (one cell loop for both generations).
    // aC returns the cantaloupe / sulci albedo factor.
    float relief(vec3 p, float fw, float cantW, float capW, float mag, out float aC) {
      float h = 0.0;
      // ---- octave loop: octave i has frequency 6 * 2.07^i; three spectra share the samples
      float aReg = 0.0009, aCas = (0.00004 + 0.0001 * mag) * (1.0 - 0.55 * cantW) * 16.0, aCap = capW * 0.00007 * 8.0;
      vec3 q = p * 6.0;
      float f = 6.0, amp = 0.5;
      for (int i = 0; i < uOctH; i++) {
        float w = lodB(f, fw);
        if (w <= 0.0) break;
        float fi = float(i);
        float A = aReg * step(fi, 5.5) + aCas * step(3.5, fi) + aCap * step(2.5, fi) * step(fi, 7.5);
        h += A * amp * w * snoise(q);
        q = q * 2.07 + vec3(5.1, 2.3, 1.9);
        f *= 2.07;
        amp *= 0.5;
      }
      aC = 1.0;
      // ---- cantaloupe terrain: overlapping bowls with raised rims, two generations, in one cell loop
      const float SC = 44.0;              // one cell ~ 31 km on a 1353 km radius
      float wl = lodB(SC * 1.6, fw);
      float wa = lod(SC * 1.6, fw);
      if (cantW > 0.01 && wa > 0.0) {
        vec4 wq = vn4(p * 7.0 + 3.0);
        vec3 qb = p * SC + 0.45 * wq.xyz;
        float wl2 = lodB(SC * 2.3 * 1.6, fw), wa2 = lod(SC * 2.3 * 1.6, fw);
        float hc = 0.0, floorD = 0.0, rimS = 0.0;
        for (int i = 0; i < uNCell; i++) {
          int gen = i / 27;
          if (gen == 1 && wa2 <= 0.0) break;
          int j = i - gen * 27;
          vec3 qq = gen == 0 ? qb : qb * 2.3 + 17.0;
          vec3 ci = floor(qq) + vec3(float(j % 3) - 1.0, float((j / 3) % 3) - 1.0, float(j / 9) - 1.0);
          vec3 hh = hash33(ci * 1.13 + float(gen) * 7.0);
          vec3 c = ci + 0.15 + 0.7 * hh;
          float rad = 0.5 * (0.6 + 0.8 * hash13(ci + 5.1 + float(gen)));
          float d = length(qq - c) / rad;
          if (d > 1.7) continue;
          float bowl = d < 1.0 ? (1.0 - d * d) * (1.0 - d * d) : 0.0;
          float rim = exp(-pow((d - 1.0) / 0.24, 2.0));
          float wg = gen == 0 ? 1.0 : 0.45 * wl2;
          hc += wg * (0.3 * rim - bowl);
          floorD = max(floorD, (gen == 0 ? 1.0 : 0.5 * wa2) * bowl);
          rimS = max(rimS, wg * rim);
        }
        h += cantW * 0.0006 * wl * hc;
        aC = mix(1.0, 1.0 - 0.2 * floorD + 0.05 * rimS, wa * cantW);
      }
      return h;
    }

    // sulci: long double ridges along bent great-circle segments (poles of the great circles in uSulN); returns
    // relief and multiplies the albedo factor aC
    float sulci(vec3 p, float fw, float cantW, inout float aC) {
      float h = 0.0;
      if (cantW <= 0.01) return 0.0;
      float as = 1.0;
      for (int k = 0; k < uNSulci; k++) {
        vec3 n = uSulN[k].xyz;
        vec4 m1 = vn4(p * 1.6 + uSulN[k].w);
        float d = dot(p, n) + 0.05 * m1.x;           // a ~90 km meander
        if (abs(d) > 0.04 + 3.0 * fw) continue;
        float seg = smoothstep(0.0, 0.25, m1.y);      // the ridges come in segments
        if (seg <= 0.0) continue;
        vec4 m2 = vn4(p * 6.0 + uSulN[k].w);
        d += 0.016 * m2.x;                            // smaller wiggles
        // the ridge pair widens and narrows along its length
        float wv = 0.55 + 0.9 * smoothstep(-0.5, 0.5, m2.y);
        float W0 = 0.0034 * wv, S0 = 0.0013 * wv;
        float s = sqrt(S0 * S0 + fw * fw);
        float amp2 = S0 / s;
        float zc = (abs(d) - W0) / s, zt = d / (0.8 * s), zf = d / (4.0 * W0);
        float crest = exp(-0.5 * zc * zc) * amp2;
        float trough = exp(-0.5 * zt * zt) * amp2;
        h += seg * (crest - 0.5 * trough) * lodB(0.5 / S0, fw);
        as *= 1.0 - seg * (0.07 * exp(-0.5 * zf * zf) - 0.06 * crest);
      }
      aC *= mix(1.0, as, cantW);
      return cantW * 0.0003 * h;
    }

    void main() {
      vec3 p = normalize(vPosL);
      float lat = asin(clamp(p.y, -1.0, 1.0));
      float lon = atan(-p.z, p.x);
      float latD = degrees(lat);
      vec2 uv = vec2(lon / TAU + 0.5, lat / PI + 0.5);
      vec2 dx = dFdx(uv), dy = dFdy(uv);
      dx.x -= floor(dx.x + 0.5);
      dy.x -= floor(dy.x + 0.5);
      // analytic pixel footprint (continuous across triangles, unlike fwidth of the interpolated position)
      vec3 Ng = normalize(uRotW * p);
      vec3 V = normalize(-vPosW);
      float muv = dot(Ng, V);
      float fw = max(vPx * length(vPosW) / uRT * (0.55 + 0.85 / max(muv, 0.05)), 1e-6);

      // coverage feathered by ~1.5 deg; the sharpness hand-over stays smooth (~4 deg)
      vec2 mkB = textureGrad(uMask, uv, vec2(0.011, 0.0), vec2(0.0, 0.022)).rg;
      vec2 mkM = textureGrad(uMask, uv, vec2(0.004, 0.0), vec2(0.0, 0.008)).rg;
      vec2 mkS = textureGrad(uMask, uv, dx, dy).rg;
      float cov = mkM.r;
      float sharp = mix(mkB.g, mkS.g, 0.25);

      // map magnification: 1 when a texel (4 km) covers several pixels -> procedural detail must take over
      float texelPx = max(length(dx) * 2048.0, length(dy) * 1024.0);
      float mag = 1.0 - smoothstep(0.35, 1.6, texelPx);
      // mosaic: low-passed where Voyager's data was coarse (smear, not detail)
      float kb = mix(6.0, 1.0, smoothstep(0.1, 0.5, sharp));
      vec3 tex = textureGrad(uMap, uv, dx * kb, dy * kb).rgb;
      vec3 texS = textureGrad(uMap, uv, dx, dy).rgb;
      // tile-gain equalisation in coarse tiles, plus Voyager-like local contrast on the cap
      vec3 tM = textureGrad(uMap, uv, vec2(0.011, 0.0), vec2(0.0, 0.022)).rgb;
      vec3 tL = textureGrad(uMap, uv, vec2(0.045, 0.0), vec2(0.0, 0.09)).rgb;
      float eqW = 0.7 * (1.0 - smoothstep(0.15, 0.6, sharp));
      vec3 gain = mix(vec3(1.0), tL / max(tM, vec3(0.02)), eqW);
      float capC = smoothstep(-8.0, -25.0, latD);
      tex = tM * gain * pow(max(tex / max(tM, vec3(1e-3)), vec3(0.0)), vec3(1.0 + 0.5 * capC));

      // ---------------------------------------------------------------- terrain weights
      vec4 nLarge = vn4(p * 2.2 + 4.0);
      float dataW = smoothstep(0.3, 0.75, cov + 0.06 * nLarge.z);
      float north = smoothstep(-12.0, 2.0, latD);
      float coarse = 1.0 - smoothstep(0.2, 0.6, sharp);
      // cantaloupe density: a large-scale mask gives way to smooth plains in places
      float plainsMask = smoothstep(-0.35, 0.25, nLarge.x);
      float cantW = north * mix(plainsMask * 0.85 + 0.15, max(coarse, 0.45 * mag), dataW);
      float capW = smoothstep(-10.0, -22.0, latD);

      // ---------------------------------------------------------------- lighting geometry
      vec3 toSun = uSunPosW - vPosW;
      float dSun = length(toSun);
      vec3 L = toSun / dSun;
      float mu0g = dot(Ng, L);
      mat3 Ri = transpose(uRotW);
      vec3 Ll = Ri * L;
      vec3 Lt = Ll - p * dot(p, Ll);
      float lt = length(Lt);
      vec3 Ld = Lt / max(lt, 1e-6);
      float tanE = mu0g / max(lt, 1e-3);           // tangent of the sun's elevation above the local horizontal

      // ---------------------------------------------------------------- relief + horizon taps toward a low Sun
      // tap k at s = s0 * 2^(k-1) radii (s0 >= 2.4 km and >= ~1.5 px, so the taps also see the large-scale relief when
      // Triton is small on screen); a tap shadows this point if the terrain there rises above the ray to the Sun (the
      // sphere's curvature included). Same relief() for all: one call site.
      bool taps = mu0g > -0.06 && mu0g < 0.3 && fw < 0.03 && lt > 1e-3;
      int nT = taps ? uNTaps : 0;
      float s0 = max(0.0018, 1.5 * fw);
      float h0 = 0.0, aMul = 1.0, horizon = 1.0;
      for (int k = 0; k <= nT; k++) {
        float s = k == 0 ? 0.0 : s0 * exp2(float(k - 1));
        vec3 pk = k == 0 ? p : normalize(p + Ld * s);
        float ac;
        float hk = relief(pk, k == 0 ? fw : max(fw, 0.2 * s), cantW, capW, mag, ac);
        if (k == 0) {
          h0 = hk;
          aMul = ac;
        } else {
          // bump exaggeration x2 (as in the shading below)
          float above = 2.0 * (hk - h0) - s * tanE - 0.5 * s * s;
          horizon = min(horizon, 1.0 - 0.9 * smoothstep(-0.03 * s, 0.06 * s, above));
        }
      }
      // fade the taps out at the edges of the band where they run (no seam)
      horizon = mix(1.0, horizon, smoothstep(0.3, 0.2, mu0g) * smoothstep(0.03, 0.022, fw));
      float h = h0 + sulci(p, fw, cantW, aMul);
      // relief cues from the mosaic itself where it holds real detail (bright knobs / dark pits and troughs)
      float lT = dot(texS - tM, vec3(0.2126, 0.7152, 0.0722)) / max(dot(tM, vec3(0.2126, 0.7152, 0.0722)), 0.05);
      // (only while the map is not magnified: a bilinearly magnified texel has derivative steps that would facet)
      h += 0.0003 * dataW * (1.0 - coarse * 0.6) * clamp(lT, -0.5, 0.5) * (1.0 - mag);

      // ---------------------------------------------------------------- albedo
      // one value-noise octave loop, four spectra: x tone (from ~14 / rad), y cap patchiness, z micro-variation,
      // w frost / lag patches (the last two start at finer scales)
      vec4 fa = vec4(0.0);
      {
        vec3 q = p * 14.0 + 2.0;
        float f = 14.0, amp = 0.5;
        for (int i = 0; i < uOctA; i++) {
          float w = lod(f, fw);
          if (w <= 0.0) break;
          float fi = float(i);
          vec4 n = vn4(q) * 0.75;
          fa.x += amp * w * n.x * step(fi, 4.5);
          fa.y += amp * w * n.y * step(fi, 3.5);
          fa.z += amp * w * n.z * 2.0 * step(0.5, fi);
          fa.w += amp * w * n.w * 16.0 * step(3.5, fi);
          q = ROT * q * 2.07 + vec3(3.1, 1.7, 5.3);
          f *= 2.07;
          amp *= 0.5;
        }
      }
      float streak = capW * textureGrad(uPlume, vec2(uv.x, (latD + 80.0) / 72.0), dx * vec2(1.0, 2.5), dy * vec2(1.0, 2.5)).r;
      if (capW > 0.01) aMul *= 1.0 + capW * (0.035 + 0.04 * coarse) * fa.y;
      // unimaged north: continue smoothly from the data edge, add frost / plains variation
      vec4 nF = vn4(p * 3.1 + 2.0);
      vec4 nF2 = vn4(p * 11.0 + 6.0);
      float fm = smoothstep(-0.2, 0.5, nF.x * 0.75 + 0.22 * nF2.x);
      vec3 frost = vec3(0.66, 0.655, 0.65);
      vec3 proc = mix(tex * vec3(0.96, 0.97, 1.0), frost, fm * 0.4) * (1.0 + 0.07 * fa.x);
      // a few dark maculae with bright aureoles on the smooth plains of the unimaged north
      {
        vec4 mq = vn4(p * 4.0 + 11.0);
        float mc = smoothstep(0.62, 0.8, mq.y + 0.15 * nF2.y);
        float au = smoothstep(0.45, 0.62, mq.y + 0.15 * nF2.y) - mc;
        float wM = north * (1.0 - plainsMask) * (1.0 - dataW);
        proc *= 1.0 + wM * (0.16 * au - 0.3 * mc);
      }
      vec3 alb = mix(proc, tex, dataW);
      float lum0 = dot(alb, vec3(0.2126, 0.7152, 0.0722));
      // equatorial / northern terrain: grey with a faint cool cast
      alb = mix(alb, lum0 * vec3(0.97, 0.99, 1.03), 0.45 * north);
      // the south polar cap: pinkish-peach in true colour
      float lumC = dot(alb, vec3(0.2126, 0.7152, 0.0722));
      alb = mix(alb, lumC + (alb - lumC) * 1.35, capW);
      alb *= mix(vec3(1.0), vec3(1.16, 0.93, 0.86), capW);
      // fresh, bluish-white N2 frost of the equatorial fringe
      alb *= mix(vec3(1.0), vec3(0.96, 1.0, 1.06), exp(-0.5 * pow((latD + 7.0) / 7.0, 2.0)));
      // micro-variation (footprint-filtered) so close passes stay crisp; less grain on the cap
      alb *= (1.0 + (0.03 + 0.04 * coarse + 0.04 * mag) * (1.0 - 0.75 * capW) * fa.z) * aMul;
      // close range: small bright frost patches and dark lag deposits below the map's resolution
      alb *= 1.0 + mag * 0.09 * (smoothstep(0.05, 0.35, fa.w) - 0.5 * smoothstep(-0.1, -0.4, fa.w));
      alb *= 1.0 - 0.68 * streak * vec3(0.9, 1.0, 1.06);
      alb *= uAlbedoGain;

      // ---------------------------------------------------------------- shading
      // surface-gradient bump, faded only toward the limb (low sun is where relief should show most)
      float hw = h * uRT * 2.0;
      vec3 dpx = dFdx(vPosW), dpy = dFdy(vPosW);
      float dhx = dFdx(hw), dhy = dFdy(hw);
      vec3 r1 = cross(dpy, Ng), r2 = cross(Ng, dpx);
      float det = dot(dpx, r1);
      vec3 N = Ng;
      if (abs(det) > 1e-20) {
        vec3 grad = sign(det) * (dhx * r1 + dhy * r2) / max(abs(det), 1e-30);
        float gl = length(grad);
        grad *= min(1.0, 0.5 / max(gl, 1e-6));
        N = normalize(Ng - grad * smoothstep(0.04, 0.3, muv));
      }
      float mu0 = dot(N, L);
      float mu = max(muv, 1e-3);
      float cosA = clamp(dot(L, V), -1.0, 1.0);
      float alpha = acos(cosA);
      float ad = degrees(alpha);
      // the perturbed normal governs, so ridge tops catch light just past the geometric terminator and slopes facing
      // away fall dark before it; light never reaches more than ~4 deg past it; horizon taps add cast shadows
      float m0 = max(mu0, 0.0) * smoothstep(-0.03, 0.02, mu0) * smoothstep(-0.07, 0.0, mu0g) * horizon;
      float ls = 2.0 * m0 / (m0 + mu);
      float brdf = mix(m0, ls, 0.42);
      float phase = (1.0 + 0.25 * exp(-ad / 5.0)) / 1.25 * (1.0 - 0.35 * alpha / PI);
      float ecl = sphereShadow(vPosW, L, uSunRadius / dSun, uNepPosW, uNepR);
      vec3 col = alb * brdf * phase * ecl * uSunColor;
      // Neptune-shine (blue), faint but real on the night side
      col += alb * uNepShine * max(dot(Ng, uNepDirW), 0.0);
      gl_FragColor = vec4(col, 1.0);
    }`;
