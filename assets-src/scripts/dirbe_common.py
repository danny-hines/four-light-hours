"""Shared helpers for the sky piece: read COBE/DIRBE ZSMA FITS binary tables and project the COBE
quadrilateralized spherical cube (resolution 9, ecliptic J2000) onto any set of directions.

The forward CSC polynomial (sphere -> face plane) is the published COBE "incube" fit
(Chan & O'Neill 1975, as used in the COBE software and in WCSLIB's CSC projection).
Face orientation conventions were verified against the data itself (see build_milkyway.py).
"""
import sys


def _bootstrap():
    # isolated mode (python -I) drops the user site-packages where numpy/PIL live on this machine
    import site
    p = site.getusersitepackages()
    if p not in sys.path:
        sys.path.append(p)


_bootstrap()

import numpy as np  # noqa: E402

NSIDE = 256
OBL = np.radians(23.4392911)


def read_zsma(path):
    """Return (pixel_no int array, resid float32 array) from a DIRBE ZSMA FITS file."""
    d = open(path, 'rb').read()
    pos = 0
    hdrs = []
    for _ in range(2):
        cards = {}
        while True:
            blk = d[pos:pos + 2880]
            pos += 2880
            end = False
            for k in range(36):
                c = blk[k * 80:(k + 1) * 80].decode('ascii', 'replace')
                key = c[:8].strip()
                if key == 'END':
                    end = True
                    break
                if c[8:10] == '= ':
                    v = c[10:].split('/')[0].strip().strip("'").strip()
                    cards[key] = v
            if end:
                break
        hdrs.append(cards)
    h = hdrs[1]
    rowlen = int(h['NAXIS1'])
    nrows = int(h['NAXIS2'])
    dt = np.dtype([('pix', '>i4'), ('resid', '>f4'), ('nobs', '>i4'), ('nwks', 'u1'), ('sd', '>f4')])
    assert dt.itemsize == rowlen, (dt.itemsize, rowlen)
    arr = np.frombuffer(d[pos:pos + rowlen * nrows], dtype=dt)
    return arr['pix'].astype(np.int64), arr['resid'].astype(np.float32)


def to_full(path):
    pix, val = read_zsma(path)
    full = np.full(6 * NSIDE * NSIDE, np.nan, np.float32)
    ok = val > -16000
    full[pix[ok]] = val[ok]
    return full


def incube(alpha, beta):
    gstar = 1.37484847732
    g = -0.13161671474
    m = 0.004869491981
    w1 = -0.159596235474
    c00 = 0.141189631152
    c10 = 0.0809701286525
    c01 = -0.281528535557
    c11 = 0.15384112876
    c20 = -0.178251207466
    c02 = 0.106959469314
    d0 = 0.0759196200467
    d1 = -0.0217762490699
    aa = alpha * alpha
    bb = beta * beta
    a4 = aa * aa
    b4 = bb * bb
    onmaa = 1 - aa
    onmbb = 1 - bb
    x = alpha * (gstar + aa * (1 - gstar) + onmaa * (bb * (g + (m - g) * aa + onmbb * (c00 + c10 * aa + c01 * bb + c11 * aa * bb + c20 * a4 + c02 * b4)) + aa * (w1 - onmaa * (d0 + d1 * aa))))
    y = beta * (gstar + bb * (1 - gstar) + onmbb * (aa * (g + (m - g) * bb + onmaa * (c00 + c10 * bb + c01 * aa + c11 * aa * bb + c20 * b4 + c02 * a4)) + bb * (w1 - onmbb * (d0 + d1 * bb))))
    return x, y


