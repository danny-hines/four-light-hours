"""Forward/inverse of the post AgX tonemap (dev only). usage:
  python -I agx.py fwd r g b          -> display sRGB 0-255 for linear radiance
  python -I agx.py inv R G B          -> linear radiance for display sRGB 0-255"""
import site, sys
p = site.getusersitepackages()
if p not in sys.path:
    sys.path.append(p)
import numpy as np
# GLSL mat3(vec3 a, vec3 b, vec3 c) -> columns
def M(a, b, c): return np.array([a, b, c]).T
S2020 = M((0.6274, 0.0691, 0.0164), (0.3293, 0.9195, 0.0880), (0.0433, 0.0113, 0.8956))
R2S = M((1.6605, -0.1246, -0.0182), (-0.5876, 1.1329, -0.1006), (-0.0728, -0.0083, 1.1187))
AIN = M((0.856627153315983, 0.137318972929847, 0.11189821299995), (0.0951212405381588, 0.761241990602591, 0.0767994186031903), (0.0482516061458583, 0.101439036467562, 0.811302368396859))
AOUT = M((1.1271005818144368, -0.1413297634984383, -0.14132976349843826), (-0.11060664309660323, 1.157823702216272, -0.11060664309660294), (-0.016493938717834573, -0.016493938717834257, 1.2519364065950405))
SAT = 1.04
def curve(x):
    x2 = x * x; x4 = x2 * x2
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232
def agx(c):
    c = AIN @ (S2020 @ c)
    c = np.clip((np.log2(np.maximum(c, 1e-10)) + 10.25) / 12.5, 0, 1)
    c = curve(c) / 0.9977
    l = c @ np.array([0.2126, 0.7152, 0.0722])
    c = l + SAT * (c - l)
    c = AOUT @ c
    c = np.maximum(c, 0) ** 2.2
    return np.clip(R2S @ c, 0, 1)
def enc(c):
    return np.where(c > 0.0031308, 1.055 * np.power(np.maximum(c, 1e-9), 1 / 2.4) - 0.055, c * 12.92)
def fwd(lin):
    return enc(agx(np.array(lin, float))) * 255
def inv(t):
    t = np.array(t, float)
    x = np.full(3, 0.3)
    for _ in range(200):
        f = fwd(x) - t
        J = np.zeros((3, 3))
        for k in range(3):
            d = np.zeros(3); d[k] = 1e-4 * max(x[k], 1e-3)
            J[:, k] = (fwd(x + d) - fwd(x)) / d[k]
        x = np.maximum(x - np.linalg.solve(J, f) * 0.7, 1e-5)
    return x
if __name__ == '__main__':
    a = sys.argv
    v = list(map(float, a[2:5]))
    if a[1] == 'fwd': print(np.round(fwd(v), 1))
    else:
        x = inv(v); print(np.round(x, 4), 'check', np.round(fwd(x), 1))
