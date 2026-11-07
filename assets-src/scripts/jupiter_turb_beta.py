"""Jupiter piece: a tileable BETA-PLANE turbulence tracer ("zonal" tile) for the cloud deck's laminar regime.

Same pseudo-spectral solver family as jupiter_turbulence.py, plus the beta effect (the planetary vorticity gradient
of a rotating sphere). Forced 2-D turbulence on a beta plane self-organises into alternating zonal jets at the Rhines
scale (Rhines 1975; Vallis & Maltrud 1993) - the mechanism that makes Jupiter banded. Between the jets eddies roll up;
on the jets the flow is laminar and meanders in Rossby waves; tracers are drawn out into long zonal streaks and
chevron-like wave trains. That is what Jupiter's zones and jet flanks look like at 50-500 km scales, which the
isotropic tile (jupiter_turbulence.py) cannot give.

    w_t + J(psi, w) + beta psi_x = F - nu (-lap)^8 w - mu w - mu_low(k) w
    c_t + J(psi, c) + G . (u, v) = - kappa (-lap)^8 c

Tracer c1: mean gradient along y (staircase-like bands with sharp fronts at the jets),
tracer c2: mean gradient along x (sheared into long zonal streaks and filaments everywhere). Both are written; the
shader uses a blend. Nothing is downloaded: physics + a fixed seed, deterministic, public domain.

Run:  python -I jupiter_turb_beta.py <raw_out_dir> [N] [spin-up time]   (env JB_BETA, JB_KF, JB_AMP, JB_MU, JB_TFINE)
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402,F401
import numpy as np  # noqa: E402
import scipy.fft as F  # noqa: E402
from PIL import Image  # noqa: E402

out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
N_FINAL = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
T_SPIN = float(sys.argv[3]) if len(sys.argv) > 3 else 30.0
T_FINE = float(os.environ.get("JB_TFINE", "1.0"))
BETA = float(os.environ.get("JB_BETA", "60"))
KF = float(os.environ.get("JB_KF", "24"))
AMP = float(os.environ.get("JB_AMP", "0.30"))
MU = float(os.environ.get("JB_MU", "0.04"))
UMAX = float(os.environ.get("JB_UMAX", "5.0"))
rng = np.random.default_rng(20261103)


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
        self.dt = 1.0 * (2 * np.pi / N) / UMAX
        D_hyper = (6.0 / self.dt) * (self.K / kmax) ** 16
        # weak linear drag (jets are long-lived) + hypo-drag on the two largest wavenumbers (no domain-scale condensate)
        D_low = 0.25 * np.where(self.K > 0, (np.minimum(self.K, 2.0) / 2.0) ** -4 - 1.0, 0.0) + MU
        D_low[0, 0] = 0.0
        self.E_w = np.exp(-(D_hyper + D_low) * self.dt)
        self.E_c = np.exp(-D_hyper * self.dt)
        self.band = (np.abs(self.K - KF) < 2.0) & (self.K > 0)
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
        nw = self.rf(u * wx + v * wy) + BETA * self.rf(v)     # beta term: + beta v  (v = -psi_x)
        n1 = self.rf(u * ax + v * ay + v)
        n2 = self.rf(u * bx + v * by + u)
        d = self.dealias
        return -nw * d, -n1 * d, -n2 * d, u, v

    def run(self, state, T, label):
        wh, c1h, c2h = state
        dt = self.dt
        steps = int(np.ceil(T / dt))
        t0 = time.time()
        for step in range(steps):
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
            if step % 400 == 0 or step == steps - 1:
                um = float(np.sqrt(np.mean(u * u + v * v)))
                mx = float(np.max(np.sqrt(u * u + v * v)))
                uz = float(np.sqrt(np.mean(np.mean(u, axis=1) ** 2)))
                print(f"[{label}] step {step}/{steps} t={step * dt:.2f} urms={um:.3f} umax={mx:.3f} zonal={uz:.3f} ({time.time() - t0:.0f}s)", flush=True)
                if mx > 1.6 * UMAX:
                    print("warning: CFL exceeded", flush=True)
        return wh, c1h, c2h


def refine(state, g0, g1):
    out = []
    n0, n1 = g0.N, g1.N
    for a in state:
        b = np.zeros((n1, n1 // 2 + 1), dtype=np.complex128)
        h = n0 // 2
        b[:h, :h + 1] = a[:h, :h + 1]
        b[n1 - h:, :h + 1] = a[n0 - h:, :h + 1]
        out.append(b * (n1 * n1) / (n0 * n0))
    return out


# spin up to statistical equilibrium at N/4 (jets take tens of eddy turnovers to organise), then refine twice
g0 = Grid(N_FINAL // 4)
w0 = np.zeros_like(g0.K, dtype=np.complex128)
w0[g0.band] = (rng.standard_normal(g0.nb) + 1j * rng.standard_normal(g0.nb)) * g0.N ** 2 * 0.02
state = g0.run((w0, np.zeros_like(w0), np.zeros_like(w0)), T_SPIN, f"spin {g0.N}")
g1 = Grid(N_FINAL // 2)
state = g1.run(refine(state, g0, g1), T_FINE, f"mid {g1.N}")
g = Grid(N_FINAL)
state = g.run(refine(state, g1, g), 0.5 * T_FINE, f"fine {g.N}")
wh, c1h, c2h = state
K = g.K


def highpass(ch, k0=2.0):
    return ch * (1.0 - np.exp(-(K / k0) ** 4))


os.makedirs(out_dir, exist_ok=True)
stats = {"N": g.N, "beta": BETA, "kf": KF, "mu": MU, "t_end": T_SPIN + T_FINE}
for name, ch in (("c1", c1h), ("c2", c2h)):
    a = g.irf(highpass(ch))
    np.save(os.path.join(out_dir, f"zon_{name}.npy"), a.astype(np.float32))
    s = 2.6 * float(np.std(a))
    u8 = np.clip(np.round(127.5 + 127.5 * np.clip(a / s, -1, 1)), 0, 255).astype(np.uint8)
    Image.fromarray(u8, "L").save(os.path.join(out_dir, f"zon_{name}_preview.png"))
    stats[name] = float(np.std(a))
ph = wh * g.K2i
u = g.irf(g.iKY * ph)
np.save(os.path.join(out_dir, "zon_u.npy"), u.astype(np.float32))
stats["urms"] = float(np.sqrt(np.mean(u * u)))
stats["u_zonal_profile_rms"] = float(np.sqrt(np.mean(np.mean(u, axis=1) ** 2)))
print(json.dumps(stats))
with open(os.path.join(out_dir, "zon_meta.json"), "w") as f:
    json.dump(stats, f, indent=1)
