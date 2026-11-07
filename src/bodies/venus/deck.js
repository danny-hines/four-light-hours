// Venus — the visible cloud deck (~68 km): an opaque sphere shaded per pixel on the exact analytic sphere.
//
// Photometry: a semi-infinite, almost conservative H2SO4 cloud. Hapke-style radiance factor with
// similarity-scaled Chandrasekhar H functions (multiple scattering) + an explicit HG single-scattering term
// (with the cloud-droplet glory near zero phase). Per-channel single-scattering albedo makes it cream-yellow:
// the "unknown UV absorber" also absorbs a little in the blue, so the UV-dark markings appear as faint
// tan/peach streaks in true colour (as in the Mariner 10 natural-colour frame), at a few per cent contrast.
// Skylight from the sunlit haze above the deck is added as a separate diffuse term: it carries a soft twilight
// a few degrees past the terminator and keeps cloud-top relief from ever reading as hard shadows.
//
// Cloud morphology (procedural, seamless 3D noise on the sphere, filtered by pixel footprint):
//   - zonal-mean structure: absorber-rich low latitudes, dark mid-latitude band, bright polar collar (~60 deg),
//     bright hazy polar hood
//   - the planetary-scale horizontal "Y" (equatorial Kelvin wave + mid-latitude Rossby wave): stem along the
//     equator, arms opening westward toward mid-latitudes; rotates rigidly with the 4-day super-rotation
//   - broad bright arcs spiralling poleward-westward from mid-latitudes into the collar (Mariner 10, PV OCPP)
//   - streaks parallel to the equator, sheared into poleward spirals by the latitude-dependent wind
//     (angular velocity rises ~55 % toward 50 deg), advected and regenerated with a two-phase flow map;
//     broad swirls at planetary scale, streaks at 300-1000 km, isotropic mottling at the km scale
//   - convective cells around the subsolar point (tied to local solar time, not to the clouds) and patches of
//     ~100 km / 35 km / 12 km convective cells: albedo mottling, with only a whisper of relief
//   - gravity-wave trains at high latitude (Venus Express VMC) that resolve only at close range
//   - the night side: the faintest 735 K surface thermal glow leaking through the clouds (Parker Solar Probe
//     WISPR), darker over the cooler highlands
//
// Compile cost (ANGLE -> HLSL -> FXC inlines every call and unrolls constant loops): the planetary scale and the
// coarse streaks come from a CPU-baked texture (venus/bake.js); the per-pixel noise has exactly ONE simplex call
// site (a single "job" loop runs the fine octaves and then the per-scale cell warps) and ONE Worley call site; all
// loop bounds are uniform-dependent so FXC emits real loops.
import { NOISE_GLSL } from '../../glsl/noise.js';
import { VENUS_COMMON_GLSL } from './common.js';
import { NOISE_GRAD_GLSL } from './noise-grad.js';