def axisxy(c):
    """c: (N,3) ecliptic unit vectors -> face (N,), x, y in [0,1)."""
    c1, c2, c3 = c[:, 0], c[:, 1], c[:, 2]
    a1, a2, a3 = np.abs(c1), np.abs(c2), np.abs(c3)
    face = np.zeros(len(c), np.int64)
    xi = np.zeros(len(c))
    eta = np.zeros(len(c))
    f0 = (a3 >= a2) & (a3 >= a1) & (c3 > 0)
    f5 = (a3 >= a2) & (a3 >= a1) & (c3 <= 0)
    rest = ~(f0 | f5)
    f1 = rest & (a1 >= a2) & (c1 > 0)
    f3 = rest & (a1 >= a2) & (c1 <= 0)
    f2 = rest & (a2 > a1) & (c2 > 0)
    f4 = rest & (a2 > a1) & (c2 <= 0)
    face[f0] = 0; eta[f0] = -c1[f0] / c3[f0]; xi[f0] = c2[f0] / c3[f0]
    face[f1] = 1; xi[f1] = c2[f1] / c1[f1]; eta[f1] = c3[f1] / c1[f1]
    face[f2] = 2; eta[f2] = c3[f2] / c2[f2]; xi[f2] = -c1[f2] / c2[f2]
    face[f3] = 3; eta[f3] = -c3[f3] / c1[f3]; xi[f3] = c2[f3] / c1[f3]
    face[f4] = 4; eta[f4] = -c3[f4] / c2[f4]; xi[f4] = -c1[f4] / c2[f4]
    face[f5] = 5; eta[f5] = -c1[f5] / c3[f5]; xi[f5] = -c2[f5] / c3[f5]
    x, y = incube(xi, eta)
    return face, (x + 1) / 2, (y + 1) / 2


def interleave(ix, iy):
    """bit-interleave: ix -> even bits, iy -> odd bits."""
    out = np.zeros_like(ix)
    for b in range(9):
        out |= ((ix >> b) & 1) << (2 * b)
        out |= ((iy >> b) & 1) << (2 * b + 1)
    return out


def d4(ix, iy, k):
    n = NSIDE - 1
    if k & 4:
        ix, iy = iy, ix
    if k & 1:
        ix = n - ix
    if k & 2:
        iy = n - iy
    return ix, iy


def pixel_index(c, orient=(0, 0, 0, 0, 0, 0)):
    face, x, y = axisxy(c)
    ix = np.clip((x * NSIDE).astype(np.int64), 0, NSIDE - 1)
    iy = np.clip((y * NSIDE).astype(np.int64), 0, NSIDE - 1)
    out = np.zeros(len(c), np.int64)
    for f in range(6):
        s = face == f
        jx, jy = d4(ix[s], iy[s], orient[f])
        out[s] = f * NSIDE * NSIDE + interleave(jx, jy)
    return out, face


# ---- frames
def rot_ecl_to_equ():
    ce, se = np.cos(OBL), np.sin(OBL)
    return np.array([[1, 0, 0], [0, ce, -se], [0, se, ce]])


def radec_vec(ra_deg, dec_deg):
    ra, dec = np.radians(ra_deg), np.radians(dec_deg)
    return np.array([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)])


def rot_equ_to_gal():
    """Rows are galactic X (to GC), Y (l=90), Z (NGP) expressed in equatorial J2000."""
    zg = radec_vec(192.85948, 27.12825)
    xg = radec_vec(266.40500, -28.93617)
    xg = xg - zg * np.dot(xg, zg)
    xg /= np.linalg.norm(xg)
    yg = np.cross(zg, xg)
    return np.vstack([xg, yg, zg])


def gal_grid(W, H, lat_fn=None):
    """Equirectangular galactic grid: centre column = l 0, l increasing to the LEFT (sky convention),
    row 0 = b +90. lat_fn maps v in [0,1] -> b in degrees (default linear).
    Returns (N,3) galactic unit vectors, L, B (deg, HxW)."""
    u = (np.arange(W) + 0.5) / W
    v = (np.arange(H) + 0.5) / H
    l = 180 - 360 * u
    b = lat_fn(v) if lat_fn else 90 - 180 * v
    L, B = np.meshgrid(np.radians(l), np.radians(b))
    vec = np.stack([np.cos(B) * np.cos(L), np.cos(B) * np.sin(L), np.sin(B)], -1).reshape(-1, 3)
    return vec, np.degrees(L), np.degrees(B)


def gal_to_equ(vec_gal):
    return vec_gal @ rot_equ_to_gal()


def gal_to_ecl(vec_gal):
    equ = gal_to_equ(vec_gal)
    return equ @ rot_ecl_to_equ()  # ecl = Me^T equ
