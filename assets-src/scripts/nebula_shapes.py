"""Morphology of the sky's signature nebulae for build_nebulae.py (sky orientation: +x east, +y north, arcmin)."""
import numpy as np


def m42(S):
    """Orion Nebula M42 / M43 / NGC 1977, centred on the Trapezium (RA 83.8187, Dec -5.3897), +-45'."""
    s = S(256, 256, 45, 45, 42)
    fil = s.filaments(4.0, 0.7)
    n2 = s.noise(2.0, 4)
    # Huygens region: brilliant core just SW of the Trapezium, the fan opening to the south-west
    core = s.blob(-1.0, -0.8, 2.2, 1.9, 0, 1.5)
    inner = s.blob(-1.5, -2.5, 4.5, 5.0, -25, 1.6)
    fan = s.blob(-3.5, -7.0, 7.5, 10.5, -28, 1.6)
    # the wings: faint loops sweeping east-then-south and west-then-south
    # (deep images: the wings sweep ~25' out to either side and curl south over ~35', the whole nebula spanning
    # about 1.2 x 1.0 deg; the eastern wing is the brighter, broken by the dark lanes coming off the Fish's Mouth)
    wing_e = s.stroke([(2.5, 1.5), (9, 0.5), (16, -2.0), (22, -6.5), (25.5, -13), (25, -21), (22, -29)], 3.4)
    wing_w = s.stroke([(-5, 1.5), (-12, 0.5), (-19, -2.5), (-25, -7.5), (-28.5, -15), (-28, -24), (-25, -32)], 3.8)
    wing_e2 = s.stroke([(4, -2.5), (11, -6), (16, -11), (18, -19)], 2.2)
    wing_w2 = s.stroke([(-7, -2.5), (-14, -6.5), (-19, -12), (-21, -20)], 2.4)
    halo = s.blob(-2.5, -10, 21, 24, -8, 1.7)
    fill = s.blob(-2.0, -14, 19, 11, 0, 1.8)   # faint nebulosity inside the arch of the wings (south of the fan)
    # surface-brightness ladder (peak mu ~16.4 at the Huygens region): inner ~17.8, fan ~19.5, wings ~21,
    # outer halo ~22.5 mag/arcsec^2 -- a steep ladder, so the core reads bright and the wings fade into the sky
    em = (1.0 * core + 0.22 * inner + 0.055 * fan * fil + 0.02 * (1.15 * wing_e + wing_w) * fil
          + 0.011 * (wing_e2 + wing_w2) * fil + 0.0045 * halo * fil + 0.006 * fill * fil)
    em = s.warp(em, 0.9, 4)
    em *= np.exp(0.18 * n2)
    # the dark bay / Fish's Mouth: foreground dust from the north-east reaching toward the Trapezium, which also
    # sets the sharp eastern edge of the bright region
    bay = np.clip(s.stroke([(1.2, 1.6), (3.2, 3.6), (6.0, 5.8), (10.0, 8.5)], 1.3)
                  + 0.9 * s.blob(6.5, 5.0, 4.5, 2.4, 35, 2.5) + 0.8 * s.blob(9.5, 0, 4.0, 7.0, 0, 2.2), 0, 1.2)
    bay = s.warp(bay, 0.5, 2.0)
    dust = 2.8 * bay
    # M43: a comma north-north-east of the Fish's Mouth, with its dark lane on the east
    m43 = s.blob(4.0, 7.3, 2.2, 2.6, 0, 1.6) * (1 - 0.75 * s.blob(5.6, 7.0, 0.8, 2.6, 15))
    em += 0.14 * m43 * np.exp(0.25 * n2)
    # NGC 1973/75/77 (the Running Man), 30' north: blue reflection with the dark figure lanes
    rm = s.blob(1.5, 31, 8, 5.5, 0, 1.6)
    rm_lanes = s.stroke([(-4, 30.5), (1, 32), (6, 29)], 0.9) + s.stroke([(0, 36), (1.5, 31), (3, 26)], 0.8)
    s.rf = rm * (1 - 0.8 * np.clip(rm_lanes, 0, 1)) * s.filaments(3.0, 0.5)
    em += 0.004 * rm
    s.em = em * np.exp(-1.0 * dust)
    s.dust = dust
    return s


