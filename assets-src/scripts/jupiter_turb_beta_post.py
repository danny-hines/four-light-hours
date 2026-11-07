"""Jupiter piece: encode the beta-plane ("zonal") turbulence tile (jupiter_turb_beta.py output) for the shader.

  - tracer c2 (mean x-gradient) carries the jets' own banding as its x-mean (k_x = 0) component: keep only a fraction of
    it (a regular stripe pattern would repeat visibly), keep all of its waves, meanders and eddies
  - add tracer c1 (mean y-gradient: the mixed eddy field between the jets) for small-scale texture
  - spectral tilt above the forcing scale (as jupiter_turb_post.py) so the large structures dominate on screen
  - normalise at 2.6 sigma to 8 bit; the field is long in x, so x is stored at half resolution (W x H = N/2 x N)
Run:  python -I jupiter_turb_beta_post.py <raw_dir> <out_dir> [zonal_mean_keep] [c1_weight] [beta]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402,F401
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

raw, out = sys.argv[1], sys.argv[2]
keep = float(sys.argv[3]) if len(sys.argv) > 3 else 0.35
w1 = float(sys.argv[4]) if len(sys.argv) > 4 else 0.45
beta = float(sys.argv[5]) if len(sys.argv) > 5 else 0.4
K0 = 16.0


def tilt(a, beta, k0=K0):
    n = a.shape[0]
    f = np.fft.rfft2(a)
    ky = np.fft.fftfreq(n, 1.0 / n)[:, None]
    kx = np.fft.rfftfreq(n, 1.0 / n)[None, :]
    k = np.sqrt(kx * kx + ky * ky)
    w = np.where(k > k0, (np.maximum(k, k0) / k0) ** -beta, 1.0)
    return np.fft.irfft2(f * w, s=a.shape)


c1 = np.load(os.path.join(raw, "zon_c1.npy")).astype(np.float64)
c2 = np.load(os.path.join(raw, "zon_c2.npy")).astype(np.float64)
# arrays are [y, x]; the x-mean of each row is the pure zonal banding
c2 = c2 - (1.0 - keep) * c2.mean(axis=1, keepdims=True)
c1 = c1 - c1.mean()
c2 = c2 - c2.mean()
z = c2 / c2.std() + w1 * c1 / c1.std()
z = tilt(z, beta)
z /= z.std()
s = 2.6
u8 = np.clip(np.round(127.5 + 127.5 * np.clip(z / s, -1, 1)), 0, 255).astype(np.uint8)
N = u8.shape[0]
im = Image.fromarray(u8, "L")
im.save(os.path.join(raw, "turb_z_full_preview.png"))
small = im.resize((N // 2, N), Image.LANCZOS)
os.makedirs(out, exist_ok=True)
p = os.path.join(out, "turb_z.webp")
small.save(p, quality=int(os.environ.get("JB_Q", "84")), method=6)
print("turb_z.webp", small.size, os.path.getsize(p), "bytes", "clip", float(np.mean(np.abs(z) > s)))
