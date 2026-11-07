"""Mercury assets for the `mercury` piece.

usage: python -I mercury_assets.py <raw_dir> <assets_dir> [work_dir]

Inputs (already downloaded, see SOURCES.md "Mercury"):
  raw/mercury_usgs/Mercury_MESSENGER_MDIS_Basemap_MD3Color_Mosaic_Global_665m.tif  (1000/750/430 nm as R/G/B)
  raw/mercury_dem_usgs/Mercury_Messenger_USGS_DEM_Global_665m_v2.tif               (int16 m, 0..360 E)

Outputs (equirectangular, lon 0 at the centre, east to the right, north up):
  assets/mercury/albedo.webp  gray, sRGB-encoded relative normal albedo (1.0 = 0.5 of the 0..255 range... see below)
  assets/mercury/tint.webp    small RGB natural-colour tint (sRGB), multiplies the albedo
  assets/mercury/height.webp  gray, DEM normalised to 0..255 with the range written to assets/height_ranges.json

A float working copy of both rasters (4096x2048) is cached in work_dir (default: alongside the raw data) so
re-encoding experiments are quick.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Image, load_array, nonzero_pixels, np, resample_to, roll_half, save_webp, to_u8  # noqa: E402

raw, assets = sys.argv[1], sys.argv[2]
work = sys.argv[3] if len(sys.argv) > 3 else os.path.join(raw, "mercury_work")
os.makedirs(work, exist_ok=True)
WORK = (4096, 2048)


def cached(name, fn):
    p = os.path.join(work, name + ".npy")
    if os.path.exists(p):
        return np.load(p)
    a = fn()
    np.save(p, a.astype(np.float32))
    return a


col = cached("color4k", lambda: resample_to(
    load_array(os.path.join(raw, "mercury_usgs", "Mercury_MESSENGER_MDIS_Basemap_MD3Color_Mosaic_Global_665m.tif")),
    WORK, valid=nonzero_pixels))
dem = cached("dem4k", lambda: roll_half(resample_to(
    load_array(os.path.join(raw, "mercury_dem_usgs", "Mercury_Messenger_USGS_DEM_Global_665m_v2.tif")),
    WORK, valid=lambda b: b > -30000)) * 0.001)
print("color", col.shape, col.dtype, "dem", dem.shape, float(dem.min()), float(dem.max()))

H4, W4 = col.shape[:2]
lat4 = 90 - (np.arange(H4) + 0.5) * 180 / H4


def blur(a, sigma):
    """Separable gaussian blur; longitude wraps, latitude clamps."""
    r = int(3 * sigma + 1)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    out = np.zeros_like(a)
    for i, w in enumerate(k):
        out += w * np.roll(a, i - r, axis=1)
    p = np.pad(out, [(r, r), (0, 0)] + [(0, 0)] * (a.ndim - 2), mode="edge")
    out2 = np.zeros_like(a)
    for i, w in enumerate(k):
        out2 += w * p[i: i + a.shape[0]]
    return out2


def polar_iso(a, w_out):
    """Make the filter footprint isotropic near the poles. An equirectangular row at latitude phi is 1/cos(phi)
    times denser in longitude than in latitude, so plain resampling leaves radially elongated texels that render as
    a starburst converging on each pole. Each row gets an extra (periodic, FFT) gaussian blur along longitude of
    sigma = 0.6 output pixels * sqrt(1/cos^2 - 1), which is 0 at the equator and becomes the row mean at the pole."""
    H, W = a.shape[:2]
    lat = np.radians(90 - (np.arange(H) + 0.5) * 180 / H)
    sig = 0.6 * (W / w_out) * np.sqrt(np.maximum(1 / np.cos(lat) ** 2 - 1, 0))
    f = np.fft.rfftfreq(W)
    out = np.array(a, dtype=np.float64, copy=True)
    for i in np.where(sig > 0.05)[0]:
        g = np.exp(-2 * (np.pi * sig[i] * f) ** 2)
        F = np.fft.rfft(out[i], axis=0)
        out[i] = np.fft.irfft(F * (g[:, None] if out.ndim == 3 else g), n=W, axis=0)
    return out.astype(np.float32)


def down(a, size):
    from common import resize_float
    return resize_float(a, size)


# ------------------------------------------------------------------ albedo (relative normal albedo)
# MD3 bands are R=1000, G=750, B=430 nm, each independently contrast-stretched (their percentiles match), so
# absolute colour is gone and the DN contrast is exaggerated. Visible-band brightness ~ 0.75*G + 0.25*B. The
# stretch is undone with an offset chosen so that the darkest low-reflectance material sits at ~0.65 of the
# median and the brightest fresh ray material at ~1.8 (Mercury's real normal-albedo range).
# (round 2: offset 80 -> 55: the full disc was too flat next to MESSENGER; LRM now ~0.55 and the brightest rays
# ~2.2 of the median)
OFFSET = 80.0       # spectral-slope tint (below) keeps the original de-stretch
OFFSET_ALB = 55.0   # albedo and detail tile
Lm = 0.75 * col[..., 1] + 0.25 * col[..., 2]
mid = np.abs(lat4) < 60
med = float(np.median(Lm[mid]))
rel = (Lm + OFFSET_ALB) / (med + OFFSET_ALB)
# Polar caps of the mosaic are dominated by baked grazing-incidence shading (black shadows, bright rims) and junk
# rows at |lat| > 87. The renderer computes that shading itself, so poleward of ~65 deg the map fades to a robust
# low-pass (outliers clipped, then blurred) that keeps only the broad albedo pattern.
clipped = np.clip(rel, 0.85, 1.2)
smooth = blur(clipped, 10.0)
w = np.clip((np.abs(lat4) - 64.0) / (80.0 - 64.0), 0, 1)[:, None]
w = w * w * (3 - 2 * w)
rel = rel * (1 - w) + smooth * w
A_LO, A_HI = 0.40, 2.60
# mild unsharp mask at the 4096 working scale (crater halos, ray filaments), then the 2048 export
rel = rel + 0.6 * (rel - blur(rel, 1.6))
rel = polar_iso(rel, 2048)
alb = down(rel, (2048, 1024))
print("albedo rel: p1 %.3f p50 %.3f p99 %.3f max %.3f" % tuple(np.percentile(alb, [1, 50, 99, 100])))
save_webp(to_u8((alb - A_LO) / (A_HI - A_LO) * 255), os.path.join(assets, "mercury", "albedo.webp"), quality=82)

# ------------------------------------------------------------------ natural-colour tint
# Spectral-slope index from the 1000/430 nm ratio, relative to the global median. In natural colour the
# differences are faint: low-reflectance material and fresh (immature) ejecta are slightly bluer/greyer, the
# red pyroclastic faculae and high-reflectance plains slightly warmer. Keep ~22% of the slope signal.
eps = 1.0
slope = np.log((col[..., 0] + OFFSET) / (col[..., 2] + OFFSET))
slope -= float(np.median(slope[mid]))
# (round 2: the tint is a low-frequency signal; blur ~2.5 texels of the 1024 map before encoding, store it
# lossless at 512x256, and keep only ~60 % of the earlier strength: the enhanced-colour LRM blue read too strongly)
slope = blur(slope, 10.0)
slope = slope * (1 - w)
slope_s = down(polar_iso(slope, 512), (512, 256))
print("slope p1 %.3f p50 %.3f p99 %.3f" % tuple(np.percentile(slope_s, [1, 50, 99])))
k = 0.55
tint = np.stack([np.exp(+0.5 * k * slope_s), np.ones_like(slope_s), np.exp(-0.5 * k * slope_s)], -1)
tint /= (0.2126 * tint[..., 0:1] + 0.7152 * tint[..., 1:2] + 0.0722 * tint[..., 2:3])
# store with neutral = 0.5 (linear) so it can go both ways; decode in shader: t = 2 * texel
srgb = lambda v: np.where(v <= 0.0031308, 12.92 * v, 1.055 * np.power(np.clip(v, 0, None), 1 / 2.4) - 0.055)
# crater-density proxy (alpha): DEM roughness at 10-60 km scales, smoothed to ~200 km. Smooth volcanic plains
# (northern plains, Caloris interior) are young and much less cratered than the intercrater plains/heavily
# cratered terrain, so the procedural crater field thins out there.
d1k = down(polar_iso(dem, 1024), (1024, 512))
hp = d1k - blur(d1k, 2.5)
rough = blur(np.abs(hp), 7.0)
lat1 = 90 - (np.arange(512) + 0.5) * 180 / 512
mid1 = np.abs(lat1) < 60
dens = np.clip(rough / np.percentile(rough[mid1], 70), 0.3, 1.0)
wp = np.clip((np.abs(lat1) - 70.0) / 15.0, 0, 1)[:, None]
dens = dens * (1 - wp) + 0.85 * wp  # polar DEM roughness is unreliable (south pole stereo gaps)
print("density p5 %.2f p50 %.2f p95 %.2f" % tuple(np.percentile(dens, [5, 50, 95])))
save_webp(to_u8(srgb(np.clip(tint * 0.5, 0, 1)) * 255), os.path.join(assets, "mercury", "tint.webp"), lossless=True)
save_webp(to_u8(down(dens, (512, 256)) * 255), os.path.join(assets, "mercury", "density.webp"), quality=90)
Image.fromarray(to_u8(dens * 255)).save(os.path.join(work, "density_preview.png"))

# ------------------------------------------------------------------ DEM
H_RES = (1664, 832)
# mild unsharp mask: the stereo DEM rounds off crater rims; restoring some crest sharpness gives crisper cast shadows
dem_s = dem + 0.45 * (dem - blur(dem, 1.4))
d = down(polar_iso(dem_s, H_RES[0]), H_RES).astype(np.float64)


def bspline_prefilter(a, axis, wrap):
    """Inverse of the cubic B-spline sampling kernel [1, 4, 1] / 6 (Unser 1999), so that evaluating a cubic
    B-spline on the stored coefficients reproduces the DEM samples exactly (sharp yet C2-smooth normals).
    Longitude wraps; latitude uses mirror boundaries."""
    n = a.shape[axis]
    if not wrap:
        a = np.concatenate([a, np.flip(a, axis=axis)], axis=axis)
    m = a.shape[axis]
    H = (4 + 2 * np.cos(2 * np.pi * np.fft.fftfreq(m))) / 6
    shape = [1] * a.ndim
    shape[axis] = m
    out = np.real(np.fft.ifft(np.fft.fft(a, axis=axis) / H.reshape(shape), axis=axis))
    return np.take(out, np.arange(n), axis=axis) if not wrap else out


d = bspline_prefilter(bspline_prefilter(d, 1, True), 0, False)
lo, hi = float(d.min()), float(d.max())
save_webp(to_u8((d - lo) / (hi - lo) * 255), os.path.join(assets, "mercury", "dem.webp"), lossless=True)
meta = {
    "albedo": {"file": "albedo.webp", "encoding": "rel = lo + v/255*(hi-lo); relative normal albedo, median 1",
               "lo": A_LO, "hi": A_HI},
    "tint": {"file": "tint.webp", "encoding": "sRGB: linear rgb = 2*texel, luminance-normalised natural-colour tint"},
    "density": {"file": "density.webp", "encoding": "linear gray: procedural crater-density factor 0.3..1"},
    "dem": {"file": "dem.webp", "encoding": "cubic B-spline coefficients: height_km = min_km + v/255*(max_km-min_km), sphere 2439.4 km",
            "min_km": round(lo, 4), "max_km": round(hi, 4), "size": list(H_RES)},
}
# ------------------------------------------------------------------ detail tile
# A tileable high-pass of the full-resolution (665 m/px) mosaic over generic intercrater plains / heavily cratered
# terrain (centred 50 W, 0 N; 1024 px = 681 km), resampled to 512 px (1.33 km/px). The shader lays it on the sphere
# (triplanar) only where the 7.5 km/px albedo is magnified, filling the 1.3-8 km band with real Mercury texture.
from common import resize_float  # noqa: E402
raw_c = load_array(os.path.join(raw, "mercury_usgs", "Mercury_MESSENGER_MDIS_Basemap_MD3Color_Mosaic_Global_665m.tif"))
Hc, Wc = raw_c.shape[:2]
cx_, cy_ = int((-50 + 180) / 360 * Wc), int(90 / 180 * Hc)
t = np.asarray(raw_c[cy_ - 512: cy_ + 512, cx_ - 512: cx_ + 512]).astype(np.float64)
Lt = 0.75 * t[..., 1] + 0.25 * t[..., 2] + OFFSET_ALB


def gblur_periodic(a, sig):
    fy = np.fft.fftfreq(a.shape[0])[:, None]
    fx = np.fft.fftfreq(a.shape[1])[None, :]
    return np.real(np.fft.ifft2(np.fft.fft2(a) * np.exp(-2 * (np.pi * sig) ** 2 * (fx * fx + fy * fy))))


def periodic_component(u):
    """Moisan (2011) periodic + smooth decomposition: returns the periodic part (tiles without seams)."""
    v = np.zeros_like(u)
    v[0, :] += u[-1, :] - u[0, :]
    v[-1, :] += u[0, :] - u[-1, :]
    v[:, 0] += u[:, -1] - u[:, 0]
    v[:, -1] += u[:, 0] - u[:, -1]
    M, N = u.shape
    q = np.arange(M)[:, None]
    r = np.arange(N)[None, :]
    den = 2 * np.cos(2 * np.pi * q / M) + 2 * np.cos(2 * np.pi * r / N) - 4
    den[0, 0] = 1
    S = np.fft.fft2(v) / den
    S[0, 0] = 0
    return u - np.real(np.fft.ifft2(S))


Lp = periodic_component(np.log(Lt))
hp = Lp - np.log(np.exp(1.0) * 0 + np.exp(gblur_periodic(Lp, 10.0)))  # log-ratio to a ~6.7 km gaussian
hp = resize_float(hp.astype(np.float32), (512, 512))
hp = np.tanh(hp / 0.45) * 0.45  # compress rare bright fresh-crater spots (they would repeat conspicuously)
print("detail log-ratio: std %.3f p1 %.3f p99 %.3f" % (hp.std(), np.percentile(hp, 1), np.percentile(hp, 99)))
DET = 0.45
save_webp(to_u8(127.5 + hp / DET * 127.5), os.path.join(assets, "mercury", "detail.webp"), quality=82)
meta["detail"] = {"file": "detail.webp", "encoding": "log(albedo ratio) = (v/255 - 0.5) * 2 * range", "range": DET,
                  "tile_km": 681.0, "source": "MD3 mosaic 665 m/px, 1024 px centred 50 W 0 N, periodic + high-pass"}

json.dump(meta, open(os.path.join(assets, "mercury", "meta.json"), "w"), indent=2)
print("dem range %.3f .. %.3f km" % (lo, hi))
print(json.dumps(meta))
