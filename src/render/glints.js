// Glints: planets and major moons whose discs are smaller than a few pixels stay visible as star-like points.
//
// Photometry: one system, the film's own. Every world is lit by unit irradiance (contract), so its resolved disc
// carries an integrated flux (pixel sum, before exposure) of
//     F_disc(r) = p * Phi(alpha) * pi * r^2          (r = disc radius in drawing-buffer px, p = geometric albedo,
//                                                     Phi = Lambert phase law)
// Below the hand-over radius R_H the point carries the TOTAL flux
//     T(r) = F_disc(R_H) * (r / R_H)^(2 KAPPA)        (KAPPA < 1: a sub-pixel world stays a visible point)
// and the glint supplies T(r) - F_disc(r), the light the (sub-pixel, under-sampled) disc itself cannot. So the summed
// flux of glint + disc rises monotonically as a world is approached, is continuous at R_H (where the glint has
// faded to nothing) and never "deflates" when the disc resolves; far away a world is a point whose brightness
// tracks its albedo and phase (Jupiter a bright one, Mercury a dim one). A moon beside its resolved planet is on
// the same scale, so Io is a faint point next to Jupiter's disc.
//
// PSF: a compact Gaussian (FWHM ~1.3 px) for an unresolved point, widening with the disc as it approaches the
// hand-over (the glint shrinks into the disc instead of sitting on it as a glow). Only a point that would clip
// (peak above PEAK after exposure) widens further and puts a little light into a short halo, so the colour
// survives the tone map; nothing ever becomes a blob.
// Shot controls: shot.glintGain (a "long exposure" multiplier), shot.glintFloor (display-peak floor for planets:
// the finale's labelled points), shot.glintNorm = { id, peak } (scale every glint so that body's peak is `peak`
// after exposure: the pale blue dot, one faint pixel; the others keep their true ratios to it).
//
// Precision / occlusion: positions are computed every frame in double precision relative to the camera (the
// object is re-centred on the camera inside the floating-origin world) and placed just outside the body's near
// side, so a nearer planet or moon hides them (depth-tested) and the body's own shells never do.
import * as THREE from 'three';
import { BODIES, JOURNEY_ORDER } from '../core/bodies-data.js';

// geometric albedo, disc colour (linear, roughly), for planets and the moons that matter
const PHOT = {
  mercury: [0.142, [0.46, 0.41, 0.36]],
  venus: [0.689, [1.0, 0.9, 0.72]],
  earth: [0.434, [0.45, 0.62, 1.0]],
  mars: [0.17, [1.0, 0.52, 0.3]],
  jupiter: [0.538, [1.0, 0.86, 0.68]],
  saturn: [0.499, [1.0, 0.85, 0.6]],
  uranus: [0.488, [0.62, 0.9, 0.98]],
  neptune: [0.442, [0.42, 0.58, 1.0]],
  moon: [0.12, [0.82, 0.76, 0.68]],
  phobos: [0.071, [0.55, 0.5, 0.45]],
  deimos: [0.068, [0.58, 0.53, 0.47]],
  io: [0.63, [1.0, 0.9, 0.55]],
  europa: [0.67, [0.95, 0.88, 0.8]],
  ganymede: [0.43, [0.8, 0.74, 0.68]],
  callisto: [0.2, [0.62, 0.57, 0.52]],
  mimas: [0.96, [0.9, 0.9, 0.9]],
  enceladus: [1.38, [0.92, 0.95, 1.0]],
  tethys: [1.23, [0.92, 0.92, 0.92]],
  dione: [1.0, [0.9, 0.9, 0.9]],
  rhea: [0.95, [0.9, 0.88, 0.86]],
  titan: [0.22, [1.0, 0.7, 0.38]],
  miranda: [0.32, [0.85, 0.85, 0.85]],
  ariel: [0.53, [0.88, 0.88, 0.88]],
  umbriel: [0.26, [0.78, 0.78, 0.8]],
  titania: [0.35, [0.85, 0.82, 0.8]],
  oberon: [0.31, [0.82, 0.78, 0.76]],
  triton: [0.72, [0.95, 0.86, 0.82]],
};
const R_H = 3.0; // px (drawing buffer): hand-over disc radius, where the glint has faded out
const KAPPA = 0.13; // sub-pixel compression of the point's flux (1 = the physical r^2 law)
const SIG_U = 0.55; // core sigma of an unresolved point (device px; FWHM 1.3 px)
const SIG_MAX = 1.8; // widest core of a clipping point (device px)
const HALO_MAX = 0.3; // largest fraction of a clipping point's light moved into its halo
const PEAK = 1.0; // display-linear peak limit (after exposure) of the brightest channel

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const phaseLaw = (a) => (Math.sin(a) + (Math.PI - a) * Math.cos(a)) / Math.PI;

