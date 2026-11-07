"""Overlay edges of a mask/height map on a colour map: python -I verify_overlay.py <color> <mask> <out.jpg> [w] [crop x0 y0 x1 y1] [threshold]"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Image, np  # noqa
c = Image.open(sys.argv[1]).convert("RGB")
m = Image.open(sys.argv[2]).convert("L").resize(c.size, Image.BILINEAR)
w = int(sys.argv[4]) if len(sys.argv) > 4 else 1600
thr = float(sys.argv[9]) if len(sys.argv) > 9 else 128
a = np.asarray(c).copy(); b = np.asarray(m) > thr
edge = (b ^ np.roll(b, 1, 0)) | (b ^ np.roll(b, 1, 1))
a[edge] = [255, 0, 0]
im = Image.fromarray(a)
if len(sys.argv) > 8:
    f = [float(v) for v in sys.argv[5:9]]
    im = im.crop((int(f[0] * im.width), int(f[1] * im.height), int(f[2] * im.width), int(f[3] * im.height)))
im.thumbnail((w, w)); im.save(sys.argv[3], quality=88); print(sys.argv[3], im.size)
