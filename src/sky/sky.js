// The real sky: Yale BSC5 stars + a procedural faint field, and a Milky Way reconstructed from NASA COBE/DIRBE and
// IRAS all-sky surveys (see assets-src/scripts/build_milkyway.py), with nebulae, the Magellanic Clouds and Andromeda.
//
// Radiometry: every star is an energy-conserving PSF whose integrated pixel energy is K * 10^(-0.4 V) (scaled for the
// pixel solid angle), so its brightness relative to the diffuse Milky Way is physical: a diffuse source of surface
// brightness mu (mag/arcsec^2) gives K * Omega_ref * 10^(-0.4 mu) per pixel. Galaxies and clusters carry exactly the
// light of their integrated V magnitude. Everything is scaled by U.uSkyGain.
//
// Warp (U.uWarp > 0): relativistic aberration with beta = 0.9 uWarp along the camera velocity (stars crowd toward the
// apex), Doppler-shifted blackbody colours (T' = delta T: bluer ahead, redder behind), a tempered delta^p brightness
// change, and motion streaks equal to the apparent displacement over a small change of beta.
import * as THREE from 'three';
import { DEG, radecToThree } from '../core/astro.js';
import { bvToTemp, makeColourLUT, T_MAX, T_MIN } from './colour.js';
import { OBJECTS } from './catalog.js';
import { MW_FRAG, MW_VERT, STAR_FRAG, STAR_VERT } from './shaders.js';
import { makeField } from './field.js';
import { makeNoiseTile, makeStarTile } from './tiles.js';

// ------------------------------------------------------------------------------------------------ calibration
export const CAL0 = {
  K: 300, //            pixel-sum energy of a V = 0 star at the reference scale (fov 50 deg over 900 px)
  FOV_Q: 0.5, //        1 = physical pixel-solid-angle scaling across fov; <1 tempers it (wide shots keep their stars)
  MW_BOOST: 5.5, //     perceptual/photographic boost of all diffuse light relative to stars (~1.6 mag)
  MAG_PIVOT: 2.5, //    photographic response of the stars: fluxes below this magnitude are compressed ...
  MAG_GAMMA: 0.66, //   ... to flux^MAG_GAMMA (1 = linear), so the deep field shows without the bright stars burning out
  MAG_FAINT: 0.06, //    extra dimming (mag per mag) of the procedural field below V = 8 (depth: dust, not salt)
  HALO_SAT: 1.5, //     chroma of a star's halo relative to its core
  FIELD_DENS: 0.55, //  flattening of the deep field's plane-to-pole density contrast (1 = follows the starlight)
  CUT: 6e-4, //         a star's quad ends where its image falls below this
  SIGMA: 0.8, //        PSF core sigma in CSS px (energy-conserving floor: faint stars dim, they never shrink)
  GROW_P: 0.42, //      above saturation the visible core widens like a photographic star image (energy conserved)
  HALO_F: 0.14, //      fraction of each star's light in the Moffat halo (x1.8 for the brightest stars)
  HALO_A: 4.5,
  HALO_B: 1.65,
  HALO_MAX: 56,
  THRESH: 1.2e-4, //    cull stars whose brightest pixel is below this
  SAT_STAR: 0.95,
  SAT_MAG: 4.5, //      stars fainter than this progressively lose chroma
  SAT_MW: 0.9,
  ADAPT: 12, //         adaptation to sunlit bodies: sky gain / (1 + ADAPT x lit share of the frame) ...
  ADAPT_MIN: 0.3, //    ... never below this
  SHOULDER: 1.6, //     displayed radiance where the diffuse light's shoulder sets in (the star clouds never clip)
  WARP_DIM: 0.5, //    at full warp the field stars lose this many magnitudes per magnitude below V = 6
  SAT_OBJ: 1.0,
  NEB: 1.5, //          brightness of the bright (sprite) emission nebulae: small vivid glints ...
  GAL: 1.3, //          ... and of the galaxies, relative to the Milky Way's diffuse light
  MW_GAMMA: 1.0,  //    compress the Milky Way's internal contrast (stretch), about the Sagittarius star cloud
  OBJ_GAMMA: 0.68, //   extra photographic stretch of the structure-sprite nebulae (their faint outer structure shows)
  SHARP: 0.5, //       log-tau unsharp mask
  FIL: 0.9, //          dust filaments: e-folds of tau on a ridge of the filament noise
  FIL2: 0.6, //         ... relative strength of the second (finer, sheared) layer
  FIL_N: 8, //          filament tile repeats around the Galactic plane (integer)
  FIL_S: 2.2, //        elongation of the filaments along the plane
  FIL_WARP: 3.0, //     domain warp of the dust map by the tile's fBm (IRAS texels)
  RED_K: 1.3, //        reddening of the starlight by the dust (1 = standard extinction curve)
  NEAR_K: 1.5, //       scale of the near-star light cap (the foreground stars inside the plane's dark lanes)
  F_EXT: 0.12, //       fraction of the foreground column in front of the nearest stars
  EDGE2: 1.5, //        steepening of ln tau about the visual cloud edge (tau = EDGE2_TAU), footprint-limited
  EDGE2_TAU: 2.0,
  TAU_CAP: 3.0, //      small dark clouds: their optical depth above the ~2 deg column saturates at about this
  GATE: [0.0008, 0.006], // displayed diffuse brightness over which the procedural detail fades in
  GRAIN: 0.42, //        share of the diffuse starlight shown as resolved points (star-dust tile)
  CLUMP: 0.6, //        gain of the minified (clumping) octaves of the tile
  GRAIN_JIT: 0.05, //   colour scatter of the grain stars
  GRAIN_A0: 0.0024, //  texel angle (rad) of the coarsest star-tile octave; each octave halves it
  TILE: [0.12, 1.3, 15, 0.62], // star tile: stars per texel, Pareto index of the fluxes, flux range, PSF sigma (texels)
  T_DISK: 7600, //      diffuse-light population colour temperatures (white point 6000 K)
  T_BULGE: 4700,
  BULGE_LIFT: 1.5, //   extra light of the bulge population (the inner Galaxy swells and outshines the disk)
  DISK_VJ: 1.5, //      visible/near-IR light ratio of the disk relative to the bulge (colour V-J ~0.45 mag bluer)
  DGL: 0.25, //         diffuse galactic light (dust-scattered starlight) strength
  BULGE: [13.0, 3.6, 3.0, 0.15], // bulge light missing from the saturated layer: amplitude, l / b scales (deg), bar
  BULGE_K: [0.6, 2.0], //  bulge screen: fraction of the column away from the mid-plane, in the mid-plane
  DOP_P: 1.4, //        tempered Doppler brightness exponent for stars, approaching side (bolometric would be 4)
  DOP_REC: [1.4, 0.25], // receding side: exponent and brightness floor (the trailing sky reddens, never goes black)
  DOP_P_MW: 0.9, //     ... and for the diffuse Milky Way
  DOP_REC_MW: [1.2, 0.3],
  DOP_T: 0.6, //        colour temperature shift T' = T * delta^DOP_T (1 = physical)
  BETA_MAX: 0.65,
  STREAK: 0.025, //     streak = apparent displacement over a change of beta of STREAK*beta (+ actual d(beta)/dt over 1/40 s)
  STREAK_MAX: 0.05, //  streak length cap (fraction of the frame height), soft
};
let CAL = CAL0;
const REF_FOV = 50, REF_H = 900;
const ARCSEC = 206264.806;
const OMEGA_REF = Math.pow(((2 * Math.tan((REF_FOV / 2) * DEG)) / REF_H) * ARCSEC, 2); // arcsec^2 per pixel

