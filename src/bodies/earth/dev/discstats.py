# dev: disc histogram stats (Blue Marble calibration). usage: python -I discstats.py <png> [<png> ...]
# mask = pixels brighter than the sky, centroid/radius from the mask area, inner 92 % of the radius only.
import sys
import numpy as np
from PIL import Image
for f in sys.argv[1:]:
    a = np.asarray(Image.open(f).convert('RGB')).astype(np.float32)
    lum = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
    m = a.max(axis=2) > 25
    ys, xs = np.nonzero(m)
    cy, cx = ys.mean(), xs.mean()
    r = np.sqrt(m.sum() / np.pi)
    yy, xx = np.mgrid[0:a.shape[0], 0:a.shape[1]]
    inner = ((yy - cy) ** 2 + (xx - cx) ** 2) < (0.92 * r) ** 2
    L = lum[inner]
    p = np.percentile(L, [5, 25, 50, 75, 95, 99])
    px = a[inner]
    ocean = px[(px[:, 2] > px[:, 0] + 25) & (px[:, 2] > px[:, 1] + 8) & (L < np.percentile(L, 45))]
    oc = np.median(ocean, axis=0) if len(ocean) else [0, 0, 0]
    o5 = np.percentile(ocean, 10, axis=0) if len(ocean) else [0, 0, 0]
    cloud = px[(px.min(axis=1) > 170)]
    print(f'{f}: r={r:.0f}px lum p5/25/50/75/95/99 = ' + '/'.join(f'{v:.0f}' for v in p)
          + f'  ocean med ({oc[0]:.0f},{oc[1]:.0f},{oc[2]:.0f}) p10 ({o5[0]:.0f},{o5[1]:.0f},{o5[2]:.0f}) n={len(ocean)}  cloudfrac {len(cloud)/len(px):.2f}')
