// Mars surface material: Viking colour mosaic (colour-corrected toward true colour), MOLA relief (float,
// de-terraced) for normals, displacement and terrain cast shadows, procedural craters / roughness at close
// range, seasonal CO2 frost, dusty-atmosphere sunlight extinction, sky fill and twilight, and the antumbral
// shadows of Phobos and Deimos.
import { MARS_COMMON } from './glsl.js';
import { noiseTexture3D } from './noise3d.js';

// Close-range detail layers, ALL evaluated by one loop with a single lookup of the baked 3D noise (noise3d.js) (FXC
// inlines a copy of an analytic noise per call site; ~22 sites took ~3 s to compile). Row: [f (1/km), offset, amplitude, footprint wavelength (km),
// mode, mask, lo | LIC tap spacing (wavelengths), LIC tap index or -1].
// modes: 0 wind direction, 1 plain height, 2 ridged height, 3 albedo, 4 LIC spurs/gullies, 5 LIC lava flows,
//        (wrinkle ridges, dunes, the Olympus aureole and giant polygons were cut for the FXC compile budget)
// masks: 0 one, 1 highlands, 2 steep slopes, 3 volcanic flanks,
//        8 undulation amplitude, 9 roughness amplitude, 10 albedo busyness
function layerTable(Rkm) {
  const rows = [];
  const add = (f, off, A, wl, mode, mask, lo = 2, tap = -1) => rows.push([f, off, A, wl, mode, mask, lo, tap]);
  add(1.7 / Rkm, 31.0, 0, 1e6, 0, 0); // regional wind direction (dune crests, crater-floor dunes, wind streaks)
  add(1 / 26, 3.1, 1, 26, 1, 8); // broad undulation everywhere (gentler on plains)
  for (let j = 0; j < 4; j++) {
    // highlands: eroded, ridged texture (degraded rims, inter-crater ridges, knobs)
    const f = Math.pow(2.4, j) / 9;
    add(f, 5.3 * j + 11.0, 0.16 * Math.pow(0.42, j), 1 / f, 2, 1);
  }
  for (let j = 0; j < 4; j++) {
    // fine roughness at 100 m - 3 km (RMS slope ~1 deg plains, ~3 deg highlands)
    const f = Math.pow(2.3, j) / 3;
    add(f, 7.7 * j + 40.0, (0.6 * Math.pow(0.85, j)) / f, 1 / f, 1, 9);
  }
  for (let j = 0; j < 4; j++) {
    // sub-texel albedo, scaled by the map's own busyness
    const f = Math.pow(2.5, j) / 18;
    add(f, 3.17 * j, 0.085 * Math.pow(0.7, j), 1 / f, 3, 10);
  }
  // steep MOLA slopes: 11 km spurs and 3.6 km gullies, ridged noise smeared downslope (line-integral convolution);
  // volcano flanks: ~8 km flow fields and ~2 km individual lava flows, elongated downslope
  [[1 / 11, 31.0, 0.9, 11, 4, 2, 0.72], [1 / 3.6, 40.0, 0.5, 3.6, 4, 2, 0.72], [1 / 8, 53.0, 0.07, 8, 5, 3, 1.6], [1 / 2.2, 60.0, 0.04, 2.2, 5, 3, 1.6]].forEach(
    ([f, off, A, wl, mode, mask, tap]) => {
      for (let k = 0; k < 5; k++) add(f, off, A, wl, mode, mask, tap, k);
    }
  );
  return rows;
}

