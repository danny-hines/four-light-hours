// Builds a float relief texture for Mars on the GPU, once at load time.
//
// The MOLA height map (assets/mars/height.webp) is 8-bit: 115 m steps. Normals taken straight from it show
// contour-line terraces on the very flat northern plains at low sun. We remove them with a constrained
// smoothing (projection onto the quantisation intervals): repeatedly blur the height, then clamp every texel
// back into [q - 0.5, q + 0.5] levels of its original value. Real relief (cliffs, volcanoes, craters) is kept
// to within half a level; flat terraces relax into smooth slopes.
//
// Output RGBA (float, mipmapped): R = height (km, relative to the MOLA areoid), G = dh/d(east), B = dh/d(north)
// as dimensionless ground slopes. Deterministic.
export function buildRelief(ctx, heightTex, { minKm, maxKm, radiusKm, cycles = 6 }) {
  const { THREE, renderer } = ctx;
  const W = heightTex.image.width, H = heightTex.image.height;
  heightTex.minFilter = THREE.NearestFilter;
  heightTex.magFilter = THREE.NearestFilter;
  heightTex.generateMipmaps = false;
  heightTex.wrapS = THREE.RepeatWrapping;
  heightTex.wrapT = THREE.ClampToEdgeWrapping;
  heightTex.needsUpdate = true;

  const floatLinear = renderer.extensions.has('OES_texture_float_linear');
  const pingOpts = {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  };
  const A = new THREE.WebGLRenderTarget(W, H, pingOpts);
  const B = new THREE.WebGLRenderTarget(W, H, pingOpts);
  const out = new THREE.WebGLRenderTarget(W, H, {
    ...pingOpts,
    type: floatLinear ? THREE.FloatType : THREE.HalfFloatType,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
  });
  out.texture.anisotropy = 8;

  const vs = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
  const common = /* glsl */ `
    uniform sampler2D tQ; uniform sampler2D tPrev; uniform vec2 uTexel; varying vec2 vUv;
    float Hq(vec2 uv) { return texture2D(tQ, uv).r * 255.0; }
    float Hs(vec2 uv) { return Hq(uv) + texture2D(tPrev, uv).r; }`;
  const iterMat = new THREE.ShaderMaterial({
    uniforms: { tQ: { value: heightTex }, tPrev: { value: null }, uTexel: { value: new THREE.Vector2(1 / W, 1 / H) }, uStep: { value: 1 } },
    vertexShader: vs,
    fragmentShader: /* glsl */ `${common}
      uniform float uStep;
      void main() {
        vec2 o = uTexel * uStep;
        float s = 4.0 * Hs(vUv)
          + 2.0 * (Hs(vUv + vec2(o.x, 0.0)) + Hs(vUv - vec2(o.x, 0.0)) + Hs(vUv + vec2(0.0, o.y)) + Hs(vUv - vec2(0.0, o.y)))
          + Hs(vUv + o) + Hs(vUv - o) + Hs(vUv + vec2(o.x, -o.y)) + Hs(vUv + vec2(-o.x, o.y));
        float r = clamp(s / 16.0 - Hq(vUv), -0.5, 0.5);
        gl_FragColor = vec4(r, 0.0, 0.0, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const finalMat = new THREE.ShaderMaterial({
    uniforms: {
      tQ: { value: heightTex },
      tPrev: { value: null },
      uTexel: { value: new THREE.Vector2(1 / W, 1 / H) },
      uMin: { value: minKm },
      uStepKm: { value: (maxKm - minKm) / 255 },
      uR: { value: radiusKm },
    },
    vertexShader: vs,
    fragmentShader: /* glsl */ `${common}
      uniform float uMin, uStepKm, uR;
      void main() {
        float hc = Hs(vUv);
        float lat = (vUv.y - 0.5) * 3.14159265;
        float cl = max(cos(lat), 0.01);
        // east-west baseline widened toward the poles so it spans about one latitude texel on the ground
        // (equirectangular rows are oversampled in longitude there; 1-texel differences amplify noise)
        float kx = clamp(floor(1.0 / cl + 0.5), 1.0, 48.0);
        float he = Hs(vUv + vec2(kx * uTexel.x, 0.0)), hw = Hs(vUv - vec2(kx * uTexel.x, 0.0));
        float hn = Hs(vUv + vec2(0.0, uTexel.y)), hs = Hs(vUv - vec2(0.0, uTexel.y));
        float dLon = 6.2831853 * uTexel.x * kx, dLat = 3.14159265 * uTexel.y;
        float sx = (he - hw) * uStepKm / (2.0 * uR * cl * dLon);
        float sy = (hn - hs) * uStepKm / (2.0 * uR * dLat);
        float polar = smoothstep(89.6, 89.0, abs(lat) * 57.29578);
        gl_FragColor = vec4(uMin + hc * uStepKm, sx * polar, sy * polar, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });

  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), iterMat);
  quad.frustumCulled = false;
  scene.add(quad);

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = true;
  // start from zero residual
  renderer.setRenderTarget(A);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  let src = A, dst = B;
  const schedule = [];
  for (let c = 0; c < cycles; c++) schedule.push(32, 16, 8, 4, 2, 1);
  schedule.push(2, 1, 1, 1);
  for (const step of schedule) {
    iterMat.uniforms.tPrev.value = src.texture;
    iterMat.uniforms.uStep.value = step;
    renderer.setRenderTarget(dst);
    renderer.render(scene, cam);
    [src, dst] = [dst, src];
  }
  quad.material = finalMat;
  finalMat.uniforms.tPrev.value = src.texture;
  renderer.setRenderTarget(out);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;

  A.dispose();
  B.dispose();
  iterMat.dispose();
  finalMat.dispose();
  quad.geometry.dispose();
  return { texture: out.texture, width: W, height: H, target: out };
}
