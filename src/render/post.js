// Post-processing: owns the HDR scene target and everything after it.
//
//   scene ──► HDR (RGBA16F, 4x MSAA, reversed 32F depth texture)
//     ├─► sun reference + probe (32x32, GPU-reduced)  → flux-calibrated sun visibility & colour
//     ├─► bloom pyramid (7 levels, Karis prefilter, 13-tap down / tent up, long-tailed lens PSF)
//     ├─► warp radial blur (only while shot.warp > 0; exact comb x tent integral in log-radius, no jitter)
//     ├─► after-post overlay layer (OVERLAY_LAYER objects, only while any is visible)
//     └─► composite → screen: lateral CA, barrel (warp, Catmull-Rom), bloom mix, analytic sun lens system
//         (aureole/glare, diffraction starburst, anamorphic streak, 5 rim-dominant aperture ghosts with coating
//         hues, field windows and cat's-eye vignetting), natural vignette, overlay, exposure, AgX + look,
//         grade, film grain, TPDF dither, 2.39:1 letterbox, fade.
//
// Test overrides (URL): postWarp=<0..1> postFade=<0..1> postLetterbox=<0..1> postFlare=<gain>
//   postDebug=bloom|flare|vis|raw   postPerf=1 (GPU timer queries, logged as "[app] post ...")
//   postIG=0 (no image-based ghosts)   postPick=x,y;x,y (log linear HDR values at screen pixels)
//   postOv=orbits (test hook: draw the director's finale orbit lines through the overlay layer)
import * as THREE from 'three';
import { VERT, PREFILTER, DOWN, UP, PROBE, WARP, COMPOSITE, NG, SPECTRAL, NL } from './post/shaders.js';
import { buildPupilPSF } from './post/psf.js';

const DEG = Math.PI / 180;
const LEVELS = 7;
// After-post overlay layer. Any Mesh / Line / Points / Sprite whose layers include ONLY this layer (e.g.
// `line.layers.set(31)`) is left out of the scene render and drawn instead, with the same camera, into a separate
// 4x MSAA HDR target that the composite ADDS over the finished optics: no warp streaks, bloom, flare, ghosts, CA or
// vignette touch it, but it follows the warp's barrel (stays registered with the planets) and goes through the same
// exposure, tone curve, fade and letterbox as the scene. So line art (finale orbit ellipses, markers) looks exactly
// as it would drawn in the scene, just clean. Additive light only (no occlusion); keep such objects under `world`
// as usual (floating origin). Objects are found by a scene scan at start-up (and every few seconds after), and
// drawn once at start-up so their programs are compiled before the film runs.
export const OVERLAY_LAYER = 31;
// lens PSF as a sum of Gaussian-like octaves (half-res .. 1/128): energy per octave falls roughly like r^-0.6,
// i.e. a long skirt rather than a "glow blob"
// (the two widest octaves carry a little more: a faint wide veil around blazing crescents, glints and ansae)
const LEVEL_WEIGHTS = [0.25, 0.2, 0.16, 0.13, 0.1, 0.135, 0.105];
const BLOOM_MIX = 0.04;
const GHOST_GAIN = 0.85;
// warp: radial speed blur toward the direction of travel — an energy-conserving mean for diffuse light,
// blended (WARP_POWMIX) with a power mean for sources much brighter than their surroundings
const WARP_LEN = 0.11, WARP_R0 = 1.2, WARP_POWMIX = 0.85, WARP_GAIN = 0.0, WARP_EXPOSURE = 0.12, WARP_BLOOM = 0.7, WARP_GLOW = 0.18;
// diffraction starburst: texture half-size (frame heights), gain on the physical PSF energy
// (the starburst is a restrained component: ~half the round-2 energy, tapered beyond STAR_ENV frame heights,
// the envelope widening by STAR_ENV_EV per stop the shot is exposed above the planet standard)
const PSF_HALF_FH = 0.46, PSF_GAIN = 0.06, STAR_ENV = 0.1, STAR_ENV_EV = 0.3;
// default grade: saturation, shadow tint, highlight warmth, contrast | hue preservation, punch
const GRADE = { saturation: 1.04, shadowTint: 0.035, warmth: 0.025, contrast: 1.0, hue: 0.0, punch: 1.0, filter: 0.0, ev: 0.0 };
// the hero look while the Sun itself is the subject (blended in with the hero weight, before shot.grade overrides)
const GRADE_SUN = { saturation: 1.0, warmth: 0.0, contrast: 1.04, hue: 0.0, punch: 1.0, filter: 1.0, ev: 0.0 };
// Hero Sun: graded like a solar-physics composite. A single exposure cannot hold the disc and the eclipse-graded
// corona at once (the corona just outside the limb is ~4 % of the disc centre, the streamers at 2 R ~0.3 %), and
// the director exposes the wide shots for the corona, which put the disc centre 2.5-3 stops above white. So the
// disc gets its own exposure through a white-light solar filter, and a radially graded filter (cf. the NRGF used
// for coronagraph and eclipse images) eases that exposure back to the shot's own over a few solar radii:
// gain(rho) = g_disc * rho^n (rho = impact parameter in solar radii), capped at 1. Continuous across the limb, so
// the anti-aliased limb pixels never ring; monotone for any corona falling faster than rho^-n.
//   discRGB: disc-centre radiance per channel (sun.js: DISC_RADIANCE 3000 x (1, .7, .36) / .739)
//   filter:  transmission of the solar filter (orange glass), applied to the photosphere only (the corona and
//            prominences keep their own pearl / H-alpha colours)
//   target:  red channel of the filtered disc centre after the exposure (the per-channel shoulder clips it a
//            little, so the centre reads golden and the limb deep orange, as through a real orange filter)
//   ev0/ev1: the disc's over-exposure (log2 of centre luminance x exposure) over which the hero look fades
//            in (ev1 -> ev0): blown-out discs in planet shots stay blinding white
//   gamma:   log contrast of the filtered photosphere about its centre colour (limb darkening, granulation and
//            umbrae read as in a contrasty solar-filter photograph / the HMI intensitygram)
//   maxEV:   the disc may be lifted (skim shots exposed darker than the wide view), but then by the photosphere
//            mask only, so the corona and prominences keep the director's exposure
const HERO = { discRGB: [4059, 2841, 1461], discLum: 3000, filter: [1.0, 0.22, 0.022], target: 2.4, gamma: 1.4, n: 1.5, ev0: 3.5, ev1: 7.5, minEV: -10, maxEV: 2.5 };
const BARREL_A = 0.012, BARREL_R = 0.45; // off-frame barrel flare: amplitude (per unit flux), radius
// image-based ghosts: energy fraction per ghost, and the display level (x white) above which light ghosts
const IGHOST = { amp: 4e-4, threshold: 2.0 };
// scattered-light beam for a sun just outside a narrow field (amplitude per unit flux per frame-height^2,
// Gaussian sigma and offset of the beam axis from the frame centre in frame heights, fall-off length along it).
// Like the sunbeams in Voyager 1's Pale Blue Dot frame: stray light reflected off the sunshade into a faint band
// that runs from the sun's side across the field, with a broader, fainter companion.
const BEAM = { amp: 0.05, width: 0.022, offset: 0.01, length: 0.7 };

