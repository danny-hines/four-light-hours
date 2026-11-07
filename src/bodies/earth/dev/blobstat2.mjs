// dev: statistics of the irregular Gaussian blob field (random amplitude and size per point)
const fr = (x) => x - Math.floor(x);
function hash33(x, y, z) {
  let a = fr(x * 0.1031), b = fr(y * 0.1030), c = fr(z * 0.0973);
  const d = a * (b + 33.33) + b * (a + 33.33) + c * (c + 33.33);
  a += d; b += d; c += d;
  return [fr((a + b) * c), fr((a + b) * b), fr((b + a) * a)];
}
let s = 0, s2 = 0, s3 = 0, n = 0;
for (let t = 0; t < 200000; t++) {
  const u = Math.random() * 2 - 1, ph = Math.random() * 2 * Math.PI, r = Math.sqrt(1 - u * u);
  const px = 300 * r * Math.cos(ph), py = 300 * u, pz = 300 * r * Math.sin(ph);
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  let B = 0;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const h = hash33(ix + dx, iy + dy, iz + dz);
    const rx = px - (ix + dx + h[0]), ry = py - (iy + dy + h[1]), rz = pz - (iz + dz + h[2]);
    const v = fr(h[0] * 7.13 + h[1] * 3.71 + h[2] * 1.93), w = fr(h[0] * 2.31 + h[2] * 5.17);
    const amp = v < 0.3 ? 0 : 0.35 + 1.3 * w * w;            // 30% empty cells, lognormal-ish sizes
    const sg = 0.2 + 0.18 * w;                                 // bigger blobs are also wider
    B += amp * Math.exp(-(rx * rx + ry * ry + rz * rz) / (2 * sg * sg));
  }
  s += B; s2 += B * B; s3 += B * B * B; n++;
}
const m = s / n, v = s2 / n - m * m, sk = (s3 / n - 3 * m * v - m * m * m) / Math.pow(v, 1.5);
console.log('mean', m.toFixed(4), 'std', Math.sqrt(v).toFixed(4), 'skew', sk.toFixed(3));
