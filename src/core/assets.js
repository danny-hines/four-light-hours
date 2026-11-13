// Asset loading. During development files are served from /assets/<path>.
// The single-file build inlines every file under assets/ as a data URI into window.__INLINE_ASSETS__,
// so modules must always load through these helpers (never hard-code URLs).
import * as THREE from 'three';

// (the web build serves assets/ beside index.html and says so with __ASSET_BASE__)
const BASE = globalThis.__ASSET_BASE__ ? new URL(globalThis.__ASSET_BASE__, document.baseURI) : new URL('../../assets/', import.meta.url);
const pending = new Set();
let total = 0,
  done = 0;
const listeners = new Set();

export function assetURL(path) {
  const inline = globalThis.__INLINE_ASSETS__;
  if (inline && inline[path]) return inline[path];
  return new URL(path, BASE).href;
}

export function hasAsset(path) {
  const inline = globalThis.__INLINE_ASSETS__;
  if (inline) return !!inline[path];
  return true; // dev: assume present; loaders reject on 404
}

function track(p) {
  total++;
  pending.add(p);
  emit();
  p.finally(() => {
    pending.delete(p);
    done++;
    emit();
  });
  return p;
}
function emit() {
  for (const f of listeners) f(done, total);
}
export function onProgress(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const texLoader = new THREE.TextureLoader();

/**
 * Load a texture from assets/. opts: { srgb = true (colour maps), mipmaps = true, anisotropy = 8, wrapS }
 * Resolves to a THREE.Texture. Rejects if the file is missing.
 */
export function loadTexture(path, opts = {}) {
  const { srgb = true, mipmaps = true, anisotropy = 8, wrapS = THREE.RepeatWrapping, wrapT = THREE.ClampToEdgeWrapping } = opts;
  return track(
    new Promise((resolve, reject) => {
      texLoader.load(
        assetURL(path),
        (tex) => {
          tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          tex.generateMipmaps = mipmaps;
          tex.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.anisotropy = anisotropy;
          tex.wrapS = wrapS;
          tex.wrapT = wrapT;
          tex.needsUpdate = true;
          resolve(tex);
        },
        undefined,
        () => reject(new Error('missing asset ' + path))
      );
    })
  );
}

/** Same as loadTexture but resolves to null instead of rejecting when the asset is missing. */
export function loadTextureOptional(path, opts) {
  return loadTexture(path, opts).catch(() => null);
}

export function loadBinary(path) {
  return track(
    fetch(assetURL(path)).then((r) => {
      if (!r.ok) throw new Error('missing asset ' + path);
      return r.arrayBuffer();
    })
  );
}

export function loadJSON(path) {
  return track(
    fetch(assetURL(path)).then((r) => {
      if (!r.ok) throw new Error('missing asset ' + path);
      return r.json();
    })
  );
}