// Aperture ghosts along the axis through the frame centre (wave 2: five, not nine). A real multi-coated cine
// lens shows only a handful of ghosts strong enough to see, one per dominant pair of reflecting surfaces, and each
// one is mostly RIM: the defocused image of the stop (or of an element edge) piles its light into a thin caustic
// ring just inside the edge, with the interior at ~10-20 % of the rim. Each pair of surfaces has its own coating
// residual, so each ghost has its own hue (green, magenta, amber, cyan at saturation ~0.3-0.5), and ghosts that
// image the 7-blade stop through an odd number of inversions (k < 0) are its point reflection — rotated by 180
// degrees, which for an odd blade count is a visibly different orientation.
//   k: position on the axis (1 = at the sun, -1 = point-mirrored through the centre); size: radius in frame
//   heights; e: fraction of the sun's flux in the ghost; hue: coating colour (luminance ~1); poly: 0 = round (an
//   element edge bounds it), 1 = the 7-blade stop; rim: caustic width (fraction of the radius); inner: interior
//   level relative to the rim peak; soft: edge softness (fraction of the radius, min ~1 px); clip: cat's-eye
//   strength; disp: dispersion (red images larger: red outside, blue inside the rim); rot: extra rotation (rad);
//   win: field window [a0, a1] in frame heights of the sun's distance from the frame centre. A ghost path is
//   vignetted by the element apertures it passes, so each ghost is bright only over part of the field and fades
//   out beyond it: the set of ghosts changes as the sun moves through the frame (a plugin shows all of them, always).
const GHOSTS = [
  // the small near-focus reflection, point-symmetric to the sun through the frame centre: compact and green, the
  // one ghost every phone and cine camera shows (a crisp small dot with a bright edge)
  { k: -0.93, size: 0.0075, e: 0.16e-5, hue: [0.62, 1.0, 0.7], poly: 1, rim: 0.3, inner: 0.35, soft: 0.12, clip: 0.0, disp: 0.02, rot: 0.06, win: [0.0, 3.0] },
  // medium polygon between the centre and the sun's mirror point: violet-magenta rim
  { k: -0.4, size: 0.05, e: 1.2e-5, hue: [0.96, 0.62, 1.0], poly: 1, rim: 0.06, inner: 0.05, soft: 0.03, clip: 0.45, disp: 0.006, rot: -0.05, win: [0.1, 1.2] },
  // round ghost between the sun and the centre (bounded by an element edge, not the stop): pale cyan-green
  { k: 0.47, size: 0.075, e: 1.6e-5, hue: [0.66, 1.0, 0.88], poly: 0, rim: 0.05, inner: 0.05, soft: 0.035, clip: 0.6, disp: 0.008, rot: 0.0, win: [0.0, 0.85] },
  // large, strongly defocused amber annulus beyond the centre: a faint ring, nearly empty inside
  { k: -1.3, size: 0.19, e: 3.5e-5, hue: [1.0, 0.8, 0.55], poly: 0.55, rim: 0.035, inner: 0.05, soft: 0.04, clip: 0.8, disp: 0.008, rot: 0.11, win: [0.35, 3.0] },
  // the widest: a huge, very faint blue-violet defocus annulus near the centre (cut by the barrel into a lune)
  { k: 0.08, size: 0.42, e: 4.5e-5, hue: [0.74, 0.8, 1.0], poly: 0.3, rim: 0.025, inner: 0.04, soft: 0.05, clip: 0.9, disp: 0.006, rot: 0.0, win: [0.0, 0.6] },
];
const ghostPeak = []; // rim-peak intensity per ghost (before the field window)

