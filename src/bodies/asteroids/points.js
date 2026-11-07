// Small rocks on the GPU: one gl.POINTS draw per size class. Every vertex is a candidate slot of a lattice cell
// around the camera (gl_VertexID -> cell, slot); the rock is regenerated from the same PCG hashes as the CPU
// field, so hand-overs are seamless:
//   bounding radius < 3.6 px : flux-conserving Gaussian point (albedo x disc-integrated airless phase function x
//                               projected area of the tumbling triaxial body = its real lightcurve)
//   2.6 .. 12 px             : lit impostor - exact ray/ellipsoid intersection in the rock's body frame, lumpy
//                               silhouette and normals, airless photometry, true terminator; fades out 8..12 px
//   >= 8 px                  : CPU mesh (fades in 8..12 px with alpha-to-coverage)
// Premultiplied "over" blending: points add light (alpha 0) while impostors occlude what is behind them.
import * as THREE from 'three';
import { fieldGLSL, CLASSES, FIELD, MESH_PX, PATH, PATH_N } from './field.js';
import { PHOTOMETRY_GLSL } from './rockMaterial.js';
import { HASH_GLSL } from './hash.js';

export function createPointClass(ctx, cls, shapeInfo) {
  const { U } = ctx;
  const C = CLASSES[cls];
  const NS = shapeInfo.length;
  const geom = new THREE.BufferGeometry();
  let cap = 0;
  const ensure = (n) => {
    if (n <= cap) return;
    cap = Math.ceil(n * 1.25);
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap), 1));
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  };
  ensure(1024);
  const uniforms = {
    uVN: { value: 8 }, // loop bound of the GLSL value noise (hash.js): a uniform so FXC keeps a real loop
    uCls: { value: cls },
    uR: { value: C.r },
    uCell: { value: C.cell },
    uPAcc: { value: C.pAcc },
    uM: { value: C.M },
    uRange: { value: C.range },
    uBoxMin: { value: new THREE.Vector3() },
    uBoxDim: { value: new THREE.Vector3(1, 1, 1) },
    uCamCell: { value: new THREE.Vector3() },
    uCamFrac: { value: new THREE.Vector3() },
    uBasis: { value: new THREE.Matrix3() },
    uK: ctx.sharedK,
    uTime: U.uTime,
    uSunPosW: U.uSunPosW,
    uSunColor: U.uSunColor,
    uShapeBound: { value: shapeInfo.map((s) => s.boundR) },
    uShapeAxes: { value: shapeInfo.map((s) => new THREE.Vector3(...s.axes)) },
    uShapeSpin: { value: shapeInfo.map((s) => s.spinAxis) },
    uShapeMaps: { value: ctx.shapeMaps },
    uPathAB: ctx.pathUniforms.uPathAB,
    uPathOn: ctx.pathUniforms.uPathOn,
    uTrace: { value: 24 },
    uShSteps: { value: 8 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    vertexShader: /* glsl */ `
      ${fieldGLSL()}
      ${PHOTOMETRY_GLSL}
      #define NS ${NS}
      uniform int uCls, uM;
      uniform float uR, uCell, uPAcc, uRange, uK, uTime;
      uniform vec3 uBoxMin, uBoxDim, uCamCell, uCamFrac, uSunPosW;
      uniform mat3 uBasis;
      uniform float uShapeBound[NS];
      uniform vec3 uShapeAxes[NS];
      uniform float uShapeSpin[NS];
      out vec3 vCol;       // gaussian peak radiance (premultiplied)
      out vec3 vAlb;       // impostor albedo colour
      flat out vec4 vRb;   // camera right in scaled body space (xyz), units per px (w)
      flat out vec4 vUb;   // camera up in scaled body space, size of the sprite (w)
      flat out vec4 vFb;   // camera forward in scaled body space, gaussian sigma (w)
      flat out vec4 vLb;   // sun direction in body space, impostor weight (w)
      flat out vec4 vVb;   // view direction (to camera) in body space, phase-darkness flag (w)
      flat out vec4 vAx;   // body axes (xyz), seed (w)
      flat out vec4 vSh;   // stretch (xyz), shape index (w)
      void kill() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); vLb = vec4(0.0); vSh = vec4(1.0); }
      void main() {
        int id = gl_VertexID;
        int slot = id % uM;
        int cid = id / uM;
        ivec3 bd = ivec3(uBoxDim);
        ivec3 c = ivec3(uBoxMin) + ivec3(cid % bd.x, (cid / bd.x) % bd.y, cid / (bd.x * bd.y));
        uint h = hashCell(c, FIELD_SEED + uint(uCls * 64 + slot));
        vec3 jit = vec3(rnd(h, 0u), rnd(h, 1u), rnd(h, 2u));
        vec3 local = (vec3(c) + jit) * uCell;
        float ua = rnd(h, 3u);
        if (ua >= uPAcc) { kill(); return; }
        vec3 relL = (vec3(c) - uCamCell + jit) * uCell - uCamFrac;
        float d = length(relL);
        if (d > uRange) { kill(); return; }
        float env = fieldEnvelope(local);
        if (ua >= uPAcc * env) { kill(); return; }
        float u = rnd(h, 4u);
        float scale = uR * pow(1.0 - u * (1.0 - exp2(-Q_SLOPE)), -1.0 / Q_SLOPE);
        int shape = min(NS - 1, shapeTable(min(31, int(floor(rnd(h, 5u) * 32.0)))));
        vec3 st = vec3(0.82) + 0.36 * vec3(rnd(h, 14u), rnd(h, 15u), rnd(h, 16u));
        float bound = uShapeBound[shape] * max(st.x, max(st.y, st.z)) * scale;
        if (length(local.xy) < ${FIELD.corridor} + bound && abs(local.z) < ${FIELD.halfLength + FIELD.tail}.0) { kill(); return; }
        if (pathBlocked(local, bound)) { kill(); return; }
        vec3 rel = uBasis * relL;
        float pB = bound * uK / d;
        // below ~2 px (bounding radius) a rock is an unresolved point: the camera's own PSF (fixed sigma), so its
        // peak brightness follows its flux (albedo x phase x projected area x lightcurve) and the swarm shows a real
        // spread of magnitudes (a few bright S-types, many faint C-types) instead of equal soft blobs; from ~2 px
        // the impostor draws its real outline
        float wPt = 1.0 - sstep(1.8, 2.6, pB);
        // Impostor -> mesh hand-over (8..12 px): the mesh dissolves in with alpha-to-coverage while the impostor
        // stays fully opaque but sits at the BACK of the rock (depth pushed back by its bounding radius), so the
        // mesh's covered MSAA samples hide it and its uncovered samples show it: complementary coverage, no
        // half-transparent ghost of the background through the rock during the cross-fade.
        float wImp = sstep(1.8, 2.6, pB) * (pB < ${(MESH_PX * 1.5).toFixed(1)} ? 1.0 : 0.0);
        float fade = 1.0 - sstep(0.72 * uRange, uRange, d);
        if ((wPt <= 0.0 && wImp <= 0.0) || fade <= 0.0) { kill(); return; }
        int t; vec3 color; float albedo;
        rockMaterial(h, t, color, albedo);
        vec3 V = -rel / d;
        vec3 L = normalize(uSunPosW - rel);
        float alpha = acos(clamp(dot(L, V), -1.0, 1.0));
        float dark = (t == 0 || t >= 4) ? 1.0 : 0.0;
        // orientation at time t (matches field.js rockQuaternion)
        float u1 = rnd(h, 7u), u2 = rnd(h, 8u), u3 = rnd(h, 9u);
        float s1 = sqrt(1.0 - u1), s2 = sqrt(u1);
        vec4 q = vec4(s1 * sin(6.2831853 * u2), s1 * cos(6.2831853 * u2), s2 * sin(6.2831853 * u3), s2 * cos(6.2831853 * u3));
        float Ph = 2.2 * pow(15.0, pow(rnd(h, 10u), 1.4));
        float omega = 6.2831853 / (Ph * 3600.0) * TIME_SCALE * (rnd(h, 11u) < 0.5 ? 1.0 : -1.0);
        float ph0 = rnd(h, 12u) * 6.2831853;
        float ang = ph0 + omega * uTime;
        int sa = int(uShapeSpin[shape]);
        float tumble = rnd(h, 13u) < 0.12 ? 0.35 + 0.6 * rnd(h, 18u) : 0.0;
        if (tumble > 0.0) {
          q = qmul(q, qaxis((sa + 1) % 3, ang * 0.37 + ph0 * 1.7));
          q = qmul(q, qaxis((sa + 2) % 3, tumble));
        }
        q = qmul(q, qaxis(sa, ang));
        vec4 qi = vec4(-q.xyz, q.w);
        vec3 ax = uShapeAxes[shape] * st;
        vec3 vb = qrot(qi, V);
        vec3 ar = vec3(ax.y * ax.z * vb.x, ax.x * ax.z * vb.y, ax.x * ax.y * vb.z);
        float lc = length(ar) / pow(ax.x * ax.y * ax.z, 2.0 / 3.0);
        float pr = scale * uK / d; // mean radius in pixels
        // gaussian point
        float flux = airlessDisc(alpha, dark) * 3.14159265 * pr * pr * lc * wPt * fade;
        float sigma = 0.6;
        vCol = color * flux / (6.2831853 * sigma * sigma);
        float size = ceil(sigma * 5.0);
        // impostor: camera basis in the scaled body frame (unit sphere = the ellipsoid)
        if (wImp > 0.0) {
          vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 axS = ax * scale;
          vRb = vec4(qrot(qi, camR) / axS, d / uK);
          vUb = vec4(qrot(qi, camU) / axS, 0.0);
          vFb = vec4(qrot(qi, -V) / axS, sigma);
          size = max(size, 2.0 * ceil(pB * 1.08) + 3.0);
        } else {
          vRb = vec4(0.0); vUb = vec4(0.0); vFb = vec4(0.0);
        }
        vUb.w = size;
        vFb.w = sigma;
        vLb = vec4(qrot(qi, L), wImp * fade);
        vVb = vec4(vb, dark);
        vAx = vec4(ax, rnd(h, 19u));
        vSh = vec4(st, float(shape));
        vAlb = color;
        gl_PointSize = size;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(rel * (1.0 + (wImp > 0.0 ? bound / d : 0.0)), 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      precision highp sampler2DArray;
      #define NS ${NS}
      ${PHOTOMETRY_GLSL}
      ${HASH_GLSL}
      uniform vec3 uSunColor;
      in vec3 vCol;
      in vec3 vAlb;
      flat in vec4 vRb;
      flat in vec4 vUb;
      flat in vec4 vFb;
      flat in vec4 vLb;
      flat in vec4 vVb;
      flat in vec4 vAx;
      flat in vec4 vSh;
      uniform highp sampler2DArray uShapeMaps;
      uniform float uShapeBound[NS];
      uniform int uTrace, uShSteps;
      out vec4 fragColor;
      vec2 octEnc(vec3 n) {
        n /= (abs(n.x) + abs(n.y) + abs(n.z));
        vec2 e = n.xy;
        if (n.z < 0.0) e = (1.0 - abs(e.yx)) * vec2(e.x >= 0.0 ? 1.0 : -1.0, e.y >= 0.0 ? 1.0 : -1.0);
        return e * 0.5 + 0.5;
      }
      float shapeR(vec3 d, float layer) { return textureLod(uShapeMaps, vec3(octEnc(d), layer), 0.0).r; }
      void main() {
        float size = vUb.w;
        vec2 o = (gl_PointCoord - 0.5) * size;
        o.y = -o.y;
        float sigma = vFb.w;
        float gw = exp(-dot(o, o) / (2.0 * sigma * sigma));
        vec3 col = vCol * gw;
        float a = 0.0;
        float wImp = vLb.w;
        if (wImp > 0.0) {
          // Orthographic ray through this pixel, sphere-traced against the rock's own octahedral radius map (the
          // same surface as its mesh), so 2..12 px rocks keep their real angular outlines, terminators and a
          // short self-shadow march, and hand over to the meshes without a change of shape.
          vec3 ro = (vRb.xyz * o.x + vUb.xyz * o.y) * vRb.w;
          vec3 rd = vFb.xyz;
          vec3 axs = vAx.xyz / vSh.xyz; // the shape's own RMS axes: shape space = scaled-body space * axs
          float layer = vSh.w;
          float bR = uShapeBound[int(layer + 0.5)];
          vec3 ros = ro * axs, rds = rd * axs;
          float rl = length(rds);
          vec3 rdn = rds / rl;
          float pxS = vRb.w * length(vRb.xyz * axs);
          float b0 = dot(ros, rdn), c0 = dot(ros, ros) - bR * bR;
          float disc = b0 * b0 - c0;
          float cover = 0.0;
          vec3 hp = vec3(0.0);
          if (disc > 0.0) {
            float sq = sqrt(disc);
            float t = -b0 - sq, tEnd = -b0 + sq;
            float dmin = 1e9;
            bool hit = false;
            for (int i = 0; i < uTrace; i++) {
              vec3 q = ros + rdn * t;
              float lq = length(q);
              float d = lq - shapeR(q / max(lq, 1e-6), layer);
              dmin = min(dmin, d);
              if (d < 0.15 * pxS) { hit = true; hp = q; break; }
              t += max(0.7 * d, 0.25 * pxS);
              if (t > tEnd) break;
            }
            cover = hit ? 1.0 : clamp(0.5 - dmin / pxS, 0.0, 1.0);
            if (!hit && cover > 0.0) hp = ros + rdn * (-b0);
          }
          if (cover > 0.0) {
            vec3 dn = normalize(hp);
            vec3 t1 = normalize(cross(dn, abs(dn.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
            vec3 t2 = cross(dn, t1);
            float e = 0.045;
            float R0 = shapeR(dn, layer);
            float R1 = shapeR(normalize(dn + e * t1), layer), R2 = shapeR(normalize(dn + e * t2), layer);
            vec3 ns = normalize(dn - ((R1 - R0) / e * t1 + (R2 - R0) / e * t2) / R0);
            vec3 n = normalize(ns / vSh.xyz); // shape space -> body frame normal
            vec3 L = normalize(vLb.xyz), V = normalize(vVb.xyz);
            float mu0 = dot(n, L), mu = max(dot(n, V), 0.02);
            float alpha = acos(clamp(dot(L, V), -1.0, 1.0));
            // lunar-Lambert airless photometry (the Hapke roughness correction is sub-pixel at 2-12 px)
            float I = mu0 > 0.0 ? airless(mu0, mu, alpha, vVb.w) : 0.0;
            // short self-shadow march toward the Sun (lobes and big concavities)
            vec3 Ls = normalize(L / vSh.xyz);
            float sh = 1.0;
            float ts = 0.04;
            vec3 p0 = dn * R0 + ns * 0.02;
            for (int i = 0; i < uShSteps; i++) {
              vec3 q = p0 + Ls * ts;
              float lq = length(q);
              if (lq > bR) break;
              sh = min(sh, clamp((lq - shapeR(q / lq, layer)) / (0.03 + 1.5 * pxS) + 0.5, 0.0, 1.0));
              ts += 0.12;
            }
            float seed = vAx.w * 57.0;
            float albv = 1.0 + 0.15 * vnoiseH(hp * 4.0 - seed, 0x77u);
            vec3 ci = vAlb * albv * I * sh + vAlb * 0.0025;
            // backlit limb (forward-scattering dust coating), as on the meshes
            float fwdA = exp(-(3.14159265 - alpha) / 0.5);
            ci += (vAlb + vec3(0.15)) * fwdA * pow(1.0 - mu, 1.5) * smoothstep(-0.25, 0.2, mu0) * 4.0;
            a = cover * wImp;
            col = col * (1.0 - a) + ci * a;
          }
        }
        if (a <= 0.0 && gw < 0.003) discard;
        fragColor = vec4(col * uSunColor, a);
      }`,
  });
  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;
  points.name = 'asteroid-points-' + cls;

  const tub = { lo: [-FIELD.halfWidth, -FIELD.halfHeight, -FIELD.halfLength - FIELD.tail], hi: [FIELD.halfWidth, FIELD.halfHeight, FIELD.halfLength + FIELD.tail] };
  // frustumBox: local-space AABB (min/max arrays) of the view frustum truncated at unit distance, scaled per class
  function update(camLocal, basis, frustumBox) {
    const cl = [camLocal.x, camLocal.y, camLocal.z];
    const lo = [], dim = [];
    let n = C.M;
    for (let i = 0; i < 3; i++) {
      let fa = cl[i] - C.range, fb = cl[i] + C.range;
      if (frustumBox) {
        const pad = C.r * 6;
        fa = Math.max(fa, cl[i] + frustumBox.min[i] * C.range - pad);
        fb = Math.min(fb, cl[i] + frustumBox.max[i] * C.range + pad);
      }
      const a = Math.floor(Math.max(fa, tub.lo[i]) / C.cell);
      const b = Math.floor(Math.min(fb, tub.hi[i]) / C.cell);
      lo.push(a);
      dim.push(b - a + 1);
      if (b < a) n = 0;
      n *= Math.max(0, b - a + 1);
    }
    if (n <= 0) {
      points.visible = false;
      return 0;
    }
    points.visible = true;
    ensure(n);
    geom.setDrawRange(0, n);
    uniforms.uBoxMin.value.set(lo[0], lo[1], lo[2]);
    uniforms.uBoxDim.value.set(dim[0], dim[1], dim[2]);
    const cc = [Math.floor(cl[0] / C.cell), Math.floor(cl[1] / C.cell), Math.floor(cl[2] / C.cell)];
    uniforms.uCamCell.value.set(cc[0], cc[1], cc[2]);
    uniforms.uCamFrac.value.set(cl[0] - cc[0] * C.cell, cl[1] - cc[1] * C.cell, cl[2] - cc[2] * C.cell);
    uniforms.uBasis.value.copy(basis);
    return n;
  }
  return { points, update };
}
