// The Galilean moons. Orbits: circular, in Jupiter's equatorial plane, real mean motions, and phases fitted to
// JPL Horizons state vectors for 2026-11-02 12:00 UTC (assets-src/scripts/jupiter_moon_phases.mjs) so the
// configuration matches the real sky on the epoch date. Tidally locked: longitude 0 faces Jupiter, the leading
// hemisphere (90 W) faces the direction of motion. Shading: USGS mosaics calibrated to each moon's normal albedo,
// lunar-Lambert photometry, footprint-filtered procedural detail, Jupiter's umbra/penumbra (eclipses) and
// Jupiter-shine on the night side.
import * as THREE from 'three';
import { circularOrbitOffset, poleQuaternion, DEG } from '../../core/astro.js';
import { JUP_COMMON } from './glsl.js';
import { noiseTile, craterTile } from './bake.js';
import { MOON_DETAIL, europaArcs, IO_VOLCANOES } from './moon-detail.js';

// J2000 mean longitude (deg) in the poleQuaternion('jupiter') frame, from Horizons at JD 2461347.0
// crat: impact relief strength (0 = none: Io has no impact craters; Europa's few dozen are in its map), crater-tile scale
export const MOON_DEFS = [
  { id: 'io', phase: 20.085, albedoScale: 2.3, kind: 0, lunar: 0.55, crat: [0, 0.3, 0, 0] },
  { id: 'europa', phase: 215.514, albedoScale: 1.85, kind: 1, lunar: 0.35, crat: [0, 0.3, 0, 0] },
  { id: 'ganymede', phase: 221.539, albedoScale: 2.35, kind: 2, lunar: 0.6, crat: [0.55, 0.3, 0, 0] },
  { id: 'callisto', phase: 80.837, albedoScale: 4.0, kind: 3, lunar: 0.85, crat: [1.0, 0.3, 0, 0] },
];

