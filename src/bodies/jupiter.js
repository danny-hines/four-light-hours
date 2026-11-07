// JUPITER and the Galilean moons.
//   - flowing cloud deck: the Cassini PIA07782 map for the large scale, a real 2-D turbulence tracer for every finer
//     scale (mean-preserving variance injection), cloud-top relief, pop-up storms (src/bodies/jupiter/surface.js)
//   - thin H2 Rayleigh + stratospheric haze shell with analytic Chapman integration (haze.js)
//   - Io, Europa, Ganymede, Callisto: USGS mosaics + procedural detail, tidally locked, real phases (moons.js)
//   - analytic umbra/penumbra moon shadows on the clouds, Jupiter's shadow on the moons, Jupiter-shine
import * as THREE from 'three';
import { bodyQuaternion, poleQuaternion, DEG } from '../core/astro.js';
import { makeSurfaceMaterial } from './jupiter/surface.js';
import { makeLatitudeTexture, flowClock, makeClock, seedOf, TILE_N } from './jupiter/flow.js';
import { createHaze } from './jupiter/haze.js';
import { createMoons } from './jupiter/moons.js';
import { createDetail } from './jupiter/detail.js';
import { packTile, packUV, correctMap, endMembers, polarTracer } from './jupiter/bake.js';

// The Great Red Spot as drawn, in Jupiter's BODY frame (System III, the frame of bodyQuaternion('jupiter')):
// planetocentric latitude and east longitude in degrees. Use these (not the map-frame uniforms) to aim at it.
export const GRS_BODY = { latcDeg: -19.5, lonEDeg: -48.2 };

// Long flow clock: rests (no cross-fade, monotonic streaming) at days 0.25 and 6.30 after the epoch, the review
// window and the film's Jupiter window (days 5.9-6.6). Churn clock: small eddies are reborn every 0.29 d (detuned
// from the 0.4135 d spin so the churn never phase-locks to the rotation).
const CLOCK_L = { rest: 0.25, cycle: 6.05, sharp: 3 };
const CLOCK_S = { rest: 0.0, cycle: 0.29, sharp: 2 };

