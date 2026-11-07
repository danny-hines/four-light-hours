// The integrated light of the swarm beyond the resolved rocks, and the forward-scattering dust haze.
//
// Each size class is drawn as points out to its range R_k and fades out over 0.72..1.0 R_k; this pass picks up
// exactly the complementary fraction, so energy hands over from points to glow without a seam. Along every
// view ray we integrate the unresolved geometric cross-section of the swarm (n_k * pi * <r^2>_k, the same
// slab density envelope and clumps as the rocks) times the mean albedo and the airless disc phase function, with
// extinction (premultiplied: out = glow + background * transmittance), plus fine dust with a Henyey-Greenstein
// forward peak. Dust samples inside the shadow cylinder of a nearby hero rock are dark, so looking sunward the
// big rocks throw shadow shafts through the haze.
//
// Evaluated per vertex on a fine (0.6 deg) indexed geodesic sphere around the camera; vertices well outside the
// view frustum skip the integral. The clump noise is low-passed with the integration step (long steps far away
// use only the large octave, then the mean), so the structure never aliases or swims as the camera moves.
import * as THREE from 'three';
import { fieldGLSL, CLASSES, FIELD, NCLASS } from './field.js';
import { PHOTOMETRY_GLSL } from './rockMaterial.js';

// indexed geodesic sphere: icosahedron faces split into n x n triangles, shared vertices
function geodesic(n) {
  const t = (1 + Math.sqrt(5)) / 2;
  const V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  const F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const pos = [];
  const idx = [];
  const map = new Map();
  const vid = (x, y, z) => {
    const l = Math.hypot(x, y, z);
    x /= l; y /= l; z /= l;
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    let i = map.get(key);
    if (i === undefined) {
      i = pos.length / 3;
      pos.push(x, y, z);
      map.set(key, i);
    }
    return i;
  };
  for (const [a, b, c] of F) {
    const A = V[a], B = V[b], C = V[c];
    const P = (i, j) => {
      // barycentric grid point: i along AB, j along AC
      const u = i / n, v = j / n, w = 1 - u - v;
      return vid(A[0] * w + B[0] * u + C[0] * v, A[1] * w + B[1] * u + C[1] * v, A[2] * w + B[2] * u + C[2] * v);
    };
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n - i; j++) {
        idx.push(P(i, j), P(i + 1, j), P(i, j + 1));
        if (j < n - i - 1) idx.push(P(i + 1, j), P(i + 1, j + 1), P(i, j + 1));
      }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  return g;
}

