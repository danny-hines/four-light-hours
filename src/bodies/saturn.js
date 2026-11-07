// Saturn: oblate banded globe with the north-polar hexagon, the full ring system built from the Voyager 2 PPS
// optical-depth profile (lit/unlit photometry, planet shadow, ring shadows on the globe, ringshine, backlit
// forward scattering, faint G and E rings), the limb haze that lights up when the planet eclipses the Sun,
// and the six major moons (Titan with its orange haze and detached blue layer).
// See notes/saturn.md for shot commands and the data sources (assets-src/SOURCES.md, Saturn section).
import * as THREE from 'three';
import { bodyQuaternion, poleQuaternion, KM_PER_UNIT } from '../core/astro.js';
import { parseProfile, buildRingData, computeRingshine, computeSaturnshine } from './saturn/rings-data.js';
import { createRings } from './saturn/rings.js';
import { createGlobe } from './saturn/globe.js';
import { createAtmosphere } from './saturn/atmo.js';
import { createMoons } from './saturn/moons.js';

export async function create(ctx) {
  const { U, data, assets } = ctx;
  const R = data.radius;
  const flat = 1 - data.flattening;
  const object = new THREE.Group();
  object.name = 'saturn';

  const poleQ = poleQuaternion('saturn');
  const poleQi = poleQ.clone().invert();
  const satU = ctx.positions.saturn.clone();
  const sunR = satU.clone().negate().normalize().applyQuaternion(poleQi); // sun direction in the ring frame

  const buf = await assets.loadBinary('saturn/rings_tau.bin');
  const ringData = buildRingData(parseProfile(buf), Math.abs(sunR.y));
  const ringshine = computeRingshine(ringData, sunR, flat);
  ringData.sshine = computeSaturnshine(ringData, sunR, flat);

  const shared = {
    uCamR: { value: new THREE.Vector3(0, 0, 10) },
    uSunR: { value: sunR.clone() },
    uCamB: { value: new THREE.Vector3(0, 0, 10) },
    uSunB: { value: new THREE.Vector3(1, 0, 0) },
    uFlat: { value: flat },
    uDtDays: { value: 0 },
    uHours: { value: 0 },
    uFApse: { value: 0 },
    uSunAngR: { value: 695700 / (satU.length() * KM_PER_UNIT) },
    uRingshine: { value: ringshine },
    uMoonsB: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 100, 0, 0)) },
    uMoonsR: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 100, 0, 0)) },
    uGain: { value: 1 },
    // Ringshine on the night side is physically 0.1-1 % of daylight; the film's punchy AgX toe crushes anything
    // below ~1 % to black, while every Cassini night-side image (and the eye) shows the disc lit and banded. This
    // lifts only the ringshine term (a display-latitude choice, like a photographic shoulder/toe), and a little more
    // while Saturn eclipses the Sun (PIA08329-style long exposure).
    uNightLift: { value: 3 },
    // the same display lift for Saturnshine on the rings where it is the only light (the unlit face in a skim):
    // ~1-3 % of daylight; off during an eclipse, where the director's exposure and the glow carry the frame
    uSSLift: { value: 4.5 },
  };

  const globe = createGlobe(ctx, shared, ringData);
  const ringFrame = new THREE.Group();
  ringFrame.name = 'saturn-ring-frame';
  ringFrame.quaternion.copy(poleQ);
  const rings = createRings(ctx, ringData, shared);
  ringFrame.add(rings.group);
  const haze = createAtmosphere(ctx, shared);
  ringFrame.add(haze);
  object.add(globe, ringFrame);

  const moonSys = createMoons(ctx, shared, poleQ);
  object.add(moonSys.group);

  // dev-only switches: ?satdbg=norings,nohaze,noglobe,nomoons
  const DBG = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('satdbg') || '' : '';
  if (DBG.includes('norings')) rings.group.visible = false;
  if (DBG.includes('nohaze')) haze.visible = false;
  if (DBG.includes('noglobe')) globe.visible = false;
  if (DBG.includes('nomoons')) moonSys.group.visible = false;
  if (DBG.includes('notitancore')) moonSys.moons.find((m) => m.id === 'titan').core.visible = false;
  if (DBG.includes('ringdbg1')) rings.uniforms.uDebug.value = 1;
  if (DBG.includes('ringdbg2')) rings.uniforms.uDebug.value = 2;
  if (DBG.includes('headlight')) globe.material.uniforms.uHeadlight.value = 1;
  if (DBG.includes('norelief')) globe.material.uniforms.uHeadlight.value = 2;

  const qB = new THREE.Quaternion(), qBi = new THREE.Quaternion();
  const satW = new THREE.Vector3(), cam = new THREE.Vector3(), sun = new THREE.Vector3(), tmp = new THREE.Vector3();

  const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const toSun = new THREE.Vector3();
  const ringTmp = new THREE.Vector3();

  const body = {
    id: 'saturn',
    radius: R,
    object,
    // Eclipse exposure assist: when Saturn hides the Sun, the Saturn system is rendered this many times brighter,
    // ramping in as the Sun sinks behind the disc (what an auto-exposing camera does in Saturn's shadow; the
    // backlit rings are ~1/10 as bright as the sunlit globe). Set to 1 if the director drives exposure itself.
    eclipseExposureAssist: 7,
    // display lift of the ringshine-lit night side (see uNightLift above); 1 = physical
    nightLift: 3,
    /**
     * Distance (scene units) from the camera to the nearest Saturn surface including the ring sheet — the rings are
     * not a sphere, so main.js's near-plane estimate (bodies + moons) would clip them in a low ring skim.
     * Integrator: please include `b.nearestDistance?.(camU)` in the near-plane minimum (as for the asteroid belt).
     */
    nearestDistance(camUniverse) {
      const c = ringTmp.copy(camUniverse).sub(ctx.positions.saturn).applyQuaternion(poleQi);
      const h = Math.abs(c.y);
      const rho = Math.hypot(c.x, c.z);
      const r0 = (66600 / 60268) * R, r1 = (141700 / 60268) * R;
      const dr = rho < r0 ? r0 - rho : rho > r1 ? rho - r1 : 0;
      const dRing = Math.hypot(h, dr);
      const dGlobe = c.length() - R;
      return Math.max(1e-4, Math.min(dRing, dGlobe));
    },
    moons: moonSys.moons.map((m) => ({ id: m.id, name: m.name, radius: m.radius, positionAt: m.positionAt })),
    update(frame) {
      const d = frame.simDays;
      bodyQuaternion('saturn', d, qB);
      globe.quaternion.copy(qB);
      qBi.copy(qB).invert();
      // Saturn centre relative to the camera (the camera sits at the world origin)
      satW.copy(ctx.positions.saturn).sub(frame.camUniverse);
      cam.copy(satW).negate();
      sun.copy(U.uSunPosW.value).sub(satW).normalize();
      shared.uCamB.value.copy(cam).applyQuaternion(qBi).divideScalar(R);
      shared.uSunB.value.copy(sun).applyQuaternion(qBi);
      shared.uCamR.value.copy(cam).applyQuaternion(poleQi).divideScalar(R);
      shared.uSunR.value.copy(sun).applyQuaternion(poleQi);
      shared.uDtDays.value = d - ctx.epochDays;
      shared.uHours.value = (((d % 400) + 400) % 400) * 24;
      shared.uFApse.value = (((24.2 + 2.7012 * d) % 360) * Math.PI) / 180;
      for (let i = 0; i < moonSys.moons.length && i < 6; i++) {
        const m = moonSys.moons[i];
        const off = m.positionAt(d);
        tmp.copy(off).applyQuaternion(qBi).divideScalar(R);
        shared.uMoonsB.value[i].set(tmp.x, tmp.y, tmp.z, m.radius / R);
        tmp.copy(off).applyQuaternion(poleQi).divideScalar(R);
        shared.uMoonsR.value[i].set(tmp.x, tmp.y, tmp.z, m.radius / R);
      }
      // eclipse exposure assist
      toSun.copy(U.uSunPosW.value);
      const dSun = toSun.length();
      const dSat = satW.length();
      let gain = 1, eclDepth = 0;
      if (dSun > dSat && dSat > R) {
        const sep = toSun.angleTo(satW);
        const rho = Math.asin(Math.min(1, (R * (1 - 0.5 * data.flattening)) / dSat));
        const depth = (rho - sep) / rho;
        // if the shot already pushes the exposure (the director's eclipse is at +3.4 EV), only top it up
        const assist = Math.max(1, body.eclipseExposureAssist / Math.max(1, frame.shot?.exposure ?? 1));
        eclDepth = smooth(-0.02, 0.35, depth);
        gain = 1 + (assist - 1) * eclDepth;
      }
      shared.uGain.value = gain;
      shared.uNightLift.value = body.nightLift * (1 + 0.4 * eclDepth);
      shared.uSSLift.value = 1 + (1.5 * body.nightLift - 1) * (1 - eclDepth);
      // ring-sheet clip distance (see rings.js): a quarter of the distance to the nearest point of the drawn annuli
      {
        const c = shared.uCamR.value; // camera, ring frame, Saturn radii
        const rho = Math.hypot(c.x, c.z);
        const r0 = 66600 / 60268, r1 = 8.6;
        const dr = rho < r0 ? r0 - rho : rho > r1 ? rho - r1 : 0;
        const dRing = Math.hypot(c.y, dr) * R;
        rings.uniforms.uNear2.value = Math.max(1e-7, Math.min(frame.camera.near, 0.25 * dRing));
        // edge-on anti-aliasing (rings.js VERT): keep the A ring's projected minor semi-axis >= 0.9 px
        const D = c.length();
        const sinB = Math.abs(c.y) / Math.max(D, 1e-9);
        const fov = (frame.camera.fov * Math.PI) / 180;
        const pxPerR = (U.uResolution.value.y * 0.5) / Math.tan(fov * 0.5) / Math.max(D, 1e-9);
        const sinMin = Math.min(0.6, 0.9 / (2.27 * pxPerR));
        const ch = Math.hypot(c.x, c.z);
        if (sinB < sinMin && D > 3 && ch > 1e-9) {
          const dB = Math.asin(sinMin) - Math.asin(sinB);
          rings.uniforms.uTilt.value.set(c.x / ch, c.z / ch, Math.tan(dB) * (c.y >= 0 ? 1 : -1), 0);
          rings.uniforms.uCover.value = Math.max(sinB, 1e-4) / sinMin;
        } else {
          rings.uniforms.uTilt.value.set(1, 0, 0, 0);
          rings.uniforms.uCover.value = 1;
        }
      }
      moonSys.update(frame, satW, U.uSunPosW.value);
    },
  };
  return body;
}