def lagoon(S):
    """Lagoon Nebula M8, centred RA 270.92, Dec -24.38: +-45' x +-22.5'."""
    s = S(256, 128, 48, 24, 8)
    fil = s.filaments(4.0, 0.65)
    n2 = s.noise(1.5, 4)
    west = s.blob(-9, 0, 12, 8.5, 8, 1.7)
    hourglass = s.blob(-5.5, -1.2, 1.2, 1.8, 20, 1.5)
    east = s.blob(13, 2, 13, 9, -10, 1.7)
    glow = s.blob(0, 0, 22, 11, 0, 1.8)
    em = 0.55 * west * fil + 1.0 * hourglass + 0.16 * east * fil + 0.03 * glow * fil
    em = s.warp(em, 1.2, 5)
    em *= np.exp(0.2 * n2)
    # the "lagoon": a dark lane winding north-south between the bright west and the cluster-rich east
    lane = s.stroke([(3, 22), (1, 12), (0, 4), (2, -4), (5, -11), (9, -20)], 2.0)
    lane = s.warp(lane, 0.9, 3)
    lane2 = s.stroke([(-16, 9), (-10, 6), (-6, 7)], 0.9)
    dust = 1.8 * lane + 0.9 * lane2
    s.em = em * np.exp(-1.1 * dust)
    s.dust = 0.7 * dust
    return s


def carina(S):
    """Carina Nebula NGC 3372, centred on eta Car (RA 161.265, Dec -59.685): +-75'."""
    s = S(128, 128, 75, 75, 3372)
    fil = s.filaments(6.0, 0.85)
    n2 = s.noise(3, 4)
    north = s.blob(-8, 10, 28, 19, 30, 1.6)
    south = s.blob(14, -18, 21, 15, 35, 1.6)
    tr16 = s.blob(1, 0, 5, 5, 0, 1.6)
    tr14 = s.blob(-6, 5, 3.5, 3.5, 0, 1.6)
    halo = s.blob(0, -3, 45, 38, 25, 1.7)
    em = 0.5 * north * fil + 0.42 * south * fil + 0.7 * tr16 + 0.5 * tr14 + 0.035 * halo * fil
    em = s.warp(em, 2.0, 9)
    em *= np.exp(0.2 * n2)
    # the great V-shaped dust lane opening to the south, and the Keyhole beside eta Car
    v1 = s.stroke([(2, -3), (12, -8), (26, -16), (44, -30)], 4.5)
    v2 = s.stroke([(2, -3), (-5, -14), (-12, -28), (-20, -46)], 3.8)
    keyhole = s.blob(-2.2, 1.0, 2.4, 1.5, 30, 2.0)
    lanes = s.warp(np.clip(v1 + v2, 0, 1), 1.6, 5)
    dust = 3.0 * lanes + 2.0 * keyhole + 0.6 * np.clip(s.noise(5, 3) - 0.8, 0, 1)
    s.em = em * np.exp(-1.1 * dust)
    s.dust = 0.8 * dust
    return s


