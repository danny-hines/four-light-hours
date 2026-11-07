// FALLBACK copy used by main.js when the real module fails to load. Do not edit.
// Renders the scene into an HDR (half-float, 4x MSAA, 32F reversed depth) target, then exposure + ACES + sRGB.
import * as THREE from 'three';

export async function create(ctx) {
  const { renderer, U } = ctx;
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    samples: 4,
    depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
  });
  const quadScene = new THREE.Scene();
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = new THREE.ShaderMaterial({
    uniforms: { tHDR: { value: target.texture }, uExposure: U.uExposure },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `
      uniform sampler2D tHDR; uniform float uExposure; varying vec2 vUv;
      vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
      vec3 toSRGB(vec3 c){ return mix(c*12.92, 1.055*pow(c,vec3(1.0/2.4))-0.055, step(0.0031308,c)); }
      void main(){ vec3 c = texture2D(tHDR, vUv).rgb * uExposure; gl_FragColor = vec4(toSRGB(aces(c)), 1.0); }`,
    depthTest: false,
    depthWrite: false,
  });
  quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  return {
    setSize(w, h) {
      target.setSize(w, h);
    },
    render({ scene, camera }) {
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.clear(true, true, true);
      renderer.render(quadScene, quadCam);
    },
  };
}
