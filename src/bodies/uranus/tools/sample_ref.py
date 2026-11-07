"""Sample colours across the Voyager 2 Uranus reference (dev only, not shipped).
usage: python -I sample_ref.py <image> [cx cy R]
Prints mean sRGB and linear values at radial fractions of the disc along four directions."""
import site, sys
p = site.getusersitepackages()
if p not in sys.path:
    sys.path.append(p)
from PIL import Image

def lin(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

for path in sys.argv[1:2]:
    im = Image.open(path).convert('RGB')
    W, H = im.size
    px = im.load()
    thr = 60
    row = [sum(px[x, H // 2]) for x in range(W)]
    xs = [x for x in range(W) if row[x] > thr]
    col = [sum(px[W // 2, y]) for y in range(H)]
    ys = [y for y in range(H) if col[y] > thr]
    cx, cy = (xs[0] + xs[-1]) / 2, (ys[0] + ys[-1]) / 2
    R = ((xs[-1] - xs[0]) + (ys[-1] - ys[0])) / 4
    if len(sys.argv) >= 5:
        cx, cy, R = float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
    print(path, 'size', W, H, 'centre', cx, cy, 'R', R)
    def s(x, y, n=5):
        acc = [0, 0, 0]; c = 0
        for dx in range(-n, n + 1):
            for dy in range(-n, n + 1):
                q = px[int(x + dx), int(y + dy)]
                acc = [a + b for a, b in zip(acc, q)]; c += 1
        return [a / c for a in acc]
    for f in [0, 0.3, 0.5, 0.7, 0.8, 0.9, 0.95, 0.98]:
        out = []
        for name, (dx, dy) in [('L', (-1, 0)), ('R', (1, 0)), ('U', (0, -1)), ('D', (0, 1))]:
            v = s(cx + dx * f * R, cy + dy * f * R)
            out.append('%s %3d %3d %3d' % (name, *[round(x) for x in v]))
        v = s(cx - f * R, cy)
        print('r=%.2f  ' % f, ' | '.join(out), '  linL %.3f %.3f %.3f' % tuple(lin(x) for x in v))
