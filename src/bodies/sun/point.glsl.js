// Far-field Sun: when the disc shrinks below ~2.5 px it becomes a screen-space Gaussian point that carries
// the disc's flux (with a floor), so MSAA never loses it and the post bloom turns it into a star.
export const POINT_VERT = /* glsl */ `
uniform vec3 uSunPosW;
uniform vec2 uResolution;
uniform float uSigmaPx;
uniform float uPull;        // distance to pull the sprite toward the camera (in front of the photosphere)
varying vec2 vPx;
void main() {
  float d = length(uSunPosW);
  vec3 c = uSunPosW * (1.0 - min(uPull, 0.5 * d) / max(d, 1e-6));
  vec4 clip = projectionMatrix * viewMatrix * vec4(c, 1.0);
  vec2 off = position.xy * uSigmaPx * 4.0;     // quad half-size = 4 sigma
  vPx = off;
  clip.xy += off * 2.0 / uResolution * clip.w;
  gl_Position = clip;
}`;

export const POINT_FRAG = /* glsl */ `
uniform float uFlux;        // total flux, (radiance units) x (pixels)
uniform float uSigmaPx;
uniform vec3 uColor;
varying vec2 vPx;
void main() {
  float s2 = uSigmaPx * uSigmaPx;
  float g = exp(-dot(vPx, vPx) / (2.0 * s2)) / (6.2831853 * s2);
  vec3 c = uColor * min(uFlux * g, 29000.0);
  gl_FragColor = vec4(c, 1.0);
}`;
