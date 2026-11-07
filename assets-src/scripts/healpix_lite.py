"""Minimal HEALPix (NESTED) support in numpy, plus a reader for LAMBDA HEALPix FITS binary tables.
ang2pix follows the standard algorithm of Gorski et al. 2005 (healpix_base loc2pix, NEST scheme)."""
import numpy as np


def read_healpix_fits(path, column=0):
    """Return (values float32 array, header dict) for a one-row-per-pixel HEALPix bintable."""
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
                    cards[key] = c[10:].split('/')[0].strip().strip("'").strip()
            if end:
                break
        hdrs.append(cards)
    h = hdrs[1]
    rowlen = int(h['NAXIS1'])
    nrows = int(h['NAXIS2'])
    nf = int(h['TFIELDS'])
    forms = [h['TFORM%d' % (i + 1)] for i in range(nf)]
    assert all(f.strip() == '1E' for f in forms), forms
    arr = np.frombuffer(d[pos:pos + rowlen * nrows], dtype='>f4').reshape(nrows, nf)
    return arr[:, column].astype(np.float32), {**hdrs[0], **h}


def _spread_bits(v):
    v = v.astype(np.int64)
    out = np.zeros_like(v)
    for b in range(20):
        out |= ((v >> b) & 1) << (2 * b)
    return out


def ang2pix_nest(nside, z, phi):
    """z = cos(theta) (theta = colatitude), phi in radians. Vectorised."""
    z = np.asarray(z, np.float64)
    phi = np.asarray(phi, np.float64)
    za = np.abs(z)
    tt = np.mod(phi, 2 * np.pi) * (2 / np.pi)  # [0,4)
    face = np.zeros(z.shape, np.int64)
    ix = np.zeros(z.shape, np.int64)
    iy = np.zeros(z.shape, np.int64)
    eq = za <= 2.0 / 3.0
    # equatorial region
    t1 = nside * (0.5 + tt[eq])
    t2 = nside * z[eq] * 0.75
    jp = (t1 - t2).astype(np.int64)
    jm = (t1 + t2).astype(np.int64)
    ifp = jp // nside
    ifm = jm // nside
    f = np.where(ifp == ifm, ifp | 4, np.where(ifp < ifm, ifp, ifm + 8))
    face[eq] = f
    ix[eq] = jm & (nside - 1)
    iy[eq] = nside - (jp & (nside - 1)) - 1
    # polar caps
    po = ~eq
    ntt = np.minimum(3, tt[po].astype(np.int64))
    tp = tt[po] - ntt
    tmp = nside * np.sqrt(3 * (1 - za[po]))
    jp = np.minimum((tp * tmp).astype(np.int64), nside - 1)
    jm = np.minimum(((1 - tp) * tmp).astype(np.int64), nside - 1)
    north = z[po] >= 0
    face[po] = np.where(north, ntt, ntt + 8)
    ix[po] = np.where(north, nside - jm - 1, jp)
    iy[po] = np.where(north, nside - jp - 1, jm)
    return face * nside * nside + _spread_bits(ix) + (_spread_bits(iy) << 1)