export function deckShaders({ octaves = 11 } = {}) {
  const vertexShader = /* glsl */ `
    varying vec3 vPos;
    void main() {
      vPos = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;

  const fragmentShader = /* glsl */ `
    precision highp float;
    #define OCT ${octaves}
    ${NOISE_GLSL}
    ${NOISE_GRAD_GLSL}
    ${VENUS_COMMON_GLSL}
    uniform vec3 uCamL;        // camera position, body frame
    uniform vec3 uSunL;        // unit vector to the Sun, body frame
    uniform vec3 uSunColor;
    uniform float uPix;        // radians per pixel
    uniform float uWaveRot;    // rotation of the planetary-scale waves (rad, eastward sample offset = westward drift)
    uniform float uArcRot;     // rotation of the mid-latitude spiral arcs (faster angular velocity)
    uniform vec4 uFlow[2];     // flow-map layers: seed angle, equatorial advection angle (rad), weight, -
    uniform vec3 uSeed[2];
    uniform int uLoop;         // always 1: keeps loops dynamic so ANGLE/FXC does not unroll them (compile time)
    uniform vec3 uOmega;       // cloud single-scattering albedo (RGB)
    uniform float uContrast;   // absorber contrast in the blue
    uniform vec3 uAbsCol;      // spectral shape of the absorber markings (blue absorbed most: pale tan/peach)
    uniform float uGlow;       // night-side thermal glow
    uniform float uStreak;     // streak amplitude in the absorber field
    uniform float uRelief;     // cloud-top relief strength (normal perturbation)
    uniform int uDebug;
    uniform float uCells;      // subsolar convective-cell amplitude
    uniform float uCellRelief; // relief of km-scale convective cloud cells
    uniform float uCellAlb;    // albedo contrast of the km-scale convective cells
    uniform float uSky;        // diffuse skylight from the haze at the terminator (fraction of overhead sun)
    uniform float uGloryGain;  // glory core brightening (relative)
    uniform float uAlbGain;    // photometric calibration of the deck radiance (Mallama et al. 2006 V phase curve)
    uniform float uGloryFade;  // 0..1: how far inside the disc the antisolar point lies (CPU)
    uniform float uFine;      // contrast of the km-scale texture
    uniform float uRidge;      // ridged (filament) share of the 300-30 km octaves
    uniform float uFineBoost;  // extra contrast of well-resolved km-scale octaves
    uniform sampler2D uPlan;   // baked planetary fields (R absorber/wave frame, G arcs/arc frame, B/A coarse streaks)
    uniform float uTexK;       // texels per radian of the bake (its width / 2 pi): mip level from the footprint
    varying vec3 vPos;

    float sq(float x) { return x * x; }
    vec3 sq(vec3 x) { return x * x; }

    // Angular velocity of the cloud-top wind relative to the equator. The zonal wind is ~100 m/s and nearly
    // constant from the equator to ~50 deg, so the angular velocity rises as 1 / cos(lat) (strongest shear at
    // 40-50 deg); poleward of ~50 deg u falls roughly linearly to zero at the pole, i.e. near solid-body rotation of
    // the polar region at ~1.5x the equatorial rate (Venus Express VMC, Khatuntsev et al. 2013). A smooth minimum
    // joins the two. The shear at 30-50 deg winds features into the poleward-westward spiral streaks.
    const float OM_K = 0.05;
    float flowRatio(float y) {
      float c = inversesqrt(max(1.0 - y * y, 1e-4));
      return 1.5 - OM_K * log(1.0 + exp((1.5 - c) / OM_K));
    }
    // |d flowRatio / dy|
    float flowRatioD(float y) {
      float c = inversesqrt(max(1.0 - y * y, 1e-4));
      float sg = 1.0 / (1.0 + exp((c - 1.5) / OM_K));
      return sg * abs(y) * c * c * c;
    }

    // Baked planetary fields at the unit-sphere point p (equirectangular, explicit mip level from the footprint fp
    // in radians: no derivative jump at the longitude seam, no aliasing on a small disc).
    // (lon / lat are computed once per pixel: a rotation about the pole only shifts the longitude)
    vec4 planTex(float lon, float lat, float lod) {
      return textureLod(uPlan, vec2(lon * (0.5 / PI) + 0.5, lat * (1.0 / PI) + 0.5), lod);
    }
    float planLod(float fp) { return max(log2(max(fp * uTexK, 1e-6)), 0.0); }

    // Worley F1 and the offset to the nearest (jittered) centre, dynamic loop (one call site).
    float worleyF1(vec3 p, out vec3 r1) {
      vec3 i = floor(p), f = fract(p);
      float d1 = 8.0;
      r1 = vec3(1.0);
      for (int c = 0; c < 27 * uLoop; c++) {
        // neighbour offset from float math (integer % and / by constants cost FXC far more to compile)
        float fcc = float(c);
        vec3 g = vec3(mod(fcc, 3.0), mod(floor(fcc * (1.0 / 3.0) + 0.01), 3.0), floor(fcc * (1.0 / 9.0) + 0.01)) - 1.0;
        vec3 r = g + 0.1 + 0.8 * hash33(i + g) - f;
        float d = dot(r, r);
        if (d < d1) { d1 = d; r1 = r; }
      }
      return sqrt(d1);
    }

    // Per-octave tables (uniform arrays, filled on the CPU; dynamic indexing of uniforms is cheap for FXC):
    // uOctS: anisotropy (squash of the vertical axis), streaks at 300-1000 km, near-isotropic at the km scale,
    //        with the extra streak anisotropy (uAniso) already folded in;
    // uOctA: albedo amplitude: falls fast at first, slowly after that so close approaches keep revealing texture.
    uniform float uOctS[12];
    uniform float uOctA[12];

    // One advected flow-map layer: streak field (value + analytic gradient for cloud-top relief) and cells.
    struct Layer { float st; float sf; float other; vec3 grad; };
    // fpS / fpL: pixel footprint along the meridional (streak short axis) / zonal direction, unit-sphere units,
    // including the foreshortening of each direction toward the limb
    Layer flowLayer(vec3 n, float lon, float lat, vec4 fl, vec3 seed, int k, float fpS, float fpL) {
      float fpN = max(fpS, fpL);
      Layer o;
      float y = n.y;
      float ay = abs(y);
      // polar vortex: a mild static twist plus a rotating two-lobed (S-shaped dipole) distortion of the flow
      // coordinates, so high-latitude streaks spiral and wobble instead of closing into concentric circles
      float pv = smoothstep(0.74, 0.96, ay);
      float th = atan(n.z, n.x + 1e-9);
      float ang = fl.x + fl.y * flowRatio(y) + 0.2 * pv * sin(2.0 * th + uArcRot) * sign(y);
      vec3 p = rotY(n, ang);
      if (pv > 0.0) {
        float sq2 = 1.0 + 0.22 * pv * cos(2.0 * th - 0.7 * uArcRot + 1.0);
        p = normalize(vec3(p.x * sq2, p.y, p.z * sq2));
      }
      // differential rotation (and the polar twist) compress features north-south as they age: include it in the
      // footprint estimate so sheared octaves fade before they turn into hairlines
      float dAng = fl.y * flowRatioD(y) + pv * 0.6;
      float shearK = sqrt(1.0 + sq(dAng * sqrt(max(1.0 - y * y, 0.0)) / 2.4));
      // Streak anisotropy (zonal squash) tapers to isotropic toward the poles; applied through a monotonic remap of y,
      // Y_i(y) = y + ex_i * G(y) with G' = T, so that dq_y/dy = 1 + ex_i * T(y) exactly (no wood grain).
      const float TA0 = 0.50, TA1 = 0.86;
      float aniT = 1.0 - smoothstep(TA0, TA1, ay);
      float tt = clamp((ay - TA0) / (TA1 - TA0), 0.0, 1.0);
      float aniG = sign(y) * (min(ay, TA0) + (TA1 - TA0) * (tt - tt * tt * tt + 0.5 * tt * tt * tt * tt));
      const float F0 = 2.6;
      vec3 q0 = p * F0 + seed;
      // coarse streaks (planetary scale to ~500 km, the first three octaves): baked, long and coherent, stretched in
      // longitude; each regeneration cycle reuses the bake at a new longitude and/or mirrored across the equator.
      // The other channel of the layer (an independent field) sets the intermittency of the fine texture and cells.
      float flip = seed.x > 0.0 ? 1.0 : -1.0;
      vec4 tx = planTex(lon + ang, lat * flip, planLod(fpN * shearK));
      float coarse = k == 0 ? tx.b : tx.a;
      float other = k == 0 ? tx.a : tx.b;
      float rough = 0.55 + 0.9 * smoothstep(-0.12, 0.15, other);
      float s = 1.19 * coarse, sf = 0.0;
      float f = 8.365, sl = 1.816;            // octave 3: 2.03^3, 1.22^3
      vec3 gq = vec3(0.0);
      // large swirls: the finer octaves are domain-warped by the coarse baked fields (planetary scale, not aligned
      // with the octaves' own gradients, so no marbled "eyes")
      vec3 warp = vec3(0.9 * other, 0.35 * coarse, 0.9 * (coarse - other));
      float vPrev1 = 2.0 * coarse, vPrev2 = 2.0 * other;
      vec3 gp = vec3(0.0);
      for (int i = 3; i < OCT * uLoop; i++) {
        // the extra anisotropy goes to the broad octaves; fine octaves stay near their base anisotropy
        float ex = uOctS[i];
        float Si = 1.0 + ex * aniT;
        // fade each octave out before its short axis drops below ~5 px (no hairline threads, no shimmer)
        float xf = f * F0 * max(fpS * Si * shearK, fpL);
        float w = 1.0 - smoothstep(0.1, 0.26, xf);
        if (w <= 0.0) break;
        vec3 qn = vec3(q0.x + warp.x, q0.y + ex * aniG * F0 + warp.y * Si, q0.z + warp.z) * f + vec3(float(i) * 1.7, float(i) * 9.2, float(i) * 3.1);
        vec3 gi;
        float v = snoiseD(qn, gi);                     // the only simplex call site
        {
          float a = uOctA[i] * rough * (i >= 4 ? 0.35 + 1.3 * smoothstep(-0.55, 0.45, vPrev2) : 1.0);
          // well-resolved fine octaves (> 20 px per period) gain contrast: close approaches keep texture density
          if (i >= 4) a *= 1.0 + uFineBoost * (1.0 - smoothstep(0.012, 0.05, xf));
          vPrev2 = vPrev1;
          vPrev1 = v;
          // 300-30 km octaves: partly ridged (thin bright filaments and lanes instead of Gaussian grain)
          v = mix(v, 1.7 * (0.55 - abs(v)), i <= 4 ? uRidge : min(uRidge + 0.25, 1.0));
          if (i < 4) s += a * w * v; else sf += a * w * v;
          // relief: the 300-30 km octaves (the low-sun ratio in the shading brings them out at the terminator)
          if (i <= 6) gq += (sl * w * (i <= 3 ? 1.0 : 0.6)) * gi * vec3(1.0, Si, 1.0);
          f *= 2.03;
          sl *= 1.22;
        }
      }
      o.other = other;
      o.st = s * (1.0 / 1.9);
      o.sf = sf;
      gp += uRelief * gq * F0;
      o.grad = rotY(gp, -ang);
      return o;
    }

    vec3 hapke(float mu, float mu0, float cosT, float glory) {
      const float g = 0.72;
      vec3 w = uOmega;
      vec3 ws = w * (1.0 - g) / (1.0 - w * g);
      vec3 gam = sqrt(max(1.0 - ws, 0.0));
      vec3 H0 = (1.0 + 2.0 * mu0) / (1.0 + 2.0 * gam * mu0);
      vec3 H = (1.0 + 2.0 * mu) / (1.0 + 2.0 * gam * mu);
      // single scattering: HG(0.72) plus the backscatter rise of the ~1 um droplet Mie phase function (HG misses
      // it); the glory itself is applied separately
      float p = 0.94 * hg(g, cosT) + 0.06 * hg(-0.4, cosT);
      return uAlbGain * (mu0 / (mu0 + mu)) * 0.25 * (w * p + ws * (H0 * H - 1.0));
    }

    // Cloud-droplet glory (r ~ 1.2 um spherical H2SO4 droplets, size parameter ~14 at 550 nm; Venus Express VMC,
    // Markiewicz et al. 2014): a bright core and a first ring centred on the antisolar point, ring radius
    // ~ lambda / r (~7.5-11 deg in the visible, red outside). Returned as a RELATIVE brightening of the deck's own
    // (cream) radiance: in the visible the glory rides on a conservative, multiply scattering cloud, so it is a
    // sheen of the same colour a few per cent strong, not a neutral or rainbow overlay. The higher-order rings
    // are smeared out by the droplet size spread and by multiple scattering: only the core and the first ring
    // survive (window to zero by ~13 deg), and the ring colours are mostly washed out.
    vec3 gloryRings(float alpha) {
      vec3 r1 = vec3(0.190, 0.160, 0.131);     // first ring radius, R G B (scales with wavelength)
      vec3 g = vec3(exp(-sq(alpha / 0.05)));
      g += 0.55 * exp(-sq((alpha - r1) / (0.22 * r1)));
      // (keep pow here: an equivalent ta2*ta2*ta2 form made FXC take 3-5 s on this program, measured)
      g *= exp(-pow(alpha / 0.21, 6.0));
      return mix(vec3(dot(g, vec3(0.3, 0.5, 0.2))), g, 0.4);
    }

    void main() {
      vec3 ro = uCamL;
      vec3 rd = normalize(vPos - ro);
      float tc = -dot(ro, rd);
      vec3 pcl = ro + rd * tc;
      float hh = uRd * uRd - dot(pcl, pcl);
      float t = tc - sqrt(max(hh, 0.0));
      vec3 P = ro + rd * t;
      vec3 n = normalize(P);
      vec3 v = -rd;
      float mu = clamp(dot(n, v), 1e-3, 1.0);
      float mu0 = dot(n, uSunL);
      float cosT = -dot(uSunL, v);            // scattering angle cosine (1 = forward)
      float y = n.y;
      float lat = asin(clamp(y, -1.0, 1.0));

      // pixel footprint on the unit sphere (slightly anisotropic toward the limb)
      float fp0 = max(t, 1e-6) * uPix / uRd;
      // local north / east tangents; the screen footprint along a tangent T grows as 1 / sqrt(1 - (T.v)^2)
      vec3 Nt = vec3(0.0, 1.0, 0.0) - y * n;
      float nl = length(Nt);
      Nt = nl > 1e-4 ? Nt / nl : vec3(1.0, 0.0, 0.0);
      vec3 Et = cross(Nt, n);
      float fpS = fp0 * inversesqrt(max(1.0 - sq(dot(Nt, v)), 1e-3));
      float fpL = fp0 * inversesqrt(max(1.0 - sq(dot(Et, v)), 1e-3));
      float fpN = max(fpS, fpL);

      // diffuse skylight from the sunlit haze: ~uSky of the overhead sun near the terminator, decaying with
      // e-folding ~4.5 deg of solar zenith angle beyond it (the haze above stays sunlit a little longer)
      float chi = acos(clamp(mu0, -1.0, 1.0));
      float esky = uSky * exp(-max(chi - 0.5 * PI, 0.0) / 0.08);

      // ---------------- cloud field (absorber amount, ~zero mean) and cloud-top relief (day side + twilight band)
      vec3 col = vec3(0.0);
      float aPlan = 0.0, st = 0.0, sf = 0.0, cells = 0.0, a = 0.3, aN = 0.0, midlat = 1.0, calb = 0.0, oth = 0.0;
      float mu0b = mu0;
      vec3 L = vec3(0.0);
      if (mu0 > -0.3 || uDebug > 0) {
        vec3 nw = rotY(n, uWaveRot);
        vec3 na = rotY(n, uArcRot);
        float lonN = atan(-n.z, n.x);
        float lodN = planLod(fpN);
        a = planTex(lonN + uWaveRot, lat, lodN).r + planTex(lonN + uArcRot, lat, lodN).g;
        aPlan = a;
        float conv = uCells * smoothstep(0.62, 0.97, dot(n, uSunL)) * (1.0 - smoothstep(0.4, 0.7, abs(y)));
        vec3 grad = vec3(0.0);
        float w2 = 0.0;
        for (int k = 0; k < 2 * uLoop; k++) {
          vec4 fl = uFlow[k];
          if (fl.z < 1e-3) continue;          // a layer at the very start/end of its cycle contributes nothing
          Layer lk = flowLayer(n, lonN, lat, fl, uSeed[k], k, fpS, fpL);
          st += lk.st * fl.z;
          sf += lk.sf * fl.z;
          oth += lk.other * fl.z;
          grad += lk.grad * fl.z;
          w2 += fl.z * fl.z;
        }
        float nrm = inversesqrt(max(w2, 1e-6));   // variance-preserving cross-fade
        st *= nrm;
        sf *= nrm;
        oth *= nrm;
        grad *= nrm;
        // cloud cells, once per pixel in the wave frame (they live hours, not the days of the flow-map cycle):
        // subsolar convection (~380 and ~150 km, masked in local solar time) and patches of finer cells (~60 / 22 /
        // 8 km), resolved only up close: soft domed bright cores with broad gentle lanes (no dark crack lines),
        // irregular lumpy outlines (a cheap analytic warp), a whisper of relief
        {
          const float Sc = 1.6;
          float mPatch = (1.0 - 0.6 * smoothstep(0.55, 0.85, abs(y))) * smoothstep(-0.1, 0.12, oth);
          float fc = 16.0, amp = 1.0;
          vec3 gp = vec3(0.0);
          for (int j = 0; j < 5 * uLoop; j++) {
            float fpc = fpN * fc * Sc;                   // pixel footprint in cell units
            float w = 1.0 - smoothstep(0.02, 0.06, fpc); // cells fade in once they are > ~20-50 px across
            if (w <= 0.0) break;
            vec3 Mc = vec3(fc, fc * Sc, fc);
            vec3 pc = nw * Mc + vec3(17.3, -4.1, 9.7) * float(j + 1);
            pc += 0.22 * sin(pc.zxy * 0.71 + 1.7 * sin(pc.yzx * 0.37 + 0.9));
            vec3 r1;
            float F1 = worleyF1(pc, r1);                 // the only Worley call site
            float core = 1.0 - smoothstep(0.0, 0.62, F1);
            float mj = j < 2 ? conv : mPatch;
            float c = amp * w * mj * (core - 0.45);
            if (j < 2) cells -= c; else calb += c;      // (cells in absorber units: + = darker)
            // relief: dome height = core; d core / d pc = smoothstep'(F1) * r1 / F1 (r1 points to the centre)
            float t2 = clamp(F1 / 0.62, 0.0, 1.0);
            gp += (uCellRelief * amp * w * mj * 6.0 * t2 * (1.0 - t2) / 0.62 * 60.0 / fc) * (r1 / max(F1, 1e-4)) * Mc;
            fc *= 2.6;
            amp *= 0.8;
          }
          grad += rotY(gp, -uWaveRot);
        }
        // streaks strongest at mid-latitudes, fading into the smooth polar hood
        midlat = (0.55 + 0.6 * smoothstep(0.25, 0.75, abs(y))) * (1.0 - 0.7 * smoothstep(0.84, 0.95, abs(y)));
        // km-scale texture (filaments, mottling, thin veils) keeps its own contrast so close approaches resolve detail
        // streaks are mostly optical-thickness (brightness) variations of the cloud: neutral, bright-skewed (the
        // white streaks of the Mariner 10 frame); only a third of their amplitude carries the tan absorber colour
        a += 0.35 * uStreak * st * midlat + 0.9 * cells;
        // fine texture and cells are mostly cloud optical-thickness variations: near-neutral in colour
        aN = 0.65 * uStreak * st * midlat + uFine * sf * (0.35 + 0.65 * midlat) - uCellAlb * calb;
        vec3 gt = grad - dot(grad, n) * n;
        vec3 nb = normalize(n - gt);

        // ---------------- photometry
        mu0b = dot(nb, uSunL);
        float alpha = acos(clamp(dot(uSunL, v), -1.0, 1.0));   // local phase angle
        // (washed out toward the limb, where the slant path through the overlying haze is long; uGloryFade is 0
        // unless the antisolar point itself lies well inside the disc, so the glory is never a partial arc)
        vec3 glory = alpha < 0.3 && uGloryFade > 0.0 ? (uGloryGain * uGloryFade * smoothstep(0.2, 0.6, mu)) * gloryRings(alpha) : vec3(0.0);
        float m0 = max(mu0, 0.0);
        // direct sunlight on the smooth sphere (keeps the large-scale terminator exact)
        L = hapke(mu, m0, cosT, 0.0) * smoothstep(0.0, 0.03, mu0 + 0.02);
        // soft relief: the tau = 1 level of the cloud top is spread over kilometres and partly lit by the sky,
        // so slopes modulate brightness as a ratio, softened toward the terminator and bounded
        // (the same slopes shade more strongly at low sun: the ratio grows as ~1 / mu0, which is why cloud-top
        // structure stands out toward the terminator; the 0.07 softening stands for the diffuse light of the sky)
        float rel = (mu0b - mu0) / (m0 + 0.07);
        rel *= smoothstep(-0.02, 0.08, mu0);
        L *= clamp(1.0 + rel, 0.85, 1.15);
        // glory: a backscatter sheen of the droplet Mie phase function, in the deck's own colour
        L *= 1.0 + glory;
      }
      // skylight (diffuse, unaffected by the relief): a twilight band past the terminator, warmed by long
      // slant paths through the haze (beyond mu0 = -0.3 it is < 7e-4 and drawn without markings)
      L += esky * vec3(0.84, 0.75, 0.56) * (0.6 + 0.4 * mu);
      if (esky > 1e-6 || mu0 > -0.3) {
        // extra slant path through the haze toward a low Sun warms the terminator zone a little
        float pol = polarHaze(y);
        vec3 ts = exp(-0.5 * (tauToSun(uRd, max(mu0, 0.02), pol) - tauToSun(uRd, 1.0, pol)));
        // UV absorber: strongest in the blue, so markings read faint tan in true colour
        // (markings gain a little contrast at low sun: the light no longer reaches the deeper, absorber-poor
        // cloud, so the reflected light samples the absorber-laden cloud top)
        float cK = uContrast * (1.0 + 0.4 * (1.0 - smoothstep(0.05, 0.5, mu0)));
        // (absorption is multiplicative, exp(-k a): strong markings saturate softly instead of losing all blue)
        // (absorber-poor cloud - the bright collar, white streaks - is whiter, not bluer: below the zero point the
        // term turns neutral)
        float da = a - 0.4;
        vec3 tint = exp(-cK * (max(da, 0.0) * uAbsCol + min(da, 0.0) * vec3(0.7, 0.72, 0.76) + aN * vec3(0.79, 0.8, 0.83)));
        col = L * ts * tint * uSunColor;
      }
      // night side: 735 K surface glow through the clouds, darker over cool highlands (surface-fixed frame)
      float night = smoothstep(0.02, -0.2, mu0);
      if (night > 0.0 && uGlow > 0.0) {
        // emission is blurred by ~100 km of scattering in the cloud layers: only large-scale terrain shows
        vec4 tg = planTex(atan(-n.z, n.x), lat, planLod(0.08));
        float topo = 2.2 * tg.b + 1.2 * tg.a + 0.5 * exp(-sq(lat / 0.18)) * smoothstep(-0.1, 0.15, tg.a);
        float temp = 0.8 - 0.3 * smoothstep(0.0, 0.7, topo);
        col += uGlow * night * temp * vec3(1.0, 0.09, 0.012);
      }
      // (debug view: vdbg=plan shows the baked planetary absorber field; the other wave-1 debug views were removed
      // to keep the program small for the D3D compiler)
      if (uDebug == 3) col = vec3(0.02 + 0.5 * clamp(aPlan + 0.4, 0.0, 2.0));
      gl_FragColor = vec4(col, 1.0);
    }`;
  return { vertexShader, fragmentShader };
}
