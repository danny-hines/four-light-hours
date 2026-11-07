"""Shared helpers for the asset pipeline.

Scripts are run as `python -I script.py <paths>`. Isolated mode drops the user
site-packages (where PIL/numpy live on this machine), so each script adds that one
fixed path back explicitly via `bootstrap()`; nothing is loaded from the cwd or
from the raw download directories.
"""
import os
import struct
import sys


def bootstrap():
    import site
    p = site.getusersitepackages()
    if p not in sys.path:
        sys.path.append(p)


bootstrap()

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

Image.MAX_IMAGE_PIXELS = None

# --------------------------------------------------------------------------------------
# Minimal classic-TIFF reader that memory-maps uncompressed, contiguous strip data.
# --------------------------------------------------------------------------------------
_TYPES = {1: ("B", 1), 2: ("c", 1), 3: ("H", 2), 4: ("I", 4), 5: ("II", 8), 6: ("b", 1),
          7: ("B", 1), 8: ("h", 2), 9: ("i", 4), 10: ("ii", 8), 11: ("f", 4), 12: ("d", 8),
          16: ("Q", 8)}


def read_tiff_tags(path):
    with open(path, "rb") as f:
        hdr = f.read(8)
        bo = {b"II": "<", b"MM": ">"}[hdr[:2]]
        magic = struct.unpack(bo + "H", hdr[2:4])[0]
        if magic != 42:
            raise ValueError("BigTIFF/unknown TIFF magic %r" % magic)
        off = struct.unpack(bo + "I", hdr[4:8])[0]
        f.seek(off)
        n = struct.unpack(bo + "H", f.read(2))[0]
        tags = {}
        entries = f.read(12 * n)
        for i in range(n):
            tag, typ, cnt = struct.unpack(bo + "HHI", entries[12 * i: 12 * i + 8])
            raw = entries[12 * i + 8: 12 * i + 12]
            fmt, size = _TYPES.get(typ, ("B", 1))
            total = size * cnt
            if total <= 4:
                data = raw[:total]
            else:
                pos = struct.unpack(bo + "I", raw)[0]
                cur = f.tell()
                f.seek(pos)
                data = f.read(total)
                f.seek(cur)
            if typ == 2:
                val = data.rstrip(b"\0").decode("latin-1", "replace")
            elif typ in (5, 10):
                val = struct.unpack(bo + fmt[0] * (2 * cnt), data)
            else:
                val = struct.unpack(bo + fmt * cnt, data)
                if cnt == 1:
                    val = val[0]
            tags[tag] = val
        return bo, tags


