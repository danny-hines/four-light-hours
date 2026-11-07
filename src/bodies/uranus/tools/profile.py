"""Radial profile of a rendered planet disc (dev only). usage: python -I profile.py img.png [cx cy R]
Auto-detects the disc on the central row/column if no geometry is given. Prints sRGB along 4 directions."""
import site, sys
p = site.getusersitepackages()
if p not in sys.path:
    sys.path.append(p)
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
W, H = im.size
px = im.load()
if len(sys.argv) >= 5:
    cx, cy, R = map(float, sys.argv[2:5])
else:
    thr = 60
    def run(get, n, c0):
        a = c0
        while a > 0 and sum(get(a - 1)) > thr: a -= 1
        b = c0
        while b < n - 1 and sum(get(b + 1)) > thr: b += 1
        return a, b
    x0, x1 = run(lambda x: px[x, H // 2], W, W // 2)
    y0, y1 = run(lambda y: px[(x0 + x1) // 2, y], H, H // 2)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    R = ((x1 - x0) + (y1 - y0)) / 4
print('centre', cx, cy, 'R', R)
def s(x, y, n=2):
    acc = [0, 0, 0]; c = 0
    for dx in range(-n, n + 1):
        for dy in range(-n, n + 1):
            q = px[int(x + dx), int(y + dy)]
            acc = [a + b for a, b in zip(acc, q)]; c += 1
    return [round(a / c) for a in acc]
fr = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98]
for f in fr:
    out = []
    for name, (dx, dy) in [('L', (-1, 0)), ('R', (1, 0)), ('U', (0, -1)), ('D', (0, 1))]:
        v = s(cx + dx * f * R, cy + dy * f * R)
        out.append('%s %3d %3d %3d' % (name, *v))
    print('r=%.2f  ' % f, ' | '.join(out))
