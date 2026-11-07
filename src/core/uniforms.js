// Shared uniform objects. Materials should reference these objects directly (e.g. `uniforms: { uTime: U.uTime, ... }`)
// so main.js updates every material at once each frame. Never replace `.value` objects, mutate them.
import * as THREE from 'three';

export const U = {
  uTime: { value: 0 }, // visual time in seconds (deterministic; equals journey time). Use for shader animation.
  uSimDays: { value: 0 }, // simulated days since J2000 (accelerated clock) — drives rotation & orbits.
  uSunPosW: { value: new THREE.Vector3() }, // Sun centre in world space (camera-relative; camera sits at the origin).
  uSunColor: { value: new THREE.Color(1.0, 0.973, 0.93) }, // sunlight colour at unit irradiance (linear).
  uSunRadius: { value: 109.2 }, // scene units
  uResolution: { value: new THREE.Vector2(1, 1) }, // drawing-buffer size in pixels
  uPixelRatio: { value: 1 },
  uSkyGain: { value: 1 }, // star / Milky Way brightness multiplier chosen by the director
  uWarp: { value: 0 }, // 0..1 warp-travel intensity (star streaks, etc.)
  uCamVelW: { value: new THREE.Vector3() }, // camera velocity in world units per second
  uExposure: { value: 1 }, // final exposure (post uses it; emissive shaders may read it to pre-clamp)
};
