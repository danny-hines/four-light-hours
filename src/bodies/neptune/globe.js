// Neptune's globe: a procedural, wind-advected cloud deck with Voyager-style discrete features.
//
// Physics / data used:
//  * Zonal winds: Sromovsky et al. (1993) fit u = -398 + 0.188 phi^2 - 1.2e-5 phi^4 m/s (retrograde 400 m/s at the
//    equator, prograde ~250 m/s near +-70 deg). The deck is advected per latitude with a two-phase flow map whose
//    phases are centred on their own mid-life (displacement (f - 1/2) * cycle), so the shear strain a phase carries
//    while it is visible stays small even in the strongest shear zones.
//  * Band structure (Voyager 2 / Karkoschka 2011): a broad dark belt centred near -59 deg with a sharp equatorward
//    edge, a narrow bright collar at -71.5 deg (sharp poleward edge) around a darker polar cap, a light zone near -29
//    deg, a bright line at the Scooter latitude, a darker equatorial belt, a light zone near +22 and a dark band near
//    +50 deg. Contrast calibrated on the central meridian against the Voyager frame (residual p2p ~ 85-90 DN). The
//    absorbing aerosol that darkens a belt sits mostly above the scattering gas, so the gas term carries 85 % of it.
//  * Deck texture: mottling plus a footprint-driven cascade of zonally stretched, mutually displaced smooth filaments
//    (gain 0.68 per octave), strongest in the shear zones at the band edges and quiet in between. Inside the Great
//    Dark Spot the deck is carried by the vortex's own anticyclonic flow (differential rotation about the spot centre),
//    so the texture wraps around and stretches along the rim instead of passing through it.
//  * Discrete features ride their own measured drift rates: Great Dark Spot (period 18.3 h, -17.5 deg, aspect ratio
//    and tilt oscillating with the observed ~8-day period), the Scooter (16.8 h, -42 deg), Dark Spot 2 (16.05 h,
//    -54 deg, bright convective core) and the South Polar Feature clouds (15.966 h, -70.4 deg; Karkoschka 2011).
//  * Bright methane-ice clouds: long filamentary streaks (2-4 sub-filaments each) clustered in the active latitude
//    bands, each living a few days, plus the GDS companions. Each filament has a continuous opacity profile: a
//    rounded core with a smooth shoulder at least ~2 px wide, an exponential skirt of thin cloud base, raggedness from
//    ONE continuous warp of the across-track coordinate, and fibres along the flow. The gas column above a cloud tints
//    it blue (more at its thin edges), its core albedo is capped below white, and light scattered around it in the
//    haze adds a faint blue glow. Clouds have their own light path (above most of the methane) and cast offset
//    shadows on the deck (height exaggerated to ~240 km so the shadows read at disc scale).
//  * Reflectance (per RGB channel), a two-component reflecting-layer model:
//      I/F = A (1 - g) mu0 exp(-ka Xe) deck  +  C_gas Rayleigh_LS(mu0, mu, Theta)
//    a Lambertian deck under the methane/haze absorption column ka (strongest in red; the excess airmass saturates
//    as in a multiply scattering atmosphere), plus Rayleigh single scattering by the gas above the deck with its own
//    lambda^-4-like colour, which keeps the limb indigo rather than teal and the crescent blue.
//    Colour follows Irwin et al. (2024): paler and greener than the 1989 release, but deeper than Uranus.
//  * Analytic shadow of Triton (with penumbra from the Sun's 0.018 deg disc).
//
// Shader compile cost (Chrome / ANGLE / FXC fully inlines every call site, superlinearly in code size): simplex noise
// appears only inside the two deck octave loops; every other noise is one fetch of a 4-channel value-noise texture
// (vn4); the ~70 cloud filaments are all evaluated through ONE ribbon() call site in one slot loop.
import * as THREE from 'three';
import { NOISE_GLSL } from '../../glsl/noise.js';
import { COMMON_GLSL, VNOISE_GLSL, noiseTexture, windOmega } from './common.js';
import { makeCloudList, MAX_CLOUDS } from './cloudlist.js';

const DEG = Math.PI / 180;

const v4 = (a = []) => new THREE.Vector4(a[0] || 0, a[1] || 0, a[2] || 0, a[3] || 0);

