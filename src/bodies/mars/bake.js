// Load-time GPU bakes for the Mars surface (deterministic, once):
//
// 1. Geologic-age map (equirectangular 1024x512, RGBA8): crater density relative to the Noachian highlands, fresh
//    fraction, young volcanic plains, Hesperian ridged plains -- simplified from the USGS global geologic map
//    (Tanaka et al. 2014, SIM 3292). Slowly varying, so the per-pixel shader just looks it up.
// 2. Polar frost maps (two polar-stereographic 1024x1024 half-float RGBA, latitude 44-90 deg): the seasonal-cap
//    margin in degrees (signed, > 0 inside the frost) driven by the season's edge latitude, pole-facing slopes and
//    topographic hollows from MOLA, plus a little large-scale wander; frost brightness (slab / granular /
//    dust); thin-frost mottling; and the residual-cap (Planum Boreum) albedo from the Viking mosaic filtered
//    correctly in 3D. Polar stereographic has no pole singularity and no seam, and the mip chain does the
//    footprint filtering, so the cap edge is crisp at any distance (the shader feathers it over 1-3 px) instead
//    of a thresholded-noise stipple, and nothing pinches or streaks radially at the pole.
import { MARS_COMMON } from './glsl.js';

export const POLAR_THETA_MAX = 46; // colatitude (deg) covered by each polar map