export function createGlow(ctx) {
  const { U } = ctx;
  const geom = geodesic(110);
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const sig = CLASSES.map((C) => C.n * Math.PI * 1.877 * C.r * C.r);
  const ranges = CLASSES.map((C) => C.range);
  const heroes = { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] };
  const uniforms = {
    uVN: { value: 8 }, // loop bound of the GLSL value noise (hash.js): a uniform so FXC keeps a real loop
    uCamLocal: { value: new THREE.Vector3() },
    uBasisT: { value: new THREE.Matrix3() },
    uSunPosW: U.uSunPosW,
    uSunColor: U.uSunColor,
    uSig: { value: sig },
    uRange: { value: ranges },
    uGain: { value: 0.3 },
    uDust: { value: 4.0 },
    uHeroes: heroes,
    uSteps: { value: 40 },
    uNC: { value: NCLASS },
    uNH: { value: 4 },
  };
  const F = FIELD;
  const mat = new THREE.ShaderMaterial({
    uniforms,
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.BackSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    vertexShader: /* glsl */ `
      ${fieldGLSL()}
      ${PHOTOMETRY_GLSL}
      #define NC ${NCLASS}
      uniform vec3 uCamLocal, uSunPosW;
      uniform mat3 uBasisT;
      uniform float uSig[NC];
      uniform float uRange[NC];
      uniform float uGain, uDust;
      uniform vec4 uHeroes[4];
      uniform int uSteps, uNC, uNH;
      out vec4 vGlow;
      // the fine dust is spread wider than the rocks (collisional debris sheared along the orbit, radiation
      // pressure): a broader core (11 x 2.8) inside the SAME warped outer shape as the rocks (fieldShape), so the
      // haze and the rocks share one silhouette and neither shows a box edge
      float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }
      void main() {
        vec3 v = normalize(position);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position * 1000.0, 1.0);
        vGlow = vec4(0.0);
        // skip vertices well outside the view (triangles are ~0.6 deg, the margin is several degrees)
        if (gl_Position.w <= 0.0) return;
        vec2 ndc = gl_Position.xy / gl_Position.w;
        if (abs(ndc.x) > 1.12 || abs(ndc.y) > 1.12) return;
        vec3 vl = uBasisT * v;
        vec3 o = uCamLocal;
        // clip the ray to the slab's bounding box
        vec3 hb = vec3(${F.halfWidth.toFixed(2)}, ${F.halfHeight.toFixed(2)}, ${(F.halfLength + F.tail).toFixed(2)});
        vec3 inv = 1.0 / (vl + vec3(1e-9) * sign(vl + 1e-12));
        vec3 ta = (-hb - o) * inv, tb = (hb - o) * inv;
        vec3 tmn = min(ta, tb), tmx = max(ta, tb);
        float t0 = max(max(tmn.x, tmn.y), max(tmn.z, 0.0));
        float t1 = min(min(tmx.x, tmx.y), min(tmx.z, 4000.0));
        if (t1 <= t0) return;
        vec3 Lw = normalize(uSunPosW);
        float alpha = acos(clamp(dot(Lw, -v), -1.0, 1.0));
        float phRock = airlessDisc(alpha, 0.6) * 0.12;
        float cosT = dot(Lw, v);
        // fine dust (micron to mm grains): strongly forward scattering (Henyey-Greenstein g = 0.8) plus a narrow
        // diffraction peak (g = 0.97) and a weak back lobe, so the swarm glows when looking toward the Sun and the
        // dust is nearly invisible in front-lit views (where the unresolved rocks' opposition glow dominates)
        float phDust = 0.85 * hg(cosT, 0.8) + 0.1 * hg(cosT, 0.97) + 0.05 * hg(cosT, -0.3);
        float L = 0.0;
        float tau = 0.0;
        // samples spaced geometrically from the near end (loop bounds are uniforms: ANGLE/FXC keeps real loops
        // instead of unrolling 48 x the field noise, which cost ~0.6 s of shader compile)
        float tn = max(t0, 0.02), tf = t1;
        float lr = log(tf / tn);
        float tPrev = tn;
        float invN = 1.0 / float(uSteps);
        for (int i = 1; i <= uSteps; i++) {
          float t = tn * exp(lr * float(i) * invN);
          float dt = t - tPrev;
          float tm = 0.5 * (t + tPrev);
          tPrev = t;
          vec3 p = o + vl * tm;
          if (abs(p.x) >= ${F.halfWidth.toFixed(1)} || abs(p.y) >= ${F.halfHeight.toFixed(1)} || abs(p.z) >= ${(F.halfLength + F.tail).toFixed(1)}) continue;
          // clump structure, low-passed by the step length (the small octave is 0.6 units, the large 1.8)
          float clod = dt < 0.35 ? 0.0 : (dt < 1.2 ? 1.0 : 2.0);
          vec4 nn = fieldNoises(p, clod < 0.5 ? uVN / 2 : (clod < 1.5 ? uVN / 2 - 1 : uVN / 4));
          vec2 sh2 = fieldShape(p, nn.xy);
          float dbase = sh2.y;
          if (dbase <= 0.0) continue;
          float base = sh2.x;
          float cl = fieldClumpN(nn.zw, clod);
          float env = base * cl;
          // unresolved cross-section: classes whose points have faded out at this distance (range_k = RANGE_K r_k)
          float s = 0.0;
          for (int k = 0; k < uNC; k++) s += uSig[k] * sstep(0.72 * uRange[k], uRange[k], tm);
          float dTau = env * s * dt;
          float tr = exp(-tau);
          L += phRock * dTau * tr * uGain;
          // dust in the shadow cylinders of the nearest heroes is unlit
          float lit = 1.0;
          vec3 rel = v * tm;
          for (int h = 0; h < uNH; h++) {
            vec4 hs = uHeroes[h];
            if (hs.w <= 0.0) continue;
            vec3 oc = rel - hs.xyz;
            float b = dot(oc, Lw);
            if (b >= 0.0) continue;
            float dp = sqrt(max(dot(oc, oc) - b * b, 0.0));
            // umbra/penumbra of a 0.1-degree Sun: the umbra closes ~580 radii behind the rock
            float e = -b * 0.00174 + 0.08 * hs.w;
            lit *= 1.0 - min(1.0, hs.w / max(e, 1e-9)) * (1.0 - sstep(hs.w - e, hs.w + e, dp));
          }
          // dust lanes: sheets stretched along the swarm (collisional debris spreads along the orbit), resolved
          // only where the integration step is short enough (long steps take the mean)
          float lane = 0.8;
          if (dt < 2.5) {
            float ln = vnoiseH(vec3(p.x * 0.7 + 3.0, p.y * 1.8 - 1.0, p.z * 0.09), FIELD_SEED ^ 0x777u);
            lane = mix(0.3 + 1.4 * sstep(-0.2, 0.45, ln), 0.8, sstep(0.8, 2.5, dt));
          }
          L += dbase * (0.35 + 0.65 * cl) * 0.0065 * phDust * dt * tr * uDust * lit * lane;
          tau += dTau;
        }
        vGlow = vec4(vec3(L), 1.0 - exp(-tau));
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uSunColor;
      in vec4 vGlow;
      out vec4 fragColor;
      // neutral grey: the mean spectrum of a C/S mix is nearly flat in the visible
      void main() { fragColor = vec4(vGlow.rgb * vec3(0.985, 1.0, 1.035) * uSunColor, vGlow.a); }`,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  mesh.name = 'asteroid-glow';
  function update(camLocal, basis, heroList) {
    uniforms.uCamLocal.value.copy(camLocal);
    uniforms.uBasisT.value.copy(basis).transpose();
    for (let i = 0; i < 4; i++) {
      const h = heroList && heroList[i];
      if (h) heroes.value[i].copy(h);
      else heroes.value[i].set(0, 0, 0, 0);
    }
  }
  return { object: mesh, update, uniforms };
}
