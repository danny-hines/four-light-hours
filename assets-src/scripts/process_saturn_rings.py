"""Saturn ring optical-depth profile -> assets/saturn/rings_tau.bin

Input : Voyager 2 PPS delta Sco occultation, 1 km resampled profiles (PDS VG_2801 EASYDATA/KM001/PS1P01*.TAB),
        downloaded unmodified to assets-src/raw/saturn_rings_pps/.
Output: assets/saturn/rings_tau.bin  -- little-endian uint16 normal optical depth * 10000, one sample per km,
        radius R0..R1 km (inclusive), preceded by a 16-byte header:
            char[4] 'SRTP', uint32 count, float32 r0_km, float32 dr_km
        plus an overview plot (optional, --plot <png>).

Processing (documented in assets-src/SOURCES.md, Saturn section):
  * opaque samples (opacity 99) -> TAU_OPAQUE; unconstrained samples (signal 0, sigma 99) -> linear fill
  * noise: PPS photon noise is ~0.02-0.05 in tau at 1 km. A noise-adaptive smoother (uncertainty-weighted,
    3..9 km) is applied only where the signal is low-contrast, so real edges and ringlets survive.
  * negative tau (noise in gaps) -> 0
  * B ring: smooth optical-depth floors from Cassini occultations where the PPS saturates (B2 1.9, B3 4.2, B4 2.2)
  * regions the occultation did not constrain well are replaced with models: the D ring (< 74,400 km,
    tau ~ 1e-3 dusty), the Roche division (> 136,800 km, tau ~ 1e-4) and the F ring (removed; it is eccentric
    and modelled analytically in the shader).

Run:  python -I process_saturn_rings.py ../raw/saturn_rings_pps ../../assets/saturn [--plot ../../shots/saturn/profile.png]
"""
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import bootstrap  # noqa: F401,E402  (adds user site-packages for numpy/PIL)

import numpy as np
from PIL import Image, ImageDraw

R0, R1 = 66000, 142000
TAU_OPAQUE = 5.0


def load(raw):
    rows = []
    for n in range(7, 15):
        p = os.path.join(raw, f"PS1P01{n:02d}.TAB")
        with open(p, "r") as f:
            for line in f:
                v = [float(x) for x in line.split(",")]
                rows.append(v)
    a = np.array(rows)
    a = a[np.argsort(a[:, 0])]
    _, idx = np.unique(a[:, 0], return_index=True)
    return a[idx]


