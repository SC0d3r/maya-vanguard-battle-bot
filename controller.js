// maya-vanguard — battle.training season 2 controller (v2)
// Original controller. Movement uses per-objective BFS distance fields built in hello(),
// objective assignments are sticky (planned once, never re-ranked), APCs hold the point
// they capture, MBTs fight from range, scouts escort and aim their fixed gun by turning
// the hull, drones orbit for vision. No network, no clock, no model call.
//
// Units are integers; positions and ranges are Q16.16 tiles, angles 4096 = full turn.

const FP = 65536;
const FULL = 4096;
const TAU = Math.PI * 2;

// Draft is map-adaptive: two flank points + centre hill gets two APCs (one per point),
// a forest of two flank points gets one APC plus a drone for vision.
let DRAFT_PAIR = ["apc", "mbt", "drone", "scout"];
let DRAFT_TRIPLE = ["apc", "apc", "mbt", "scout"];

let R, M, SIDE, W, H, PASS, FIELDS, OBJS, SPAWN, ENEMY_SPAWN, HILL;
let ASSIGN = null; // unit id -> objective index, planned once
let sayTick = -9999;

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function idx(x, y) { return y * W + x; }
function tile(v) { return Math.floor(v / FP); }
function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }
function angleTo(ax, ay, bx, by) {
  return Math.round((Math.atan2(by - ay, bx - ax) / TAU) * FULL) & (FULL - 1);
}
function angDiff(a, b) {
  let d = (b - a) & (FULL - 1);
  return d > FULL / 2 ? d - FULL : d;
}
function passTile(x, y) {
  return x >= 0 && y >= 0 && x < W && y < H && PASS[idx(x, y)] === 1;
}

function bfs(sx, sy) {
  const d = new Int32Array(W * H);
  d.fill(-1);
  if (!passTile(sx, sy)) return d;
  const q = new Int32Array(W * H);
  let qh = 0, qt = 0;
  const s = idx(sx, sy);
  d[s] = 0;
  q[qt++] = s;
  while (qh < qt) {
    const cur = q[qh++];
    const cx = cur % W;
    const cy = (cur - cx) / W;
    const nd = d[cur] + 1;
    if (cx > 0) { const n = cur - 1; if (d[n] < 0 && PASS[n]) { d[n] = nd; q[qt++] = n; } }
    if (cx + 1 < W) { const n = cur + 1; if (d[n] < 0 && PASS[n]) { d[n] = nd; q[qt++] = n; } }
    if (cy > 0) { const n = cur - W; if (d[n] < 0 && PASS[n]) { d[n] = nd; q[qt++] = n; } }
    if (cy + 1 < H) { const n = cur + W; if (d[n] < 0 && PASS[n]) { d[n] = nd; q[qt++] = n; } }
  }
  return d;
}

// Distance field from a control point. If the point itself sat on an impassable tile
// (never seen in practice, but cheap insurance) start from the nearest open tile.
function fieldFromObjective(ob) {
  let sx = tile(ob.x), sy = tile(ob.y);
  if (passTile(sx, sy)) return bfs(sx, sy);
  for (let r = 1; r <= 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (passTile(sx + dx, sy + dy)) return bfs(sx + dx, sy + dy);
      }
    }
  }
  return bfs(sx, sy);
}

// One gradient step on a distance field; returns the centre of the best neighbour tile.
function stepToward(u, field) {
  const tx = tile(u.x), ty = tile(u.y);
  if (!passTile(tx, ty)) return null;
  let bestD = field[idx(tx, ty)];
  if (bestD < 0) return null;
  let bx = tx, by = ty;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = tx + dx, ny = ty + dy;
      if (!passTile(nx, ny)) continue;
      if (dx && dy && (!passTile(tx + dx, ty) || !passTile(tx, ty + dy))) continue;
      const v = field[idx(nx, ny)];
      if (v >= 0 && v < bestD) { bestD = v; bx = nx; by = ny; }
    }
  }
  if (bx === tx && by === ty) return null;
  return [(bx + 0.5) * FP, (by + 0.5) * FP];
}

