// Venus — a globe of unbroken sulfuric-acid cloud.
//
//   venus/deck.js    opaque cloud deck (~68 km): Hapke/H-function photometry, UV-absorber morphology (sideways Y,
//                    polar collar, spiral streaks, subsolar cells), 4-day retrograde super-rotation
//   venus/bake.js    CPU bake (once, ~0.2 s) of the planetary-scale fields into a 512x256 half-float texture:
//                    zonal mean + Y + collar, spiral arcs, two coarse streak fields (keeps the deck program small)
//   venus/haze.js    transparent haze shell (to 200 km): single scattering + forward-diffused sunbeam + deck
//                    light + twilight diffusion, Chapman optical depths; soft bright limb, broad terminator,
//                    HDR forward-scattering crescent and the ring of light
//   venus/common.js  shared constants and GLSL (vertical structure, phase functions, sun transmittance)
//
// Frames: the meshes ride in bodyQuaternion('venus') (IAU pole, retrograde 243-day spin). The clouds rotate
// relative to the surface toward the west with a ~4-day period at the equator (faster angular velocity at
// mid-latitudes). All animation is a pure function of frame.simDays.
import * as THREE from 'three';
import { bodyQuaternion } from '../core/astro.js';
import { KM, R_SURF_KM, DECK_ALT_KM, TOP_ALT_KM, HAZE } from './venus/common.js';
import { deckShaders } from './venus/deck.js';
import { hazeShaders } from './venus/haze.js';
import { bakePlanetary, BAKE } from './venus/bake.js';

const SUPER_ROTATION_DAYS = 4.0; // cloud-top equatorial period relative to the surface (westward)
let FLOW_CYCLE_DAYS = 3.0; // flow-map regeneration cycle: features persist ~1.5-2 days while the wind shears them
const ARC_PERIOD_DAYS = 2.8;
const WAVE_PH0 = (85 * Math.PI) / 180; // longitude of the Y vertex in the old wave frame (see notes) // mid-latitude spiral arcs: ~1.45x the equatorial angular velocity

const num0 = (k) => (typeof location !== 'undefined' && new URLSearchParams(location.search).has(k) ? Number(new URLSearchParams(location.search).get(k)) : null);