export function galacticAxes() {
  const gN = radecToThree(192.85948 * DEG, 27.12825 * DEG);
  const gC = radecToThree(266.405 * DEG, -28.93617 * DEG);
  gC.addScaledVector(gN, -gC.dot(gN)).normalize();
  const gY = new THREE.Vector3().crossVectors(gN, gC).normalize();
  return { gC, gY, gN };
}

function tangentFrame(raDeg, decDeg) {
  const c = radecToThree(raDeg * DEG, decDeg * DEG);
  const e = 1e-4;
  const n = radecToThree(raDeg * DEG, (decDeg + (decDeg > 89 ? -1 : 1) * e) * DEG).sub(c);
  if (decDeg > 89) n.negate();
  n.addScaledVector(c, -n.dot(c)).normalize();
  const east = new THREE.Vector3().crossVectors(n, c).normalize(); // cross(c, east) = north  =>  east = n x c
  return { c, n, east };
}

// BSC5 lists the components of close doubles separately (alpha Cru, alpha Cen, gamma Vir...): a camera records one
// image with the combined light, so components closer than ~20 arcsec are merged (flux-weighted colour).
function mergeCloseDoubles(dir, mag, temp, n) {
  const S = 3000; // cell ~69 arcsec
  const cell = new Map();
  const lim = Math.cos((20 / 3600) * DEG);
  for (let i = 0; i < n; i++) {
    const cx = Math.round(dir[i * 3] * S), cy = Math.round(dir[i * 3 + 1] * S), cz = Math.round(dir[i * 3 + 2] * S);
    let merged = false;
    for (let dx = -1; dx <= 1 && !merged; dx++)
      for (let dy = -1; dy <= 1 && !merged; dy++)
        for (let dz = -1; dz <= 1 && !merged; dz++) {
          const list = cell.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!list) continue;
          for (const j of list) {
            const d = dir[i * 3] * dir[j * 3] + dir[i * 3 + 1] * dir[j * 3 + 1] + dir[i * 3 + 2] * dir[j * 3 + 2];
            if (d > lim && mag[j] < 90) {
              const fi = Math.pow(10, -0.4 * mag[i]), fj = Math.pow(10, -0.4 * mag[j]);
              temp[j] = (temp[j] * fj + temp[i] * fi) / (fi + fj);
              mag[j] = -2.5 * Math.log10(fi + fj);
              mag[i] = 99; // culled by the brightness threshold
              merged = true;
              break;
            }
          }
        }
    if (!merged) {
      const k = `${cx},${cy},${cz}`;
      if (!cell.has(k)) cell.set(k, []);
      cell.get(k).push(i);
    }
  }
}

