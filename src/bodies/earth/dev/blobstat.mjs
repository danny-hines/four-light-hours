// dev: statistics of the Gaussian blob field (sum of Gaussians at jittered-lattice points) sampled on a sphere
const fr = (x) => x - Math.floor(x);
function hash33(x, y, z) {
  let a = fr(x * 0.1031), b = fr(y * 0.1030), c = fr(z * 0.0973);
  const d = a * (b + 33.33) + b * (a + 33.33) + c * (c + 33.33);
  a += d; b += d; c += d;
  return [fr((a + b) * c), fr((a + b) * b), fr((b + a) * a)];
}
const sig = Number(process.argv[2] || 0.3);
let s = 0, s2 = 0, s3 = 0, n = 0, gm = 0;
const k = 1 / (2 * sig * sig);
for (let t = 0; t < 200000; t++) {
  // random point on a sphere of radius 300
  const u = Math.random() * 2 - 1, ph = Math.random() * 2 * Math.PI, r = Math.sqrt(1 - u * u);
  const px = 300 * r * Math.cos(ph), py = 300 * u, pz = 300 * r * Math.sin(ph);
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  let B = 0, gx = 0, gy = 0, gz = 0;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const h = hash33(ix + dx, iy + dy, iz + dz);
    const rx = px - (ix + dx + h[0]), ry = py - (iy + dy + h[1]), rz = pz - (iz + dz + h[2]);
    const w = Math.exp(-k * (rx * rx + ry * ry + rz * rz));
    B += w; gx += -2 * k * rx * w; gy += -2 * k * ry * w; gz += -2 * k * rz * w;
  }
  s += B; s2 += B * B; s3 += B * B * B; n++; gm += Math.sqrt(gx * gx + gy * gy + gz * gz);
}
const m = s / n, v = s2 / n - m * m, sk = (s3 / n - 3 * m * v - m * m * m) / Math.pow(v, 1.5);
console.log('sigma', sig, 'mean', m.toFixed(4), 'std', Math.sqrt(v).toFixed(4), 'skew', sk.toFixed(3), '|grad| mean', (gm / n).toFixed(3));