function drive(u, gx, gy, field, stopRadius) {
  const spec = R.units[u.kind];
  const order = { id: u.id };
  const d = dist(u.x, u.y, gx, gy);
  if (d <= stopRadius) { order.throttle = 0; return order; }
  let wx = gx, wy = gy;
  if (field) {
    const p = stepToward(u, field);
    if (p) { wx = p[0]; wy = p[1]; }
  }
  const want = angleTo(u.x, u.y, wx, wy);
  const diff = angDiff(u.heading, want);
  order.steer = clamp(Math.round((diff / spec.turnRate) * FP), -FP, FP);
  order.throttle = Math.abs(diff) > 700 ? Math.round(FP * 0.25) : FP;
  if (u.blocked) {
    order.throttle = -Math.round(FP * 0.55);
    order.steer = Math.round(FP * 0.8);
  }
  return order;
}

// Plan once: which control point each unit owns. APCs take distinct points (the near
// flank and, when there is one, the centre hill). The rest defend the near flank.
function planAssignments(units) {
  ASSIGN = new Map();
  if (!OBJS.length || !units || !units.length) return;
  const order = OBJS.map((o, i) => ({ i, o, d: dist(SPAWN[0], SPAWN[1], o.x, o.y) }))
    .sort((a, b) => a.d - b.d);
  const near = order[0].i;
  let hill = -1;
  for (const x of order) if (x.o.radius >= 5.5 * FP) { hill = x.i; break; }
  const far = order[order.length - 1].i;
  let apcN = 0;
  for (const u of units) {
    if (u.kind === "apc") { ASSIGN.set(u.id, apcN === 0 ? near : (hill >= 0 ? hill : far)); apcN++; }
  }
  for (const u of units) {
    if (ASSIGN.has(u.id)) continue;
    if (u.kind === "scout") ASSIGN.set(u.id, hill >= 0 ? hill : near);
    else ASSIGN.set(u.id, near);
  }
}

function leadPos(c, flightTicks) {
  const a = (c.heading / FULL) * TAU;
  return [c.x + Math.cos(a) * c.speed * flightTicks, c.y + Math.sin(a) * c.speed * flightTicks];
}

