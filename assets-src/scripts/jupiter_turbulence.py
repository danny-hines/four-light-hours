"""Jupiter piece: a tileable 2-D turbulence tracer for the close-range cloud deck.

Pseudo-spectral simulation of forced 2-D incompressible Navier-Stokes on a doubly periodic square
(vorticity form), with two passive tracers held against mean gradients (the classic Batchelor-regime setup
that produces sharp fronts, filaments and vortex roll-ups everywhere). Nothing is downloaded: the output is
pure physics + a fixed random seed, so it is deterministic and public domain.

    w_t + J(psi, w) = F - nu (-lap)^8 w - mu_low(k) w          (w = -lap psi, u = psi_y, v = -psi_x)
    c_t + J(psi, c) + G . (u, v) = - kappa (-lap)^8 c

  c1 holds a mean gradient along y, c2 along x (two statistically independent but co-located tracers).
  Forcing: white-in-time, isotropic band around k_f. Hypo-drag at k < 4 arrests the inverse cascade so the tile
  has no domain-scale condensate (the global map supplies the large scales on Jupiter).

Spin-up at N/2 to statistical equilibrium, then spectral refinement to N for the fine filaments.
Outputs (assets/jupiter/):
  turb_c1.webp  tracer 1, high-passed (k >= 3), normalised to [-1, 1] -> 8 bit (lossy WebP, grayscale)
  turb_c2.webp  tracer 2, same
  turb_u.webp, turb_v.webp  velocity at N/4 resolution (lossless), scaled by 1/uv_scale (turb_meta.json)
Run:  python -I jupiter_turbulence.py <out_dir> [N] [spin-up time]   (env JT_TFINE, JT_KF, JT_AMP, JT_MU)
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402,F401  (adds the user site-packages back in isolated mode)
import numpy as np  # noqa: E402
import scipy.fft as F  # noqa: E402
from PIL import Image  # noqa: E402

out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
N_FINAL = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
T_SPIN = float(sys.argv[3]) if len(sys.argv) > 3 else 12.0     # spin-up time at N_FINAL / 2
T_FINE = float(os.environ.get("JT_TFINE", "1.2"))               # refinement time at N_FINAL
KF = float(os.environ.get("JT_KF", "14"))
AMP = float(os.environ.get("JT_AMP", "0.26"))
MU = float(os.environ.get("JT_MU", "0.15"))
UMAX = 3.0
rng = np.random.default_rng(20261102)


class Grid:
    def __init__(self, N):
        self.N = N
        kx = F.rfftfreq(N, 1.0 / N)
        ky = F.fftfreq(N, 1.0 / N)
        self.KX, self.KY = np.meshgrid(kx, ky)
        K2 = self.KX ** 2 + self.KY ** 2
        self.K = np.sqrt(K2)
        self.K2i = np.where(K2 > 0, 1.0 / np.maximum(K2, 1e-12), 0.0)
        kmax = N / 3.0
        self.dealias = (np.abs(self.KX) < kmax) & (np.abs(self.KY) < kmax)
        self.iKX = 1j * self.KX
        self.iKY = 1j * self.KY
        self.dt = 1.2 * (2 * np.pi / N) / UMAX
        D_hyper = (6.0 / self.dt) * (self.K / kmax) ** 16      # hyperviscosity (exact integrating factor)
        D_low = 0.32 * np.where(self.K > 0, (np.minimum(self.K, 4.0) / 4.0) ** -4 - 1.0, 0.0) + MU
        D_low[0, 0] = 0.0
        self.E_w = np.exp(-(D_hyper + D_low) * self.dt)
        self.E_c = np.exp(-D_hyper * self.dt)
        self.band = (np.abs(self.K - KF) < 1.5) & (self.K > 0)
        self.nb = int(self.band.sum())
        self.famp = AMP * N * N / np.sqrt(self.nb) * KF

    def irf(self, a):
        return F.irfft2(a, s=(self.N, self.N), workers=-1)

    def rf(self, a):
        return F.rfft2(a, workers=-1)

    def rhs(self, wh, c1h, c2h):
        ph = wh * self.K2i
        irf = self.irf
        u = irf(self.iKY * ph)
        v = irf(-self.iKX * ph)
        wx = irf(self.iKX * wh); wy = irf(self.iKY * wh)
        ax = irf(self.iKX * c1h); ay = irf(self.iKY * c1h)
        bx = irf(self.iKX * c2h); by = irf(self.iKY * c2h)
        nw = self.rf(u * wx + v * wy)
        n1 = self.rf(u * ax + v * ay + v)        # mean gradient (0, 1)
        n2 = self.rf(u * bx + v * by + u)        # mean gradient (1, 0)
        d = self.dealias
        return -nw * d, -n1 * d, -n2 * d, u, v

    def run(self, state, T, label):
        wh, c1h, c2h = state
        dt = self.dt
        steps = int(np.ceil(T / dt))
        t0 = time.time()
        for step in range(steps):
            # SSP-RK3 for advection, integrating factor for dissipation, white-in-time forcing
            a1, b1, d1, u, v = self.rhs(wh, c1h, c2h)
            w1 = wh + dt * a1; p1 = c1h + dt * b1; q1 = c2h + dt * d1
            a2, b2, d2, _, _ = self.rhs(w1, p1, q1)
            w2 = 0.75 * wh + 0.25 * (w1 + dt * a2); p2 = 0.75 * c1h + 0.25 * (p1 + dt * b2); q2 = 0.75 * c2h + 0.25 * (q1 + dt * d2)
            a3, b3, d3, _, _ = self.rhs(w2, p2, q2)
            wh = (wh / 3.0 + 2.0 / 3.0 * (w2 + dt * a3)) * self.E_w
            c1h = (c1h / 3.0 + 2.0 / 3.0 * (p2 + dt * b3)) * self.E_c
            c2h = (c2h / 3.0 + 2.0 / 3.0 * (q2 + dt * d3)) * self.E_c
            fr = np.zeros_like(wh)
            fr[self.band] = (rng.standard_normal(self.nb) + 1j * rng.standard_normal(self.nb)) * self.famp * np.sqrt(dt)
            wh = wh + fr
            if step % 200 == 0 or step == steps - 1:
                um = float(np.sqrt(np.mean(u * u + v * v)))
                mx = float(np.max(np.sqrt(u * u + v * v)))
                print(f"[{label}] step {step}/{steps} t={step * dt:.3f} urms={um:.3f} umax={mx:.3f} ({time.time() - t0:.0f}s)", flush=True)
                if mx > 1.6 * UMAX:
                    print("warning: CFL exceeded", flush=True)
        return wh, c1h, c2h


def refine(state, g0, g1):
    """Zero-pad spectra from grid g0 to the finer grid g1 (exact spectral interpolation)."""
    out = []
    n0, n1 = g0.N, g1.N
    for a in state:
        b = np.zeros((n1, n1 // 2 + 1), dtype=np.complex128)
        h = n0 // 2
        b[:h, :h + 1] = a[:h, :h + 1]
        b[n1 - h:, :h + 1] = a[n0 - h:, :h + 1]
        out.append(b * (n1 * n1) / (n0 * n0))
    return out


g0 = Grid(N_FINAL // 2)
w0 = np.zeros_like(g0.K, dtype=np.complex128)
w0[g0.band] = (rng.standard_normal(g0.nb) + 1j * rng.standard_normal(g0.nb)) * g0.N ** 2 * 0.02
state = g0.run((w0, np.zeros_like(w0), np.zeros_like(w0)), T_SPIN, f"spin {g0.N}")
g = Grid(N_FINAL)
state = g.run(refine(state, g0, g), T_FINE, f"fine {g.N}")
wh, c1h, c2h = state
N = g.N
K = g.K
K2i = g.K2i
iKX, iKY = g.iKX, g.iKY
irf = g.irf
dt = g.dt
STEPS = int(np.ceil(T_SPIN / g0.dt)) + int(np.ceil(T_FINE / g.dt))

def highpass(ch, k0=3.0):
    return ch * (1.0 - np.exp(-(K / k0) ** 4))

def to_u8(a, s):
    return np.clip(np.round(127.5 + 127.5 * np.clip(a / s, -1, 1)), 0, 255).astype(np.uint8)

os.makedirs(out_dir, exist_ok=True)
stats = {}
for name, ch in (("c1", c1h), ("c2", c2h)):
    a = irf(highpass(ch))
    s = 2.6 * float(np.std(a))
    stats[name] = {"std": float(np.std(a)), "clip_frac": float(np.mean(np.abs(a) > s))}
    Image.fromarray(to_u8(a, s), "L").save(os.path.join(out_dir, f"turb_{name}.webp"), quality=90, method=6)
# velocity, spectrally truncated to N/4 (exact band-limited downsample)
M = N // 4
ph = wh * K2i
uh = iKY * ph
vh = -iKX * ph
def down(ah):
    sel_y = np.r_[0:M // 2, N - M // 2:N]
    sub = ah[sel_y][:, : M // 2 + 1] * (M * M) / (N * N)
    return F.irfft2(sub, s=(M, M), workers=-1)
ud = down(uh); vd = down(vh)
UV = float(max(np.max(np.abs(ud)), np.max(np.abs(vd))))
# u and v as separate (repeat-wrappable) grayscale images; lossless (smooth fields compress well)
Image.fromarray(to_u8(ud, UV), "L").save(os.path.join(out_dir, "turb_u.webp"), lossless=True, method=6)
Image.fromarray(to_u8(vd, UV), "L").save(os.path.join(out_dir, "turb_v.webp"), lossless=True, method=6)
stats.update({"N": N, "steps": STEPS, "dt": dt, "t_end": T_SPIN + T_FINE, "uv_scale": UV, "kf": KF,
              "urms": float(np.sqrt(np.mean(irf(uh) ** 2 + irf(vh) ** 2)))})
print(json.dumps(stats))
with open(os.path.join(out_dir, "turb_meta.json"), "w") as f:
    json.dump(stats, f, indent=1)
