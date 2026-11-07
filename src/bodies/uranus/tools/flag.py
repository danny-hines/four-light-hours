"""List debug-flag pixels (udbg=9): pixels whose colour deviates strongly from their neighbourhood median in hue.
usage: python -I flag.py img.png"""
import site, sys
p = site.getusersitepackages()
if p not in sys.path:
    sys.path.append(p)
import numpy as np
from PIL import Image
a = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.float32)
H, W, _ = a.shape
r = 2
pad = np.pad(a, ((r, r), (r, r), (0, 0)), mode='edge')
win = np.lib.stride_tricks.sliding_window_view(pad, (2 * r + 1, 2 * r + 1), axis=(0, 1))
med = np.median(win.reshape(H, W, 3, -1), axis=3)
d = a - med
score = np.abs(d).max(axis=2)
ys, xs = np.nonzero((score > 30) & (med.mean(axis=2) > 50))
print(len(xs), 'flagged')
for x, y in list(zip(xs, ys))[:30]:
    print(f'  ({x},{y}) rgb={tuple(int(v) for v in a[y, x])} med={tuple(int(v) for v in med[y, x])}')
