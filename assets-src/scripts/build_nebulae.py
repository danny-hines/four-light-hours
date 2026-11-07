"""Structure sprites for the sky's signature nebulae (and the Large Magellanic Cloud), authored procedurally.

    python -I build_nebulae.py ../../assets/sky [preview_dir]

No imagery is used: each object is built from its documented morphology (positions of the bright regions, dark
bays, lanes and rims taken from the NGC/IC, Sharpless, Lynds and Barnard descriptions and standard charts) with
analytic primitives and band-limited noise. Every sprite is in sky orientation: +x = east, +y = north, centred on
the catalogue position given in src/sky/catalog.js, and fades to zero at its border.

Output: assets/sky/nebulae.webp, a 512 x 384 RGB atlas (mipmapped at runtime):
    R = emission (H-alpha dominated) brightness^(1/3), G = dust optical depth / 3, B = reflection brightness^(1/3)
"""
import os
import site
import sys

sys.path.append(site.getusersitepackages())
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from scipy import ndimage as nd  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else '../../assets/sky'
PREV = sys.argv[2] if len(sys.argv) > 2 else None
AW, AH = 512, 384


class Sprite:
    def __init__(self, w, h, half_x, half_y, seed):
        """w x h texels covering +-half_x, +-half_y arcmin (x east, y north)."""
        self.w, self.h = w, h
        xs = (np.arange(w) + 0.5) / w * 2 - 1
        ys = 1 - (np.arange(h) + 0.5) / h * 2  # row 0 = north
        self.X, self.Y = np.meshgrid(xs * half_x, ys * half_y)
        self.hx, self.hy = half_x, half_y
        self.em = np.zeros((h, w))
        self.dust = np.zeros((h, w))
        self.rf = np.zeros((h, w))
        self.rng = np.random.default_rng(seed)

    def noise(self, scale_arcmin, octaves=4, gain=0.55):
        """Band-limited fractal noise, unit std, features ~scale_arcmin."""
        px = 2 * self.hx / self.w
        acc = np.zeros((self.h, self.w))
        a, s, tot = 1.0, scale_arcmin, 0.0
        for _ in range(octaves):
            sig = max(s / px / 2.5, 0.6)
            n = nd.gaussian_filter(self.rng.standard_normal((self.h, self.w)), sig, mode='reflect')
            acc += a * n / (n.std() + 1e-12)
            tot += a * a
            a *= gain
            s /= 2.0
        return acc / np.sqrt(tot)

    def filaments(self, scale_arcmin, strength=0.8):
        """Ridged (filamentary) multiplicative texture, mean ~1."""
        a = np.abs(self.noise(scale_arcmin, 4))
        b = np.abs(self.noise(scale_arcmin * 0.45, 3))
        r = (1 - np.clip(a / 1.6, 0, 1)) ** 2.5 + 0.6 * (1 - np.clip(b / 1.6, 0, 1)) ** 2.5
        r /= r.mean()
        return (1 - strength) + strength * r

    def blob(self, cx, cy, rx, ry, ang=0.0, p=2.0):
        c, s = np.cos(np.radians(ang)), np.sin(np.radians(ang))
        dx, dy = self.X - cx, self.Y - cy
        u = (dx * c + dy * s) / rx
        v = (-dx * s + dy * c) / ry
        return np.exp(-(np.abs(u) ** p + np.abs(v) ** p))

    def stroke(self, pts, width, soft=1.0):
        """Gaussian-profile stroke along a polyline (arcmin); returns 0..1."""
        d = np.full(self.X.shape, 1e9)
        for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:]):
            vx, vy = x1 - x0, y1 - y0
            L2 = vx * vx + vy * vy
            t = np.clip(((self.X - x0) * vx + (self.Y - y0) * vy) / L2, 0, 1)
            d = np.minimum(d, np.hypot(self.X - (x0 + t * vx), self.Y - (y0 + t * vy)))
        return np.exp(-0.5 * (d / (width * soft)) ** 2)

    def warp(self, field, amp, scale):
        """Domain-warp a field by noise (amp, scale in arcmin)."""
        px = 2 * self.hx / self.w
        dx = self.noise(scale, 3) * amp / px
        dy = self.noise(scale, 3) * amp / px
        yy, xx = np.mgrid[0:self.h, 0:self.w].astype(np.float64)
        return nd.map_coordinates(field, [yy + dy, xx + dx], order=1, mode='nearest')

    def border(self):
        # elliptical, wide and smooth: nothing may reach the cell edge (a rectangle would show on the sky)
        r = np.hypot(self.X / self.hx, self.Y / self.hy) * np.exp(0.22 * self.noise(0.35 * self.hx, 3))
        # (a long, gentle fall: with the photographic stretch the shader applies, any residual light at the edge of
        # the cell would read as a cut-out)
        t = np.clip((0.95 - r) / 0.6, 0, 1)
        w = t * t * (3 - 2 * t)
        w = w * w
        self.em *= w
        self.dust *= w
        self.rf *= w


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nebula_shapes as NS  # noqa: E402

