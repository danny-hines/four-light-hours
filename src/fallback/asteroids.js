// FALLBACK copy used by main.js when the real module fails to load. Do not edit.
import * as THREE from 'three';

export async function create(ctx) {
  const object = new THREE.Group();
  object.name = 'asteroids';
  return {
    object,
    setCrossing(position, direction) {},
    nearestDistance(camUniverse) { return Infinity; },
    update(frame) {},
  };
}