// Latitude band profile (deck albedo multipliers, RGB) as a 1024 x 2 lookup: row 0 every band except the dark southern
// belt, row 1 the belt alone (its edge meanders separately). Voyager 2 / Karkoschka (2011) layout, contrast calibrated
// on the central meridian against the Voyager frame.
function bandLut() {
  const W = 1024;
  const g = (x, c, s) => Math.exp(-0.5 * ((x - c) / s) ** 2);
  const g2 = (x, c, sa, sb) => g(x, c, x < c ? sa : sb);
  const ss = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const mixv = (v, w) => v.map((c) => 1 + (c - 1) * w);
  const data = new Uint16Array(W * 2 * 4);
  for (let i = 0; i < W; i++) {
    const L = -90 + (180 * (i + 0.5)) / W;
    const terms = [
      [[1.36, 1.43, 1.39], g2(L, -71.5, 1.15, 2.1)], // bright collar, sharp poleward edge
      [[0.88, 0.88, 0.9], ss(-74.5, -80, L)], // darker polar cap inside it
      [[1.25, 1.22, 1.14], g(L, -44.5, 2.0)], // bright line at the Scooter latitude
      [[1.5, 1.45, 1.24], g2(L, -30, 4.2, 6.5)], // light zone, sharper poleward
      [[0.84, 0.82, 0.86], g(L, -39.5, 2.3)], // a darker lane between it and the Scooter line
      [[0.52, 0.49, 0.58], g(L, -3, 8)], // darker equatorial belt
      [[1.45, 1.4, 1.2], g(L, 22, 6.5)], // northern light zone
      [[0.5, 0.48, 0.6], g(L, 50, 8)], // dark northern band
      [[1.12, 1.1, 1.05], ss(66, 80, L)],
    ];
    const m = [1, 1, 1];
    for (const [v, w] of terms) mixv(v, w).forEach((c, k) => (m[k] *= c));
    // broad dark southern belt: a sharp equatorward edge at ~-48.5 deg (just south of the Scooter line), a softer
    // poleward one toward the collar
    const belt = mixv([0.52, 0.47, 0.58], ss(-46.6, -50.4, L) * ss(-70, -63.5, L));
    for (let k = 0; k < 3; k++) {
      data[(i * 4 + k)] = THREE.DataUtils.toHalfFloat(m[k]);
      data[((W + i) * 4 + k)] = THREE.DataUtils.toHalfFloat(belt[k]);
    }
    data[i * 4 + 3] = data[(W + i) * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const t = new THREE.DataTexture(data, W, 2, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export function makeGlobeMaterials(ctx, { radius, flat }) {
  const { U } = ctx;
  const cloudList = makeCloudList();
  const low = ctx.quality === 'low';
  const uniforms = {
    uSunPosW: U.uSunPosW,
    uSunColor: U.uSunColor,
    uSunRadius: U.uSunRadius,
    uRotW: { value: new THREE.Matrix3() },
    uResolution: U.uResolution,
    uNoiseTex: { value: noiseTexture(THREE) },
    uBandLut: { value: bandLut() },
    uRadius: { value: radius },
    uFlat: { value: 1 - flat },
    uT: { value: 0 },
    uTritonPosW: { value: new THREE.Vector3(1e9, 0, 0) },
    uTritonR: { value: 0.2124 },
    // disc-centre I/F of the deck at zero phase (linear): rich azure, paler than Voyager's 1989 release
    uAlbedo: { value: new THREE.Vector3(0.05, 0.165, 0.56) },
    // absorption optical depth above the deck (methane + haze absorption; strongest in red)
    uKa: { value: new THREE.Vector3(1.45, 1.27, 1.12) },
    // fraction of the disc-centre I/F carried by the gas above the deck, and that gas term's own colour (I/F)
    uGasF: { value: new THREE.Vector3(0.05, 0.06, 0.095) },
    uGasC: { value: new THREE.Vector3(0.016, 0.0145, 0.056) },
    uKb: { value: 1.2 },
    uBandK: { value: 1.2 }, // exponent on the band pattern (contrast; dev: ?nepBandK=)
    uGdsRate: { value: 360 * 24 * (1 / 18.3 - 1 / 16.11) * DEG },
    uGdsOmega: { value: windOmega(-17.5) },
        uDs2Rate: { value: 360 * 24 * (1 / 16.05 - 1 / 16.11) * DEG },
        uCloudH: { value: 0.004 }, // cirrus height (planet radii) for the lit-past-terminator dip (~100 km)
    uShadowH: { value: 0.0095 }, // height used for the shadow offset (~240 km, exaggerated for readability)
    // loop bounds as uniforms: ANGLE/D3D would otherwise unroll and inline every iteration
    uTwo: { value: 2 },
    uOctMott: { value: 5 },
    uOctFine: { value: low ? 7 : 10 },
    uNSub: { value: 4 },
    // bright-cloud slots, rebuilt on the CPU every frame (cloudlist.js)
    uCA: { value: cloudList.A },
    uCB: { value: cloudList.B },
    uCC: { value: cloudList.C },
    uNC: { value: 0 },
    uDbg: { value: 0 },
  };

  const vertexShader = /* glsl */ `
    uniform vec2 uResolution;
    varying vec3 vPosL;
    varying vec3 vPosW;
    varying float vPx;
    void main() {
      vPx = 2.0 / (projectionMatrix[1][1] * uResolution.y);   // pixel angle (rad)
      vPosL = position;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vPosW = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`;

  const head = /* glsl */ `
    precision highp float;
    precision highp sampler3D;
    uniform vec3 uSunPosW;
    uniform vec3 uSunColor;
    uniform float uSunRadius;
    uniform mat3 uRotW;
    uniform float uFlat;
    uniform float uT;
    uniform vec3 uTritonPosW;
    uniform float uTritonR;
    uniform vec3 uAlbedo, uKa, uGasF, uGasC;
    uniform float uKb, uBandK;
    uniform sampler2D uBandLut;
    uniform float uGdsRate, uGdsOmega, uDs2Rate;
    uniform vec4 uCA[${MAX_CLOUDS}], uCB[${MAX_CLOUDS}], uCC[${MAX_CLOUDS}];
    uniform float uCloudH, uShadowH;
    uniform int uTwo, uOctMott, uOctFine, uNSub, uNC, uDbg;
    uniform float uRadius;
    varying vec3 vPosL;
    varying vec3 vPosW;
    varying float vPx;

    ${NOISE_GLSL}
    ${VNOISE_GLSL}
    ${COMMON_GLSL}

    const float RKM = 24764.0;
    const float CYC = 2.0;    // flow-map cycle for the deck texture (days)

    // angular drift rate (rad/day). Poleward of ~76 deg the polar vortex turns close to a solid body (u ~ cos lat),
    // so the rate is held at its 76-deg value there: no shear, no concentric smearing around the pole.
    float windOmega(float lat) {
      float L = clamp(degrees(lat), -76.0, 76.0);
      float p2 = L * L;
      float u = (-398.0 + 0.188 * p2 - 1.2e-5 * p2 * p2) * (1.0 - smoothstep(72.0, 90.0, abs(L)));
      return u * 86400.0 / (RKM * 1000.0 * cos(radians(L)));
    }
    vec3 sph(float lat, float lon) { float c = cos(lat); return vec3(c * cos(lon), sin(lat), -c * sin(lon)); }
    float gauss(float x, float c, float s) { float d = (x - c) / s; return exp(-0.5 * d * d); }
    // asymmetric Gaussian: width sa below the centre, sb above it
    float gauss2(float x, float c, float sa, float sb) { float d = (x - c) / (x < c ? sa : sb); return exp(-0.5 * d * d); }
    float wrapPi(float a) { return mod(a + PI, TAU) - PI; }
    float screen(float a, float b) { return 1.0 - (1.0 - a) * (1.0 - clamp(b, 0.0, 1.0)); }
    // octave weight by pixel footprint: f = feature frequency (noise units per radian), fw = footprint (radians)
    float lod(float f, float fw) { return 1.0 - smoothstep(0.14, 0.42, f * fw); }

    // The deck's two spectra in ONE octave loop (one simplex call site keeps the compile fast):
    //  * octaves 0 .. uOctMott-1: zonally stretched mottling from 4 / rad, gain 0.55;
    //  * then the fine cascade from 14 / rad: zonally stretched smooth filaments, each octave displaced by the one above
    //    it (filaments bend around the larger eddies) and gated by it (intermittency); gain 0.68 at first, so no single
    //    octave dominates the disc, then a floor (equal contrast per octave, a passive tracer's k^-1 spectrum), so the
    //    cascade keeps its contrast as the footprint shrinks. Fine octaves are evaluated at q * f + a bounded offset.
    // Every octave is footprint-filtered. Returns (mottling, fine).
    vec2 deckOctaves(vec3 q, vec3 q2, vec3 seed, float ani, float aniF, float fw) {
      vec3 sm = (vec3(q.x, q.y * ani, q.z) + seed) * 4.0;
      float fm = 4.0 * ani, am = 1.0;
      float ff = 14.0, af = 1.0, n = 0.0;
      float mott = 0.0, fine = 0.0;
      vec3 sf = seed + 37.0;
      int nTot = uOctMott + uOctFine;
      for (int i = 0; i < nTot; i++) {
        bool isM = i < uOctMott;
        float fi = float(i - uOctMott);
        float an = mix(aniF, 1.5, min(max(fi, 0.0) / 6.0, 1.0));     // small filaments are less elongated
        float w = lod(isM ? fm : ff * an * 1.7, fw);                 // fine: no sub-4-px hairlines across the flow
        if (w <= 0.0) break;
        vec3 c = isM ? sm : vec3(q2.x, q2.y * an, q2.z) * ff + fract(sf * (0.137 + 0.071 * fi)) * 97.0 + vec3(1.0, 0.2, -0.85) * n;
        float nn = snoise(c);
        if (isM) {
          mott += am * w * nn;
          sm = sm * 2.03 + vec3(1.7, 9.2, 3.1);
          am *= 0.55;
          fm *= 2.03;
        } else {
          float gate = fi < 0.5 ? 1.0 : 0.45 + 1.1 * smoothstep(-0.35, 0.5, n);
          fine += af * w * nn * gate;
          n = nn;
          ff *= 2.04;
          af = max(af * 0.68, 0.45);   // below ~1000 km the tracer cascade keeps its contrast per octave (k^-1)
        }
      }
      return vec2(mott, fine);
    }

    // ---------------------------------------------------------------- flow map
    struct Flow { float ta; float tb; vec3 sa; vec3 sb; float va; float vb; };
    // phases live for one cycle each, displaced by (f - 1/2) * cycle so they are undistorted at peak weight
    Flow flowAt(float cyc, float salt) {
      Flow F;
      float ph = uT / cyc + salt;
      float fa = fract(ph), fb = fract(ph + 0.5);
      F.sa = hash33(vec3(floor(ph), 1.7, 3.1 + salt)) * 61.0;
      F.sb = hash33(vec3(floor(ph + 0.5), 5.3, 7.9 + salt)) * 61.0;
      F.ta = (fa - 0.5) * cyc;
      F.tb = (fb - 0.5) * cyc;
      float wa = 1.0 - abs(2.0 * fa - 1.0);
      float wb = 1.0 - wa;
      float n = inversesqrt(wa * wa + wb * wb);
      F.va = wa * n; F.vb = wb * n;   // variance-preserving (zero-mean noise)
      return F;
    }

    // ---------------------------------------------------------------- discrete features
    vec2 featXY(float lat, float lon, float lat0, float lon0) {
      return vec2(wrapPi(lon - lon0) * cos(lat0), lat - lat0);
    }
    float aw(float a, float c, float w) { float d = wrapPi(a - c) / w; return exp(-0.5 * d * d); }

    // GDS frame: ellipse-normalised coordinates e (|e| = 1 on the nominal boundary), g in radians (tilted frame)
    const float GDS_LAT = -0.30543;   // -17.5 deg
    void gdsFrame(float lat, float lon, out vec2 g, out vec2 e, out vec2 axes, out float tilt) {
      float t = uT;
      float lonc = radians(-78.0) + uGdsRate * t;
      g = featXY(lat, lon, GDS_LAT, lonc);
      float osc = sin(TAU * t / 8.0);
      tilt = 0.06 * osc - 0.04;
      g = mat2(cos(tilt), sin(tilt), -sin(tilt), cos(tilt)) * g;
      axes = vec2(0.232 * (1.0 + 0.07 * osc), 0.108 * (1.0 - 0.07 * osc));
      e = g / axes;
    }

`;
  const ribbonGLSL = /* glsl */ `
    // A bright cloud filament: u = along-track coordinate (one unit ~ one clump), v = across-track offset in units of
    // the nominal half-width; fu, fv = pixel footprints in u and v units. Continuous opacity profile (rounded core with
    // a >= ~2 px shoulder, exponential skirt), ONE continuous warp of the across-track coordinate for raggedness,
    // gentle fibres along the flow; energy-preserving when sub-pixel. Returns (opacity, halo).
    vec2 ribbon(float u, float v, float seed, float fu, float fv) {
      vec4 a = vn4(vec3(u * 0.23 + seed * 3.7, seed * 1.31, 0.5));
      float wv = max(1.0 + 0.5 * a.x, 0.4);                // width varies along the length
      float vn = (v - 0.35 * a.w) / wv;                    // the centre line meanders a little
      float fvn = fv / wv;
      float S = max(1.0, fvn);                              // effective half-width (>= one footprint)
      float brk = smoothstep(-0.5, 0.2, a.y);               // breaks along the length
      // raggedness: one continuous warp of the across-track coordinate, long along the flow (two octaves)
      vec4 b = vn4(vec3(u * 0.9 + seed, vn * 0.45, seed * 1.7 + 2.0));
      vec4 c = vn4(vec3(u * 2.7 + seed * 1.3, vn * 1.3, seed * 2.3 + 5.0));
      float l1 = lod(1.0, max(0.9 * fu, 0.45 * fvn));
      float l2 = lod(1.0, max(2.7 * fu, 1.3 * fvn));
      float warp = 0.34 * b.x * l1 + 0.16 * c.x * l2;
      float vw = abs(vn + warp) / S;
      // rounded core with a smooth shoulder at least ~2 px wide, then a thin skirt of cloud base
      float sh = max(0.25, 2.2 * fvn / S);
      float core = 1.0 - smoothstep(1.0 - sh, 1.0 + sh, vw);
      core *= 1.0 - 0.28 * min(vw * vw, 1.0);
      float skirt = 0.2 * exp(-max(vw - 0.7, 0.0) / 1.9);
      float op = core + (1.0 - core) * skirt;
      // fibres along the flow: a continuous density modulation, no thresholds
      float fib = 1.0 + 0.3 * b.z * l1 + 0.2 * c.z * l2;
      op *= clamp(fib, 0.35, 1.35) * 0.9 / S;
      float halo = exp(-0.5 * vw * vw / 9.0) / S;
      return vec2(op, halo) * brk;
    }

`;
  const deckGLSL = /* glsl */ `
    // deck darkening by the GDS: a smooth, saturated elliptical core, diffuse and irregular at its edge (softer on the
    // north and west, a little steeper on the south / east side), darkest in its western third, with faint
    // anticyclonic spiral shading inside
    float gdsDark(vec2 g, vec2 e, vec2 axes, float fw) {
      if (abs(e.x) > 2.2 || abs(e.y) > 2.6) return 0.0;
      float ky = mix(0.92, 1.3, smoothstep(0.35, -0.35, e.y));
      vec2 es = vec2(e.x, e.y * ky);
      float rr = dot(es, es);
      float r = sqrt(rr);
      float se = smoothstep(0.2, -0.6, e.y) * 0.75 + 0.35 * smoothstep(0.0, 0.9, e.x);
      float fe = fw / axes.y;                            // footprint in e units
      vec4 n1 = vn4(vec3(e * 1.5, 3.1));
      vec4 n2 = vn4(vec3(e * 4.1, 8.2));
      vec4 n3 = vn4(vec3(e * 10.5, 4.4));
      float edge = 0.16 * n1.x + 0.09 * n2.x * lod(4.1, fe) + 0.045 * n3.x * lod(10.5, fe);
      float P = mix(2.2, 2.8, clamp(se, 0.0, 1.0));
      float d = exp(-pow(rr * (1.0 + edge), P) * 0.62);
      // the western third is darker than the east
      d *= 1.0 + 0.13 * smoothstep(0.35, -0.9, es.x);
      // internal mottling (the deck texture inside is already carried round by the vortex flow)
      float inner = 0.05 * n1.z + 0.035 * n2.z * lod(4.1, fe);
      d *= 1.0 + 1.6 * inner * smoothstep(1.0, 0.3, r);
      // faint lighter collar outside
      d -= 0.06 * exp(-0.5 * pow((r - 1.45) / 0.22, 2.0));
      return d;
    }

    // ---------------------------------------------------------------- deck
    // the band albedo pattern alone (set by deck()): the absorbing aerosol that darkens a belt sits mostly above the
    // scattering gas, so the gas term carries most of the band contrast too
    vec3 gBand = vec3(1.0);
    vec3 deck(vec3 p, float lat, float lon, float fw, Flow F, vec2 g, vec2 e, vec2 axes, float tilt) {
      float L = degrees(lat);
      float polar = smoothstep(50.0, 72.0, abs(L));
      // band boundaries undulate: a slow, low-order wave pattern drifting at one rate (a wave, not a tracer, so it
      // is NOT sheared by the zonal wind; sheared, it combed the steep edges of the dark band into hairlines)
      vec3 sw = sph(lat, lon + 0.35 * uT);
      vec4 nw = vec4(vn4(sw * vec3(2.0, 5.0, 2.0) + vec3(3.7, 1.1, 8.3)).x, vn4(sw * vec3(6.5, 9.0, 6.5) + vec3(1.3, 5.1, 2.9)).y, 0.0, 0.0);
      float Lw = L + 1.6 * nw.x + 0.7 * nw.y;
      // latitude band profile from the LUT built in bandLut() (row 0: everything but the belt; row 1: the belt, whose
      // equatorward edge meanders more than the others)
      float Lb = Lw + 1.3 * nw.y;
      vec3 m = textureLod(uBandLut, vec2(clamp(Lw / 180.0 + 0.5, 0.0, 1.0), 0.25), 0.0).rgb
             * textureLod(uBandLut, vec2(clamp(Lb / 180.0 + 0.5, 0.0, 1.0), 0.75), 0.0).rgb;
      m = pow(m, vec3(uBandK));
      gBand = m;
      // fine latitudinal texture (stable, zonally coherent); faded toward the poles so no bull's-eye forms
      float zonalW = smoothstep(0.38, 0.75, cos(lat));
      vec4 nz1 = vn4(vec3(Lw * 0.4, 1.3, 7.1));
      vec4 nz2 = vn4(vec3(Lw * 1.3, 4.2, 2.2));
      float fb = nz1.x * 0.6 + nz2.x * 0.4 * lod(1.3 * 57.3, fw);
      m *= 1.0 + 0.05 * fb * zonalW * vec3(1.0, 0.9, 0.7);

      // fine-texture strength by latitude: high in the shear zones at band edges, quieter in between
      float shear = clamp(gauss(L, -20.0, 6.0) + gauss(L, -45.0, 4.0) + gauss(L, -61.0, 5.0) + gauss(L, 25.0, 6.0)
                        + gauss(L, 46.0, 5.0) + gauss(L, -72.0, 3.0), 0.0, 1.0);
      float fineA = 0.55 + 0.45 * shear;

      // the GDS carries the deck around with it: inside rho < ~1.6 the texture coordinates are rotated about the
      // spot centre by an anticyclonic, differential angle (fastest near the rim), plus a permanent wind-up
      float rho = length(e);
      float omR = rho * rho * exp(2.0 * (1.0 - rho * rho)) * TAU / 8.0;   // rad/day: ~solid body inside, decays outside the rim
      float om = windOmega(lat);
      float k = mix(1.0, 0.35, smoothstep(55.0, 72.0, abs(L)));   // reduced shear-displacement near the poles
      float cl = cos(GDS_LAT);

      float ani = mix(2.6, 1.0, polar);
      float aniF = mix(5.0, 1.5, polar);
      float mott = 0.0, fine = 0.0;
      // both flow phases in one loop (single call sites keep the compile fast)
      for (int kk = 0; kk < uTwo; kk++) {
        float v = kk == 0 ? F.va : F.vb;
        if (v < 0.01) continue;
        float tau = kk == 0 ? F.ta : F.tb;
        vec3 sd = kk == 0 ? F.sa : F.sb;
        float la = lat, lo = lon - om * k * tau;
        if (rho < 1.9) {
          float ph = omR * (tau + 1.0);
          vec2 eg = mat2(cos(ph), sin(ph), -sin(ph), cos(ph)) * e;
          vec2 dg = (eg - e) * axes;
          dg = mat2(cos(tilt), -sin(tilt), sin(tilt), cos(tilt)) * dg;   // back to east / north
          la += dg.y;
          lo += dg.x / cl;
        }
        vec3 d = sph(la, lo);
        vec4 w1 = vn4((d + sd) * 2.4);
        vec3 q = d + 0.075 * vec3(w1.x, w1.y * 0.4, w1.z);
        // mid-scale meanders (~4000 km): bend the fine lanes so they do not all run parallel
        vec4 w2 = vn4(q * 38.0 + sd);
        vec3 q2 = q + 0.009 * vec3(w2.x, 0.25 * w2.y, w2.z) * lod(38.0, fw);
        vec2 mf = deckOctaves(q, q2, sd, ani, aniF, fw);
        mott += v * mf.x;
        fine += v * mf.y;
      }
      m *= 1.0 + 0.085 * mott * vec3(1.0, 0.86, 0.62);
      // (the spot's interior is calmer than the shear zone around it)
      m *= 1.0 + 0.19 * fineA * mix(1.0, 0.45, smoothstep(1.1, 0.6, rho)) * fine * vec3(1.0, 0.9, 0.74);
      // polar vortical mottling
      if (polar > 0.0) {
        vec4 np = vn4(p * 7.0 + 3.1);
        float pm = np.x * 0.6 + np.y * 0.3;
        m *= 1.0 + 0.06 * polar * pm * vec3(1.0, 0.88, 0.7);
      }

      // dark spots: a deeper, more saturated blue than the surroundings
      float dark = gdsDark(g, e, axes, fw);
      {
        vec2 g2 = featXY(lat, lon, radians(-54.0), radians(-142.0) + uDs2Rate * uT);
        if (abs(g2.x) < 0.2 && abs(g2.y) < 0.09) {
          vec2 e2 = g2 / vec2(0.068, 0.034);
          float n = vn4(vec3(e2 * 2.5, 5.5)).x * 0.1;
          dark = max(dark, 0.8 * exp(-pow(dot(e2, e2) * (1.0 + n), 1.6) * 0.8));
        }
      }
      vec3 dk = mix(vec3(1.0), vec3(0.3, 0.42, 0.68), clamp(dark, -0.3, 1.1));
      m *= dk;
      gBand *= mix(vec3(1.0), dk, 0.4);     // the spot is a hole in the haze too: part of it darkens the gas term
      return m;
    }

`;
  const cloudGLSL = /* glsl */ `
    // ---------------------------------------------------------------- bright clouds
    // Every filament comes from one flat uniform list that cloudlist.js rebuilds on the CPU each frame (GDS companion
    // arcs as rotated parabolas, GDS flank streaks, the Scooter, Dark Spot 2's core, polar-feature clouds, hand-placed
    // and procedural band streaks), 1-4 sub-filaments each, all through ONE ribbon() call. Returns (opacity, halo).
    vec2 clouds(float lat, float lon, float fw) {
      float c = 0.0, cArc = 0.0, halo = 0.0;
      for (int s = 0; s < uNC; s++) {
        vec4 A = uCA[s], B = uCB[s];
        vec4 C = uCC[s];
        float dy0 = lat - A.x;
        if (abs(dy0) > A.z * abs(C.y) + 14.0 * A.w + abs(C.z) * A.z * A.z * 3.2 + 3.0 * fw) continue;
        float dx0 = wrapPi(lon - A.y) * cos(A.x);
        // the filament's own frame: rotated by theta from east, bent by the curvature
        float x = C.x * dx0 + C.y * dy0;
        float hl = A.z;
        if (abs(x) > hl * 1.75 + 3.0 * fw) continue;
        float y = -C.y * dx0 + C.x * dy0 - C.z * x * x;
        float wd = A.w;
        float type = floor(B.w / 8.0);
        float round = min(type, 1.0);
        float ns = B.w - 8.0 * type;
        float u = x / hl;
        float sq = sqrt(max(1.0 - u * u, 0.0));
        // streaks: a blunt east head and a frayed western tail; blobs: rounded; arc segments: flat-top cross-fades.
        // Opacity varies along the length.
        float env = type < 0.5 ? smoothstep(-1.15, -0.25, u) * smoothstep(1.05, 0.72, u)
                  : (type < 1.5 ? smoothstep(1.7, 0.25, abs(u)) : (abs(u) < 1.0 ? 0.5 + 0.5 * cos(PI * u) : 0.0));
        env *= mix(0.55 + 0.45 * smoothstep(-0.4, 0.4, vn4(vec3(u * 2.1, B.y, 1.1)).x), 1.0, step(1.5, type));
        // sub-filaments converge and thin toward the ends
        float taper = mix(0.3 + 0.7 * sq, 1.0, round);
        float otaper = (0.65 + 0.35 * sq) * (1.0 - round);
        float wu = C.w;                            // clump length along the flow
        float cs = 0.0, hsum = 0.0;
        for (int jj = 0; jj < uNSub; jj++) {
          float fj = float(jj);
          if (fj >= ns) break;
          float hj = hash11(B.y * 0.71 + fj * 7.13);
          float off = ((fj - 0.5 * (ns - 1.0)) * 1.7 + 0.6 * sin(u * (2.0 + 3.0 * hj) + B.y + fj)) * otaper;
          float wj = mix((0.38 + 0.45 * hj) * taper, 1.0, round);
          float aj = 0.78 + 0.3 * vn4(vec3(u * (1.6 + hj), fj * 3.3, B.y)).x;
          float vv = (y / wd - off) / wj;
          float fv = fw / (wd * wj);
          vec2 rb = ribbon(x / wu + B.z + fj * 4.1, vv, B.y + fj * 2.3, fw / wu, fv);
          cs = screen(cs, aj * rb.x);
          hsum = max(hsum, aj * rb.y);
        }
        // arc segments add up (their windows are a partition of unity); everything else combines like layers
        if (type > 1.5) cArc += B.x * env * cs;
        else c = screen(c, B.x * env * cs);
        halo = max(halo, min(B.x, 1.0) * env * hsum);
      }
      return vec2(screen(c, cArc), halo);
    }

`;
  const prologue = /* glsl */ `
      vec3 p = normalize(vPosL);
      vec3 N = normalize(uRotW * vec3(p.x, p.y / uFlat, p.z));
      vec3 V = normalize(-vPosW);
      vec3 toSun = uSunPosW - vPosW;
      float dSun = length(toSun);
      vec3 L = toSun / dSun;
      float mu0 = dot(N, L);
      float mu = max(dot(N, V), 1e-3);
      float cosT = -dot(L, V);
      // Pixel footprint on the unit sphere, analytic (pixel angle x distance / radius, stretched by 1/mu).
      // fwidth(p) is constant per triangle, so LOD weights built on it jump at every mesh edge; this is continuous.
      float fw = max(vPx * length(vPosW) / uRadius * (0.55 + 0.85 / max(dot(N, V), 0.05)), 1e-6);
      // cloud tops stay sunlit a few degrees past the terminator
      float dip = sqrt(2.0 * uCloudH);
      float lat = asin(clamp(p.y, -1.0, 1.0));
      float lon = atan(-p.z, p.x);
      float tri = sphereShadow(vPosW, L, uSunRadius / dSun, uTritonPosW, uTritonR);
`;
  // deck pass (opaque): banded, wind-advected deck under the methane column plus the Rayleigh gas above it
  const deckFS =
    head +
    deckGLSL +
    /* glsl */ `
    void main() {
${prologue}
      if (mu0 <= 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      Flow F = flowAt(CYC, 0.0);
      vec2 g, e, axes; float tilt;
      gdsFrame(lat, lon, g, e, axes, tilt);
      vec3 dm = deck(p, lat, lon, fw, F, g, e, axes, tilt);
      float m0 = max(mu0, 1e-4);
      float M = 1.0 / m0 + 1.0 / mu;
      // Lambertian deck through the absorption column. In a multiply scattering atmosphere the effective path
      // grows more slowly than the geometric airmass, so the excess airmass saturates (keeps crescents alive)
      float X = M - 2.0;
      float Xe = X / (1.0 + X / 3.2);
      vec3 D = m0 * exp(-uKa * Xe);
      // Rayleigh single scattering in the gas above the deck (Lommel-Seeliger, saturating), normalised to 1 at
      // disc centre and zero phase. Its colour is its own (lambda^-4-like), not the deck's.
      float Pr = (1.0 + cosT * cosT) * 0.5;
      float G = (2.0 * m0 / (m0 + mu)) * Pr * (1.0 - exp(-uKb * M)) / (1.0 - exp(-2.0 * uKb));
      vec3 col = uAlbedo * (1.0 - uGasF) * D * dm + uGasC * G * mix(vec3(1.0), gBand, 0.85);
      if (uDbg == 1) {
        float gl = abs(fract(degrees(lat) / 10.0 + 0.5) - 0.5) * 10.0;
        float go = abs(fract(degrees(lon) / 30.0 + 0.5) - 0.5) * 30.0;
        float px = fw * 57.3;
        col = mix(col, vec3(1.0, 0.1, 0.0), 1.0 - smoothstep(0.0, 1.2 * px, gl));
        col = mix(col, vec3(0.0, 1.0, 0.0), 1.0 - smoothstep(0.0, 1.2 * px, go));
        col = mix(col, vec3(1.0, 1.0, 0.0), 1.0 - smoothstep(0.0, 2.5 * px, abs(degrees(lat))));
        col = mix(col, vec3(1.0, 0.0, 1.0), 1.0 - smoothstep(0.0, 2.5 * px, abs(degrees(lat) + 60.0)));
      }
      gl_FragColor = vec4(col * uSunColor * tri, 1.0);
    }`;

  // cloud pass: the same mesh again, blended out = cloud radiance + deck * (1 - opacity) * shadow
  const cloudFS =
    head +
    ribbonGLSL +
    cloudGLSL +
    /* glsl */ `
    void main() {
${prologue}
      if (mu0 < -dip - 0.01 || uDbg == 2) discard;
      // pass 0: clouds here; pass 1: the cloud field where the sun ray from this deck point crosses the cloud layer
      // (cirrus shadows, offset toward the Sun by h tan z)
      mat3 Ri = transpose(uRotW);
      vec3 Ll = Ri * L;
      vec3 Lt = Ll - p * dot(p, Ll);
      float tz = clamp(length(Lt) / max(mu0, 0.04), 0.0, 25.0);
      bool doShadow = mu0 > 0.0 && tz > 0.05;
      vec3 ps = doShadow ? normalize(p + normalize(Lt) * uShadowH * tz) : p;
      vec2 cloud = vec2(0.0);
      float cshadow = 0.0;
      for (int k = 0; k < uTwo; k++) {
        if (k == 1 && !doShadow) break;
        float la = k == 0 ? lat : asin(clamp(ps.y, -1.0, 1.0));
        float lo = k == 0 ? lon : atan(-ps.z, ps.x);
        vec2 c = clouds(la, lo, k == 0 ? fw : max(fw, uShadowH * 0.08));
        if (k == 0) cloud = c; else cshadow = c.x;
      }
      // the shadow fades in with obliquity (offset) and is strongest on the deck under a dense cloud; it acts on the
      // deck pass below through the blend (dst * alpha)
      float shadow = 1.0 - 0.66 * cshadow * smoothstep(0.08, 0.6, tz);
      if (cloud.x < 1e-4 && cloud.y < 1e-3 && shadow > 0.9999) discard;
      // bright clouds: high methane ice above most of the absorption, their own light path (Lambert / Lommel-Seeliger
      // mix through only the thin gas column above them). The gas above a cloud tints it blue, more at its thin edges,
      // and the core albedo is capped below white.
      float mu0c = (mu0 + dip) / (1.0 + dip);
      float lit = smoothstep(0.0, 0.03, mu0c);
      float mc = max(mu0c, 0.0);
      float cs = 0.5 * mc + 0.5 * 2.0 * mc / (mc + mu + 0.02);
      vec3 deckTint = uAlbedo / max(uAlbedo.b, 1e-3);
      vec3 clAlb = vec3(0.74, 0.83, 0.94) * mix(vec3(1.0), deckTint, mix(0.42, 0.22, cloud.x));
      vec3 cl = clAlb * cs * lit * exp(-0.07 * uKa * (1.0 / max(mc, 0.02) + 1.0 / mu - 2.0));
      cl += uGasC * 0.5 * (2.0 * mc / (mc + mu + 0.02));   // the gas above the cloud still scatters blue
      // light scattered around the cloud in the haze: a soft blue glow over the deck next to it
      vec3 glow = 0.12 * cloud.y * (1.0 - cloud.x) * cl * mix(vec3(1.0), deckTint, 0.55);
      vec3 src = cl * cloud.x + glow;
      float a = (1.0 - cloud.x) * shadow;
      if (uDbg == 4) { src = vec3(cloud.x, cloud.y, 0.0); a = 0.0; }
      gl_FragColor = vec4(src * uSunColor * tri, a);
    }`;

  const deck = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader: deckFS });
  deck.name = 'neptune-deck';
  // clouds: the same geometry drawn again (identical depth), blended out = cloud + deck * (1 - opacity) * shadow
  const clouds = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader: cloudFS,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.SrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  clouds.name = 'neptune-clouds';
  // rebuild the cloud list for time t (days since T0); a pure function of t
  const setTime = (t) => {
    uniforms.uNC.value = cloudList.build(t);
  };
  return { deck, clouds, uniforms, setTime };
}
