// Faint heliocentric orbit ellipses for the finale (director.object). Hidden unless shot.orbits > 0.
// Each line leaves a small gap (about 7 px) around its own planet, so the planet's point of light reads on its
// own instead of sitting on top of the line.
import * as THREE from 'three';
import { AU, orbitalElements, eclToThree } from '../core/astro.js';

const TINT = { mercury: 0x9a948c, venus: 0xe8d8b0, earth: 0x7fb0ff, mars: 0xe08a60, jupiter: 0xd8c0a0, saturn: 0xe0cc98, uranus: 0x9fe0ea, neptune: 0x7f9cff };
const GAP_PX = 7;

export function createOrbits(ctx, W) {
  const group = new THREE.Group();
  group.name = 'director-orbits';
  const uOpacity = { value: 0 };
  const uGap = { value: 0.004 };
  const items = [];
  for (const id of Object.keys(TINT)) {
    const el = orbitalElements(id, ctx.epochDays);
    const N = 1440;
    const pts = new Float32Array((N + 1) * 3);
    const cw = Math.cos(el.w), sw = Math.sin(el.w), cO = Math.cos(el.O), sO = Math.sin(el.O), cI = Math.cos(el.I), sI = Math.sin(el.I);
    const v = new THREE.Vector3();
    for (let i = 0; i <= N; i++) {
      const E = (i / N) * Math.PI * 2;
      const xp = el.a * (Math.cos(E) - el.e), yp = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
      const X = (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp;
      const Y = (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp;
      const Z = sw * sI * xp + cw * sI * yp;
      eclToThree(X * AU, Y * AU, Z * AU, v).toArray(pts, i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const uPlanet = { value: new THREE.Vector3() };
    const m = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(TINT[id]) }, uOpacity, uGain: { value: id === 'earth' ? 1.6 : 1.0 }, uPlanet, uGap },
      vertexShader: /* glsl */ `varying vec3 vRel;
        void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vRel = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: /* glsl */ `uniform vec3 uColor; uniform float uOpacity; uniform float uGain; uniform vec3 uPlanet; uniform float uGap;
        varying vec3 vRel;
        void main(){
          // angular distance (camera at the origin) from this fragment to the line's own planet
          float c = dot(normalize(vRel), normalize(uPlanet));
          float ang = acos(clamp(c, -1.0, 1.0));
          float gap = smoothstep(uGap * 0.7, uGap * 1.3, ang);
          gl_FragColor = vec4(uColor * 0.10 * uGain * uOpacity * gap, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    const line = new THREE.Line(g, m);
    line.frustumCulled = false;
    line.renderOrder = 5;
    group.add(line);
    items.push({ id, uPlanet });
  }
  group.visible = false;
  return {
    object: group,
    update(frame) {
      const o = frame.shot?.orbits ?? 0;
      uOpacity.value = o;
      group.visible = o > 0.001;
      if (!group.visible) return;
      const resY = ctx.U?.uResolution?.value?.y || 900;
      const fov = frame.camera?.fov ?? 45;
      uGap.value = ((GAP_PX * (ctx.U?.uPixelRatio?.value || 1)) / resY) * 2 * Math.tan((fov * Math.PI) / 360);
      for (const it of items) it.uPlanet.value.copy(frame.positions[it.id]).sub(frame.camUniverse);
    },
  };
}
