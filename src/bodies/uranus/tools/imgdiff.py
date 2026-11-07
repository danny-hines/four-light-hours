"""Before / after comparison of two shot folders (same file names): mean absolute difference (sRGB 0-255, all
channels), 99th percentile and max of the per-pixel max-channel difference, share of pixels differing by > 8, and an
amplified difference image per pair (|a - b| x gain) for inspection.
usage: python -I imgdiff.py beforeDir afterDir outDir [gain]"""
import site, sys, os
p = site.getusersitepackages()
if p not in sys.path:
    sys.path.append(p)
import numpy as np
from PIL import Image

a_dir, b_dir, out = sys.argv[1:4]
gain = float(sys.argv[4]) if len(sys.argv) > 4 else 8.0
os.makedirs(out, exist_ok=True)
print(f"{'view':16s} {'MAD':>6s} {'p99':>5s} {'max':>4s} {'>8':>7s}")
for f in sorted(os.listdir(a_dir)):
    if not f.endswith('.png') or not os.path.exists(os.path.join(b_dir, f)):
        continue
    a = np.asarray(Image.open(os.path.join(a_dir, f)).convert('RGB')).astype(np.float32)
    b = np.asarray(Image.open(os.path.join(b_dir, f)).convert('RGB')).astype(np.float32)
    d = np.abs(a - b)
    m = d.max(axis=2)
    print(f'{f[:-4]:16s} {d.mean():6.3f} {np.percentile(m, 99):5.1f} {m.max():4.0f} {100 * (m > 8).mean():6.3f}%')
    Image.fromarray(np.clip(d * gain, 0, 255).astype(np.uint8)).save(os.path.join(out, f))
