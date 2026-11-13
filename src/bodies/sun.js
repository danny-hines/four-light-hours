// The Sun, true scale (R = 109.2 scene units = 695,700 km).
//
// Layers (all in the Sun's rotating body frame, inside `rotor`):
//   photosphere  opaque sphere; analytic per-pixel ray/sphere surface, Hopf/Eddington-Barbier limb darkening
//                with a per-channel Planck colour, animated granulation (footprint LOD), network, faculae,
//                sunspots with filamentary penumbrae and the Wilson depression  -> src/bodies/sun/photosphere.glsl.js
//   corona       one BackSide shell integrated along each ray: K-corona (streamers, rays, polar plumes),
//                F-corona, chromosphere + spicules                              -> src/bodies/sun/corona.glsl.js
//   prominences  ray-marched boxes, emission + absorption (glow off-limb, dark filaments on the disc)
//                                                                               -> src/bodies/sun/prominence.glsl.js
//   point        screen-space Gaussian that takes over the disc's flux when it is < ~2.5 px wide
//                                                                               -> src/bodies/sun/point.glsl.js
// Radiance: disc centre = DISC_RADIANCE (linear HDR). See notes/sun.md for exposures per shot.
// Optional director control: shot.sunCorona (corona gain, default 1), shot.sunProminence (default 1).
import * as THREE from 'three';
import { bodyQuaternion, daysSinceJ2000, DEG } from '../core/astro.js';
import { SPOTS, PLAGES, PROMINENCES, STREAMERS, diffRotationOffsetDeg, dirFromLatLon } from './sun/features.js';
import { PHOTO_VERT, PHOTO_FRAG, NSPOT, NPLAGE } from './sun/photosphere.glsl.js';
import { CORONA_VERT, CORONA_FRAG, NOISE_BAKE_FRAG } from './sun/corona.glsl.js';
import { PROM_VERT, PROM_FRAG, NSTRAND } from './sun/prominence.glsl.js';
import { POINT_VERT, POINT_FRAG } from './sun/point.glsl.js';
import { sunNoiseTexture } from './sun/noisetex.js';

export const DISC_RADIANCE = 3000; // linear radiance at disc centre (luminance)
const QS = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams('');
const WB = QS.get('sunwb'); // dev: test disc-centre white balances
// Disc-centre colour: a warm photographic white (as through a neutral white-light solar filter on daylight-balanced
// film). The limb then turns orange-red by itself: the Planck ratios of the cooler layers seen there (see
// photosphere.glsl.js), with their chroma exaggerated like a contrasty photograph (CHROMA).
const DISC_CENTRE = WB ? new THREE.Color(...WB.split(',').map(Number)) : new THREE.Color(1.0, 0.7, 0.36);
const CHROMA = QS.has('sunchroma') ? Number(QS.get('sunchroma')) : 1.6;
// HERO LOOK. In shots exposed for the Sun itself, post composites the disc at its own exposure behind an orange
// "solar filter" with a log contrast and a per-channel tone curve (post.js HERO; constants mirrored in POST_HERO).
// Left alone that renders the HMI-intensitygram look: an evenly orange disc. The film wants a star: so the
// photosphere is authored display-referred. The colour that should reach the tone curve is a per-channel power
// ramp of the luminance signal L (1 = quiet disc centre): D_c(L) = LOOK_A[c] * L^LOOK_P[c]
//   L 1.0  (centre)        -> (8, 1.7, .40)   white-gold   sRGB ~(255, 240, 183)
//   L 0.83 (r = 0.7)       -> (4.8, .79, .13) gold              ~(255, 215, 115)
//   L 0.66 (r = 0.9)       -> (2.5, .31, .035) orange           ~(247, 170, 45)
//   L 0.47 (limb)          -> (1.0, .08, .005) deep orange-red  ~(225, 90, 2)
//   L 0.15 (umbra)         -> (.04, 0, 0)     near black
// and sun.js inverts post's chain (filter, exposure, log contrast about the pivot) to get the scene radiance.
// The far-field point, planet lighting and planet-exposed views keep the physical radiance. dev: ?sunlook=Ar,Ag,Ab,Pr,Pg,Pb
const POST_HERO = { discRGB: [4059, 2841, 1461], filter: [1.0, 0.22, 0.022], target: 2.4, gamma: 1.4 };
const LOOK = QS.has('sunlook') ? QS.get('sunlook').split(',').map(Number) : [8, 1.6, 0.3, 2.75, 4.0, 5.6];
// granulation-scale fluctuations ride the same ramp with this exponent on their luminance ratio. dev: ?sunhks=x
const HERO_SMALL = QS.has('sunhks') ? Number(QS.get('sunhks')) : 0.8;
// close views (the skim): the disc is exposed down the ramp, so the plain is a rich gold and only the granule
// centres and faculae reach white-gold. dev: ?sunhx=x
const HERO_CLOSE_EXP = QS.has('sunhx') ? Number(QS.get('sunhx').split(',')[0]) : 0.76;
const HERO_CLOSE_K = QS.has('sunhx') ? Number(QS.get('sunhx').split(',')[1] ?? 0.65) : 0.65;
const REF_DAYS = daysSinceJ2000(new Date('2026-11-02T12:00:00Z')); // rotation-phase reference (see features.js)
const SHELL_R = 22; // corona shell radius (solar radii)
const CHROMO_R = 1.0185; // chromosphere shell radius (solar radii; must match RC in corona.glsl.js)
const CORONA_EXPOSURE = 0.002; // exposure of the wide (corona) shots; below it the corona's gain follows the exposure (see update)
const CORV = QS.has('suncor') ? QS.get('suncor').split(',').map(Number) : [];
const CRAY = QS.has('sunray') ? QS.get('sunray').split(',').map(Number) : []; // dev: ray-texture amplitudes
const CORONA_DISC = CORV[0] ?? 0.8; // corona level in disc-exposed shots, relative to the wide (corona-exposed) shots
const CORONA_CLOSE = CORV[1] ?? 0.45; // corona gain in the close views (the skim)
const SKY_LIFT = QS.has('sunsky') ? Number(QS.get('sunsky')) : 0.4; // height-graded sky of the close views (skim). dev: ?sunsky=x
const WILSON_DEPTH = 600 / 695700; // umbral depression, in solar radii
// dev only: ?sundebug=<n> switches the photosphere to a diagnostic output
const DEFS = QS.get('sundefs'); // dev: shader experiments
const DEBUG = Number(QS.get('sundebug') || 0);
// (?sundebug=n also becomes #define SUN_DEBUGn, so the shader diagnostics cost nothing otherwise)
const DEVDEFS = (DEFS ? DEFS.split(',').map((d) => `#define ${d} 1\n`).join('') : '') + (DEBUG ? `#define SUN_DEBUG${DEBUG} 1\n` : '');
const DEVPRAGMA = QS.has('sunpragma') ? '#pragma optimize(off)\n' : ''; // dev: compile-time experiment
const PROM_ONLY = QS.has('sunprom') ? QS.get('sunprom').split(',').map(Number) : null; // dev: show only these prominences
// Prominence emission. The H-alpha source function is display-graded like an eclipse photograph: the saturated
// (optically thick) plasma lands on PROM_DISP of linear display radiance at the shot's exposure (well below the
// tone curve's shoulder, so it stays eclipse red instead of bleaching to pink), capped at PROM_EMIT x the disc.
// The optically thin lines are soft-clipped at PROM_THIN_SAT x the thick level (pale-pink cores, never white).
// Opacity per unit column. dev: ?sunpe=disp,thinSat,kappa,kappaHedge,thinHedge
const PE = QS.has('sunpe') ? QS.get('sunpe').split(',').map(Number) : [];
const PROM_DISP = PE[0] ?? 0.38;
const PROM_THIN_SAT = PE[1] ?? 0.14;
const PROM_KAPPA = PE[2] ?? 0.35;
const PROM_KAPPA_HEDGE = PE[3] ?? 0.3;
const PROM_THIN_HEDGE = PE[4] ?? 0.6;
const PROM_EMIT = 1.0;
const PROM_THIN_K = 4.0; // knee of the thin-line soft clip (emission-measure units)

