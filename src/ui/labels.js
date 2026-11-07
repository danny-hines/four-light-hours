// Projected labels: a hairline reticle on a body or point plus its name, decluttered and occlusion-tested.
// Input positions are universe coordinates; screen = project(position - camera universe position) with ctx.camera.
//
// Layout (all in screen pixels, every frame, deterministic):
//   1. project + cull (behind camera, off screen, occluded by another sphere, or the body fills the view)
//   2. reticles shrink to fit when points crowd together (the inner planets seen from Neptune)
//   3. names are placed by priority (`priority`, then items with a sub line, then input order) on rings of
//      increasing radius around their point; any placement away from the first ring gets a hairline leader.
// Hard obstacles — a candidate is rejected, never merely penalised — for names and leaders alike: the HUD's text
// rows (title card, caption, telemetry), every body / moon disc on screen wider than 4 px (other than the label's
// own), other reticles and names, other leaders, the letterbox matte and a safe-area inset. A point that lies under
// visible text fades out with that text instead of being drawn through it.

const ANGLES = [0, 180, -32, 32, -148, 148, -62, 62, -118, 118, -90, 90].map((d) => (d * Math.PI) / 180);

export function createLabels(THREE, layer) {
  const pool = [];
  const v = new THREE.Vector3();
  const vc = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  function el(i) {
    if (pool[i]) return pool[i];
    const root = document.createElement('div');
    root.className = 'flh-label';
    root.innerHTML = '<i class="flh-lead"></i><i class="flh-ret"></i><div class="flh-ltext"><span class="nm"></span><span class="sb"></span></div>';
    layer.appendChild(root);
    const o = { root, lead: root.children[0], ret: root.children[1], text: root.children[2], nm: root.querySelector('.nm'), sb: root.querySelector('.sb'), last: {} };
    o.root.style.opacity = '0';
    pool[i] = o;
    return o;
  }
  function setText(o, name, sub) {
    if (o.last.name !== name) o.nm.textContent = o.last.name = name;
    if (o.last.sub !== sub) {
      o.sb.textContent = o.last.sub = sub || '';
      o.sb.style.display = sub ? '' : 'none';
    }
  }
  // cached style writes: key -> [element, property]
  const MAP = { tf: ['root', 'transform'], op: ['root', 'opacity'], rt: ['ret', 'transform'], ld: ['lead', 'transform'], lw: ['lead', 'width'], tx: ['text', 'transform'] };
  const css = (o, k, val) => {
    if (o.last[k] === val) return;
    o.last[k] = val;
    o[MAP[k][0]].style[MAP[k][1]] = val;
  };

  /**
   * items: [{ name, sub, pos (universe Vector3), radius, ownId, alpha, priority? }]
   * occluders: [{ id, pos (universe), radius }]
   * avoid: screen rects [{ x, y, w, h, a }] of visible HUD text (a = how visible, 0..1)
   * matte: height in px of the letterbox bars currently covering the top and bottom of the picture
   * opts: { u (HUD unit), inset (safe-area px), lum(x, y) -> 0..1 brightness behind a point }
   */
  function update(items, camera, camU, W, H, occluders, avoid, globalAlpha, matte = 0, opts = {}) {
    const u = opts.u || 1;
    const inset = opts.inset ?? 8;
    camera.updateMatrixWorld();
    const fovY = (camera.fov * Math.PI) / 180;
    const fpx = H / 2 / Math.tan(fovY / 2);
    const PAD = 4 * u;

    // every disc on screen wider than 4 px: names and leaders keep off it
    const discs = [];
    for (const oc of occluders) {
      v.copy(oc.pos).sub(camU);
      const d = v.length();
      if (!(d > oc.radius * 1.0001)) continue;
      vc.copy(v).applyMatrix4(camera.matrixWorldInverse);
      if (vc.z > -1e-9) continue;
      const rpx = fpx * Math.tan(Math.min(1.45, Math.asin(Math.min(1, oc.radius / d))));
      if (rpx < 2) continue;
      tmp.copy(v).project(camera);
      const x = (tmp.x * 0.5 + 0.5) * W, y = (-tmp.y * 0.5 + 0.5) * H;
      if (x < -rpx || y < -rpx || x > W + rpx || y > H + rpx) continue;
      discs.push({ x, y, r: rpx + 3 * u, id: oc.id });
    }
    const blocks = avoid.filter((q) => q && q.a > 0.04).map((q) => ({ x: q.x - 6 * u, y: q.y - 6 * u, w: q.w + 12 * u, h: q.h + 12 * u, a: q.a }));

    const vis = [];
    const why = (update.why = {});
    items.forEach((it, order) => {
      if (!(it.alpha > 0.002) || globalAlpha <= 0.002) return;
      v.copy(it.pos).sub(camU);
      const dist = v.length();
      if (!(dist > 0)) return;
      vc.copy(v).applyMatrix4(camera.matrixWorldInverse);
      if (vc.z > -1e-9) return void (why.behind = (why.behind || 0) + 1);
      tmp.copy(v).project(camera);
      if (Math.abs(tmp.x) > 1.08 || Math.abs(tmp.y) > 1.08) return void (why.off = (why.off || 0) + 1);
      const sx = (tmp.x * 0.5 + 0.5) * W, sy = (-tmp.y * 0.5 + 0.5) * H;
      // a point outside the picture (or behind the letterbox matte) gets no label; near the edge it fades, so a
      // point that grazes the frame for a moment never flashes a name with a leader running off screen
      const edge = Math.min(sx - inset * 0.5, W - inset * 0.5 - sx, sy - matte - 2, H - matte - 2 - sy);
      if (edge <= 0) return void (why.edge = (why.edge || 0) + 1);
      const edgeA = smoothstep(0, 30 * u, edge);
      const dx = v.x / dist, dy = v.y / dist, dz = v.z / dist;
      for (const oc of occluders) {
        if (oc.id === it.ownId) continue;
        const cx = oc.pos.x - camU.x, cy = oc.pos.y - camU.y, cz = oc.pos.z - camU.z;
        const b = cx * dx + cy * dy + cz * dz;
        if (b <= 0 || b >= dist) continue;
        if (cx * cx + cy * cy + cz * cz - b * b < oc.radius * oc.radius) return void (why.occ = (why.occ || 0) + 1);
      }
      const rpx = it.radius ? fpx * Math.tan(Math.min(1.45, Math.asin(Math.min(1, it.radius / Math.max(dist, it.radius * 1.0001))))) : 0;
      if (rpx > Math.min(W, H) * 0.22) return void (why.big = (why.big || 0) + 1); // the body fills the view: no label needed
      // a point whose reticle (ticks included) would touch visible HUD text fades out with that text
      const m = Math.max(6.5 * u, rpx + 5 * u) + 6 * u;
      let under = 0;
      for (const q of blocks) if (sx > q.x - m && sx < q.x + q.w + m && sy > q.y - m && sy < q.y + q.h + m) under = Math.max(under, q.a);
      const alpha = Math.min(1, it.alpha) * globalAlpha * (1 - under) * edgeA;
      if (alpha <= 0.004) return void (why.faded = (why.faded || 0) + 1);
      vis.push({ it, order, sx, sy, rpx, rr: Math.max(6.5 * u, rpx + 5 * u), alpha });
    });
    // reticles shrink when points crowd; crowded names fan out away from their cluster, always on a leader
    for (const a of vis) {
      let nn = Infinity, cx = a.sx, cy = a.sy, k = 1;
      for (const b of vis) {
        if (a === b) continue;
        const d = Math.hypot(a.sx - b.sx, a.sy - b.sy);
        nn = Math.min(nn, d);
        if (d < 40 * u) {
          cx += b.sx;
          cy += b.sy;
          k++;
        }
      }
      if (nn < 2 * a.rr + 3) a.rr = Math.max(2.5 * u, Math.min(a.rr, nn / 2 - 1.5));
      a.crowded = k > 1;
      if (a.crowded) {
        cx /= k;
        cy /= k;
        const dx = a.sx - cx, dy = a.sy - cy;
        const pref = Math.hypot(dx, dy) > 0.5 ? Math.atan2(dy, dx) : -Math.PI / 2;
        const wrap = (x) => Math.abs(Math.atan2(Math.sin(x), Math.cos(x)));
        a.angles = [...ANGLES].sort((p, q) => wrap(p - pref) - wrap(q - pref));
      } else a.angles = ANGLES;
    }
    // every reticle is an obstacle for every name
    const placed = vis.map((p) => ({ x: p.sx - p.rr - 2, y: p.sy - p.rr - 2, w: 2 * p.rr + 4, h: 2 * p.rr + 4, own: p }));
    const sorted = [...vis].sort((a, b) => (b.it.priority ?? (b.it.sub ? 1 : 0)) - (a.it.priority ?? (a.it.sub ? 1 : 0)) || a.order - b.order);
    const top = Math.max(inset, matte + 4 * u), bot = H - Math.max(inset, matte + 4 * u);

    const leaders = [];
    const boxOf = (it) => ({ tw: Math.max(it.name.length * 8.7, (it.sub || '').length * 5.6) * u + 2, th: (it.sub ? 24 : 11) * u });
    // Callout column. Points inside the Sun's glare (the inner planets seen from the edge of the system) cannot
    // carry a name beside them: they are listed just outside the glare in a stacked column, in order of distance
    // from the Sun, each on a hairline leader from its point (a planetarium chart's legend).
    const column = new Map();
    const G = opts.glare;
    if (G) {
      const mem = vis.filter((p) => Math.hypot(p.sx - G.x, p.sy - G.y) < G.r * 0.92);
      if (mem.length >= 3) {
        const lh = 19 * u, gap = 12 * u;
        const memSet = new Set(mem);
        // heliocentric order reads as a legend (The Sun, Mercury, Venus ...); if its leaders would cross, the
        // order of the points down the screen is used instead (leaders then fan out without crossing)
        const helio = [...mem].sort((a, b) => a.it.pos.length() - b.it.pos.length());
        // (the Sun, at the glare's centre, stays at the foot of the column: the order of the others then only changes
        // when their points really pass each other on screen)
        const isSun = (p) => p.it.ownId === 'sun';
        const byY = [...mem].sort((a, b) => isSun(a) - isSun(b) || a.sy - b.sy);
        let best = null;
        for (const [oi, list] of [helio, byY].entries()) {
          const boxes = list.map((p) => boxOf(p.it));
          const colH = list.length * lh;
          for (const side of [1, -1])
            for (const k of [0, -0.6, 0.6, -1.2, 1.2]) {
              // the column's near edge just outside the glare circle at the column's own height
              const y0 = G.y - colH / 2 + k * colH;
              const dyMin = y0 > G.y ? y0 - G.y : y0 + colH < G.y ? G.y - (y0 + colH) : 0;
              const half = dyMin < G.r ? Math.sqrt(G.r * G.r - dyMin * dyMin) : 0;
              const xEdge = G.x + side * (Math.max(half * 0.8, 0.55 * G.r) + gap);
              const rows = list.map((p, i) => {
                const { tw, th } = boxes[i];
                const x = side > 0 ? xEdge : xEdge - tw;
                const y = y0 + i * lh + (lh - th) / 2;
                return { p, x, y, tw, th, ax: side > 0 ? x - 5 * u : x + tw + 5 * u, ay: y + th / 2, r: { x: x - PAD, y: y - PAD, w: tw + 2 * PAD, h: th + 2 * PAD } };
              });
              let ok = true, cost = Math.abs(k) * 10 + (side < 0 ? 4 : 0) + oi * 3;
              for (const R of rows) {
                const r = R.r;
                if (r.x < inset || r.y < top || r.x + r.w > W - inset || r.y + r.h > bot) ok = false;
                for (const q of placed) if (!memSet.has(q.own) && overlap(r, q)) ok = false;
                for (const q of blocks) if (overlap(r, q)) ok = false;
                for (const d of discs) if (rectCircle(r, d.x, d.y, d.r)) ok = false;
                if (rectCircle(r, G.x, G.y, G.r * 0.7)) ok = false;
                if (!ok) break;
                // leaders: off text blocks and other reticles
                for (const q of blocks) if (segRect(R.p.sx, R.p.sy, R.ax, R.ay, q)) ok = false;
                for (const q of placed) if (!memSet.has(q.own) && segRect(R.p.sx, R.p.sy, R.ax, R.ay, q)) ok = false;
                cost += Math.hypot(R.ax - R.p.sx, R.ay - R.p.sy) / u / 40;
              }
              if (!ok) continue;
              // ... and, as far as possible, never crossing each other
              for (let i = 0; i < rows.length; i++)
                for (let j = i + 1; j < rows.length; j++)
                  if (segX(rows[i].p.sx, rows[i].p.sy, rows[i].ax, rows[i].ay, rows[j].p.sx, rows[j].p.sy, rows[j].ax, rows[j].ay)) cost += 8;
              if (!best || cost < best.cost) best = { cost, rows, side };
            }
        }
        if (best)
          for (const R of best.rows) {
            column.set(R.p, R);
            R.p.rr = 2.4 * u; // a small ringed dot at the point (a full reticle would only be a white blob in the glare)
            placed.push({ ...R.r, own: R.p });
            leaders.push([R.p.sx, R.p.sy, R.ax, R.ay]);
          }
      }
    }
    let n = 0;
    for (const p of sorted) {
      const { it, sx, sy, rr } = p;
      const o = el(n++);
      setText(o, it.name, it.sub);
      // text box estimate (uppercase 10px tracked .24em ~ 8.7 px/glyph; sub 9.5px ~ 5.6 px/glyph)
      const { tw, th } = boxOf(it);
      let pick = null;
      const C = column.get(p);
      if (C) {
        const a = Math.atan2(C.ay - sy, C.ax - sx), R = Math.hypot(C.ax - sx, C.ay - sy);
        pick = { x: C.x, y: C.y, a, R: R + 4 * u, left: C.ax > C.x, r: C.r, lead: R > rr + 6 * u ? [sx, sy, C.ax, C.ay] : null };
      }
      const g0 = rr + (rr >= 5 * u ? 11 : 6) * u; // clear the reticle's tick marks
      const rings = (p.crowded ? [22, 40, 64, 96, 136] : [0, 24, 52, 86, 126]).map((k) => g0 + k * u);
      const ownDisc = discs.find((d) => d.id === it.ownId);
      // score every free candidate: short leaders, preferred directions, and room around other points
      let best = Infinity;
      if (!C) rings.forEach((R, ri) => {
        p.angles.forEach((a, ai) => {
          const ax = sx + Math.cos(a) * R, ay = sy + Math.sin(a) * R;
          const left = Math.cos(a) < -0.2;
          const x = left ? ax - tw : Math.abs(Math.cos(a)) <= 0.2 ? ax - tw / 2 : ax;
          const y = Math.abs(Math.sin(a)) < 0.3 ? ay - th / 2 : Math.sin(a) < 0 ? ay - th : ay;
          const r = { x: x - PAD, y: y - PAD, w: tw + 2 * PAD, h: th + 2 * PAD };
          // inside the safe area, off every reticle / name / text block / disc
          if (r.x < inset || r.y < top || r.x + r.w > W - inset || r.y + r.h > bot) return;
          for (const q of placed) if (q.own !== p && overlap(r, q)) return;
          for (const q of blocks) if (overlap(r, q)) return;
          for (const d of discs) if (d !== ownDisc && rectCircle(r, d.x, d.y, d.r)) return;
          if (opts.glare && rectCircle(r, opts.glare.x, opts.glare.y, opts.glare.r)) return; // never in the Sun's glare
          // the name must read as this point's: never nearer to another disc (or, without a leader, to another
          // point) than to its own point
          const ncx = r.x + r.w / 2, ncy = r.y + r.h / 2;
          const dOwn = Math.hypot(ncx - sx, ncy - sy);
          for (const d of discs) if (d !== ownDisc && Math.hypot(ncx - d.x, ncy - d.y) - d.r - 6 * u < dOwn) return;
          let lead = null;
          if (R > g0 + 1) {
            // the leader may not pass through another reticle, name, text block or disc, nor cross another leader
            const x0 = sx + Math.cos(a) * (rr + 2), y0 = sy + Math.sin(a) * (rr + 2);
            for (const q of placed) if (q.own !== p && segRect(x0, y0, ax, ay, q)) return;
            for (const q of blocks) if (segRect(x0, y0, ax, ay, q)) return;
            for (const d of discs) if (d !== ownDisc && segCircle(x0, y0, ax, ay, d.x, d.y, d.r)) return;
            for (const L of leaders) if (segX(x0, y0, ax, ay, L[0], L[1], L[2], L[3])) return;
            lead = [x0, y0, ax, ay];
          } else for (const q of vis) if (q !== p && Math.hypot(ncx - q.sx, ncy - q.sy) < dOwn) return;
          let cost = (R - g0) / u * 0.9 + ai * 2.5 + ri * 4;
          for (const q of vis) {
            if (q === p) continue;
            const dx = Math.max(r.x - q.sx, 0, q.sx - (r.x + r.w)), dy = Math.max(r.y - q.sy, 0, q.sy - (r.y + r.h));
            const dd = Math.hypot(dx, dy) / u;
            if (dd < 26) cost += (26 - dd) * 3;
          }
          // a name never sits in glare or on a lit limb (the Sun's own name goes outside its glare, on a leader)
          if (cost < best && !(opts.lum && opts.lum(ncx, ncy) > 0.42)) {
            best = cost;
            pick = { x, y, a, R, left, r, lead };
          }
        });
      });
      css(o, 'tf', `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`);
      css(o, 'op', p.alpha.toFixed(3));
      const d = (2 * rr).toFixed(1) + 'px';
      if (o.last.col !== !!C) o.root.classList.toggle('col', (o.last.col = !!C));
      if (o.last.d !== d) {
        o.ret.style.width = o.ret.style.height = o.last.d = d;
        o.ret.classList.toggle('sm', rr < 5 * u);
      }
      css(o, 'rt', `translate(${(-rr).toFixed(1)}px, ${(-rr).toFixed(1)}px)`);
      if (pick) {
        if (!C) placed.push(pick.r);
        o.text.style.visibility = '';
        if (o.last.left !== pick.left) o.text.classList.toggle('left', (o.last.left = pick.left));
        css(o, 'tx', `translate(${(pick.x - sx).toFixed(1)}px, ${(pick.y - sy).toFixed(1)}px)`);
        o.text.style.width = pick.left ? tw.toFixed(0) + 'px' : '';
        // a stronger halo where the name sits on something bright (glare, a lit limb)
        if (opts.lum) {
          const hk = (Math.round(Math.min(1, opts.lum(pick.x + tw / 2, pick.y + th / 2) * 1.6) * 5) / 5).toFixed(1);
          if (o.last.halo !== hk) o.root.style.setProperty('--halo', (o.last.halo = hk));
        }
        if (pick.lead) {
          if (!C) leaders.push(pick.lead);
          // hairline leader from the reticle edge to the name
          const L = pick.R - rr - 4 * u;
          o.lead.style.display = '';
          css(o, 'lw', L.toFixed(1) + 'px');
          css(o, 'ld', `rotate(${pick.a.toFixed(4)}rad) translateX(${(rr + 2).toFixed(1)}px)`);
        } else o.lead.style.display = 'none';
      } else {
        o.text.style.visibility = 'hidden';
        o.lead.style.display = 'none';
      }
    }
    for (let i = n; i < pool.length; i++) if (pool[i].last.op !== '0') css(pool[i], 'op', '0');
    return n;
  }

  return { update, get why() { return update.why; } };
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
// do segments p1-p2 and p3-p4 properly intersect?
function segX(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d1 = d(x3, y3, x4, y4, x1, y1), d2 = d(x3, y3, x4, y4, x2, y2), d3 = d(x1, y1, x2, y2, x3, y3), d4 = d(x1, y1, x2, y2, x4, y4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
// does segment p1-p2 touch rect r? (Liang–Barsky clip)
function segRect(x1, y1, x2, y2, r) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const clip = (p, q) => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, x1 - r.x) && clip(dx, r.x + r.w - x1) && clip(-dy, y1 - r.y) && clip(dy, r.y + r.h - y1) && t0 <= t1;
}
// distance from a segment to a circle centre < radius?
function segCircle(x1, y1, x2, y2, cx, cy, rad) {
  const dx = x2 - x1, dy = y2 - y1;
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((cx - x1) * dx + (cy - y1) * dy) / L2)) : 0;
  return Math.hypot(x1 + t * dx - cx, y1 + t * dy - cy) < rad;
}
function rectCircle(r, cx, cy, rad) {
  const dx = Math.max(r.x - cx, 0, cx - (r.x + r.w)), dy = Math.max(r.y - cy, 0, cy - (r.y + r.h));
  return dx * dx + dy * dy < rad * rad;
}
function overlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
