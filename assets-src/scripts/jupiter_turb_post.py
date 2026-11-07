"""Jupiter piece: post-process the raw turbulence tile (jupiter_turbulence.py output) into the shipped assets.

  - spectral tilt of the tracers above the forcing scale (amplitude x (k / k0)^-beta): a passive tracer in 2-D
    turbulence has a flat (Batchelor, k^-1) variance spectrum, so every octave is equally contrasty and the deck looks
    busy at every zoom; cloud albedo is steeper, so the large swirls should dominate whatever scale is on screen
  - renormalise to [-1, 1] at 2.6 sigma, 8-bit lossy grayscale WebP (tracer 2 at half resolution: it only modulates hue,
    storm edges and intermittency)
  - velocity: lossy grayscale (smooth fields)
Run:  python -I jupiter_turb_post.py <raw_dir> <out_dir> [beta]
"""
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402,F401
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

raw, out = sys.argv[1], sys.argv[2]
beta = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5
K0 = 12.0


def tilt(a, beta, k0=K0):
    n = a.shape[0]
    f = np.fft.rfft2(a)
    ky = np.fft.fftfreq(n, 1.0 / n)[:, None]
    kx = np.fft.rfftfreq(n, 1.0 / n)[None, :]
    k = np.sqrt(kx * kx + ky * ky)
    w = np.where(k > k0, (np.maximum(k, k0) / k0) ** -beta, 1.0)
    return np.fft.irfft2(f * w, s=a.shape)


def load(name):
    return np.asarray(Image.open(os.path.join(raw, name)).convert("L")).astype(np.float64) / 127.5 - 1.0


def save(a, name, size=None, quality=86, lossless=False):
    s = 2.6 * np.std(a)
    u8 = np.clip(np.round(127.5 + 127.5 * np.clip(a / s, -1, 1)), 0, 255).astype(np.uint8)
    im = Image.fromarray(u8, "L")
    if size:
        im = im.resize((size, size), Image.LANCZOS)
    p = os.path.join(out, name)
    if lossless:
        im.save(p, lossless=True, method=6)
    else:
        im.save(p, quality=quality, method=6)
    print(name, os.path.getsize(p), "bytes")


os.makedirs(out, exist_ok=True)
save(tilt(load("turb_c1.webp"), beta), "turb_c1.webp", quality=84)
save(tilt(load("turb_c2.webp"), beta), "turb_c2.webp", size=512, quality=82)
for n in ("u", "v"):
    src = os.path.join(raw, f"turb_{n}_lossless.webp")
    if not os.path.exists(src):
        src = os.path.join(raw, f"turb_{n}.webp")         # jupiter_turbulence.py writes these losslessly
    im = Image.open(src).convert("L")
    p = os.path.join(out, f"turb_{n}.webp")
    im.save(p, quality=90, method=6)
    print(f"turb_{n}.webp", os.path.getsize(p), "bytes")
shutil.copy(os.path.join(raw, "turb_meta.json"), os.path.join(out, "turb_meta.json"))
