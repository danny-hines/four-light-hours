"""Triton base maps for the neptune piece.

usage: python -I process_triton.py <raw_dir> <assets_dir>

Input : <raw_dir>/triton_usgs/Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif (USGS/LPI PIA18668,
        Voyager 2 ISS orange/violet/UV composite, equirectangular, -180..180 E, 0 at the centre).
Output: <assets_dir>/triton/color.webp  2048x1024, approximate TRUE colour (sRGB), no-data filled smoothly
        <assets_dir>/triton/mask.webp   512x256 lossless RGB: R = Voyager coverage (1 = real data),
                                         G = local sharpness of the source (how much real detail it holds),
                                         B = 0.

Colour: the mosaic shows orange / violet / UV as R / G / B, so it reads green-grey. We rebuild an
approximate visible-light colour: luminance comes from the orange + violet average; hue comes from the
UV-to-violet ratio (UV-dark material on Triton is the reddish/tan organics, UV-bright is the fresh
bluish-white N2 frost of the equatorial fringe) and the orange/violet slope. The target palette follows
published true-colour reconstructions: a pale peach/pinkish-tan south polar cap, bluish-white fringe,
grey-tan cantaloupe terrain, slightly darker brownish-grey plume streaks.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import box_reduce, load_array, np, push_pull_fill, resample_to, resize_float, save_webp, to_u8  # noqa: E402

raw, assets = sys.argv[1], sys.argv[2]
src = os.path.join(raw, "triton_usgs", "Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif")
a = load_array(src)
print("triton <-", os.path.basename(src), a.shape, a.dtype)


def valid(b):
    return np.repeat((b.max(axis=-1) >= 16)[..., None], b.shape[-1], axis=-1)


W, H = 2048, 1024
col = resample_to(a, (W, H), valid=valid).astype(np.float32)  # 0..255, orange/violet/UV

# coverage mask (fraction of valid source pixels), 512x256
m_full, _ = box_reduce((np.asarray(a[::2, ::2]).max(axis=-1) >= 16).astype(np.float32), 7)
cov = resize_float(m_full, (512, 256))
cov = np.clip(cov, 0, 1)


def blur(x, r):  # noqa: E302
    """Separable box blur (3 passes ~ gaussian), longitude wraps."""
    for _ in range(3):
        p = np.concatenate([x[:, -r:], x, x[:, :r]], axis=1)
        c = np.cumsum(p, axis=1)
        c = np.concatenate([np.zeros((x.shape[0], 1), np.float64), c], axis=1)
        x = (c[:, 2 * r + 1:] - c[:, :-2 * r - 1]) / (2 * r + 1)
        p = np.pad(x, ((r, r), (0, 0)), mode="edge")
        c = np.cumsum(p, axis=0)
        c = np.concatenate([np.zeros((1, x.shape[1]), np.float64), c], axis=0)
        x = (c[2 * r + 1:] - c[:-2 * r - 1]) / (2 * r + 1)
    return x


# ---- replace the push-pull fill (blocky at coarse levels) by a heavily smoothed version, blended by coverage
covF = np.clip(resize_float(cov, (W, H)), 0, 1)
smooth = np.stack([blur(col[..., c].astype(np.float64), 24) for c in range(3)], axis=-1)
smooth = np.stack([blur(smooth[..., c], 24) for c in range(3)], axis=-1).astype(np.float32)
wdat = np.clip((covF - 0.15) / 0.6, 0, 1)[..., None]
col = col * wdat + smooth * (1 - wdat)

# ---- approximate true colour -------------------------------------------------------------------
O, V, UVc = col[..., 0], col[..., 1], col[..., 2]
Y = 0.5 * (O + V)                       # visible luminance proxy
eps = 1.0
uvr = (V - UVc) / (Y + eps)             # high = UV-absorbing (reddish organics); low = fresh frost
slope = (O - V) / (Y + eps)             # orange vs violet slope
cm = resize_float(cov, (W, H)) > 0.5
uv0, uvs = np.median(uvr[cm]), np.std(uvr[cm])
sl0, sls = np.median(slope[cm]), np.std(slope[cm])
warm = np.clip(1.1 * (uvr - uv0) / (uvs + 1e-6) + 0.5 * (slope - sl0) / (sls + 1e-6), -2.5, 2.5)
warm = blur(warm.astype(np.float64), 2)  # chroma is noisier than luminance in the source
warm = np.clip(warm / 1.6, -1.0, 1.0).astype(np.float32)

# luminance: normalise so the bright cap sits near 0.88 (linear albedo is set in the shader)
yl = Y / np.percentile(Y[cm], 75) * 0.80
yl = np.clip(yl, 0.0, 1.15)
base = np.array([1.0, 0.925, 0.87], np.float32)        # pale peach (linear, relative)
warmc = np.array([1.07, 0.95, 0.80], np.float32)       # tan / pink organics
coolc = np.array([0.93, 0.985, 1.06], np.float32)      # bluish-white fresh N2 frost
w = warm[..., None]
tint = base * np.where(w > 0, 1 + w * (warmc - 1), 1 - w * (coolc - 1))
lin = yl[..., None] * tint / (0.2126 * tint[..., 0:1] + 0.7152 * tint[..., 1:2] + 0.0722 * tint[..., 2:3])
lin = lin * 0.72  # keep headroom: linear 0.72 -> sRGB ~0.86 for the bright cap
srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(np.maximum(lin, 0), 1 / 2.4) - 0.055)
save_webp(to_u8(srgb * 255.0), os.path.join(assets, "triton", "color.webp"), quality=90)

# ---- sharpness: local high-pass energy of the luminance, normalised ------------------------------
Yd = Y.astype(np.float64)
hp = np.abs(Yd - blur(Yd, 2))
en = blur(hp, 6)
en = en / np.percentile(en[cm], 97)
sharp = np.clip(en, 0, 1) * resize_float(cov, (W, H))
sharp = resize_float(sharp.astype(np.float32), (512, 256))
mask = np.stack([cov, np.clip(sharp, 0, 1), np.zeros_like(cov)], axis=-1)
save_webp(to_u8(mask * 255.0), os.path.join(assets, "triton", "mask.webp"), lossless=True)
print("coverage %.3f, mean sharpness %.3f" % (cov.mean(), sharp.mean()))
