# dev: replica of post's AgX display transform (default grade) for calibration: HDR linear sRGB -> sRGB 8-bit
import numpy as np
S2020 = np.array([[0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.0880], [0.0433, 0.0113, 0.8956]]).T
R2S = np.array([[1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]]).T
AIN = np.array([[0.856627153315983, 0.137318972929847, 0.11189821299995], [0.0951212405381588, 0.761241990602591, 0.0767994186031903], [0.0482516061458583, 0.101439036467562, 0.811302368396859]]).T
AOUT = np.array([[1.1271005818144368, -0.1413297634984383, -0.14132976349843826], [-0.11060664309660323, 1.157823702216272, -0.11060664309660294], [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405]]).T
def curve(x):
    x2 = x * x; x4 = x2 * x2
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232
def agx(c, sat=1.04, shadowTint=0.035, warmth=0.025):
    c = AIN @ (S2020 @ np.asarray(c, float))
    c = (np.log2(np.maximum(c, 1e-10)) + 10.25) / 12.5
    c = np.clip(c, 0, 1)
    c = curve(c) / 0.9977
    l = c @ [0.2126, 0.7152, 0.0722]
    c = l + sat * (c - l)
    c = AOUT @ c
    c = np.maximum(c, 0) ** 2.2
    d = np.clip(R2S @ c, 0, 1)
    l = d @ [0.2126, 0.7152, 0.0722]
    sh = 1 - np.clip(l / 0.25, 0, 1) ** 2 * (3 - 2 * np.clip(l / 0.25, 0, 1))
    t = np.clip((l - 0.35) / 0.65, 0, 1); hi = t * t * (3 - 2 * t)
    t2 = np.clip(l / 0.02, 0, 1); s02 = t2 * t2 * (3 - 2 * t2)
    d = d * (1 + (np.array([1 - 0.5 * shadowTint, 1, 1 + shadowTint]) - 1) * sh * s02)
    d = d * (1 + (np.array([1 + warmth, 1 + 0.3 * warmth, 1 - warmth]) - 1) * hi)
    d = np.clip(d, 0, 1)
    s = np.where(d <= 0.0031308, 12.92 * d, 1.055 * d ** (1 / 2.4) - 0.055)
    return np.round(s * 255)
if __name__ == '__main__':
    for v in [0.01, 0.02, 0.05, 0.1, 0.18, 0.3, 0.5, 0.7, 0.8, 1.0, 1.3, 1.6, 2.0, 3.0]:
        print(v, agx([v, v, v]))
    for c in [[0.03591, 0.06647, 0.1425], [0.7958, 0.7924, 0.7818]]:
        print(c, agx(c))
    # inverse search: HDR giving Apollo ocean (28,57,92) and (35,64,102)
    from scipy.optimize import least_squares
