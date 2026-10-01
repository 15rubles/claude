'use strict';
// ============================================================
//  Colony.io world simulation (runs on the server).
//  Ported from the single-player game: the same rules, AI, events and
//  creatures, but any number of human colonies, driven by network input.
// ============================================================
const S = require('../shared/constants.js');
const {
  TAU, WORLD_W, WORLD_H, QUEEN_R, WORKER_R, PLAYER_SPEED, AI_SPEED, AI_FLEE_SPEED, SPAWN_GRACE,
  WORKER_SPEED, CHARGE_SPEED, CHARGE_TIME, PLAYER_CHARGE_CD, AI_CHARGE_CD, RING0, RING_GAP, RING_SPACING,
  FOOD_MAX, FOOD_RESPAWN_RATE, FOOD_PER_WORKER, MAX_WORKERS, START_ENEMIES, MAX_ENEMIES, SKINS,
  SEP_DIST, FIGHT_DIST, CELL, POWERUP_MAX, FRENZY_TIME, RUSH_TIME, RUSH_SPEED, FRENZY_POWER,
  GARDEN_R, GARDEN_RATE, HOLE_R, TUNNEL_CD, POWER_INFO, GCOLS, GROWS, PALETTE,
  STREAK_WINDOW, STREAK_NAMES, MILESTONES, RAIN_TIME, RAIN_SLOW, PUDDLE_SLOW, DIFFS, STRIKE_RANGE, COMPASS, EVENT_TYPES,
} = S;

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
function lerpAngle(a, b, t) {
  const d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return a + d * t;
}
function shade(hex, amt) {
  let r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  if (amt < 0) { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; } else { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function createWorld(diffKey = 'normal') {
  const D = DIFFS[diffKey] || DIFFS.normal;
  let colonies = [], food = [], uid = 1, time = 0, spawnTimer = 10, foodAccum = 0;
  let powerups = [], gardens = [], tunnels = [], rocks = [], puddles = [];
  let powerTimer = 5, mapVersion = 1;
  let eventTimer = 60, raining = 0, quakeTime = 0, picnic = null, lastEvent = '';
  let creatures = [], creatureTimer = 30, bossTimer = 300;
  let magnifier = null, flood = null, migration = null, golden = null;
  let nightT = 0, bloodMoon = 0, sugarRain = 0, sugarRainT = 0;
  const antGrid = Array.from({ length: GCOLS * GROWS }, () => []);
  const foodGrid = Array.from({ length: GCOLS * GROWS }, () => []);
  // which colony occupies each grid cell (0 = empty, -1 = more than one): lets calm ants skip work
  const cellOwner = new Int32Array(GCOLS * GROWS);
  let stepNo = 0;
  let events = [];   // visual events for every client since the last snapshot

  // ---------- event helpers ----------
  const fx = e => { events.push(e); if (events.length > 200) events.shift(); };
  function personal(c, e) { if (c && c.session) c.session.out.push(e); }
  function sfx(c, name) { if (c && c.session) c.session.sfx.add(name); }
  function lifeAdd(c, key, n = 1) { if (c && c.session) c.session.life[key] = (c.session.life[key] || 0) + n; }
  function lifeMax(c, key, v) { if (c && c.session) c.session.lifeMax[key] = Math.max(c.session.lifeMax[key] || 0, v); }
  const banner = (c, text, sub, color, life = 2.2, size = 44) => personal(c, { t: 'banner', text, sub, color, life, size });
  const bannerAll = (text, sub, color, life = 2.2, size = 44) => fx({ t: 'banner', text, sub, color, life, size });
  const humans = () => colonies.filter(c => c.alive && c.human);

  // ============================================================
  //  Entity creation
  // ============================================================
  function makeColony(x, y, workers, name, color, human) {
    const c = {
      id: uid++, name, color, human, session: null, skinId: '', crownColor: '', crownLevel: 0,
      dark: shade(color, color === '#26262b' ? -0.6 : -0.5),
      alive: true, food: 0, births: 0, grace: 0, frenzy: 0, rush: 0, tunnelCd: 3,
      charge: 0, chargeCd: rand(0, 2), chargeX: x, chargeY: y, chargeHit: false,
      input: { x, y }, st: null,
      workers: [],
      queen: { x, y, vx: 0, vy: 0, ang: rand(0, TAU), walk: 0 }, outerR: RING0,
      ai: { mode: 'wander', target: null, food: null, think: 0, react: rand(0, 0.2), wx: x, wy: y,
            chargeTarget: null, aggro: rand(0.7, 1.1) * (human ? 1 : D.aggro), orbit: Math.random() < 0.5 ? -1 : 1,
            likesFarm: Math.random() < 0.5, power: null, garden: null },
    };
    for (let i = 0; i < workers; i++) addWorker(c, x + rand(-30, 30), y + rand(-30, 30));
    return c;
  }
  function addWorker(c, x, y) {
    const a = rand(0, TAU), r = Math.sqrt(Math.random());
    c.workers.push({
      id: uid++, col: c,
      x: clamp(x, 5, WORLD_W - 5), y: clamp(y, 5, WORLD_H - 5),
      vx: 0, vy: 0, ang: rand(0, TAU), walk: rand(0, 10),
      ox: Math.cos(a) * r, oy: Math.sin(a) * r, jit: rand(0, TAU),
      sx: 0, sy: 0, fx: 0, fy: 0, ex: 0, ey: 0, ed: Infinity,
      fightCd: 0, dead: false,
    });
  }
  function spawnFood(x, y) {
    if (x === undefined) {
      for (let t = 0; t < 6; t++) { x = rand(20, WORLD_W - 20); y = rand(20, WORLD_H - 20); if (!inRock(x, y, 6)) break; }
    } else if (inRock(x, y, 4)) return;
    food.push({ id: uid++, x, y, r: rand(2.6, 4.2), dead: false });
  }
  function pickPalette() {
    const used = new Set(colonies.filter(c => c.alive).map(c => c.color));
    const free = PALETTE.filter(p => !used.has(p.color));
    const src = free.length ? free : PALETTE;
    return src[randInt(0, src.length - 1)];
  }
  function findSpawnPos(minFromHuman, minFromQueens) {
    let best = null, bestScore = -1;
    for (let t = 0; t < 80; t++) {
      const x = rand(180, WORLD_W - 180), y = rand(180, WORLD_H - 180);
      if (inRock(x, y, 70)) continue;
      let score = Infinity;
      for (const c of colonies) {
        if (!c.alive) continue;
        score = Math.min(score, dist(x, y, c.queen.x, c.queen.y) / (c.human ? minFromHuman : minFromQueens));
      }
      if (score >= 1) return { x, y };
      if (score > bestScore) { bestScore = score; best = { x, y }; }
    }
    return best || { x: WORLD_W / 2, y: WORLD_H / 2 };
  }
  function spawnEnemy(size) {
    const p = findSpawnPos(900, 380);
    const pal = pickPalette();
    const c = makeColony(p.x, p.y, size, pal.name, pal.color, false);
    c.grace = SPAWN_GRACE;
    colonies.push(c);
    fx({ t: 'ring', x: p.x, y: p.y, color: pal.color, life: 1.5, r: 80 });
    fx({ t: 'text', text: `${pal.name} has emerged!`, x: p.x, y: p.y - 40, color: pal.color, life: 2.5, size: 18 });
    return c;
  }
  function enemyCount() { let n = 0; for (const c of colonies) if (c.alive && !c.human) n++; return n; }
  const colonySize = c => c.workers.length;

  // ============================================================
  //  World setup
  // ============================================================
  function resetWorld() {
    colonies = []; food = []; time = 0; foodAccum = 0;
    placeStructures();
    powerups = []; powerTimer = 3;
    eventTimer = rand(55, 75);
    for (let i = 0; i < 2; i++) spawnPowerup();
    for (let i = 0; i < FOOD_MAX; i++) spawnFood();
    const sizes = [3, 30];
    while (sizes.length < START_ENEMIES) sizes.push(randInt(4, 26));
    for (const s of sizes) {
      const p = findSpawnPos(700, 450);
      const pal = pickPalette();
      colonies.push(makeColony(p.x, p.y, Math.max(3, Math.round(s * D.startSize)), pal.name, pal.color, false));
    }
    spawnTimer = rand(3, 7);
  }

  // a human joins (or respawns): returns the new colony
  function addHuman(session, name, skinId, crownColor) {
    const skin = SKINS.find(k => k.id === skinId) || SKINS[0];
    const p = findSpawnPos(800, 420);
    const c = makeColony(p.x, p.y, 5, name, skin.color, true);
    c.skinId = skin.id; c.crownColor = crownColor || '#ffd700';
    c.chargeCd = 0; c.grace = D.grace; c.tunnelCd = 3;
    c.session = session; c.input = { x: p.x, y: p.y };
    c.st = { kills: 0, streak: 0, bestStreak: 0, lastConquer: -99, charges: 0, milestone: 0, start: time, peak: 5 };
    colonies.push(c);
    fx({ t: 'ring', x: p.x, y: p.y, color: skin.color, life: 1.5, r: 80 });
    return c;
  }
  // a human leaves mid-game: the colony goes wild and is run by the AI from now on
  function releaseHuman(c) {
    if (!c) return;
    c.session = null;
    if (!c.alive) return;
    c.human = false; c.ai.aggro = rand(0.7, 1.1) * D.aggro; c.ai.think = 0;
  }
  function humanCharge(c, x, y) {
    if (!c || !c.alive || c.chargeCd > 0 || c.charge > 0) return;
    startCharge(c, clamp(+x || 0, 0, WORLD_W), clamp(+y || 0, 0, WORLD_H));
  }
  function startCharge(c, x, y) {
    c.chargeHit = false;
    if (c.human) { lifeAdd(c, 'charges'); c.st.charges++; sfx(c, 'charge'); }
    else fx({ t: 'sfx', name: 'charge', x: c.queen.x, y: c.queen.y, vol: 0.5 });
    c.charge = CHARGE_TIME;
    c.chargeX = x; c.chargeY = y;
  }

  // ============================================================
  //  Queen movement
  // ============================================================
  function steerQueen(q, tvx, tvy, dt, resp) {
    const ts = Math.hypot(tvx, tvy);
    if (ts > 1) {
      for (const r of rocks) {
        const dx = r.x - q.x, dy = r.y - q.y, d = Math.hypot(dx, dy), clear = r.r + QUEEN_R + 45;
        if (d > clear || d < 1 || (dx * tvx + dy * tvy) / (d * ts) < 0.25) continue;
        const side = dx * tvy - dy * tvx > 0 ? 1 : -1;
        const w = 0.4 + (1 - d / clear) * 1.6;
        tvx += -dy / d * side * ts * w; tvy += dx / d * side * ts * w;
        const n = Math.hypot(tvx, tvy); tvx = tvx / n * ts; tvy = tvy / n * ts;
      }
    }
    const k = 1 - Math.exp(-resp * dt);
    q.vx += (tvx - q.vx) * k;
    q.vy += (tvy - q.vy) * k;
    const tf = terrainFactor(q.x, q.y);
    q.x += q.vx * dt * tf; q.y += q.vy * dt * tf;
    if (rocks.length) pushOutOfRocks(q, QUEEN_R);
    if (q.x < QUEEN_R) { q.x = QUEEN_R; q.vx = 0; }
    if (q.x > WORLD_W - QUEEN_R) { q.x = WORLD_W - QUEEN_R; q.vx = 0; }
    if (q.y < QUEEN_R) { q.y = QUEEN_R; q.vy = 0; }
    if (q.y > WORLD_H - QUEEN_R) { q.y = WORLD_H - QUEEN_R; q.vy = 0; }
    const s = Math.hypot(q.vx, q.vy);
    if (s > 6) q.ang = lerpAngle(q.ang, Math.atan2(q.vy, q.vx), 1 - Math.exp(-10 * dt));
    q.walk += s * dt * 0.13;
  }
  function updateHuman(c, dt) {
    const q = c.queen, m = c.input;
    const dx = m.x - q.x, dy = m.y - q.y, d = Math.hypot(dx, dy);
    const sp = Math.min(PLAYER_SPEED * speedFactor(c), Math.max(0, d - 4) * 3);
    steerQueen(q, d > 1 ? dx / d * sp : 0, d > 1 ? dy / d * sp : 0, dt, 7);
    if (c.charge > 0) { c.chargeX = m.x; c.chargeY = m.y; }
  }

  // ============================================================
  //  AI
  // ============================================================
  function blockersOnPath(fromQ, o) {
    const tq = o.queen;
    const sx = tq.x - fromQ.x, sy = tq.y - fromQ.y, L2 = sx * sx + sy * sy || 1;
    let n = 0;
    for (const w of o.workers) {
      const dq = (w.x - tq.x) ** 2 + (w.y - tq.y) ** 2;
      if (dq < 28 * 28) { n++; continue; }
      const t = clamp(((w.x - fromQ.x) * sx + (w.y - fromQ.y) * sy) / L2, 0, 1);
      const px = fromQ.x + sx * t, py = fromQ.y + sy * t;
      if ((w.x - px) ** 2 + (w.y - py) ** 2 < 18 * 18) n++;
    }
    return n;
  }
  function aiStrike(c) {
    if (c.charge > 0 || c.chargeCd > 0 || c.workers.length < 2) return false;
    const q = c.queen, my = c.workers.length;
    let best = null, bestOdds = 0;
    for (const o of colonies) {
      if (o === c || !o.alive || o.grace > 0) continue;
      const tq = o.queen, d = dist(q.x, q.y, tq.x, tq.y);
      if (d > STRIKE_RANGE) continue;
      const blockers = blockersOnPath(q, o);
      let odds = my * c.ai.aggro * (1.5 - d / STRIKE_RANGE) / (2.5 * blockers + 2);
      if (o.charge > 0) odds *= 1.25;
      if (colonySize(o) > my && d < 200) odds *= 1.3;
      if (o.charge > 0 && dist(o.chargeX, o.chargeY, q.x, q.y) < 200) odds *= 1.2;
      if (odds > bestOdds) { bestOdds = odds; best = o; }
    }
    if (best && bestOdds > D.strike * (bloodMoon > 0 ? 0.6 : 1) && Math.random() < 0.6) {
      c.ai.chargeTarget = best;
      startCharge(c, best.queen.x, best.queen.y);
      return true;
    }
    return false;
  }
  function aiThink(c) {
    const q = c.queen, ai = c.ai, my = colonySize(c);
    ai.target = null;
    for (const o of colonies) {
      if (o === c || !o.alive || o.charge <= 0) continue;
      if (dist(o.chargeX, o.chargeY, q.x, q.y) < 220 && Math.random() < 0.6) { ai.mode = 'evade'; ai.target = o; return; }
    }
    let threat = null, threatD = Infinity, prey = null, preyScore = -Infinity;
    for (const o of colonies) {
      if (o === c || !o.alive) continue;
      const d = dist(q.x, q.y, o.queen.x, o.queen.y);
      const os = colonySize(o);
      if (o.grace > 0 && os <= my) continue;
      if (os > my * 1.4 * ai.aggro && d < 360 && d < threatD) { threat = o; threatD = d; }
      if (os <= my * 1.2 * ai.aggro && d < 480) {
        const score = (my + 5) / (os + 5) - d / 480;
        if (score > preyScore) { preyScore = score; prey = o; }
      }
    }
    if (threat && (!prey || threatD < 240)) { ai.mode = 'flee'; ai.target = threat; return; }
    if (prey) { ai.mode = colonySize(prey) < my * 0.7 ? 'chase' : 'stalk'; ai.target = prey; return; }
    if (golden && dist(q.x, q.y, golden.x, golden.y) < 1000) { ai.mode = 'powerup'; ai.power = golden; return; }
    let bp = null, bpd = 450;
    for (const pu of powerups) { const d = dist(q.x, q.y, pu.x, pu.y); if (d < bpd) { bpd = d; bp = pu; } }
    if (bp) { ai.mode = 'powerup'; ai.power = bp; return; }
    if (ai.likesFarm) {
      let bg = null, bgd = 900;
      for (const g of gardens) {
        if (g.owner && g.owner !== c) continue;
        const d = dist(q.x, q.y, g.x, g.y);
        if (d < bgd) { bgd = d; bg = g; }
      }
      if (bg) { ai.mode = 'farm'; ai.garden = bg; return; }
    }
    let best = null, bestD = 340;
    const gx = (q.x / CELL) | 0, gy = (q.y / CELL) | 0;
    for (let yy = gy - 8; yy <= gy + 8; yy++) {
      if (yy < 0 || yy >= GROWS) continue;
      for (let xx = gx - 8; xx <= gx + 8; xx++) {
        if (xx < 0 || xx >= GCOLS) continue;
        for (const f of foodGrid[yy * GCOLS + xx]) {
          if (f.dead) continue;
          const d = dist(q.x, q.y, f.x, f.y);
          if (d < bestD) { bestD = d; best = f; }
        }
      }
    }
    if (best) { ai.mode = 'food'; ai.food = best; return; }
    if (ai.mode !== 'wander' || dist(q.x, q.y, ai.wx, ai.wy) < 60) {
      ai.wx = clamp(q.x + rand(-700, 700), 150, WORLD_W - 150);
      ai.wy = clamp(q.y + rand(-700, 700), 150, WORLD_H - 150);
      if (c.tunnelCd <= 0 && Math.random() < 0.35) {
        const h = tunnels.find(t => dist(q.x, q.y, t.x, t.y) < 600);
        if (h) { ai.wx = h.x; ai.wy = h.y; }
      }
    }
    ai.mode = 'wander';
  }
  function wallAvoid(q, v) {
    const m = 260;
    if (q.x < m) v.x += (m - q.x) / m * 1.6;
    if (q.x > WORLD_W - m) v.x -= (q.x - (WORLD_W - m)) / m * 1.6;
    if (q.y < m) v.y += (m - q.y) / m * 1.6;
    if (q.y > WORLD_H - m) v.y -= (q.y - (WORLD_H - m)) / m * 1.6;
  }
  function updateAI(c, dt) {
    const q = c.queen, ai = c.ai;
    ai.think -= dt;
    if (ai.think <= 0) { ai.think = rand(0.35, 0.7); aiThink(c); }
    ai.react -= dt;
    if (ai.react <= 0) {
      ai.react = rand(0.25, 0.5) * D.react;
      if (aiStrike(c)) ai.think = 0;
      else if (c.charge <= 0 && c.chargeCd <= 0 && c.workers.length >= 15 && Math.random() < 0.15) {
        const cr = creatures.find(k => k.type !== 'drone' && k.state !== 'flipped' && k.state !== 'out' && dist(k.x, k.y, q.x, q.y) < 230);
        if (cr) { ai.chargeTarget = null; startCharge(c, cr.x, cr.y); }
      }
    }
    if (c.charge > 0 && ai.chargeTarget && ai.chargeTarget.alive) {
      const tq = ai.chargeTarget.queen;
      c.chargeX = tq.x + tq.vx * 0.15; c.chargeY = tq.y + tq.vy * 0.15;
    }
    const v = { x: 0, y: 0 };
    let sp = AI_SPEED * 0.6;
    const tgt = ai.target && ai.target.alive ? ai.target : null;
    if (c.charge > 0 && ai.chargeTarget && ai.chargeTarget.alive) {
      const tq = ai.chargeTarget.queen;
      const dx = q.x - tq.x, dy = q.y - tq.y, d = Math.hypot(dx, dy) || 1;
      if (d < 300) { v.x = dx / d; v.y = dy / d; sp = AI_FLEE_SPEED * 0.8; }
      wallAvoid(q, v);
    } else if (ai.mode === 'evade' && tgt) {
      const dx = q.x - tgt.chargeX, dy = q.y - tgt.chargeY, d = Math.hypot(dx, dy) || 1;
      v.x = dx / d; v.y = dy / d; sp = AI_FLEE_SPEED;
      wallAvoid(q, v);
    } else if (ai.mode === 'flee' && tgt) {
      const dx = q.x - tgt.queen.x, dy = q.y - tgt.queen.y, d = Math.hypot(dx, dy) || 1;
      v.x = dx / d; v.y = dy / d; sp = AI_FLEE_SPEED;
      if (c.tunnelCd <= 0) {
        for (const h of tunnels) {
          const hx = h.x - q.x, hy = h.y - q.y, hd = Math.hypot(hx, hy) || 1;
          if (hd < 240 && (hx * dx + hy * dy) / (hd * d) > -0.2) { v.x = hx / hd; v.y = hy / hd; break; }
        }
      }
      wallAvoid(q, v);
    } else if (ai.mode === 'chase' && tgt) {
      const tq = tgt.queen;
      v.x = tq.x + tq.vx * 0.3 - q.x; v.y = tq.y + tq.vy * 0.3 - q.y; sp = AI_SPEED;
    } else if (ai.mode === 'stalk' && tgt) {
      const tq = tgt.queen;
      const dx = tq.x - q.x, dy = tq.y - q.y, d = Math.hypot(dx, dy) || 1;
      const want = tgt.charge > 0 ? 120 : 230;
      const radial = clamp((d - want) / 80, -1, 1);
      v.x = dx / d * radial - dy / d * ai.orbit * 0.8;
      v.y = dy / d * radial + dx / d * ai.orbit * 0.8;
      sp = AI_SPEED;
      wallAvoid(q, v);
    } else if (ai.mode === 'powerup' && ai.power && !ai.power.dead) {
      v.x = ai.power.x - q.x; v.y = ai.power.y - q.y; sp = AI_SPEED * 0.9;
    } else if (ai.mode === 'farm' && ai.garden) {
      const g = ai.garden, d = dist(q.x, q.y, g.x, g.y);
      v.x = g.x - q.x; v.y = g.y - q.y;
      sp = d > GARDEN_R * 0.4 ? AI_SPEED * 0.8 : Math.min(30, d);
    } else if (ai.mode === 'food' && ai.food && !ai.food.dead) {
      v.x = ai.food.x - q.x; v.y = ai.food.y - q.y; sp = AI_SPEED * 0.8;
    } else {
      if (ai.mode !== 'wander') { ai.mode = 'wander'; ai.think = 0; }
      v.x = ai.wx - q.x; v.y = ai.wy - q.y; sp = AI_SPEED * 0.6;
      if (Math.hypot(v.x, v.y) < 50) ai.think = 0;
    }
    sp *= speedFactor(c) * D.speed;
    const n = Math.hypot(v.x, v.y);
    steerQueen(q, n > 0.001 ? v.x / n * sp : 0, n > 0.001 ? v.y / n * sp : 0, dt, 4);
  }

  // ============================================================
  //  Grids, fights, food
  // ============================================================
  const usedAntCells = [], usedFoodCells = [];
  function buildGrids() {
    for (const i of usedAntCells) { antGrid[i].length = 0; cellOwner[i] = 0; }
    for (const i of usedFoodCells) foodGrid[i].length = 0;
    usedAntCells.length = 0; usedFoodCells.length = 0;
    for (const c of colonies) {
      if (!c.alive) continue;
      for (const w of c.workers) {
        const gx = clamp((w.x / CELL) | 0, 0, GCOLS - 1), gy = clamp((w.y / CELL) | 0, 0, GROWS - 1);
        const ci = gy * GCOLS + gx, cell = antGrid[ci];
        if (!cell.length) { usedAntCells.push(ci); cellOwner[ci] = c.id; }
        else if (cellOwner[ci] !== c.id) cellOwner[ci] = -1;
        cell.push(w);
      }
    }
    for (const f of food) {
      if (f.dead) continue;
      const gx = clamp((f.x / CELL) | 0, 0, GCOLS - 1), gy = clamp((f.y / CELL) | 0, 0, GROWS - 1);
      const cell = foodGrid[gy * GCOLS + gx];
      if (!cell.length) usedFoodCells.push(gy * GCOLS + gx);
      cell.push(f);
    }
  }
  function fight(a, b) {
    if (a.fightCd > 0 || b.fightCd > 0) return;
    a.fightCd = b.fightCd = 0.2;
    const sa = colonySize(a.col), sb = colonySize(b.col);
    const pa = (sa + 1) / (sa + sb + 2);
    let aDie = 0.9 * (1 - pa), bDie = 0.9 * pa;
    if (bloodMoon > 0) { aDie *= 1.5; bDie *= 1.5; }
    const ac = a.col.charge > 0, bc = b.col.charge > 0;
    if (ac && !bc) { aDie *= 1.25; bDie *= 0.75; }
    if (bc && !ac) { bDie *= 1.25; aDie *= 0.75; }
    if (a.col.frenzy > 0) { aDie *= 0.6; bDie *= 1.4; }
    if (b.col.frenzy > 0) { bDie *= 0.6; aDie *= 1.4; }
    const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy) || 1;
    a.vx += dx / d * 120; a.vy += dy / d * 120;
    b.vx -= dx / d * 120; b.vy -= dy / d * 120;
    for (const side of [a, b]) {
      const c = side.col;
      if (c.human) {
        sfx(c, 'fight');
        if (c.charge > 0 && !c.chargeHit) { c.chargeHit = true; personal(c, { t: 'shake', a: 6 }); }
      }
    }
    if (Math.random() < Math.min(0.95, aDie)) killWorker(a);
    if (Math.random() < Math.min(0.95, bDie)) killWorker(b);
  }
  function killWorker(w) { w.dead = true; }
  function eatFood(c, f) {
    if (f.dead) return;
    f.dead = true;
    if (c.human) { sfx(c, 'eat'); lifeAdd(c, 'crumbs'); }
    c.food += f.honey ? 2 : 1;
    while (c.food >= FOOD_PER_WORKER) { c.food -= FOOD_PER_WORKER; c.births++; }
  }
  function interactions(dt) {
    const SEP2 = SEP_DIST * SEP_DIST, FIGHT2 = FIGHT_DIST * FIGHT_DIST;
    for (const c of colonies) {
      if (!c.alive) continue;
      const cid = c.id;
      for (const w of c.workers) {
        if (w.dead) continue;
        w.fightCd -= dt;
        const gx = clamp((w.x / CELL) | 0, 0, GCOLS - 1), gy = clamp((w.y / CELL) | 0, 0, GROWS - 1);
        // Level of detail: an ant with no other colony in the 3x3 cells around it only needs its
        // spacing and food steering refreshed every third step (it keeps the last result between).
        // Anywhere two colonies meet, every ant is checked every step, so fights stay exact.
        let calm = true;
        for (let yy = gy - 1; yy <= gy + 1 && calm; yy++) {
          if (yy < 0 || yy >= GROWS) continue;
          for (let xx = gx - 1; xx <= gx + 1; xx++) {
            if (xx < 0 || xx >= GCOLS) continue;
            const ow = cellOwner[yy * GCOLS + xx];
            if (ow !== 0 && ow !== cid) { calm = false; break; }
          }
        }
        w.ed = Infinity;
        if (calm && (w.id + stepNo) % 3 !== 0) continue;
        w.sx = w.sy = w.fx = w.fy = 0;
        let nearF = null, nearD = 30;
        for (let yy = gy - 1; yy <= gy + 1; yy++) {
          if (yy < 0 || yy >= GROWS) continue;
          for (let xx = gx - 1; xx <= gx + 1; xx++) {
            if (xx < 0 || xx >= GCOLS) continue;
            const idx = yy * GCOLS + xx;
            const cell = antGrid[idx];
            for (let i = 0; i < cell.length; i++) {
              const o = cell[i];
              if (o === w || o.dead) continue;
              const dx = w.x - o.x, dy = w.y - o.y, d2 = dx * dx + dy * dy;
              if (o.col === w.col) {
                if (d2 < SEP2 && d2 > 0.0001) {
                  const d = Math.sqrt(d2), p = (SEP_DIST - d) / SEP_DIST;
                  w.sx += dx / d * p * 140; w.sy += dy / d * p * 140;
                }
              } else {
                if (d2 < 38 * 38 && d2 < w.ed * w.ed) { w.ed = Math.sqrt(d2); w.ex = o.x; w.ey = o.y; }
                if (d2 < FIGHT2 && w.id < o.id) {
                  const d = Math.sqrt(d2) || 0.01, nx = dx / d, ny = dy / d, overlap = FIGHT_DIST - d;
                  const wa = w.col.charge > 0, oa = o.col.charge > 0;
                  const ww = wa === oa ? 0.5 : wa ? 0.85 : 0.15;
                  w.x += nx * overlap * ww; w.y += ny * overlap * ww;
                  o.x -= nx * overlap * (1 - ww); o.y -= ny * overlap * (1 - ww);
                  const rv = (w.vx - o.vx) * nx + (w.vy - o.vy) * ny;
                  if (rv < 0) {
                    w.vx -= rv * nx * ww; w.vy -= rv * ny * ww;
                    o.vx += rv * nx * (1 - ww); o.vy += rv * ny * (1 - ww);
                  }
                  fight(w, o);
                }
                if (w.dead) break;
              }
            }
            if (w.dead) break;
            const fc = foodGrid[idx];
            for (let i = 0; i < fc.length; i++) {
              const f = fc[i];
              if (f.dead) continue;
              const fdx = w.x - f.x, fdy = w.y - f.y, d = Math.sqrt(fdx * fdx + fdy * fdy);
              if (d < WORKER_R + f.r + 1) { eatFood(c, f); continue; }
              if (d < nearD) { nearD = d; nearF = f; }
            }
          }
          if (w.dead) break;
        }
        if (nearF && c.charge <= 0) { w.fx = (nearF.x - w.x) / nearD * 150; w.fy = (nearF.y - w.y) / nearD * 150; }
      }
    }
    for (const c of colonies) {
      if (!c.alive) continue;
      const q = c.queen;
      const gx = clamp((q.x / CELL) | 0, 0, GCOLS - 1), gy = clamp((q.y / CELL) | 0, 0, GROWS - 1);
      for (let yy = gy - 1; yy <= gy + 1; yy++) {
        if (yy < 0 || yy >= GROWS) continue;
        for (let xx = gx - 1; xx <= gx + 1; xx++) {
          if (xx < 0 || xx >= GCOLS) continue;
          for (const f of foodGrid[yy * GCOLS + xx]) if (!f.dead && dist(q.x, q.y, f.x, f.y) < QUEEN_R + f.r) eatFood(c, f);
        }
      }
    }
    for (const c of colonies) {
      if (!c.alive) continue;
      if (c.workers.some(w => w.dead)) c.workers = c.workers.filter(w => !w.dead);
      while (c.births > 0) {
        c.births--;
        if (c.workers.length >= MAX_WORKERS) continue;
        const q = c.queen;
        addWorker(c, q.x - Math.cos(q.ang) * 16 + rand(-4, 4), q.y - Math.sin(q.ang) * 16 + rand(-4, 4));
        if (c.human) { personal(c, { t: 'text', text: '+1', x: q.x, y: q.y - 24, color: '#ffe27a', life: 0.9, size: 16 }); sfx(c, 'hatch'); }
      }
    }
    if (food.some(f => f.dead)) food = food.filter(f => !f.dead);
  }

  // ============================================================
  //  Worker movement (flocking around the queen)
  // ============================================================
  function updateWorkers(c, dt) {
    const q = c.queen, n = c.workers.length;
    if (!n) return;
    let rings = 0;
    for (let left = n; left > 0; rings++) left -= Math.max(6, Math.floor(TAU * (RING0 + rings * RING_GAP) / RING_SPACING));
    const outerR = RING0 + (rings - 1) * RING_GAP;
    c.outerR = outerR;
    const k = 1 - Math.exp(-7 * dt), kRing = 1 - Math.exp(-16 * dt);
    const kTurn = 1 - Math.exp(-12 * dt), kRest = 1 - Math.exp(-6 * dt);
    const capS = PLAYER_SPEED * 1.3 * RUSH_SPEED + 140;
    const qx = q.x, qy = q.y, qvx = q.vx, qvy = q.vy;
    const charging = c.charge > 0;
    const Rc = 8 + 3.5 * Math.sqrt(n);
    let tvx = 0, tvy = 0, tcount = 0;
    const scan = outerR + 70, cr = Math.ceil(scan / CELL);
    const gx = clamp((q.x / CELL) | 0, 0, GCOLS - 1), gy = clamp((q.y / CELL) | 0, 0, GROWS - 1);
    for (let yy = Math.max(0, gy - cr); yy <= Math.min(GROWS - 1, gy + cr); yy++) {
      for (let xx = Math.max(0, gx - cr); xx <= Math.min(GCOLS - 1, gx + cr); xx++) {
        const ow = cellOwner[yy * GCOLS + xx];
        if (ow === 0 || ow === c.id) continue;
        for (const e of antGrid[yy * GCOLS + xx]) {
          if (e.col === c || e.dead) continue;
          const dx = e.x - q.x, dy = e.y - q.y, d = Math.sqrt(dx * dx + dy * dy);
          if (d > scan || d < 0.01) continue;
          tvx += dx / d; tvy += dy / d; tcount++;
        }
      }
    }
    const tmag = Math.hypot(tvx, tvy);
    const shift = Math.hypot(q.vx, q.vy) < 90 ? 0.55 : 0.25;
    const squeeze = tcount >= 2 && !charging ? shift * Math.min(1, tcount / 8) * Math.min(1, tmag / tcount + 0.2) : 0;
    const threatAng = Math.atan2(tvy, tvx);
    c.calm = tcount === 0;
    let idx = 0;
    for (let ring = 0; idx < n; ring++) {
      const r = RING0 + ring * RING_GAP;
      const cnt = Math.min(Math.max(6, Math.floor(TAU * r / RING_SPACING)), n - idx);
      const rot = time * 0.22 * (ring % 2 ? -1 : 1) + ring * 0.7 + c.id;
      for (let j = 0; j < cnt; j++) {
        const w = c.workers[idx + j];
        let a = rot + j / cnt * TAU;
        if (squeeze > 0) {
          const rel = ((a - threatAng + Math.PI) % TAU + TAU) % TAU - Math.PI;
          a = threatAng + rel * (1 - squeeze);
        }
        let tx = qx + Math.cos(a) * r, ty = qy + Math.sin(a) * r;
        let maxS = WORKER_SPEED, guarding = false;
        if (charging) {
          tx = c.chargeX + w.ox * Rc; ty = c.chargeY + w.oy * Rc; maxS = CHARGE_SPEED;
          if (w.ed < 13) maxS = 25;
        } else if (w.ed < 38 && (w.ex - qx) ** 2 + (w.ey - qy) ** 2 < (r + 3) * (r + 3)) {
          tx = w.ex; ty = w.ey; maxS = WORKER_SPEED * 1.15;
        } else guarding = true;
        const dx = tx - w.x, dy = ty - w.y, d = Math.sqrt(dx * dx + dy * dy);
        let dvx, dvy;
        if (guarding) {
          dvx = qvx + dx * 8 + w.sx * 0.5 + w.fx * 0.5;
          dvy = qvy + dy * 8 + w.sy * 0.5 + w.fy * 0.5;
          const m2 = dvx * dvx + dvy * dvy;
          if (m2 > capS * capS) { const f = capS / Math.sqrt(m2); dvx *= f; dvy *= f; }
          w.vx += (dvx - w.vx) * kRing; w.vy += (dvy - w.vy) * kRing;
        } else {
          const sp = Math.min(maxS, d * (charging ? 6 : 4));
          dvx = (d > 0.01 ? dx / d * sp : 0) + w.sx + w.fx;
          dvy = (d > 0.01 ? dy / d * sp : 0) + w.sy + w.fy;
          w.vx += (dvx - w.vx) * k; w.vy += (dvy - w.vy) * k;
        }
        if (w.stuck > 0) {
          w.stuck -= dt; w.vx = w.vy = 0;
          if (w.stuck <= 0) w.webCd = 3;
        } else {
          if (w.webCd > 0) w.webCd -= dt;
          const tf = terrainFactor(w.x, w.y);
          w.x = clamp(w.x + w.vx * dt * tf, 3, WORLD_W - 3);
          w.y = clamp(w.y + w.vy * dt * tf, 3, WORLD_H - 3);
          if (rocks.length) pushOutOfRocks(w, WORKER_R);
        }
        const s2 = w.vx * w.vx + w.vy * w.vy;
        if (s2 > 625) w.ang = lerpAngle(w.ang, Math.atan2(w.vy, w.vx), kTurn);
        else w.ang = lerpAngle(w.ang, a, kRest);
      }
      idx += cnt;
    }
  }

  // ============================================================
  //  Conquest
  // ============================================================
  function speedFactor(c) {
    const base = 0.85 + 0.45 * (1 - Math.sqrt(Math.min(1, c.workers.length / 150)));
    return c.rush > 0 ? base * RUSH_SPEED : base;
  }
  function countNear(col, x, y, r, qx = 0, qy = 0, maxQ = Infinity) {
    const gx = clamp((x / CELL) | 0, 0, GCOLS - 1), gy = clamp((y / CELL) | 0, 0, GROWS - 1), r2 = r * r;
    let n = 0;
    for (let yy = Math.max(0, gy - 1); yy <= Math.min(GROWS - 1, gy + 1); yy++)
      for (let xx = Math.max(0, gx - 1); xx <= Math.min(GCOLS - 1, gx + 1); xx++)
        for (const w of antGrid[yy * GCOLS + xx])
          if (w.col === col && !w.dead && (w.x - x) ** 2 + (w.y - y) ** 2 < r2 &&
              (maxQ === Infinity || (w.x - qx) ** 2 + (w.y - qy) ** 2 < maxQ * maxQ)) n++;
    return n;
  }
  function guardWalls() {
    const wallR = RING0 + 2;
    for (const c of colonies) {
      if (!c.alive || !c.workers.length) continue;
      const q = c.queen;
      const brace = Math.hypot(q.vx, q.vy) < 90 ? 2.2 : 1.3;
      const gx = clamp((q.x / CELL) | 0, 0, GCOLS - 1), gy = clamp((q.y / CELL) | 0, 0, GROWS - 1);
      for (let yy = Math.max(0, gy - 1); yy <= Math.min(GROWS - 1, gy + 1); yy++) {
        for (let xx = Math.max(0, gx - 1); xx <= Math.min(GCOLS - 1, gx + 1); xx++) {
          for (const e of antGrid[yy * GCOLS + xx]) {
            if (e.dead || e.col === c) continue;
            const dx = e.x - q.x, dy = e.y - q.y, d = Math.hypot(dx, dy);
            if (d >= wallR) continue;
            const defenders = countNear(c, e.x, e.y, 32);
            const attackers = countNear(e.col, e.x, e.y, 32, q.x, q.y, wallR + 10);
            const dPow = c.frenzy > 0 ? FRENZY_POWER : 1, aPow = e.col.frenzy > 0 ? FRENZY_POWER : 1;
            if (defenders * brace * dPow >= attackers * aPow) {
              const nx = d > 0.01 ? dx / d : 1, ny = d > 0.01 ? dy / d : 0;
              e.x = q.x + nx * wallR; e.y = q.y + ny * wallR;
              const vin = e.vx * nx + e.vy * ny;
              if (vin < 0) { e.vx -= vin * nx; e.vy -= vin * ny; }
            }
          }
        }
      }
    }
  }
  function antQueenContacts() {
    guardWalls();
    for (const c of colonies) {
      if (!c.alive) continue;
      const q = c.queen;
      const bx = q.x - Math.cos(q.ang) * 11, by = q.y - Math.sin(q.ang) * 11;
      const gx = clamp((q.x / CELL) | 0, 0, GCOLS - 1), gy = clamp((q.y / CELL) | 0, 0, GROWS - 1);
      let hit = null;
      for (let yy = gy - 1; yy <= gy + 1 && !hit; yy++) {
        if (yy < 0 || yy >= GROWS) continue;
        for (let xx = gx - 1; xx <= gx + 1 && !hit; xx++) {
          if (xx < 0 || xx >= GCOLS) continue;
          for (const w of antGrid[yy * GCOLS + xx]) {
            if (w.dead || w.col === c || !w.col.alive) continue;
            if (dist(w.x, w.y, q.x, q.y) < QUEEN_R + WORKER_R || dist(w.x, w.y, bx, by) < 9 + WORKER_R) { hit = w; break; }
          }
        }
      }
      if (hit && c.grace <= 0) conquer(hit.col, c, { via: 'ant', x: hit.x, y: hit.y, attackerCharging: hit.col.charge > 0 });
    }
  }
  function queenCollisions() {
    for (let i = 0; i < colonies.length; i++) {
      const a = colonies[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < colonies.length; j++) {
        const b = colonies[j];
        if (!b.alive || !a.alive) continue;
        const dx = a.queen.x - b.queen.x, dy = a.queen.y - b.queen.y, d = Math.hypot(dx, dy);
        if (d >= QUEEN_R * 2) continue;
        const sa = colonySize(a), sb = colonySize(b);
        if (sa > sb && b.grace <= 0) conquer(a, b, { via: 'queen' });
        else if (sb > sa && a.grace <= 0) conquer(b, a, { via: 'queen' });
        else {
          const nx = dx / (d || 1), ny = dy / (d || 1), push = (QUEEN_R * 2 - d) / 2 + 0.5;
          a.queen.x += nx * push; a.queen.y += ny * push;
          b.queen.x -= nx * push; b.queen.y -= ny * push;
          a.queen.vx += nx * 80; a.queen.vy += ny * 80;
          b.queen.vx -= nx * 80; b.queen.vy -= ny * 80;
        }
      }
    }
  }
  function conquer(win, lose, how = { via: 'ant' }) {
    const loseSize = colonySize(lose), winSize = colonySize(win);
    lose.alive = false;
    const lq = lose.queen;
    fx({ t: 'conquest', x: lq.x, y: lq.y, wc: win.color, lc: lose.color, win: win.id, lose: lose.id });
    for (const w of lose.workers) {
      const a = rand(0, TAU), r = Math.sqrt(Math.random());
      w.col = win; w.ox = Math.cos(a) * r; w.oy = Math.sin(a) * r; w.fightCd = 0.6;
      win.workers.push(w);
    }
    lose.workers = [];
    if (win.human) {
      const st = win.st;
      st.kills++;
      st.streak = time - st.lastConquer <= STREAK_WINDOW ? st.streak + 1 : 1;
      st.lastConquer = time;
      st.bestStreak = Math.max(st.bestStreak, st.streak);
      lifeAdd(win, 'conquests');
      lifeMax(win, 'bestStreak', st.streak);
      if (loseSize > winSize) lifeMax(win, 'giant', 1);
      if (loseSize >= 50) lifeMax(win, 'bigGame', 1);
      if (winSize < 10) lifeMax(win, 'underdog', 1);
      let bonus = 0;
      if (st.streak >= 2) {
        bonus = 3 * (st.streak - 1);
        win.births += bonus;
        banner(win, STREAK_NAMES[Math.min(st.streak, 5)], `Streak x${st.streak}  +${bonus} bonus ants`, st.streak >= 4 ? '#ff6a3d' : '#ffd54a', 2.2, 40 + Math.min(st.streak, 5) * 4);
      }
      personal(win, { t: 'won', x: lq.x, y: lq.y, name: lose.name, size: loseSize, streak: st.streak, bonus, human: !!lose.human });
    }
    if (lose.human) {
      const st = lose.st;
      const cause = how.via === 'queen' ? 'queen'
        : lose.charge > 0 ? 'selfCharge'
        : how.attackerCharging ? 'charged'
        : Math.hypot(lq.vx, lq.vy) > 90 ? 'running' : 'overrun';
      personal(lose, { t: 'died', by: win.name, byId: win.id, x: how.x ?? lq.x, y: how.y ?? lq.y, cause,
        size: loseSize, peak: st.peak, kills: st.kills, bestStreak: st.bestStreak, time: time - st.start, charges: st.charges });
      if (lose.session) lose.session.colony = null;
      lose.session = null;
    }
  }

  // ============================================================
  //  Power-ups & structures
  // ============================================================
  function placeStructures() {
    gardens = []; tunnels = []; rocks = []; puddles = [];
    const taken = [];
    const pick = (margin, r, gap) => {
      for (let t = 0; t < 300; t++) {
        const x = rand(margin, WORLD_W - margin), y = rand(margin, WORLD_H - margin);
        if (taken.every(p => dist(x, y, p.x, p.y) >= p.r + r + gap)) return { x, y };
      }
      return { x: rand(margin, WORLD_W - margin), y: rand(margin, WORLD_H - margin) };
    };
    const nGardens = randInt(2, 5);
    for (let i = 0; i < nGardens; i++) {
      const p = pick(300, GARDEN_R, 500);
      taken.push({ x: p.x, y: p.y, r: GARDEN_R });
      const shrooms = [];
      for (let k = 0; k < 9; k++) {
        const a = rand(0, TAU), r = rand(20, GARDEN_R - 12);
        shrooms.push({ dx: Math.cos(a) * r, dy: Math.sin(a) * r, r: rand(6, 11), tone: rand(0, 1) });
      }
      gardens.push({ x: p.x, y: p.y, owner: null, contested: false, acc: 0, shrooms });
    }
    const nRocks = randInt(6, 14);
    for (let i = 0; i < nRocks; i++) {
      const r = rand(30, 72), p = pick(160, r, 120);
      const pts = [];
      for (let k = 0; k < 9; k++) { const a = k / 9 * TAU + rand(-0.2, 0.2); pts.push([Math.cos(a) * r * rand(0.85, 1.12), Math.sin(a) * r * rand(0.85, 1.12)]); }
      rocks.push({ x: p.x, y: p.y, r, pts, tone: randInt(95, 135) });
      taken.push({ x: p.x, y: p.y, r });
    }
    const nPuddles = randInt(3, 6);
    for (let i = 0; i < nPuddles; i++) {
      const rx = rand(60, 130), ry = rand(40, 80), p = pick(200, rx, 60);
      puddles.push({ x: p.x, y: p.y, rx, ry, rot: rand(0, Math.PI) });
      taken.push({ x: p.x, y: p.y, r: rx });
    }
    placeTunnels(randInt(1, 3));
  }
  function placeTunnels(pairs) {
    tunnels = [];
    const blockers = [...gardens.map(g => ({ x: g.x, y: g.y, r: GARDEN_R })), ...rocks.map(k => ({ x: k.x, y: k.y, r: k.r })), ...puddles.map(p => ({ x: p.x, y: p.y, r: p.rx }))];
    const pick = () => {
      for (let t = 0; t < 300; t++) {
        const x = rand(220, WORLD_W - 220), y = rand(220, WORLD_H - 220);
        if (blockers.every(p => dist(x, y, p.x, p.y) >= p.r + 120)) return { x, y };
      }
      return { x: rand(220, WORLD_W - 220), y: rand(220, WORLD_H - 220) };
    };
    for (let pair = 0; pair < pairs; pair++) {
      let a, b;
      for (let t = 0; t < 60; t++) { a = pick(); b = pick(); if (dist(a.x, a.y, b.x, b.y) > 1700) break; }
      blockers.push({ x: a.x, y: a.y, r: 40 }, { x: b.x, y: b.y, r: 40 });
      const i = tunnels.length;
      tunnels.push({ x: a.x, y: a.y, pair: i + 1, group: pair }, { x: b.x, y: b.y, pair: i, group: pair });
    }
    mapVersion++;
  }
  function inRock(x, y, pad = 0) { return rocks.some(k => (x - k.x) ** 2 + (y - k.y) ** 2 < (k.r + pad) ** 2); }
  function terrainFactor(x, y) {
    let f = raining > 0 ? RAIN_SLOW : 1;
    if (flood && inFlood(x, y)) f *= 0.35;
    for (const cr of creatures) if (cr.type === 'spider' && (x - cr.x) ** 2 + (y - cr.y) ** 2 < cr.webR * cr.webR) f *= 0.4;
    for (const p of puddles) {
      const dx = x - p.x, dy = y - p.y;
      if (Math.abs(dx) > p.rx || Math.abs(dy) > p.rx) continue;
      const c = Math.cos(p.rot), sn = Math.sin(p.rot), u = (dx * c + dy * sn) / p.rx, v = (-dx * sn + dy * c) / p.ry;
      if (u * u + v * v < 1) { f *= PUDDLE_SLOW; break; }
    }
    return f;
  }
  function pushOutOfRocks(o, rad) {
    for (const k of rocks) {
      const dx = o.x - k.x, dy = o.y - k.y, rr = k.r + rad;
      if (Math.abs(dx) > rr || Math.abs(dy) > rr) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2) || 0.01, nx = dx / d, ny = dy / d;
      o.x = k.x + nx * rr; o.y = k.y + ny * rr;
      const vn = o.vx * nx + o.vy * ny;
      if (vn < 0) { o.vx -= vn * nx; o.vy -= vn * ny; }
    }
  }
  function spawnPowerup() {
    for (let t = 0; t < 40; t++) {
      const x = rand(150, WORLD_W - 150), y = rand(150, WORLD_H - 150);
      if (tunnels.some(h => dist(x, y, h.x, h.y) < 80) || gardens.some(g => dist(x, y, g.x, g.y) < GARDEN_R + 30) || inRock(x, y, 30)) continue;
      powerups.push({ id: uid++, x, y, type: Math.random() < 0.5 ? 'frenzy' : 'rush', dead: false });
      return;
    }
  }
  function applyPower(c, pu) {
    pu.dead = true;
    if (c.human) { sfx(c, 'power'); lifeAdd(c, pu.type === 'frenzy' ? 'chili' : 'sugar'); }
    if (pu.type === 'frenzy') c.frenzy = FRENZY_TIME;
    else { c.rush = RUSH_TIME; if (c.charge <= 0) c.chargeCd = 0; }
    fx({ t: 'power', x: pu.x, y: pu.y, type: pu.type, by: c.id, name: c.name, qx: c.queen.x, qy: c.queen.y });
  }
  function teleport(c, from, to) {
    if (c.human) { sfx(c, 'tunnel'); lifeAdd(c, 'tunnels'); }
    const q = c.queen, s = Math.hypot(q.vx, q.vy);
    const hx = s > 5 ? q.vx / s : Math.cos(q.ang), hy = s > 5 ? q.vy / s : Math.sin(q.ang);
    const ex = clamp(to.x + hx * (HOLE_R + 16), 40, WORLD_W - 40), ey = clamp(to.y + hy * (HOLE_R + 16), 40, WORLD_H - 40);
    const dx = ex - q.x, dy = ey - q.y;
    q.x = ex; q.y = ey;
    for (const w of c.workers) { w.x = clamp(w.x + dx, 3, WORLD_W - 3); w.y = clamp(w.y + dy, 3, WORLD_H - 3); }
    c.tunnelCd = TUNNEL_CD;
    if (c.charge > 0) { c.charge = 0; c.chargeCd = Math.max(c.chargeCd, 0.5); }
    // the input target is where the mouse points relative to the queen: carry it through the tunnel
    if (c.human) { c.input.x += dx; c.input.y += dy; personal(c, { t: 'teleport', dx, dy }); }
    fx({ t: 'tunnel', ax: from.x, ay: from.y, ag: from.group, bx: to.x, by: to.y, bg: to.group });
  }

  // ---------- map events ----------
  function floodCov() {
    if (!flood) return 0;
    const t = flood.t, d = flood.dur;
    return 0.34 * clamp(t < 3 ? t / 3 : t > d - 3 ? (d - t) / 3 : 1, 0, 1);
  }
  function inFlood(x, y) {
    const c = floodCov();
    if (c <= 0) return false;
    switch (flood.side) {
      case 'left': return x < WORLD_W * c;
      case 'right': return x > WORLD_W * (1 - c);
      case 'top': return y < WORLD_H * c;
      default: return y > WORLD_H * (1 - c);
    }
  }
  function startExtraEvent(type) {
    if (type === 'glass') {
      const lead = biggestColony(), p = lead ? { x: lead.queen.x + rand(-400, 400), y: lead.queen.y + rand(-300, 300) } : openSpot(0);
      magnifier = { x: clamp(p.x, 100, WORLD_W - 100), y: clamp(p.y, 100, WORLD_H - 100), t: 20, burnT: 0.5 };
      bannerAll('MAGNIFYING GLASS!', 'A burning sunbeam hunts the biggest colony', '#fff2a0', 3, 44);
      fx({ t: 'sfx', name: 'event' });
    } else if (type === 'flood') {
      flood = { side: ['left', 'right', 'top', 'bottom'][randInt(0, 3)], t: 0, dur: 20 };
      bannerAll('FLOOD!', `Water is rising from the ${flood.side} - everything in it is slowed`, '#7fc4ff', 3, 46);
      fx({ t: 'sfx', name: 'thunder' });
    } else if (type === 'migration') {
      const a = rand(0, TAU);
      migration = { dx: Math.cos(a), dy: Math.sin(a), t: 25 };
      bannerAll('MIGRATION!', `All the food is drifting ${COMPASS[Math.round(((a % TAU) + TAU) % TAU / (TAU / 8)) % 8]} - follow it`, '#b8ff8c', 3, 44);
      fx({ t: 'sfx', name: 'event' });
    } else if (type === 'night') {
      nightT = 30;
      bannerAll('NIGHT FALLS', 'You can only see around your colony - watch the minimap', '#b0b8ff', 3, 44);
      fx({ t: 'sfx', name: 'event' });
    } else if (type === 'blood') {
      bloodMoon = 20;
      bannerAll('BLOOD MOON!', 'Charges recharge instantly and every fight is deadlier', '#ff5a5a', 3, 46);
      fx({ t: 'sfx', name: 'thunder' }); fx({ t: 'shake', a: 5 });
    } else if (type === 'sugar') {
      sugarRain = 15; sugarRainT = 0;
      bannerAll('SUGAR RAIN!', 'Sugar cubes are falling everywhere - grab them!', '#8fd8ff', 3, 46);
      fx({ t: 'sfx', name: 'event' });
    } else if (type === 'golden') {
      const p = openSpot(350, 350);
      golden = { x: p.x, y: p.y, progress: 0, t: 60, lead: null, dead: false };
      bannerAll('GOLDEN CRUMB!', 'Worth 25 ants to whoever takes the last bite - see the minimap', '#ffd54a', 3, 44);
      fx({ t: 'sfx', name: 'event' });
    }
  }
  function updateExtraEvents(dt) {
    if (magnifier) {
      if ((magnifier.t -= dt) <= 0) magnifier = null;
      else {
        const lead = biggestColony();
        if (lead) {
          const dx = lead.queen.x - magnifier.x, dy = lead.queen.y - magnifier.y, d = Math.hypot(dx, dy);
          if (d > 5) { magnifier.x += dx / d * Math.min(95 * dt, d); magnifier.y += dy / d * Math.min(95 * dt, d); }
        }
        if ((magnifier.burnT -= dt) <= 0) {
          magnifier.burnT = 0.35;
          const hit = workersNear(magnifier.x, magnifier.y, 48);
          if (hit.length) killWorker(hit[randInt(0, hit.length - 1)]);
          fx({ t: 'smoke', x: magnifier.x, y: magnifier.y });
        }
      }
    }
    if (flood && (flood.t += dt) >= flood.dur) flood = null;
    if (migration) {
      for (const f of food) { f.x = clamp(f.x + migration.dx * 22 * dt, 12, WORLD_W - 12); f.y = clamp(f.y + migration.dy * 22 * dt, 12, WORLD_H - 12); }
      if ((migration.t -= dt) <= 0) migration = null;
    }
    if (nightT > 0) nightT -= dt;
    if (bloodMoon > 0) {
      bloodMoon -= dt;
      for (const c of colonies) if (c.alive && c.charge <= 0) c.chargeCd = 0;
    }
    if (sugarRain > 0) {
      sugarRain -= dt;
      if ((sugarRainT -= dt) <= 0 && powerups.length < 30) {
        sugarRainT = 0.3;
        const p = openSpot(0, 120);
        powerups.push({ id: uid++, x: p.x, y: p.y, type: 'rush', dead: false, rain: true });
      }
      if (sugarRain <= 0) powerups = powerups.filter(p => !p.rain);
    }
    if (golden) {
      const con = crContacts(golden.x, golden.y, 16);
      for (const c of colonies) if (c.alive && dist(c.queen.x, c.queen.y, golden.x, golden.y) < QUEEN_R + 16) { con.res.set(c, (con.res.get(c) || 0) + 3); con.total += 3; }
      if (con.total > 0) {
        golden.progress += Math.min(0.25, con.total * 0.012) * dt;
        let lead = null, lw = 0;
        for (const [c, w] of con.res) if (w > lw) { lw = w; lead = c; }
        golden.lead = lead;
      }
      if (golden.progress >= 1 && golden.lead) {
        const w = golden.lead;
        w.births += 25;
        golden.dead = true;
        fx({ t: 'ring', x: golden.x, y: golden.y, color: '#ffd54a', life: 1.2, r: 150 });
        fx({ t: 'text', text: `${w.name} took the Golden Crumb! +25`, x: golden.x, y: golden.y - 40, color: '#ffe27a', life: 2.5, size: 20, by: w.id });
        if (w.human) {
          lifeAdd(w, 'goldenWins');
          banner(w, 'GOLDEN CRUMB!', '+25 ants - you took the last bite', '#ffd54a', 2.6, 42);
          sfx(w, 'combo'); personal(w, { t: 'shake', a: 6 });
        }
        golden = null;
      } else if ((golden.t -= dt) <= 0) { golden.dead = true; golden = null; }
    }
  }
  function openSpot(minFromHuman = 500, margin = 200) {
    const hs = humans();
    for (let t = 0; t < 60; t++) {
      const x = rand(margin, WORLD_W - margin), y = rand(margin, WORLD_H - margin);
      if (inRock(x, y, 70)) continue;
      if (hs.some(h => dist(x, y, h.queen.x, h.queen.y) < minFromHuman)) continue;
      return { x, y };
    }
    return { x: rand(margin, WORLD_W - margin), y: rand(margin, WORLD_H - margin) };
  }
  function edgeSpot() {
    const side = randInt(0, 3);
    return side === 0 ? { x: -60, y: rand(200, WORLD_H - 200) } : side === 1 ? { x: WORLD_W + 60, y: rand(200, WORLD_H - 200) }
         : side === 2 ? { x: rand(200, WORLD_W - 200), y: -60 } : { x: rand(200, WORLD_W - 200), y: WORLD_H + 60 };
  }
  function biggestColony() {
    let best = null;
    for (const c of colonies) if (c.alive && (!best || c.workers.length > best.workers.length)) best = c;
    return best;
  }
  function crContacts(x, y, rad) {
    const res = new Map(); let total = 0;
    const rr = rad + WORKER_R, cr = Math.ceil(rr / CELL);
    const gx = clamp((x / CELL) | 0, 0, GCOLS - 1), gy = clamp((y / CELL) | 0, 0, GROWS - 1);
    for (let yy = Math.max(0, gy - cr); yy <= Math.min(GROWS - 1, gy + cr); yy++)
      for (let xx = Math.max(0, gx - cr); xx <= Math.min(GCOLS - 1, gx + cr); xx++)
        for (const w of antGrid[yy * GCOLS + xx]) {
          if (w.dead || !w.col.alive || (w.x - x) ** 2 + (w.y - y) ** 2 > rr * rr) continue;
          const wt = w.col.charge > 0 ? 3 : 1;
          res.set(w.col, (res.get(w.col) || 0) + wt); total += wt;
        }
    return { res, total };
  }
  function workersNear(x, y, rad, filter) {
    const out = [], cr = Math.ceil(rad / CELL);
    const gx = clamp((x / CELL) | 0, 0, GCOLS - 1), gy = clamp((y / CELL) | 0, 0, GROWS - 1);
    for (let yy = Math.max(0, gy - cr); yy <= Math.min(GROWS - 1, gy + cr); yy++)
      for (let xx = Math.max(0, gx - cr); xx <= Math.min(GCOLS - 1, gx + cr); xx++)
        for (const w of antGrid[yy * GCOLS + xx])
          if (!w.dead && (w.x - x) ** 2 + (w.y - y) ** 2 <= rad * rad && (!filter || filter(w))) out.push(w);
    return out;
  }
  function hurtCreature(cr, con, rate, dt) {
    for (const [col, wt] of con.res) { const d = wt * rate * dt; cr.hp -= d; cr.dmg.set(col, (cr.dmg.get(col) || 0) + d); }
    if (con.total > 0) cr.hitFlash = 0.12;
  }
  function rewardCreature(cr, ants, label, lifeKey) {
    let best = null, bd = 0;
    for (const [c, d] of cr.dmg) if (c.alive && d > bd) { bd = d; best = c; }
    fx({ t: 'burst', x: cr.x, y: cr.y });
    if (!best) return;
    best.births += ants;
    fx({ t: 'text', text: `${label}! +${ants}`, x: cr.x, y: cr.y - 34, color: '#ffe27a', life: 2, size: 20 });
    if (best.human) {
      lifeAdd(best, lifeKey);
      banner(best, label + '!', `+${ants} ants for your colony`, '#ffe27a', 2.4, 40);
      sfx(best, 'conquer'); personal(best, { t: 'shake', a: 6 });
    }
  }
  function spawnCreature(type) {
    const base = { id: uid++, type, t: 0, hp: 1, max: 1, dmg: new Map(), hitFlash: 0, ang: rand(0, TAU), gone: false, vx: 0, vy: 0 };
    if (type === 'spider') {
      const p = openSpot(600);
      creatures.push({ ...base, x: p.x, y: p.y, r: 16, hp: 140, max: 140, webR: 78, eatT: 1, webSeed: rand(0, 1) });
    } else if (type === 'ladybug') {
      const p = openSpot(400);
      creatures.push({ ...base, x: p.x, y: p.y, r: 20, hp: 160, max: 160, tx: p.x, ty: p.y, state: 'walk', flipT: 0 });
    } else if (type === 'wasp') {
      const prey = colonies.filter(c => c.alive && c.workers.length >= 12);
      if (!prey.length) return;
      const hs = prey.filter(c => c.human);
      const target = hs.length && Math.random() < 0.5 ? hs[randInt(0, hs.length - 1)] : prey[randInt(0, prey.length - 1)];
      const p = edgeSpot();
      creatures.push({ ...base, x: p.x, y: p.y, r: 11, hp: 30, max: 30, target, state: 'in', grabT: 1.2, grabs: 0, huntT: 12, orbit: rand(0, TAU) });
      if (target.human) banner(target, 'WASP SCOUT!', 'It picks off ants at the edge of your ring - keep it tight', '#ffd23a', 2.4, 34);
    } else if (type === 'bee') {
      const p = edgeSpot();
      const boss = { ...base, x: p.x, y: p.y, r: 30, hp: 600, max: 600, target: null, retarget: 0, stingT: 0.4 };
      creatures.push(boss);
      for (let i = 0; i < 8; i++) creatures.push({ ...base, id: uid++, dmg: new Map(), type: 'drone', owner: boss, x: p.x, y: p.y, r: 9, hp: 20, max: 20, a: i / 8 * TAU, state: 'orbit', diveT: rand(1, 3), prey: null });
      bannerAll('QUEEN BEE ATTACKS!', 'Defeat her and her drones for a pile of honey', '#ffc23a', 3.2, 44);
      fx({ t: 'sfx', name: 'thunder' }); fx({ t: 'shake', a: 8 });
    }
  }
  function releaseWeb(cr) {
    for (const w of workersNear(cr.x, cr.y, cr.webR + 4)) if (w.stuck > 0) { w.stuck = 0; w.webCd = 2; }
  }
  function moveToward(cr, tx, ty, speed, dt) {
    const dx = tx - cr.x, dy = ty - cr.y, d = Math.hypot(dx, dy);
    if (d < 1) { cr.vx = cr.vy = 0; return d; }
    const s = Math.min(speed, d / dt);
    cr.vx = dx / d * s; cr.vy = dy / d * s;
    cr.x += cr.vx * dt; cr.y += cr.vy * dt;
    cr.ang = lerpAngle(cr.ang, Math.atan2(dy, dx), 1 - Math.exp(-6 * dt));
    return d;
  }
  function updateCreatures(dt) {
    creatureTimer -= dt;
    if (creatureTimer <= 0) {
      creatureTimer = rand(35, 60);
      const count = t => creatures.filter(c => c.type === t && !c.gone).length;
      const opts = [];
      if (count('spider') < 2) opts.push('spider');
      if (count('ladybug') < 3) opts.push('ladybug', 'ladybug');
      if (count('wasp') < 1) opts.push('wasp');
      if (opts.length) spawnCreature(opts[randInt(0, opts.length - 1)]);
    }
    if (humans().length) {
      bossTimer -= dt;
      if (bossTimer <= 0) { bossTimer = 300; if (!creatures.some(c => c.type === 'bee' && !c.gone)) spawnCreature('bee'); }
    }
    for (const cr of creatures) {
      cr.t += dt;
      if (cr.hitFlash > 0) cr.hitFlash -= dt;
      if (cr.type === 'spider') {
        const inWeb = workersNear(cr.x, cr.y, cr.webR);
        const stuck = [];
        for (const w of inWeb) {
          if (w.stuck > 0) { stuck.push(w); continue; }
          if (!(w.webCd > 0) && w.col.charge <= 0) { w.stuck = 2.5; stuck.push(w); }
        }
        if ((cr.eatT -= dt) <= 0) {
          cr.eatT = 1;
          if (stuck.length) { killWorker(stuck[randInt(0, stuck.length - 1)]); cr.munch = 0.3; }
        }
        if (cr.munch > 0) cr.munch -= dt;
        hurtCreature(cr, crContacts(cr.x, cr.y, cr.r + 10), 5, dt);
        if (cr.hp <= 0) { releaseWeb(cr); rewardCreature(cr, 15, 'Spider defeated', 'spiderKills'); cr.gone = true; }
      } else if (cr.type === 'ladybug') {
        if (cr.state === 'flipped') { if ((cr.flipT -= dt) <= 0) cr.gone = true; continue; }
        if (dist(cr.x, cr.y, cr.tx, cr.ty) < 30 || cr.t > 12) {
          cr.t = 0;
          for (let k = 0; k < 20; k++) { const tx = clamp(cr.x + rand(-500, 500), 120, WORLD_W - 120), ty = clamp(cr.y + rand(-500, 500), 120, WORLD_H - 120); if (!inRock(tx, ty, 40)) { cr.tx = tx; cr.ty = ty; break; } }
        }
        moveToward(cr, cr.tx, cr.ty, 28 * terrainFactor(cr.x, cr.y), dt);
        pushOutOfRocks(cr, cr.r);
        const gx = clamp((cr.x / CELL) | 0, 0, GCOLS - 1), gy = clamp((cr.y / CELL) | 0, 0, GROWS - 1);
        for (let yy = Math.max(0, gy - 1); yy <= Math.min(GROWS - 1, gy + 1); yy++)
          for (let xx = Math.max(0, gx - 1); xx <= Math.min(GCOLS - 1, gx + 1); xx++)
            for (const f of foodGrid[yy * GCOLS + xx]) if (!f.dead && dist(f.x, f.y, cr.x, cr.y) < cr.r) f.dead = true;
        for (const w of workersNear(cr.x, cr.y, cr.r + WORKER_R)) {
          const dx = w.x - cr.x, dy = w.y - cr.y, d = Math.hypot(dx, dy) || 0.01, rr = cr.r + WORKER_R;
          w.x = cr.x + dx / d * rr; w.y = cr.y + dy / d * rr;
        }
        const con = crContacts(cr.x, cr.y, cr.r + 4);
        if (con.total >= 15) hurtCreature(cr, con, 6, dt);
        if (cr.hp <= 0) { cr.state = 'flipped'; cr.flipT = 4; rewardCreature(cr, 10, 'Ladybug flipped', 'ladyFlips'); }
      } else if (cr.type === 'wasp') {
        const tg = cr.target;
        if (cr.state !== 'out' && (!tg || !tg.alive)) cr.state = 'out';
        if (cr.state === 'in') {
          if (moveToward(cr, tg.queen.x, tg.queen.y, 170, dt) < tg.outerR + 45) cr.state = 'hunt';
        } else if (cr.state === 'hunt') {
          cr.orbit += 1.1 * dt;
          const rr = tg.outerR + 38;
          moveToward(cr, tg.queen.x + Math.cos(cr.orbit) * rr, tg.queen.y + Math.sin(cr.orbit) * rr, 220, dt);
          if ((cr.grabT -= dt) <= 0) {
            cr.grabT = 1.3;
            let far = null, fd = 0;
            for (const w of workersNear(cr.x, cr.y, 70, w => w.col === tg)) { const d = dist(w.x, w.y, tg.queen.x, tg.queen.y); if (d > fd) { fd = d; far = w; } }
            if (far) { killWorker(far); cr.grabs++; fx({ t: 'ring', x: far.x, y: far.y, color: '#ffd23a', life: 0.4, r: 20 }); }
          }
          if ((cr.huntT -= dt) <= 0 || cr.grabs >= 4) cr.state = 'out';
        } else {
          const ex = cr.x < WORLD_W / 2 ? -200 : WORLD_W + 200, ey = cr.y;
          moveToward(cr, ex, ey, 200, dt);
          if (cr.x < -150 || cr.x > WORLD_W + 150) cr.gone = true;
        }
        hurtCreature(cr, crContacts(cr.x, cr.y, cr.r + 2), 8, dt);
        if (cr.hp <= 0) { rewardCreature(cr, 4, 'Wasp swatted', 'waspKills'); cr.gone = true; }
      } else if (cr.type === 'bee') {
        if ((cr.retarget -= dt) <= 0) { cr.retarget = 4; cr.target = biggestColony(); }
        if (cr.target && cr.target.alive && dist(cr.x, cr.y, cr.target.queen.x, cr.target.queen.y) > 50) moveToward(cr, cr.target.queen.x, cr.target.queen.y, 45, dt);
        if ((cr.stingT -= dt) <= 0) {
          cr.stingT = 0.35;
          const vic = workersNear(cr.x, cr.y, cr.r + 6);
          if (vic.length) killWorker(vic[0]);
        }
        hurtCreature(cr, crContacts(cr.x, cr.y, cr.r + 4), 3, dt);
        if (cr.hp <= 0) {
          cr.gone = true;
          const start = food.length;
          for (let i = 0; i < 70; i++) { const a = rand(0, TAU), r = Math.sqrt(Math.random()) * 90; spawnFood(cr.x + Math.cos(a) * r, cr.y + Math.sin(a) * r); }
          for (let i = start; i < food.length; i++) { food[i].honey = true; food[i].r = rand(3.5, 5); }
          rewardCreature(cr, 20, 'Queen Bee defeated', 'beeKills');
          fx({ t: 'ring', x: cr.x, y: cr.y, color: '#ffc23a', life: 1.4, r: 180 });
        }
      } else if (cr.type === 'drone') {
        const boss = cr.owner;
        if (!boss || boss.gone) { cr.gone = true; continue; }
        if (cr.state === 'orbit') {
          cr.a += 1.6 * dt;
          moveToward(cr, boss.x + Math.cos(cr.a) * 70, boss.y + Math.sin(cr.a) * 70, 230, dt);
          if ((cr.diveT -= dt) <= 0) {
            cr.diveT = rand(1.5, 3);
            let best = null, bd = 1e9;
            for (const w of workersNear(cr.x, cr.y, 200)) { const d = dist(w.x, w.y, cr.x, cr.y); if (d < bd) { bd = d; best = w; } }
            if (best) { cr.prey = best; cr.state = 'dive'; }
          }
        } else {
          const p = cr.prey;
          if (!p || p.dead || dist(p.x, p.y, boss.x, boss.y) > 320) cr.state = 'orbit';
          else if (moveToward(cr, p.x, p.y, 260, dt) < 10) { killWorker(p); cr.state = 'orbit'; cr.diveT = rand(1.5, 3); }
        }
        hurtCreature(cr, crContacts(cr.x, cr.y, cr.r + 2), 10, dt);
        if (cr.hp <= 0) cr.gone = true;
      }
    }
    if (creatures.some(c => c.gone)) creatures = creatures.filter(c => !c.gone);
  }

  function startMapEvent(type) {
    lastEvent = type;
    for (const h of humans()) lifeAdd(h, 'events');
    if (!['rain', 'picnic', 'quake', 'flight'].includes(type)) return startExtraEvent(type);
    if (type === 'rain') {
      raining = RAIN_TIME;
      bannerAll('RAINSTORM!', 'Everyone slows down - food washes toward the edges', '#8fd0ff', 3, 46);
      fx({ t: 'sfx', name: 'thunder' }); fx({ t: 'shake', a: 4 });
    } else if (type === 'picnic') {
      let x, y;
      for (let t = 0; t < 40; t++) { x = rand(400, WORLD_W - 400); y = rand(350, WORLD_H - 350); if (!inRock(x, y, 120)) break; }
      for (let i = 0; i < 90; i++) { const a = rand(0, TAU), r = Math.sqrt(Math.random()) * 95; spawnFood(x + Math.cos(a) * r, y + Math.sin(a) * r); }
      picnic = { x, y, t: 25 };
      fx({ t: 'ring', x, y, color: '#ff8a8a', life: 1.5, r: 160 });
      bannerAll('PICNIC DROP!', 'A feast just landed - check the minimap and race for it!', '#ff9a8a', 3, 46);
      fx({ t: 'sfx', name: 'event' });
    } else if (type === 'quake') {
      quakeTime = 2.2;
      placeTunnels(Math.max(1, tunnels.length / 2));
      for (const c of colonies) c.tunnelCd = Math.max(c.tunnelCd, 1.5);
      bannerAll('EARTHQUAKE!', 'The tunnels have shifted', '#e0b070', 3, 46);
      fx({ t: 'sfx', name: 'thunder' }); fx({ t: 'shake', a: 14 });
    } else if (type === 'flight') {
      for (let i = 0; i < 4; i++) {
        const c = spawnEnemy(randInt(3, 6));
        fx({ t: 'ring', x: c.queen.x, y: c.queen.y, color: '#fff2b0', life: 1.6, r: 110 });
      }
      bannerAll('MATING FLIGHT!', 'New queens are settling all over the map', '#fff2b0', 3, 46);
      fx({ t: 'sfx', name: 'event' });
    }
  }
  function updateMapEvents(dt) {
    eventTimer -= dt;
    if (eventTimer <= 0) {
      eventTimer = rand(75, 110);
      const options = EVENT_TYPES.filter(e => e !== lastEvent);
      startMapEvent(options[randInt(0, options.length - 1)]);
    }
    if (raining > 0) {
      raining -= dt;
      for (const f of food) {
        if (Math.min(f.x, WORLD_W - f.x) < Math.min(f.y, WORLD_H - f.y)) f.x = clamp(f.x + (f.x < WORLD_W / 2 ? -1 : 1) * 14 * dt, 12, WORLD_W - 12);
        else f.y = clamp(f.y + (f.y < WORLD_H / 2 ? -1 : 1) * 14 * dt, 12, WORLD_H - 12);
      }
    }
    if (quakeTime > 0) quakeTime -= dt;
    if (picnic && (picnic.t -= dt) <= 0) picnic = null;
    updateExtraEvents(dt);
  }
  function updatePowerAndStructures(dt) {
    for (const c of colonies) {
      if (!c.alive) continue;
      if (c.frenzy > 0) c.frenzy -= dt;
      if (c.rush > 0) c.rush -= dt;
      if (c.tunnelCd > 0) c.tunnelCd -= dt;
    }
    powerTimer -= dt;
    if (powerTimer <= 0) {
      powerTimer = rand(6, 11);
      if (powerups.length < POWERUP_MAX) spawnPowerup();
    }
    for (const pu of powerups) {
      if (pu.dead) continue;
      let taker = null;
      for (const c of colonies) {
        if (c.alive && dist(c.queen.x, c.queen.y, pu.x, pu.y) < QUEEN_R + 10) { taker = c; break; }
      }
      if (!taker) {
        const gx = clamp((pu.x / CELL) | 0, 0, GCOLS - 1), gy = clamp((pu.y / CELL) | 0, 0, GROWS - 1);
        for (let yy = Math.max(0, gy - 1); yy <= Math.min(GROWS - 1, gy + 1) && !taker; yy++)
          for (let xx = Math.max(0, gx - 1); xx <= Math.min(GCOLS - 1, gx + 1) && !taker; xx++)
            for (const w of antGrid[yy * GCOLS + xx])
              if (!w.dead && w.col.alive && dist(w.x, w.y, pu.x, pu.y) < WORKER_R + 9) { taker = w.col; break; }
      }
      if (taker) applyPower(taker, pu);
    }
    if (powerups.some(p => p.dead)) powerups = powerups.filter(p => !p.dead);
    for (const g of gardens) {
      const inside = colonies.filter(c => c.alive && dist(c.queen.x, c.queen.y, g.x, g.y) < GARDEN_R);
      g.contested = inside.length > 1;
      if (inside.length === 1) {
        if (g.owner !== inside[0]) g.acc = 0;
        g.owner = inside[0];
        g.acc += dt;
        if (g.acc >= GARDEN_RATE) {
          g.acc -= GARDEN_RATE;
          const c = g.owner;
          c.food++;
          if (c.food >= FOOD_PER_WORKER) { c.food -= FOOD_PER_WORKER; c.births++; }
          if (c.human) { sfx(c, 'garden'); lifeAdd(c, 'gardenFood'); }
        }
      } else { g.owner = null; g.acc = 0; }
    }
    for (const c of colonies) {
      if (!c.alive || c.tunnelCd > 0) continue;
      for (const h of tunnels) {
        if (dist(c.queen.x, c.queen.y, h.x, h.y) < HOLE_R) { teleport(c, h, tunnels[h.pair]); break; }
      }
    }
  }

  // ============================================================
  //  Main update (one fixed step)
  // ============================================================
  function update(dt) {
    time += dt; stepNo++;
    for (const c of colonies) {
      if (!c.alive) continue;
      if (c.human) updateHuman(c, dt); else updateAI(c, dt);
      if (c.grace > 0) c.grace -= dt;
      if (c.charge > 0) {
        c.charge -= dt;
        if (c.charge <= 0) { c.charge = 0; c.chargeCd = c.human ? PLAYER_CHARGE_CD : AI_CHARGE_CD * rand(0.8, 1.3); }
      } else if (c.chargeCd > 0) c.chargeCd -= dt;
    }
    buildGrids();
    interactions(dt);
    // A colony with no enemy near its ring and no charge running moves its guards on alternate
    // steps with a double time step: clients only get 30 snapshots a second, so it looks the same.
    for (const c of colonies) {
      if (!c.alive) continue;
      if (c.calm && c.charge <= 0 && !c.wasCharging) {
        if ((stepNo + c.id) % 2) updateWorkers(c, dt * 2);
      } else updateWorkers(c, dt);
      c.wasCharging = c.charge > 0;
    }
    // the grid from the start of the step is reused: ants only moved a few pixels, well inside the 3x3 cell search
    antQueenContacts();
    queenCollisions();
    updatePowerAndStructures(dt);
    updateMapEvents(dt);
    updateCreatures(dt);
    colonies = colonies.filter(c => c.alive);

    if (food.length < FOOD_MAX) {
      foodAccum += FOOD_RESPAWN_RATE * dt;
      while (foodAccum >= 1 && food.length < FOOD_MAX) {
        foodAccum -= 1;
        if (Math.random() < 0.3) {
          const x = rand(40, WORLD_W - 40), y = rand(40, WORLD_H - 40);
          for (let i = 0; i < 4 && food.length < FOOD_MAX; i++) spawnFood(x + rand(-25, 25), y + rand(-25, 25));
        } else spawnFood();
      }
    }

    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      let psize = 0;
      for (const h of humans()) psize = Math.max(psize, colonySize(h));
      spawnTimer = (rand(3, 8) + Math.min(5, psize * 0.02)) * D.spawn;
      if (enemyCount() < MAX_ENEMIES) spawnEnemy(randInt(3, 10));
    }

    // per-human progress: peak size, growth milestones (crown upgrades everyone can see)
    for (const c of humans()) {
      const n = colonySize(c), st = c.st;
      st.peak = Math.max(st.peak, n);
      while (st.milestone < MILESTONES.length && n >= MILESTONES[st.milestone].at) {
        personal(c, { t: 'milestone', i: st.milestone });
        st.milestone++;
        c.crownLevel = st.milestone;
      }
    }
  }

  // ============================================================
  //  Snapshots: what one client sees
  // ============================================================
  const r1 = v => Math.round(v * 10) / 10;
  function mapData() {
    return {
      t: 'map', v: mapVersion, diff: diffKey,
      rocks: rocks.map(k => ({ x: r1(k.x), y: r1(k.y), r: r1(k.r), tone: k.tone, pts: k.pts.map(p => [r1(p[0]), r1(p[1])]) })),
      puddles: puddles.map(p => ({ x: r1(p.x), y: r1(p.y), rx: r1(p.rx), ry: r1(p.ry), rot: Math.round(p.rot * 1000) / 1000 })),
      gardens: gardens.map(g => ({ x: r1(g.x), y: r1(g.y), shrooms: g.shrooms.map(s => ({ dx: r1(s.dx), dy: r1(s.dy), r: r1(s.r), tone: Math.round(s.tone * 100) / 100 })) })),
      tunnels: tunnels.map(h => ({ x: r1(h.x), y: r1(h.y), pair: h.pair, group: h.group })),
    };
  }

  // Build the message for one client. `view` = {x, y, hw, hh} (camera centre and half-size in world units),
  // `known` = Set of colony ids whose static info this client already has.
  function snapshotFor(session) {
    const v = session.view, me = session.colony;
    const m = S.NET.VIEW_MARGIN;
    const L = v.x - v.hw - m, R = v.x + v.hw + m, T = v.y - v.hh - m, B = v.y + v.hh + m;
    const inV = (x, y) => x > L && x < R && y > T && y < B;
    const cols = [], far = [], info = {}, antCounts = [], groups = [];
    session.snapNo = (session.snapNo || 0) + 1;
    const sendFar = session.snapNo % 6 === 1;   // far-away colonies only feed the minimap and leaderboard: 5 times a second is plenty
    let nAnts = 0;
    for (const c of colonies) {
      if (!c.alive) continue;
      const q = c.queen, n = c.workers.length;
      if (!session.known.has(c.id)) {
        session.known.add(c.id);
        info[c.id] = [c.name, c.color, c.skinId, c.crownColor, c.human ? 1 : 0];
      }
      const near = Math.abs(q.x - v.x) < v.hw + m + c.outerR + 60 && Math.abs(q.y - v.y) < v.hh + m + c.outerR + 60;
      if (!near) { if (sendFar) far.push([c.id, Math.round(q.x), Math.round(q.y), n]); continue; }
      const flags = (c.frenzy > 0 ? 1 : 0) | (c.rush > 0 ? 2 : 0) | (c.charge > 0 ? 4 : 0) | (c.human ? 8 : 0);
      cols.push([c.id, r1(q.x), r1(q.y), n, Math.round(q.ang * 100) / 100, Math.round(c.outerR), flags,
        r1(Math.max(0, c.grace)), r1(Math.max(0, c.tunnelCd)), Math.round(c.chargeX), Math.round(c.chargeY), c.crownLevel,
        r1(Math.max(0, c.charge)), r1(Math.max(0, c.chargeCd))]);
      const vis = [];
      for (const w of c.workers) if (inV(w.x, w.y)) vis.push(w);
      if (vis.length) { vis.sort((a, b) => a.id - b.id); antCounts.push(c.id, vis.length); groups.push(vis); nAnts += vis.length; }
    }

    const creat = creatures.map(cr => [cr.id, cr.type, r1(cr.x), r1(cr.y), Math.round(cr.ang * 100) / 100, Math.round(cr.hp), cr.max,
      cr.state === 'flipped' ? 1 : 0, cr.hitFlash > 0 ? 1 : 0, cr.munch > 0 ? 1 : 0, cr.webR || 0, cr.webSeed ? Math.round(cr.webSeed * 1000) / 1000 : 0]);
    const ev = {};
    if (raining > 0) ev.rain = r1(raining);
    if (quakeTime > 0) ev.quake = r1(quakeTime);
    if (picnic) ev.picnic = [Math.round(picnic.x), Math.round(picnic.y), r1(picnic.t)];
    if (magnifier) ev.mag = [r1(magnifier.x), r1(magnifier.y), r1(magnifier.t)];
    if (flood) ev.flood = [flood.side, r1(flood.t), flood.dur];
    if (migration) ev.mig = r1(migration.t);
    if (nightT > 0) ev.night = r1(nightT);
    if (bloodMoon > 0) ev.blood = r1(bloodMoon);
    if (sugarRain > 0) ev.sugar = r1(sugarRain);
    if (golden) ev.golden = [Math.round(golden.x), Math.round(golden.y), Math.round(golden.progress * 1000) / 1000, golden.lead ? golden.lead.id : 0];

    const head = {
      t: 'snap', time: Math.round(time * 1000) / 1000, me: me && me.alive ? me.id : 0, mapV: mapVersion,
      cols, info, ac: antCounts,
      pu: powerups.map(p => [p.id, Math.round(p.x), Math.round(p.y), p.type === 'frenzy' ? 0 : 1]),
      gd: gardens.map(g => [g.owner ? g.owner.id : 0, g.contested ? 1 : 0, Math.round(g.acc * 20) / 20]),
      cr: creat, ev,
    };
    if (sendFar) head.far = far;
    // unchanged since the last snapshot to this client? leave it out (the client keeps the previous value)
    const last = session.lastParts || (session.lastParts = {});
    for (const key of ['pu', 'gd', 'ev', 'cr']) {
      const str = JSON.stringify(head[key]);
      if (last[key] === str) delete head[key]; else last[key] = str;
    }
    if (me && me.alive) head.st = { k: me.st.kills, s: me.st.streak, lc: Math.round(me.st.lastConquer * 100) / 100, sp: Math.round(speedFactor(me) * 100), fd: me.food };
    if (head.st) { const str = JSON.stringify(head.st); if (last.st === str) delete head.st; else last.st = str; }
    // Binary part, sent as changes since the last snapshot this client received (WebSocket delivery is
    // reliable and in order, so both sides always share the same baseline).
    // Ants: per colony, sorted by id: varint(idGap * 2 + full), then
    //   full:  u16 x, u16 y (1/8 px), u8 angle        delta: i8 dx, i8 dy (1/8 px), u8 angle
    // Food: varint count of removed ids (varint id gaps), then added/moved crumbs: varint id gap, u16 x, u16 y, u8 r|honey
    const out = session.enc || (session.enc = Buffer.allocUnsafe(64 * 1024));
    let buf = out, o = 0;
    const need = n => { if (o + n > buf.length) { const nb = Buffer.allocUnsafe(Math.max(buf.length * 2, o + n)); buf.copy(nb, 0, 0, o); buf = nb; session.enc = nb; } };
    const varint = v => { need(5); while (v >= 128) { buf[o++] = (v % 128) | 128; v = Math.floor(v / 128); } buf[o++] = v; };
    const prevA = session.prevAnts || new Map(), nextA = new Map();
    for (const vis of groups) {
      let last = 0;
      for (const w of vis) {
        const qx = Math.round(clamp(w.x, 0, 4095) * 8), qy = Math.round(clamp(w.y, 0, 4095) * 8);
        const qa = Math.round(((w.ang % TAU) + TAU) % TAU / TAU * 255) & 255;
        const p = prevA.get(w.id);
        const dx = p ? qx - p[0] : 999, dy = p ? qy - p[1] : 999;
        const full = !(dx >= -127 && dx <= 127 && dy >= -127 && dy <= 127);
        varint((w.id - last) * 2 + (full ? 1 : 0));
        last = w.id;
        need(5);
        if (full) { buf.writeUInt16LE(qx, o); buf.writeUInt16LE(qy, o + 2); buf[o + 4] = qa; o += 5; }
        else { buf.writeInt8(dx, o); buf.writeInt8(dy, o + 1); buf[o + 2] = qa; o += 3; }
        nextA.set(w.id, [qx, qy]);
      }
    }
    session.prevAnts = nextA;
    const prevF = session.prevFood || new Map(), nextF = new Map(), adds = [];
    for (const f of food) {
      if (!inV(f.x, f.y)) continue;
      const qx = Math.round(clamp(f.x, 0, 4095) * 8), qy = Math.round(clamp(f.y, 0, 4095) * 8);
      const key = qx * 65536 + qy;
      nextF.set(f.id, key);
      if (prevF.get(f.id) !== key) adds.push([f.id, qx, qy, Math.min(127, Math.round(f.r * 20)) | (f.honey ? 128 : 0)]);
    }
    const removed = [];
    for (const id of prevF.keys()) if (!nextF.has(id)) removed.push(id);
    removed.sort((a, b) => a - b);
    varint(removed.length);
    let lastR = 0;
    for (const id of removed) { varint(id - lastR); lastR = id; }
    adds.sort((a, b) => a[0] - b[0]);
    varint(adds.length);
    let lastF = 0;
    for (const [id, qx, qy, r] of adds) { varint(id - lastF); lastF = id; need(5); buf.writeUInt16LE(qx, o); buf.writeUInt16LE(qy, o + 2); buf[o + 4] = r; o += 5; }
    session.prevFood = nextF;
    return { head, bin: buf.subarray(0, o) };
  }

  function takeEvents() { const e = events; events = []; return e; }
  // test hooks (only reachable when the server runs with COLONY_DEBUG=1)
  function debug(cmd, c) {
    if (EVENT_TYPES.includes(cmd)) startMapEvent(cmd);
    else if (['spider', 'ladybug', 'wasp', 'bee'].includes(cmd)) spawnCreature(cmd);
    else if (cmd === 'grow' && c) c.births += 60;
    else if (cmd === 'die' && c && c.alive) {
      const k = colonies.find(o => o !== c && o.alive && !o.human) || colonies.find(o => o !== c && o.alive);
      if (k) conquer(k, c, { via: 'ant', attackerCharging: true });
    }
  }

  resetWorld();
  return {
    diff: diffKey,
    update, addHuman, releaseHuman, humanCharge, snapshotFor, mapData, takeEvents, debug,
    get mapVersion() { return mapVersion; },
    get time() { return time; },
    get colonies() { return colonies; },
    biggestColony,
    stats() { return { colonies: colonies.length, ants: colonies.reduce((a, c) => a + c.workers.length, 0), food: food.length, creatures: creatures.length }; },
  };
}

module.exports = { createWorld };