export async function create(ctx) {
  const { renderer, U } = ctx;
  const gl = renderer.getContext();
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const pnum = (k) => (params.has(k) ? Number(params.get(k)) : null);
  const OV = { warp: pnum('postWarp'), fade: pnum('postFade'), letterbox: pnum('postLetterbox'), flare: pnum('postFlare') };
  const DEBUG = { bloom: 1, flare: 2, vis: 3 }[params.get('postDebug')] || 0;
  const RAW = params.get('postDebug') === 'raw';
  const PERF = params.get('postPerf') === '1';
  const LOG = params.get('postLog') === '1';

  // ------------------------------------------------------------------ targets
  const rtOpts = (o = {}) => ({
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    generateMipmaps: false,
    ...o,
  });
  const hdr = new THREE.WebGLRenderTarget(1, 1, rtOpts({ samples: 4, depthBuffer: true, depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType) }));
  hdr.texture.name = 'post.hdr';
  const down = [], up = [];
  for (let i = 0; i <= LEVELS; i++) {
    down.push(i === 0 ? null : new THREE.WebGLRenderTarget(1, 1, rtOpts()));
    up.push(i === 0 ? null : new THREE.WebGLRenderTarget(1, 1, rtOpts()));
  }
  const warpA = new THREE.WebGLRenderTarget(1, 1, rtOpts());
  const warpB = new THREE.WebGLRenderTarget(1, 1, rtOpts());
  // after-post overlay layer: scene-linear additive light, 4x MSAA (line art stays anti-aliased); allocated at
  // full size only while the scene holds overlay objects (OVERLAY_LAYER)
  const ovRT = new THREE.WebGLRenderTarget(1, 1, rtOpts({ samples: 4 }));
  ovRT.texture.name = 'post.overlay';
  // The reference needs the same 32F reversed depth as the scene: with a 24-bit fixed-point buffer and the tiny
  // near plane of a low orbit (near ~1e-3, sun at 2.3e4) the sun's depths collapse into a few LSBs, the back
  // halves of the chromosphere / corona shells z-fight through the photosphere and the reference gains red
  // light the scene does not have — which made every low-orbit flare teal (scene/ref = 0.70, 0.93, 0.89).
  const refRT = new THREE.WebGLRenderTarget(32, 32, rtOpts({ samples: 4, depthBuffer: true, depthTexture: new THREE.DepthTexture(32, 32, THREE.FloatType) }));
  const probeRef = new THREE.WebGLRenderTarget(32, 32, rtOpts({ generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter }));
  const probeVis = new THREE.WebGLRenderTarget(32, 32, rtOpts({ generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter }));
  const sizes = [];
  let W = 1, H = 1;

  // ------------------------------------------------------------------ passes
  const fsGeom = new THREE.BufferGeometry();
  fsGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const fsMesh = new THREE.Mesh(fsGeom);
  fsMesh.frustumCulled = false;
  const fsScene = new THREE.Scene();
  fsScene.add(fsMesh);
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = (frag, uniforms) =>
    new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: frag,
      uniforms,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
  function pass(material, target) {
    fsMesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(fsScene, fsCam);
  }

  const prefilterM = mat(PREFILTER, { tSrc: { value: hdr.texture }, uTexel: { value: new THREE.Vector2() }, uClamp: { value: 40 }, uKaris: { value: 1 } });
  const downM = mat(DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  const upM = mat(UP, { tLow: { value: null }, tCur: { value: null }, uTexelLow: { value: new THREE.Vector2() }, uLowScale: { value: 1 }, uCurWeight: { value: 1 } });
  const probeM = mat(PROBE, {
    tScene: { value: hdr.texture },
    tRef: { value: refRT.texture },
    uOrigin: { value: new THREE.Vector2() },
    uWin: { value: 32 },
    uScreen: { value: new THREE.Vector2() },
    uAVis: { value: 1 },
    uMode: { value: 0 },
  });
  const warpM = mat(WARP, {
    tSrc: { value: null },
    tOrig: { value: hdr.texture },
    uRes: { value: new THREE.Vector2() },
    uFoe: { value: new THREE.Vector2() },
    uLen: { value: 0 },
    uR0: { value: 1000 },
    uN2: { value: 16 },
    uGain: { value: 1 },
    uMix: { value: 1 },
    uFinal: { value: 0 },
    uPowMix: { value: WARP_POWMIX },
    uPMClamp: { value: 2 },
    uSunW: { value: new THREE.Vector3() },
    uInClamp: { value: 8 },
    uGlow: { value: new THREE.Vector2(0, 1) },
  });

  const v4 = () => new THREE.Vector4();
  const cu = {
    tHDR: { value: hdr.texture },
    tBloom: { value: null },
    // image-based ghosts of other very bright sources (crescents, ring ansae, limb arcs): amp, threshold
    // (scene units), -, - | sun mask (frame-height coords: x, y, radius; radius 0 = none)
    tGhostSrc: { value: null },
    uIG: { value: new THREE.Vector4() },
    uIGSun: { value: new THREE.Vector3() },
    tProbeRef: { value: probeRef.texture },
    tProbeVis: { value: probeVis.texture },
    uRes: { value: new THREE.Vector2() },
    uBloomTexel: { value: new THREE.Vector2() },
    uBloomMix: { value: BLOOM_MIX },
    uBloomWarp: { value: 0 },
    tOverlay: { value: ovRT.texture },
    uOverlayOn: { value: 0 },
    uBloomNorm: { value: 1 / LEVEL_WEIGHTS.reduce((a, b) => a + b, 0) },
    uExposure: { value: 1 },
    uFadeDisp: { value: 1 },
    uBarH: { value: 0 },
    uFrame: { value: 0 },
    uGrain: { value: 0.022 },
    uVignette: { value: 0.32 },
    uTanHalf: { value: 0.4 },
    uCA: { value: 0.0012 },
    uWarp: { value: 0 },
    uBarrel: { value: 0 },
    uCornerR2: { value: 1 },
    uDebug: { value: DEBUG },
    uFlareOn: { value: 0 },
    uSunPx: { value: new THREE.Vector2() },
    uSunR: { value: 0 },
    uFlux: { value: new THREE.Vector3() },
    uAVis: { value: 1 },
    uProbeValid: { value: 0 },
    uProbeLod: { value: 5 },
    uProbeWin: { value: 32 },
    uKGlare: { value: 0 },
    uKStar: { value: 0 },
    uKGhost: { value: 0 },
    uStarRot: { value: 0 },
    uBladeRot: { value: 0 },
    uGhostA: { value: GHOSTS.map(() => v4()) },
    uGhostB: { value: GHOSTS.map(() => v4()) },
    uGhostC: { value: GHOSTS.map(() => v4()) },
    uGhostRot: { value: GHOSTS.map(() => 0) },
    // aureole amp, radius; skirt amp, radius   (amplitudes are per unit flux per frame-height^2)
    uGlare: { value: new THREE.Vector4() },
    uGlare2: { value: new THREE.Vector4() },
    uKStreak: { value: 0 },
    uBeam: { value: new THREE.Vector4() },
    tPSF: { value: null },
    uPSF: { value: new THREE.Vector4() },
    uPSFRot: { value: new THREE.Vector2(1, 0) },
    uStar2: { value: new THREE.Vector4() },
    uGrade: { value: new THREE.Vector4(GRADE.saturation, GRADE.shadowTint, GRADE.warmth, GRADE.contrast) },
    uGrade2: { value: new THREE.Vector4(GRADE.hue, GRADE.punch, 0, 0) },
    // hero Sun composite: weight, ln(disc gain), radial power, filter mix | sun direction (camera space) | sin R
    uHero: { value: new THREE.Vector4() },
    uHeroDir: { value: new THREE.Vector3(0, 0, -1) },
    uHeroSinR: { value: 1 },
    uHeroEdge: { value: 0.01 },
    uHeroFilter: { value: new THREE.Vector3(...HERO.filter) },
    uHeroPivot: { value: new THREE.Vector4(1, 1, 1, 1) }, // filtered disc-centre colour after exposure, contrast
  };
  if (GHOSTS.length !== NG) throw new Error('ghost table size mismatch');
  GHOSTS.forEach((g, i) => {
    // rim-peak intensity from the ghost's energy: the profile (interior at `inner`, plus an exponential caustic of
    // width `rim` rising to 1 at the edge) integrates to ~pi r^2 (inner + 2 rim (1 - inner))
    const norm = Math.PI * g.size * g.size * (g.inner + 2 * g.rim * (1 - g.inner));
    const lum = 0.2126 * g.hue[0] + 0.7152 * g.hue[1] + 0.0722 * g.hue[2];
    ghostPeak[i] = (GHOST_GAIN * g.e) / norm;
    cu.uGhostA.value[i].set(g.k, g.size, ghostPeak[i], g.soft);
    cu.uGhostB.value[i].set(g.hue[0] / lum, g.hue[1] / lum, g.hue[2] / lum, g.rim);
    cu.uGhostC.value[i].set(g.clip, g.disp, g.inner, g.poly);
    // stop images formed through an inversion (k < 0) are the stop's point reflection: rotated by pi
    cu.uGhostRot.value[i] = (g.k < 0 ? Math.PI : 0) + g.rot;
  });
  // PSF components, each given as (fraction of flux, scale) and normalised so the fraction is the energy
  // (a compact aureole and a modest skirt: the blown core of a 1 AU sun stays ~30-40 px across at 900p and
  // rolls off smoothly instead of reading as a flat white disc)
  const setGlare = () => {
    const a1 = 0.005, r1 = 0.0024; // aureole: exp(-r/r1)/(2 pi r1^2)
    const a2 = 0.0065, r2 = 0.02; // skirt: (1+(r/r2)^2)^-1.5 / (2 pi r2^2)
    const a3 = 0.005, r3 = 0.3; // veiling glare
    cu.uGlare.value.set(a1 / (2 * Math.PI * r1 * r1), r1, a2 / (2 * Math.PI * r2 * r2), r2);
    cu.uGlare2.value.set(a3 / (2 * Math.PI * r3 * r3), r3, 0.0, BARREL_R);
    cu.uStar2.value.set(0, 0, 0.25, 0.05); // -, -, anamorphic amp, anamorphic length
  };
  setGlare();
  const compositeM = mat(COMPOSITE, cu);

  // ------------------------------------------------------------------ diffraction PSF (once, at start-up)
  // CPU: pupil + FFT (psf.js). GPU: spectral sum into a mip-mapped RGBA16F texture.
  const PSF_M = 512, PSF_SCALE = 1024;
  let psfTexel = 0, psfAiry = 0;
  const psfRT = new THREE.WebGLRenderTarget(PSF_M, PSF_M, rtOpts({ generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter }));
  psfRT.texture.name = 'post.psf';
  {
    const t0 = performance.now();
    const psf = buildPupilPSF();
    const half = Math.min(psf.maxHalf, 352);
    const mono = new THREE.DataTexture(psf.P, psf.N, psf.N, THREE.RedFormat, THREE.FloatType);
    mono.minFilter = mono.magFilter = THREE.NearestFilter;
    mono.generateMipmaps = false;
    mono.needsUpdate = true;
    const specM = mat(SPECTRAL, {
      tMono: { value: mono },
      uN: { value: psf.N },
      uHalf: { value: half },
      uM: { value: PSF_M },
      uS: { value: psf.lambdaScale.slice(0, NL) },
      uW: { value: psf.weights.slice(0, NL).map((w) => new THREE.Vector3(w[0], w[1], w[2])) },
      uScale: { value: PSF_SCALE },
    });
    if (psf.lambdaScale.length !== NL) throw new Error('psf wavelength count mismatch');
    pass(specM, psfRT);
    renderer.setRenderTarget(null); // generates the mip chain
    specM.dispose();
    mono.dispose();
    // texel value -> energy density per frame-height^2: P/sum per 550 nm sample, (half/S)^2 samples per fh^2
    cu.tPSF.value = psfRT.texture;
    cu.uPSF.value.set(PSF_HALF_FH, (PSF_GAIN * (half / PSF_HALF_FH) ** 2) / psf.sum / PSF_SCALE, 0, 0);
    psfTexel = (2 * PSF_HALF_FH) / PSF_M;
    psfAiry = (psf.airySamples / half) * PSF_HALF_FH;
    if (LOG) console.log(`[app] post psf ${(performance.now() - t0).toFixed(1)} ms, airy ${(psfAiry * 900).toFixed(1)} px @900`);
  }

  // ------------------------------------------------------------------ sun reference camera
  const refCam = new THREE.PerspectiveCamera();
  const sunObj = ctx.bodies?.sun?.object || null;

  // ------------------------------------------------------------------ GPU timing (debug)
  const tq = PERF ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  const perf = { scene: [], post: [], pending: [] };
  if (PERF && !tq) console.log('[app] post: EXT_disjoint_timer_query_webgl2 unavailable');
  function tBegin(label) {
    if (!tq) return null;
    const q = gl.createQuery();
    gl.beginQuery(tq.TIME_ELAPSED_EXT, q);
    return { q, label };
  }
  function tEnd(h) {
    if (!h) return;
    gl.endQuery(tq.TIME_ELAPSED_EXT);
    perf.pending.push(h);
  }
  let perfFrames = 0;
  function tCollect() {
    if (!tq) return;
    const disjoint = gl.getParameter(tq.GPU_DISJOINT_EXT);
    perf.pending = perf.pending.filter((h) => {
      if (!gl.getQueryParameter(h.q, gl.QUERY_RESULT_AVAILABLE)) return true;
      if (!disjoint) perf[h.label].push(gl.getQueryParameter(h.q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(h.q);
      return false;
    });
    if (++perfFrames % 120 === 0 && perf.post.length) {
      const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1].toFixed(3);
      const msg = `[app] post gpu ms: scene(incl. MSAA resolve) ${med(perf.scene)}  post ${med(perf.post)}  (${perf.post.length} samples, ${W}x${H})`;
      console.log(msg);
      globalThis.__postPerf = { scene: +med(perf.scene), post: +med(perf.post), n: perf.post.length };
      perf.scene.length = 0;
      perf.post.length = 0;
    }
  }

  // ------------------------------------------------------------------ helpers
  const sunC = new THREE.Vector3();
  const resSave = new THREE.Vector2();
  const tmpV = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  // direction of travel for the warp effects, in camera space (pure function of the shot / director)
  function travelDirCam(camera, shot, t) {
    const dir = new THREE.Vector3();
    const dirr = ctx.director;
    if (dirr && dirr.evaluate && shot && shot.camPos && OV.warp === null) {
      const dur = dirr.duration || 1e9;
      const ta = Math.max(0, Math.min(dur, t - 0.04)), tb = Math.max(0, Math.min(dur, t + 0.04));
      try {
        const a = dirr.evaluate(ta).camPos, b = dirr.evaluate(tb).camPos;
        dir.copy(b).sub(a);
      } catch {
        dir.set(0, 0, 0);
      }
    }
    if (dir.lengthSq() < 1e-12) {
      if (U.uCamVelW.value.lengthSq() > 1e-12) dir.copy(U.uCamVelW.value);
      else return new THREE.Vector3(0, 0, -1);
    }
    return dir.applyQuaternion(tmpQ.copy(camera.quaternion).invert()).normalize();
  }

  // ------------------------------------------------------------------ after-post overlay
  const overlay = [];
  let ovFrame = 0;
  const onlyOverlay = (o) => o.layers.isEnabled(OVERLAY_LAYER) && !o.layers.isEnabled(0);
  function scanOverlay() {
    overlay.length = 0;
    ctx.scene?.traverse?.((o) => {
      if ((o.isMesh || o.isLine || o.isPoints || o.isSprite) && o.material && onlyOverlay(o)) overlay.push(o);
    });
  }
  const chainVisible = (o) => {
    for (let p = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  };
  // test hook (postOv=orbits): put the director's finale orbit lines on the overlay layer, to verify the overlay in
  // film frames before the director opts in itself
  if (params.get('postOv') === 'orbits') {
    ctx.scene?.getObjectByName?.('director-orbits')?.traverse((o) => o.layers.set(OVERLAY_LAYER));
  }
  scanOverlay();
  function renderOverlay(camera) {
    if ((++ovFrame & 255) === 0) scanOverlay();
    let any = false;
    for (const o of overlay) if (chainVisible(o)) { any = true; break; }
    if (!any) return false;
    if (ovRT.width !== W || ovRT.height !== H) ovRT.setSize(W, H);
    const mask = camera.layers.mask;
    camera.layers.mask = 1 << OVERLAY_LAYER;
    renderer.setRenderTarget(ovRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    for (const o of overlay) if (chainVisible(o)) renderer.render(o, camera);
    renderer.setRenderTarget(null); // resolves MSAA
    renderer.setClearColor(0x000000, 1);
    camera.layers.mask = mask;
    return true;
  }
  // compile the overlay objects' programs now (ANGLE builds them at the first draw): one forced draw each
  if (overlay.length) {
    const cam = ctx.camera || new THREE.PerspectiveCamera();
    const mask = cam.layers.mask;
    cam.layers.mask = 1 << OVERLAY_LAYER;
    renderer.setRenderTarget(ovRT);
    for (const o of overlay) {
      const saved = [];
      for (let p = o; p; p = p.parent) {
        saved.push([p, p.visible]);
        p.visible = true;
      }
      const fc = o.frustumCulled;
      o.frustumCulled = false;
      try {
        renderer.render(o, cam);
      } catch (e) {
        console.warn('[app] post: overlay warm-up draw failed', e);
      }
      o.frustumCulled = fc;
      for (const [p, v] of saved) p.visible = v;
    }
    renderer.setRenderTarget(null);
    cam.layers.mask = mask;
  }

  // ------------------------------------------------------------------ API
  function setSize(w, h) {
    W = Math.max(1, Math.floor(w));
    H = Math.max(1, Math.floor(h));
    hdr.setSize(W, H);
    warpA.setSize(W, H);
    scanOverlay();
    ovRT.setSize(overlay.length ? W : 1, overlay.length ? H : 1);
    warpB.setSize(W, H);
    sizes.length = 0;
    sizes.push([W, H]);
    for (let i = 1; i <= LEVELS; i++) {
      const sw = Math.max(1, Math.ceil(W / 2 ** i)), sh = Math.max(1, Math.ceil(H / 2 ** i));
      sizes.push([sw, sh]);
      down[i].setSize(sw, sh);
      up[i].setSize(sw, sh);
    }
    cu.uRes.value.set(W, H);
    cu.uBloomTexel.value.set(1 / sizes[1][0], 1 / sizes[1][1]);
    cu.uCornerR2.value = 0.25 * ((W / H) ** 2 + 1);
    probeM.uniforms.uScreen.value.set(W, H);
    warpM.uniforms.uRes.value.set(W, H);
  }

  function render({ scene, camera, shot = {}, sun, t = 0 }) {
    const exposure = shot.exposure ?? U.uExposure.value ?? 1;
    const warp = OV.warp ?? shot.warp ?? 0;
    const fade = OV.fade ?? shot.fade ?? 0;
    const letterbox = OV.letterbox ?? shot.letterbox ?? 0;
    const flareGain = (OV.flare ?? 1) * (shot.flare ?? 1);

    // ---------------------------------------------------------------- scene
    const hs = tBegin('scene');
    renderer.setRenderTarget(hdr);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null); // resolves MSAA
    tEnd(hs);
    const hp = tBegin('post');

    // ---------------------------------------------------------------- sun geometry
    const tanHalf = Math.tan((camera.fov * DEG) / 2) / (camera.zoom || 1);
    const aspect = W / H;
    sunC.copy(U.uSunPosW.value).applyMatrix4(camera.matrixWorldInverse);
    const sd = sunC.length();
    const cosField = sd > 0 ? -sunC.z / sd : -1;
    let flareOn = false;
    let probeValid = false;
    const angR = sun ? sun.angularRadius : 0;
    const aVis = sun ? sun.visible : 0;
    if (sun && sd > 0 && cosField > 0.2 && aVis > 1e-4 && flareGain > 0) {
      const nx = sunC.x / -sunC.z / (tanHalf * aspect);
      const ny = sunC.y / -sunC.z / tanHalf;
      const px = (nx * 0.5 + 0.5) * W, py = (ny * 0.5 + 0.5) * H;
      const rpx = (Math.tan(angR) / tanHalf) * H * 0.5;
      // angle by which the sun lies outside the frame (0 inside): lens light fades with it the way a sun shade
      // and the lens barrel cut off-axis light, so the flare leaves gracefully instead of popping
      const hx = Math.atan(Math.abs(sunC.x / sunC.z)) - Math.atan(tanHalf * aspect);
      const hy = Math.atan(Math.abs(sunC.y / sunC.z)) - Math.atan(tanHalf);
      // (measured relative to the field: a long lens and its hood cut off-axis light within a few field widths,
      // so for a 1 deg telephoto field a sun 0.6 deg beyond the edge is already "far" outside)
      const halfFovDeg = Math.atan(tanHalf) / DEG;
      const out = (Math.max(0, hx, hy) / DEG) * Math.max(1, 10 / halfFovDeg);
      // and as the disc becomes an extended source (close to the Sun the bloom alone is right)
      const sizeStar = 1 - smooth(0.7 * DEG, 2.6 * DEG, angR);
      const sizeGlare = 1 - smooth(2.0 * DEG, 8.0 * DEG, angR);
      const kGlare = (1 - smooth(5, 45, out)) * sizeGlare;
      const kStar = (1 - smooth(0, 14, out)) * sizeStar;
      // a narrow field with the sun just outside it (the pale-blue-dot frame): the hood and the long barrel
      // block the oblique ghost paths, so the chain fades as (fov / 10 deg)^2; with the sun in the field the
      // ghosts stay
      const fovDeg = 2 * halfFovDeg;
      const kGhost = (1 - smooth(3, 30, out)) * sizeStar * (1 + (Math.min(1, (fovDeg / 10) ** 2) - 1) * smooth(0, 2, out));
      // scattered-light beam (Voyager's sunbeams): only for narrow fields with the sun just outside them
      const kBeam = (1 - smooth(5, 14, fovDeg)) * smooth(0.3, 3, out) * (1 - smooth(25, 60, out));
      // the anamorphic streak is a thin in-frame artefact: it dies within ~3 deg of the frame edge
      const kStreak = (1 - smooth(0, 3, out)) * sizeStar;
      if (LOG) console.log(`[app] post sun ndc ${nx.toFixed(3)},${ny.toFixed(3)} out ${out.toFixed(2)}deg rpx ${rpx.toFixed(2)} vis ${aVis.toFixed(3)} k ${kGlare.toFixed(2)}/${kStar.toFixed(2)}/${kGhost.toFixed(2)} exp ${exposure.toExponential(2)} flare ${flareGain.toFixed(3)} fov ${(2 * halfFovDeg).toFixed(2)}`);
      if (kGlare + kStar + kGhost + kStreak + kBeam > 1e-4) {
        flareOn = true;
        cu.uSunPx.value.set(px, py);
        cu.uSunR.value = rpx / H;
        cu.uKGlare.value = kGlare;
        cu.uKStar.value = kStar;
        cu.uKGhost.value = kGhost;
        // each ghost's field window (vignetting of its path): fades in over 0.12 fh below a0, out over 0.3 above a1
        {
          const off = Math.hypot(px - 0.5 * W, py - 0.5 * H) / H;
          GHOSTS.forEach((g, i) => {
            const wv = (g.win[0] > 0 ? smooth(g.win[0] - 0.12, g.win[0], off) : 1) * (1 - smooth(g.win[1], g.win[1] + 0.3, off));
            cu.uGhostA.value[i].z = ghostPeak[i] * wv;
          });
        }
        cu.uKStreak.value = kStreak;
        cu.uBeam.value.set(BEAM.amp * kBeam, BEAM.width, BEAM.offset, BEAM.length);
        cu.uGlare2.value.z = BARREL_A * smooth(0.5, 4, out) * (1 - smooth(12, 40, out));
        cu.uAVis.value = aVis;
        // flux of the sun in frame units: pi (unit irradiance on a white Lambertian = 1.0) per frame-height^2
        // of solid angle, softened from 1/tan^2 to 1/tan so zooms don't swing the flare too hard
        // (and held constant below a 12 deg field, so telephoto shots don't drown in flare)
        const F = (Math.PI / (4 * Math.max(tanHalf, Math.tan(6 * DEG)) * Math.tan(22.5 * DEG))) * flareGain;
        const sc = U.uSunColor.value;
        cu.uFlux.value.set(sc.r * F, sc.g * F, sc.b * F);
        // aperture orientation: fixed to the camera body, with a subtle drift as the camera rolls relative to
        // the ecliptic (the blades "breathe" with focus/iris in real lenses)
        tmpV.set(1, 0, 0).applyQuaternion(camera.quaternion);
        const roll = Math.atan2(tmpV.y, Math.hypot(tmpV.x, tmpV.z));
        const rot = 0.21 + 0.15 * roll;
        cu.uStarRot.value = rot;
        cu.uBladeRot.value = rot + Math.PI / 14;
        cu.uPSFRot.value.set(Math.cos(rot), Math.sin(rot));
        // convolve the PSF with the solar disc: mip level whose texel matches the disc's equal-area box
        cu.uPSF.value.z = Math.max(0, Math.log2((1.2 * (rpx / H)) / psfTexel));
        cu.uPSF.value.w = rpx / H + 2.0 * psfAiry;
        // (measured beyond the PSF's core, so an extended 1-degree disc near Mercury keeps its wide, soft spikes)
        cu.uStar2.value.x = STAR_ENV * Math.max(0.5, 1 + STAR_ENV_EV * Math.log2(Math.max(exposure * flareGain, 1e-6))) + 2.5 * cu.uPSF.value.w;

        // flux-calibrated visibility probe: only while the disc window touches the frame
        const win = Math.max(32, Math.ceil(2.3 * rpx + 8));
        const ox = Math.round(px - win / 2), oy = Math.round(py - win / 2);
        if (sunObj && ox < W && oy < H && ox + win > 0 && oy + win > 0) {
          refCam.copy(camera, false);
          refCam.setViewOffset(W, H, ox, H - (oy + win), win, win);
          refCam.updateProjectionMatrix();
          refCam.updateMatrixWorld(true);
          renderer.setRenderTarget(refRT);
          renderer.clear(true, true, true);
          // screen-space-sized sun content (the far-field point sprite) sizes itself from uResolution: the
          // window spans win x win scene pixels, so present it as the "screen" while the reference renders
          resSave.copy(U.uResolution.value);
          U.uResolution.value.set(win, win);
          renderer.render(sunObj, refCam);
          U.uResolution.value.copy(resSave);
          probeM.uniforms.uOrigin.value.set(ox, oy);
          probeM.uniforms.uWin.value = win;
          probeM.uniforms.uAVis.value = aVis;
          probeM.uniforms.uMode.value = 0;
          pass(probeM, probeRef);
          probeM.uniforms.uMode.value = 1;
          pass(probeM, probeVis);
          cu.uProbeWin.value = win;
          probeValid = true;
        }
      }
    }
    cu.uFlareOn.value = flareOn && !RAW ? 1 : 0;
    cu.uProbeValid.value = probeValid ? 1 : 0;

    // ---------------------------------------------------------------- bloom
    prefilterM.uniforms.uTexel.value.set(1 / W, 1 / H);
    prefilterM.uniforms.uClamp.value = 40 / Math.max(exposure, 1e-6);
    prefilterM.uniforms.uKaris.value = exposure;
    pass(prefilterM, down[1]);
    for (let i = 2; i <= LEVELS; i++) {
      downM.uniforms.tSrc.value = down[i - 1].texture;
      downM.uniforms.uTexel.value.set(1 / sizes[i - 1][0], 1 / sizes[i - 1][1]);
      pass(downM, down[i]);
    }
    for (let i = LEVELS - 1; i >= 1; i--) {
      const low = i === LEVELS - 1 ? down[LEVELS] : up[i + 1];
      upM.uniforms.tLow.value = low.texture;
      upM.uniforms.tCur.value = down[i].texture;
      upM.uniforms.uTexelLow.value.set(1 / sizes[i + 1][0], 1 / sizes[i + 1][1]);
      upM.uniforms.uLowScale.value = i === LEVELS - 1 ? LEVEL_WEIGHTS[LEVELS - 1] : 1;
      upM.uniforms.uCurWeight.value = LEVEL_WEIGHTS[i - 1];
      pass(upM, up[i]);
    }
    cu.tBloom.value = up[1].texture;
    // image-based ghosts: the 1/16-res bloom level (already defocused) mirrored and scaled about the frame
    // centre; only light above IGHOST.threshold x white ghosts visibly. The Sun has its own analytic ghosts and
    // is masked out of the source, and the hero-Sun composite (where the disc is the subject) has none.
    cu.tGhostSrc.value = down[4].texture;
    {
      const on = !RAW && cu.uHero.value.x < 0.5 && params.get('postIG') !== '0';
      cu.uIG.value.set(on ? IGHOST.amp : 0, IGHOST.threshold / Math.max(exposure, 1e-6), 0, 0);
      if (sd > 0 && cosField > 0.05) {
        const tz = -sunC.z;
        cu.uIGSun.value.set(sunC.x / tz / (2 * tanHalf), sunC.y / tz / (2 * tanHalf), (Math.tan(Math.min(angR, 1.4)) / (2 * tanHalf)) * 1.35 + 0.09);
      } else cu.uIGSun.value.set(0, 0, 0);
    }

    // ---------------------------------------------------------------- warp
    let src = hdr.texture;
    const w = Math.min(1, Math.max(0, warp));
    if (w > 0.002 && !RAW) {
      const dc = travelDirCam(camera, shot, t);
      // focus of expansion (or of contraction when flying backwards); clamped so sideways motion gives
      // near-parallel streaks instead of a singularity
      const fz = dc.z < 0 ? dc : dc.clone().negate();
      const zz = Math.max(1e-3, -fz.z);
      let fx = fz.x / zz / (tanHalf * aspect), fy = fz.y / zz / tanHalf;
      const m = Math.max(Math.abs(fx), Math.abs(fy));
      if (m > 3) {
        fx *= 3 / m;
        fy *= 3 / m;
      }
      warpM.uniforms.uFoe.value.set((fx * 0.5 + 0.5) * W, (fy * 0.5 + 0.5) * H);
      // trail length: L x the distance from the focus near it, capped at L x R0 far from it (parallel streaks when
      // the focus is well outside the frame); in the radial coordinate both passes step through, that is ln(1 + L)
      const len = WARP_LEN * w * w * (3 - 2 * w);
      const U = Math.log1p(len);
      const R0 = WARP_R0 * H;
      warpM.uniforms.tSrc.value = hdr.texture;
      warpM.uniforms.uLen.value = U;
      warpM.uniforms.uR0.value = R0;
      // pass 2: the tent spans two teeth of the longest trail (R0 U px / 16 each) with taps ~0.8 px apart
      warpM.uniforms.uN2.value = Math.min(64, Math.max(8, Math.ceil((2 * R0 * U) / 16 / 0.8)));
      warpM.uniforms.uFinal.value = 0;
      warpM.uniforms.uPMClamp.value = 1.6 / Math.max(exposure, 1e-6);
      warpM.uniforms.uInClamp.value = 4 / Math.max(exposure, 1e-6);
      // the sun's disc and its far-field sprite (when on screen and small) are kept out of the streaks
      const sunRpx = cu.uSunR.value * H;
      if (flareOn) warpM.uniforms.uSunW.value.set(cu.uSunPx.value.x, cu.uSunPx.value.y, sunRpx + Math.max(7, 0.5 * sunRpx));
      else warpM.uniforms.uSunW.value.set(0, 0, 0);
      pass(warpM, warpA);
      warpM.uniforms.tSrc.value = warpA.texture;
      warpM.uniforms.uFinal.value = 1;
      warpM.uniforms.uGain.value = 1.0 + WARP_GAIN * w;
      // the sharp copy is gone by mid-warp (no crisp dots floating on their own streaks)
      warpM.uniforms.uMix.value = smooth(0, 0.3, w);
      warpM.uniforms.uGlow.value.set(WARP_GLOW * smooth(0.2, 0.8, w), 0.3 * H);
      pass(warpM, warpB);
      src = warpB.texture;
    }

    // ---------------------------------------------------------------- composite
    const fadeC = Math.min(1, Math.max(0, fade));
    const lb = Math.min(1, Math.max(0, letterbox));
    const targetH = Math.min(1, W / H / 2.39);
    // pushed exposures (night side, eclipse) get a slightly stronger veil: blazing crescents and glints then
    // carry a faint, wide halo, as they would through real glass
    const exBoost = 1 + 0.4 * smooth(1.2, 4, exposure);
    let gradeEV = 0;
    // (the warp's extra bloom is confined to the periphery in the shader: the destination stays crisp)
    cu.uBloomMix.value = RAW ? 0 : BLOOM_MIX * exBoost;
    cu.uBloomWarp.value = RAW ? 0 : BLOOM_MIX * exBoost * WARP_BLOOM * w;
    // grade: defaults -> hero-Sun look -> shot.grade overrides. The hero weight follows how far the disc is
    // over-exposed (a smooth, director-authored track), never the disc's size on screen, so the look cannot
    // change while the camera closes in: blinding white while the shot is exposed for planets, the filtered
    // composite once the exposure is brought down for the Sun itself.
    {
      const sg = shot.grade || {};
      const expBase = exposure * 2 ** (sg.ev ?? GRADE.ev);
      const over = Math.log2(Math.max(1e-30, HERO.discLum * expBase));
      const hero = RAW || !sun || sd <= 0 ? 0 : (sg.hero ?? 1 - smooth(HERO.ev0, HERO.ev1, over));
      const g = (k) => sg[k] ?? GRADE[k] + ((GRADE_SUN[k] ?? GRADE[k]) - GRADE[k]) * hero;
      cu.uGrade.value.set(g('saturation'), g('shadowTint'), g('warmth'), g('contrast'));
      cu.uGrade2.value.set(g('hue'), g('punch'), 0, 0);
      gradeEV = g('ev');
      if (hero > 1e-3) {
        // the disc's own exposure: its filtered red channel lands on HERO.target
        const lnG = Math.log(HERO.target / (HERO.discRGB[0] * HERO.filter[0] * exposure * 2 ** gradeEV));
        const lnC = Math.min(HERO.maxEV, Math.max(HERO.minEV, lnG / Math.LN2)) * Math.LN2;
        cu.uHero.value.set(hero, hero * lnC, HERO.n, hero * g('filter'));
        cu.uHeroDir.value.copy(sunC).normalize();
        cu.uHeroSinR.value = Math.max(1e-6, Math.sin(Math.min(angR, 1.5)));
        const rpx = (Math.tan(Math.min(angR, 1.4)) / tanHalf) * H * 0.5;
        cu.uHeroEdge.value = 0.7 / Math.max(rpx, 1);
        // (pivot follows the fade / warp exposure factors, so a fade dims the disc linearly like everything else)
        const kf = (1 + WARP_EXPOSURE * w) * (1 - fadeC) ** 0.6;
        const pr = (c) => (kf * HERO.target * HERO.discRGB[c] * HERO.filter[c]) / (HERO.discRGB[0] * HERO.filter[0]);
        cu.uHeroPivot.value.set(pr(0), pr(1), pr(2), 1 + (HERO.gamma - 1) * hero * g('filter'));
        if (LOG) console.log(`[app] post hero ${hero.toFixed(3)} over ${over.toFixed(2)} disc gain ${(lnC / Math.LN2).toFixed(2)} EV`);
      } else cu.uHero.value.set(0, 0, HERO.n, 0);
    }
    cu.tHDR.value = src;
    cu.uOverlayOn.value = !RAW && renderOverlay(camera) ? 1 : 0;
    cu.uExposure.value = exposure * 2 ** gradeEV * (1 + WARP_EXPOSURE * w) * (1 - fadeC) ** 0.6;
    // fade: part optical (exposure: highlights linger, as in a printer-light fade), part display (reaches black)
    cu.uFadeDisp.value = (1 - fadeC) ** 0.8;
    cu.uBarH.value = RAW ? 0 : 0.5 * (1 - targetH) * lb * lb * (3 - 2 * lb);
    cu.uFrame.value = Math.floor(t * 60 + 1e-6) % 4096;
    cu.uTanHalf.value = tanHalf;
    cu.uWarp.value = w;
    cu.uBarrel.value = RAW ? 0 : 0.11 * w;
    cu.uCA.value = RAW ? 0 : 0.0012 * (1 + 1.5 * w);
    cu.uVignette.value = RAW ? 0 : 0.32 + 0.2 * w;
    cu.uGrain.value = RAW ? 0 : 0.022;
    pass(compositeM, null);
    tEnd(hp);
    tCollect();
    if (PICK) pickHDR(exposure);
  }

  // debug (postPick=x,y;x,y;... in screen pixels, y down): logs the linear HDR scene value (3x3 mean) at each point,
  // plus the exposure, so tone/grade decisions can be made against real numbers
  const PICK = params.get('postPick') ? params.get('postPick').split(';').map((s) => s.split(',').map(Number)) : null;
  function pickHDR(exposure) {
    const h2f = (h) => {
      const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
      if (e === 0) return s * 2 ** -14 * (f / 1024);
      if (e === 31) return f ? NaN : s * Infinity;
      return s * 2 ** (e - 15) * (1 + f / 1024);
    };
    const b = new Uint16Array(9 * 4);
    const out = PICK.map(([x, y]) => {
      renderer.readRenderTargetPixels(hdr, Math.max(0, x - 1), Math.max(0, H - 1 - y - 1), 3, 3, b);
      const m = [0, 1, 2].map((c) => {
        let s = 0;
        for (let i = 0; i < 9; i++) s += h2f(b[i * 4 + c]);
        return s / 9;
      });
      return `${x},${y}: ${m.map((v) => v.toPrecision(4)).join(' ')}`;
    });
    console.log(`[app] post pick exp ${exposure.toExponential(3)} eff ${cu.uExposure.value.toExponential(3)} | ${out.join(' | ')}`);
  }

  // debug readback for offline analysis (postProbe=1): raw probe windows and reductions
  if (params.get('postProbe') === '1') {
    const h2f = (h) => {
      const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
      if (e === 0) return s * 2 ** -14 * (f / 1024);
      if (e === 31) return f ? NaN : s * Infinity;
      return s * 2 ** (e - 15) * (1 + f / 1024);
    };
    const read = (rt, x, y, w, h) => {
      const b = new Uint16Array(w * h * 4);
      renderer.readRenderTargetPixels(rt, x, y, w, h, b);
      return Array.from(b, h2f);
    };
    globalThis.__postProbe = () => {
      const o = probeM.uniforms.uOrigin.value, win = probeM.uniforms.uWin.value;
      const x0 = Math.max(0, o.x), y0 = Math.max(0, o.y);
      const w = Math.max(1, Math.min(W, o.x + win) - x0), h = Math.max(1, Math.min(H, o.y + win) - y0);
      return {
        origin: [o.x, o.y], win, valid: cu.uProbeValid.value, aVis: cu.uAVis.value, sunPx: cu.uSunPx.value.toArray(), sunR: cu.uSunR.value,
        ref: read(refRT, 0, 0, 32, 32), probeRef: read(probeRef, 0, 0, 32, 32), probeVis: read(probeVis, 0, 0, 32, 32),
        scene: { x0, y0, w, h, data: read(hdr, x0, y0, w, h) },
      };
    };
  }

  // ------------------------------------------------------------------ program warm-up
  // ANGLE builds a program's executable at its first draw, so every pass that does not run on the very first frame
  // (the sun probe, both warp passes) is drawn once here, into the still 1x1 targets: no compile hitch when the Sun
  // first nears the frame or the first warp leg starts. (Bloom and the composite run on every frame; the composite
  // switches its optional terms by uniforms, never by defines.)
  {
    probeM.uniforms.uMode.value = 0;
    pass(probeM, probeRef);
    probeM.uniforms.uMode.value = 1;
    pass(probeM, probeVis);
    warpM.uniforms.tSrc.value = hdr.texture;
    warpM.uniforms.uFinal.value = 0;
    pass(warpM, warpA);
    warpM.uniforms.tSrc.value = warpA.texture;
    warpM.uniforms.uFinal.value = 1;
    pass(warpM, warpB);
    renderer.setRenderTarget(null);
  }

  return { setSize, render, target: hdr, depthTexture: hdr.depthTexture, overlayLayer: OVERLAY_LAYER };
}
