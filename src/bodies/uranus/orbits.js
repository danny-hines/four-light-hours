// Orbits and synchronous rotation of Uranus's five major moons.
//
// Source: JPL Horizons state vectors (ICRF, km and km/s, centre = Uranus body centre @799) at 2026-11-02 12:00 UT,
// raw responses in assets-src/raw/uranus_moons_horizons/. Each orbit is circular (e < 0.004) in the instantaneous
// plane r x v (Miranda keeps its real 4.4 deg inclination), with radius = BODIES[].aKm and the period from
// BODIES[].periodDays, phased so the moon is exactly where Horizons puts it at that epoch. All moons orbit
// retrograde about the IAU north pole, in the same sense as Uranus spins.
// Body frames are synchronous: +x (lon 0) faces Uranus, -z (90 E) is the leading apex, +y is IAU north.
import * as THREE from 'three';
import { KM_PER_UNIT, OBLIQUITY, daysSinceJ2000, eclToThree, poleQuaternion } from '../../core/astro.js';

export const HORIZONS_EPOCH = daysSinceJ2000(new Date('2026-11-02T12:00:00Z'));
const STATE = {
  miranda: [1.139073366155581e5, -1.912111204254627e4, -5.961610042768777e4, -2.577685967390767, 2.343953225274107, -5.692189564547484],
  ariel: [1.073000052797646e5, 1.942407542692808e4, -1.565853367007333e5, -4.406648174140115, 1.76917077823873, -2.799568669185338],
  umbriel: [-2.379477440591883e5, 7.821244068789019e4, -8.981037425667366e4, -1.82566976474644, -0.7668441361940848, 4.224478691718438],
  titania: [1.816696014449995e5, 6.715481254851108e4, -3.897570614334042e5, -3.229419221681168, 1.091307395109676, -1.313743431226574],
  oberon: [-5.632507699873172e5, 9.15616427873325e4, 1.254481999274113e5, 0.5118732944738303, -0.9279459366944219, 2.96318256925611],
};

const ce = Math.cos(OBLIQUITY), se = Math.sin(OBLIQUITY);
function eqToThree(x, y, z) {
  return eclToThree(x, ce * y + se * z, -se * y + ce * z);
}

/** Build the orbit model for one moon. Returns { positionAt(d, out), basisAt(d, outMatrix3), poleQ, aUnits }. */
export function makeOrbit(id, aKm, periodDays) {
  const poleQ = poleQuaternion('uranus');
  const poleQi = poleQ.clone().invert();
  const s = STATE[id];
  const r = eqToThree(s[0], s[1], s[2]).applyQuaternion(poleQi);
  const v = eqToThree(s[3], s[4], s[5]).applyQuaternion(poleQi);
  const e1 = r.clone().normalize(); // pole frame
  const h = new THREE.Vector3().crossVectors(r, v).normalize();
  const e2 = new THREE.Vector3().crossVectors(h, e1).normalize(); // direction of motion at epoch
  const aUnits = aKm / KM_PER_UNIT;
  const n = (2 * Math.PI) / Math.abs(periodDays);
  const tmp = new THREE.Vector3();

  function phase(d) {
    return n * (d - HORIZONS_EPOCH);
  }
  // offset from Uranus's centre, world axes
  function positionAt(d, out = new THREE.Vector3()) {
    const f = phase(d);
    return out
      .copy(e1)
      .multiplyScalar(Math.cos(f) * aUnits)
      .addScaledVector(e2, Math.sin(f) * aUnits)
      .applyQuaternion(poleQ);
  }
  // synchronous body frame -> world (columns: x toward Uranus, y north, z = x cross y)
  const xb = new THREE.Vector3(), yb = new THREE.Vector3(), zb = new THREE.Vector3();
  const m4 = new THREE.Matrix4();
  function quaternionAt(d, outQ = new THREE.Quaternion()) {
    const f = phase(d);
    tmp.copy(e1).multiplyScalar(Math.cos(f)).addScaledVector(e2, Math.sin(f)); // r-hat, pole frame
    xb.copy(tmp).negate();
    yb.copy(h).negate();
    zb.crossVectors(xb, yb);
    m4.makeBasis(xb, yb, zb);
    outQ.setFromRotationMatrix(m4);
    return outQ.premultiply(poleQ);
  }
  return { positionAt, quaternionAt, aUnits, poleQ, normalPole: h.clone() };
}