// small deterministic PRNG
function rng(seed) {
  let s = Math.floor(seed * 1e6) % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
// standard normal deviate from a uniform generator (Box-Muller)
function gauss(rnd) {
  return Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(6.283185307 * rnd());
}

// Disc-centre colour normalised to unit luminance, and the disc-integrated luminance relative to the centre
// (limb darkening of the grey Hopf atmosphere, Planck ratio per channel; the chroma exponent leaves luminance alone).
function discCentreColor(centre) {
  const lam = [0.61, 0.55, 0.465], C2 = 14388, TEFF = 5772, W = [0.2126, 0.7152, 0.0722];
  const T = (mu) => TEFF * Math.pow(0.75 * (mu + 0.7104 - 0.1331 * Math.exp(-3.4488 * mu)), 0.25);
  const B = (l, t) => 1 / (Math.exp(C2 / (l * t)) - 1);
  let meanLum = 0;
  const n = 400;
  for (let i = 0; i < n; i++) {
    const mu = (i + 0.5) / n;
    let Y = 0;
    lam.forEach((l, k) => (Y += W[k] * (B(l, T(mu)) / B(l, T(1)))));
    meanLum += (2 * mu * Y) / n;
  }
  const c = centre.clone();
  const lum = W[0] * c.r + W[1] * c.g + W[2] * c.b;
  c.multiplyScalar(1 / lum);
  return { color: c, meanRatio: meanLum };
}

export async function create(ctx) {
  const { U, data, epochDays } = ctx;
  const heroA = new THREE.Vector3(), heroP = new THREE.Vector3();
  const R = data.radius;
  const object = new THREE.Group();
  object.name = 'sun';
  const rotor = new THREE.Group();
  rotor.name = 'sun-rotor';
  object.add(rotor);

  // (Sunlight on the planets uses U.uSunColor; the disc itself is only ever seen through a solar-grade exposure.)
  // hero look -> scene radiance per channel: out_c = pivot_c (D_c / pivot_c)^(1/gamma) / (filter_c k)
  {
    const H = POST_HERO, k = H.target / (H.discRGB[0] * H.filter[0]);
    const A = [0, 1, 2].map((c) => {
      const pivot = (H.target * H.discRGB[c] * H.filter[c]) / (H.discRGB[0] * H.filter[0]);
      return (pivot * Math.pow(LOOK[c] / pivot, 1 / H.gamma)) / (H.filter[c] * k);
    });
    heroA.set(A[0], A[1], A[2]);
    heroP.set(LOOK[3] / H.gamma, LOOK[4] / H.gamma, LOOK[5] / H.gamma);
  }
  const { color: discColor, meanRatio } = discCentreColor(DISC_CENTRE);

  // shared uniforms (objects shared between materials, mutated each frame)
  const S = {
    uTime: U.uTime,
    uCamLocal: { value: new THREE.Vector3() },
    uR: { value: R },
    uGain: { value: DISC_RADIANCE },
    uDiscColor: { value: discColor },
    uPixAngle: { value: 1e-3 },
    uDiscFade: { value: 1 },
    uFade: { value: 1 },
    uDebug: { value: DEBUG },
    uHeroW: { value: 0 }, // hero weight (the shot is exposed for the Sun)
    uHeroA: { value: new THREE.Vector3(1, 1, 1) }, // hero look, inverted through post's chain (see HERO LOOK)
    uHeroP: { value: new THREE.Vector3(1, 1, 1) },
    uHeroX: { value: new THREE.Vector2(1, 1) },
    uHeroS: { value: new THREE.Vector4(1, HERO_SMALL, 1, 1.3) }, // signal exposure, small-scale exponent, plage, ceiling
    uNoise3: { value: sunNoiseTexture() }, // shared band-limited noise volume (noisetex.js)
  };

  // ---------------------------------------------------------------- photosphere
  const spotA = Array.from({ length: NSPOT }, () => new THREE.Vector4(0, 0, 0, 0));
  const spotB = Array.from({ length: NSPOT }, () => new THREE.Vector4(0, 0, 0, 0));
  const plage = Array.from({ length: NPLAGE }, () => new THREE.Vector4(0, 0, 0, 0));
  const plageS = new Array(NPLAGE).fill(0);
  // all spots, largest first (if more than NSPOT are on the visible hemisphere, the smallest are dropped)
  const spotList = SPOTS.map((s) => ({
    ...s,
    dir: new THREE.Vector3(),
    reach: (Math.max(s.rp * 1.55 + s.ru * 0.5, s.ru * 2.6) + 0.3) * DEG,
    // y packs the umbral core count (integer part) and a seed (fraction)
    b: new THREE.Vector4(s.ru * DEG, s.cores + 0.02 + 0.96 * s.seed, s.rp > 0 ? WILSON_DEPTH * (s.depth ?? 0.8) : 0, s.one ?? 0),
  })).sort((a, b) => Math.max(b.rp, b.ru) - Math.max(a.rp, a.ru));
  PLAGES.slice(0, NPLAGE).forEach((p, i) => {
    plage[i].w = p.r * DEG;
    plageS[i] = p.s;
  });

  const photoMat = new THREE.ShaderMaterial({
    name: 'sun-photosphere',
    uniforms: {
      ...S,
      uSpotA: { value: spotA },
      uSpotB: { value: spotB },
      uNSpot: { value: 0 },
      uPlage: { value: plage },
      uPlageS: { value: plageS },
      uNPlage: { value: Math.min(NPLAGE, PLAGES.length) },
      uCellN: { value: 27 },
      uFilN: { value: 6 },
      uCores: { value: 3 },
      uChroma: { value: CHROMA },
    },
    vertexShader: PHOTO_VERT,
    fragmentShader: DEVDEFS + PHOTO_FRAG,
  });
  const photo = new THREE.Mesh(new THREE.SphereGeometry(R, 288, 144), photoMat);
  photo.name = 'sun-photosphere';
  rotor.add(photo);

  // ---------------------------------------------------------------- corona noise cubemap (baked once)
  // The corona's fine structure is a function of direction only (it projects to radial rays), so it is
  // rendered once into a mipmapped cubemap: one texture fetch per ray sample instead of several noises.
  const noiseRT = new THREE.WebGLCubeRenderTarget(ctx.quality === 'low' ? 256 : 512, {
    type: THREE.UnsignedByteType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  noiseRT.texture.colorSpace = THREE.NoColorSpace;
  {
    const bakeScene = new THREE.Scene();
    const bakeMat = new THREE.ShaderMaterial({ vertexShader: CORONA_VERT, fragmentShader: NOISE_BAKE_FRAG, side: THREE.BackSide, depthTest: false, depthWrite: false });
    bakeScene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), bakeMat));
    const cubeCam = new THREE.CubeCamera(0.1, 10, noiseRT);
    const prevTarget = ctx.renderer.getRenderTarget();
    cubeCam.update(ctx.renderer, bakeScene);
    ctx.renderer.setRenderTarget(prevTarget);
    bakeMat.dispose();
  }

  // ---------------------------------------------------------------- corona + chromosphere shell
  const eclN = new THREE.Vector3(0, 1, 0);
  const tmpS = new THREE.Vector3();
  const arDirs = Array.from({ length: 10 }, () => new THREE.Vector4(0, 0, 0, 0));
  const strA = Array.from({ length: 10 }, () => new THREE.Vector4(0, 0, 0, 0));
  const strB = Array.from({ length: 10 }, () => new THREE.Vector4(0.1, 2, 0.03, 0));
  STREAMERS.slice(0, 10).forEach((st, i) => {
    dirFromLatLon(st.lat, st.lon, tmpS);
    strA[i].set(tmpS.x, tmpS.y, tmpS.z, st.s);
    strB[i].set(st.bw * DEG, st.rc, st.sw * DEG, st.cav);
  });
  const coronaUniforms = {
    ...S,
    uShellR: { value: SHELL_R },
    uCorona: { value: 1 },
    uChromo: { value: 1 },
    uEclN: { value: eclN },
    uAR: { value: arDirs },
    uStrA: { value: strA },
    uStrB: { value: strB },
    uNoiseCube: { value: noiseRT.texture },
    uSamples: { value: ctx.quality === 'low' ? 16 : ctx.quality === 'med' ? 20 : 24 },
    uNAr: { value: 10 },
    uNStrU: { value: 10 },
    uSpicN: { value: 20 },
    uKCol: { value: new THREE.Color(1.0, 0.98, 0.95) },
    uKColIn: { value: new THREE.Color(1.0, 0.9, 0.74) },
    uRay: { value: new THREE.Vector4(CRAY[0] ?? 0.45, CRAY[1] ?? 0.75, CRAY[2] ?? 0.95, CRAY[3] ?? 0.15) },
    uPostG: { value: 1 },
    uCorK: { value: new THREE.Vector4(CORV[2] ?? 0.5, CORV[3] ?? 1.3, CORV[4] ?? 0.35, CORV[5] ?? -1.5) },
    uSkyLift: { value: 0 },
    uCubeLod0: { value: Math.log2((ctx.quality === 'low' ? 256 : 512) / (Math.PI / 2)) },
    uInside: { value: 0 },
  };
  const defs = DEVDEFS;
  const shellMaterial = (name, extra) => new THREE.ShaderMaterial({
    name,
    uniforms: coronaUniforms,
    vertexShader: CORONA_VERT,
    fragmentShader: extra + defs + CORONA_FRAG,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const coronaMat = shellMaterial('sun-corona', '');
  const shell = new THREE.Mesh(new THREE.SphereGeometry(SHELL_R * R, 96, 48), coronaMat);
  shell.name = 'sun-corona';
  rotor.add(shell);
  // chromosphere + spicules: same shader with CHROMO_PASS on a thin shell (finely tessellated: its silhouette
  // bounds the spicule forest at the limb), so only the limb ring pays for it
  const chromoMat = shellMaterial('sun-chromosphere', '#define CHROMO_PASS 1\n');
  chromoMat.uniforms = { ...coronaUniforms, uChromo: { value: 1 }, uInside: { value: 0 } };
  // both faces, one program: the shader keeps the front faces (camera outside the shell) or the back faces (inside)
  chromoMat.side = THREE.DoubleSide;
  const chromo = new THREE.Mesh(new THREE.SphereGeometry(CHROMO_R * R, 320, 160), chromoMat);
  chromo.name = 'sun-chromosphere';
  rotor.add(chromo);

  // ---------------------------------------------------------------- prominences
  const proms = [];
  // loop bounds as uniforms (FXC compiles real loops instead of unrolling them)
  const PROM_LOOPS = {
    nc: { value: 12 },
    newton: { value: 2 },
    three: { value: 3 },
    thread: { value: 14 },
    hedge: { value: ctx.quality === 'low' ? 6 : 9 },
  };
  PROMINENCES.forEach((P, idx) => {
    const rnd = rng(P.seed * 1.37 + idx * 0.11 + 0.5);
    const up = dirFromLatLon(P.lat, P.lon, new THREE.Vector3());
    const lo = P.lon * DEG;
    const east = new THREE.Vector3(-Math.sin(lo), 0, -Math.cos(lo));
    const north = new THREE.Vector3().crossVectors(up, east);
    const X = north.clone().multiplyScalar(Math.cos(P.az * DEG)).addScaledVector(east, Math.sin(P.az * DEG)).normalize();
    const Y = up.clone();
    const Z = new THREE.Vector3().crossVectors(X, Y).normalize();
    const origin = up.clone().multiplyScalar(R);
    const type = P.type === 'arch' ? 0 : P.type === 'hedge' ? 1 : 2;

    const strandA = Array.from({ length: NSTRAND }, () => new THREE.Vector4());
    const strandB = Array.from({ length: NSTRAND }, () => new THREE.Vector4());
    const strandC = Array.from({ length: NSTRAND }, () => new THREE.Vector4());
    const strandD = Array.from({ length: NSTRAND }, () => new THREE.Vector4());
    let nStrand = 0;
    const bmin = new THREE.Vector3(1e9, 1e9, 1e9), bmax = new THREE.Vector3(-1e9, -1e9, -1e9);
    if (type !== 1) {
      // flux-rope strands: irregular inverted-U curves with both legs anchored (see strandPlane in the shader)
      nStrand = Math.min(NSTRAND, P.strands || 6);
      const er = type === 2;
      // 'arch': one flux rope, a bundle of strands of similar span braided around each other (their wobbles
      // differ), splaying apart at the feet; 'erupt': a taller, more twisted and more dishevelled bundle.
      // P.loops > 0 instead nests the strands (a loop system of different spans and heights).
      const nest = P.loops ?? 0;
      // asymmetric arches: one leg denser and fatter than the other (the whole bundle shares the sense)
      const asym = P.asym ?? (rnd() - 0.5) * 1.1;
      for (let k = 0; k < nStrand; k++) {
        const s = {
          Lk: P.L * (nest ? 0.45 + 0.55 * rnd() : 0.8 + 0.2 * rnd()),
          Hk: P.H * (nest ? 0.45 + 0.55 * rnd() : er ? 0.75 + 0.25 * rnd() : 0.78 + 0.22 * rnd()),
          tilt: (rnd() - 0.5) * (er ? 0.4 : 0.3),
          zoff: (rnd() - 0.5) * P.W * 1.1,
          width: P.W * (nest ? 0.12 + 0.1 * rnd() : er ? 0.18 + 0.2 * rnd() : 0.17 + 0.2 * rnd()),
          // lognormal brightness per strand (sigma ~0.8, mean ~1): a few dominate, most are faint
          dens: Math.min(4.5, Math.max(0.08, Math.exp(1.05 * gauss(rnd) - 0.3))),
          phase: rnd() * 6.283,
          skew: (rnd() - 0.5) * 0.3 + (P.lean ?? 0),
          twist: (rnd() - 0.5) * (er ? 8 : 5),
          footX: (rnd() - 0.5) * P.L * 0.35,
          footZ: (rnd() - 0.5) * P.W * 1.4,
          asym: Math.max(-0.85, Math.min(0.85, asym + (rnd() - 0.5) * 0.35)),
          // the apex sags (Kippenhahn-Schlueter dip), more in some strands than others
          dip: (P.dip ?? (er ? 0.1 : 0.14)) * (0.5 + rnd()),
        };
        s.ce = 0.12 * s.Hk + 0.4;
        // bounds from the exact curve (same formula as the shader), padded by the rope's Gaussian reach
        const thLo = Math.asin(Math.min(0.99, s.ce / (s.Hk + s.ce))) - 0.32, thHi = Math.PI - thLo;
        const ct = Math.cos(s.tilt), st = Math.sin(s.tilt);
        let yMin = 1e9, yMax = -1e9;
        const pts = [];
        const sstep = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
        for (let i = 0; i <= 96; i++) {
          const th = thLo + ((thHi - thLo) * i) / 96;
          const c = Math.cos(th), sn = Math.sin(th), ph = s.phase;
          const del = s.width * 0.85 * Math.sin(4.3 * th + ph) * Math.sin(1.7 * th + 2.3 * ph) + s.Hk * 0.06 * Math.sin(2.2 * th + 1.3 * ph);
          const dq = th - Math.PI / 2;
          const Yp = -s.ce + (s.Hk + s.ce) * sn + del * sn - s.dip * s.Hk * Math.exp(-4 * dq * dq);
          let foot = 1 - sstep(-0.1 * s.Hk, 0.55 * s.Hk, Yp);
          foot *= foot;
          const Xp = (s.Lk + del) * c + s.skew * Math.max(Yp, 0) + s.footX * foot * Math.sign(c);
          const za = s.zoff + s.width * 1.1 * Math.sin(3.1 * th + 1.3 * ph) * Math.sin(2.2 * th + 0.7 * ph) + P.W * 0.3 * Math.sin(1.4 * th + 2 * ph) + s.footZ * foot * Math.sign(c);
          pts.push([Xp, Yp, za]);
          yMin = Math.min(yMin, Yp);
          yMax = Math.max(yMax, Yp);
        }
        // (the diffuse envelope reaches sqrt(5) x 2.6 x the widest rope radius, 1.4 x width)
        const pad = 10.2 * s.width + 0.2;
        const yc = 0.5 * (yMin + yMax);
        let rad = 0;
        for (const [Xp, Yp, za] of pts) {
          rad = Math.max(rad, Math.hypot(Xp, Yp - yc, za - s.zoff));
          const p3 = [Xp, Yp * ct - za * st, Yp * st + za * ct];
          bmin.set(Math.min(bmin.x, p3[0] - pad), Math.min(bmin.y, p3[1] - pad), Math.min(bmin.z, p3[2] - pad));
          bmax.set(Math.max(bmax.x, p3[0] + pad), Math.max(bmax.y, p3[1] + pad), Math.max(bmax.z, p3[2] + pad));
        }
        strandA[k].set(s.Lk, s.Hk, s.ce, s.tilt);
        strandB[k].set(s.width, s.dens, s.zoff, s.phase);
        strandC[k].set(s.skew, s.twist, yc, rad + pad + 0.3);
        strandD[k].set(s.footX, s.footZ, s.asym, s.dip);
      }
      // nothing below the surface's sag needs covering
      const bxm = Math.max(Math.abs(bmin.x), Math.abs(bmax.x));
      bmin.y = Math.max(bmin.y, -((bxm * bxm) / (2 * R) + 0.6));
    } else {
      const bx = P.L * 1.15 + 1.0, by = P.H * 1.6 + 1.0, bz = P.W * 3.6 + 1.0;
      const sag = (bx * bx) / (2 * R) + 0.6;
      bmin.set(-bx, -sag, -bz);
      bmax.set(bx, by, bz);
    }

    // the hedgerow sheet; under an arch (P.curtain > 0) a fainter rain curtain hanging from the dipped strands
    const curtain = type === 1
      ? new THREE.Vector4(P.L, P.H, P.W, 1)
      : new THREE.Vector4(P.L * 0.72, P.H * 0.78, P.W * 0.4, P.curtain ?? 0);
    const curtainS = type === 1 ? new THREE.Vector4(0.35, 1.2, 0.22, 1) : new THREE.Vector4(0.55, 0.8, 0.35, 0.25);

    const geo = new THREE.BoxGeometry(bmax.x - bmin.x, bmax.y - bmin.y, bmax.z - bmin.z);
    geo.translate((bmax.x + bmin.x) / 2, (bmax.y + bmin.y) / 2, (bmax.z + bmin.z) / 2);
    const M = new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(origin);
    geo.applyMatrix4(M);
    const basisT = new THREE.Matrix3().set(X.x, X.y, X.z, Y.x, Y.y, Y.z, Z.x, Z.y, Z.z);

    const mat = new THREE.ShaderMaterial({
      name: 'sun-prominence-' + idx,
      uniforms: {
        uTime: S.uTime,
        uCamLocal: S.uCamLocal,
        uR: S.uR,
        uGain: S.uGain,
        uPixAngle: S.uPixAngle,
        uFade: S.uFade,
        uNoise3: S.uNoise3,
        uBasisT: { value: basisT },
        uOrigin: { value: origin },
        uBoxMin: { value: bmin },
        uBoxMax: { value: bmax },
        uArch: { value: new THREE.Vector4(0.8, 0.42, 0.11, type === 2 ? 0.7 : 0.45) },
        uCurtain: { value: curtain },
        uCurtainS: { value: curtainS },
        uSeed: { value: P.seed },
        uLHW: { value: new THREE.Vector3(P.L, P.H, P.W) },
        uStrandA: { value: strandA },
        uStrandB: { value: strandB },
        uStrandC: { value: strandC },
        uStrandD: { value: strandD },
        uNStrand: { value: nStrand },
        uNC: PROM_LOOPS.nc,
        uNewton: PROM_LOOPS.newton,
        uThree: PROM_LOOPS.three,
        uNThread: PROM_LOOPS.thread,
        uHedgeN: PROM_LOOPS.hedge,
        uEmit: { value: PROM_EMIT },
        uThin: { value: 0 },
        uThinK: { value: PROM_THIN_K },
        uOffGain: { value: 1 },
        uInside: { value: 0 },
        uDebug: S.uDebug,
        uKappa: { value: (type === 1 ? PROM_KAPPA_HEDGE : PROM_KAPPA) * (P.dens ?? 1) },
      },
      vertexShader: PROM_VERT,
      fragmentShader: DEVDEFS + PROM_FRAG,
      // both faces, one program: the shader keeps the front faces (camera outside the box) or the back faces
      // (inside; uInside), so entering a box never switches to another program variant mid-film
      side: THREE.DoubleSide,
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
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'sun-prominence-' + idx;
    rotor.add(mesh);
    // box centre and bounding radius (body frame), for the per-frame occlusion test
    const cLoc = new THREE.Vector3().addVectors(bmin, bmax).multiplyScalar(0.5);
    const centre = origin.clone().addScaledVector(X, cLoc.x).addScaledVector(Y, cLoc.y).addScaledVector(Z, cLoc.z);
    const bRad = 0.5 * new THREE.Vector3().subVectors(bmax, bmin).length();
    proms.push({ mesh, mat, basisT, origin, bmin, bmax, centre, bRad, idx, thinScale: type === 1 ? PROM_THIN_HEDGE : 1, emitScale: type === 2 ? 0.9 : 1 });
  });

  // ---------------------------------------------------------------- far-field point
  const pointMat = new THREE.ShaderMaterial({
    name: 'sun-point',
    uniforms: {
      uSunPosW: U.uSunPosW,
      uResolution: U.uResolution,
      uSigmaPx: { value: 0.8 },
      uPull: { value: 1.3 * R },
      uFlux: { value: 0 },
      uColor: { value: U.uSunColor.value.clone() },
    },
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const point = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), pointMat);
  point.name = 'sun-point';
  point.frustumCulled = false;
  point.visible = false;
  object.add(point);

  // ---------------------------------------------------------------- per frame
  const q = new THREE.Quaternion(), qi = new THREE.Quaternion();
  const camLocal = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const sunLum = 0.2126 * U.uSunColor.value.r + 0.7152 * U.uSunColor.value.g + 0.0722 * U.uSunColor.value.b;
  pointMat.uniforms.uColor.value.multiplyScalar(1 / sunLum);

  function update(frame) {
    const dDays = frame.simDays - epochDays;
    bodyQuaternion('sun', REF_DAYS + dDays, q);
    rotor.quaternion.copy(q);
    qi.copy(q).invert();
    // camera in the body frame (the Sun sits at the universe origin), computed in double precision
    camLocal.copy(frame.camUniverse).applyQuaternion(qi);
    S.uCamLocal.value.copy(camLocal);
    eclN.set(0, 1, 0).applyQuaternion(qi);

    const cam = frame.camera;
    const resY = U.uResolution.value.y || 900;
    const pixAngle = (2 * Math.tan((cam.fov * DEG) / 2)) / resY;
    S.uPixAngle.value = pixAngle;

    // active regions drift with differential rotation relative to the body frame
    // only the spots on the visible hemisphere (plus their own radius) go to the shader
    const dCam = camLocal.length();
    const cosLimb = Math.min(1, R / Math.max(dCam, R));
    tmp2.copy(camLocal).multiplyScalar(1 / Math.max(dCam, 1e-9));
    let ns = 0;
    for (const s of spotList) {
      dirFromLatLon(s.lat, s.lon + diffRotationOffsetDeg(s.lat, dDays), s.dir);
      if (ns >= NSPOT || s.dir.dot(tmp2) < cosLimb - s.reach) continue;
      spotA[ns].set(s.dir.x, s.dir.y, s.dir.z, s.rp * DEG);
      spotB[ns].copy(s.b);
      ns++;
    }
    photoMat.uniforms.uNSpot.value = ns;
    PLAGES.slice(0, NPLAGE).forEach((p, i) => {
      dirFromLatLon(p.lat, p.lon + diffRotationOffsetDeg(p.lat, dDays), tmp);
      plage[i].x = tmp.x;
      plage[i].y = tmp.y;
      plage[i].z = tmp.z;
      if (i < arDirs.length) arDirs[i].set(tmp.x, tmp.y, tmp.z, p.s * (i < 10 ? 1 : 0));
    });

    // far field: disc radius in pixels -> blend the disc into a point that carries its flux
    const d = camLocal.length();
    const rPx = Math.asin(Math.min(1, R / Math.max(d, R * 1.0001))) / pixAngle;
    const wPoint = 1 - THREE.MathUtils.smoothstep(rPx, 1.4, 2.6);
    S.uDiscFade.value = 1 - wPoint;
    S.uFade.value = 1 - wPoint;
    point.visible = wPoint > 0;
    const rEff = Math.max(rPx, 2.0);
    pointMat.uniforms.uFlux.value = DISC_RADIANCE * meanRatio * Math.PI * rEff * rEff * wPoint;
    pointMat.uniforms.uSigmaPx.value = Math.max(0.8, 0.5 * Math.min(rPx, 2.6));

    const shot = frame.shot || {};
    // The corona is ~1e-6 of the disc in reality; here it is graded like an eclipse photograph. Its gain follows
    // the exposure (constant on-screen brightness above CORONA_EXPOSURE) so planet-exposed shots get a soft,
    // structured glow rather than a blown-out halo. shot.sunCorona overrides/multiplies it.
    const ex = Math.max(U.uExposure.value || 1, 1e-6);
    // Hero weight, as post.js derives it (HERO.ev0/ev1: how far the disc centre is over-exposed): 1 when the shot
    // is exposed for the Sun itself, 0 in planet shots where the disc is a blinding white.
    const sg = shot.grade || {};
    const over = Math.log2(Math.max(1e-30, DISC_RADIANCE * ex * 2 ** (sg.ev ?? 0)));
    const heroW = sg.hero ?? 1 - THREE.MathUtils.smoothstep(over, 3.5, 7.5);
    S.uHeroW.value = heroW;
    S.uHeroA.value.copy(heroA);
    S.uHeroP.value.copy(heroP);
    // close views are exposed down the ramp (see HERO_CLOSE_EXP)
    // ... with a gentler large-scale contrast, so the plain glows orange-red all the way to the horizon
    const closeH = 1 - THREE.MathUtils.smoothstep(d / R, 1.15, 2.4);
    S.uHeroX.value.set(THREE.MathUtils.lerp(1, HERO_CLOSE_EXP, closeH), THREE.MathUtils.lerp(1, HERO_CLOSE_K, closeH));
    // Close hero views (inside ~1.5 R) exposed for the disc: the sky above the horizon of the skim is graded by
    // height (uSkyLift, below), as in a coronagraph composite, so it glows pearl at the limb instead of going black.
    const closeF = 1 - THREE.MathUtils.smoothstep(d / R, 1.2, 1.5);
    const lift = THREE.MathUtils.clamp(Math.pow(CORONA_EXPOSURE / ex, 0.2), 1, 3);
    // The corona is display-graded like an eclipse composite: below CORONA_EXPOSURE its gain follows the exposure, so
    // it keeps a constant on-screen brightness whether the shot is exposed for the corona (wide) or for the disc
    // (full disc, departure); CORONA_DISC of the wide level when exposed for the disc. Close views (the skim) keep
    // the fainter height-graded sky (uSkyLift). dev: ?suncor=discLevel,closeLevel
    // (dimmer when the inner corona fills the frame, between the full-disc view and the skim)
    const discLevel = THREE.MathUtils.lerp(CORONA_DISC, 1, THREE.MathUtils.smoothstep(ex, 0.0005, 0.0018)) * THREE.MathUtils.lerp(0.55, 1, THREE.MathUtils.smoothstep(d / R, 1.5, 3.5));
    const dispGain = ex < CORONA_EXPOSURE ? (CORONA_EXPOSURE / ex) * discLevel : Math.pow(CORONA_EXPOSURE / ex, 1.15);
    const autoGain = THREE.MathUtils.lerp(dispGain, CORONA_CLOSE, heroW * closeF);
    // post's radially graded hero gain (post.js: gain = g_disc rho^1.5 capped at 1 when the disc must be darkened)
    {
      const H = POST_HERO;
      const lnC = THREE.MathUtils.clamp(Math.log2(H.target / (H.discRGB[0] * H.filter[0] * ex * 2 ** (sg.ev ?? 0))), -10, 2.5);
      coronaUniforms.uPostG.value = lnC < 0 ? Math.pow(2, heroW * lnC) : 1;
    }
    // ... and the close views grade the sky above the horizon by height (bright pearl at the limb, see the shader)
    const skyW = heroW * closeF;
    coronaMat.uniforms.uSkyLift.value = SKY_LIFT * skyW * Math.min(1, (lift - 1) / 0.6);
    coronaMat.uniforms.uKCol.value.setRGB(1.0, 0.98 - 0.03 * skyW, 0.95 - 0.07 * skyW);
    coronaMat.uniforms.uCorona.value = autoGain * (shot.sunCorona ?? 1);
    if (api.debugMask & 8) coronaMat.uniforms.uCorona.value = 0;
    // chromosphere: like the corona it is an eclipse-grade feature, so it fades with exposure; once its height is
    // resolved (limb close-ups) it keeps most of its strength so the spicules stay visible; unresolved and
    // exposed for the disc it is a faint pink rim
    const limbDist = Math.sqrt(Math.max(d * d - R * R, 0));
    const fpMmLimb = pixAngle * limbDist * 6.371;
    const resolved = 1 - THREE.MathUtils.smoothstep(fpMmLimb, 0.5, 2.2);
    const chromoGain = Math.max(Math.min(1, Math.pow(CORONA_EXPOSURE / ex, 1.15)), 0.3 + 0.5 * resolved);
    // (the shader's band + spicule forest is calibrated for resolved close-ups; unresolved it is a thin rim)
    chromoMat.uniforms.uChromo.value = api.debugMask & 16 ? 0 : chromoGain * (0.14 + 0.86 * resolved);
    // outside the shell draw its front faces (the pass then also covers the photosphere's extreme limb)
    chromoMat.uniforms.uInside.value = d > CHROMO_R * R * 1.0005 ? 0 : 1;
    const mask = api.debugMask;
    shell.visible = wPoint < 1 && (mask & 2) !== 0;
    chromo.visible = wPoint < 1 && (mask & 2) !== 0;
    photo.visible = (mask & 1) !== 0;

    // prominences: camera inside a box -> back faces, no depth test (nothing can be in front of it)
    const promGain = shot.sunProminence ?? 1;
    // display grading of the H-alpha source function (see PROM_DISP): constant on-screen level at Sun exposures
    // (a little brighter in the wide views, where they are small flames on the limb of an eclipse-graded corona)
    const promEmit = Math.min(PROM_EMIT, (PROM_DISP * (1 + 0.8 * THREE.MathUtils.smoothstep(d / R, 3, 10))) / (DISC_RADIANCE * ex));
    for (const p of proms) {
      tmp.copy(camLocal).sub(p.origin).applyMatrix3(p.basisT);
      const inside = tmp.x > p.bmin.x - 1 && tmp.x < p.bmax.x + 1 && tmp.y > p.bmin.y - 1 && tmp.y < p.bmax.y + 1 && tmp.z > p.bmin.z - 1 && tmp.z < p.bmax.z + 1;
      p.mat.uniforms.uInside.value = inside ? 1 : 0;
      p.mat.depthTest = !inside; // (GL state only, not part of the program)
      // Entirely within the disc as seen from the camera, a prominence is either behind the Sun or in front of the
      // photosphere, where in white light it is invisible (the shader draws nothing on the disc): skip the draw.
      const toC = tmp.copy(p.centre).sub(camLocal);
      const dcB = toC.length();
      const cosB = -toC.dot(camLocal) / Math.max(dcB * d, 1e-9);
      const beta = Math.acos(THREE.MathUtils.clamp(cosB, -1, 1));
      const alphaS = Math.asin(Math.min(1, R / Math.max(d, R)));
      const alphaB = Math.asin(Math.min(1, p.bRad / Math.max(dcB, 1e-9)));
      const occluded = !inside && beta + alphaB < alphaS * 0.995;
      p.mesh.visible = !occluded && wPoint < 1 && promGain > 0 && DEBUG !== 6 && (mask & 4) !== 0 && (!PROM_ONLY || PROM_ONLY.includes(p.idx));
      p.mat.uniforms.uEmit.value = promEmit * p.emitScale;
      p.mat.uniforms.uThin.value = (promEmit * p.emitScale * PROM_THIN_SAT * p.thinScale) / PROM_THIN_K;
      p.mat.uniforms.uOffGain.value = 1;
    }
  }

  // debugMask (dev/perf only): 1 photosphere, 2 corona shell, 4 prominences
  const api = { id: 'sun', radius: R, object, moons: [], update, debugMask: QS.has('sunmask') ? Number(QS.get('sunmask')) : 7 };
  return api;
}