def main():
    raw, out = sys.argv[1], sys.argv[2]
    plot = None
    if "--plot" in sys.argv:
        plot = sys.argv[sys.argv.index("--plot") + 1]
    a = load(raw)
    r = a[:, 0]
    sig = a[:, 1]
    tau = a[:, 3].copy()
    lo = a[:, 4]
    hi = a[:, 5]
    print("PPS samples", len(r), "radius", r[0], r[-1])

    opaque = tau >= 98
    unc = (sig == 0) | (a[:, 2] >= 98)
    print("opaque", opaque.sum(), "unconstrained", unc.sum())
    tau[opaque] = TAU_OPAQUE
    # 1-sigma half-width as the noise estimate (opaque: large)
    err = np.where(opaque, 2.0, np.clip((hi - lo) * 0.5, 1e-3, 5.0))
    err[hi >= 98] = 2.0
    good = ~unc
    tau[unc] = np.interp(r[unc], r[good], tau[good])

    # noise-adaptive smoothing: weight neighbours by 1/err^2, kernel width grows where err/tau is large
    n = len(tau)
    sm = tau.copy()
    w = 1.0 / np.maximum(err, 1e-3) ** 2
    for half in (1, 2, 4):
        k = np.ones(2 * half + 1)
        num = np.convolve(tau * w, k, mode="same")
        den = np.convolve(w, k, mode="same")
        cand = num / den
        # apply where the local signal is weak relative to noise (gaps, C ring background)
        snr = np.abs(tau) / np.maximum(err, 1e-3)
        use = snr < (2.0 + half)
        sm = np.where(use & ~opaque, cand, sm)
    tau = np.clip(sm, 0.0, TAU_OPAQUE)

    # resample onto the output grid
    grid = np.arange(R0, R1 + 1, 1.0)
    out_tau = np.interp(grid, r, tau, left=0.0, right=0.0)

    # --- B ring: the PPS saturates near tau ~ 3 (values there are lower limits, and 1 km noise dips are not gaps).
    # Cassini UVIS/RSS occultations (Colwell et al. 2007, 2009) give B2 ~ 2-3, the B3 core > 5, B4 ~ 2-4. Apply
    # smooth floors, keeping the PPS structure above them.
    def ramp(a, b, x):
        t = np.clip((x - a) / (b - a), 0, 1)
        return t * t * (3 - 2 * t)
    floor = (1.9 * ramp(98800, 99600, grid) * (1 - ramp(103600, 104400, grid))
             + 4.2 * ramp(103600, 104400, grid) * (1 - ramp(110000, 110800, grid))
             + 2.2 * ramp(110000, 110800, grid) * (1 - ramp(117000, 117350, grid)))
    # the PPS fine structure (relative to a 31 km running mean) modulates the floor, so B-ring banding survives
    sm = np.convolve(out_tau, np.ones(31) / 31.0, mode="same")
    detail = np.tanh((out_tau - sm) / np.maximum(sm, 0.5) * 1.5)
    sm300 = np.convolve(out_tau, np.ones(301) / 301.0, mode="same")
    broad = np.tanh((sm - sm300) / np.maximum(sm300, 0.5) * 2.0)
    out_tau = np.maximum(out_tau, floor * (1.0 + 0.22 * detail + 0.18 * broad))

    # --- models replacing poorly constrained regions -----------------------------------------
    rng = np.random.default_rng(1981)
    # D ring: dusty, tau ~ 1e-3 with the D68/D72/D73 ringlets (Hedman et al. 2007)
    d = grid < 74400
    base = 1.2e-3 * np.clip((grid - 66900) / 2000, 0, 1) * (1 - 0.3 * np.cos((grid - 66900) / 900))
    for rc, wd, amp in ((67630, 40, 6e-3), (71710, 150, 8e-3), (73200, 120, 4e-3)):
        base += amp * np.exp(-0.5 * ((grid - rc) / wd) ** 2)
    out_tau[d] = np.maximum(base[d], 0) * (grid[d] >= 66900)
    # Roche division beyond the A ring edge: very faint dust; remove the F ring (modelled in the shader)
    roche = grid > 136790
    out_tau[roche] = 1.5e-4 * np.exp(-((grid[roche] - 136790) / 1500))
    out_tau = np.clip(out_tau, 0, 6.5)

    os.makedirs(out, exist_ok=True)
    q = np.round(out_tau * 10000).astype("<u2")
    path = os.path.join(out, "rings_tau.bin")
    with open(path, "wb") as f:
        f.write(b"SRTP")
        f.write(struct.pack("<Iff", len(q), float(R0), 1.0))
        f.write(q.tobytes())
    print("wrote", path, os.path.getsize(path), "bytes", "samples", len(q))

    # sanity: named features
    for name, rr in (("C/B edge", 92000), ("B outer", 117580), ("Huygens gap", 117800), ("Cassini div", 119000),
                     ("A inner", 122170), ("Encke", 133589), ("Keeler", 136505), ("A outer", 136775),
                     ("Colombo", 77870), ("Maxwell", 87510), ("Titan ringlet", 77880)):
        i = int(rr - R0)
        print(f"  {name:14s} r={rr} tau={out_tau[i]:.3f}  (+-20 km min {out_tau[i-20:i+20].min():.3f} max {out_tau[i-20:i+20].max():.3f})")

    if plot:
        W, H = 3000, 900
        img = Image.new("RGB", (W, H), (10, 10, 14))
        dr = ImageDraw.Draw(img)
        for xk in range(66000, 142001, 2000):
            x = int((xk - R0) / (R1 - R0) * (W - 1))
            dr.line([(x, 0), (x, H)], fill=(40, 40, 50) if xk % 10000 else (80, 80, 100))
            if xk % 10000 == 0:
                dr.text((x + 3, 3), f"{xk // 1000}k", fill=(160, 160, 180))
        # two panels: sqrt tau and 1-exp(-tau)
        for x in range(W):
            i0 = int(x / W * len(out_tau))
            i1 = max(i0 + 1, int((x + 1) / W * len(out_tau)))
            seg = out_tau[i0:i1]
            for val, col, y0, sc in ((np.sqrt(seg / 5.0), (230, 200, 140), 440, 420), (1 - np.exp(-seg), (140, 190, 240), 890, 420)):
                ya = int(y0 - val.max() * sc)
                yb = int(y0 - val.min() * sc)
                dr.line([(x, ya), (x, yb)], fill=col)
        os.makedirs(os.path.dirname(plot), exist_ok=True)
        img.save(plot)
        print("plot", plot)


if __name__ == "__main__":
    main()