export function bakeMarsMaps(ctx, { relief, colorTex, frostLat, frostLatS, size = 1024 }) {
  const { THREE, renderer } = ctx;
  const vs = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  scene.add(quad);

  // ---------------- 1. geologic age ----------------
  const ageRT = new THREE.WebGLRenderTarget(1024, 512, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: true,
  });
  ageRT.texture.anisotropy = 4;
  const ageMat = new THREE.ShaderMaterial({
    uniforms: { tRelief: { value: relief.texture } },
    vertexShader: vs,
    fragmentShader: /* glsl */ `
      ${MARS_COMMON}
      uniform sampler2D tRelief;
      varying vec2 vUv;
      float capW(vec3 n, float lonE, float latN, float rDeg, float wob) {
        float la = radians(latN), lo = radians(lonE);
        vec3 c = vec3(cos(la) * cos(lo), sin(la), -cos(la) * sin(lo));
        float ca = dot(n, c) + radians(wob) * sin(radians(rDeg));
        return smoothstep(cos(radians(rDeg + 3.0)), cos(radians(rDeg - 3.0)), ca);
      }
      void main() {
        float lon = (vUv.x - 0.5) * 6.2831853, lat = (vUv.y - 0.5) * 3.14159265;
        vec3 n = vec3(cos(lat) * cos(lon), sin(lat), -cos(lat) * sin(lon));
        float hKm = textureLod(tRelief, vUv, 1.0).r;
        float latD = lat * 57.29578;
        float wob = 2.5 * gnoised(n * 9.0 + 3.3).x + 1.2 * gnoised(n * 31.0).x;
        // x: crater density relative to the Noachian highlands (N(5 km) ~300 per 10^6 km^2; Hesperian ridged
        // plains ~120; Amazonian volcanics ~30; Olympus Mons and the polar layered deposits ~5-10),
        // y: fraction of craters still fresh, z: young volcanic plains, w: Hesperian ridged plains
        float lowl = smoothstep(-2.2, -3.2, hKm) * smoothstep(5.0, 20.0, latD);       // Vastitas Borealis
        float age = mix(1.0, 0.3, lowl);
        float hes = max(max(capW(n, -65.0, 12.0, 11.0, wob), capW(n, -98.0, -22.0, 13.0, wob)),    // Lunae, Solis/Syria
                        max(max(capW(n, 110.0, -21.0, 10.0, wob), capW(n, 67.0, 8.0, 9.0, wob)),  // Hesperia, Syrtis
                            capW(n, 65.0, -64.0, 8.0, wob)));                                     // Malea
        age = mix(age, 0.38, hes);
        float mff = capW(n, -158.0, -3.0, 10.0, wob);                                             // Medusae Fossae
        float ama = max(max(max(capW(n, -112.0, 3.0, 19.0, wob), capW(n, -134.0, 18.6, 11.5, wob)), // Tharsis, Olympus
                            max(capW(n, -109.0, 40.0, 10.0, wob), capW(n, -160.0, 18.0, 14.0, wob))), // Alba, Amazonis
                        max(max(capW(n, 147.0, 25.0, 9.0, wob), capW(n, 160.0, 6.0, 11.0, wob)),    // Elysium, Cerberus
                            max(mff, 0.7 * capW(n, 70.0, -42.0, 11.0, wob))));                     // MFF, Hellas fill
        age = mix(age, 0.1, ama);
        age = mix(age, 0.03, capW(n, -134.0, 18.6, 4.5, 0.0));                                  // Olympus edifice
        age = mix(age, 0.025, smoothstep(79.0, 83.0, abs(latD)));                               // polar deposits
        gl_FragColor = vec4(age, mix(0.36, 0.045, pow(age, 0.7)) / 0.4, ama * (1.0 - mff), hes);
      }`,
    depthTest: false,
    depthWrite: false,
  });

  // ---------------- 2. polar frost maps ----------------
  const polarOpts = {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: true,
  };
  const polarN = new THREE.WebGLRenderTarget(size, size, polarOpts);
  const polarS = new THREE.WebGLRenderTarget(size, size, polarOpts);
  polarN.texture.anisotropy = 4;
  polarS.texture.anisotropy = 4;
  const polarMat = new THREE.ShaderMaterial({
    uniforms: {
      tRelief: { value: relief.texture },
      tColor: { value: colorTex },
      uReliefSize: { value: new THREE.Vector2(relief.width, relief.height) },
      uSouth: { value: 0 },
      uEdge: { value: frostLat },
      uTanHalf: { value: Math.tan(((POLAR_THETA_MAX / 2) * Math.PI) / 180) },
      uNoiseN: { value: 6 },
    },
    vertexShader: vs,
    fragmentShader: /* glsl */ `
      ${MARS_COMMON}
      uniform sampler2D tRelief, tColor;
      uniform vec2 uReliefSize;
      uniform float uSouth, uEdge, uTanHalf;
      uniform int uNoiseN;
      varying vec2 vUv;
      void main() {
        // polar stereographic: st = (x, z) / (1 + |y|) / tan(theta_max / 2)
        vec2 st = (vUv * 2.0 - 1.0) * uTanHalf;
        float t = length(st);
        float colat = 2.0 * atan(t);
        vec2 xz = t > 1e-7 ? st / t * sin(colat) : vec2(0.0);
        float sy = uSouth > 0.5 ? -1.0 : 1.0;
        vec3 n = vec3(xz.x, sy * cos(colat), xz.y);
        float lat = asin(clamp(n.y, -1.0, 1.0)), lon = atan(-n.z, n.x);
        vec2 uv = vec2(lon * 0.15915494 + 0.5, lat * 0.31830989 + 0.5);
        float latP = 90.0 - colat * 57.29578;                     // latitude toward this pole (deg)
        // MOLA at ~20 km and ~80 km smoothing: height, pole-facing slope, hollows
        vec4 r1 = textureLod(tRelief, uv, 1.0);
        float hB = textureLod(tRelief, uv, 3.0).r;
        float poleSlope = sy * r1.b * (1.0 - smoothstep(82.0, 86.0, latP));
        // a pole-facing slope of s deg gets the insolation of flat ground s deg poleward (frost survives there);
        // hollows (crater floors, troughs, chasmata) are cold traps
        float slopeDeg = clamp(atan(poleSlope) * 57.29578, -10.0, 10.0);
        float hol = clamp((hB - r1.r) * 1.1, 0.0, 3.0);
        // noise: large-scale edge wander (deg) and frost brightness / mottling (one call site, loop)
        float nE = 0.0, nB = 0.0, nM = 0.0;
        for (int i = 0; i < uNoiseN; i++) {
          float f = i == 0 ? 5.0 : i == 1 ? 14.0 : i == 2 ? 38.0 : i == 3 ? 23.0 : i == 4 ? 70.0 : 130.0;
          float v = gnoised(n * f + vec3(2.0 + 7.1 * float(i), 9.0 * uSouth, 3.3)).x;
          if (i < 3) nE += v * (i == 0 ? 2.0 : i == 1 ? 0.9 : 0.35);
          else if (i < 5) nB += v * (i == 3 ? 0.05 : 0.03);
          else nM = v;
        }
        float margin = latP + slopeDeg + hol - (uEdge + nE);
        // Viking mosaic luminance, filtered over this texel's true footprint (no radial equirect streaks)
        vec2 dX = dFdx(uv), dY = dFdy(uv);
        float u2 = fract(uv.x + 0.5);
        float a2x = dFdx(u2), a2y = dFdy(u2);
        if (abs(a2x) < abs(dX.x)) dX.x = a2x;
        if (abs(a2y) < abs(dY.x)) dY.x = a2y;
        vec3 vik = textureGrad(tColor, uv, dX * 1.5, dY * 1.5).rgb;
        float lum = dot(vik, vec3(0.6, 0.3, 0.1));
        gl_FragColor = vec4(margin, 0.94 + nB, nM, lum);
      }`,
    depthTest: false,
    depthWrite: false,
  });

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = true;
  quad.material = ageMat;
  renderer.setRenderTarget(ageRT);
  renderer.render(scene, cam);
  quad.material = polarMat;
  polarMat.uniforms.uSouth.value = 0;
  polarMat.uniforms.uEdge.value = frostLat;
  renderer.setRenderTarget(polarN);
  renderer.render(scene, cam);
  polarMat.uniforms.uSouth.value = 1;
  polarMat.uniforms.uEdge.value = frostLatS;
  renderer.setRenderTarget(polarS);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  ageMat.dispose();
  polarMat.dispose();
  quad.geometry.dispose();
  return { age: ageRT.texture, polarN: polarN.texture, polarS: polarS.texture, tanHalf: Math.tan(((POLAR_THETA_MAX / 2) * Math.PI) / 180) };
}