function nearestContact(o, u, maxDist) {
  let best = null, bd = maxDist;
  for (const c of o.contacts) {
    const d = dist(u.x, u.y, c.x, c.y);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

function fireDirect(u, c, order, g) {
  const d = dist(u.x, u.y, c.x, c.y);
  if (d > g.maxRange || d < g.minRange) return;
  const ft = Math.max(1, Math.round(d / g.shellSpeed));
  const p = leadPos(c, ft);
  order.aimAt = [Math.round(p[0]), Math.round(p[1])];
  if (u.reload === 0) {
    const err = Math.abs(angDiff(u.turret, angleTo(u.x, u.y, p[0], p[1])));
    if (err <= g.aimTolerance + 2) order.fire = true;
  }
}

function fireMissile(u, c, order, g) {
  const d = dist(u.x, u.y, c.x, c.y);
  order.target = c.id;
  if (u.reload === 0 && d >= g.minRange && d <= g.maxRange && u.lockTicks >= (g.lockTicks || 40)) {
    order.fire = true;
  }
}

function fireArtillery(u, c, order, g) {
  const d = dist(u.x, u.y, c.x, c.y);
  if (u.ammo === 0 || d < g.minRange || d > g.maxRange) return;
  const ft = 40 + d / FP;
  const p = leadPos(c, ft);
  if (u.reload === 0) order.fire = [Math.round(p[0]), Math.round(p[1])];
}

function incomingDanger(o, u) {
  for (const s of o.incoming) {
    const d = dist(u.x, u.y, s.x, s.y);
    if (d < 4.2 * FP && s.ticks > 0) {
      const a = angleTo(s.x, s.y, u.x, u.y);
      const rad = (a / FULL) * TAU;
      return [u.x + Math.cos(rad) * 7 * FP, u.y + Math.sin(rad) * 7 * FP];
    }
  }
  return null;
}

function say(o, text) {
  if (o.tick - sayTick >= R.say.cooldown) { sayTick = o.tick; return text; }
  return undefined;
}

globalThis.controller = {
  draft(h) {
    const d = h.draft;
    if (!d) return undefined;
    const pick = (h.objectives && h.objectives.length >= 3) ? DRAFT_TRIPLE : DRAFT_PAIR;
    const cost = pick.reduce((c, k) => c + (d.costs[k] || 99), 0);
    const legal = cost <= d.budget && pick.length >= d.min && pick.length <= d.max &&
      pick.every(k => d.roster.indexOf(k) >= 0);
    return legal ? pick.slice() : undefined;
  },

  hello(h) {
    R = h.rules;
    M = h.map;
    SIDE = h.side;
    W = M.width;
    H = M.height;
    PASS = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) PASS[i] = (R.terrainSpeed[M.terrain[i]] > 0) ? 1 : 0;
    OBJS = h.objectives || [];
    SPAWN = [M.spawns[SIDE][0] * FP + FP / 2, M.spawns[SIDE][1] * FP + FP / 2];
    ENEMY_SPAWN = [M.spawns[1 - SIDE][0] * FP + FP / 2, M.spawns[1 - SIDE][1] * FP + FP / 2];
    HILL = [Math.floor(W / 2) * FP + FP / 2, Math.floor(H / 2) * FP + FP / 2];
    FIELDS = OBJS.map(fieldFromObjective);
    planAssignments(h.units || []);
  },

  tick(o) {
    if (!ASSIGN || !ASSIGN.size) planAssignments(o.units);
    const orders = [];

    for (const u of o.units) {
      if (!u.alive) continue;
      const spec = R.units[u.kind];
      const order = { id: u.id };
      const dodge = incomingDanger(o, u);

      const tIdx = ASSIGN.has(u.id) ? ASSIGN.get(u.id) : 0;
      const t = OBJS[tIdx] || { x: HILL[0], y: HILL[1], radius: 5 * FP, weight: 1 };
      const tRad = t.radius || 5 * FP;
      const tDist = dist(u.x, u.y, t.x, t.y);
      let field = FIELDS[tIdx] || null;

      const gunRange = (spec.gun && spec.gun.maxRange) || 0;
      const cAny = nearestContact(o, u, Math.max(gunRange, spec.sensorRange || 0));
      const cGun = nearestContact(o, u, gunRange);

      // ---- movement goal: hold the assigned control point ----
      let gx = t.x, gy = t.y, stop = tRad * 0.55;

      if (u.kind === "apc") {
        // The APC owns the point: get inside the radius and stay there. Its turret
        // does the fighting, so it never chases a contact off the point.
        gx = t.x; gy = t.y; stop = tRad * 0.55;
      } else if (u.kind === "mbt") {
        // Stand off the point: the MBT outranges every other ground gun (30 tiles).
        gx = t.x; gy = t.y; stop = 9 * FP;
      } else if (u.kind === "scout") {
        // Escort: sit just inside/at the edge of the point, fast enough to fall back.
        gx = t.x; gy = t.y; stop = Math.max(2 * FP, tRad * 0.8);
      } else if (u.kind === "drone") {
        const a = (o.tick * 0.011) + (u.id % 5) * 1.3;
        gx = t.x + Math.cos(a) * 9 * FP;
        gy = t.y + Math.sin(a) * 9 * FP;
        stop = 0;
        field = null;
      } else if (u.kind === "artillery" || u.kind === "missile") {
        const a = angleTo(t.x, t.y, SPAWN[0], SPAWN[1]);
        const rad = (a / FULL) * TAU;
        const keep = u.kind === "artillery" ? 24 * FP : 14 * FP;
        gx = t.x + Math.cos(rad) * keep;
        gy = t.y + Math.sin(rad) * keep;
        field = null;
        stop = 4 * FP;
        if (u.ammo === 0) { gx = SPAWN[0]; gy = SPAWN[1]; field = null; stop = 2 * FP; }
      } else if (u.kind === "engineer") {
        gx = t.x; gy = t.y; stop = tRad * 1.1;
        if (cAny && dist(u.x, u.y, cAny.x, cAny.y) < 9 * FP && u.charges && u.charges.smoke > 0) {
          order.ability = "smoke";
        }
      }

      // ---- combat movement ----
      // MBT: keep 12-14 tiles, which is inside its 30-tile gun range but outside an
      // APC (14) or scout (18) knife range. Scout: kite at 12-14 tiles and let the
      // hull point, because its gun is fixed to the hull.
      if (cGun && (u.kind === "mbt" || u.kind === "scout")) {
        const d = dist(u.x, u.y, cGun.x, cGun.y);
        if (u.kind === "mbt") {
          if (d < 10 * FP) {
            const a = angleTo(cGun.x, cGun.y, u.x, u.y);
            const rad = (a / FULL) * TAU;
            gx = u.x + Math.cos(rad) * 9 * FP;
            gy = u.y + Math.sin(rad) * 9 * FP;
            field = null; stop = 0;
          } else {
            gx = cGun.x; gy = cGun.y; field = null; stop = 13 * FP;
          }
        } else {
          // scout: do not chase far from the point it is escorting
          if (tDist < 20 * FP) {
            if (d < 9 * FP) {
              const a = angleTo(cGun.x, cGun.y, u.x, u.y);
              const rad = (a / FULL) * TAU;
              gx = u.x + Math.cos(rad) * 8 * FP;
              gy = u.y + Math.sin(rad) * 8 * FP;
              field = null; stop = 0;
            } else if (d > 14 * FP) {
              gx = cGun.x; gy = cGun.y; field = null; stop = 13 * FP;
            } else {
              gx = cGun.x; gy = cGun.y; field = null; stop = d;
            }
          }
        }
      }

      // artillery and missiles keep their distance
      if ((u.kind === "artillery" || u.kind === "missile") && cAny) {
        const d = dist(u.x, u.y, cAny.x, cAny.y);
        const minKeep = u.kind === "artillery" ? 12 * FP : 8 * FP;
        if (d < minKeep) {
          const a = angleTo(cAny.x, cAny.y, u.x, u.y);
          const rad = (a / FULL) * TAU;
          gx = u.x + Math.cos(rad) * 10 * FP; gy = u.y + Math.sin(rad) * 10 * FP;
          field = null; stop = 0;
        }
      }
      if (dodge) { gx = dodge[0]; gy = dodge[1]; field = null; stop = 0; }

      if (o.canMove) {
        const mv = drive(u, gx, gy, field, stop);
        if (mv.steer !== undefined) order.steer = mv.steer;
        if (mv.throttle !== undefined) order.throttle = mv.throttle;
      }

      // ---- weapons ----
      if (u.kind === "drone") {
        // no gun; stay high and away from threats
        if (cAny && dist(u.x, u.y, cAny.x, cAny.y) < 9 * FP) {
          const a = angleTo(cAny.x, cAny.y, u.x, u.y);
          order.steer = clamp(Math.round((angDiff(u.heading, a) / spec.turnRate) * FP), -FP, FP);
          order.throttle = FP;
        }
      } else if (spec.secondary && u.kind === "engineer" && cAny) {
        const d = dist(u.x, u.y, cAny.x, cAny.y);
        if (d <= spec.secondary.maxRange && u.reload2 === 0) {
          const p = leadPos(cAny, Math.max(1, Math.round(d / spec.secondary.shellSpeed)));
          order.aimAt = [Math.round(p[0]), Math.round(p[1])];
          if (Math.abs(angDiff(u.turret, angleTo(u.x, u.y, p[0], p[1]))) <= spec.secondary.aimTolerance) order.fire = true;
        }
      } else if (spec.gun && spec.gun.mode === "indirect" && cGun) {
        fireArtillery(u, cGun, order, spec.gun);
      } else if (spec.gun && spec.gun.mode === "direct" && cGun) {
        if (spec.gun.lockTicks) fireMissile(u, cGun, order, spec.gun);
        else fireDirect(u, cGun, order, spec.gun);
      }

      // Fixed guns ride the hull: turn the tank onto the target so the shot can fire.
      if (spec.fixedGun && cGun && spec.gun && u.reload === 0 && u.kind !== "drone") {
        const d = dist(u.x, u.y, cGun.x, cGun.y);
        if (d >= spec.gun.minRange && d <= gunRange) {
          const p = leadPos(cGun, Math.max(1, Math.round(d / spec.gun.shellSpeed)));
          const want = angleTo(u.x, u.y, p[0], p[1]);
          const diff = angDiff(u.heading, want);
          order.steer = clamp(Math.round((diff / spec.turnRate) * FP), -FP, FP);
          if (Math.abs(diff) < 260) order.throttle = 0;
        }
      }

      orders.push(order);
    }

    const out = { units: orders };
    const lead = o.score[0] >= o.score[1];
    const s = say(o, lead ? "holding the line" : "pressing the point");
    if (s) out.say = s;
    return out;
  },
};