export async function createMoons({ ctx, shared, object }) {
  const { THREE: _T, U, data, assets, positions } = ctx;
  const jR = data.radius;
  const qPole = poleQuaternion('jupiter');
  const list = [];
  const meshes = [];
  const defs = MOON_DEFS.map((d) => ({ ...d, ...data.moons[d.id] }));

  const maps = await Promise.all(defs.map((d) => assets.loadTexture(`${d.id}/color.webp`, { srgb: true, anisotropy: 16 })));
  const arcs = europaArcs(THREE);
  const noArcs = arcs.map(() => new THREE.Vector4());
  const volc = IO_VOLCANOES.map(([la, lo, rKm]) => {
    const a = la * DEG, b = lo * DEG;
    return new THREE.Vector4(Math.cos(a) * Math.cos(b), Math.sin(a), -Math.cos(a) * Math.sin(b), rKm);
  });
  const volcS = [0, 1, 2].map((k) => new THREE.Vector4(...[0, 1, 2, 3].map((j) => (IO_VOLCANOES[4 * k + j] || [0, 0, 0, 0])[3])));
  const noVolc = volc.map(() => new THREE.Vector4());
  const noise = noiseTile();
  const crater = craterTile();
  for (const t of [...maps, noise, crater.tex]) ctx.renderer.initTexture(t);

  defs.forEach((d, i) => {
    const a = d.aKm / 6371;
    const P = d.periodDays;
    const uniforms = {
      uSunColor: U.uSunColor,
      uSunR: U.uSunRadius,
      uTime: U.uTime,
      uMap: { value: maps[i] },
      uRadius: { value: d.radius },
      uAlbedo: { value: d.albedoScale },
      uLunar: { value: d.lunar },
      uKind: { value: d.kind },
      uSunM: { value: new THREE.Vector3() }, // Sun relative to moon centre
      uJupM: { value: new THREE.Vector3() }, // Jupiter centre relative to moon centre
      uJupR: { value: jR },
      uJupFlat: { value: shared.uFlat.value },
      uPoleW: shared.uPoleW,
      uRot: { value: new THREE.Matrix3() },
      uCamM: { value: new THREE.Vector3() },
      uArcs: { value: d.kind === 1 ? arcs : noArcs },
      uNArcs: { value: d.kind === 1 ? arcs.length / 2 : 0 },
      uKind: { value: d.kind },
      uI0: { value: 0 },
      uCrat: { value: new THREE.Vector4(...d.crat) },
      uNVolc: { value: d.kind === 0 ? volc.length : 0 },
      uVolc: { value: d.kind === 0 ? volc : noVolc },
      uVolcS: { value: volcS },
      uRkm: { value: d.radius * 6371 },
      uJshine: { value: 0 },
      uDiscPhase: { value: 0 },
      uNoise: { value: noise },
      uCraterT: { value: crater.tex },
      uCratS: { value: new THREE.Vector2(crater.hmax, crater.gmax) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      // no defines: the four moons share ONE compiled program (uKind and the other switches are uniforms)
      vertexShader: /* glsl */ `
        uniform float uRadius;
        varying vec3 vObj;
        varying vec3 vPosM;
        varying vec3 vPosW;
        void main() {
          vObj = position / uRadius;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vPosW = wp.xyz;
          vPosM = mat3(modelMatrix) * position;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        ${JUP_COMMON}
        uniform sampler2D uMap;
        uniform float uRadius;
        uniform float uAlbedo;
        uniform float uLunar;
        uniform vec3 uSunM;
        uniform vec3 uJupM;
        uniform float uJupR;
        uniform float uJupFlat;
        uniform vec3 uPoleW;
        uniform float uSunR;
        uniform vec3 uSunColor;
        uniform mat3 uRot;
        uniform float uTime;
        uniform float uRkm;
        uniform float uJshine;
        uniform float uDiscPhase;
        varying vec3 vObj;
        varying vec3 vPosM;
        varying vec3 vPosW;
        ${MOON_DETAIL}
        void main() {
          vec3 p = normalize(vObj);
          float lon = atan(-p.z, p.x);
          float lat = asin(clamp(p.y, -1.0, 1.0));
          vec2 uv = vec2(lon / TAU + 0.5, 0.5 + lat / PI);
          vec2 dx = dFdx(uv), dy = dFdy(uv);
          dx.x -= floor(dx.x + 0.5); dy.x -= floor(dy.x + 0.5);
          float fp = max(length(dFdx(vPosM)), length(dFdy(vPosM))) / uRadius;
          fp = max(fp, 1e-6);
          vec3 base = textureGrad(uMap, uv, dx, dy).rgb;
          vec3 baseLo = textureGrad(uMap, uv, dx * 8.0 + 0.004, dy * 8.0 + 0.004).rgb;
          // procedural close-range detail and colour (moon-detail.js)
          vec3 nLoc;
          vec3 alb = moonSurface(p, lat, base, baseLo, fp, uRkm, nLoc) * uAlbedo;

          vec3 N0 = normalize(uRot * p);
          vec3 N = normalize(uRot * nLoc);
          vec3 posM = vPosM;
          vec3 L = normalize(uSunM - posM);
          vec3 V = normalize(-vPosW);
          float mu0 = dot(N, L), mu = dot(N, V);
          float mu0g = dot(N0, L);
          // lunar-Lambert: mix of Lambert and Lommel-Seeliger (flat-looking full disc for dark regolith)
          float ls = 2.0 * max(mu0, 0.0) / (max(mu0, 0.0) + max(mu, 0.02));
          float photo = mix(max(mu0, 0.0), ls, uLunar) * smoothstep(-0.02, 0.06, mu0g);
          // eclipse by Jupiter (oblate: scale the pole axis)
          vec3 sq = uPoleW * (1.0 / (1.0 - uJupFlat) - 1.0);
          vec3 pS = posM + sq * dot(posM, uPoleW), sS = uSunM + sq * dot(uSunM, uPoleW), jS = uJupM + sq * dot(uJupM, uPoleW);
          float ecl = sphereShadow(pS, sS, uSunR, jS, uJupR);
          vec3 col = alb * photo * ecl * uSunColor;
          // Jupiter-shine: geometric albedo 0.52 x (R/d)^2 x Lambert-sphere phase law of Jupiter seen from here (uJshine,
          // a per-moon constant computed in moons.js)
          col += alb * (uJshine * max(dot(N, normalize(uJupM - posM)), 0.0)) * vec3(1.0, 0.93, 0.82) * uSunColor;
          // thermal glow is independent of sunlight: fully visible on the night side and inside Jupiter's shadow
          col += moonEmission(p, mix(-1.0, mu0g, ecl), fp, uRkm);
          // a disc only a few pixels wide: output the analytic disc-averaged brightness (Lambert-sphere phase law,
          // mean albedo) so MSAA coverage gives a soft, stable dot instead of an aliased pixel cluster
          float rpx = 1.0 / fp;
          if (rpx < 4.0) {
            // uDiscPhase = (2/3) x Lambert-sphere phase law toward the camera (moons.js)
            vec3 albMean = textureLod(uMap, vec2(0.5), 12.0).rgb * uAlbedo;
            col = mix(col, albMean * uDiscPhase * ecl * uSunColor, smoothstep(4.0, 2.5, rpx));
          }
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(d.radius, 160, 80), mat);
    mesh.name = d.id;
    object.add(mesh);
    const positionAt = (simDays, out = new THREE.Vector3()) => circularOrbitOffset(a, P, d.phase, simDays, qPole, out);
    meshes.push({ d, mesh, uniforms, a, P });
    list.push({ id: d.id, name: d.name, radius: d.radius, positionAt });
  });

  const qY = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const m4 = new THREE.Matrix4();
  const tmp = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
  return {
    list,
    meshes,
    update(frame) {
      const d = frame.simDays;
      const jup = frame.positions.jupiter;
      meshes.forEach((m, i) => {
        circularOrbitOffset(m.a, m.P, m.d.phase, d, qPole, m.mesh.position);
        const th = m.d.phase * DEG + (2 * Math.PI * d) / m.P;
        m.mesh.quaternion.copy(qPole).multiply(qY.setFromAxisAngle(yAxis, th + Math.PI));
        m.uniforms.uRot.value.setFromMatrix4(m4.makeRotationFromQuaternion(m.mesh.quaternion));
        // Sun at the universe origin; positions relative to this moon's centre (world axes)
        m.uniforms.uSunM.value.copy(jup).add(m.mesh.position).negate();
        m.uniforms.uJupM.value.copy(m.mesh.position).negate();
        shared.uMoon.value[i].set(m.mesh.position.x, m.mesh.position.y, m.mesh.position.z, m.d.radius);
        // per-moon lighting constants: Jupiter-shine (Lambert-sphere phase of Jupiter seen from the moon) and the
        // disc-averaged phase toward the camera (for discs a few pixels wide)
        const lam = (al) => (Math.sin(al) + (Math.PI - al) * Math.cos(al)) / Math.PI;
        const dJ = m.mesh.position.length();
        tmp.copy(m.mesh.position).divideScalar(dJ);                       // Jupiter -> moon
        const sunJ = tmpB.copy(jup).negate().normalize();                 // Jupiter -> Sun
        m.uniforms.uJshine.value = (0.52 * jR * jR) / (dJ * dJ) * lam(Math.acos(THREE.MathUtils.clamp(tmp.dot(sunJ), -1, 1)));
        const toCam = tmpC.copy(frame.camUniverse).sub(jup).sub(m.mesh.position).normalize();
        const toSun = tmpB.copy(m.uniforms.uSunM.value).normalize();
        m.uniforms.uDiscPhase.value = (2 / 3) * lam(Math.acos(THREE.MathUtils.clamp(toCam.dot(toSun), -1, 1)));
      });
    },
  };
}
