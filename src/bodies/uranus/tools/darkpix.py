"""Find isolated dark pixels inside bright regions (NaN / negative-sqrt artifacts) in screenshots.
usage: python -I darkpix.py img.png [img2.png ...]
A pixel is flagged when its luminance is < 25 % of the median of its 9x9 neighbourhood and that median is > 60."""
import site, sys
p = site.getusersitepackages()
if p not in sys.path:
    sys.path.append(p)
import numpy as np
from PIL import Image

for path in sys.argv[1:]:
    a = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
    y = a.mean(axis=2)
    H, W = y.shape
    r = 4
    pad = np.pad(y, r, mode='edge')
    win = np.lib.stride_tricks.sliding_window_view(pad, (2 * r + 1, 2 * r + 1))
    med = np.median(win.reshape(H, W, -1), axis=2)
    m = (y < 0.25 * med) & (med > 60)
    ys, xs = np.nonzero(m)
    print(f'{path}: {len(xs)} dark pixels')
    for x, yy in list(zip(xs, ys))[:20]:
        print(f'   ({x},{yy}) rgb={tuple(int(v) for v in a[yy, x])} med={med[yy, x]:.0f}')
