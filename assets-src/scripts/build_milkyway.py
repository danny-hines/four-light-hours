"""Build the Milky Way textures for the sky piece from public-domain NASA all-sky surveys.

    python -I build_milkyway.py ../raw ../../assets/sky [cache_dir] [preview_dir]

Inputs (assets-src/raw):
  sky_dirbe/DIRBE_BAND{1A,07,08,10}_ZSMA.FITS   COBE/DIRBE zodi-subtracted mission-average maps (NASA/GSFC LAMBDA)
  sky_iras_issa/ISSA_B4H0_healpix_ns1024.fits   IRAS Sky Survey Atlas 100 um, HEALPix (NASA/IPAC, via LAMBDA)
  ../../assets/sky/stars.bin                    Yale BSC5 (to mask bright stars out of the J-band starlight)

Model (an optical-band reconstruction, not a photograph):
  starlight S  = DIRBE 1.25 um surface brightness with bright stars masked and point sources median-clipped
                 (the stars themselves are drawn by the renderer from BSC5 + a procedural field)
  dust tau_V   = 100 um emission (DIRBE large scales + IRAS small scales at the full ~4' resolution), corrected to
                 column density with a DIRBE 100/240 um dust temperature, de-weighted where 60/100 um says the dust
                 is warm (HII regions glow, they are not dark), converted with SFD's E(B-V) = 0.0184 I100, R_V = 3.1
  layers       = very-near stars F in front of all dust (unextincted), and the background light S_bg behind a
                 near / mid / far split of the column (near clouds from a dust-layer geometry plus known nearby
                 dark-cloud complexes treated as foreground screens)
The renderer composes the extinction PER PIXEL:  L_c = pop_c * (F + S_bg * exp(-tau_eff) * exp(-(k_c - 1) rho tau_eff))
with a sharp, high-resolution tau_eff (so dust-lane edges stay crisp at any zoom), the population colour pop_c
(disk / bulge blackbody, computed in the shader) and reddening k_c = A_c/A_V applied to the background term only.

Outputs:
  assets/sky/milkyway.webp  1024x256 RGB, galactic (l = 0 at centre, increasing to the LEFT; b = +90 at top; latitude
                            stretched as b = 90 sinh(K y)/sinh(K)):
                            R = log F, G = log S_bg (linear radiance, log-encoded), B = rho (reddening fraction)
  assets/sky/dust.webp      4096x1024 grey, same projection: log-encoded tau_eff (effective V optical depth of the
                            background light), IRAS-resolution
  assets/sky/milkyway.json  encoding constants
"""
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dirbe_common import pixel_index, gal_to_ecl, to_full  # noqa: E402  (also bootstraps site-packages)
from healpix_lite import ang2pix_nest, read_healpix_fits  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from scipy import ndimage as nd  # noqa: E402

RAW = sys.argv[1] if len(sys.argv) > 1 else '../raw'
OUT = sys.argv[2] if len(sys.argv) > 2 else '../../assets/sky'
CACHE = sys.argv[3] if len(sys.argv) > 3 else os.path.join(RAW, '..', 'cache_sky')
PREVIEW = sys.argv[4] if len(sys.argv) > 4 else None
os.makedirs(CACHE, exist_ok=True)


class Grid:
    """Equirectangular galactic grid: column 0 = l +180 (l decreasing to the right), row 0 = b +90."""

    def __init__(self, degpx):
        self.d = degpx
        self.H = int(round(180 / degpx))
        self.W = 2 * self.H
        self.B = 90 - (np.arange(self.H) + 0.5) * degpx
        self.L = 180 - (np.arange(self.W) + 0.5) * degpx


G0 = Grid(0.125)   # DIRBE-scale processing (smooth quantities)
G1 = Grid(0.0625)  # IRAS-scale processing (dust structure)


# ------------------------------------------------------------------------------------------- reprojection
def reproject_all():
    path = os.path.join(CACHE, 'reproj.npz')
    if os.path.exists(path):
        return dict(np.load(path))
    H, W = G0.H, G0.W
    issa, _ = read_healpix_fits(os.path.join(RAW, 'sky_iras_issa', 'ISSA_B4H0_healpix_ns1024.fits'))
    bands = ['1A', '07', '08', '10']
    dirbe = {k: to_full(os.path.join(RAW, 'sky_dirbe', f'DIRBE_BAND{k}_ZSMA.FITS')) for k in bands}
    acc = {k: np.zeros(H * W) for k in bands}
    isum = np.zeros(H * W)
    icnt = np.zeros(H * W)
    for sy in range(2):
        for sx in range(2):
            u = (np.arange(W) + 0.25 + 0.5 * sx) / W
            v = (np.arange(H) + 0.25 + 0.5 * sy) / H
            Lg, Bg = np.meshgrid(np.radians(180 - 360 * u), np.radians(90 - 180 * v))
            vec = np.stack([np.cos(Bg) * np.cos(Lg), np.cos(Bg) * np.sin(Lg), np.sin(Bg)], -1).reshape(-1, 3)
            iv = issa[ang2pix_nest(1024, vec[:, 2], np.arctan2(vec[:, 1], vec[:, 0]))].astype(np.float64)
            ok = iv > -1000
            isum += np.where(ok, iv, 0)
            icnt += ok
            pd, _ = pixel_index(gal_to_ecl(vec))
            for k in bands:
                acc[k] += dirbe[k][pd] / 4
    out = {k: acc[k].reshape(H, W).astype(np.float32) for k in bands}
    out['issa'] = np.where(icnt > 0, isum / np.maximum(icnt, 1), np.nan).reshape(H, W).astype(np.float32)
    np.savez(path, **out)
    return out


def reproject_issa_hi():
    """IRAS 100 um on the fine grid (2x2 supersampled; the HEALPix Nside 1024 pixel is 3.4')."""
    path = os.path.join(CACHE, 'issa_hi.npy')
    if os.path.exists(path):
        return np.load(path)
    H, W = G1.H, G1.W
    issa, _ = read_healpix_fits(os.path.join(RAW, 'sky_iras_issa', 'ISSA_B4H0_healpix_ns1024.fits'))
    out = np.full((H, W), np.nan, np.float32)
    step = 360
    for r0 in range(0, H, step):
        r1 = min(H, r0 + step)
        isum = np.zeros((r1 - r0, W))
        icnt = np.zeros((r1 - r0, W))
        for sy in range(2):
            for sx in range(2):
                u = (np.arange(W) + 0.25 + 0.5 * sx) / W
                v = (np.arange(r0, r1) + 0.25 + 0.5 * sy) / H
                Lg, Bg = np.meshgrid(np.radians(180 - 360 * u), np.radians(90 - 180 * v))
                z = np.sin(Bg)
                iv = issa[ang2pix_nest(1024, z.ravel(), Lg.ravel())].reshape(z.shape).astype(np.float64)
                ok = iv > -1000
                isum += np.where(ok, iv, 0)
                icnt += ok
        out[r0:r1] = np.where(icnt > 0, isum / np.maximum(icnt, 1), np.nan)
    np.save(path, out)
    return out