def tiff_memmap(path):
    """Return a numpy memmap (H, W, C) or (H, W) for an uncompressed, contiguous TIFF."""
    bo, t = read_tiff_tags(path)
    W, H = t[256], t[257]
    bps = t.get(258, 1)
    bps = bps[0] if isinstance(bps, tuple) else bps
    spp = t.get(277, 1)
    comp = t.get(259, 1)
    planar = t.get(284, 1)
    fmt = t.get(339, 1)
    fmt = fmt[0] if isinstance(fmt, tuple) else fmt
    if comp != 1:
        raise ValueError("compressed TIFF (compression=%s)" % comp)
    if 322 in t:
        raise ValueError("tiled TIFF not supported by memmap path")
    offs = t[273] if isinstance(t[273], tuple) else (t[273],)
    cnts = t[279] if isinstance(t[279], tuple) else (t[279],)
    # verify contiguity
    for i in range(1, len(offs)):
        if offs[i] != offs[i - 1] + cnts[i - 1]:
            raise ValueError("non-contiguous strips")
    kind = {1: "u", 2: "i", 3: "f"}[fmt]
    dt = np.dtype(bo + kind + str(bps // 8))
    if planar == 2 and spp > 1:
        arr = np.memmap(path, dtype=dt, mode="r", offset=offs[0], shape=(spp, H, W))
        return np.moveaxis(arr, 0, -1), t
    shape = (H, W, spp) if spp > 1 else (H, W)
    arr = np.memmap(path, dtype=dt, mode="r", offset=offs[0], shape=shape)
    return arr, t


def load_array(path):
    """Memory-map an uncompressed TIFF if possible, else decode with PIL."""
    if path.lower().endswith((".tif", ".tiff")):
        try:
            return tiff_memmap(path)[0]
        except Exception as e:  # fall back to PIL
            print("  (memmap unavailable: %s; using PIL)" % e)
    im = Image.open(path)
    return np.asarray(im)


# --------------------------------------------------------------------------------------
# Resampling
# --------------------------------------------------------------------------------------
def box_reduce(arr, k, band_rows=None, valid=None):
    """Area-average an (H, W[, C]) array by integer factor k, streaming in row bands.

    The input is edge-padded up to a multiple of k. Returns float32 array of shape
    (ceil(H/k), ceil(W/k)[, C]) plus the exact fractional extent (W/k, H/k).
    If `valid` is a function(block)->bool mask, invalid samples are excluded from means.
    """
    H, W = arr.shape[:2]
    C = arr.shape[2] if arr.ndim == 3 else None
    Ho, Wo = -(-H // k), -(-W // k)
    out = np.zeros((Ho, Wo) + ((C,) if C else ()), np.float32)
    band = band_rows or max(1, (64 * 1024 * 1024) // max(1, W * (C or 1) * 8) // k) * k
    padw = Wo * k - W
    for y0 in range(0, H, band):
        y1 = min(H, y0 + band)
        blk = np.asarray(arr[y0:y1], dtype=np.float64)
        padh = (-(y1 - y0)) % k
        if padh or padw:
            pad = [(0, padh), (0, padw)] + ([(0, 0)] if C else [])
            blk = np.pad(blk, pad, mode="edge")
        hb = blk.shape[0] // k
        if valid is not None:
            m = valid(blk).astype(np.float64)
            blk = np.where(m > 0, blk, 0.0)
            s = blk.reshape(hb, k, Wo, k, *([C] if C else [])).sum(axis=(1, 3))
            c = m.reshape(hb, k, Wo, k, *([C] if C else [])).sum(axis=(1, 3))
            r = np.where(c > 0, s / np.maximum(c, 1), np.nan)
        else:
            r = blk.reshape(hb, k, Wo, k, *([C] if C else [])).mean(axis=(1, 3))
        out[y0 // k: y0 // k + hb] = r
    return out, (W / k, H / k)


def resample_to(arr, size, k=None, valid=None):
    """Downsample (H, W[, C]) to size=(w, h) with box prefilter + exact-extent Lanczos.

    Returns float32 array (h, w[, C]) in source units.
    """
    w, h = size
    H, W = arr.shape[:2]
    if k is None:
        k = max(1, int(min(W / w, H / h) / 1.5))  # leave >=1.5x headroom for Lanczos
    if k > 1:
        red, (ew, eh) = box_reduce(arr, k, valid=valid)
    else:
        red, (ew, eh) = np.asarray(arr, dtype=np.float32), (W, H)
    if valid is not None and np.isnan(red).any():
        red = push_pull_fill(red)
    return resize_float(red, (w, h), box=(0, 0, ew, eh))


def nonzero_pixels(blk):
    """Validity mask for 8-bit mosaics whose no-data value is 0 in every band."""
    if blk.ndim == 3:
        return np.repeat((blk.max(axis=-1) > 0)[..., None], blk.shape[-1], axis=-1)
    return blk > 0


def push_pull_fill(a):
    """Fill NaN holes of any size with a smooth multi-scale (push-pull) interpolation.

    Longitude wraps (np.roll-free: the coarse levels are built by 2x2 valid-weighted
    averaging, then upsampled and used only where the finer level has no data).
    """
    a = np.asarray(a, np.float32)
    m = ~np.isnan(a)
    if m.all():
        return a
    v = np.where(m, a, 0.0)
    levels = [(v, m.astype(np.float32))]
    while True:
        v, w = levels[-1]
        if (w > 0).all() or min(v.shape[:2]) <= 2:
            break
        H, W = v.shape[:2]
        H2, W2 = H + (H % 2), W + (W % 2)
        pad = [(0, H2 - H), (0, W2 - W)] + [(0, 0)] * (v.ndim - 2)
        vp, wp = np.pad(v * w, pad, mode="edge"), np.pad(w, pad, mode="edge")
        sh = (H2 // 2, 2, W2 // 2, 2) + v.shape[2:]
        sv, sw = vp.reshape(sh).sum(axis=(1, 3)), wp.reshape(sh).sum(axis=(1, 3))
        nv = np.where(sw > 0, sv / np.maximum(sw, 1e-9), 0.0)
        levels.append((nv.astype(np.float32), (sw > 0).astype(np.float32)))
    # pull: walk back up, filling empty pixels from the (bilinearly) upsampled coarser level
    fill = levels[-1][0]
    if not (levels[-1][1] > 0).all():  # degenerate: fill remaining with global mean
        fill = np.where(levels[-1][1] > 0, fill, np.nanmean(a))
    for v, w in reversed(levels[:-1]):
        H, W = v.shape[:2]
        up = resize_float(fill, (W, H), resample=Image.BILINEAR)
        fill = np.where(w > 0, v, up)
    return fill


def resize_float(a, size, box=None, resample=Image.LANCZOS):
    """Lanczos-resize a float array channel by channel through PIL mode 'F'."""
    if a.ndim == 2:
        return np.asarray(Image.fromarray(a.astype(np.float32), "F").resize(size, resample, box=box))
    chans = [np.asarray(Image.fromarray(np.ascontiguousarray(a[..., c]).astype(np.float32), "F")
                        .resize(size, resample, box=box)) for c in range(a.shape[2])]
    return np.stack(chans, axis=-1)


def fill_nan(a):
    """Fill NaNs by iterative neighbour averaging (small holes only)."""
    a = a.copy()
    for _ in range(200):
        m = np.isnan(a)
        if not m.any():
            break
        p = np.pad(a, [(1, 1), (1, 1)] + [(0, 0)] * (a.ndim - 2), mode="edge")
        nb = np.stack([p[:-2, 1:-1], p[2:, 1:-1], p[1:-1, :-2], p[1:-1, 2:]])
        cnt = (~np.isnan(nb)).sum(0)
        s = np.nansum(nb, 0)
        fillv = np.where(cnt > 0, s / np.maximum(cnt, 1), np.nan)
        a[m] = fillv[m]
    return np.nan_to_num(a)


def roll_half(a):
    """Shift an equirectangular map by 180 deg of longitude (0..360 -> -180..180)."""
    return np.roll(a, a.shape[1] // 2, axis=1)


def to_u8(a):
    return np.clip(np.rint(a), 0, 255).astype(np.uint8)


def save_webp(a, path, quality=88, lossless=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if a.ndim == 2:
        im = Image.fromarray(a, "L")
    else:
        im = Image.fromarray(a, "RGB")
    if lossless:
        im.save(path, "WEBP", lossless=True, quality=100, method=6)
    else:
        im.save(path, "WEBP", quality=quality, method=6)
    print("  wrote %s %dx%d %s %.0f KB" % (path, im.width, im.height, im.mode, os.path.getsize(path) / 1024))
    return path
