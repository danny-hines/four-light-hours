// Subject-aware composition for the HUD's text blocks (title cards, captions).
//
// A text block must never sit on the film's subject. For every beat we look at the frames it will be shown over
// (director.evaluate is a pure function of t), find where the subject is on screen — every body / moon sphere,
// Saturn's rings, the Sun's disc and its glare, labelled points — and score each candidate placement of the block
// (lower-left, lower-right, upper-left; a narrower reflow; a tighter title; a short name+subtitle form) by how much
// of its *text* (the measured line boxes, not the bounding box) lands on the subject. The winner is chosen once
// per beat and viewport size, so the block never jumps mid-beat and seek(t) always gives the same layout.
//
// The subject test is exact ray–sphere geometry against the true positions (the same geometry the renderer uses),
// with a padding angle so text keeps clear of limbs and prominences. Lit surface weighs more than night side.

const PAD_PX = 22; // keep text this far (CSS px at --u = 1) from a limb
const HARD_PX = 30; // no text at all within this distance of a labelled point

export function createComposer({ THREE, BODIES, spheresAt, satPole, ringIn, ringOut, labelPoints, orbitLines = null }) {
  const qInv = new THREE.Quaternion();
  const tmp = new THREE.Vector3();
  const sunR = BODIES.sun.radius;

  /** Everything we need to test screen points against the subject for one shot. */
  function snapshot(shot, W, H, { focus = shot.focus, u = 1, labels = true, spheres = null, lines = true } = {}) {
    const fov = ((shot.fov ?? 35) * Math.PI) / 180;
    const tanY = Math.tan(fov / 2);
    const f = H / 2 / tanY;
    const halfDiag = Math.atan(Math.hypot(tanY * (W / H), tanY));
    qInv.copy(shot.camQuat).invert();
    const cam = shot.camPos;
    const padA = (PAD_PX * u) / f;
    const items = [];
    let sun = null;
    for (const o of spheres || spheresAt(shot.simDays)) {
      const c = o.pos.clone().sub(cam).applyQuaternion(qInv);
      const d = c.length();
      if (!(d > o.radius * 1.0005)) continue;
      const isSun = o.id === 'sun';
      const R = isSun ? o.radius * 1.12 : o.radius; // the Sun: include limb prominences
      const a = Math.asin(Math.min(1, R / d));
      // angle between the view axis (-z) and the centre: skip spheres entirely outside the view cone
      const axis = Math.acos(Math.max(-1, Math.min(1, -c.z / d)));
      const rpx = f * Math.tan(Math.min(a, 1.45));
      const isFocus = o.id === focus;
      // tiny discs only matter if they are the subject (the focus) — then they are a point to keep clear of
      const small = rpx < 3;
      if (small && !isFocus && !isSun) continue;
      const outer = small ? a + (14 * u) / f : a + padA;
      if (axis > halfDiag + outer + (isSun ? 0.6 : 0)) continue;
      const it = { id: o.id, c, d, R, a, cosA: Math.cos(a), cosOuter: Math.cos(Math.min(Math.PI, outer)), small, isSun, isFocus, rpx, sunDir: null, base: isFocus ? 1 : 0.8 };
      if (isSun) sun = it;
      items.push(it);
    }
    // camera-space Sun position (for lighting) and whether a body hides it (no glare then)
    const sunC = tmp.copy(cam).negate().applyQuaternion(qInv).clone();
    for (const it of items) if (!it.isSun) it.sunDir = sunC.clone().sub(it.c).normalize();
    let glare = 0;
    if (sun) {
      glare = 1;
      const sd = sun.c.clone().normalize();
      for (const it of items) {
        if (it.isSun || it.d >= sun.d) continue;
        const ang = Math.acos(Math.max(-1, Math.min(1, it.c.dot(sd) / it.d)));
        if (ang < it.a) glare = 0;
      }
    }
    // Saturn's rings (plane through Saturn's centre, normal = pole)
    let ring = null;
    const sat = items.find((it) => it.id === 'saturn');
    if (sat && !sat.small && ringOut) ring = { c: sat.c, n: satPole.clone().applyQuaternion(qInv) };
    else if (!sat && ringOut) {
      // Saturn itself may be off screen while its rings are not
      const so = spheresAt(shot.simDays).find((o) => o.id === 'saturn');
      if (so) {
        const c = so.pos.clone().sub(cam).applyQuaternion(qInv);
        if (c.length() < ringOut * 400) ring = { c, n: satPole.clone().applyQuaternion(qInv) };
      }
    }
    // labelled points (the director's labels): keep text off them too
    const points = [];
    if (labels && labelPoints) {
      for (const p of labelPoints(shot)) {
        const c = p.pos.clone().sub(cam).applyQuaternion(qInv);
        if (c.z >= 0) continue;
        const sx = W / 2 + (c.x / -c.z) * f, sy = H / 2 - (c.y / -c.z) * f;
        if (sx < -20 || sy < -20 || sx > W + 20 || sy > H + 20) continue;
        // (a clearly shown point is a hard obstacle: no text within HARD_PX of it, whatever the score)
        points.push({ sx, sy, r: 13 * u, w: 0.55 * p.alpha, keep: p.alpha > 0.3 ? HARD_PX * u : 0 });
      }
    }
    const S = { W, H, f, u, items, ring, sun, glare, points, glareScale: 0.045 * H, blobs: null, lines: null };
    // the finale's orbit lines (shot.orbits = their opacity): thin, but text should not be printed across them
    if (lines && orbitLines && (shot.orbits || 0) > 0.05) S.lines = rasterLines(orbitLines, cam, W, H, f, u, 0.32 * Math.min(1, shot.orbits));
    S.blobs = S.lines ? null : boundsOf(S);
    return S;
  }
  // projected polylines -> a coarse weight grid (cells of 8 u px; a line marks a band three cells wide)
  const _lp = new THREE.Vector3();
  function rasterLines(lines, cam, W, H, f, u, wt) {
    const cell = Math.max(6, 8 * u);
    const nx = Math.ceil(W / cell), ny = Math.ceil(H / cell);
    const g = new Float32Array(nx * ny);
    const mark = (x, y) => {
      const i = Math.floor(x / cell), j = Math.floor(y / cell);
      for (let b = j - 1; b <= j + 1; b++) for (let a = i - 1; a <= i + 1; a++) if (a >= 0 && b >= 0 && a < nx && b < ny) g[b * nx + a] = wt;
    };
    for (const pts of lines) {
      let px = 0, py = 0, ok = false;
      for (let k = 0; k < pts.length; k += 3) {
        _lp.set(pts[k] - cam.x, pts[k + 1] - cam.y, pts[k + 2] - cam.z).applyQuaternion(qInv);
        if (_lp.z > -1e-6) { ok = false; continue; }
        const sx = W / 2 + (_lp.x / -_lp.z) * f, sy = H / 2 - (_lp.y / -_lp.z) * f;
        if (ok && !((px < 0 && sx < 0) || (py < 0 && sy < 0) || (px > W && sx > W) || (py > H && sy > H))) {
          const n = Math.min(400, Math.ceil(Math.hypot(sx - px, sy - py) / (cell * 0.5)));
          for (let q = 0; q <= n; q++) mark(px + ((sx - px) * q) / n, py + ((sy - py) * q) / n);
        }
        px = sx; py = sy; ok = true;
      }
    }
    return { g, nx, ny, cell };
  }

  // Conservative screen-space circles around everything weightAt can see (null = cannot bound: test every point).
  // Lets coverage() skip text rows that are nowhere near the subject.
  function boundsOf(S) {
    const out = [];
    const cx = S.W / 2, cy = S.H / 2;
    for (const it of S.items) {
      if (it.c.z > -it.R * 0.2 || it.a > 1.2) return null; // very close / off to the side: no simple bound
      const sx = cx + (it.c.x / -it.c.z) * S.f, sy = cy - (it.c.y / -it.c.z) * S.f;
      const off = Math.hypot(sx - cx, sy - cy) / S.f; // off-axis stretch of the projected disc
      let r = (it.small ? 14 * S.u : it.rpx + PAD_PX * S.u) * (1.08 + off * off) + 2;
      if (it.isSun && S.glare) r += 5 * (S.glareScale + 0.2 * it.rpx);
      out.push({ x: sx, y: sy, r });
    }
    if (S.ring) {
      const { c } = S.ring;
      if (c.z > -ringOut * 1.2) return null;
      const d = c.length();
      out.push({ x: cx + (c.x / -c.z) * S.f, y: cy - (c.y / -c.z) * S.f, r: S.f * Math.tan(Math.min(1.2, Math.asin(Math.min(1, ringOut / d)))) * 1.3 + 4 });
    }
    for (const p of S.points) out.push({ x: p.sx, y: p.sy, r: Math.max(p.r, p.keep || 0) + 1 });
    return out;
  }
  // Hard obstacles: text may never be printed on a labelled point (with a keep-out ring of HARD_PX) or on the
  // Sun's disc. Returns true if rect (x, y, w, h) touches one in snapshot S.
  function hardHit(S, x, y, w, h) {
    for (const p of S.points) {
      if (!p.keep) continue;
      const dx = Math.max(x - p.sx, 0, p.sx - (x + w)), dy = Math.max(y - p.sy, 0, p.sy - (y + h));
      if (dx * dx + dy * dy < p.keep * p.keep) return true;
    }
    const s = S.sun;
    if (s && s.c.z < -s.R) {
      const sx = S.W / 2 + (s.c.x / -s.c.z) * S.f, sy = S.H / 2 - (s.c.y / -s.c.z) * S.f;
      const r = s.rpx + 4 * S.u;
      const dx = Math.max(x - sx, 0, sx - (x + w)), dy = Math.max(y - sy, 0, sy - (y + h));
      if (dx * dx + dy * dy < r * r) return true;
    }
    return false;
  }
  const rectNear = (blobs, x, y, w, h) => {
    if (!blobs) return true;
    for (const b of blobs) {
      const dx = Math.max(x - b.x, 0, b.x - (x + w)), dy = Math.max(y - b.y, 0, b.y - (y + h));
      if (dx * dx + dy * dy < b.r * b.r) return true;
    }
    return false;
  };

  /** How much of the subject is under screen point (sx, sy): 0 (empty sky) .. 1 (lit disc / the Sun). */
  function weightAt(S, sx, sy) {
    let rx = (sx - S.W / 2) / S.f, ry = -(sy - S.H / 2) / S.f, rz = -1;
    const rl = Math.hypot(rx, ry, rz);
    rx /= rl; ry /= rl; rz /= rl;
    let w = 0;
    for (const it of S.items) {
      const b = rx * it.c.x + ry * it.c.y + rz * it.c.z;
      if (b <= 0) continue;
      const cosT = b / it.d;
      if (it.isSun) {
        if (cosT >= it.cosA) return 1;
        if (S.glare) {
          // the glare around the disc (post adds bloom + flare): bright, roughly constant on screen
          const th = Math.acos(Math.min(1, cosT));
          const dpx = (th - it.a) * S.f;
          const g = 0.6 * Math.exp(-dpx / (S.glareScale + 0.2 * it.rpx));
          if (g > w) w = g;
        }
        continue;
      }
      if (cosT < it.cosOuter) continue;
      if (it.small) {
        w = Math.max(w, 0.7);
        continue;
      }
      if (cosT >= it.cosA) {
        // on the disc: lit side counts fully, the night side less (it is still the subject's silhouette)
        const d2 = it.d * it.d - b * b;
        const tHit = b - Math.sqrt(Math.max(0, it.R * it.R - d2));
        const nx = (rx * tHit - it.c.x) / it.R, ny = (ry * tHit - it.c.y) / it.R, nz = (rz * tHit - it.c.z) / it.R;
        const lam = Math.max(0, nx * it.sunDir.x + ny * it.sunDir.y + nz * it.sunDir.z);
        const v = it.base * (0.3 + 0.7 * Math.sqrt(lam));
        if (v > w) w = v;
      } else if (0.42 * it.base > w) w = 0.42 * it.base; // the padding band around the limb
    }
    if (S.ring) {
      const { c, n } = S.ring;
      const den = rx * n.x + ry * n.y + rz * n.z;
      if (Math.abs(den) > 1e-6) {
        const t = (c.x * n.x + c.y * n.y + c.z * n.z) / den;
        if (t > 0) {
          const hx = rx * t - c.x, hy = ry * t - c.y, hz = rz * t - c.z;
          const rr = Math.hypot(hx, hy, hz);
          if (rr > ringIn && rr < ringOut) w = Math.max(w, 0.6);
        }
      }
    }
    for (const p of S.points) {
      const dd = Math.hypot(sx - p.sx, sy - p.sy);
      if (dd < p.r) w = Math.max(w, p.w);
    }
    if (S.lines && sx >= 0 && sy >= 0) {
      const L = S.lines, i = Math.floor(sx / L.cell), j = Math.floor(sy / L.cell);
      if (i < L.nx && j < L.ny && L.g[j * L.nx + i] > w) w = L.g[j * L.nx + i];
    }
    return w;
  }

  /**
   * Covered text area of a placement, summed over its sample frames.
   * rows: [{ x, y, w, h, stage }] (viewport px when measured); samples: [{ S, stages:Set, dy, wt }]
   * dy shifts the rows at that sample (letterbox movement); wt = how visible the block is then (fade in / out).
   * Returns { cost, mean, peak }, covered area normalised by refArea.
   */
  function coverage(rows, samples, refArea, anchorTop) {
    let sum = 0, peak = 0, n = 0, hard = 0;
    for (const sm of samples) {
      let acc = 0;
      for (const r of rows) {
        if (!sm.stages.has(r.stage)) continue;
        const y0 = r.y + (anchorTop ? sm.dy : -sm.dy);
        if (hard < (sm.wt ?? 1) && hardHit(sm.S, r.x, y0, r.w, r.h)) hard = sm.wt ?? 1;
        if (!rectNear(sm.S.blobs, r.x, y0, r.w, r.h)) continue;
        const step = Math.max(10, 12 * sm.S.u);
        const nx = Math.max(1, Math.round(r.w / step)), ny = Math.max(1, Math.round(r.h / step));
        const cw = r.w / nx, ch = r.h / ny;
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            const wt = weightAt(sm.S, r.x + (i + 0.5) * cw, y0 + (j + 0.5) * ch);
            if (wt > 0) acc += wt * cw * ch;
          }
      }
      const wt = sm.wt ?? 1;
      const c = acc / Math.max(1, refArea);
      sum += c * wt;
      peak = Math.max(peak, c * wt);
      n += wt;
    }
    const mean = n ? sum / n : 0;
    // a hard obstacle (a labelled point, the Sun's disc) under the text at any sample all but rules the candidate out
    return { cost: 0.6 * mean + 0.4 * peak + 2 * hard, mean, peak, hard };
  }

  /** Screen radius (px) and centre of a body for a shot — for arrival gating. */
  function screenDisc(shot, id, W, H) {
    const S = snapshot(shot, W, H, { focus: id, labels: false });
    const it = S.items.find((x) => x.id === id);
    if (!it || it.c.z >= 0) return null;
    return { sx: W / 2 + (it.c.x / -it.c.z) * S.f, sy: H / 2 - (it.c.y / -it.c.z) * S.f, r: it.rpx, glare: S.sun && S.glare ? S.sun : null, S };
  }

  return { snapshot, weightAt, coverage, screenDisc };
}

/** Rects of the visible text inside an element: one per line box group (Range rects), in viewport px. */
export function textRects(e) {
  if (!e) return [];
  const rg = document.createRange();
  rg.selectNodeContents(e);
  const out = [];
  for (const b of rg.getClientRects()) if (b.width > 0.5 && b.height > 0.5) out.push({ x: b.left, y: b.top, w: b.width, h: b.height });
  return mergeRects(out);
}
/** union bounding box of a list of rects */
export function unionRect(rs) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rs) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
// collapse the many glyph rects of one line into one rect per line
function mergeRects(rs) {
  const lines = [];
  for (const r of rs) {
    const L = lines.find((l) => Math.abs(l.y + l.h / 2 - (r.y + r.h / 2)) < Math.max(l.h, r.h) * 0.5);
    if (L) {
      const x1 = Math.max(L.x + L.w, r.x + r.w), y1 = Math.max(L.y + L.h, r.y + r.h);
      L.x = Math.min(L.x, r.x); L.y = Math.min(L.y, r.y); L.w = x1 - L.x; L.h = y1 - L.y;
    } else lines.push({ ...r });
  }
  return lines;
}