SPRITES = [
    ('m42', NS.m42, (0, 0)),
    ('lagoon', NS.lagoon, (256, 0)),
    ('carina', NS.carina, (256, 128)),
    ('nan', NS.nan_pelican, (384, 128)),
    ('rhooph', NS.rho_oph, (0, 256)),
    ('trifid', NS.trifid, (128, 256)),
    ('rosette', NS.rosette, (256, 256)),
    ('lmc', NS.lmc, (384, 256)),
]


def main():
    atlas = np.zeros((AH, AW, 3))
    meta = {}
    for name, fn, (x0, y0) in SPRITES:
        s = fn(Sprite)
        yel = getattr(s, 'yellow', None)
        s.border()
        if yel is not None:
            pass
        em = np.clip(s.em / max(s.em.max(), 1e-9), 0, 1)
        rf = np.clip(s.rf / max(s.rf.max(), 1e-9), 0, 1) if s.rf.max() > 0 else s.rf
        if yel is not None:  # rho Oph: the Antares glow shares the reflection channel, coloured by position in the shader
            rf = np.clip((s.rf + yel) / max((s.rf + yel).max(), 1e-9), 0, 1)
        atlas[y0:y0 + s.h, x0:x0 + s.w, 0] = em ** (1 / 3)
        atlas[y0:y0 + s.h, x0:x0 + s.w, 1] = np.clip(s.dust / 3.0, 0, 1)
        atlas[y0:y0 + s.h, x0:x0 + s.w, 2] = rf ** (1 / 3)
        pix = (2 * s.hx * 60 / s.w) * (2 * s.hy * 60 / s.h)  # arcsec^2 per texel
        meta[name] = dict(cell=[x0 / AW, 1 - (y0 + s.h) / AH, s.w / AW, s.h / AH], half=[s.hx / 60, s.hy / 60],
                          emInt=float(em.sum() * pix), rfInt=float(rf.sum() * pix))
        print(name, meta[name], 'em max %.3g rf max %.3g dust max %.2f' % (s.em.max(), s.rf.max(), s.dust.max()))
    img = np.clip(np.round(atlas * 255), 0, 255).astype(np.uint8)
    dst = os.path.join(OUT, 'nebulae.webp')
    Image.fromarray(img, 'RGB').save(dst, 'WEBP', quality=88, method=6)
    print('wrote', dst, os.path.getsize(dst), 'bytes')
    import json
    json.dump({'size': [AW, AH], 'encoding': 'R = emission^(1/3), G = dust tau / 3, B = reflection^(1/3); integrals in arcsec^2 at unit peak',
               'sprites': meta}, open(os.path.join(OUT, 'nebulae.json'), 'w'), indent=1)
    if PREV:
        os.makedirs(PREV, exist_ok=True)
        e = atlas[..., 0] ** 3
        r = atlas[..., 2] ** 3
        d = atlas[..., 1] * 3
        rgb = np.stack([e * 1.0 + r * 0.5, e * 0.35 + r * 0.7, e * 0.5 + r * 1.2], -1)
        rgb = np.arcsinh(rgb / 0.03) / np.arcsinh(1 / 0.03)
        bgc = 0.12 * np.exp(-d)[..., None]  # a uniform star-field glow behind, to show the dust
        rgb = rgb + bgc
        Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).resize((AW * 2, AH * 2), Image.LANCZOS).save(os.path.join(PREV, 'nebulae_preview.png'))


if __name__ == '__main__':
    main()