export async function create(ctx) {
  const { U } = ctx;
  // entries: { id, parent, radius, p, col, maxc }
  const list = [];
  for (const id of JOURNEY_ORDER) {
    if (id === 'sun') continue;
    const ph = PHOT[id];
    list.push({ id, parent: null, radius: BODIES[id].radius, p: ph[0], col: ph[1] });
  }
  for (const pid of JOURNEY_ORDER) {
    const moons = BODIES[pid].moons;
    if (!moons) continue;
    for (const mid in moons) {
      const ph = PHOT[mid];
      if (!ph) continue;
      list.push({ id: mid, parent: pid, radius: moons[mid].radius, p: ph[0], col: ph[1] });
    }
  }
  for (const e of list) {
    const l = lum(e.col);
    e.col = e.col.map((c) => c / l);
    e.maxc = Math.max(...e.col);
  }
  const N = list.length;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), psf = new Float32Array(N * 3);
  const g = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aCol = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
  const aSize = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
  const aPsf = new THREE.BufferAttribute(psf, 3).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', aPos);
  g.setAttribute('aCol', aCol);
  g.setAttribute('aSize', aSize);
  g.setAttribute('aPsf', aPsf);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e12);

  const mat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      attribute vec3 aCol;
      attribute float aSize;
      attribute vec3 aPsf; // core sigma (px), halo scale (px), halo fraction
      varying vec3 vCol;
      varying vec3 vPsf;
      varying float vSize;
      void main() {
        vCol = aCol;
        vPsf = aPsf;
        vSize = aSize;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
        gl_PointSize = aSize;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      varying vec3 vPsf;
      varying float vSize;
      void main() {
        // energy-normalised PSF: Gaussian core (+ a short Moffat beta-3 halo for clipping points only); vCol is the
        // total flux (pixel sum). The core is integrated over the pixel (the Gaussian convolved with the pixel's
        // box, approximated by adding 1/12 px^2 to its variance), so a 0.55 px point keeps its energy.
        vec2 d = (gl_PointCoord - 0.5) * vSize;
        float r2 = dot(d, d);
        float s2 = vPsf.x * vPsf.x + 0.0833;
        float core = exp(-0.5 * r2 / s2) / (6.2831853 * s2);
        float hs = vPsf.y;
        float halo = 2.0 / (3.14159265 * hs * hs) / pow(1.0 + r2 / (hs * hs), 3.0);
        float w = (1.0 - vPsf.z) * core + vPsf.z * halo;
        // soft edge of the sprite so the halo never shows a square
        float e = 1.0 - smoothstep(0.42 * vSize, 0.5 * vSize, length(d));
        gl_FragColor = vec4(vCol * w * e, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const points = new THREE.Points(g, mat);
  points.name = 'glints';
  points.frustumCulled = false;
  points.renderOrder = 10; // after the director's orbit lines (5)

  const c = new THREE.Vector3(), toCam = new THREE.Vector3(), toSun = new THREE.Vector3(), tmp = new THREE.Vector3();
  const sunColor = U.uSunColor.value;
  const Fv = new Float64Array(N);

  // total flux of a point (pixel sum, before exposure) and its disc radius in px
  function pointFlux(e, cPos, camU, focal, kappa) {
    toCam.copy(camU).sub(cPos);
    const d = toCam.length();
    const R = e.radius;
    if (!(d > R * 1.5)) return { F: 0, rpx: Infinity };
    const rpx = (R / d) * focal;
    if (rpx >= R_H) return { F: 0, rpx };
    toCam.divideScalar(d);
    toSun.copy(cPos).negate().normalize();
    const a = Math.acos(Math.max(-1, Math.min(1, toCam.dot(toSun))));
    const k = e.p * phaseLaw(a) * Math.PI;
    const T = k * R_H * R_H * Math.pow(rpx / R_H, 2 * kappa);
    const Fd = k * rpx * rpx;
    return { F: Math.max(0, T - Fd), rpx };
  }

  return {
    object: points,
    update(frame) {
      const camU = frame.camUniverse;
      // re-centre the points on the camera: the parent `world` group sits at -camU
      points.position.copy(camU);
      const cam = frame.camera;
      const pr = U.uPixelRatio.value || 1;
      const resY = U.uResolution.value.y || 900; // drawing-buffer pixels (render scale and DPR included)
      const tanH = Math.tan((cam.fov * Math.PI) / 360);
      const focal = resY / 2 / tanH; // drawing-buffer px per radian
      const shot = frame.shot || {};
      let gain = shot.glintGain ?? 1; // director's "long exposure" stretch
      const floor = shot.glintFloor ?? 0;
      const exposure = Math.max(1e-6, shot.exposure ?? 1);
      const sigU = SIG_U * pr;
      // pass 1: positions and fluxes
      for (let k = 0; k < N; k++) {
        const e = list[k];
        let ok = true;
        if (e.parent) {
          const b = frame.bodies[e.parent];
          const m = b?.moons?.find((x) => x.id === e.id);
          if (!m) ok = false;
          else c.copy(frame.positions[e.parent]).add(m.positionAt(frame.simDays));
        } else c.copy(frame.positions[e.id]);
        e._ok = ok;
        e._rpx = Infinity;
        Fv[k] = 0;
        if (!ok) continue;
        // a moon beside its resolved planet is held closer to its true (tiny) flux: a sub-pixel Io must not out-shine
        // Jupiter's cloud tops per pixel
        let kappa = KAPPA;
        if (e.parent) {
          const P = frame.positions[e.parent];
          const rp = (BODIES[e.parent].radius / Math.max(1e-9, tmp.copy(camU).sub(P).length())) * focal;
          kappa += (0.45 - KAPPA) * smooth(2, 10, rp);
        }
        const { F, rpx } = pointFlux(e, c, camU, focal, kappa);
        e._rpx = rpx;
        // the shadow of the parent planet (eclipsed moons go dark)
        Fv[k] = e.parent && F > 0 ? F * eclipse(c, frame.positions[e.parent], BODIES[e.parent].radius) : F;
        e._c = e._c || new THREE.Vector3();
        e._c.copy(c);
      }
      // normalisation to one body's peak (the pale blue dot): every glint keeps its true ratio to it
      const norm = shot.glintNorm;
      let sigN = sigU;
      if (norm && norm.id) {
        const k = list.findIndex((x) => x.id === norm.id);
        if (k >= 0 && Fv[k] > 0) {
          const w = Math.min(1, Math.max(0, norm.w ?? 1));
          // (norm.sig widens every point's core for this beat: see pass 2)
          sigN = sigU * (1 + ((norm.sig ?? 1) - 1) * w);
          const s2 = sigN * sigN + 0.0833;
          const gN = (norm.peak * 2 * Math.PI * s2) / (Fv[k] * exposure * list[k].maxc);
          gain = Math.exp(Math.log(Math.max(gain, 1e-9)) * (1 - w) + Math.log(gN) * w);
        }
      }
      // pass 2: PSF and attributes
      for (let k = 0; k < N; k++) {
        const e = list[k];
        let F = Fv[k] * gain, sz = 0, sc = sigU, hs = 3 * sigU, hf = 0;
        if (e._ok) {
          // the normalised beat belongs to one world: no other point may out-shine it (norm.others = the largest
          // peak any other point keeps, as a fraction of its peak; Venus, nearer the Sun, would otherwise win)
          if (F > 0 && norm && norm.id && norm.others !== undefined && e.id !== norm.id) {
            const capF = (norm.others * norm.peak * 2 * Math.PI * (sigN * sigN + 0.0833)) / (exposure * e.maxc);
            const w = Math.min(1, Math.max(0, norm.w ?? 1));
            if (F > capF) F = Math.exp(Math.log(F) * (1 - w) + Math.log(capF) * w);
          }
          if (F > 0) {
            // the point shrinks into its disc: the core follows the disc's size as it nears the hand-over
            sc = Math.max(sigN, 0.5 * e._rpx * pr);
            // a clipping point widens a little, then moves up to HALO_MAX of its light into a short halo; above
            // that it is simply bright (the bloom takes over), never a blob
            const pmax = PEAK / exposure / e.maxc; // per-luminance-unit peak allowed
            const need = (F / (2 * Math.PI * pmax)) - 0.0833;
            if (need > sc * sc) sc = Math.min(SIG_MAX * pr, Math.sqrt(need));
            const coreMax = 2 * Math.PI * (sc * sc + 0.0833) * pmax;
            if (F > coreMax) {
              hf = Math.min(HALO_MAX, 1 - coreMax / F);
              hs = Math.min(5 * pr, Math.max(2.5 * sc, Math.sqrt((hf * F) / (Math.PI * 0.3 * pmax))));
            }
            // display floor for labelled planets in the finale: the core's peak reaches at least `floor`
            if (floor > 0 && !e.parent) {
              const want = (floor / exposure / e.maxc) * 2 * Math.PI * (sc * sc + 0.0833);
              const core = (1 - hf) * F;
              if (core < want) {
                F += want - core;
                hf = hf * (1 - (want - core) / F);
              }
            }
            sz = 2 * Math.ceil(Math.max(3.6 * Math.sqrt(sc * sc + 0.0833), hf > 0.02 ? 3.2 * hs : 0)) + 3;
          }
          // point just outside the body's near side (beyond its cloud / atmosphere shells, which write depth),
          // camera-relative in double precision; it moves only along the line of sight, so nothing shifts on screen
          tmp.copy(e._c).sub(camU);
          const dd = tmp.length();
          if (dd > 0) tmp.multiplyScalar(1 - Math.min(0.5, (e.radius * (e.id === 'titan' ? 1.6 : 1.3)) / dd));
        } else tmp.set(0, 0, 0);
        pos[k * 3] = tmp.x;
        pos[k * 3 + 1] = tmp.y;
        pos[k * 3 + 2] = tmp.z;
        col[k * 3] = e.col[0] * sunColor.r * F;
        col[k * 3 + 1] = e.col[1] * sunColor.g * F;
        col[k * 3 + 2] = e.col[2] * sunColor.b * F;
        psf[k * 3] = sc;
        psf[k * 3 + 1] = hs;
        psf[k * 3 + 2] = hf;
        size[k] = F > 0 ? Math.min(64, sz) : 0;
      }
      aPos.needsUpdate = true;
      aCol.needsUpdate = true;
      aSize.needsUpdate = true;
      aPsf.needsUpdate = true;
    },
  };
}

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
// fraction of sunlight reaching a moon at c, given its planet at P with radius R (soft umbra edge)
const _e = new THREE.Vector3(), _rel = new THREE.Vector3();
function eclipse(c, P, R) {
  const sunDir = _e.copy(P).negate().normalize(); // from the planet toward the Sun
  const rel = _rel.copy(c).sub(P);
  const along = rel.dot(sunDir);
  if (along > 0) return 1; // sunward of the planet
  const perp = rel.addScaledVector(sunDir, -along).length();
  return smooth(R * 0.97, R * 1.03, perp);
}