def gsmooth(a, sig_deg, g, mask=None):
    """NaN/mask-aware Gaussian smoothing on an equirect grid; horizontal sigma widened by 1/cos(b)."""
    if mask is None:
        mask = np.isfinite(a)
    a0 = np.where(mask, a, 0.0)
    m0 = mask.astype(np.float64)
    sy = sig_deg / g.d
    a1 = nd.gaussian_filter1d(a0, sy, axis=0, mode='nearest')
    m1 = nd.gaussian_filter1d(m0, sy, axis=0, mode='nearest')
    out = np.empty_like(a1)
    mo = np.empty_like(m1)
    edges = np.linspace(0, g.H, 97).astype(int)
    for i in range(96):
        r0, r1 = edges[i], edges[i + 1]
        cb = max(np.cos(np.radians(g.B[(r0 + r1) // 2])), 0.03)
        sx = min(sy / cb, g.W / 3)
        out[r0:r1] = nd.gaussian_filter1d(a1[r0:r1], sx, axis=1, mode='wrap')
        mo[r0:r1] = nd.gaussian_filter1d(m1[r0:r1], sx, axis=1, mode='wrap')
    return out / np.maximum(mo, 1e-9)


def up2(a):
    """G0 -> G1 bilinear upsampling (pixel-centre aligned, longitude wraps)."""
    a = np.asarray(a, np.float64)
    H, W = a.shape
    y = np.arange(2 * H) / 2 - 0.25
    y0 = np.clip(np.floor(y).astype(int), 0, H - 1)
    y1 = np.clip(y0 + 1, 0, H - 1)
    ty = np.clip(y - np.floor(y), 0, 1)[:, None]
    r = a[y0] * (1 - ty) + a[y1] * ty
    x = np.arange(2 * W) / 2 - 0.25
    x0 = np.floor(x).astype(int)
    tx = (x - x0)[None, :]
    return r[:, x0 % W] * (1 - tx) + r[:, (x0 + 1) % W] * tx


def down2(a):
    H, W = a.shape
    return a.reshape(H // 2, 2, W // 2, 2).mean((1, 3))


def gal_lb_of_radec(ra_deg, dec_deg):
    from dirbe_common import rot_equ_to_gal
    ra, dec = np.radians(ra_deg), np.radians(dec_deg)
    v = np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], -1)
    gv = v @ rot_equ_to_gal().T
    return np.degrees(np.arctan2(gv[..., 1], gv[..., 0])), np.degrees(np.arcsin(np.clip(gv[..., 2], -1, 1)))


def ang_dist(g, l0, b0, rows=None):
    """Angular distance (deg) from (l0, b0) for every grid cell (or a row subset)."""
    B = np.radians(g.B if rows is None else g.B[rows])[:, None]
    L = np.radians(g.L)[None, :]
    cosd = np.sin(np.radians(b0)) * np.sin(B) + np.cos(np.radians(b0)) * np.cos(B) * np.cos(L - np.radians(l0))
    return np.degrees(np.arccos(np.clip(cosd, -1, 1)))


def disc_mask(g, l0, b0, r_deg):
    m = np.zeros((g.H, g.W), bool)
    y0 = int((90 - b0 - r_deg) / g.d) - 1
    y1 = int((90 - b0 + r_deg) / g.d) + 2
    ys = np.arange(max(0, y0), min(g.H, y1))
    m[ys] = ang_dist(g, l0, b0, ys) < r_deg
    return m


# Magellanic Clouds and M31: their own dust/IR emission must not be read as Galactic extinction, and their light
# is drawn procedurally by the shader (with optical structure), so they are masked out of both channels here.
EXTRAGAL = [
    (280.47, -32.89, 6.0),  # LMC
    (302.81, -44.33, 3.2),  # SMC
    (121.17, -21.57, 1.6),  # M31
]


def build0():
    """Smooth quantities on G0: starlight S, the DIRBE dust column pieces, temperature and warm-dust weights."""
    path = os.path.join(CACHE, 'phys0.npz')
    if os.path.exists(path) and not os.environ.get('MW_REBUILD'):
        return {k: v.astype(np.float64) for k, v in np.load(path).items()}
    g = reproject_all()
    gd = G0
    d100 = g['08'].astype(np.float64)
    issa = g['issa'].astype(np.float64)
    mask_i = np.isfinite(issa)
    d100_s = gsmooth(d100, 0.52, gd)
    issa_s = gsmooth(issa, 0.6, gd, mask_i)
    gain = np.clip(d100_s / np.maximum(issa_s, 0.3), 0.5, 2.0)
    gain = gsmooth(gain, 2.0, gd)
    # temperature from the 100/240 colour (beta = 2), only where 240 um has signal
    r100 = gsmooth(d100, 1.0, gd)
    r240 = gsmooth(g['10'].astype(np.float64), 1.0, gd)
    T_REF = 18.2
    Tg = np.linspace(10, 40, 601)
    Rg = 2.4 ** 5 * (np.exp(59.95 / Tg) - 1) / (np.exp(143.9 / Tg) - 1)
    T = np.interp(r100 / np.maximum(r240, 1e-3), Rg, Tg)
    wsig = np.clip((r240 - 4) / 10, 0, 1)
    T = gsmooth(T * wsig + T_REF * (1 - wsig), 0.8, gd)
    X = np.clip((np.exp(143.9 / T) - 1) / (np.exp(143.9 / T_REF) - 1), 0.4, 3.0)
    # warm dust (high 60/100) marks HII / star-forming regions: much of that emission is not a foreground screen
    r60 = gsmooth(g['07'].astype(np.float64), 0.7, gd) / np.maximum(gsmooth(d100, 0.7, gd), 0.5)
    warm = gsmooth(np.clip((r60 - 0.30) / 0.35, 0, 1), 1.2, gd)
    # ----------------------------------------------------------------- starlight (J band)
    J = g['1A'].astype(np.float64)
    d = open(os.path.join(OUT, 'stars.bin'), 'rb').read() if os.path.exists(os.path.join(OUT, 'stars.bin')) else \
        open(os.path.join(RAW, 'stars_bsc5', 'stars.bin'), 'rb').read()
    n = struct.unpack('<I', d[:4])[0]
    st = np.frombuffer(d[4:4 + 16 * n], dtype='<f4').reshape(n, 4).astype(np.float64)
    vj = np.where(st[:, 3] > 0.3, 1.9 * st[:, 3], 0.6 * st[:, 3])
    Jm = st[:, 2] - vj
    sl, sb = gal_lb_of_radec(np.degrees(st[:, 0]), np.degrees(st[:, 1]))
    smask = np.zeros((gd.H, gd.W), bool)
    for k in np.where(Jm < 4.5)[0]:
        smask |= disc_mask(gd, sl[k], sb[k], min(0.45 + 0.13 * (4.5 - Jm[k]), 1.4))
    for l0, b0, r in EXTRAGAL:
        smask |= disc_mask(gd, l0, b0, r)
    Jf = gsmooth(J, 0.9, gd, ~smask)
    J = np.where(smask, Jf, J)
    # median clip remaining point sources (window widened toward the poles)
    Jc = np.empty_like(J)
    edges = np.linspace(0, gd.H, 49).astype(int)
    for i in range(48):
        r0, r1 = edges[i], edges[i + 1]
        a0, a1 = max(0, r0 - 12), min(gd.H, r1 + 12)
        cb = max(np.cos(np.radians(gd.B[(r0 + r1) // 2])), 0.08)
        wx = int(min(13 / cb, 161)) | 1
        blk = np.concatenate([J[a0:a1, -wx:], J[a0:a1], J[a0:a1, :wx]], 1)
        med = nd.median_filter(blk, size=(1, wx), mode='nearest')
        med = nd.median_filter(med, size=(13, 1), mode='nearest')[:, wx:-wx]
        Jc[r0:r1] = med[r0 - a0:r0 - a0 + (r1 - r0)]
    J = np.minimum(J, Jc * 1.10)
    S_det = gsmooth(J, 0.35, gd)
    S_lo = gsmooth(J, 3.0, gd)
    ab = np.abs(gd.B)[:, None]
    wlat = np.clip((ab - 6) / 18, 0, 1)
    wlat = wlat * wlat * (3 - 2 * wlat)
    S = S_det * (1 - wlat) + S_lo * wlat
    S = np.maximum(S - J0, 0)
    out = dict(S=S, d100_s=d100_s, gain=gain, X=X, warm=warm)
    np.savez(path, **{k: v.astype(np.float32) for k, v in out.items()})
    return out


def line_opening(a, length, n_ang=12):
    """Max over orientations of grey openings with a straight-line structuring element. A compact peak (shorter
    than `length` in every direction) is removed; a filament longer than `length` survives in the orientation
    that runs along it. (A square opening, used before, also erased every filament narrower than the square, which
    left only soft round plateaus -- the 'cotton-ball' dust.)"""
    r = length // 2
    out = None
    for k in range(n_ang):
        th = np.pi * k / n_ang
        fp = np.zeros((2 * r + 1, 2 * r + 1), bool)
        for t in np.linspace(-r, r, 4 * r + 1):
            fp[int(round(r + t * np.sin(th))), int(round(r + t * np.cos(th)))] = True
        o = nd.grey_opening(a, footprint=fp, mode='nearest')
        out = o if out is None else np.maximum(out, o)
    return out


# Bright HII regions south of the LBN limit (Dec < -33) and a few large northern complexes: (l, b, radius deg).
# Inside them the far-IR excess is the nebula's own warm dust (behind or around the ionised gas), not a dark screen.
HII_SOUTH = [
    (294.8, -1.6, 1.1),   # IC 2944/2948 (lambda Cen)
    (287.6, -0.7, 1.6),   # Carina nebula
    (291.6, -0.5, 0.5),   # NGC 3603
    (291.3, -0.7, 0.5),   # NGC 3576
    (284.3, -0.3, 0.6),   # RCW 49 / Westerlund 2
    (286.2, -0.2, 0.5),   # NGC 3324
    (282.0, -1.8, 0.5),   # RCW 46
    (336.5, -1.5, 0.7),   # NGC 6188 / RCW 108
    (351.2, 0.6, 0.9),    # NGC 6334
    (353.2, 0.9, 0.9),    # NGC 6357
    (305.3, 0.1, 0.8),    # G305
    (333.6, -0.2, 0.7),   # G333
    (268.0, -1.0, 0.5),   # RCW 38
    (263.6, -0.5, 0.6),   # RCW 36 / Vela C region
    (243.2, 0.4, 0.4),    # NGC 2467
    (6.0, -1.2, 0.8),     # M8 Lagoon
    (7.0, -0.3, 0.45),    # M20 Trifid
    (15.1, -0.7, 0.6),    # M17
    (17.0, 0.8, 0.6),     # M16
    (209.0, -19.4, 0.9),  # M42 / M43 (the bright core of the Orion A cloud is behind the nebula)
    (206.5, -16.4, 0.45), # NGC 2024
    (206.3, -2.1, 0.9),   # Rosette
    (99.3, 3.7, 1.4),     # IC 1396
    (134.7, 0.9, 0.9),    # IC 1805 (Heart)
    (137.2, 1.0, 0.9),    # IC 1848 (Soul)
    (160.6, -12.1, 1.2),  # California
    (195.1, -12.0, 2.2),  # lambda Ori (interior of the dust ring)
]


def hii_mask(g):
    """Soft mask (0..1) of bright emission nebulae: the hand list above plus Lynds' Bright Nebulae that are red on
    the POSS plates (colour class 3-4, i.e. HII regions) with brightness class 1-4."""
    from votable_lite import read_votable
    regs = [(l, b, r, 1.0) for l, b, r in HII_SOUTH]
    try:
        for x in read_votable(os.path.join(RAW, 'sky_darkclouds', 'lbn_heasarc.xml')):
            if x['color'] in (3, 4) and x['brightness'] in (1, 2, 3, 4):
                dim = 0.5 * (float(x['large_dimension'] or 0) + float(x['small_dimension'] or 0)) / 60.0
                if dim < 0.08:
                    continue
                w = {1: 1.0, 2: 1.0, 3: 0.85, 4: 0.6}[x['brightness']]
                regs.append((float(x['lii']), float(x['bii']), 0.6 * dim, w))
    except Exception as e:  # catalogue missing: hand list only
        print('LBN not used:', e)
    m = np.zeros((g.H, g.W))
    for l0, b0, r, w in regs:
        r = max(r, 0.15)
        y0 = max(0, int((90 - b0 - 1.6 * r) / g.d) - 1)
        y1 = min(g.H, int((90 - b0 + 1.6 * r) / g.d) + 2)
        rows = np.arange(y0, y1)
        t = np.clip((1.5 - ang_dist(g, l0, b0, rows) / r) / 0.7, 0, 1)
        m[rows] = np.maximum(m[rows], w * t * t * (3 - 2 * t))
    return m


def av_hi(p):
    """V-band dust column on G1 at IRAS resolution."""
    path = os.path.join(CACHE, 'av_hi_v3.npz')
    if os.path.exists(path) and not os.environ.get('MW_REBUILD'):
        z = np.load(path)
        return z['clean'].astype(np.float64), z['raw'].astype(np.float64)
    issa = reproject_issa_hi().astype(np.float64)
    mask_i = np.isfinite(issa)
    issa_s = gsmooth(issa, 0.6, G1, mask_i)
    d100_s = up2(p['d100_s'])
    hp = np.where(mask_i, (issa - issa_s) * up2(p['gain']), 0.0)
    # compact positive spikes (IR point sources, compact HII) are clipped: they are warm, not dark
    hp = np.clip(hp, -0.8 * d100_s, 1.2 * d100_s)
    # compact far-IR peaks (< ~0.6 deg) near the plane are overwhelmingly warm sources (HII regions, YSO clusters),
    # not dark clouds. They are removed with an oriented line opening, which keeps filaments (dark lanes, streamers)
    # of any width as long as they are longer than the line. Away from the plane compact peaks are kept: there they
    # are mostly cold dense cores, which are exactly the optical dark nebulae.
    rows = np.where(np.abs(G1.B) < 10)[0]
    pad = 16
    band = hp[rows]
    band = np.concatenate([band[:, -pad:], band, band[:, :pad]], 1)
    hpo = line_opening(band, 11)[:, pad:-pad]
    wb = np.clip((9.0 - np.abs(G1.B[rows])) / 4.0, 0, 1)[:, None]
    hp[rows] = hp[rows] - wb * 0.7 * np.maximum(hp[rows] - hpo, 0)
    feather = np.clip((nd.gaussian_filter(mask_i.astype(np.float64), 6) - 0.5) * 2, 0, 1)
    I100 = np.maximum(d100_s + hp * feather, 0.05)
    # inside bright HII regions the 100 um excess over the surrounding column is the nebula's own warm dust (behind
    # or mixed with the ionised gas), not a foreground screen: replace it by a ~3 deg lower envelope
    hm = hii_mask(G1)
    li = np.log(I100[::4, ::4])
    env = nd.grey_opening(np.concatenate([li[:, -16:], li, li[:, :16]], 1), size=(13, 13), mode='nearest')[:, 16:-16]
    env = nd.gaussian_filter(env, 2.0, mode='nearest')
    env = np.exp(np.repeat(np.repeat(env, 4, 0), 4, 1))[:G1.H, :G1.W]
    out = []
    for I in (I100 - 0.92 * hm * np.maximum(I100 - env, 0), I100):
        N100 = np.maximum(I - 0.8, 0.0) * up2(p['X']) * (1 - 0.5 * up2(p['warm']))
        AV = 3.1 * 0.0184 * N100
        for l0, b0, r in EXTRAGAL:  # replace by the surrounding Galactic foreground
            m = disc_mask(G1, l0, b0, r)
            ring = disc_mask(G1, l0, b0, r * 1.6) & ~m
            AV[m] = np.median(AV[ring])
        out.append(AV)
    # clean: the HII regions' own warm dust removed (used for the foreground screens); raw: the total column
    np.savez(path, clean=out[0].astype(np.float32), raw=out[1].astype(np.float32))
    return out[0], out[1]


# optical model constants (tuned by eye against all-sky optical panoramas; see notes/sky.md)
J0 = 0.05
P = 1.25          # contrast exponent: the unresolved (fainter than ~mag 10) starlight is more plane-concentrated than J
GAIN = 0.25       # radiance scale of the stored layers (the shader applies its own calibration on top)
SN0, BN, CL = 0.8, 12.0, 0.4      # near-star light cap: SN0 * exp(-|b|/BN) * (1 + CL cos l)   (J units)
MID = 2.0                         # mid-distance light cap, in units of the near cap
VNEAR = 0.12                      # the nearest stars (fraction of the near cap) lie in front of all dust
H_DUST, L_IN, L_OUT, NEAR = 0.125, 14.0, 5.0, 1.0  # kpc: dust scale height, disk path toward/away from GC, near zone
NEAR_CAP = 2.6    # max smooth near-zone tau_V
CG = 0.5          # fraction of the small-scale column excess (clouds) that is foreground
FM = 0.15         # fraction of the remaining column in front of mid-distance stars
WK = 0.2          # warm (HII-heated) dust is mostly embedded, not foreground


# (l, b, radius deg): nearby dark-cloud complexes whose column excess is a foreground screen.
NEAR_CLOUDS = [
    (301.0, -1.0, 4.5, 0.2),  # Coalsack (~180 pc): its IRAS excess is mostly the distant plane behind it; the
                              # optical cloud (A_V ~ 1-1.5) is the explicit screen below
    (359.0, 5.0, 4.5),    # Pipe Nebula + B72 (~130-200 pc)
    (3.0, 2.5, 3.0),      # dark lanes toward Sgr, foreground Ophiuchus complex
    (28.0, 3.5, 8.0),     # Aquila Rift (~250 pc)
    (18.0, 1.5, 4.0),     # Aquila Rift southern extension over Scutum
    (77.0, 1.5, 7.0, 0.45),  # Cygnus Rift (~600-800 pc); half weight: behind it, Cygnus X (1.4 kpc) fills the IRAS map
    (45.0, 2.0, 6.0),     # Great Rift through Aquila / Vulpecula
    (353.0, 17.0, 6.0),   # rho Ophiuchi
    (339.0, 12.0, 6.0),   # Lupus
    (300.0, -16.0, 4.0),  # Chamaeleon
    (0.0, -18.0, 3.0),    # Corona Australis
]


# (l, b, radius deg): distant giant star-forming complexes. Their far-IR clumps are warm gas and dust 1.5-5 kpc
# away, mostly hidden behind nearer dust -- not foreground screens -- so their column excess is kept out of the
# near layer (otherwise each IR clump becomes a black puff on the optical sky).
FAR_COMPLEXES = [
    (79.5, 0.5, 6.5),     # Cygnus X (1.4 kpc)
    (287.5, -0.7, 3.5),   # Carina complex (2.3 kpc)
    (284.3, -0.3, 1.8),   # RCW 49 / Westerlund 2
    (305.3, 0.1, 1.8),    # G305
    (333.0, -0.3, 2.5),   # G333 / Norma
    (351.5, 0.5, 2.5),    # NGC 6334 / 6357
    (15.0, -0.6, 2.5),    # M17 / M16 / W39
    (30.8, 0.0, 2.5),     # W43
    (49.4, -0.3, 2.0),    # W51
    (134.0, 1.0, 3.0),    # W3 / W4 / W5
]


def far_complex_mask(g):
    m = np.zeros((g.H, g.W))
    for l0, b0, r in FAR_COMPLEXES:
        y0 = max(0, int((90 - b0 - 1.3 * r) / g.d) - 1)
        y1 = min(g.H, int((90 - b0 + 1.3 * r) / g.d) + 2)
        rows = np.arange(y0, y1)
        t = np.clip(1.3 - ang_dist(g, l0, b0, rows) / r, 0, 1)
        m[rows] = np.maximum(m[rows], t * t * (3 - 2 * t))
    return m


def near_cloud_mask(g):
    m = np.zeros((g.H, g.W))
    for cl in NEAR_CLOUDS:
        l0, b0, r = cl[:3]
        wgt = cl[3] if len(cl) > 3 else 1.0
        y0 = max(0, int((90 - b0 - 1.3 * r) / g.d) - 1)
        y1 = min(g.H, int((90 - b0 + 1.3 * r) / g.d) + 2)
        rows = np.arange(y0, y1)
        t = np.clip(1.3 - ang_dist(g, l0, b0, rows) / r, 0, 1)
        m[rows] = np.maximum(m[rows], wgt * t * t * (3 - 2 * t))
    return m


def coalsack_screen(g):
    """The Coalsack as an explicit foreground screen (~180 pc): an irregular ~7 x 5 deg oval centred SE of
    Acrux/Mimosa (RA 193, Dec -62.8), A_V ~ 1.6 at the core with a steep edge, plus its darker inner core."""
    l0, b0 = gal_lb_of_radec(193.0, -62.8)
    l0, b0 = float(l0) % 360, float(b0)
    rows = np.arange(max(0, int((90 - b0 - 6) / g.d)), min(g.H, int((90 - b0 + 6) / g.d)))
    B = g.B[rows][:, None]
    L = ((g.L[None, :] - l0 + 180) % 360) - 180
    x = L * np.cos(np.radians(B))  # deg, toward +l
    y = B - b0
    th = np.radians(-18)  # major axis tilted to the plane
    xr = x * np.cos(th) - y * np.sin(th)
    yr = x * np.sin(th) + y * np.cos(th)
    ang = np.arctan2(yr, xr)
    # lobed outline (irregular, a bay on the north-west side toward Crux)
    rad = 1 + 0.12 * np.cos(2 * ang + 0.6) + 0.08 * np.cos(3 * ang - 1.1) + 0.05 * np.cos(5 * ang + 2.0)
    # ragged, domain-warped boundary (0.3-0.5 deg ramp) with streaky internal structure, A_V ~ 1.0 over most of
    # the cloud and ~1.5 in its darker south-eastern core (Tapia's globule 2): a smoky screen, never an ink blot
    tile = _noise_tile(512, 53)
    n1 = _tile_sample(tile, xr * 14 + 120, yr * 14 + 40)
    n2 = _tile_sample(tile, xr * 40 + 300, yr * 90 + 210)
    rho = np.sqrt((xr / 3.4) ** 2 + (yr / 2.5) ** 2) / rad * np.exp(0.12 * n1 + 0.05 * n2)
    edge = np.clip((1.06 - rho) / 0.17, 0, 1)
    edge = edge * edge * (3 - 2 * edge)
    core = np.exp(-((xr + 0.4) ** 2 + (yr + 0.3) ** 2) / (2 * 0.9 ** 2))
    out = np.zeros((g.H, g.W))
    out[rows] = (0.95 * edge + 0.5 * core * edge) * np.exp(0.18 * n2 + 0.1 * n1) / 1.086
    return out


def _polyline_screen(g, pts_radec, width, av_core, seed, blobs=()):
    """An opaque near screen along a polyline of (RA, Dec) points: Gaussian-ish cross-section of half-width
    `width` deg (modulated along its length), plus optional blobs (RA, Dec, a, b, PA, A_V); noisy, steep edges."""
    lb = [tuple(float(v) for v in gal_lb_of_radec(r, d)) for r, d in pts_radec]
    l0, b0 = lb[len(lb) // 2]
    ext = max(max(abs(((l - l0 + 180) % 360) - 180), abs(b - b0)) for l, b in lb) + 4 * width + 3
    rows = np.arange(max(0, int((90 - b0 - ext) / g.d)), min(g.H, int((90 - b0 + ext) / g.d)))
    Bq = g.B[rows][:, None]
    dl = ((g.L[None, :] - l0 + 180) % 360) - 180
    cols = np.where(np.abs(dl[0]) < ext / max(np.cos(np.radians(b0)), 0.2))[0]
    x = dl[:, cols] * np.cos(np.radians(Bq))
    y = (Bq - b0) * np.ones_like(x)
    P = [((((l - l0 + 180) % 360) - 180) * np.cos(np.radians(b)), b - b0) for l, b in lb]
    dmin = np.full(x.shape, 1e9)
    tpos = np.zeros(x.shape)
    acc = 0.0
    for (ax, ay), (bx, by) in zip(P[:-1], P[1:]):
        vx, vy = bx - ax, by - ay
        L2 = vx * vx + vy * vy
        t = np.clip(((x - ax) * vx + (y - ay) * vy) / L2, 0, 1)
        d = np.hypot(x - ax - t * vx, y - ay - t * vy)
        sel = d < dmin
        dmin = np.where(sel, d, dmin)
        tpos = np.where(sel, acc + t * np.sqrt(L2), tpos)
        acc += np.sqrt(L2)
    tile = _noise_tile(512, seed)
    n1 = _tile_sample(tile, x * 70 + 100, y * 70 + 200)
    n2 = _tile_sample(tile, x * 190 + 300, y * 190 + 50)
    wv = width * np.exp(0.25 * _tile_sample(tile, tpos * 9 + 40, tpos * 3 + 7))   # width varies along the stem
    n0 = _tile_sample(tile, x * 16 + 410, y * 16 + 330)
    rr = dmin / wv * np.exp(0.32 * n0 + 0.22 * n1 + 0.12 * n2)
    # core with a soft ~0.1 deg ramp and wisps, plus a faint envelope out to ~3 half-widths (the stem's tenuous
    # outskirts and the dust around it), so the edge reads as smoke, not a stamped silhouette
    e = np.clip((1.25 - rr) / 0.85, 0, 1)
    env = np.exp(-0.5 * (rr / 1.9) ** 2)
    out_c = (av_core * e * e * (3 - 2 * e) + 0.22 * av_core * env) * np.exp(0.3 * n2 + 0.1 * n1)
    for ra, dec, a, b, pa, av in blobs:
        bl, bb = (float(v) for v in gal_lb_of_radec(ra, dec))
        bx, by = (((bl - l0 + 180) % 360) - 180) * np.cos(np.radians(bb)), bb - b0
        th = np.radians(pa)
        xr = (x - bx) * np.cos(th) + (y - by) * np.sin(th)
        yr = -(x - bx) * np.sin(th) + (y - by) * np.cos(th)
        ang = np.arctan2(yr, xr)
        rad = 1 + 0.16 * np.cos(2 * ang + 1.3) + 0.1 * np.cos(3 * ang - 0.4) + 0.07 * np.cos(5 * ang + 2.2)
        rb = np.sqrt((xr / a) ** 2 + (yr / b) ** 2) / rad * np.exp(0.3 * n0 + 0.3 * n1 + 0.18 * n2)
        e = np.clip((1.2 - rb) / 0.75, 0, 1)
        out_c = np.maximum(out_c, (av * e * e * (3 - 2 * e) + 0.2 * av * np.exp(-0.5 * (rb / 1.6) ** 2)) * np.exp(0.35 * n2))
    out = np.zeros((g.H, g.W))
    out[rows[:, None], cols[None, :]] = out_c / 1.086
    return out


def pipe_screen(g):
    """The Pipe Nebula (~130 pc, the 'hind legs' of the Dark Horse): the 3-degree stem from Barnard 59 east along
    B65-67 to the bowl (B77/B78), plus the Snake (B72) just north of the stem. Opaque, inky against the bulge."""
    stem = [(257.75, -27.45), (258.6, -27.2), (259.5, -27.0), (260.4, -26.85), (261.3, -26.65), (262.2, -26.35),
            (262.9, -26.1)]
    bowl = [(263.3, -25.9, 0.85, 0.62, 25, 1.9), (263.85, -25.35, 0.35, 0.28, -30, 1.4), (257.85, -27.4, 0.3, 0.24, 0, 2.6)]
    pipe = _polyline_screen(g, stem, 0.2, 2.3, 31, bowl)
    snake = _polyline_screen(g, [(262.6, -23.45), (262.75, -23.6), (262.68, -23.75), (262.82, -23.9)], 0.035, 1.8, 37)
    return np.maximum(pipe, snake)


# ------------------------------------------------------------------------------------------- optical dark clouds
# Lynds' Catalogue of Dark Nebulae (1962, from the POSS optical plates; NASA HEASARC table `ldn`): position, area and
# a visual opacity class 1-6 for 1791 clouds north of Dec -33. The IRAS column cannot separate the small nearby dark
# clouds from the bright inner-Galaxy emission behind them, so the catalogued optical clouds are stamped into the
# foreground screen as irregular, steep-edged shapes of the catalogued area and opacity.
LDN_AV = {1: 0.4, 2: 0.7, 3: 1.0, 4: 1.4, 5: 1.9, 6: 2.6}


def _noise_tile(n=512, seed=7):
    rng = np.random.default_rng(seed)
    acc = np.zeros((n, n))
    for s, a in ((24, 1.0), (12, 0.6), (6, 0.35), (3, 0.2)):
        w = nd.gaussian_filter(rng.standard_normal((n, n)), s, mode='wrap')
        acc += a * w / w.std()
    return acc / acc.std()


def _tile_sample(tile, x, y):
    n = tile.shape[0]
    xi = np.floor(x).astype(int) % n
    yi = np.floor(y).astype(int) % n
    fx, fy = x - np.floor(x), y - np.floor(y)
    x1, y1 = (xi + 1) % n, (yi + 1) % n
    return (tile[yi, xi] * (1 - fx) * (1 - fy) + tile[yi, x1] * fx * (1 - fy) + tile[y1, xi] * (1 - fx) * fy + tile[y1, x1] * fx * fy)


def orientation_field(tau, g, down=4, sig_deg=0.9):
    """Local filament orientation of the dust column (structure tensor of ln tau): returns, on a grid `down` times
    coarser, the angle of the iso-contour direction in the (l, b) tangent plane (rad, from +l toward +b) and the
    coherence 0..1 (1 = strongly elongated structure)."""
    lt = np.log(np.maximum(tau[::down, ::down], 1e-3))
    lt = nd.gaussian_filter(lt, 0.25 / (g.d * down), mode='nearest')
    d = g.d * down
    cb = np.maximum(np.cos(np.radians(g.B[::down])), 0.05)[:, None]
    gl = -np.gradient(lt, axis=1) / (d * cb)   # columns run toward decreasing l
    gb = -np.gradient(lt, axis=0) / d          # rows run toward decreasing b
    s = sig_deg / d
    jxx = nd.gaussian_filter(gl * gl, s, mode='nearest')
    jyy = nd.gaussian_filter(gb * gb, s, mode='nearest')
    jxy = nd.gaussian_filter(gl * gb, s, mode='nearest')
    th_grad = 0.5 * np.arctan2(2 * jxy, jxx - jyy)
    coh = np.sqrt((jxx - jyy) ** 2 + 4 * jxy ** 2) / (jxx + jyy + 1e-9)
    return th_grad + 0.5 * np.pi, coh


def ldn_tau(g, tau=None):
    path = os.path.join(CACHE, f'ldn_v3_{g.H}.npy')
    if os.path.exists(path) and not os.environ.get('MW_REBUILD') and not os.environ.get('LDN_REBUILD'):
        return np.load(path).astype(np.float64)
    from votable_lite import read_votable
    rows = read_votable(os.path.join(RAW, 'sky_darkclouds', 'ldn_heasarc.xml'))
    tile = _noise_tile()
    rng = np.random.default_rng(1962)
    acc = np.zeros((g.H, g.W))
    P3 = 3.0
    down = 4
    th_f, coh_f = orientation_field(tau, g, down) if tau is not None else (None, None)
    for r in sorted(rows, key=lambda r: -r['cloud_area']):
        o = r['opacity']
        if o not in LDN_AV or r['cloud_area'] <= 0:
            rng.random(5)
            continue
        l0, b0, A = r['lii'], r['bii'], r['cloud_area']
        req = np.sqrt(A / np.pi)
        u = rng.random(5)
        tau0 = LDN_AV[o] / 1.086
        # the opacity class was judged on arcsecond plates: a small cloud seen at our resolution is diluted
        tau0 *= min(1.0, (req / 0.3) ** 0.9)
        rmin = 0.05
        if req < rmin:  # below the grid: keep the cloud's integrated opacity (area x tau) on a minimum footprint
            tau0 *= (req / rmin) ** 2
            req = rmin
        # Dark clouds are filamentary and lie along the structure of the column they belong to: each cloud is laid
        # along the local iso-contour direction of the IRAS column, the more elongated the more coherent that
        # structure is (instead of a randomly oriented ellipse, which read as a field of round soot puffs)
        if th_f is not None:
            yi = min(th_f.shape[0] - 1, max(0, int((90 - b0) / (g.d * down))))
            xi = int((180 - (((l0 + 180) % 360) - 180)) / (g.d * down)) % th_f.shape[1]
            c = float(np.clip(coh_f[yi, xi], 0, 1))
            pa = float(th_f[yi, xi]) + (1 - c) * (u[1] - 0.5) * 1.6
            q = float(np.clip(0.62 - 0.5 * c + 0.3 * (u[0] - 0.5), 0.12, 0.85))
        else:
            q = 0.15 + 0.6 * u[0] ** 2
            pa = np.pi * u[1]
        a, bax = req / np.sqrt(q), req * np.sqrt(q)
        ext = 1.6 * a
        y0 = max(0, int((90 - b0 - ext) / g.d) - 1)
        y1 = min(g.H, int((90 - b0 + ext) / g.d) + 2)
        if y1 <= y0:
            continue
        rows_ = np.arange(y0, y1)
        B = g.B[rows_][:, None]
        cb = max(np.cos(np.radians(b0)), 0.05)
        dl = ((g.L[None, :] - l0 + 180) % 360) - 180
        cols = np.where(np.abs(dl[0]) < ext / cb + g.d)[0]
        if cols.size == 0:
            continue
        x = dl[:, cols] * np.cos(np.radians(B))
        y = (B - b0) * np.ones_like(x)
        xr = x * np.cos(pa) + y * np.sin(pa)
        yr = -x * np.sin(pa) + y * np.cos(pa)
        rho = np.sqrt((xr / a) ** 2 + (yr / bax) ** 2)
        # irregular outline and internal structure from a tileable noise field, streaked along the cloud's axis
        sc = 60.0 / max(req, 0.05)
        ox, oy = u[2] * 512, u[3] * 512
        n1 = _tile_sample(tile, xr * sc * 0.4 + ox, yr * sc + oy)
        n2 = _tile_sample(tile, xr * sc * 1.1 + oy, yr * sc * 2.7 + ox)
        rho2 = rho * np.exp(0.38 * n1 + 0.16 * n2)
        edge = np.clip((1.12 - rho2) / 0.28, 0, 1)
        edge = edge * edge * (3 - 2 * edge)
        prof = tau0 * edge * (0.7 + 0.3 * np.exp(-rho2 * rho2)) * np.exp(0.35 * n2 - 0.06)
        blk = acc[y0:y1][:, cols]
        acc[y0:y1, cols] = blk + prof ** P3
    out = acc ** (1 / P3)
    np.save(path, out.astype(np.float32))
    return out


def optical(S, AV, warm, g, down, AV_raw=None):
    """Layered extinction. Returns F (unextincted near stars), S_bg (background light before extinction),
    B_vis (background light after extinction, V), rho (reddening weight), tau_near.
    AV: column with the HII regions' own warm dust removed (builds the foreground screens); AV_raw: total column."""
    tau = 0.921 * AV
    tau_tot = 0.921 * (AV if AV_raw is None else AV_raw)
    B = g.B[:, None]
    L = ((g.L + 180) % 360 - 180)[None, :]
    lt = np.log(np.maximum(tau, 1e-3))
    lt = nd.gaussian_filter1d(lt, 5.0 / g.d, axis=1, mode='wrap')
    lt = nd.gaussian_filter1d(lt, 0.6 / g.d, axis=0, mode='nearest')
    tau_s = np.exp(lt)  # column smoothed along the plane (keeps the thin-disk latitude profile)
    tau_c = tau - tau_s
    Ltot = L_OUT + (L_IN - L_OUT) * 0.5 * (1 + np.cos(np.radians(L)))
    sinb = np.maximum(np.sin(np.radians(np.abs(B))), 1e-4)
    path = np.minimum(H_DUST / sinb, Ltot)
    phi = np.minimum(NEAR, path) / path  # fraction of the line of sight's dust within the near zone
    # the near zone holds a fraction phi of the SMOOTH column. Its small-scale structure (IRAS clumps) near the
    # plane is overwhelmingly distant (kpc) -- far behind the stars we see -- so close to the plane only the ~1 deg
    # smoothed column enters the near zone; away from the plane (|b| > ~5 deg, where the whole dust layer is local)
    # the full-resolution structure does
    lt1 = np.log(np.maximum(tau, 1e-3))
    lt1 = nd.gaussian_filter1d(nd.gaussian_filter1d(lt1, 1.0 / g.d, axis=1, mode='wrap'), 0.6 / g.d, axis=0, mode='nearest')
    tau_s1 = np.exp(lt1)
    ab = np.abs(B)
    floc = np.clip((ab - 1.5) / 4.5, 0, 1)
    floc = floc * floc * (3 - 2 * floc)
    # (in between, the structure is kept but compressed in log: distant clumps leave only a faint imprint)
    gam = 0.35 + 0.65 * floc
    pt = phi * tau_s1 * np.exp(gam * (np.log(np.maximum(tau, 1e-3)) - lt1))
    pt = -np.log(np.exp(-1.5 * pt) + np.exp(-1.5 * NEAR_CAP)) / 1.5
    # the smooth near-zone column is a model (the total column cannot say how much of it is near): break its
    # thin mid-plane lane into segments with windows, as the clumpy near disk does, instead of a uniform tube
    rng = np.random.default_rng(42)
    nz = nd.gaussian_filter(rng.standard_normal((g.H, g.W)), (1.2 / g.d, 2.4 / g.d), mode='wrap')
    nz /= nz.std()
    wpl = np.exp(-(B / 3.0) ** 2) * (0.35 + 0.65 * np.exp(-(L / 35.0) ** 2))  # strongest in the inner Galaxy
    pt = pt * np.exp((PT_SEG * nz - 0.5 * PT_SEG * PT_SEG) * wpl)
    exc = np.maximum(tau_c, 0)
    exc = -np.log(np.exp(-exc) + np.exp(-5.0))  # soft cap
    # foreground share of the small-scale excess outside the catalogued near clouds: tiny in the mid-plane (those
    # clumps are kpc away), rising to most of it a few degrees out of the plane
    bb = np.clip((ab - 0.4) / 3.6, 0, 1)
    wb = 0.08 + 0.92 * bb * bb * (3 - 2 * bb)
    cm = near_cloud_mask(g)
    # inside the near clouds, measure the excess against a morphological lower envelope (~8 deg)
    lt4 = np.log(np.maximum(tau[::down, ::down], 1e-3))
    env = nd.grey_opening(lt4, size=(17, 17), mode='nearest')
    env = nd.gaussian_filter(env, 3.0, mode='nearest')
    env = np.exp(np.repeat(np.repeat(env, down, 0), down, 1))[:g.H, :g.W]
    exc2 = np.maximum(tau - env, 0)
    exc2 = -np.log(np.exp(-exc2) + np.exp(-6.0))
    exc_c = exc * (1 - cm) + np.maximum(exc, exc2) * cm
    fm = far_complex_mask(g)
    x = pt + (CG + (0.9 - CG) * cm) * (1 - 0.8 * fm) * exc_c * (1 - phi) * np.maximum(wb, cm)
    tau_near = np.log1p(np.exp(np.clip(x, -50, 50)))
    tau_near = np.minimum(tau_near, tau) * (1 - WK * warm)
    # (a catalogued cloud's stamp does not cover a bright HII region: there its dust is behind or lit)
    tl = ldn_tau(g, tau) * float(os.environ.get('LDN_K', '1')) * (1 - 0.85 * hii_mask(g))
    tau_near = (tau_near ** 3 + tl ** 3) ** (1 / 3)
    tau = np.maximum(tau_tot, tau_near)
    cs = coalsack_screen(g) + pipe_screen(g)
    tau_near = tau_near + cs
    tau = tau + cs
    # mid-distance stars sit in front of a fraction FM of the remaining column -- of its SMOOTH part only: the
    # remaining small-scale structure belongs to clouds beyond them
    tau_mid = tau_near + FM * gsmooth(tau - tau_near, 1.2, g)
    # the bright star clouds are windows where the nearer dust thins out (M24, Scutum, Norma, the Sgr cloud):
    # documented optical features that the far-IR column (dominated by the dust far behind them) cannot show
    wm = window_mask(g)
    tau_near = tau_near * (1 - WIN_NEAR * wm)
    tau_mid = tau_near + (tau_mid - tau_near) * (1 - WIN_MID * wm)
    Sp = S ** P
    cap = (SN0 * np.exp(-np.abs(B) / BN) * (1 + CL * np.cos(np.radians(L)))) ** P
    S_near = np.minimum(Sp, cap)
    F = VNEAR * S_near
    S_near = S_near - F
    S_mid = np.minimum(Sp - S_near - F, cap * MID)
    S_far = Sp - S_near - F - S_mid
    w1 = S_near * np.exp(-tau_near)
    w2 = S_mid * np.exp(-tau_mid)
    w3 = S_far * np.exp(-tau)
    Bvis = w1 + w2 + w3
    Sbg = S_near + S_mid + S_far
    tau_r = (w1 * tau_near + w2 * tau_mid + w3 * tau) / np.maximum(Bvis, 1e-30)
    tau_eff = -np.log(np.maximum(Bvis, 1e-30) / np.maximum(Sbg, 1e-30))
    rho = np.clip(tau_r / np.maximum(tau_eff, 1e-6), 0, 1)
    return GAIN * F, GAIN * Sbg, GAIN * Bvis, rho, tau_eff, tau_near


# Bright star-cloud windows: (l, b, half-length deg along PA, half-width deg, PA from +l toward +b, strength)
STAR_CLOUDS = [
    (2.0, -5.2, 4.2, 2.6, -10, 0.55),    # Large Sagittarius Star Cloud (includes Baade's window at l=1, b=-3.9)
    (1.0, -3.9, 0.7, 0.5, 0, 0.5),       # Baade's window
    (12.0, -0.9, 0.95, 0.45, 5, 0.9),    # M24, Small Sagittarius Star Cloud
    (11.0, -1.6, 2.6, 1.3, 15, 0.35),    # ... and the thinner dust around it, toward the Large Sgr cloud
    (26.8, -2.6, 2.3, 1.5, 15, 0.8),     # Scutum Star Cloud
    (331.0, -2.0, 2.2, 1.1, 0, 0.7),     # Norma Star Cloud
    (72.5, 1.0, 5.0, 2.0, 10, 0.75),     # Cygnus Star Cloud (between gamma and beta Cyg)
    (345.0, -2.5, 2.5, 1.2, 0, 0.35),    # Ara / Scorpius tail star fields
    (5.6, -1.9, 2.0, 1.0, 20, 0.45),     # the rich field M8 / NGC 6530 sit on, at the NE edge of the Large Sgr cloud
]
WIN_NEAR, WIN_MID = 0.55, 0.85
PT_SEG = float(os.environ.get('PT_SEG', '0.3'))


def window_mask(g):
    m = np.zeros((g.H, g.W))
    rng = np.random.default_rng(24)
    tile = _noise_tile(512, 11)
    for l0, b0, a, c, pa, w in STAR_CLOUDS:
        ext = 1.6 * max(a, c)
        y0 = max(0, int((90 - b0 - ext) / g.d) - 1)
        y1 = min(g.H, int((90 - b0 + ext) / g.d) + 2)
        rows = np.arange(y0, y1)
        Bq = g.B[rows][:, None]
        x = (((g.L[None, :] - l0 + 180) % 360) - 180) * np.cos(np.radians(Bq))
        y = (Bq - b0) * np.ones_like(x)
        cols = np.where(np.abs(x[0]) < ext + 0.5)[0]
        x, y = x[:, cols], y[:, cols]
        t = np.radians(pa)
        xr, yr = x * np.cos(t) + y * np.sin(t), -x * np.sin(t) + y * np.cos(t)
        rr = np.sqrt((xr / a) ** 2 + (yr / c) ** 2)
        ox, oy = rng.random(2) * 512
        n = _tile_sample(tile, xr * 40 / max(c, 0.3) + ox, yr * 40 / max(c, 0.3) + oy)
        rr = rr * np.exp(0.3 * n)
        v = np.clip((1.3 - rr) / 0.8, 0, 1)
        blk = m[y0:y1][:, cols]
        m[y0:y1, cols] = np.maximum(blk, w * v * v * (3 - 2 * v))
    return m


LAT_K = 2.6
RES_R = float(os.environ.get("RES_R", "2.5"))
RES_G = float(os.environ.get("RES_G", "1.0"))
# (radMax 8: the inner Galaxy's background light reaches S_bg ~ 2.5 in the Sgr cloud and ~5.4 in Baade's window;
# a cap at 1.0 flattened the bulge into a straight band)
ENC = {'radMin': 2e-5, 'radMax': float(os.environ.get('RAD_MAX', '8.0')), 'tauMin': 0.003, 'tauMax': 30.0}


def to_tex(field, g, OW, OH, log=True):
    """Resample a grid field to the output projection: area average in longitude, row-span average in latitude."""
    a = np.log(np.maximum(field, 1e-30)) if log else field.astype(np.float64)
    if g.W % OW == 0:
        a2 = a.reshape(g.H, OW, -1).mean(2)
    else:
        a2 = np.array(Image.fromarray(a.astype(np.float32)).resize((OW, g.H), Image.BOX), np.float64)
    yv_edges = 1 - 2 * np.arange(OH + 1) / OH
    b_edges = 90 * np.sinh(LAT_K * yv_edges) / np.sinh(LAT_K)
    r_edges = (90 - b_edges) / g.d  # fractional source rows
    cs = np.concatenate([np.zeros((1, OW)), np.cumsum(a2, 0)], 0)

    def integ(r):  # integral of rows up to fractional row r
        r = np.clip(r, 0, g.H)
        i = np.floor(r).astype(int)
        f = (r - i)[:, None]
        i1 = np.minimum(i, g.H - 1)
        return cs[i] + f * a2[i1]

    lo, hi = r_edges[:-1], r_edges[1:]
    span = np.maximum(hi - lo, 1.0)  # at least one source row (bilinear-like when upsampling)
    mid = 0.5 * (lo + hi)
    lo2, hi2 = mid - 0.5 * span, mid + 0.5 * span
    return (integ(hi2) - integ(lo2)) / (hi2 - lo2)[:, None]


def encode(q, lo, hi, log=True):
    if log:
        lo, hi = np.log(lo), np.log(hi)
    v = (q - lo) / (hi - lo)
    return np.clip(np.round(v * 255), 0, 255).astype(np.uint8)


def aces(x):
    return np.clip((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0, 1)


def srgb(c):
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(np.maximum(c, 0), 1 / 2.4) - 0.055)


def main():
    p = build0()
    AV, AV_raw = av_hi(p)
    S1 = np.maximum(up2(p['S']), 0)
    warm1 = up2(p['warm'])
    F, Sbg, Bvis, rho, tau_eff, tau_near = optical(S1, AV, warm1, G1, 8, AV_raw)
    del AV, AV_raw
    for name, l0, b0 in [('gc', 0, 0), ('baade', 1, -3.9), ('sgr_cloud', 3, -6), ('scutum', 27, -3), ('rift', 35, 3), ('cyg', 75, 1),
                         ('coalsack', 303, 0), ('crux', 304, 3), ('carina', 287.5, -0.6), ('anti', 180, 0), ('taurus', 172, -15),
                         ('pole', 0, 89), ('b30', 90, 30), ('norma', 330, -1), ('perseus', 130, 0)]:
        y = int((90 - b0) / G1.d); x = int((180 - (((l0 + 180) % 360) - 180)) / G1.d) % G1.W
        print(f'{name:10s} F={F[y, x]:.4f} Sbg={Sbg[y, x]:.4f} vis={Bvis[y, x]:.4f} tau_eff={tau_eff[y, x]:6.2f} near={tau_near[y, x]:5.2f} rho={rho[y, x]:.2f}')
    # ---- low-res layers (1024 x 256): ln tau smooth, S_bg, rho   (F is analytic: min(k1 S_bg, k2 cap(l, b)))
    OW, OH = 1024, 256
    lt_full = np.log(np.clip(tau_eff, ENC['tauMin'], ENC['tauMax']))
    lsm = gsmooth(lt_full, 0.7, G1)
    lo = np.zeros((OH, OW, 3), np.uint8)
    lo[..., 0] = encode(to_tex(lsm, G1, OW, OH, log=False), ENC['tauMin'], ENC['tauMax'])
    lo[..., 1] = encode(to_tex(Sbg, G1, OW, OH), ENC['radMin'], ENC['radMax'])
    lo[..., 2] = encode(to_tex(rho, G1, OW, OH, log=False), 0.0, 1.0, log=False)
    dst = os.path.join(OUT, 'milkyway.webp')
    Image.fromarray(lo, 'RGB').save(dst, 'WEBP', quality=int(os.environ.get('MW_Q', '92')), method=6)
    print('wrote', dst, os.path.getsize(dst), 'bytes')
    # ---- high-res dust (4096 x 1024): ln tau_eff - (the decoded, GPU-interpolated smooth layer), +-RES_R e-folds
    DW, DH = int(os.environ.get('DUST_W', '4096')), int(os.environ.get('DUST_H', '1024'))
    tq = to_tex(np.clip(tau_eff, ENC['tauMin'], ENC['tauMax']), G1, DW, DH)
    lo_dec = np.array(Image.open(dst).convert('RGB'))[..., 0].astype(np.float64) / 255
    lo_dec = np.log(ENC['tauMin']) + (np.log(ENC['tauMax']) - np.log(ENC['tauMin'])) * lo_dec
    # bilinear sample of the low-res layer at the dust texel centres (wrap in u, clamp in v), as the GPU does
    yu = (np.arange(DH) + 0.5) / DH * OH - 0.5
    xu = (np.arange(DW) + 0.5) / DW * OW - 0.5
    y0 = np.clip(np.floor(yu).astype(int), 0, OH - 1); y1 = np.clip(y0 + 1, 0, OH - 1)
    ty = np.clip(yu - np.floor(yu), 0, 1)[:, None]
    x0 = np.floor(xu).astype(int); tx = (xu - x0)[None, :]
    r0 = lo_dec[y0] * (1 - ty) + lo_dec[y1] * ty
    lsm_hi = r0[:, x0 % OW] * (1 - tx) + r0[:, (x0 + 1) % OW] * tx
    resid = tq - lsm_hi
    # where the column is optically thin its log is mostly survey noise (and invisible): fade the residual there
    resid *= np.clip(np.exp(lsm_hi) / 0.12, 0.15, 1.0) ** 0.7
    print('residual e-folds: p0.01 %.2f p1 %.2f p50 %.2f p99 %.2f p99.99 %.2f' % tuple(np.percentile(resid, [0.01, 1, 50, 99, 99.99])))
    # companded: fine steps near zero (smooth regions, where block artefacts would show), coarse at the extremes
    rq = np.sign(resid) * (np.minimum(np.abs(resid) / RES_R, 1.0) ** RES_G)
    dimg = np.clip(np.round(128 + 127 * rq), 0, 255).astype(np.uint8)
    dst2 = os.path.join(OUT, 'dust.webp')
    Image.fromarray(dimg, 'L').save(dst2, 'WEBP', quality=int(os.environ.get('DUST_Q', '80')), method=6)
    print('wrote', dst2, os.path.getsize(dst2), 'bytes')
    meta = {
        'source': 'Optical reconstruction from COBE/DIRBE (1.25, 60, 100, 240 um ZSMA) and IRAS ISSA 100 um; NASA, public domain',
        'projection': 'galactic; u = 0.5 - l/360 (l = 0 at centre, increasing to the left); v = (1 - y)/2 with b = 90 sinh(latK y)/sinh(latK) (b = +90 at top)',
        'latK': LAT_K,
        'milkyway': 'R = smooth ln tau_eff (mix(ln tauMin, ln tauMax, value)); G = S_bg, background light before extinction (linear radiance exp(mix(ln radMin, ln radMax, value))); B = rho (reddening fraction, linear 0..1). The unextincted near-star light is analytic: F = min(fNear[0] S_bg, fNear[1] (cap0 exp(-|b|/capB) (1 + capL cos l))^P)',
        'dust': 'ln tau_eff = R(milkyway, bilinear) + resR sign(q) |q|^(1/resG), q = (value*255 - 128)/127: effective V optical depth of the background light, IRAS resolution',
        'resR': RES_R, 'resG': RES_G,
        'fNear': [VNEAR / (1 - VNEAR), VNEAR * GAIN], 'cap0': SN0, 'capB': BN, 'capL': CL, 'P': P,
        **ENC,
        'size': [OW, OH],
        'dustSize': [DW, DH],
        'model': {'VNEAR': VNEAR, 'J0': J0, 'P': P, 'GAIN': GAIN, 'SN0': SN0, 'BN': BN, 'CL': CL, 'MID': MID, 'CG': CG, 'FM': FM, 'WK': WK},
    }
    json.dump(meta, open(os.path.join(OUT, 'milkyway.json'), 'w'), indent=1)
    if PREVIEW:
        os.makedirs(PREVIEW, exist_ok=True)
        KC = np.array([0.84, 1.0, 1.24])
        g0 = G1
        Bc = g0.B[:, None]
        Lc = ((g0.L + 180) % 360 - 180)[None, :]
        bulge = np.exp(-(Lc / 12) ** 2 - (Bc / 8) ** 2)
        popc = np.stack([1 + 0.25 * bulge, 1 + 0.0 * bulge, 1 - 0.3 * bulge], -1) * np.array([0.95, 1.0, 1.06])
        img = np.zeros(F.shape + (3,))
        for c in range(3):
            img[..., c] = popc[..., c] * (F + Sbg * np.exp(-tau_eff) * np.exp(-(KC[c] - 1) * rho * tau_eff))
        Lum = np.maximum(img @ np.array([0.2126, 0.7152, 0.0722]), 1e-9)
        img = img * (Lum / 0.86)[..., None] ** (0.82 - 1)
        pv = (srgb(aces(img * 0.45)) * 255).astype(np.uint8)
        Image.fromarray(pv).resize((1440, 720), Image.LANCZOS).save(os.path.join(PREVIEW, 'mw_full.png'))

        def crop(name, l0, l1, b0, b1):
            x0 = int((180 - l1) / g0.d); x1 = int((180 - l0) / g0.d)
            y0 = int((90 - b1) / g0.d); y1 = int((90 - b0) / g0.d)
            Image.fromarray(pv[y0:y1, x0:x1]).save(os.path.join(PREVIEW, f'mw_{name}.png'))

        crop('gc', -30, 40, -20, 20)
        crop('gcz', -12, 12, -8, 12)
        crop('south', -80, -30, -15, 15)
        crop('cyg', 40, 100, -15, 15)
        crop('anti', 130, 179, -30, 20)


if __name__ == '__main__':
    main()