def nan_pelican(S):
    """North America & Pelican (NGC 7000, IC 5070) around LDN 935, centred RA 313.6, Dec 44.3: +-100'."""
    s = S(128, 128, 100, 100, 7000)
    fil = s.filaments(10.0, 0.6)
    n2 = s.noise(4, 4)
    # the continent (east of the dark cloud): body, Mexico to the south, the Florida peninsula on its west coast
    body = s.blob(46, 10, 40, 47, -10, 1.8)
    mexico = s.blob(34, -38, 15, 19, 25, 1.8)
    florida = s.blob(17, -21, 5, 11, 10, 1.9)
    wall = s.stroke([(16, -12), (22, -34), (30, -52)], 2.4)  # the Cygnus Wall: bright rim facing the dark cloud
    nan = 0.5 * body * fil + 0.6 * mexico * fil + 0.45 * florida + 0.8 * wall
    # the Pelican (west of the dark cloud), its bright head/beak rim facing east
    pel = s.blob(-38, 8, 26, 28, 20, 1.7)
    beak = s.stroke([(-8, 30), (-10, 14), (-6, 2), (-14, -8)], 2.8)
    # (the Pelican is the smaller, fainter partner: the continent dominates, so the pair is not a symmetric butterfly)
    em = nan + 0.17 * pel * fil + 0.42 * beak + 0.035 * s.blob(18, 0, 70, 70, 0, 1.8)
    em = s.warp(em, 2.5, 12)
    em *= np.exp(0.2 * n2)
    # LDN 935: the dark cloud between them; the Gulf of Mexico is its bay into the continent
    cloud = s.stroke([(4, 70), (2, 40), (0, 15), (2, -10), (6, -40), (4, -75)], 8.0)
    gulf = s.blob(25, -25, 12, 10, 15, 2.0)
    dust = s.warp(np.clip(cloud + 1.1 * gulf, 0, 1.4), 2.5, 8)
    dust = 2.2 * dust
    s.em = em * np.exp(-1.3 * dust)
    s.dust = 0.9 * dust
    return s


def rho_oph(S):
    """rho Ophiuchi complex, centred RA 246.6, Dec -24.8: +-200'. rho Oph blue, Antares yellow, sigma Sco red."""
    s = S(128, 128, 200, 200, 1688)
    fil = s.filaments(18.0, 0.55)
    n2 = s.noise(7, 4)
    cd = np.cos(np.radians(-24.8))

    def pos(ra, dec):
        return ((ra - 246.6) * cd * 60, (dec + 24.8) * 60)
    rx, ry = pos(246.40, -23.45)
    ax, ay = pos(247.35, -26.43)
    sx, sy = pos(245.30, -25.59)
    tx, ty = pos(247.0, -25.05)  # 22 Sco / IC 4605 region
    rho = s.blob(rx, ry, 30, 26, 30, 1.6) + 0.6 * s.blob(rx + 6, ry - 4, 12, 10, 0, 1.6)
    sig = s.blob(sx, sy, 32, 29, 0, 1.7)
    tsc = s.blob(tx, ty, 14, 12, 0, 1.6)
    rho, sig = s.warp(rho, 4, 25), s.warp(sig, 5, 25)
    blue = (0.6 * rho + 0.25 * tsc) * fil * np.exp(0.15 * n2)
    red = 0.45 * sig * fil * np.exp(0.2 * n2)
    # dark lanes: the L1688 core east of rho Oph and the streamers running east-north-east
    core = s.blob(rx + 26, ry - 40, 28, 16, 30, 1.8)
    str1 = s.stroke([(rx + 20, ry - 30), (rx + 70, ry - 20), (rx + 140, ry - 5), (rx + 200, ry + 10)], 6)
    str2 = s.stroke([(rx + 10, ry - 70), (rx + 60, ry - 75), (rx + 130, ry - 60), (rx + 190, ry - 55)], 5)
    lane = s.stroke([(rx - 20, ry - 25), (rx + 5, ry - 8), (rx + 25, ry + 5)], 3.5)
    dust = s.warp(np.clip(1.4 * core + 0.9 * str1 + 0.7 * str2 + 0.8 * lane, 0, 2.0), 4, 14)
    att = np.exp(-0.9 * dust)
    s.em = red * att
    s.rf = blue * att  # (the yellow Antares glow, a smooth reflection halo, stays an analytic catalogue object)
    s.dust = 0.9 * dust
    return s