function hash1(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export async function create(ctx) {
  const { U } = ctx;
  const q = ctx.quality || 'high';
  const R = ctx.data.radius;
  const Rd = (R_SURF_KM + DECK_ALT_KM) * KM;
  const Rt = (R_SURF_KM + TOP_ALT_KM) * KM;

  const object = new THREE.Group();
  object.name = 'venus';
  const spin = new THREE.Group();
  spin.name = 'venus-spin';
  object.add(spin);

  // developer overrides of the haze structure: vh=aerTau,aerH,upTau,upH,extTau,extH,rayTau,rayH (km)
  const vh = num0('vh') !== null ? new URLSearchParams(location.search).get('vh').split(',').map((x) => (x === '' ? NaN : Number(x))) : null;
  if (vh) {
    const cur = [HAZE.aer.tau, HAZE.aer.H, HAZE.up.tau, HAZE.up.H, HAZE.ext.tau, HAZE.ext.H, HAZE.ray.tau, HAZE.ray.H];
    const v = cur.map((d, i) => (Number.isFinite(vh[i]) ? vh[i] : d));
    [HAZE.aer.tau, HAZE.aer.H, HAZE.up.tau, HAZE.up.H, HAZE.ext.tau, HAZE.ext.H, HAZE.ray.tau, HAZE.ray.H] = v;
  }
  const vec = (k, d) => (typeof location !== 'undefined' && new URLSearchParams(location.search).has(k) ? new URLSearchParams(location.search).get(k).split(',').map(Number) : d);
  const beta = (c, H) => new THREE.Vector3(...c.spec.map((s) => (c.tau * s) / (H * KM)));
  const shared = {
    uRd: { value: Rd },
    uRt: { value: Rt },
    uAerB: { value: beta(HAZE.aer, HAZE.aer.H) },
    uUpB: { value: beta(HAZE.up, HAZE.up.H) },
    uExtB: { value: beta(HAZE.ext, HAZE.ext.H) },
    uDetB: { value: new THREE.Vector3(...HAZE.det.spec.map((s) => (HAZE.det.tau * s) / (HAZE.det.w * KM * Math.sqrt(Math.PI)))) },
    uRayB: { value: beta(HAZE.ray, HAZE.ray.H) },
    uHgt: { value: new THREE.Vector4(HAZE.aer.H * KM, HAZE.up.H * KM, HAZE.ray.H * KM, HAZE.ext.H * KM) },
    uDet: { value: new THREE.Vector2(HAZE.det.h * KM, HAZE.det.w * KM) },
    uHazeOmega: { value: new THREE.Vector3(...vec('vhw', [0.999, 0.996, 0.985])) },
    uPhA: { value: new THREE.Vector4(...vec('vph', [0, 0.85, 0.12, -0.25])) },
    uCamL: { value: new THREE.Vector3(0, 0, 10) },
    uSunL: { value: new THREE.Vector3(1, 0, 0) },
    uSunColor: U.uSunColor,
    uPix: { value: 1e-3 },
  };

  // ---------------------------------------------------------------- cloud deck (opaque)
  for (const [k, key] of [['vyamp', 'yAmp'], ['vcollar', 'collar'], ['vstretch', 'stretch']]) if (num0(k) !== null) BAKE[key] = num0(k);
  const planTex = bakePlanetary();
  const deckU = {
    ...shared,
    uPlan: { value: planTex },
    uTexK: { value: BAKE.W / (2 * Math.PI) },
    uWaveRot: { value: 0 },
    uArcRot: { value: 0 },
    uFlow: { value: [new THREE.Vector4(0, 0, 1, 0), new THREE.Vector4(0, 0, 0, 0)] },
    uSeed: { value: [new THREE.Vector3(), new THREE.Vector3()] },
    uLoop: { value: 1 },
    uOmega: { value: new THREE.Vector3(0.9998, 0.99975, 0.9992) },
    uAlbGain: { value: 1.3 },
    uOctS: { value: [] },
    uOctA: { value: [] },
    uContrast: { value: 1.0 },
    uAbsCol: { value: new THREE.Vector3(...vec('vabs', [0.34, 0.64, 0.95])) },
    uGlow: { value: 6e-4 },
    uStreak: { value: 4.2 },
    uRelief: { value: 2e-4 },
    uDebug: { value: 0 },
    uCells: { value: 0.45 },
    uCellRelief: { value: 1.4e-4 },
    uCellAlb: { value: 0.1 },
    uSky: { value: 0.03 },
    uGloryGain: { value: 0.05 },
    uGloryFade: { value: 0 },
    uFine: { value: 0.8 },
    uRidge: { value: 0.5 },
    uFineBoost: { value: 1.2 },
    uWarpK: { value: 0.3 },
  };
  // per-octave tables of the deck's fine streak octaves (see deck.js): extra anisotropy (octS - 1) * aniso * share
  {
    const aniso = num0('vani') ?? 2.0;
    const octS = (i) => (i < 1 ? 1.5 : i < 2 ? 1.9 : i < 3 ? 2.4 : i < 5 ? 2.8 : i < 6 ? 2.5 : i < 7 ? 2.2 : 1.9);
    const octA = (i) => (i < 1 ? 1.0 : i < 2 ? 0.55 : i < 3 ? 0.34 : i < 4 ? 0.24 : i < 5 ? 0.19 : i < 6 ? 0.16 : 0.15 * 0.9 ** (i - 6));
    for (let i = 0; i < 12; i++) {
      deckU.uOctS.value.push((octS(i) - 1) * aniso * (i < 5 ? 0.6 : 0.5));
      deckU.uOctA.value.push(octA(i));
    }
  }
  const deckMat = new THREE.ShaderMaterial({
    uniforms: deckU,
    ...deckShaders({ octaves: q === 'low' ? 7 : q === 'med' ? 9 : 11 }),
  });
  const segs = q === 'low' ? 160 : 320;
  const deck = new THREE.Mesh(new THREE.SphereGeometry(Rd, segs, segs / 2), deckMat);
  deck.name = 'venus-deck';
  spin.add(deck);

  // ---------------------------------------------------------------- haze shell (transparent)
  const hazeU = {
    ...shared,
    uTwilight: { value: 0.3 },
    uTwA: { value: 2.5 },
    uTwK: { value: 20.0 },
    uMsF: { value: 1.0 },
    uMsTint: { value: new THREE.Vector3(1.0, 0.982, 0.875) },
    uFwd: { value: new THREE.Vector4(...vec('vfwd', [1.0, 0.84, 0.58, 5.0])) },
    uSteps: { value: q === 'low' ? 10 : q === 'med' ? 13 : 16 },
    uSegs: { value: 2 },
  };
  const hazeMat = new THREE.ShaderMaterial({
    uniforms: hazeU,
    ...hazeShaders(),
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.SrcAlphaFactor,
    side: THREE.FrontSide,
  });
  const haze = new THREE.Mesh(new THREE.SphereGeometry(Rt * 1.003, 192, 96), hazeMat);
  haze.name = 'venus-haze';
  spin.add(haze);

  // ---------------------------------------------------------------- per-frame state
  const qb = new THREE.Quaternion();
  const qi = new THREE.Quaternion();
  const c = new THREE.Vector3();
  const sun = new THREE.Vector3();
  const TWO_PI = Math.PI * 2;
  const omegaEq = TWO_PI / SUPER_ROTATION_DAYS; // rad / day

  if (num0('vcyc') !== null) FLOW_CYCLE_DAYS = num0('vcyc');
  function flowLayer(simDays, k, vec4, seed) {
    const x = simDays / FLOW_CYCLE_DAYS + 0.5 * k;
    const cyc = Math.floor(x);
    const ph = x - cyc;
    const age = ph * FLOW_CYCLE_DAYS;
    const w = Math.sin(Math.PI * ph) ** 2;
    const id = cyc * 2 + k;
    vec4.set(hash1(id) * TWO_PI, omegaEq * age, Math.max(w, 1e-4), 0);
    seed.set((hash1(id + 0.37) - 0.5) * 200, (hash1(id + 0.71) - 0.5) * 200, (hash1(id + 0.13) - 0.5) * 200);
  }

  // developer-only switches for isolated testing (vdbg=nohaze|nodeck|flat)
  const dbg = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('vdbg') || '' : '';
  if (dbg.includes('nohaze')) haze.visible = false;
  if (dbg.includes('nodeck')) deck.visible = false;
  if (dbg.includes('flat')) deckU.uContrast.value = 0;
  if (dbg.includes('plan')) deckU.uDebug.value = 3;
  const num = (k) => (typeof location !== 'undefined' && new URLSearchParams(location.search).has(k) ? Number(new URLSearchParams(location.search).get(k)) : null);
  for (const [k, u] of [['vcon', deckU.uContrast], ['vrel', deckU.uRelief], ['vstr', deckU.uStreak], ['vtw', hazeU.uTwilight], ['vtwa', hazeU.uTwA], ['vtwk', hazeU.uTwK], ['vmsf', hazeU.uMsF], ['vcell', deckU.uCells], ['vcr', deckU.uCellRelief], ['vcalb', deckU.uCellAlb], ['vsky', deckU.uSky], ['vglory', deckU.uGloryGain], ['vfine', deckU.uFine], ['vridge', deckU.uRidge], ['vfb', deckU.uFineBoost], ['valb', deckU.uAlbGain], ['vwarp', deckU.uWarpK]]) if (num(k) !== null) u.value = num(k);

  function update(frame) {
    const d = frame.simDays;
    bodyQuaternion('venus', d, qb);
    spin.quaternion.copy(qb);
    qi.copy(qb).invert();

    // camera and Sun in the body frame (double precision on the CPU; the camera is at the world origin)
    c.copy(object.position).sub(frame.camUniverse); // Venus centre, camera-relative
    shared.uCamL.value.copy(c).negate().applyQuaternion(qi);
    sun.copy(object.position).negate().normalize().applyQuaternion(qi);
    shared.uSunL.value.copy(sun);

    // glory visibility: the glory is centred on the antisolar point; show it only when that point lies well
    // inside the disc (emission cosine there > ~0.3-0.7), so it never appears as a partial arc near the limb
    {
      const ro = shared.uCamL.value;
      const tc = ro.dot(sun); // rd = -sun
      const pc2 = ro.lengthSq() - tc * tc;
      const h = Rd * Rd - pc2;
      let fade = 0;
      if (h > 0 && tc - Math.sqrt(h) > 0) {
        const tHit = tc - Math.sqrt(h);
        // hit point P = ro - sun * tHit; emission cosine = dot(P / |P|, sun)
        const muH = (ro.dot(sun) - tHit) / Rd;
        const x = Math.min(Math.max((muH - 0.3) / 0.4, 0), 1);
        fade = x * x * (3 - 2 * x);
      }
      deckU.uGloryFade.value = fade;
    }

    const cam = frame.camera;
    const resY = U.uResolution.value.y || 900;
    shared.uPix.value = (2 * Math.tan((cam.fov * Math.PI) / 360)) / resY;

    // super-rotation: rigid planetary-scale waves + regenerating flow-map streaks
    const ph = d / SUPER_ROTATION_DAYS;
    // (phase origin of the Y: unknown in reality; chosen so the vertex and both arms face the film's day approach)
    deckU.uWaveRot.value = TWO_PI * (ph - Math.floor(ph)) - WAVE_PH0;
    const pa = d / ARC_PERIOD_DAYS;
    deckU.uArcRot.value = TWO_PI * (pa - Math.floor(pa)) + 1.3;
    if (dbg.includes('wave')) {
      const cl = shared.uCamL.value, sl = shared.uSunL.value;
      const w = (v) => ((((Math.atan2(-v.z, v.x) + deckU.uWaveRot.value) * 180) / Math.PI + 540) % 360) - 180;
      console.log(`[app] venus wave-frame lon: sub-camera ${w(cl).toFixed(1)} sub-solar ${w(sl).toFixed(1)} simDays ${d.toFixed(3)}`);
    }
    flowLayer(d, 0, deckU.uFlow.value[0], deckU.uSeed.value[0]);
    flowLayer(d, 1, deckU.uFlow.value[1], deckU.uSeed.value[1]);

    // inside the haze shell: draw its back faces instead
    // (the shader stops each ray at the deck itself, so depth testing can be dropped there)
    const inside = c.length() < Rt * 1.004;
    hazeMat.side = inside ? THREE.BackSide : THREE.FrontSide;
    hazeMat.depthTest = !inside;
  }

  return { id: 'venus', radius: R, object, update, moons: [] };
}
