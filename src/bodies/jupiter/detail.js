// Jupiter's close-range detail layer, as a multiplicative shell riding a hair above the cloud deck:
//   out = deck x F (rgb), drawn after the opaque globe and before the haze shell (it discards beyond ~40 km/px).
// F = the fine turbulence octaves B and C as a mean-preserving colour change, convective cloud towers, their relief
//     shading and soft cast shadows.
// Splitting the deck into two programs keeps each one small: Chrome on Windows compiles every program through FXC in a
// time that grows ~quadratically with its instruction count, so one big program costs far more than two halves.
// The relief here is drawn relative to the deck's own (octave-A) lighting, so the product is the full shading.
import * as THREE from 'three';
import { JUP_COMMON } from './glsl.js';
import { HAZE_PARAMS } from './haze.js';
import { JUP_CLOUDS } from './surface.js';

export function createDetail({ geometry, shared }) {
  const mat = new THREE.ShaderMaterial({
    uniforms: shared,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.ZeroFactor,
    vertexShader: /* glsl */ `
      uniform float uRadius;
      varying vec3 vObj;
      varying vec3 vPosJ;
      void main() {
        vObj = position / uRadius;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPosJ = mat3(modelMatrix) * position;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${JUP_COMMON}
      ${HAZE_PARAMS}
      ${JUP_CLOUDS}
      uniform vec3 uSunJ;
      uniform float uSunR;
      uniform float uRadius;
      uniform mat3 uRot;
      uniform vec4 uMoon[4];
      varying vec3 vObj;
      varying vec3 vPosJ;
      void main() {
        vec3 L = normalize(uSunJ - vPosJ);
        vec3 F = vec3(1.0);

        // ---- the deck point (every screen derivative here, outside branches and loops)
        vec3 uS = normalize(vObj);
        vec2 ll0 = vec2(wrapPi(atan(-uS.z, uS.x) + uLonOff), atan((1.0 - uFlat) * uS.y, length(uS.xz)));
        vec3 nLoc = normalize(vec3(uS.x, uS.y / (1.0 - uFlat), uS.z));
        vec2 uv0 = mapUV(ll0);
        vec2 dx = dFdx(uv0), dy = dFdy(uv0);
        dx.x -= floor(dx.x + 0.5); dy.x -= floor(dy.x + 0.5);
        vec2 dllx = vec2(dx.x * TAU, dx.y * PI), dlly = vec2(dy.x * TAU, dy.y * PI);
        float fpk = max(max(length(dFdx(vPosJ)), length(dFdy(vPosJ))) / uRadius, 1e-7) * R_KM;
        vec4 p0, p1, p2;
        latRows(ll0.y, p0, p1, p2);
        float ckA = cos(ll0.y) * (1.0 - uFlat);
        float preLon = -p2.r / (max(ckA * inversesqrt(sin(ll0.y) * sin(ll0.y) + ckA * ckA), 0.03) * R_KM);
        float shK = p2.g;
        vec2 dPre = vec2(dFdx(preLon), dFdy(preLon)) * (NA / TAU);
        vec2 uvA0 = vec2((ll0.x + preLon) * (NA / TAU), p1.r);
        vec2 gA0x = dFdx(uvA0), gA0y = dFdy(uvA0);
        gA0x.x -= NA * floor(gA0x.x / NA + 0.5); gA0y.x -= NA * floor(gA0y.x / NA + 0.5);
        // octave B fades in from ~65 km/px (its eddies are ~300 km and larger: above the map's 35 km texels), the towers
        // from 40 km/px; the layer as a whole from 70 km/px
        float DB = smoothstep(65.0, 25.0, fpk) * step(0.5, uQual);
        float DL = smoothstep(70.0, 60.0, fpk) * step(0.5, uQual);
        float DC = smoothstep(9.0, 3.0, fpk) * step(1.5, uQual);
        float DU = smoothstep(40.0, 30.0, fpk) * step(0.5, uQual);
        vec3 Lb = transpose(uRot) * L;
        float mu0g = dot(nLoc, Lb);
        float polar = smoothstep(1.03, 1.13, abs(ll0.y));

        if (DL <= 0.0 || mu0g < -0.03 || polar >= 1.0) discard;
        {
          // ---- the deck's flow state, re-derived (as deckPhase): advection, vortex turns, the octave-A tile coords
          float tau = uClkL.x, tauG = uClkL.y, tauB = uClkL.z;
          float rg = vortexR(ll0, uGrs), rb = vortexR(ll0, uBa);
          float vm = max(1.0 - smoothstep(1.05, 2.1, rg), 1.0 - smoothstep(1.05, 1.9, rb));
          vec2 ll = advectZonal(ll0, tau, p0.r * (1.0 - vm));
          vec2 llTr = vortexRot(ll, uGrs, -grsOmega(rg) * tauG * (1.0 - smoothstep(1.3, 1.75, rg)));
          float mb = 1.0 - smoothstep(1.2, 1.7, rb);
          llTr = vortexRot(llTr, uBa, -(2.0 * tauB * mb * (1.0 - smoothstep(0.9, 1.4, rb)) + 2.2 * smoothstep(0.15, 0.7, rb) * (1.0 - smoothstep(0.9, 1.45, rb)) * mb));
          llTr.x += preLon;
          float cphi = max(cos(ll0.y), 1e-3);
          vec2 uvA = backtrace(vec2(llTr.x * (NA / TAU), p1.r + (llTr.y - ll0.y) * (NA / TAU) * p1.g / max(cphi, 0.1205)), tau * KA, 3);
          float kx = NA / (TAU * R_KM * cphi), ky = NA * p1.g / (TAU * R_KM * max(cphi, 0.1205));
          // regime and local colour context (baked end-members, the map mean)
          vec2 uvMap = mapUV(ll);
          vec4 hT = textureLod(uHi, uvMap, 0.0), lT = textureLod(uLo, uvMap, 0.0);
          vec3 cMap = textureGrad(uMap, uvMap, dx, dy).rgb;
          float dw = wrapPi(ll0.x - uGrs.x);
          float wake = smoothstep(-0.42, -0.31, ll0.y) * (1.0 - smoothstep(-0.27, -0.2, ll0.y)) * smoothstep(-0.07, -0.17, dw) * (1.0 - smoothstep(-0.6, -1.2, dw));
          float grsW = 1.0 - smoothstep(1.04, 1.3, rg);
          float chaos = max(smoothstep(0.1, 0.6, hT.a) * mix(0.75, 1.0, smoothstep(-0.3, 0.6, lT.a)), wake) * (1.0 - grsW);
          float lam = (1.0 - smoothstep(0.2, 0.7, chaos)) * (1.0 - polar) * closeLam(fpk);
          float zone = p0.b;
          float ezM = 1.0 - smoothstep(0.07, 0.13, abs(ll0.y));
          // the nearer vortex's streamline frame (lanes of the fine octaves wrap the vortex)
          bool inV = min(rg, rb) < 1.3;
          bool inBA = rb < rg;
          vec4 VV = inBA ? uBa : uGrs;
          float wV = 1.0 - smoothstep(inBA ? 1.0 : 1.04, 1.3, min(rg, rb));
          mat2 Mv;
          vec2 fv = vortexFrame(vec2(wrapPi(ll.x - VV.x), ll.y - VV.y) / VV.zw, inBA ? 1.4 * tauB : tauG, inBA ? 1.0 : 0.0, Mv);
          mat2 Jv = vortexK(3.0) * Mv;
          vec2 vgx = Jv * (dllx / VV.zw), vgy = Jv * (dlly / VV.zw);
          vec2 vJe = Jv * vec2(1.0 / (VV.z * R_KM * cphi), 0.0), vJn = Jv * vec2(0.0, 1.0 / (VV.w * R_KM));
          float omS = grsOmega(length(vec2(wrapPi(ll.x - VV.x), ll.y - VV.y) / VV.zw)) * (inBA ? 1.4 : 1.0);

          // ---- octaves B (~2,340 km tile, churn clock) and C (~290 km): glued to the octave-A flow, re-seeded each churn
          //      cycle and evolved by their own eddies; half the pre-shear (smaller eddies are younger). One zonal-tile
          //      sample per octave: along the vortex streamlines inside a vortex, along the jets in the laminar regions.
          float unS = mix(0.5, 1.0, wV);
          vec2 base = uvA - vec2(unS * preLon * (NA / TAU), 0.0);
          vec2 je = vec2(kx, 0.0), jn = vec2(-(1.0 - unS) * shK * kx, ky);
          vec2 gBx = (gA0x - vec2(unS * dPre.x, 0.0)) * 8.0, gBy = (gA0y - vec2(unS * dPre.y, 0.0)) * 8.0;
          // (inside a vortex half the fine structure follows the streamlines, the rest is mottled eddies)
          float wZ = inV ? 0.55 * wV : lam * smoothstep(1.3, 1.6, min(rg, rb));
          float caZ = cos(wZ * 1.5708), saZ = sin(wZ * 1.5708) * ZAMP;
          vec2 zgx = inV ? vgx : vec2(gBx.x, gBx.y * ZY), zgy = inV ? vgy : vec2(gBy.x, gBy.y * ZY);
          vec2 zJe = inV ? vJe : vec2(je.x, je.y * ZY) * 8.0, zJn = inV ? vJn : vec2(jn.x, jn.y * ZY) * 8.0;
          // (octave C is the isotropic tile only: the finest scales are convective, not streaky)
          vec3 tB = vec3(0.0);
          float wsum = 0.0;
          for (int j = 0; j < 2 + uI0; j++) {
            float w = (j == 0 ? uClkS.z : uClkS.w) * DB;
            if (w <= 0.0) continue;
            float tauS = j == 0 ? uClkS.x : uClkS.y;
            vec2 sd = j == 0 ? uSeedS.xy : uSeedS.zw;
            vec2 uvc0 = base * 8.0 + sd;
            vec2 uvB = backtrace(uvc0, tauS * KB, 2);
            vec4 t4 = textureGrad(uT1, uvB, gBx, gBy);
            vec3 v = vec3(t4.r * 2.0 - 1.0, (t4.gb - 0.5) * (2.0 * uT1G));
            float v2 = t4.a * 2.0 - 1.0;
            v.yz = vec2(dot(v.yz, je), dot(v.yz, jn)) * 8.0;
            vec2 uvZ = inV ? vortexK(3.0) * vec2(fv.x - omS * tauS, fv.y) + sd * vec2(1.0, 0.618) : vec2(uvc0.x, uvc0.y * ZY) + sd.yx * 1.7;
            vec3 z = vec3(0.0);
            if (wZ > 0.0) {
              z = tileVG(uTz, uTzG, uvZ, zgx, zgy);
              z.yz = vec2(dot(z.yz, zJe), dot(z.yz, zJn));
              v = v * caZ + z * saZ;
            }
            if (DC > 0.0) {
              vec2 uvC = uvB * 8.0 + sd.yx * 3.7 + vec2(0.7 * v.x + 0.35 * v2, 0.7 * v2 - 0.35 * v.x);
              vec3 vc = tileVG(uT1, uT1G, uvC, gBx * 8.0, gBy * 8.0);
              vc.yz = vec2(dot(vc.yz, je), dot(vc.yz, jn)) * 64.0;
              v.x += vc.x * (0.55 * DC);   // (value only: its steep gradient embosses 'worms')
            }
            tB += v * w;
            wsum += w * w;
          }
          tB *= inversesqrt(max(wsum, 1e-4));

          // ---- the deck's tracer -> colour curve, at the octave-A state and with octave B / C added
          float turbv = p0.g * (1.0 + 0.8 * wake);
          float amp = mix(0.2, 1.3, smoothstep(0.06, 0.6, hT.a)) * mix(0.8, 1.15, smoothstep(-0.45, 0.55, lT.a));
          // at close range every region has full texture: cloud-thickness contrast, not the map's smooth zones
          amp = max(max(amp, 0.34 * smoothstep(0.15, 0.6, p1.a)), 0.75 * smoothstep(40.0, 8.0, fpk));
          amp = max(max(amp, 0.95 * wake), 0.42 * ezM);
          amp = mix(amp, 1.0, grsW);
          float g = (0.75 + 0.35 * turbv) * p0.a * mix(1.0, 0.7, zone * (1.0 - 0.6 * ezM)) * mix(1.0, 0.95, grsW) * closeGain(fpk);
          float Lf = dot(cMap, LUMW), Ld0 = dot(lT.rgb, LUMW), Lt0 = dot(hT.rgb, LUMW);
          float mRaw = clamp((Lf - Ld0) / max(Lt0 - Ld0, 1e-4), 0.0, 1.0);
          float m = 0.5 + (mRaw - 0.5) * 0.5;
          float b = sqrt(1.0 + 1.571 * g * g * amp * amp) * atanh(2.0 * m - 1.0) / g;
          float tA = tileV(uT1, uvA, gA0x, gA0y) / 0.385 * amp;
          float tBn = tB.x * 0.65 / 0.385 * amp * mix(1.0, 1.3, smoothstep(30.0, 8.0, fpk));
          // analytic AA of the contrast curve: never sharper than ~1 px (the tracer's slope per pixel, from its gradient)
          // the fine octaves enter LINEARLY through the local slope of the deck's contrast curve (then soft-limited):
          // a threshold here would turn their small eddies into dark speckle. Anti-aliased by their slope per pixel.
          float T0 = 0.5 + 0.5 * tanh(g * (tA + b));
          float aa = 1.0 / (1.0 + pow(length(tB.yz) * (0.65 / 0.385) * amp * fpk * g, 2.0));
          // (slope floor at close range: the interiors of the large swirls carry the fine filaments too, not only their edges)
          float dTl = max(0.5 * g * (1.0 - (2.0 * T0 - 1.0) * (2.0 * T0 - 1.0)), 0.15 * smoothstep(50.0, 14.0, fpk)) * tBn * aa;
          float T1 = T0 + 0.3 * tanh(dTl / 0.3);
          // the re-centred local end-members (as the deck): the spread grows at close range; gaps show the deeper,
          // blue-grey layer under the zones
          float closeK = smoothstep(70.0, 12.0, fpk) * (1.0 - 0.25 * grsW);
          float Sp = max(Lt0 - Ld0, (0.05 + 0.38 * closeK + 0.17 * closeK * closeK) * Lf) * (1.0 + 0.6 * closeK);
          float Ld = max(Lf - m * Sp, 0.2 * Lf), Lt = Lf + (1.0 - m) * Sp;
          vec3 cDk = lT.rgb * (Ld / max(Ld0, 1e-4)), cLt = hT.rgb * (Lt / max(Lt0, 1e-4));
          vec3 gapC = mix(vec3(0.80, 0.86, 0.98), vec3(1.12, 0.94, 0.72), smoothstep(-0.3, 0.3, lT.a * 2.0 - 0.3));
          cDk = mix(cDk, gapC * Ld, 0.6 * zone * closeK * (1.0 - grsW));
          vec3 col0 = max(cMap, vec3(0.02));
          // (soft floor: the fine octaves shade the deck, they never punch near-black holes into it)
          vec3 col = col0 + (cLt - cDk) * (T1 - T0);
          col = max(col, col0 * (0.55 + 0.45 * exp(min(col / col0 - 1.0, vec3(0.0)) * 2.2)));

          // ---- relief: the fine octaves' cloud-top streets (relative to the deck's own octave-A relief) ...
          float Hamp = mix(5.0, 13.0, smoothstep(40.0, 8.0, fpk)) * mix(1.0, 0.6, zone) * (1.0 + 0.4 * wake);
          float gh = 0.45 * g / closeGain(fpk) * mix(1.0, 2.2, smoothstep(40.0, 8.0, fpk));
          float Th = 0.5 + 0.5 * tanh(gh * (tA + tBn + b));
          // (close range: the mesoscale eddies of octave B stand ~15 km proud, independent of the softened colour curve:
          //  slopes of 0.1-0.3, so a 20-40 deg sun models every cloud mass)
          float HB = mix(Hamp * 0.5 * gh * (1.0 - (2.0 * Th - 1.0) * (2.0 * Th - 1.0)) * amp * (0.65 / 0.385), 2.6 * mix(1.0, 0.7, zone), smoothstep(40.0, 12.0, fpk));
          vec2 Hg = HB * tB.yz * DB;
          // ... and the convective cloud towers on the thick cloud of the convective regions (chaotic belts, outbreaks,
          // the GRS wake, the EZ plumes); bright compact plumes in the map are always a dense cauliflower of turrets
          vec3 east = vec3(uS.z, 0.0, -uS.x) * inversesqrt(max(dot(uS.xz, uS.xz), 1e-12));
          vec3 north = normalize(cross(nLoc, east));
          vec2 sunT = vec2(dot(Lb, east), dot(Lb, north));
          float sunTl = max(length(sunT), 1e-4);
          float tanE = mu0g / sunTl;
          float shad = 1.0;
          float conv = max((0.2 + 0.8 * chaos) * (1.0 - 0.9 * grsW) * (1.0 - polar) * (1.0 - 0.8 * (1.0 - smoothstep(0.75, 1.05, rb))), 0.6 * ezM * (1.0 - grsW));
          float outbreak = smoothstep(-0.25, 0.45, lT.a + 0.35 * chaos - 0.1);
          float plume = smoothstep(0.72, 0.97, mRaw) * smoothstep(0.35, 0.8, chaos + 0.6 * ezM) * (1.0 - grsW);
          float cover = max(conv * outbreak, 0.95 * plume) * smoothstep(0.25, 0.8, T1) * DU;
          // the coarsest octave is the sparse pop-up storms (~470 km cells, anvils 15-30 km high)
          float occS = (0.05 + 0.2 * (1.0 - zone) * turbv + 0.25 * wake) * (1.0 - grsW) * smoothstep(-0.3, 0.5, lT.a) * 0.3 * DU;
          if (cover > 0.01 || occS > 0.01) {
            vec2 uvU = uvA - vec2(preLon * (NA / TAU), 0.0);
            vec4 cu = cumulus(vec2(uvU.x, uvU.y * CU_CY) * (CU_NC0 / 3.0), NA * CU_NC0 / 3.0, vec2(kx, ky * CU_CY) * (CU_NC0 / 3.0),
                              fpk, cover, occS, uDt, sunT / sunTl, tanE, shad);
            Hg += cu.yz;
            // fresh ammonia-ice turrets are brighter and whiter than the deck they rise from; the gaps between them are a
            // little darker (deeper, thinner cloud)
            vec3 cream = vec3(0.86, 0.83, 0.76) * max(Lt, 0.42) / 0.6;
            col = mix(col, max(col, cream), 0.6 * smoothstep(0.1, 0.9, cu.w));
            col *= 1.0 - 0.1 * cover * (1.0 - smoothstep(0.0, 0.4, cu.w));
          }
          // ---- cast shadows of the cloud masses at a low sun: the octave-A cloud-top height field (soft footprint, exaggerated
          //      ~2.5x: 15-35 km of relief) is probed at three distances toward the Sun. Long shadows rake across the deck
          //      as the skim nears the terminator; nothing at a high sun.
          float shLow = smoothstep(1.1, 0.45, tanE) * smoothstep(68.0, 45.0, fpk) * step(1.5, uQual);
          if (shLow > 0.0) {
            float HS = 3.2 * Hamp;
            vec2 gSx = minLen(gA0x, 0.0011), gSy = minLen(gA0y, 0.0011);
            vec2 sK = (vec2(kx, 0.0) * sunT.x + vec2(-shK * kx, ky) * sunT.y) / sunTl;   // tile units per km toward the Sun
            float dMax = min(HS / max(tanE, 0.02), 700.0);
            float kq = amp / 0.385;
            float h0 = HS * (0.5 + 0.5 * tanh(gh * (tileV(uT1, uvA, gSx, gSy) * kq + b)));
            float occ = 0.0;
            for (int j = 0; j < 3 + uI0; j++) {
              float d = dMax * (j == 0 ? 0.22 : (j == 1 ? 0.55 : 1.0));
              float hk = HS * (0.5 + 0.5 * tanh(gh * (tileV(uT1, uvA + sK * d, gSx, gSy) * kq + b)));
              occ = max(occ, (hk - h0 - d * tanE) / (0.4 * HS));
            }
            shad *= 1.0 - 0.6 * shLow * smoothstep(0.0, 1.0, occ);
          }
          // relief shading relative to the smooth deck, soft-limited at the terminator
          vec3 nB = normalize(nLoc - east * Hg.x - north * Hg.y);
          float rr = (max(dot(nB, Lb), 0.0) + 0.02) / (max(mu0g, 0.0) + 0.02);
          // jdebug=20: colour change only, 21: relief shading only, 22: tower shadows only
          vec3 fx = col / col0 * min(rr, 4.0) * shad;
          if (abs(uDebug - 20.0) < 0.5) fx = col / col0;
          if (abs(uDebug - 21.0) < 0.5) fx = vec3(min(rr, 4.0));
          if (abs(uDebug - 22.0) < 0.5) fx = vec3(shad);
          F *= mix(vec3(1.0), fx, DL);
        }
        gl_FragColor = vec4(F, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = 'jupiter-detail';
  // a hair above the deck (~1.4 km), so it always passes the depth test against the globe it rides on
  mesh.scale.setScalar(1.00002);
  mesh.renderOrder = 0.5;
  return mesh;
}