function luminance(c) {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function makeObjectTexture(objects, Kd, sprites) {
  const N = Math.min(64, objects.length);
  const data = new Float32Array(6 * 4 * N);
  const cones = [];
  objects.slice(0, N).forEach((o, i) => {
    const { c, n, east } = tangentFrame(o.ra, o.dec);
    const L = luminance(o.col || [1, 1, 1]);
    let row;
    if (o.kind === 4) {
      // structure sprite: emission peak (mu, or integrated V over the sprite), reflection / starlight peak
      const sp = sprites?.[o.sprite];
      if (!sp) {
        data.set(new Array(24).fill(0).map((v, k) => (k === 15 ? 2 : v)), i * 24); // cosLim 2: never drawn
        cones.push({ dir: c.clone(), ext: 0 });
        return;
      }
      const hx = sp.half[0] * DEG, hy = sp.half[1] * DEG;
      const nb = o.sprite === 'lmc' ? 1 : CAL.NEB;
      const pe = nb * (o.V !== undefined ? (Kd * Math.pow(10, -0.4 * o.V)) / Math.max(sp.emInt, 1) : Kd * Math.pow(10, -0.4 * (o.mu ?? 99))) * CAL.MW_BOOST;
      const pr = (o.sprite === 'lmc' ? CAL.GAL : 1) * (o.VR !== undefined ? (Kd * Math.pow(10, -0.4 * o.VR)) / Math.max(sp.rfInt, 1) : Kd * Math.pow(10, -0.4 * (o.muR ?? 99))) * CAL.MW_BOOST;
      const cr = o.colR || [1, 1, 1];
      const LR = luminance(cr);
      const ext = Math.hypot(hx, hy) * 1.02;
      row = [
        c.x, c.y, c.z, hx,
        (o.col[0] / L) * pe, (o.col[1] / L) * pe, (o.col[2] / L) * pe, (i * 1.618) % 7,
        east.x, east.y, east.z, hy,
        4, o.stretch ?? CAL.OBJ_GAMMA, o.noise || 0, Math.cos(ext),
        sp.cell[0], sp.cell[1], sp.cell[2], sp.cell[3],
        (cr[0] / LR) * pr, (cr[1] / LR) * pr, (cr[2] / LR) * pr, o.dust ?? 1,
      ];
      cones.push({ dir: c.clone(), ext });
    } else {
      const pa = (o.pa || 0) * DEG;
      const major = n.clone().multiplyScalar(Math.cos(pa)).addScaledVector(east, Math.sin(pa)).normalize();
      const q = o.q || 1;
      const rRad = o.r * DEG;
      let peak;
      if (o.V !== undefined) {
        const rAs = o.r * 3600;
        peak = (Kd * Math.pow(10, -0.4 * o.V)) / (2 * Math.PI * rAs * rAs * q);
      } else peak = Kd * Math.pow(10, -0.4 * o.mu);
      peak *= CAL.MW_BOOST * (o.kind === 2 ? CAL.GAL : 1);
      const ext = o.kind === 0 ? (o.ring ? o.ring + 3 * (o.rw || 0.2) : 3.0) : o.kind === 1 ? 4.5 : o.kind === 2 ? 8 : 18;
      const cosLim = Math.cos(Math.min(85, ext * o.r) * DEG);
      let sx = 0, sy = 0, ss = 0;
      if (o.side) {
        const d = (o.side[0] - (o.pa || 0)) * DEG;
        sx = Math.cos(d);
        sy = -Math.sin(d);
        ss = o.side[1];
      }
      row = [
        c.x, c.y, c.z, rRad,
        (o.col[0] / L) * peak, (o.col[1] / L) * peak, (o.col[2] / L) * peak, (i * 1.618) % 7,
        major.x, major.y, major.z, q,
        o.kind, o.ring || 0, o.noise || 0, cosLim,
        sx, sy, ss, o.kind === 2 ? (o.lane ? 1 : 0) : o.rw || 0.2,
        o.streak || 0, 0, 0, 0,
      ];
      cones.push({ dir: c.clone(), ext: Math.min(85, ext * o.r) * DEG });
    }
    data.set(row, i * 24);
  });
  const tex = new THREE.DataTexture(data, 6, N, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { tex, count: N, cones };
}

export async function create(ctx) {
  const { U, assets } = ctx;
  const group = new THREE.Group();
  group.name = 'sky';
  const axes = galacticAxes();
  const w2g = new THREE.Matrix3().set(
    axes.gC.x, axes.gC.y, axes.gC.z,
    axes.gY.x, axes.gY.y, axes.gY.z,
    axes.gN.x, axes.gN.y, axes.gN.z
  );
  const lut = makeColourLUT(1.0);
  const lutRange = new THREE.Vector2(Math.log(T_MIN), 1 / Math.log(T_MAX / T_MIN));

  // ---------------------------------------------------------------- data
  const [starBuf, meta, mwTex, dustTex, nebTex, nebMeta] = await Promise.all([
    assets.loadBinary('sky/stars.bin'),
    assets.loadJSON('sky/milkyway.json').catch(() => null),
    assets.loadTextureOptional('sky/milkyway.webp', { srgb: false, mipmaps: false, anisotropy: 1, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping }),
    assets.loadTextureOptional('sky/dust.webp', { srgb: false, mipmaps: true, anisotropy: 1, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping }),
    assets.loadTextureOptional('sky/nebulae.webp', { srgb: false, mipmaps: true, anisotropy: 1, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping }),
    assets.loadJSON('sky/nebulae.json').catch(() => null),
  ]);
  // debug switches (URL, sky only): skyDbg=nofield,nobsc,nores,nodetail ; skyCal=KEY:value,... overrides CAL
  const QS = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const DBG = new Set((QS.get('skyDbg') || '').split(','));
  CAL = { ...CAL0 };
  for (const kv of (QS.get('skyCal') || '').split(',').filter(Boolean)) {
    const [k, v] = kv.split(':');
    const [ka, ia] = k.split('.'); // array entries: KEY.i:value
    if (ia !== undefined && Array.isArray(CAL[ka])) (CAL[ka] = CAL[ka].slice())[Number(ia)] = Number(v);
    else if (k in CAL && typeof CAL[k] === 'number') CAL[k] = Number(v);
  }
  const enc = meta || { radMin: 2e-5, radMax: 1, tauMin: 0.003, tauMax: 30, latK: 2.6 };
  let mw = mwTex;
  if (mw) {
    mw.minFilter = THREE.LinearFilter;
    mw.magFilter = THREE.LinearFilter;
    mw.needsUpdate = true;
  } else {
    mw = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1); // decodes to ~0 radiance: objects and stars only
    mw.needsUpdate = true;
  }
  let dust = dustTex;
  if (!dust) {
    dust = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    dust.needsUpdate = true;
  }
  const dustSize = new THREE.Vector2(dust.image?.width || 1, dust.image?.height || 1);
  let neb = nebTex;
  if (!neb) {
    neb = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    neb.needsUpdate = true;
  }
  const nebSize = new THREE.Vector2(neb.image?.width || 1, neb.image?.height || 1);

  // ---------------------------------------------------------------- shared uniforms
  const shared = {
    uSkyGain: { value: 1 }, // U.uSkyGain x the sky's own adaptation to sunlit bodies in the frame (see update)
    uLUT: { value: lut },
    uLUTRange: { value: lutRange },
    uBeta: { value: 0 },
    uVelDir: { value: new THREE.Vector3(0, 0, -1) },
    uDopP: { value: CAL.DOP_P },
    uDopT: { value: CAL.DOP_T },
  };

  // faint field: deep enough (to V ~10.6 at high quality) that most of it sits near the visual floor and merges into
  // the star-cloud texture; the resolved star clouds continue its luminosity function below that limit
  const FQ = { low: [300000, 11.0], med: [650000, 11.7], high: [1300000, 12.3] }[ctx.quality] ?? [1300000, 12.3];
  // ---------------------------------------------------------------- Milky Way shell
  const Kd = CAL.K * OMEGA_REF; // pixel radiance per (flux per arcsec^2)
  // texture radiance unit: the Sagittarius star cloud (~0.86 in the texture) has mu_V ~ 20.0 mag/arcsec^2
  const mwK = (Kd * Math.pow(10, -0.4 * 20.0)) / 0.86 * CAL.MW_BOOST;
  // structure sprites replace their analytic stand-ins (kept as `fallback` entries if the atlas is missing)
  const useSprites = !!(nebTex && nebMeta?.sprites);
  const objList = OBJECTS.filter((o) => (useSprites ? !o.fallback && (o.kind !== 4 || nebMeta.sprites[o.sprite]) : o.kind !== 4));
  const obj = makeObjectTexture(objList, Kd, nebMeta?.sprites);
  // procedural tiles (deterministic): star dust for the resolved star clouds, noise for the dust filaments
  const tGen0 = performance.now();
  const starTile = makeStarTile({ size: ctx.quality === 'low' ? 512 : 1024, density: CAL.TILE[0], alpha: CAL.TILE[1], range: CAL.TILE[2], sigma: CAL.TILE[3] });
  const noiseTile = makeNoiseTile({ size: 512 });
  const tGen1 = performance.now();
  const mwMat = new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      tMW: { value: mw },
      tDust: { value: dust },
      uDustTex: { value: dustSize },
      uResR: { value: enc.resR ?? 3.5 },
      uNear: { value: new THREE.Vector4(enc.fNear?.[0] ?? 0.136, (enc.fNear?.[1] ?? 0.03) * CAL.NEAR_K, enc.cap0 ?? 0.8, enc.capB ?? 12) },
      uNear2: { value: new THREE.Vector2(enc.capL ?? 0.4, enc.P ?? 1.25) },
      tNeb: { value: neb },
      uNebSize: { value: nebSize },
      tObj: { value: obj.tex },
      uObjCount: { value: 0 },
      uObjIdx: { value: new Int32Array(32) },
      uW2G: { value: w2g },
      uRadLn: { value: new THREE.Vector2(Math.log(enc.radMin), Math.log(enc.radMax)) },
      uTauLn: { value: new THREE.Vector2(Math.log(enc.tauMin), Math.log(enc.tauMax)) },
      uLatK: { value: enc.latK ?? 2.6 },
      uSinhK: { value: Math.sinh(enc.latK ?? 2.6) },
      uMWK: { value: mwK },
      uObjToTex: { value: 1 / mwK },
      uSat: { value: CAL.SAT_MW },
      uSatObj: { value: CAL.SAT_OBJ },
      uSharp: { value: CAL.SHARP },
      uFExt: { value: CAL.F_EXT },
      uTauCap: { value: CAL.TAU_CAP },
      uEdge2: { value: new THREE.Vector2(CAL.EDGE2, Math.log(CAL.EDGE2_TAU)) },
      uPop: { value: new THREE.Vector3(CAL.T_DISK, CAL.T_BULGE, CAL.DGL) },
      uDiskVJ: { value: CAL.DISK_VJ },
      uBulgeLift: { value: CAL.BULGE_LIFT },
      uMWGamma: { value: CAL.MW_GAMMA },
      uObjGamma: { value: CAL.OBJ_GAMMA },
      uExpo: U.uExposure,
      uDetail: { value: DBG.has('nodetail') ? 0 : 1 },
      uGate: { value: new THREE.Vector2(...CAL.GATE) },
      uRedK: { value: CAL.RED_K },
      uShoulder: { value: CAL.SHOULDER },
      uDopP: { value: CAL.DOP_P_MW },
      tStar: { value: starTile.tex },
      uStarT: { value: new THREE.Vector4(CAL.GRAIN_A0, 1 / starTile.size, starTile.vmax, 0) },
      uGrainN: { value: DBG.has('nores') ? 0 : ({ low: 5, med: 6 }[ctx.quality] ?? 7) },
      uGrain: { value: new THREE.Vector4(CAL.GRAIN, CAL.CLUMP, CAL.GRAIN_JIT, 0.12) },
      tNoise: { value: noiseTile.tex },
      uFil: { value: new THREE.Vector4(CAL.FIL_N, CAL.FIL_S, CAL.FIL, CAL.FIL_WARP) },
      uFilM: { value: new THREE.Vector4(noiseTile.mean[0], noiseTile.mean[1], noiseTile.size, CAL.FIL2) },
      uBulge: { value: new THREE.Vector4(...CAL.BULGE) },
      uBulgeK: { value: new THREE.Vector2(...CAL.BULGE_K) },
      uDopRec: { value: new THREE.Vector2(...CAL.DOP_REC_MW) },
    },
    vertexShader: MW_VERT,
    fragmentShader: MW_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    transparent: false,
  });
  const shell = new THREE.Mesh(new THREE.SphereGeometry(1e7, 96, 48), mwMat);
  shell.name = 'milkyway';
  shell.frustumCulled = false;
  shell.renderOrder = -1000;
  group.add(shell);

  // ---------------------------------------------------------------- stars
  // One shared material; the catalogue stars are one instanced mesh (never culled), the deep procedural field is
  // sorted into sky patches (cube faces x PG x PG) that are switched on only when they can touch the view, so the
  // field can be several times deeper than a single always-drawn buffer could afford.
  const dv = new DataView(starBuf);
  const nBSC = dv.getUint32(0, true);
  const nField = DBG.has('nofield') ? 0 : FQ[0];
  const tGenF = performance.now();
  const field = makeField({ image: mwTex?.image || null, dust: dustTex?.image || null, meta: enc, axes, count: nField, mMax: FQ[1], densPow: CAL.FIELD_DENS });
  const tGen2 = performance.now();
  if (DBG.has('log')) console.warn(`[sky] tiles ${(tGen1 - tGen0).toFixed(0)} ms, field ${(tGen2 - tGenF).toFixed(0)} ms (${field.count} stars)`);
  if (DBG.has('log')) { let h = [0,0,0,0,0,0,0,0]; for (let i = 0; i < field.count; i++) h[Math.max(0, Math.min(7, Math.floor(field.mag[i] - 6)))]++; console.warn('[sky] field mags 6..13+', JSON.stringify(h), dustTex?.image?.width, mwTex?.image?.width); }
  // attribute encoding shared by both: aMT = ((V - MAG0) / MAGR, ln(T / T_MIN) / ln(T_MAX / T_MIN))
  const MAG0 = 6, MAGR = 9;
  const tEnc = (T) => Math.log(Math.min(T_MAX, Math.max(T_MIN, T)) / T_MIN) / Math.log(T_MAX / T_MIN);
  const quadPos = new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3);
  const quadCorner = new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2);
  const quadIndex = new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);
  const starGeo = (aDir, aMT, n) => {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', quadPos);
    geo.setAttribute('corner', quadCorner);
    geo.setIndex(quadIndex);
    geo.setAttribute('aDir', aDir);
    geo.setAttribute('aMT', aMT);
    geo.instanceCount = n;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    return geo;
  };

  const haloN = (CAL.HALO_B - 1) / (Math.PI * CAL.HALO_A * CAL.HALO_A);
  const starU = {
    ...shared,
    uRes: { value: new THREE.Vector2(1, 1) },
    uK: { value: CAL.K },
    uSigma: { value: CAL.SIGMA },
    uHaloF: { value: CAL.HALO_F },
    uHaloA: { value: CAL.HALO_A },
    uHaloB: { value: CAL.HALO_B },
    uHaloN: { value: haloN },
    uHaloMax: { value: CAL.HALO_MAX },
    uThresh: { value: CAL.THRESH },
    uStreakDB: { value: 0 },
    uStreakMax: { value: CAL.STREAK_MAX },
    uDopRec: { value: new THREE.Vector2(...CAL.DOP_REC) },
    uSat: { value: CAL.SAT_STAR },
    uSatMag: { value: CAL.SAT_MAG },
    uGrowE: { value: 2 * Math.PI * CAL.SIGMA * CAL.SIGMA },
    uGrowP: { value: CAL.GROW_P },
    uMagC: { value: new THREE.Vector3(CAL.MAG_PIVOT, CAL.MAG_GAMMA, CAL.MAG_FAINT) },
    uHaloSat: { value: CAL.HALO_SAT },
    uDec: { value: new THREE.Vector4(MAG0, MAGR, Math.log(T_MIN), Math.log(T_MAX / T_MIN)) },
    uCut: { value: CAL.CUT },
    uWarpDim: { value: 0 },
  };
  const starMat = new THREE.ShaderMaterial({
    uniforms: starU,
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    transparent: false,
  });
  const addStars = (geo, name) => {
    const m = new THREE.Mesh(geo, starMat);
    m.name = name;
    m.frustumCulled = false;
    m.renderOrder = -999;
    group.add(m);
    return m;
  };

  // catalogue stars (BSC5)
  {
    const dir = new Float32Array(nBSC * 3), mag = new Float32Array(nBSC), temp = new Float32Array(nBSC);
    const v = new THREE.Vector3();
    for (let i = 0; i < nBSC; i++) {
      const o = 4 + i * 16;
      radecToThree(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), v);
      dir[i * 3] = v.x;
      dir[i * 3 + 1] = v.y;
      dir[i * 3 + 2] = v.z;
      mag[i] = dv.getFloat32(o + 8, true);
      temp[i] = bvToTemp(dv.getFloat32(o + 12, true));
    }
    mergeCloseDoubles(dir, mag, temp, nBSC);
    if (DBG.has('nobsc')) mag.fill(99);
    const mt = new Float32Array(nBSC * 2);
    for (let i = 0; i < nBSC; i++) {
      mt[i * 2] = (mag[i] - MAG0) / MAGR;
      mt[i * 2 + 1] = tEnc(temp[i]);
    }
    addStars(starGeo(new THREE.InstancedBufferAttribute(dir, 3), new THREE.InstancedBufferAttribute(mt, 2), nBSC), 'stars');
  }

  // deep field, in patches: directions as normalised int16 (6 arcsec), magnitude and temperature as bytes
  const PG = 4, NP = 6 * PG * PG;
  const patches = [];
  if (field.count > 0) {
    const fd = field.dir, n = field.count;
    const pid = new Uint8Array(n), cnt = new Uint32Array(NP);
    for (let i = 0; i < n; i++) {
      const x = fd[i * 3], y = fd[i * 3 + 1], z = fd[i * 3 + 2];
      const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
      let f, a, b, m;
      if (ax >= ay && ax >= az) { f = x > 0 ? 0 : 1; m = ax; a = y; b = z; }
      else if (ay >= az) { f = y > 0 ? 2 : 3; m = ay; a = x; b = z; }
      else { f = z > 0 ? 4 : 5; m = az; a = x; b = y; }
      // (equal-angle cube: cells of nearly equal size)
      const u = Math.min(PG - 1, Math.floor((Math.atan(a / m) * (2 / Math.PI) + 0.5) * PG));
      const w = Math.min(PG - 1, Math.floor((Math.atan(b / m) * (2 / Math.PI) + 0.5) * PG));
      cnt[(pid[i] = (f * PG + w) * PG + u)]++;
    }
    const start = new Uint32Array(NP + 1);
    for (let k = 0; k < NP; k++) start[k + 1] = start[k] + cnt[k];
    const fill = start.slice(0, NP);
    const dirS = new Int16Array(n * 3), mtS = new Uint8Array(n * 2);
    const cx = new Float64Array(NP * 3);
    for (let i = 0; i < n; i++) {
      const k = pid[i], j = fill[k]++;
      dirS[j * 3] = Math.round(fd[i * 3] * 32767);
      dirS[j * 3 + 1] = Math.round(fd[i * 3 + 1] * 32767);
      dirS[j * 3 + 2] = Math.round(fd[i * 3 + 2] * 32767);
      mtS[j * 2] = Math.max(0, Math.min(255, Math.round(((field.mag[i] - MAG0) / MAGR) * 255)));
      mtS[j * 2 + 1] = Math.round(tEnc(field.temp[i]) * 255);
      cx[k * 3] += fd[i * 3];
      cx[k * 3 + 1] += fd[i * 3 + 1];
      cx[k * 3 + 2] += fd[i * 3 + 2];
    }
    const cdir = [], cmin = new Float64Array(NP).fill(1);
    for (let k = 0; k < NP; k++) cdir.push(new THREE.Vector3(cx[k * 3], cx[k * 3 + 1], cx[k * 3 + 2]).normalize());
    for (let i = 0; i < n; i++) {
      const c = cdir[pid[i]];
      const d = fd[i * 3] * c.x + fd[i * 3 + 1] * c.y + fd[i * 3 + 2] * c.z;
      if (d < cmin[pid[i]]) cmin[pid[i]] = d;
    }
    for (let k = 0; k < NP; k++) {
      if (!cnt[k]) continue;
      const a = new THREE.InstancedBufferAttribute(dirS.subarray(start[k] * 3, start[k + 1] * 3), 3, true);
      const b = new THREE.InstancedBufferAttribute(mtS.subarray(start[k] * 2, start[k + 1] * 2), 2, true);
      patches.push({ mesh: addStars(starGeo(a, b, cnt[k]), 'starfield'), dir: cdir[k], ext: Math.acos(Math.max(-1, Math.min(1, cmin[k]))) });
    }
  }

  // ---------------------------------------------------------------- test overrides (URL)
  //   skyWarp=<0..1>        force the sky's warp amount (aberration / Doppler / streaks) in any view
  //   skyVel=<ra,dec>       direction of travel for skyWarp, J2000 degrees (default: the view axis)
  //   skyStreak=<dbeta>     force the streak length (change of beta per exposure)
  const qp = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const OV = {
    warp: qp.has('skyWarp') ? Number(qp.get('skyWarp')) : null,
    vel: qp.has('skyVel') ? qp.get('skyVel').split(',').map(Number) : null,
    streak: qp.has('skyStreak') ? Number(qp.get('skyStreak')) : null,
  };

  // ---------------------------------------------------------------- per frame
  const vel = new THREE.Vector3();
  const camFwd = new THREE.Vector3();
  const abDir = new THREE.Vector3();
  const lastDir = new THREE.Vector3(0, 0, -1);
  function velocityDirection(frame) {
    vel.copy(U.uCamVelW.value);
    const dir = ctx.director;
    if (vel.lengthSq() < 1e-10 && dir && dir.evaluate && frame.shot && frame.shot.warp > 0) {
      try {
        const h = 0.05;
        const a = dir.evaluate(Math.max(0, frame.t - h)).camPos;
        const b = dir.evaluate(frame.t + h).camPos;
        vel.copy(b).sub(a);
      } catch (e) {
        vel.set(0, 0, 0);
      }
    }
    if (vel.lengthSq() < 1e-10) {
      // no motion information: travel along the view axis
      vel.set(0, 0, -1).applyQuaternion(frame.camera.quaternion);
    }
    return lastDir.copy(vel).normalize();
  }
  function warpRate(frame) {
    const dir = ctx.director;
    if (!dir || !dir.evaluate) return 0;
    try {
      const h = 0.1;
      return Math.abs((dir.evaluate(frame.t + h).warp ?? 0) - (dir.evaluate(Math.max(0, frame.t - h)).warp ?? 0)) / (2 * h);
    } catch (e) {
      return 0;
    }
  }

  // Adaptation: an exposure that holds a sunlit world holds fewer stars. The share of the frame covered by sunlit
  // discs (planets and moons; phase-weighted) dims the whole sky, smoothly, down to ADAPT_MIN; the empty transits
  // between worlds get the full dark-adapted sky. A pure function of the frame.
  const bv = new THREE.Vector3(), bm = new THREE.Vector3();
  function litCoverage(frame) {
    const bodies = frame.bodies;
    const cam = frame.camera, camU = frame.camUniverse;
    if (!bodies || !camU) return 0;
    const tanV = Math.tan(((cam.fov ?? 35) / 2) * DEG), A = cam.aspect || 16 / 9;
    let S = 0;
    const one = (pos, R, kFixed) => {
      bv.copy(pos).sub(camU);
      const d = bv.length();
      if (!(d > R * 1.0001)) return;
      // lit fraction of the disc from the phase angle (Sun - body - camera); the Sun is at the universe origin
      const cosA = (bv.x * pos.x + bv.y * pos.y + bv.z * pos.z) / (d * Math.max(pos.length(), 1e-9));
      const k = kFixed ?? 0.5 * (1 + Math.max(-1, Math.min(1, cosA)));
      bm.copy(bv).applyQuaternion(camInv);
      if (bm.z > -1e-9 && d > 3 * R) return;
      const z = Math.max(-bm.z, 0.2 * R);
      const r = R / Math.sqrt(Math.max(d * d - R * R, 1e-12)) / tanV; // disc radius, units of the half-height
      const x = bm.x / z / tanV, y = bm.y / z / tanV;
      const ox = Math.max(0, Math.min(x + r, A) - Math.max(x - r, -A)), oy = Math.max(0, Math.min(y + r, 1) - Math.max(y - r, -1));
      if (ox <= 0 || oy <= 0) return;
      const area = Math.min(Math.PI * r * r * (ox / (2 * r)) * (oy / (2 * r)), ox * oy);
      S += (k * area) / (4 * A);
    };
    for (const id in bodies) {
      if (id === 'sun') continue;
      const b = bodies[id];
      if (!b || !b.object || !(b.radius > 0)) continue;
      one(b.object.position, b.radius);
      // Saturn's rings are bright at every phase (back-scatter, or forward-scatter in the eclipse shot)
      if (id === 'saturn') one(b.object.position, b.radius * 2.27, 0.3);
      if (b.moons)
        for (const m of b.moons) {
          if (!m.positionAt || !(m.radius > 0)) continue;
          one(bm2.copy(b.object.position).add(m.positionAt(frame.simDays)), m.radius);
        }
    }
    return S;
  }
  const camInv = new THREE.Quaternion(), bm2 = new THREE.Vector3();

  return {
    object: group,
    cal: CAL,
    update(frame) {
      let adapt = 1;
      if (CAL.ADAPT > 0) {
        try {
          camInv.copy(frame.camera.quaternion).invert();
          adapt = Math.max(CAL.ADAPT_MIN, 1 / (1 + CAL.ADAPT * litCoverage(frame)));
        } catch (e) {
          adapt = 1;
        }
      }
      shared.uSkyGain.value = U.uSkyGain.value * adapt;
      const res = U.uResolution.value;
      const pr = Math.max(1, U.uPixelRatio.value || 1);
      starU.uRes.value.copy(res);
      const fov = frame.camera.fov ?? 35;
      if (DBG.has('log')) console.warn(`[sky] t=${frame.t?.toFixed?.(1)} gain=${U.uSkyGain.value.toFixed(3)} adapt=${adapt.toFixed(2)} exp=${U.uExposure.value.toExponential(2)} fov=${fov.toFixed(1)} warp=${(U.uWarp.value || 0).toFixed(2)}`);
      const pix =((2 * Math.tan((fov / 2) * DEG)) / Math.max(1, res.y)) * ARCSEC;
      const omega = pix * pix;
      const fovFactor = Math.pow(Math.tan((fov / 2) * DEG) / Math.tan((REF_FOV / 2) * DEG), 2 * (1 - CAL.FOV_Q));
      starU.uK.value = CAL.K * (OMEGA_REF / omega) * fovFactor;
      starU.uSigma.value = CAL.SIGMA * pr;
      starU.uGrowE.value = 2 * Math.PI * starU.uSigma.value * starU.uSigma.value;
      starU.uHaloA.value = CAL.HALO_A * pr;
      starU.uHaloN.value = (CAL.HALO_B - 1) / (Math.PI * starU.uHaloA.value * starU.uHaloA.value);
      starU.uHaloMax.value = CAL.HALO_MAX * pr;
      const warp = Math.min(1, Math.max(0, OV.warp ?? U.uWarp.value ?? 0));
      const beta = CAL.BETA_MAX * warp;
      shared.uBeta.value = beta;
      starU.uWarpDim.value = CAL.WARP_DIM * warp;
      if (beta > 1e-4) {
        if (OV.warp !== null) {
          if (OV.vel) radecToThree(OV.vel[0] * DEG, OV.vel[1] * DEG, shared.uVelDir.value);
          else shared.uVelDir.value.set(0, 0, -1).applyQuaternion(frame.camera.quaternion);
          starU.uStreakDB.value = Math.min(beta, OV.streak ?? CAL.STREAK * beta);
        } else {
          shared.uVelDir.value.copy(velocityDirection(frame));
          const rate = warpRate(frame) * CAL.BETA_MAX;
          starU.uStreakDB.value = Math.min(beta, OV.streak ?? CAL.STREAK * beta + rate / 40);
        }
      } else starU.uStreakDB.value = 0;
      // diffuse objects that can touch the view cone. During warp each object is tested where aberration puts it,
      // with its extent scaled by 1/delta (the receding sky is magnified), so the 32-slot list never overflows
      const cam = frame.camera;
      camFwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
      const tanV = Math.tan((fov / 2) * DEG);
      const half = Math.atan(tanV * Math.hypot(1, cam.aspect || 16 / 9));
      const idx = mwMat.uniforms.uObjIdx.value;
      let nv = 0;
      const vd = shared.uVelDir.value;
      const gam = 1 / Math.sqrt(Math.max(1e-6, 1 - beta * beta));
      for (let i = 0; i < obj.cones.length && nv < 32; i++) {
        const cn = obj.cones[i];
        let dir = cn.dir, ext = cn.ext;
        if (beta > 1e-4) {
          const cr = cn.dir.dot(vd);
          const cp = (cr + beta) / (1 + beta * cr);
          abDir.copy(cn.dir).addScaledVector(vd, -cr);
          const pl = abDir.length();
          if (pl > 1e-7) abDir.multiplyScalar(Math.sqrt(Math.max(0, 1 - cp * cp)) / pl);
          abDir.addScaledVector(vd, cp).normalize();
          dir = abDir;
          ext = ext / (gam * (1 + beta * cr));
        }
        if (Math.acos(Math.max(-1, Math.min(1, camFwd.dot(dir)))) < half + ext + 0.02) idx[nv++] = i;
      }
      mwMat.uniforms.uObjCount.value = nv;
      // deep-field patches: the same test (an aberrated patch is tested where it appears, its radius scaled by the
      // largest magnification inside it, plus the streak length)
      for (let i = 0; i < patches.length; i++) {
        const pt = patches[i];
        let dir = pt.dir, ext = pt.ext;
        if (beta > 1e-4) {
          const cr = pt.dir.dot(vd);
          const cp = (cr + beta) / (1 + beta * cr);
          abDir.copy(pt.dir).addScaledVector(vd, -cr);
          const pl = abDir.length();
          if (pl > 1e-7) abDir.multiplyScalar(Math.sqrt(Math.max(0, 1 - cp * cp)) / pl);
          abDir.addScaledVector(vd, cp).normalize();
          dir = abDir;
          const crFar = Math.cos(Math.min(Math.PI, Math.acos(Math.max(-1, Math.min(1, cr))) + ext));
          ext = ext / (gam * (1 + beta * crFar)) + 0.12;
        }
        pt.mesh.visible = Math.acos(Math.max(-1, Math.min(1, camFwd.dot(dir)))) < half + ext + 0.03;
      }
      // nebula chroma eases off in wide fields (small, saturated knots read as stickers at fov > 40)
      mwMat.uniforms.uSatObj.value = CAL.SAT_OBJ * (1 - 0.3 * Math.min(1, Math.max(0, (fov - 20) / 30)));
    },
  };
}