export async function create(ctx) {
  const { U, data, assets, epochDays, quality } = ctx;
  const R = data.radius;
  const flat = data.flattening ?? 0.06487;

  const object = new THREE.Group();
  object.name = 'jupiter';

  const lin = { srgb: false, anisotropy: 16, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping };
  const [map, c1, c2, tu, tv, meta, struct, tz] = await Promise.all([
    assets.loadTexture('jupiter/cassini.webp', { srgb: true, anisotropy: 16 }),
    assets.loadTexture('jupiter/turb_c1.webp', lin),
    assets.loadTexture('jupiter/turb_c2.webp', lin),
    assets.loadTexture('jupiter/turb_u.webp', { ...lin, mipmaps: false, anisotropy: 1 }),
    assets.loadTexture('jupiter/turb_v.webp', { ...lin, mipmaps: false, anisotropy: 1 }),
    assets.loadJSON('jupiter/turb_meta.json'),
    assets.loadTexture('jupiter/structure.webp', { srgb: false, anisotropy: 1 }),
    assets.loadTexture('jupiter/turb_z.webp', lin),
  ]);
  const latTex = makeLatitudeTexture(flat);
  // create-time bakes (bake.js): packed tiles with gradients, the colour-corrected map, the local end-members
  const t1 = packTile(c1.image, c2.image);
  const tzP = packTile(tz.image);
  const tuv = packUV(tu.image, tv.image);
  const cmap = correctMap(map.image);
  const em = endMembers(cmap.lin, cmap.w, cmap.h, struct.image);
  for (const t of [map, c1, c2, tu, tv, tz, struct]) t.dispose();
  // upload now (create time), so the first draw of each program pays its compile only
  for (const t of [cmap.tex, t1.tex, tzP.tex, tuv, em.hi, em.lo, latTex]) ctx.renderer.initTexture(t);

  const qual = { low: 0, med: 1, high: 2 }[quality] ?? 2;
  const deg = (d) => d * DEG;
  const clkL = makeClock();
  const clkS = makeClock();

  const shared = {
    uSunPosW: U.uSunPosW,
    uSunColor: U.uSunColor,
    uSunR: U.uSunRadius,
    uTime: U.uTime,
    uRadius: { value: R },
    uFlat: { value: flat },
    uSunJ: { value: new THREE.Vector3() },
    uRot: { value: new THREE.Matrix3() },
    uPoleW: { value: new THREE.Vector3(0, 1, 0) },
    uMap: { value: cmap.tex },
    uLatF: { value: latTex },
    uT1: { value: t1.tex },
    uT1G: { value: t1.gs },
    uTz: { value: tzP.tex },
    uTzG: { value: tzP.gs },
    uTuv: { value: tuv },
    uHi: { value: em.hi },
    uLo: { value: em.lo },
    uUVS: { value: meta.uv_scale },
    uClkL: { value: new THREE.Vector4(0, 0, 1, 0) },
    uClkS: { value: new THREE.Vector4(0, 0, 1, 0) },
    uVcs: { value: new THREE.Vector4(1, 0, 1, 0) },
    uSeedS: { value: new THREE.Vector4() },
    uDt: { value: 0 },
    uQual: { value: qual },
    uI0: { value: 0 },  // always 0: makes shader loop bounds non-constant (real loops, fast FXC compile)
    // development switch (read only by this module): jdebug=1 T, 2 m, 3 tracer, 4 amp/gain/sigma, 5 detail fades, 6 palette, 7 height
    uDebug: { value: Number(new URLSearchParams(globalThis.location ? location.search : '').get('jdebug') || 0) },
    // The Cassini map's longitude origin is not documented and the GRS drifts, so its System III longitude is a free
    // choice. Offset 0: map frame = body frame, GRS at body longitude -48.2 E (GRS_BODY above), which is the value
    // the director's clock search (src/journey/film.js) uses to put the GRS beside Io's shadow in the film.
    uLonOff: { value: deg(0) },
    // GRS as drawn (present-day ~16,000 x 11,500 km) and as it appears in the Dec-2000 Cassini map (map frame)
    uGrs: { value: new THREE.Vector4(deg(-48.2), deg(-19.5), deg(6.9), deg(4.6)) },
    uGrsMap: { value: new THREE.Vector4(deg(-48.2), deg(-19.5), deg(9.6), deg(4.9)) },
    // Oval BA, 33 S planetographic (29.6 planetocentric), ~8,000 x 6,000 km
    uBa: { value: new THREE.Vector4(deg(22.0), deg(-29.6), deg(3.6), deg(2.4)) },
    uMoon: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uCyc: { value: [] },
    uCycP: { value: [] },
    uStorm: { value: [] },
    uFlash: { value: [0, 1, 2, 3, 4, 5].map(() => new THREE.Vector4()) },
    uFlashR: { value: new THREE.Vector4(600, 600, 600, 600) },
  };
  const sph = (lonDeg, latDeg) => {
    const lo = lonDeg * DEG, la = latDeg * DEG;
    return [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)];
  };
  // Juno's circumpolar cyclones: 8 around a central one near the north pole (~83 N, ~4,300 km across),
  // 5 around a central one near the south pole (~84 S, ~6,000 km across). Cyclonic = ccw in the north, cw in the south.
  const addCyc = (lon, lat, rKm, sign) => {
    const [x, y, z] = sph(lon, lat);
    shared.uCyc.value.push(new THREE.Vector4(x, y, z, rKm / 71492));
    // zw = the centre's polar-stereographic tile coordinates (surface.js polarUV with NA = TILE_N, POLAR_K = 0.8)
    const lo = Math.atan2(-z, x), la = Math.asin(y), sg = la >= 0 ? 1 : -1;
    const rho = 2 * Math.tan(0.5 * (Math.PI / 2 - Math.abs(la))) * (TILE_N / (2 * Math.PI)) / 0.8;
    shared.uCycP.value.push(new THREE.Vector4(3.2 * sign, 1.1 * sign, Math.cos(lo) * rho + sg * 17.31, sg * Math.sin(lo) * rho + 5.77));
  };

  addCyc(30, 89.2, 2000, 1);
  for (let k = 0; k < 8; k++) addCyc(12 + 45 * k + (k % 2) * 6, 83.2 + (k % 3) * 0.4, 2150 + (k % 3) * 150, 1);
  addCyc(-60, -88.6, 2900, -1);
  for (let k = 0; k < 5; k++) addCyc(-20 + 72 * k + (k % 2) * 5, -84.0 + (k % 2) * 0.5, 2900 + (k % 3) * 250, -1);
  const pol = polarTracer(t1, shared.uCyc.value, shared.uCycP.value, TILE_N, 0.8);
  shared.uPolT = { value: pol.tex };
  shared.uPolG = { value: pol.gs };
  ctx.renderer.initTexture(pol.tex);
  // lightning storm cells (body frame): convective storms in the belts and at high latitudes (Juno MWR / SRU)
  for (const [lon, lat, rKm] of [[25, 15, 1400], [140, -15, 1200], [215, 13, 1100], [300, -17, 1300], [80, 58, 1500], [250, -50, 1300]]) {
    const [x, y, z] = sph(lon, lat);
    shared.uStorm.value.push(new THREE.Vector4(x, y, z, rKm / 71492));
  }

  // ------------------------------------------------------------------ globe
  const surfMat = makeSurfaceMaterial({ uniforms: shared });
  const globe = new THREE.Mesh(new THREE.SphereGeometry(R, 384, 192), surfMat);
  globe.scale.set(1, 1 - flat, 1);
  globe.name = 'jupiter-globe';
  object.add(globe);

  // moon shadows + the close-range detail layer: a multiplicative shell riding on the globe (detail.js)
  globe.add(createDetail({ geometry: globe.geometry, shared }));

  const haze = createHaze({ R, flat, shared });
  object.add(haze.mesh);

  const moons = await createMoons({ ctx, shared, object });

  const qSpin = new THREE.Quaternion();
  const qPole = poleQuaternion('jupiter');
  const m4 = new THREE.Matrix4();

  return {
    id: 'jupiter',
    radius: R,
    object,
    moons: moons.list,
    grs: GRS_BODY,
    update(frame) {
      const d = frame.simDays;
      // lightning (Juno MWR / SRU, Voyager, Galileo): 6 storm cells, each active ~16 % of a 2.3-10.8 s cycle with 3-5
      // multi-stroke flashes, every stroke at a different spot in the cell; light diffuses into a 300-900 km glow.
      // A pure function of the journey time (deterministic, seekable); the haze shell draws the glows.
      const tt = frame.t ?? 0;
      shared.uStorm.value.forEach((st, i) => {
        const T0 = 2.3 + 1.7 * i;
        const ph = ((tt / T0 + i * 0.37) % 1 + 1) % 1;
        const k = Math.floor(ph / 0.032), sf = ph / 0.032 - k;
        const hh = [0, 1, 2].map((c) => { const x = Math.sin((i * 127.1 + k * 311.7 + Math.floor(tt / T0) * 74.7 + c * 19.19) * 1.0) * 43758.5453; return x - Math.floor(x); });
        const on = ph < 0.16 ? THREE.MathUtils.smoothstep(sf, 0, 0.08) * Math.exp(-sf * 5) * (0.5 + 0.5 * hh[2]) : 0;
        const f = shared.uFlash.value[i].set(st.x + (hh[0] - 0.5) * 0.5 * st.w, st.y + (hh[1] - 0.5) * 0.5 * st.w, st.z + (hh[2] - 0.5) * 0.5 * st.w, 0);
        const l = Math.hypot(f.x, f.y, f.z);
        f.set(f.x / l, f.y / l, f.z / l, on);
        if (i < 4) shared.uFlashR.value.setComponent(i, 300 + 600 * hh[1]);
      });
      bodyQuaternion('jupiter', d, qSpin);
      globe.quaternion.copy(qSpin);
      shared.uRot.value.setFromMatrix4(m4.makeRotationFromQuaternion(qSpin));
      shared.uPoleW.value.set(0, 1, 0).applyQuaternion(qPole);
      // Sun relative to Jupiter's centre (universe coords: Sun at origin)
      shared.uSunJ.value.copy(frame.positions.jupiter).negate();

      const dd = d - epochDays;
      shared.uDt.value = dd;
      flowClock(dd, CLOCK_L.rest, CLOCK_L.cycle, CLOCK_L.sharp, clkL);
      flowClock(dd, CLOCK_S.rest, CLOCK_S.cycle, CLOCK_S.sharp, clkS);
      // the deck shader evaluates one long-clock phase: the dominant one (x = its tau)
      const kL = clkL.w[0] >= clkL.w[1] ? 0 : 1;
      const tL = clkL.tau[kL], tG = 1.2 * Math.tanh(tL / 1.2), tB = Math.tanh(tL);
      shared.uClkL.value.set(tL, tG, tB, 0);
      shared.uVcs.value.set(Math.cos(0.6 * tG), Math.sin(0.6 * tG), Math.cos(0.84 * tB), Math.sin(0.84 * tB));
      shared.uClkS.value.set(clkS.tau[0], clkS.tau[1], clkS.w[0], clkS.w[1]);
      const fr = (x) => x - Math.floor(x);
      shared.uSeedS.value.set(
        fr(seedOf(clkS.n[0], 0)), fr(seedOf(clkS.n[0], 1)),
        fr(seedOf(clkS.n[1], 0)), fr(seedOf(clkS.n[1], 1)));

      moons.update(frame);
      haze.update(frame);
    },
  };
}