export function createSurfaceMaterial(ctx, { colorTex, relief, params, baked }) {
  const { THREE, U } = ctx;
  const LAY = layerTable(params.radiusKm);
  const uniforms = {
    tColor: { value: colorTex },
    tRelief: { value: relief.texture },
    uReliefSize: { value: new THREE.Vector2(relief.width, relief.height) },
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uCamPos: { value: new THREE.Vector3(3, 0, 0) }, // body-fixed, in Mars equatorial radii
    uSunColor: U.uSunColor,
    uRkm: { value: params.radiusKm },
    uRscene: { value: params.radius },
    uFlat: { value: params.flattening },
    uPixAngle: { value: 0.001 },
    uExag: { value: params.exaggeration },
    uSunAng: { value: 0.003 },
    uTau0: { value: params.tau0 },
    uExt: { value: params.extScale },
    uHdust: { value: params.Hdust },
    uMoonA: { value: new THREE.Vector4(10, 0, 0, 0.003) },
    uMoonB: { value: new THREE.Vector4(10, 0, 0, 0.002) },
    uDetail: { value: params.detail },
    uFrostLat: { value: params.frostLat },
    uFrostLatS: { value: params.frostLatS },
    uDebug: { value: params.debug },
    // albedo grade: x contrast gamma below the median red albedo, y above it; basalt (dark-region) hue
    uGrade: { value: new THREE.Vector2(2.4, 1.35) },
    uBasalt: { value: new THREE.Vector3(1.0, 0.84, 0.8) },
    // loop bounds as uniforms: FXC (ANGLE/D3D) fully unrolls constant-bound loops and inlines every call in them,
    // which made this program take seconds to compile; with uniform bounds it emits real loops
    uCraterIters: { value: 80 }, // 10 octaves x 8 cells
    uShadowSteps: { value: 22 },
    uMoonN: { value: 2 },
    uLayA: { value: LAY.map((r) => new THREE.Vector4(r[0], r[1], r[2], r[3])) },
    uLayB: { value: LAY.map((r) => new THREE.Vector4(r[4], r[5], r[6], r[7])) },
    uLayN: { value: LAY.length },
    tAge: { value: baked.age },
    tPolarN: { value: baked.polarN },
    tPolarS: { value: baked.polarS },
    uPolarTan: { value: baked.tanHalf },
    tNoise3: { value: noiseTexture3D(THREE) },
    // per-layer lattice rotations (the baked noise is periodic: rotated octaves never line up)
    uRot: { value: [[0.3, 1.1, 0.7], [1.9, 0.4, 2.3], [2.7, 1.6, 0.2], [0.9, 2.8, 1.4]].map(([a, b, c]) => new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(a, b, c)))) },
  };

  // dev-only overrides for grading: mars_grade=lo,hi  mars_basalt=r,g,b
  const qp = new URLSearchParams(globalThis.location ? globalThis.location.search : '');
  if (qp.has('mars_grade')) uniforms.uGrade.value.fromArray(qp.get('mars_grade').split(',').map(Number));
  if (qp.has('mars_basalt')) uniforms.uBasalt.value.fromArray(qp.get('mars_basalt').split(',').map(Number));

  const vertexShader = /* glsl */ `
    uniform sampler2D tRelief;
    uniform float uRscene, uRkm, uFlat;
    varying vec3 vDir;
    varying float vH;
    void main() {
      vec3 d = normalize(position);
      float lon = abs(d.y) > 0.99999 ? 0.0 : atan(-d.z, d.x);
      float lat = asin(clamp(d.y, -1.0, 1.0));
      vec2 uv = vec2(lon * 0.15915494 + 0.5, lat * 0.31830989 + 0.5);
      float h = textureLod(tRelief, uv, 0.5).r;
      float r = uRscene * (1.0 - uFlat * d.y * d.y) + h * (uRscene / uRkm);
      vDir = d;
      vH = h;
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(d * r, 1.0);
    }`;

  const fragmentShader = /* glsl */ `
    ${MARS_COMMON}
    uniform sampler2D tColor, tRelief;
    uniform vec2 uReliefSize;
    uniform vec3 uSunDir, uCamPos, uSunColor;
    uniform float uRkm, uFlat, uPixAngle, uExag, uSunAng, uTau0, uHdust, uDetail, uFrostLat, uFrostLatS, uDebug, uExt;
    uniform vec4 uMoonA, uMoonB;
    uniform vec2 uGrade;
    uniform vec3 uBasalt;
    uniform int uCraterIters, uShadowSteps, uLayN, uMoonN;
    uniform vec4 uLayA[34], uLayB[34];
    uniform sampler2D tAge, tPolarN, tPolarS;
    uniform float uPolarTan;
    uniform highp sampler3D tNoise3;
    uniform mat3 uRot[4];
    varying vec3 vDir;
    varying float vH;

    vec2 dirToUv(vec3 d) {
      return vec2(atan(-d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
    }

    // B-spline bicubic (4 bilinear taps): smooth, C2 reconstruction of the relief when magnified
    vec4 reliefBicubic(vec2 uv) {
      vec2 st = uv * uReliefSize - 0.5;
      vec2 i = floor(st), f = st - i;
      vec2 f2 = f * f, f3 = f2 * f;
      vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
      vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
      vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
      vec2 w3 = f3 / 6.0;
      vec2 s0 = w0 + w1, s1 = w2 + w3;
      vec2 p0 = (i - 0.5 + w1 / s0) / uReliefSize;
      vec2 p1 = (i + 1.5 + w3 / s1) / uReliefSize;
      vec4 a = textureLod(tRelief, vec2(p0.x, p0.y), 0.0);
      vec4 b = textureLod(tRelief, vec2(p1.x, p0.y), 0.0);
      vec4 c = textureLod(tRelief, vec2(p0.x, p1.y), 0.0);
      vec4 d = textureLod(tRelief, vec2(p1.x, p1.y), 0.0);
      return mix(mix(a, b, s1.x / (s0.x + s1.x)), mix(c, d, s1.x / (s0.x + s1.x)), s1.y / (s0.y + s1.y));
    }

    // Viking synthetic colour -> approximate true colour (linear). The mosaic's red channel is the real red
    // filter but stretched ~40:1 between dark and bright regions; its blue channel is synthetic and constant
    // (no information), and its green tracks the violet filter: green/red is ~0.3 on bright dust and ~0.9-1.6 on
    // dark basaltic sand, so that ratio is the dust/basalt index. True Mars (red-band normal albedo): bright
    // dusty regions ~0.31-0.42 (Arabia, Tharsis), dark regions ~0.10-0.14 (Syrtis, Acidalia); hue butterscotch
    // (R:G:B ~ 1 : 0.40 : 0.13 linear) on the dust and grey umber (1 : 0.58 : 0.36) on the basalt.
    vec3 trueColour(vec3 v) {
      float rs = pow(max(v.r, 0.0), 0.4545);                // back to the mosaic's perceptual red value
      float gr = v.g / max(v.r, 1e-3);
      float dark = smoothstep(0.42, 0.95, gr);
      // red albedo: Syrtis ~0.10, Acidalia / Meridiani ~0.14, Arabia ~0.31, Tharsis ~0.42
      float R = 0.03 + 0.52 * pow(rs, 1.05);
      // albedo grade (matched to the Viking global colour views: dark-region and bright-region colour, luminance
      // percentiles): a contrast pivot about the median red albedo (~0.26), steeper below it -- the classical dark
      // markings (Acidalia, Mare Erythraeum, Margaritifer, Sinus Meridiani) are slate grey-brown basaltic sand and
      // rock, not darker dust -- and a cleaner butterscotch (less blue) on the bright dust above it
      float x = R / 0.26;
      R = 0.26 * pow(x, x < 1.0 ? uGrade.x : uGrade.y);
      float dk = max(dark, smoothstep(1.08, 0.42, x));
      vec3 c = R * mix(vec3(1.0, 0.345, 0.066), uBasalt, dk);
      // (the mosaic's pink-violet residual ice is always under the baked frost caps, so it needs no special case)
      return c;
    }

    // Terrain cast shadow: march toward the Sun along the great circle, tracking the minimum elevation margin of
    // the sun ray over the terrain (radians). Returns x: direct-sun visibility (penumbra = the real solar disc),
    // y: aureole visibility (the bright forward-scattered sky within ~10-15 deg of the Sun, blocked by the same
    // terrain but with a wide penumbra). Heights are sampled with the same reconstruction as the shaded pixel
    // (bicubic when magnified) so the shadow outline follows smooth contours, not texel edges.
    vec2 terrainShadow(vec3 n0, vec3 Lt, float sinE, float h0, float fpKm, bool cubic) {
      float cosE = sqrt(max(1.0 - sinE * sinE, 1e-6));
      float tanE = sinE / cosE;
      float texKm = 6.2831853 * uRkm / uReliefSize.x;
      float s = max(texKm * 0.35, fpKm * 1.5);
      float m = 1.0;
      for (int i = 0; i < uShadowSteps; i++) {
        float a = s / uRkm;
        vec3 q = n0 * cos(a) + Lt * sin(a);
        float lod = clamp(log2(s / texKm) - 0.5, 0.0, 8.0);
        float hq = textureLod(tRelief, dirToUv(q), lod).r;
        float rayH = (h0 - hq) * uExag + s * tanE + s * s / (2.0 * uRkm);
        m = min(m, rayH / s);
        if (m < -0.25) break;
        s *= 1.36;
        if (s > 1600.0) break;
      }
      float w = uSunAng * 1.25 + 0.0008;
      return vec2(smoothstep(-w, w, m), smoothstep(-0.1, 0.18, m));
    }

    // One octave of Martian craters, cell size S (km). Sizes follow a truncated power law, cumulative N(>D) ~ D^-2
    // (D = 0.12 S .. 0.286 S); pres is the per-cell presence probability (0.52 ~ the Noachian N(5) density).
    // Every crater has a degradation state: fresh ones (fraction freshF) are crisp bowls (d/D ~0.2, complex
    // d ~0.36 D^0.49) with a sharp crest (C1 break) and power-law ejecta; the rest are degraded: shallow, infilled
    // flat floors and low, rounded rims (a crest never sharper than the pixel footprint). Complex craters above
    // ~6 km get flat floors with central peaks or the central pits common on Mars. Albedo: dark blast haloes on
    // dusty ground / bright ejecta on dark sand, brighter fresh walls, and dark dune deposits on large degraded
    // floors, offset downwind. (Rays, rampart aprons and wind streaks were cut for the FXC compile budget; the
    // wind streaks also converged into a radial spray of dark dashes at the pole.)
    // (one cell k of the 2x2x2 neighbourhood per call: the caller runs octaves x cells as ONE loop)
    void marsCraterCell(vec3 pk, vec3 n, vec3 e1, vec3 e2, float Rk, float S, float pres, float freshF, float w, float seed,
                        int k, vec3 Lt, float tanE, float fp, float dusty, vec3 wind,
                        inout float h, inout vec3 g, inout float alb, inout float vis, inout float darkF) {
      vec3 cell = floor(pk / S - 0.5) + vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
      vec4 r4 = mh43(cell + seed);
      vec3 c = (cell + 0.5 + 0.8 * (mh33(cell + seed * 1.37 + 11.1) - 0.5)) * S;
      float rc = length(c);
      vec3 dv = pk - c * (Rk / rc);
      dv -= n * dot(dv, n);
      float dist = length(dv);
      float D = 0.12 * S * inversesqrt(1.0 - 0.8236 * r4.x);
      vec4 q4 = mh43(cell + seed * 2.11 + 5.3);
      // slightly polygonal rim: 3- and 5-fold azimuthal harmonics via Chebyshev polynomials (no atan)
      float ca = dot(dv, e1) / max(dist, 1e-7), sa = dot(dv, e2) / max(dist, 1e-7);
      vec4 qa = q4 * 2.0 - 1.0;
      float R = 0.5 * D * (1.0 + 0.06 * (qa.x * ca * (4.0 * ca * ca - 3.0) + qa.y * sa * (3.0 - 4.0 * sa * sa)));
      float xr = dist / R;
      // one guard: absent, off the surface shell, or too far
      if (r4.w > pres || abs(rc - Rk) > 0.5 * S || xr > 2.3) return;
      float fq = fract(q4.w * 7.13 + r4.z * 3.1);
      float fr = r4.y < freshF ? 0.84 + 0.16 * q4.w : 0.62 * fq * fq;
      float cx = smoothstep(5.0, 9.0, D);
      float depth = mix(0.06 * D, mix(0.2 * D, 0.36 * sqrt(D), cx), fr * fr);
      float rim = D * (mix(0.04, 0.022, cx) * fr * sqrt(fr) + 0.009);
      float ff = max(0.42 * cx, 0.62 * (1.0 - fr));
      float del = min(0.04 + 0.34 * (1.0 - fr) + 1.2 * fp / R, 0.6);
      // inner wall: paraboloid from the floor edge up to the crest, held at crest height beyond it
      float t = clamp((xr - ff) / (1.0 - ff), 0.0, 1.0);
      float hin = -depth + (depth + rim) * t * t;
      float din = 2.0 * (depth + rim) * t / (1.0 - ff) * step(ff, xr) * step(xr, 1.0);
      // outer flank: ejecta thickness ~ (r/R)^-3.5 when fresh, a broad shoulder when degraded
      float pw = mix(1.6, 3.5, fr);
      float xo = max(xr, 1.0);
      float win = 1.0 - smoothstep(1.7, 2.3, xr);
      float tw = clamp((xr - 1.7) / 0.6, 0.0, 1.0);
      float hraw = rim * pow(xo, -pw);
      float dout = -pw * hraw / xo * step(1.0, xr) * win - hraw * 10.0 * tw * (1.0 - tw);
      // crest: blend the two sides over +-del (sharp for fresh craters, rounded for degraded ones)
      float ts = clamp((xr - 1.0 + del) / (2.0 * del), 0.0, 1.0);
      float sb = ts * ts * (3.0 - 2.0 * ts);
      float hh = mix(hin, hraw * win, sb);
      float dh = mix(din, dout, sb) + (hraw * win - hin) * 3.0 * ts * (1.0 - ts) / del;
      // central peak, or a central pit (common on Mars: volatiles in the target)
      float pitC = step(q4.z, 0.4);
      float pa = mix(0.16, 0.09, pitC);
      float pe = exp(-xr * xr / (pa * pa));
      float PA = cx * step(0.2, fr) * depth * mix(0.45 * fr, -0.3, pitC);
      hh += PA * pe;
      dh -= PA * pe * 2.0 * xr / (pa * pa);
      h += w * hh;
      g += w * (dh / R) * (dv / max(dist, 1e-7));
      // ---- albedo ----
      // ejecta: dark blast zone on dusty ground (the bright dust is stripped), bright on dark sandy ground; fresh
      // walls expose brighter rock; large degraded floors trap dark dunes, offset downwind
      float fresh2 = smoothstep(0.7, 0.95, fr);
      float outer = step(0.85, xr);
      bool dunes = q4.y < 0.45 && D > 3.0 && fr < 0.55;
      float ejAlb = outer * fresh2 * mix(0.12, -0.17, dusty) / (xo * xo) * win
                  + (1.0 - outer) * (fresh2 * 0.07 * smoothstep(0.35, 0.9, xr) + (dunes ? 0.0 : 0.03 * (1.0 - fr) * (1.0 - xr * xr)));
      if (dunes && xr < 0.85) {
        float xd = length(dv / R - wind * 0.38) / max(ff + 0.05, 0.35);
        darkF = max(darkF, w * (1.0 - smoothstep(0.55, 1.0, xd)) * smoothstep(3.0, 6.0, D) * (0.55 + 0.45 * q4.x));
      }
      alb += w * ejAlb;
      // bowl shadow: the sun ray must clear the crest
      float qu = dot(dv, Lt);
      float sd = -qu + sqrt(max(R * R - dist * dist + qu * qu, 0.0));
      float clear = hh + sd * tanE - rim;
      float soft = 0.004 * sd + mix(0.08, 0.025, fr) * R + 0.6 * fp * max(tanE, 0.05);
      float inB = step(xr, 1.0) * step(tanE, 3.0);
      vis = min(vis, mix(1.0, smoothstep(-soft, soft, clear), w * inB));
    }

    float moonShadow(vec3 P, vec3 L, vec4 m) {
      vec3 d = m.xyz - P;
      float dl = length(d);
      if (dot(d, L) <= 0.0) return 0.0;
      float th = acos(clamp(dot(d / dl, L), -1.0, 1.0));
      return discOcclusion(th, uSunAng, asin(min(1.0, m.w / dl)));
    }

    void main() {
      vec3 n0 = normalize(vDir);
      float rRef = 1.0 - uFlat * n0.y * n0.y;
      vec3 P = n0 * (rRef + vH / uRkm);
      vec3 Vv = uCamPos - P;
      float dist = length(Vv);
      vec3 V = Vv / dist;
      vec3 L = uSunDir;

      float lat = asin(clamp(n0.y, -1.0, 1.0));
      float lon = atan(-n0.z, n0.x);
      vec2 uv = vec2(lon * 0.15915494 + 0.5, lat * 0.31830989 + 0.5);
      // seam-safe derivatives for the longitude coordinate
      vec2 dX = dFdx(uv), dY = dFdy(uv);
      float u2 = fract(uv.x + 0.5);
      float a2x = dFdx(u2), a2y = dFdy(u2);
      if (abs(a2x) < abs(dX.x)) dX.x = a2x;
      if (abs(a2y) < abs(dY.x)) dY.x = a2y;

      float sl = sin(lat), cl = cos(lat), so = sin(lon), co = cos(lon);
      vec3 east = vec3(-so, 0.0, -co);
      vec3 north = vec3(-sl * co, cl, sl * so);

      // pixel footprint on the ground (km); major axis grows at grazing view
      float muV = max(dot(n0, V), 0.0);
      float fpKm = dist * uRkm * uPixAngle;
      float fpMaj = fpKm / max(muV, 0.12);

      // ---- relief (MOLA, float) ----
      float texPerPx = max(length(dX * uReliefSize), length(dY * uReliefSize));
      vec4 rel = texPerPx < 0.75 ? reliefBicubic(uv) : textureGrad(tRelief, uv, dX, dY);
      // slopes from an equirectangular grid are unreliable right at the pole
      rel.gb *= 1.0 - smoothstep(86.5, 89.5, abs(lat) * 57.29578);
      // the 10 km MOLA grid smooths the walls of craters, scarps and channels: restore their steepness with an
      // unsharp mask on the slopes (band-pass between the sampled level and a 4x coarser one)
      float lodR = log2(max(texPerPx, 1e-4));
      vec2 slBlur = textureLod(tRelief, uv, max(lodR, 0.0) + 2.0).gb;
      rel.gb += 0.7 * (rel.gb - slBlur) * (1.0 - smoothstep(84.0, 88.0, abs(lat) * 57.29578));
      float hKm = rel.r;
      // at disc scale (MOLA resolved, sun high) the relief needs more exaggeration to read as it does in the
      // low-sun Viking frames; close up (where the terrain shadows and the procedural relief take over) it stays
      float exagD = uExag * (1.0 + 0.55 * smoothstep(1.5, 6.0, fpKm));
      vec3 gT = (rel.g * east + rel.b * north) * exagD;

      // ---- albedo ----
      // sharpened colour lookup. The 925 m Viking mosaic is intrinsically soft (it is assembled from ~1000
      // frames of mixed resolution), so restore its baked low-sun relief shading with a two-band unsharp mask
      // (~2.5 and ~7 texel radii) -- applied to the brightness only (hue from the unsharpened sample, so edges
      // get no colour fringes) and faded out toward the poles where the map's texels are stretched
      vec3 vik = textureGrad(tColor, uv, dX * 0.75, dY * 0.75).rgb;
      vec3 vikBlur = textureGrad(tColor, uv, dX * 2.5, dY * 2.5).rgb;
      vec3 vikBlur2 = textureGrad(tColor, uv, dX * 7.0, dY * 7.0).rgb;
      float shp = 1.0 - smoothstep(70.0, 84.0, abs(lat) * 57.29578);
      float rSh = max(vik.r + shp * (0.95 * (vik.r - vikBlur.r) + 0.4 * (vikBlur.r - vikBlur2.r)), 0.0);
      // (the equirectangular mosaic smears into radial streaks near the poles; those latitudes are always under the
      // frost caps, whose albedo comes from the polar-stereographic bake)
      vec3 alb = trueColour(vik);
      alb *= clamp((0.03 + 0.52 * pow(pow(rSh, 0.4545), 1.05)) / (0.03 + 0.52 * pow(pow(max(vik.r, 0.0), 0.4545), 1.05)), 0.55, 1.6);
      // Valles Marineris: the chasma floors (dark sand, layered deposits) are darker and greyer than the plateau in every
      // global colour view, but the soft 925 m mosaic washes them out. MOLA-depth mask: floors more than ~1.5 km below
      // the ~160 km-smoothed surroundings, inside the canyon system (Noctis Labyrinthus to Eos / Capri Chasma)
      {
        float lonD = lon * 57.29578, latDg = lat * 57.29578;
        float vmR = smoothstep(-112.0, -104.0, lonD) * (1.0 - smoothstep(-40.0, -33.0, lonD))
                  * smoothstep(-19.0, -15.0, latDg) * (1.0 - smoothstep(-1.0, 3.0, latDg));
        if (vmR > 0.0) {
          float depthV = textureLod(tRelief, uv, 4.0).r - hKm;
          float fl = vmR * smoothstep(1.0, 3.2, depthV);
          alb = mix(alb, dot(alb, vec3(0.5, 0.35, 0.15)) * vec3(1.0, 0.8, 0.7) * 0.62, 0.8 * fl);
        }
      }

      // ---- sun geometry on the reference sphere ----
      float sinE = dot(n0, L);
      vec3 Lt = L - n0 * sinE;
      float ltl = length(Lt);
      Lt = ltl > 1e-5 ? Lt / ltl : east;
      float tanE = sinE / max(sqrt(max(1.0 - sinE * sinE, 0.0)), 1e-3);

      // ---- procedural detail, faded by footprint ----
      vec3 pk = n0 * uRkm;
      float hp = 0.0, cAlb = 0.0, cVis = 1.0;
      vec3 gp = vec3(0.0);
      float microAlb = 0.0, darkF = 0.0;
      float aLatD = abs(lat) * 57.29578;
      // geologic age (baked, see bake.js): x crater density relative to the Noachian highlands, y fresh fraction,
      // z young volcanic plains, w Hesperian ridged plains
      vec4 age = textureGrad(tAge, uv, dX, dY);
      age.y *= 0.4;
      // dust index from the mosaic (green/red ~0.3 on bright dust, ~0.9-1.6 on dark basaltic sand)
      float dusty = 1.0 - smoothstep(0.42, 0.95, vik.g / max(vik.r, 1e-3));
      vec3 wind = east;
      vec3 dpx = dFdx(pk), dpy = dFdy(pk);    // (outside the branch: derivatives need uniform control flow)
      if (uDetail > 0.5 && fpMaj < 12.0) {
        // Real km-scale roughness depends on the terrain: the lowland and volcanic plains are smooth (RMS slope
        // < 1 deg), the old highlands rugged (eroded crater rims, knobs), steep walls carry spurs and gullies that
        // run downslope, volcano flanks are streaked with radial lava flows, and dark sandy regions hold dunes.
        vec4 slS = textureLod(tRelief, uv, max(lodR, 0.0) + 1.0);          // smoothed MOLA slope field
        vec3 upv = slS.g * east + slS.b * north;
        float slMag = length(upv) * (1.0 - smoothstep(84.0, 88.0, aLatD));
        vec3 sdir = slMag > 1e-4 ? upv / length(upv) : east;
        float busy = clamp(length(vik - vikBlur) * 5.0, 0.0, 1.0);          // the map's own local contrast
        float polar = smoothstep(72.0, 80.0, aLatD);
        float young = 1.0 - smoothstep(0.08, 0.45, age.x);
        float highland = smoothstep(0.45, 0.9, age.x) * smoothstep(-3.0, -1.0, hKm) * (1.0 - polar);
        float steep = smoothstep(0.025, 0.1, slMag) * (1.0 - polar);
        float volc = max(age.z, young * smoothstep(1.5, 5.0, hKm)) * (1.0 - steep);
        float undM = mix(0.12, 0.32, highland) * (1.0 - 0.6 * polar);
        float rouM = mix(0.026, 0.06, highland) * (1.0 - 0.6 * polar) * (0.7 + 0.3 * busy);
        float highM = highland * (0.55 + 0.45 * busy);
        float albM = 0.35 + 0.65 * busy;
        vec4 acc = vec4(0.0);
        for (int i = 0; i < uLayN; i++) {
          vec4 la = uLayA[i];   // f (1/km), offset, amplitude, footprint wavelength (km)
          vec4 lb = uLayB[i];   // mode, mask, lo | tap spacing, tap index
          int mode = int(lb.x + 0.5);
          int mid = int(lb.y + 0.5);
          float mask = mid == 0 ? 1.0 : mid == 1 ? highM : mid == 2 ? steep : mid == 3 ? volc
                     : mid == 8 ? undM : mid == 9 ? rouM : albM;
          bool lic = lb.w > -0.5;
          float lo = lic ? 2.0 : lb.z;
          float w = smoothstep(lo, lo + 3.0, la.w / fpMaj);
          if (mask <= 0.01 || w <= 0.0) continue;
          float f = la.x;
          vec3 q = lic ? pk + sdir * ((lb.w - 2.0) * lb.z / f) : pk;
          // noise value + gradient from the baked periodic 3D texture, each layer on its own rotated lattice
          // (rotation per band, from its frequency and offset: the 5 taps of one LIC band must share a lattice)
          mat3 Rm = uRot[int(mod(floor(la.y * 0.37 + la.x * 13.7), 4.0))];
          vec4 t4 = textureGrad(tNoise3, (Rm * (q * f) + la.y) * 0.0625, Rm * dpx * (f * 0.0625), Rm * dpy * (f * 0.0625));
          vec4 nd = vec4(t4.x, t4.yzw * Rm);
          float A = la.z * w * mask;
          if (mode == 0) {
            float wa = 3.1 * nd.x + 0.8 + 1.2 * n0.y;
            wind = east * cos(wa) + north * sin(wa);
            continue;
          }
          if (lic) {
            acc += nd;
            if (lb.w < 3.5) continue;
          }
          // one branch-free profile for every family: linear (plain height, albedo) or ridged (highland ridges,
          // spurs / gullies, lava flows; LIC rows use the 5-tap average)
          vec4 sm = lic ? acc * 0.33 : nd;
          acc = vec4(0.0);
          float r = 1.0 - abs(sm.x);
          bool ridged = mode == 2 || lic;
          float Pv = ridged ? r * r - (mode == 5 ? 0.0 : 0.4) : sm.x;
          float dP = ridged ? -2.0 * r * sign(sm.x) : 1.0;
          float hw = mode == 3 ? 0.0 : A;
          hp += hw * Pv;
          gp += hw * f * dP * sm.yzw;
          microAlb += mode == 3 ? A * sm.x : mode == 4 ? mask * w * (r - 0.6) * 0.1 : mode == 5 ? mask * w * (r * r - 0.45) * 0.06 : 0.0;
        }
        // (the analytic caldera high-pass at the 13 big volcanoes was cut for the FXC compile budget: MOLA's own
        // 10 km grid still holds the calderas, softened)
        // crater octaves: S = 84 km (D 10-24 km, the scale where the real map's own craters take over) down to
        // ~10 m. Density follows the surface age; young surfaces keep a steep production population of small
        // craters (the < 1 km craters accumulate fast), so they look smooth at 10 km and pocked at 100 m.
        vec3 ce1 = normalize(cross(abs(n0.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), n0));
        vec3 ce2 = cross(n0, ce1);
        for (int it = 0; it < uCraterIters; it++) {
          int o = it >> 3;
          float S = 84.0 * pow(0.42, float(o));
          float w = smoothstep(1.5, 4.0, 0.25 * S / fpMaj);
          if (w <= 0.0) break;
          float Dmin = 0.12 * S;
          float small = clamp(log2(1.0 / Dmin), 0.0, 4.0);
          float pres = 0.52 * age.x * (1.0 + (1.0 - age.x) * 0.55 * small) * (o == 0 ? 0.45 : 1.0);
          float fF = min(age.y * (1.0 + 0.25 * small), 0.6);
          marsCraterCell(pk, n0, ce1, ce2, uRkm, S, min(pres, 0.9), fF, w, float(o) * 7.31, it & 7, Lt, tanE, fpMaj, dusty, wind, hp, gp, cAlb, cVis, darkF);
        }
      }

      // dark basaltic dune deposits on crater floors (red albedo ~0.11, umber), from the crater field
      alb = mix(alb, vec3(0.115, 0.07, 0.046) * (0.9 + 0.2 * dusty), darkF * 0.85);

      // ---- seasonal CO2 / H2O frost caps (north: early spring, receding; south: autumn, forming) ----
      // The margin (deg, > 0 inside the frost) is baked into polar-stereographic maps from the season's edge
      // latitude, pole-facing MOLA slopes and topographic hollows (bake.js): no seam, no pole singularity, and the
      // mip chain filters it by footprint, so the edge is crisp, feathered over 1-3 px. Craters and procedural
      // hollows below the map's resolution keep frost a little longer (cold traps).
      float latD = lat * 57.29578;
      float fpDeg = fpMaj / (uRkm * 0.0174533);
      vec2 puv = vec2(n0.x, n0.z) / ((1.0 + abs(n0.y)) * uPolarTan) * 0.5 + 0.5;
      vec2 pdx = dFdx(puv), pdy = dFdy(puv);
      float frost = 0.0, thick = 0.0;
      if (aLatD > 45.0) {
        bool south = lat < 0.0;
        vec4 pz = south ? textureGrad(tPolarS, puv, pdx, pdy) : textureGrad(tPolarN, puv, pdx, pdy);
        float m = pz.r + max(-hp, 0.0) * 0.3 + 6.0 * dot(gp, south ? -north : north);
        float darkGround = smoothstep(0.13, 0.06, alb.r);
        float rw = sqrt(0.0625 + 2.25 * fpDeg * fpDeg);
        thick = smoothstep(0.2, 2.2, m);
        // dark sand (the circumpolar ergs) defrosts first
        float cover = smoothstep(-rw, rw, m - 1.0 * darkGround * (1.0 - thick));
        // fresh seasonal CO2 / H2O frost: albedo ~0.68, a faint warm pink from the dust it holds (1 : 0.92 : 0.89);
        // slab vs granular ice and dust contamination vary it by a few per cent at 50-500 km scales
        vec3 frostCol = vec3(0.68, 0.627, 0.605) * pz.g;
        // the residual water-ice cap (Planum Boreum): the dusty layered slopes of the spiral troughs stay darker
        float res = south ? 0.0 : smoothstep(79.0, 82.5, latD);
        float lumN = clamp(pz.a / 0.42, 0.3, 1.25);
        vec3 capCol = frostCol * mix(1.0, 0.62 + 0.4 * lumN, res);
        // near the edge the frost is thin and patchy: the ground's own pattern shows through a mottled veil
        float mot = smoothstep(-0.5, 0.6, pz.b);
        vec3 thinFrost = mix(alb, frostCol, 0.45 + 0.35 * mot) + 0.02;
        alb = mix(alb, mix(thinFrost, capCol, thick), cover);
        frost = cover;
        thick *= cover;
      }
      // procedural albedo after the frost so that it is mostly hidden under the ice (crater floors frost over)
      float ma = microAlb * (1.0 - 0.85 * frost);
      alb *= (1.0 + cAlb * (1.0 - 0.9 * frost)) * (1.0 + ma);
      alb = mix(alb, vec3(dot(alb, vec3(0.45, 0.4, 0.15))) * vec3(1.0, 0.82, 0.66), clamp(-ma * 1.5, 0.0, 0.35));
      // frost blankets and fills small relief (and the disc-scale exaggeration must not turn frosted craters into
      // dark pits); frost-filled bowls are shallower, so their shadows shrink
      gT *= 1.0 - 0.45 * thick;
      gp -= n0 * dot(gp, n0);
      vec3 N = normalize(n0 - gT - gp * (1.0 - 0.3 * thick));
      cVis = mix(cVis, 1.0, 0.6 * thick);

      // ---- lighting ----
      float mu0 = dot(N, L);
      float mu = max(dot(N, V), 0.0);
      float h0 = hKm + hp;
      vec2 tsh = vec2(1.0);
      // (terrain cast shadows fade out poleward of 81-85 deg: the equirectangular MOLA rows there are degenerate and
      // the march cast spurious radial dashes and a star-shaped spot at the pole; MOLA normals still shade the relief)
      if (sinE < 0.4 && sinE > -0.14 && aLatD < 85.0) tsh = mix(terrainShadow(n0, Lt, sinE, hKm, fpKm, texPerPx < 0.75), vec2(1.0), smoothstep(81.0, 85.0, aLatD));
      float mshadow = 1.0;
      for (int i = 0; i < uMoonN; i++) mshadow *= 1.0 - moonShadow(P, L, i == 0 ? uMoonA : uMoonB);
      float vis = tsh.x * cVis * mshadow;

      // direct sunlight through the dust: delta-Eddington extinction (the forward peak stays in the beam),
      // Chapman slant path at the local terrain height (high volcanoes stand above most of the dust)
      float Xr = (rRef * uRkm + h0) / uHdust;
      float tauSun = uTau0 * exp(-h0 / uHdust) * chapman(Xr, sinE);
      // grazing paths: light scattered by a few degrees still arrives from the Sun's direction (it is the bright
      // aureole), so the effective directional extinction saturates (keeps the terminator crisp, not a brown band)
      float tauEff = mix(tauSun, tauSun / (1.0 + tauSun / 4.0), smoothstep(-0.03, 0.0, sinE));
      vec3 Tsun = exp(-min(DUST_EXT * tauEff, vec3(60.0)));

      // Lunar-Lambert: Mars is between Lambert and Lommel-Seeliger; mild opposition brightening
      float g = acos(clamp(dot(L, V), -1.0, 1.0));
      // frost has its own photometry. The seasonal CO2 cap stays bright at 60-80 deg incidence (Viking, MOC, OMEGA):
      // translucent slab ice and coarse frost scatter light forward and laterally, so its reflectance falls much
      // more slowly with incidence than Lambert -- here a Lunar-Lambert blend weighted toward Lommel-Seeliger, a
      // narrow opposition surge (coherent backscatter) and a mild forward lobe at high phase
      float LL = mix(0.38, 0.64, frost);
      float brdf = max(mu0, 0.0) * ((1.0 - LL) + 2.0 * LL / max(max(mu0, 0.0) + mu, 0.05));
      brdf *= 1.0 + mix(0.32, 0.5, frost) * exp(-g / mix(0.16, 0.1, frost));
      brdf *= 1.0 + frost * 0.4 * smoothstep(1.4, 2.6, g);
      vec3 direct = uSunColor * Tsun * vis * brdf;

      // skylight: the light the dust takes out of the beam (true extinction minus the delta-scaled part) and
      // sends down. ~60% arrives from the forward aureole around the Sun (directional: it shades relief and is
      // blocked by terrain with a wide penumbra), the rest from the whole butterscotch sky. Beyond the
      // terminator the dust overhead stays sunlit for a while: twilight, decaying with the depression angle.
      float e0 = max(sinE + 0.02, 0.0);
      float cX = sqrt(1.5707963 * Xr);
      float tF = uTau0 * exp(-h0 / uHdust) * cX / ((cX - 1.0) * max(sinE, 0.0) + 1.0);
      // (only the broad, coloured lobes leave the delta-scaled beam; ~80% of that goes down)
      vec3 Ed = uSunColor * DUST_OMEGA * (vec3(1.0) - DUST_FD) * (1.0 - exp(-min(tF, 30.0))) * 0.8 * e0;
      vec3 La = normalize(L + n0 * 0.22);
      float aur = min(max(dot(N, La), 0.0) / max(dot(n0, La), 0.08), 3.0);
      float iso = 0.5 + 0.5 * dot(N, n0);
      // Martian twilight lasts to ~15-20 deg solar depression (the dust column stays sunlit long after sunset: Viking /
      // Pathfinder / Curiosity sky photometry): an exponential in the depression angle, e-fold ~4.5 deg, scaled by the
      // dust optical depth
      float twi = 0.022 * (uTau0 / 0.15) * exp(min(sinE, 0.0) / 0.0785) * smoothstep(-0.34, -0.02, sinE) * (1.0 - smoothstep(0.0, 0.25, sinE) * 0.5);
      // the twilight glow is brightest low in the solar azimuth (forward scattering by the sunlit dust), so it
      // still shades the relief after sunset
      vec3 Ltw = normalize(Lt * 0.985 + n0 * 0.17);
      float twDir = 0.35 * iso + 0.65 * min(max(dot(N, Ltw), 0.0) / max(dot(n0, Ltw), 0.12), 3.0);
      // twilight: the light from low in the solar azimuth is the blue sunset aureole (the dust's diffraction peak,
      // narrower and stronger in the blue); the rest of the twilight sky is butterscotch
      vec3 sky = Ed * (0.6 * aur * tsh.y * mshadow + 0.4 * iso * vec3(1.0, 0.88, 0.76))
               + uSunColor * twi * (0.35 * iso * vec3(1.0, 0.8, 0.62) + 0.65 * (twDir - 0.35 * iso) / 0.65 * vec3(0.78, 0.9, 1.08));

      vec3 col = alb * (direct + sky);
      if (uDebug > 0.5 && uDebug < 1.5) col = alb;
      if (uDebug > 1.5 && uDebug < 2.5) col = vec3(0.4) * (direct + sky);
      gl_FragColor = vec4(col, 1.0);
    }`;

  return new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader });
}