def trifid(S):
    """Trifid Nebula M20, centred RA 270.60, Dec -23.02: +-16'. Red emission trisected by dark lanes, blue to the north."""
    s = S(128, 128, 16, 16, 20)
    fil = s.filaments(1.5, 0.5)
    em = s.blob(0, 0, 4.8, 4.8, 0, 1.7) + 0.12 * s.blob(0, 0, 7.5, 7.5, 0, 1.6)
    em = s.warp(em, 0.35, 1.8) * fil
    lanes = (s.stroke([(0.3, 0.2), (-0.5, 6.5)], 0.5) + s.stroke([(0.3, 0.2), (5.8, -2.6)], 0.45)
             + s.stroke([(0.3, 0.2), (-4.8, -4.2)], 0.45))
    lanes = s.warp(np.clip(lanes, 0, 1), 0.22, 1.0)
    dust = 2.4 * lanes
    s.rf = s.blob(0.8, 8.5, 4.2, 3.5, 0, 1.7) * s.filaments(1.5, 0.4)
    s.em = em * np.exp(-1.2 * dust)
    s.dust = 0.7 * dust
    return s


def rosette(S):
    """Rosette Nebula NGC 2237-9, centred RA 97.98, Dec 4.95: +-50'. A thick ring around the NGC 2244 cavity."""
    s = S(128, 128, 50, 50, 2237)
    fil = s.filaments(4.0, 0.7)
    r = np.hypot(s.X, s.Y)
    ring = np.exp(-0.5 * ((r - 22) / 7.5) ** 2) * (1 + 0.3 * np.cos(np.arctan2(s.Y, s.X) - 2.2))
    ring = s.warp(ring, 2.2, 7) * fil
    globules = np.clip(s.noise(1.4, 3) - 1.8, 0, 1) * np.exp(-0.5 * ((r - 16) / 5) ** 2)
    dust = 2.0 * globules + 0.5 * np.clip(s.noise(3, 3) - 1.0, 0, 1) * ring
    s.em = ring * np.exp(-1.0 * dust)
    s.dust = 0.6 * dust
    return s


def lmc(S):
    """Large Magellanic Cloud, centred RA 80.89, Dec -69.76: +-6.5 deg. Starlight in the reflection channel (the
    off-centre bar and the clumpy disk lobes), 30 Dor (the Tarantula) and the N11 / N44 / N159 knots in emission."""
    s = S(128, 128, 390, 390, 1)
    n1, n2 = s.noise(40, 5), s.noise(14, 4)
    cd = np.cos(np.radians(-69.76))

    def pos(ra, dec):
        return ((ra - 80.89) * cd * 60, (dec + 69.76) * 60)
    bx, by = pos(80.0, -69.5)
    bar = s.blob(bx, by, 110, 30, -30, 1.8)  # bar PA ~120 deg (N through E)
    lobes = (s.blob(*pos(77, -66.8), 105, 85, 0, 1.6) + 0.8 * s.blob(*pos(87, -68.5), 95, 85, 0, 1.6)
             + 0.7 * s.blob(*pos(74, -70.8), 95, 75, 0, 1.6) + 0.6 * s.blob(*pos(85, -72.0), 85, 70, 0, 1.6)
             + 0.45 * s.blob(*pos(92, -70.5), 60, 55, 0, 1.6))
    star = 1.0 * bar + 0.3 * lobes + 0.08 * s.blob(0, 0, 230, 210, 0, 1.5)
    star = s.warp(star, 12, 70) * np.exp(0.18 * n1 + 0.12 * n2)
    tx, ty = pos(84.68, -69.10)
    taran = s.blob(tx, ty, 5, 4.5, 0, 1.5) + 0.25 * s.blob(tx, ty, 15, 13, 0, 1.6)
    knots = (0.35 * s.blob(*pos(80.9, -67.95), 7, 5) + 0.3 * s.blob(*pos(74.2, -66.45), 8, 7)
             + 0.3 * s.blob(*pos(84.9, -69.7), 5, 8) + 0.15 * s.blob(*pos(83.0, -67.0), 6, 6))
    s.em = (taran + knots) * np.exp(0.3 * n2)
    s.rf = star
    s.dust = 0.25 * np.clip(s.noise(10, 3) - 0.8, 0, 1) * star
    return s
