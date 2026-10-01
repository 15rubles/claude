'use strict';
/* global SHARED */
const {
  TAU, WORLD_W, WORLD_H, QUEEN_R, WORKER_R, FOOD_R, PLAYER_SPEED, CHARGE_TIME, PLAYER_CHARGE_CD, RING0, FOOD_PER_WORKER,
  PLAYER_COLOR, SKINS, CELL, FRENZY_TIME, RUSH_TIME, RUSH_SPEED, GARDEN_R, GARDEN_RATE, HOLE_R, TUNNEL_CD, POWER_INFO,
  TUNNEL_COLORS, PALETTE, STREAK_WINDOW, STREAK_NAMES, MILESTONES, RAIN_TIME, DIFFS, NET,
} = SHARED;

// ============================================================
//  Constants
// ============================================================
// Player skins: restyle the queen and every worker in her colony
let selectedSkin = 0;
try { const i = SKINS.findIndex(k => k.id === localStorage.getItem('qoth-skin')); if (i >= 0) selectedSkin = i; } catch (e) {}
// power-ups & structures

// ============================================================
//  Helpers
// ============================================================
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
  if (amt < 0) { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
  else { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
// perceived brightness of a #rrggbb colour, to pick readable text on top of it
function isDarkColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}
function fmtTime(s) {
  s = Math.floor(s);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ============================================================
//  Canvas / input
// ============================================================
const canvas = document.getElementById('game');
let ctx = canvas.getContext('2d', { alpha: false });   // swapped briefly while caching HUD layers
let W = 0, H = 0, DPR = 1;
// Render resolution: capped on very sharp screens and lowered automatically
// when the frame rate drops (see adaptQuality()).
let quality = 1;
function resize() {
  DPR = Math.min(1.5, window.devicePixelRatio || 1) * quality;
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.floor(W * DPR); canvas.height = Math.floor(H * DPR);
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
}
window.addEventListener('resize', resize);
resize();

const mouse = { x: 0, y: 0, moved: false };
window.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.moved = true; });
canvas.addEventListener('touchstart', e => {
  const t = e.touches[0];
  mouse.x = t.clientX; mouse.y = t.clientY; mouse.moved = true;
  if (e.touches.length >= 2) tryPlayerCharge();   // two-finger tap = charge on touch devices
  e.preventDefault();
}, { passive: false });
canvas.addEventListener('touchmove', e => {
  const t = e.touches[0];
  mouse.x = t.clientX; mouse.y = t.clientY; e.preventDefault();
}, { passive: false });
canvas.addEventListener('mousedown', e => {
  if (e.button === 0) tryPlayerCharge();
});
window.addEventListener('keydown', e => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) tryPlayerCharge();
  } else if (e.code === 'KeyM') {
    startMusic();
    toggleMusic();
  } else if (e.code === 'Escape') {
    if (state === 'playing') openOptions(); else if (state === 'paused') closeOptions();
  } else if (e.code === 'Enter') {
    if ((state === 'title' || state === 'over' || state === 'victory') && document.activeElement.tagName !== 'INPUT') startGame();
  }
});

// ============================================================
//  Game state
// ============================================================
let state = 'title';     // title | playing | paused | over | victory
let colonies = [];
let food = [];
let particles = [];      // ground splats + flecks
let floaters = [];       // floating text / rings
let player = null;
let uid = 1;
let time = 0;
let spawnTimer = 10;
let foodAccum = 0;
let powerups = [], gardens = [], tunnels = [];
// game feel
let shake = 0, shakeX = 0, shakeY = 0, hitStop = 0, deathTimer = 0;
let banners = [];   // big screen-space announcements
function addShake(a) { shake = Math.max(shake, a); }
function addBanner(text, sub, color, life = 2.2, size = 44) {
  banners.push({ text, sub, color, life, max: life, size });
  if (banners.length > 4) banners.shift();
}
let powerTimer = 5;
// terrain obstacles and map events
let rocks = [], puddles = [];
let eventTimer = 60, raining = 0, quakeTime = 0, picnic = null, lastEvent = '';
let creatures = [], creatureTimer = 30, bossTimer = 300;
let magnifier = null, flood = null, migration = null, golden = null;
let nightT = 0, bloodMoon = 0, sugarRain = 0, sugarRainT = 0;
let stats = { start: 0, kills: 0, peak: 0, finalSize: 0, killedBy: '', endTime: 0 };
const cam = { x: WORLD_W / 2, y: WORLD_H / 2, zoom: 0.8 };

// ============================================================
//  Entity creation
// ============================================================

function colonySize(c) { return c.n !== undefined ? c.n : c.workers.length; }

// ============================================================
//  World setup
// ============================================================

function screenToWorld(sx, sy) {
  return { x: cam.x + (sx - W / 2) / cam.zoom, y: cam.y + (sy - H / 2) / cam.zoom };
}

// ============================================================
//  Grids, fights, food
// ============================================================

function sparks(x, y) {
  for (let i = 0; i < 2; i++) {
    const a = rand(0, TAU), s = rand(40, 110);
    particles.push({ type: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, color: '#fff3c0', life: 0.25, max: 0.25, r: 1.2 });
  }
}

// ============================================================
//  Enemy ant touches a queen: that queen's colony is conquered
// ============================================================
// Smaller colonies move faster: ~1.3x with a handful of ants, down to 0.85x at 150+.
function speedFactor(c) {
  const base = 0.85 + 0.45 * (1 - Math.sqrt(Math.min(1, c.workers.length / 150)));
  return c.rush > 0 ? base * RUSH_SPEED : base;
}

// ============================================================
//  Queen vs queen: conquest
// ============================================================

// ---- growth milestones: celebration, crown upgrade, permanent skin unlock ----
function reachMilestone(m) {
  addBanner(m.title, m.perk, '#9fe08a', 2.6, 46);
  addShake(5);
  playSfx('milestone');
  const q = player.queen, cols = ['#ffd54a', '#ff6a8a', '#6ad0ff', '#9fe08a', '#ffffff', player.color];
  for (let i = 0; i < 60; i++) {   // confetti burst
    const a = rand(0, TAU), sp = rand(120, 360);
    particles.push({ type: 'spark', x: q.x, y: q.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, color: cols[i % cols.length], life: rand(0.8, 1.4), max: 1.4, r: rand(1.8, 3.2) });
  }
  floaters.push({ type: 'ring', x: q.x, y: q.y, color: '#9fe08a', life: 1, max: 1, r: 140 });
}

// ---- death replay: slow-motion zoom on whoever got you, then Game Over ----
const DEATH_TIPS = {
  queen: 'Tip: never touch a queen whose colony is bigger - red size tags mean danger.',
  selfCharge: 'Tip: charging sends your guards away. Only charge when no rival is close enough to strike back.',
  charged: 'Tip: stand still when a colony charges you - a braced guard ring holds the wall.',
  running: 'Tip: a running ring is thin. Keep your distance from rivals, or stop and brace.',
  overrun: 'Tip: grab Fire Chili before a big fight, and use tunnels to escape bigger colonies.',
};
function startDeathCam(killer) {
  state = 'dying';
  deathTimer = 2.3;
  hitStop = 0.25;
  addShake(14);
  addBanner('CONQUERED!', `by ${killer.name}`, '#ff6a5a', 2.3, 52);
  document.getElementById('optionsBtn').classList.add('hidden');
  playSfx('lose');
}

// ---- high score (kept in this browser) ----
const best = { peak: 0, kills: 0, time: 0, wins: 0 };
try { Object.assign(best, JSON.parse(localStorage.getItem('qoth-best') || '{}')); } catch (e) {}
function recordBest(won, survived) {
  const newRecord = stats.peak > best.peak;
  if (newRecord && player && player.skin) best.skin = player.skin.id;   // the ghost rival wears this
  best.peak = Math.max(best.peak, stats.peak);
  best.kills = Math.max(best.kills, stats.kills);
  best.time = Math.max(best.time, survived);
  if (won) best.wins++;
  try { localStorage.setItem('qoth-best', JSON.stringify(best)); } catch (e) {}
  renderBest();
  return newRecord;
}
// ---- colony level / XP and cosmetics ----
const prog = { xp: 0, level: 1, crown: 'gold', trail: 'none', kfx: 'none' };
try { Object.assign(prog, JSON.parse(localStorage.getItem('qoth-prog') || '{}')); } catch (e) {}
function saveProg() { try { localStorage.setItem('qoth-prog', JSON.stringify(prog)); } catch (e) {} }
function xpNeeded(l) { return Math.min(1000, 150 + (l - 1) * 90); }   // ramps up, then 1000 XP per level to 100
while (prog.xp >= xpNeeded(prog.level)) { prog.xp -= xpNeeded(prog.level); prog.level++; }   // settle saved progress
const TITLES = [[1, 'Larva'], [2, 'Egg Carrier'], [3, 'Forager'], [5, 'Soldier'], [7, 'Hive Mother'], [10, 'Swarm Lord'], [14, 'Empress'], [18, 'Queen of Queens'],
  [25, 'Warlord'], [35, 'Matriarch'], [50, 'Grand Matriarch'], [70, 'Hive Deity'], [90, 'Living Legend'], [100, 'Eternal Queen']];
function titleFor(l) { let t = TITLES[0][1]; for (const [lv, n] of TITLES) if (l >= lv) t = n; return t; }
const COSMETICS = {
  crown: [
    { id: 'gold', name: 'Gold', level: 1, color: '#ffd700' },
    { id: 'silver', name: 'Silver', level: 3, color: '#e4ebf2' },
    { id: 'ruby', name: 'Ruby', level: 6, color: '#e0304a' },
    { id: 'emerald', name: 'Emerald', level: 9, color: '#2ed070' },
    { id: 'diamond', name: 'Diamond', level: 13, color: '#c8f6ff' },
    { id: 'obsidian', name: 'Obsidian', level: 17, color: '#3a2c5a' },
  ],
  trail: [
    { id: 'none', name: 'None', level: 1 },
    { id: 'sparkle', name: 'Sparkle', level: 2 },
    { id: 'fire', name: 'Fire', level: 5 },
    { id: 'leaves', name: 'Leaves', level: 8 },
    { id: 'rainbow', name: 'Rainbow', level: 11 },
    { id: 'stars', name: 'Starfall', level: 15 },
  ],
  kfx: [
    { id: 'none', name: 'Classic', level: 1 },
    { id: 'confetti', name: 'Confetti', level: 4 },
    { id: 'shock', name: 'Shockwave', level: 7 },
    { id: 'fireworks', name: 'Fireworks', level: 12 },
    { id: 'crown', name: 'Crown Rain', level: 16 },
  ],
};
const COS_LABEL = { crown: 'Crown', trail: 'Trail', kfx: 'Conquest FX' };
function levelRewards(l) {
  const out = [];
  if (l === 100 || (l % 10 === 0 && l <= 90)) out.push(`Badge: ${BADGE_NAMES[badgeTier(l)]}`);
  for (const [lv, n] of TITLES) if (lv === l) out.push(`Title: ${n}`);
  for (const k of Object.keys(COSMETICS)) for (const o of COSMETICS[k]) if (o.level === l) out.push(`${COS_LABEL[k]}: ${o.name}`);
  return out;
}
function awardXP(amount) {
  const from = prog.level, fromXp = prog.xp;
  prog.xp += Math.round(amount);
  while (prog.xp >= xpNeeded(prog.level)) { prog.xp -= xpNeeded(prog.level); prog.level++; }
  saveProg(); renderProfile();
  const rewards = [];
  for (let l = from + 1; l <= prog.level; l++) rewards.push(...levelRewards(l));
  return { from, fromXp, to: prog.level, rewards };
}
function matchXP(won) {
  const parts = [['Growth', stats.peak * 2], ['Conquests', stats.kills * 25], ['Survival', Math.floor((stats.endTime || 0) / 2)]];
  if (won) parts.push(['Victory', 300]);
  if (stats.ghostBeaten) parts.push(['Past Self', 150]);
  const base = parts.reduce((a, p) => a + p[1], 0), mult = diff().xp;
  return { parts, mult, total: Math.round(base * mult) };
}
function trailSwatch(id) {
  if (id === 'none') return 'transparent';
  if (id === 'rainbow') return 'linear-gradient(90deg,#ff5a5a,#ffd24a,#5aff8a,#5ab0ff,#c07aff)';
  const c = TRAIL_COLORS[id]; return `linear-gradient(90deg,${c.join(',')})`;
}
function renderProfile() {
  const need = xpNeeded(prog.level);
  const bc = document.getElementById('lvlBadge');
  paintBadge(bc, 64, prog.level);
  bc.title = `${BADGE_NAMES[badgeTier(prog.level)]} badge - level ${prog.level}`;
  const row = document.getElementById('badgeRow');
  row.innerHTML = '';
  [1, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].forEach(l => {
    const cv = document.createElement('canvas');
    paintBadge(cv, 24, l, prog.level < l, false);
    cv.title = `${BADGE_NAMES[badgeTier(l)]} - ${prog.level >= l ? 'earned' : 'level ' + l}`;
    row.appendChild(cv);
  });
  document.getElementById('lvlTitle').textContent = titleFor(prog.level);
  document.getElementById('lvlBar').style.width = (prog.xp / need * 100) + '%';
  document.getElementById('lvlXp').textContent = `${prog.xp} / ${need} XP to level ${prog.level + 1}`;
  let next = null;
  for (let l = prog.level + 1; l < prog.level + 30 && !next; l++) { const r = levelRewards(l); if (r.length) next = `Next at Lv ${l}: ${r.join(', ')}`; }
  document.getElementById('lvlNext').textContent = next || '';
  const box = document.getElementById('cosmBox');
  box.innerHTML = '';
  for (const kind of Object.keys(COSMETICS)) {
    const all = COSMETICS[kind];
    const group = document.createElement('div');
    group.className = 'cosgroup';
    group.innerHTML = `<div class="coslabel">${COS_LABEL[kind]} <em>${all.filter(o => prog.level >= o.level).length}/${all.length}</em></div>`;
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const o of all) {
      const locked = prog.level < o.level;
      const chip = document.createElement('button');
      chip.className = 'chip' + (prog[kind] === o.id ? ' on' : '') + (locked ? ' locked' : '');
      chip.title = locked ? `${o.name} - unlocks at level ${o.level}` : o.name;
      const sw = kind === 'crown' ? `<i class="sw crownsw" style="background:${o.color}"></i>`
        : kind === 'trail' ? `<i class="sw${o.id === 'none' ? ' nosw' : ''}" style="background:${trailSwatch(o.id)}"></i>` : '';
      chip.innerHTML = `${sw}${o.name}${locked ? `<small>Lv ${o.level}</small>` : ''}`;
      chip.addEventListener('click', () => {
        if (locked) return;
        prog[kind] = o.id; saveProg(); renderProfile();
        if (kind === 'kfx') cosPrev.fxT = 0.05;   // show the new effect right away
      });
      chips.appendChild(chip);
    }
    group.appendChild(chips);
    box.appendChild(group);
  }
}
function showXP(boxId, x, res) {
  const box = document.getElementById(boxId);
  const need = xpNeeded(prog.level);
  const detail = x.parts.filter(p => p[1] > 0).map(p => `${p[0]} ${p[1]}`).join(' · ') + (x.mult !== 1 ? ` · ${diff().name} x${x.mult}` : '');
  const startPct = res.to > res.from ? 0 : (res.fromXp / need * 100);
  box.innerHTML = `<div class="xphead">+${x.total} XP <small>${detail}</small></div>
    <div class="xprow"><canvas class="xpbadge"></canvas><b>Lv ${prog.level}</b><div class="xpbar"><i style="width:${startPct}%"></i></div></div>
    ${res.to > res.from ? `<div class="lvlup">LEVEL UP! Level ${res.to} - ${titleFor(res.to)}${res.rewards.length ? '<br><small>Unlocked: ' + res.rewards.join(', ') + '</small>' : ''}</div>` : ''}`;
  paintBadge(box.querySelector('.xpbadge'), 34, prog.level);
  const bar = box.querySelector('.xpbar i');
  requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = (prog.xp / need * 100) + '%'; }));
  if (res.to > res.from) setTimeout(() => playSfx('milestone'), 500);
}

// ---- level badges: a new emblem every 10 levels up to 100 (ribbons from the 5th level of each tier) ----
const BADGE_NAMES = ['Egg', 'Bronze Shield', 'Silver Honeycomb', 'Gold Star', 'Winged Crest', 'Royal Crown', 'Crystal', 'Flame', 'Sunburst', 'Laurel Wreath', 'Eternal'];
function badgeTier(l) { return l >= 100 ? 10 : Math.floor(l / 10); }
function drawLevelBadge(g, cx, cy, R, level, dim = false, showNum = true) {
  const t = badgeTier(level);
  g.save();
  g.translate(cx, cy); g.scale(R / 30, R / 30);
  if (dim) g.globalAlpha = 0.3;
  g.lineJoin = 'round';
  const grad = (a, b, y0 = -30, y1 = 30) => { const gr = g.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, a); gr.addColorStop(1, b); return gr; };
  const poly = pts => { g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); };
  const edge = (c, w = 2.4) => { g.lineWidth = w; g.strokeStyle = c; g.stroke(); };
  const crown = (y, sc, fill = '#ffd54a') => {
    poly([[-11 * sc, y + 5 * sc], [-12 * sc, y - 5 * sc], [-6 * sc, y], [0, y - 8 * sc], [6 * sc, y], [12 * sc, y - 5 * sc], [11 * sc, y + 5 * sc]]);
    g.fillStyle = fill; g.fill(); edge('#7a5200', 1.4);
  };
  const laurel = (col) => {
    g.fillStyle = col;
    for (let side = -1; side <= 1; side += 2) for (let i = 0; i < 7; i++) {
      const a = Math.PI / 2 + side * (0.35 + i * 0.36), x = Math.cos(a) * 27, y = Math.sin(a) * 27;
      g.save(); g.translate(x, y); g.rotate(a + side * 0.9); g.beginPath(); g.ellipse(0, 0, 6, 2.6, 0, 0, TAU); g.fill(); g.restore();
    }
  };
  // ribbon tails for the upper half of each tier
  if (t < 10 && level % 10 >= 5) {
    const rc = ['#c9a0ff', '#e07a3a', '#8aa0b8', '#e0b020', '#6ab0ff', '#9a5ae0', '#2ac0e0', '#e0401a', '#f0a020', '#3aa060'][t];
    g.fillStyle = rc;
    poly([[-14, 14], [-6, 16], [-12, 34], [-15, 29], [-19, 33]]); g.fill();
    poly([[14, 14], [6, 16], [12, 34], [15, 29], [19, 33]]); g.fill();
  }
  let numY = 1, numCol = '#ffffff';
  switch (t) {
    case 0:   // egg
      g.beginPath(); g.ellipse(0, 2, 21, 27, 0, 0, TAU); g.fillStyle = grad('#fffaf0', '#e2d2a8'); g.fill(); edge('#8a7650');
      g.fillStyle = 'rgba(150,120,70,0.35)';
      for (const [x, y, r] of [[-9, -12, 2.2], [8, -6, 1.8], [-4, 14, 2], [11, 12, 1.6], [-13, 4, 1.4]]) { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }
      numCol = '#5a4020'; numY = 4; break;
    case 1:   // bronze shield
      g.beginPath(); g.moveTo(-23, -25); g.lineTo(23, -25); g.lineTo(23, -2); g.quadraticCurveTo(22, 20, 0, 30); g.quadraticCurveTo(-22, 20, -23, -2); g.closePath();
      g.fillStyle = grad('#f2b878', '#8a4a1a'); g.fill(); edge('#5a2a08');
      g.beginPath(); g.moveTo(-17, -19); g.lineTo(17, -19); g.lineTo(17, -3); g.quadraticCurveTo(16, 14, 0, 23); g.quadraticCurveTo(-16, 14, -17, -3); g.closePath(); edge('rgba(255,230,190,0.55)', 1.5);
      break;
    case 2: { // silver honeycomb
      const hex = r => poly([...Array(6)].map((_, i) => [Math.cos(i * Math.PI / 3 + Math.PI / 6) * r, Math.sin(i * Math.PI / 3 + Math.PI / 6) * r]));
      hex(29); g.fillStyle = grad('#f6f9fc', '#8494a6'); g.fill(); edge('#44525f');
      hex(21); edge('rgba(255,255,255,0.7)', 1.6);
      numCol = '#2a3440'; break;
    }
    case 3: { // gold star
      poly([...Array(10)].map((_, i) => { const r = i % 2 ? 14 : 31, a = -Math.PI / 2 + i * Math.PI / 5; return [Math.cos(a) * r, Math.sin(a) * r]; }));
      g.fillStyle = grad('#fff2a0', '#c08a10'); g.fill(); edge('#7a5200');
      numCol = '#5a3a00'; numY = 3; break;
    }
    case 4:   // winged crest
      g.fillStyle = grad('#ffffff', '#a8d4ff');
      for (let side = -1; side <= 1; side += 2) {
        g.beginPath(); g.moveTo(side * 8, -6);
        g.quadraticCurveTo(side * 36, -30, side * 34, -4); g.quadraticCurveTo(side * 30, 10, side * 8, 10); g.closePath(); g.fill(); edge('#4a78a8', 1.6);
      }
      g.beginPath(); g.moveTo(-15, -18); g.lineTo(15, -18); g.lineTo(15, 0); g.quadraticCurveTo(14, 16, 0, 24); g.quadraticCurveTo(-14, 16, -15, 0); g.closePath();
      g.fillStyle = grad('#ffe27a', '#c08a10'); g.fill(); edge('#7a5200');
      numCol = '#5a3a00'; break;
    case 5:   // royal crown on purple
      g.beginPath(); g.arc(0, 3, 26, 0, TAU); g.fillStyle = grad('#c8a0ff', '#4a1a90'); g.fill(); edge('#ffd54a', 3);
      crown(-15, 1.3); numY = 7; break;
    case 6:   // crystal gem
      poly([[-17, -24], [17, -24], [29, -9], [0, 30], [-29, -9]]); g.fillStyle = grad('#e2fdff', '#1a9ad0'); g.fill(); edge('#0a5a80');
      g.strokeStyle = 'rgba(255,255,255,0.65)'; g.lineWidth = 1.2; g.beginPath();
      g.moveTo(-29, -9); g.lineTo(29, -9); g.moveTo(-17, -24); g.lineTo(-8, -9); g.lineTo(0, 30); g.lineTo(8, -9); g.lineTo(17, -24); g.stroke();
      numY = -1; numCol = '#08384f'; break;
    case 7:   // flame
      g.beginPath(); g.moveTo(0, 30); g.bezierCurveTo(-28, 26, -26, -2, -12, -12); g.bezierCurveTo(-12, -2, -6, 0, -4, -4);
      g.bezierCurveTo(-8, -18, 0, -26, 4, -32); g.bezierCurveTo(6, -18, 26, -12, 24, 8); g.bezierCurveTo(22, 24, 12, 30, 0, 30); g.closePath();
      g.fillStyle = grad('#ffe070', '#e0301a', -32, 30); g.fill(); edge('#7a1a08');
      g.beginPath(); g.ellipse(0, 14, 9, 12, 0, 0, TAU); g.fillStyle = 'rgba(255,240,170,0.8)'; g.fill();
      numY = 11; numCol = '#7a1a08'; break;
    case 8:   // sunburst
      g.fillStyle = '#ffc93a';
      for (let i = 0; i < 16; i++) { const a = i / 16 * TAU; poly([[Math.cos(a - 0.12) * 18, Math.sin(a - 0.12) * 18], [Math.cos(a) * 32, Math.sin(a) * 32], [Math.cos(a + 0.12) * 18, Math.sin(a + 0.12) * 18]]); g.fill(); }
      g.beginPath(); g.arc(0, 0, 20, 0, TAU); g.fillStyle = grad('#fff2a0', '#f07a10'); g.fill(); edge('#9a4a00');
      numCol = '#7a3000'; break;
    case 9:   // laurel wreath
      laurel('#4aa040');
      g.beginPath(); g.arc(0, 2, 19, 0, TAU); g.fillStyle = grad('#b890ff', '#4a1a90'); g.fill(); edge('#ffd54a', 2);
      crown(-22, 0.9); numY = 4; break;
    default: { // 100: eternal - prismatic rays, laurel and crown
      for (let i = 0; i < 20; i++) { const a = i / 20 * TAU; g.fillStyle = `hsl(${i * 18},90%,65%)`; poly([[Math.cos(a - 0.1) * 16, Math.sin(a - 0.1) * 16], [Math.cos(a) * 33, Math.sin(a) * 33], [Math.cos(a + 0.1) * 16, Math.sin(a + 0.1) * 16]]); g.fill(); }
      laurel('#ffd54a');
      g.beginPath(); g.arc(0, 2, 18, 0, TAU); g.fillStyle = grad('#fff6c8', '#e0a010'); g.fill(); edge('#7a5200', 2);
      crown(-21, 0.95, '#ffffff'); numY = 4; numCol = '#5a3a00';
    }
  }
  if (showNum) {
    const txt = String(level);
    g.font = `900 ${txt.length > 2 ? 15 : 19}px "Trebuchet MS", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (numCol === '#ffffff') { g.lineWidth = 3.5; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.strokeText(txt, 0, numY); }
    g.fillStyle = numCol; g.fillText(txt, 0, numY);
  }
  g.restore();
}
function paintBadge(cv, size, level, dim = false, showNum = true) {
  const d = Math.min(2, window.devicePixelRatio || 1);
  cv.width = size * d; cv.height = size * d; cv.style.width = size + 'px'; cv.style.height = size + 'px';
  const g = cv.getContext('2d');
  g.setTransform(d, 0, 0, d, 0, 0);
  drawLevelBadge(g, size / 2, size / 2, size * 0.42, level, dim, showNum);
}

// cosmetic effects in play
const TRAIL_COLORS = { sparkle: ['#ffffff', '#fff2a0'], fire: ['#ff9a2a', '#ff5a1a', '#ffd23a'], leaves: ['#6fbf3a', '#9fd84a', '#4a9a2a'], stars: ['#ffffff', '#ffe27a'] };
function trailParticle(x, y, t, s = 1) {
  const color = t === 'rainbow' ? `hsl(${(time * 300) % 360},90%,62%)` : TRAIL_COLORS[t][randInt(0, TRAIL_COLORS[t].length - 1)];
  const big = t === 'stars' && Math.random() < 0.2, life = t === 'leaves' || t === 'stars' ? 0.9 : 0.55;
  return { type: 'trail', x: x + rand(-5, 5) * s, y: y + rand(-5, 5) * s, vx: rand(-15, 15) * s, vy: (t === 'fire' ? rand(-50, -20) : rand(-15, 15)) * s,
    color, life, max: life, r: (big ? 3.2 : rand(1.3, 2.4)) * Math.max(0.7, s) };
}
function spawnTrail(q) {
  const s = Math.hypot(q.vx, q.vy) || 1;
  particles.push(trailParticle(q.x - q.vx / s * 16, q.y - q.vy / s * 16, prog.trail));
}
// conquest effect into any particle (P) / ring (F) list, scaled by s (the menu preview uses a small scale)
function killFxInto(x, y, k, P, F, s = 1, baseColor = '#ffd54a') {
  if (k === 'confetti') {
    const cols = ['#ffd54a', '#ff6a8a', '#6ad0ff', '#9fe08a', '#c9a0ff', '#ffffff'];
    for (let i = 0; i < 60; i++) { const a = rand(0, TAU), sp = rand(150, 380) * s; P.push({ type: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, color: cols[i % cols.length], life: rand(1, 1.6), max: 1.6, r: rand(2, 3.2) * Math.max(0.6, s) }); }
  } else if (k === 'shock') {
    [[160, 0.6, '#ffffff'], [240, 0.8, '#ffd54a'], [330, 1, '#ffffff']].forEach(([r, l, c]) => F.push({ type: 'ring', x, y, color: c, life: l, max: l, r: r * s }));
  } else if (k === 'fireworks') {
    const cols = ['#ff5a5a', '#5ad0ff', '#ffe24a', '#9f7aff', '#6aff9a'];
    for (let b = 0; b < 4; b++) {
      const cx = x + rand(-130, 130) * s, cy = y + rand(-130, 130) * s, col = cols[randInt(0, cols.length - 1)];
      for (let i = 0; i < 22; i++) { const a = i / 22 * TAU, sp = rand(160, 230) * s; P.push({ type: 'spark', x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, color: col, life: 1.1, max: 1.1, r: 2.2 * Math.max(0.6, s) }); }
      F.push({ type: 'ring', x: cx, y: cy, color: col, life: 0.5, max: 0.5, r: 50 * s });
    }
  } else if (k === 'crown') {
    for (let i = 0; i < 14; i++) P.push({ type: 'crown', x: x + rand(-90, 90) * s, y: y + rand(-90, 60) * s, vx: rand(-20, 20) * s, vy: rand(-160, -60) * s, color: '#ffd700', life: 1.6, max: 1.6, r: rand(5, 8) * Math.max(0.6, s) });
  } else {   // classic: a small splash in the colony colour
    for (let i = 0; i < 16; i++) { const a = rand(0, TAU), sp = rand(60, 180) * s; P.push({ type: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, color: i % 2 ? baseColor : '#ffffff', life: 0.8, max: 0.8, r: 2 * Math.max(0.6, s) }); }
    F.push({ type: 'ring', x, y, color: baseColor, life: 0.9, max: 0.9, r: 90 * s });
  }
}
function playKillFx(x, y) {
  if (prog.kfx === 'none') return;   // classic flecks are already part of every conquest
  killFxInto(x, y, prog.kfx, particles, floaters);
  if (prog.kfx === 'shock') addShake(5);
}

// Live cosmetics preview on the menu: your current skin wearing your crown, trail and conquest effect
const cosPrev = { parts: [], rings: [], t: 0, fxT: 1.2, trailT: 0, q: { x: 148, y: 60, vx: 0, vy: 0, ang: 0, walk: 0 } };
function drawCosPreview(dt) {
  const cv = document.getElementById('cosPreview');
  if (!cv || !cv.offsetParent || dt <= 0) return;
  const d = Math.min(2, window.devicePixelRatio || 1), w = 296, h = 120;
  if (cv.width !== Math.round(w * d)) { cv.width = Math.round(w * d); cv.height = Math.round(h * d); }
  const P = cosPrev, q = P.q;
  P.t += dt;
  const nx = w / 2 + Math.sin(P.t * 0.8) * w * 0.27, ny = h / 2 + 4 + Math.sin(P.t * 1.6) * h * 0.13;
  q.vx = (nx - q.x) / dt; q.vy = (ny - q.y) / dt; q.x = nx; q.y = ny;
  q.ang = Math.atan2(q.vy, q.vx); q.walk += Math.hypot(q.vx, q.vy) * dt * 0.13;
  const sk = SKINS[selectedSkin];
  const col = { color: sk.color, dark: shade(sk.color, -0.5), isPlayer: true, skin: sk,
                crownColor: (COSMETICS.crown.find(o => o.id === prog.crown) || COSMETICS.crown[0]).color };
  if (prog.trail !== 'none' && (P.trailT -= dt) <= 0) {
    P.trailT = 0.035;
    const s = Math.hypot(q.vx, q.vy) || 1;
    P.parts.push(trailParticle(q.x - q.vx / s * 18, q.y - q.vy / s * 18, prog.trail, 0.8));
  }
  if ((P.fxT -= dt) <= 0) { P.fxT = 3; killFxInto(q.x, q.y, prog.kfx, P.parts, P.rings, 0.45, sk.color); }
  for (const p of P.parts) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.93; p.vy *= 0.93; }
  for (const r of P.rings) r.life -= dt;
  P.parts = P.parts.filter(p => p.life > 0); P.rings = P.rings.filter(r => r.life > 0);

  const g = cv.getContext('2d');
  g.setTransform(d, 0, 0, d, 0, 0);
  const bg = g.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w * 0.6);
  bg.addColorStop(0, '#7a522e'); bg.addColorStop(1, '#4a2f17');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  for (const r of P.rings) {
    const a = Math.max(0, r.life / r.max);
    g.globalAlpha = a; g.strokeStyle = r.color; g.lineWidth = 2 * a + 0.5;
    g.beginPath(); g.arc(r.x, r.y, r.r * (1 - a) + 4, 0, TAU); g.stroke();
  }
  for (const p of P.parts) {
    g.globalAlpha = Math.max(0, p.life / p.max); g.fillStyle = p.color;
    if (p.type === 'crown') {
      const r = p.r; g.beginPath();
      g.moveTo(p.x - r, p.y + r * 0.6); g.lineTo(p.x - r, p.y - r * 0.4); g.lineTo(p.x - r * 0.5, p.y); g.lineTo(p.x, p.y - r * 0.8);
      g.lineTo(p.x + r * 0.5, p.y); g.lineTo(p.x + r, p.y - r * 0.4); g.lineTo(p.x + r, p.y + r * 0.6); g.closePath(); g.fill();
    } else g.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
  }
  g.globalAlpha = 1;
  const saved = [TZ, TEX, TEY];
  antCtx = g; TZ = d; TEX = 0; TEY = 0;
  for (let i = 0; i < 7; i++) {   // a little guard ring around the queen
    const a = P.t * 0.6 + i / 7 * TAU, wx = q.x + Math.cos(a) * 31, wy = q.y + Math.sin(a) * 31;
    drawAnt(wx, wy, a + Math.PI / 2, 1.15, col, q.walk * 2 + i, false, i);
  }
  drawAnt(q.x, q.y, q.ang, 2.4, col, q.walk, true);
  antCtx = ctx; [TZ, TEX, TEY] = saved;
}

// ---- achievements: lifetime progress unlocks skins ----
const ACHIEVEMENTS = [
  { id: 'first',     name: 'First Steps',      desc: 'Play your first match',                    key: 'games',      goal: 1,    skin: 'bee' },
  { id: 'hungry',    name: 'Hungry Colony',    desc: 'Eat 100 crumbs',                           key: 'crumbs',     goal: 100,  skin: 'leaf' },
  { id: 'feast',     name: 'Endless Feast',    desc: 'Eat 1,000 crumbs',                         key: 'crumbs',     goal: 1000, skin: 'termite' },
  { id: 'blood',     name: 'First Conquest',   desc: 'Conquer a rival colony',                   key: 'conquests',  goal: 1,    skin: 'lady' },
  { id: 'conq25',    name: 'Conqueror',        desc: 'Conquer 25 colonies',                      key: 'conquests',  goal: 25,   skin: 'army' },
  { id: 'conq100',   name: 'Warlord',          desc: 'Conquer 100 colonies',                     key: 'conquests',  goal: 100,  skin: 'hornet' },
  { id: 'streak2',   name: 'Double Trouble',   desc: 'Get a x2 conquest streak',                 key: 'bestStreak', goal: 2,    skin: 'wasp' },
  { id: 'streak4',   name: 'Rampage',          desc: 'Get a x4 conquest streak',                 key: 'bestStreak', goal: 4,    skin: 'widow' },
  { id: 'size25',    name: 'Growing Up',       desc: 'Reach 25 ants in a match',                 key: 'bestPeak',   goal: 25,   skin: 'royal' },
  { id: 'size50',    name: 'Swarm',            desc: 'Reach 50 ants in a match',                 key: 'bestPeak',   goal: 50,   skin: 'diamond' },
  { id: 'size100',   name: 'Horde',            desc: 'Reach 100 ants in a match',                key: 'bestPeak',   goal: 100,  skin: 'emperor' },
  { id: 'size200',   name: 'Legion',           desc: 'Reach 200 ants in a match',                key: 'bestPeak',   goal: 200,  skin: 'legend' },
  { id: 'chili',     name: 'Chili Head',       desc: 'Eat 10 Fire Chilis',                       key: 'chili',      goal: 10,   skin: 'lava' },
  { id: 'sugar',     name: 'Sugar High',       desc: 'Collect 10 Sugar Rush cubes',              key: 'sugar',      goal: 10,   skin: 'candy' },
  { id: 'tunnel',    name: 'Tunnel Rat',       desc: 'Travel through tunnels 10 times',          key: 'tunnels',    goal: 10,   skin: 'roach' },
  { id: 'farmer',    name: 'Mushroom Farmer',  desc: 'Harvest 150 food from fungus gardens',     key: 'gardenFood', goal: 150,  skin: 'scarab' },
  { id: 'surv5',     name: 'Survivor',         desc: 'Survive 5 minutes in one match',           key: 'longest',    goal: 300,  skin: 'robot' },
  { id: 'surv10',    name: 'Marathon Queen',   desc: 'Survive 10 minutes in one match',          key: 'longest',    goal: 600,  skin: 'galaxy' },
  { id: 'win',       name: 'Queen of the Hill', desc: 'Be #1 on the map with 100+ ants',                             key: 'wins',       goal: 1,    skin: 'rainbow' },
  { id: 'giant',     name: 'Giant Slayer',     desc: 'Conquer a colony bigger than yours',       key: 'giant',      goal: 1,    skin: 'stag' },
  { id: 'blitz',     name: 'Blitz',            desc: 'Reach 50 ants within 2 minutes',           key: 'blitz',      goal: 1,    skin: 'firefly' },
  { id: 'charge',    name: 'Charge!',          desc: 'Launch 50 charges',                        key: 'charges',    goal: 50,   skin: 'spider' },
  { id: 'pacifist',  name: 'Gentle Giant',     desc: 'Reach 30 ants without charging',           key: 'pacifist',   goal: 1,    skin: 'ghost' },
  { id: 'dedicated', name: 'Dedicated',        desc: 'Play 10 matches',                          key: 'games',      goal: 10,   skin: 'jewel' },
  { id: 'bigGame',   name: 'Big Game Hunter',  desc: 'Conquer a colony of 50+ ants',             key: 'bigGame',    goal: 1,    skin: 'moth' },
  { id: 'underdog',  name: 'Underdog',         desc: 'Conquer a colony while you have under 10 ants', key: 'underdog', goal: 1, skin: 'frost' },
  // XP-reward achievements
  { id: 'events',    name: 'Weather Watcher',  desc: 'Experience 10 map events',                 key: 'events',     goal: 10,   xp: 250 },
    { id: 'nm5',       name: 'Nightmare Survivor', desc: 'Survive 5 minutes on Nightmare',         key: 'nmLongest',  goal: 300,  xp: 500 },
  { id: 'nm100',     name: 'Nightmare Horde',  desc: 'Reach 100 ants on Nightmare',              key: 'nmPeak',     goal: 100,  xp: 700 },
  { id: 'nmwin',     name: 'Nightmare Queen',  desc: 'Be #1 with 100+ ants on Nightmare',                 key: 'nmWins',     goal: 1,    xp: 1500 },
  { id: 'spider',    name: 'Arachnophobe',     desc: 'Defeat a spider',                          key: 'spiderKills', goal: 1,   xp: 200 },
  { id: 'ladybug',   name: 'Flip It',          desc: 'Flip a ladybug beetle',                    key: 'ladyFlips',  goal: 1,    xp: 200 },
  { id: 'wasp',      name: 'Swatter',          desc: 'Swat a wasp scout',                        key: 'waspKills',  goal: 1,    xp: 200 },
  { id: 'beeBoss',   name: 'Bee Slayer',       desc: 'Defeat the Queen Bee',                     key: 'beeKills',   goal: 1,    xp: 800 },
  { id: 'golden',    name: 'Golden Touch',     desc: 'Take the last bite of a Golden Crumb',     key: 'goldenWins', goal: 1,    xp: 200 },
];
const life = { games: 0, crumbs: 0, conquests: 0, wins: 0, chili: 0, sugar: 0, tunnels: 0, gardenFood: 0, charges: 0,
               bestStreak: 0, bestPeak: 0, longest: 0, blitz: 0, pacifist: 0, giant: 0, bigGame: 0, underdog: 0,
               events: 0, nmLongest: 0, nmPeak: 0, nmWins: 0, ghostKills: 0,
               spiderKills: 0, ladyFlips: 0, waspKills: 0, beeKills: 0, goldenWins: 0 };
try { Object.assign(life, JSON.parse(localStorage.getItem('qoth-life') || '{}')); } catch (e) {}
// carry over earlier records
life.bestPeak = Math.max(life.bestPeak, best.peak);
life.wins = Math.max(life.wins, best.wins);
life.longest = Math.max(life.longest, best.time);
life.conquests = Math.max(life.conquests, best.kills);
try { life.bestPeak = Math.max(life.bestPeak, +localStorage.getItem('qoth-unlock') || 0); } catch (e) {}
let achDone = new Set();
try { achDone = new Set(JSON.parse(localStorage.getItem('qoth-ach') || '[]')); } catch (e) {}
function saveLife() {
  try { localStorage.setItem('qoth-life', JSON.stringify(life)); localStorage.setItem('qoth-ach', JSON.stringify([...achDone])); } catch (e) {}
}
function skinUnlocked(sk) { return sk.basic || ACHIEVEMENTS.some(a => a.skin === sk.id && achDone.has(a.id)); }
function achForSkin(sk) { return ACHIEVEMENTS.find(a => a.skin === sk.id); }
function checkAchievements(announce = true) {
  const fresh = [];
  for (const a of ACHIEVEMENTS) {
    if (!achDone.has(a.id) && life[a.key] >= a.goal) { achDone.add(a.id); fresh.push(a); }
  }
  if (!fresh.length) return;
  saveLife();
  for (const a of fresh) {
    const sk = a.skin && SKINS.find(k => k.id === a.skin);
    if (a.xp) awardXP(a.xp);
    if (announce) {
      addBanner('Achievement: ' + a.name, sk ? `New skin unlocked: ${sk.name}` : `Reward: +${a.xp} XP`, '#c9a0ff', 3, 34);
      stats.newAch.push(a.name);
    }
  }
  if (announce) playSfx('milestone');
  buildSkinPicker();
  updateAchButton();
}
function updateAchButton() {
  const b = document.getElementById('achBtn');
  if (b) b.textContent = `Achievements  ${achDone.size}/${ACHIEVEMENTS.length}`;
}
function openAchievements() {
  const list = document.getElementById('achList');
  list.innerHTML = '';
  document.getElementById('achCount').textContent = `${achDone.size} of ${ACHIEVEMENTS.length} unlocked`;
  const d = Math.min(2, window.devicePixelRatio || 1);
  for (const a of ACHIEVEMENTS) {
    const done = achDone.has(a.id), sk = a.skin && SKINS.find(k => k.id === a.skin);
    const cur = Math.min(a.goal, life[a.key] || 0);
    const card = document.createElement('div');
    card.className = 'achcard' + (done ? ' done' : '') + (a.id.startsWith('nm') ? ' nm' : '');
    const cv = document.createElement('canvas');
    cv.width = 56 * d; cv.height = 48 * d;
    card.appendChild(cv);
    const txt = document.createElement('div');
    txt.className = 'achtxt';
    const prog = a.goal > 1 ? `${cur}/${a.goal}` : '';
    txt.innerHTML = `<b>${a.name}</b><span>${a.desc}</span>
      <div class="achbar"><i style="width:${(cur / a.goal) * 100}%"></i></div>
      <em>${done ? 'Unlocked' : prog || 'Locked'} &middot; ${sk ? sk.name + ' skin' : '+' + a.xp + ' XP'}</em>`;
    card.appendChild(txt);
    list.appendChild(card);
    if (sk) drawSkinPreview(cv, sk, d); else drawXpStar(cv, d);
  }
  document.getElementById('achScreen').classList.remove('hidden');
}

function drawXpStar(cv, d) {
  const g = cv.getContext('2d');
  g.setTransform(d, 0, 0, d, 0, 0);
  g.beginPath();
  for (let i = 0; i < 10; i++) { const r = i % 2 ? 8 : 18, a = -Math.PI / 2 + i * Math.PI / 5; g.lineTo(28 + Math.cos(a) * r, 25 + Math.sin(a) * r); }
  g.closePath();
  g.fillStyle = '#c9a0ff'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#6a3ab0'; g.stroke();
  g.fillStyle = '#fff'; g.font = 'bold 10px "Trebuchet MS", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('XP', 28, 26);
}

function renderBest() {
  const box = document.getElementById('bestBox');
  if (!best.peak) { box.innerHTML = '<div class="best-label">High score</div><div class="best-none">No games yet &mdash; set the first record!</div>'; return; }
  box.innerHTML = `<div class="best-label">High score</div>
    <div class="best-main"><b>${best.peak}</b> ants</div>
    <div class="best-sub">${best.kills} conquered in one match &middot; longest reign ${fmtTime(best.time)} &middot; ${best.wins} ${best.wins === 1 ? 'victory' : 'victories'}</div>`;
}

function endGame(won) {
  if (won) { stats.endTime = time - stats.start; life.wins++; if (stats.diff === 'nightmare') life.nmWins++; }
  checkAchievements();
  saveLife();
  const xp = matchXP(won), xpRes = awardXP(xp.total);
  showXP(won ? 'winXp' : 'overXp', xp, xpRes);
  const achText = stats.newAch.length ? 'Achievements unlocked: ' + stats.newAch.join(', ') : '';
  document.getElementById('overAch').textContent = achText;
  document.getElementById('winAch').textContent = achText;
  const isRecord = recordBest(won, stats.endTime);
  document.querySelectorAll('.newbest').forEach(el => el.classList.toggle('hidden', !isRecord));
  document.getElementById('optionsBtn').classList.add('hidden');
  if (won) { playSfx('victory'); addShake(8); }
  document.getElementById('overTip').textContent = DEATH_TIPS[stats.deathCause] || '';
  document.getElementById('overStreak').textContent = stats.bestStreak > 1 ? `Best streak: x${stats.bestStreak}` : '';
  document.getElementById('winStreak').textContent = stats.bestStreak > 1 ? `Best streak: x${stats.bestStreak}` : '';
  if (won) {
    state = 'victory';
    document.getElementById('winSize').textContent = colonySize(player);
    document.getElementById('winPeak').textContent = stats.peak;
    document.getElementById('winKills').textContent = stats.kills;
    document.getElementById('winTime').textContent = fmtTime(stats.endTime);
    document.getElementById('winScreen').classList.remove('hidden');
  } else {
    state = 'over';
    document.getElementById('overBy').textContent = `Your queen was conquered by ${stats.killedBy}.`;
    document.getElementById('overSize').textContent = stats.finalSize;
    document.getElementById('overPeak').textContent = stats.peak;
    document.getElementById('overKills').textContent = stats.kills;
    document.getElementById('overTime').textContent = fmtTime(stats.endTime);
    document.getElementById('overScreen').classList.remove('hidden');
  }
}

// ============================================================
//  Power-ups & structures
// ============================================================

// ---- more map events ----
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
function drawGolden() {
  const g = golden, pulse = 0.5 + 0.5 * Math.sin(time * 4);
  const gl = ctx.createRadialGradient(g.x, g.y, 4, g.x, g.y, 46);
  gl.addColorStop(0, `rgba(255,220,80,${0.55 + 0.2 * pulse})`); gl.addColorStop(1, 'rgba(255,220,80,0)');
  ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(g.x, g.y, 46, 0, TAU); ctx.fill();
  if (TH === 'war') {   // map objective star
    ctx.fillStyle = 'rgba(201,162,39,0.25)'; ctx.strokeStyle = TH_GOLD; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(g.x, g.y, 18, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = TH_GOLD; ctx.strokeStyle = TH_INK; ctx.lineWidth = 1.2; warStar(g.x, g.y, 13); ctx.fill(); ctx.stroke();
  } else {
  ctx.fillStyle = '#ffc93a'; ctx.strokeStyle = '#8a5a00'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(g.x, g.y, 12, 0, TAU); ctx.arc(g.x + 6, g.y - 5, 8, 0, TAU); ctx.fill();
  ctx.fillStyle = '#fff6c0'; ctx.beginPath(); ctx.arc(g.x - 4, g.y - 5, 3.5, 0, TAU); ctx.fill();
  }
  // eating progress ring
  ctx.lineWidth = 5 / cam.zoom;
  ctx.strokeStyle = 'rgba(20,10,0,0.6)'; ctx.beginPath(); ctx.arc(g.x, g.y, 26, 0, TAU); ctx.stroke();
  ctx.strokeStyle = g.lead ? g.lead.color : '#ffd54a';
  ctx.beginPath(); ctx.arc(g.x, g.y, 26, -Math.PI / 2, -Math.PI / 2 + g.progress * TAU); ctx.stroke();
  ctx.font = `bold ${12 / cam.zoom}px "Trebuchet MS", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 3 / cam.zoom; ctx.strokeStyle = 'rgba(30,15,0,0.85)';
  const label = (TH === 'war' ? 'OBJECTIVE ' : '') + `${Math.floor(g.progress * 100)}%`;
  ctx.strokeText(label, g.x, g.y + 40); ctx.fillStyle = '#ffe27a'; ctx.fillText(label, g.x, g.y + 40);
}
function drawFlood(L, R, T, B) {
  const c = floodCov();
  if (c <= 0) return;
  let x0 = 0, y0 = 0, x1 = WORLD_W, y1 = WORLD_H;
  if (flood.side === 'left') x1 = WORLD_W * c; else if (flood.side === 'right') x0 = WORLD_W * (1 - c);
  else if (flood.side === 'top') y1 = WORLD_H * c; else y0 = WORLD_H * (1 - c);
  ctx.fillStyle = TH === 'war' ? 'rgba(61,111,147,0.3)' : 'rgba(55,115,175,0.45)';
  ctx.fillRect(Math.max(x0, L), Math.max(y0, T), Math.min(x1, R) - Math.max(x0, L), Math.min(y1, B) - Math.max(y0, T));
  if (TH === 'war') {   // blue hatching like a flooded zone on a field map
    const fx0 = Math.max(x0, L), fy0 = Math.max(y0, T), fx1 = Math.min(x1, R), fy1 = Math.min(y1, B);
    if (fx1 > fx0 && fy1 > fy0) {
      ctx.save(); ctx.beginPath(); ctx.rect(fx0, fy0, fx1 - fx0, fy1 - fy0); ctx.clip();
      ctx.strokeStyle = 'rgba(61,111,147,0.55)'; ctx.lineWidth = 2; ctx.beginPath();
      const hgt = fy1 - fy0, st = Math.floor(fx0 / 24) * 24 - hgt;
      for (let x = st; x < fx1; x += 24) { ctx.moveTo(x, fy1); ctx.lineTo(x + hgt, fy0); }
      ctx.stroke(); ctx.restore();
    }
  }
  ctx.strokeStyle = 'rgba(200,230,255,0.7)'; ctx.lineWidth = 3 / cam.zoom;
  ctx.beginPath();
  if (flood.side === 'left' || flood.side === 'right') {
    const ex = flood.side === 'left' ? x1 : x0;
    for (let y = Math.max(0, T); y <= Math.min(WORLD_H, B); y += 20) { const x = ex + Math.sin(y * 0.05 + time * 3) * 6; y === Math.max(0, T) ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
  } else {
    const ey = flood.side === 'top' ? y1 : y0;
    for (let x = Math.max(0, L); x <= Math.min(WORLD_W, R); x += 20) { const y = ey + Math.sin(x * 0.05 + time * 3) * 6; x === Math.max(0, L) ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
  }
  ctx.stroke();
}
function drawMagnifier() {
  const m = magnifier, fade = Math.min(1, m.t / 1.5, (20 - m.t) / 1.5), pulse = 0.5 + 0.5 * Math.sin(time * 10);
  if (TH === 'war') {   // airstrike target
    const r = 58;
    ctx.globalAlpha = fade;
    ctx.fillStyle = `rgba(179,38,30,${0.1 + pulse * 0.12})`; ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, TAU); ctx.fill();
    ctx.strokeStyle = TH_RED; ctx.lineWidth = 3 / cam.zoom;
    ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, TAU); ctx.stroke();
    ctx.lineWidth = 2 / cam.zoom; ctx.beginPath(); ctx.arc(m.x, m.y, r * 0.5, 0, TAU);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(m.x + dx * r * 0.2, m.y + dy * r * 0.2); ctx.lineTo(m.x + dx * (r + 14), m.y + dy * (r + 14)); }
    ctx.stroke();
    ctx.font = `bold ${13 / cam.zoom}px "Courier New", monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = TH_RED; ctx.fillText('AIRSTRIKE', m.x, m.y - r - 12 / cam.zoom);
    ctx.globalAlpha = 1;
    return;
  }
  ctx.globalAlpha = fade;
  ctx.fillStyle = 'rgba(255,255,220,0.07)'; ctx.strokeStyle = 'rgba(255,255,240,0.35)'; ctx.lineWidth = 4 / cam.zoom;
  ctx.beginPath(); ctx.arc(m.x - 20, m.y - 30, 130, 0, TAU); ctx.fill(); ctx.stroke();   // the lens above
  const g = ctx.createRadialGradient(m.x, m.y, 2, m.x, m.y, 55 + pulse * 6);
  g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.35, 'rgba(255,240,140,0.8)'); g.addColorStop(1, 'rgba(255,150,40,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(m.x, m.y, 55 + pulse * 6, 0, TAU); ctx.fill();
  ctx.globalAlpha = 1;
}
function drawNightAndMoon() {
  if (nightT > 0) {
    const fade = Math.min(1, nightT / 2, (30 - nightT) / 2);
    let sx = W / 2, sy = H / 2, r = 220;
    if (player && player.alive) { sx = (player.queen.x - cam.x) * cam.zoom + W / 2; sy = (player.queen.y - cam.y) * cam.zoom + H / 2; r = (player.outerR + 150) * cam.zoom; }
    const g = ctx.createRadialGradient(sx, sy, r * 0.6, sx, sy, r * 1.35);
    g.addColorStop(0, 'rgba(5,6,20,0)'); g.addColorStop(1, `rgba(5,6,20,${0.9 * fade})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  if (bloodMoon > 0) {
    const fade = Math.min(1, bloodMoon / 2, (20 - bloodMoon) / 1.5);
    ctx.fillStyle = `rgba(150,0,15,${0.17 * fade})`; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = fade;
    const mg = ctx.createRadialGradient(W - 290, 60, 4, W - 290, 60, 34);
    mg.addColorStop(0, '#ff8a7a'); mg.addColorStop(1, '#8a0a10');
    ctx.fillStyle = mg; ctx.beginPath(); ctx.arc(W - 290, 60, 26, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// ============================================================
//  Roaming creatures: spider, ladybug, wasp scout, queen bee boss (+ drones)
// ============================================================

// ---- creature drawing (world space, camera transform set) ----
function drawWeb(cr) {
  const r = cr.webR, spokes = 10;
  ctx.strokeStyle = 'rgba(240,240,250,0.45)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let i = 0; i < spokes; i++) { const a = i / spokes * TAU + cr.webSeed; ctx.moveTo(cr.x, cr.y); ctx.lineTo(cr.x + Math.cos(a) * r, cr.y + Math.sin(a) * r); }
  for (let k = 1; k <= 5; k++) {
    const rr = r * k / 5;
    for (let i = 0; i <= spokes; i++) { const a = i / spokes * TAU + cr.webSeed, x = cr.x + Math.cos(a) * rr, y = cr.y + Math.sin(a) * rr; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  }
  ctx.stroke();
}
function hpBar(cr, w, yOff, label) {
  if (cr.hp >= cr.max && !label) return;
  const x = cr.x - w / 2, y = cr.y - yOff;
  ctx.fillStyle = 'rgba(20,10,5,0.75)'; ctx.fillRect(x - 1, y - 1, w + 2, 6);
  ctx.fillStyle = cr.hp / cr.max > 0.4 ? '#8fe07a' : '#ff7a5a'; ctx.fillRect(x, y, w * Math.max(0, cr.hp / cr.max), 4);
  if (label) {
    ctx.font = `bold ${12 / cam.zoom}px "Trebuchet MS", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3 / cam.zoom; ctx.strokeStyle = 'rgba(30,15,5,0.85)'; ctx.strokeText(label, cr.x, y - 3);
    ctx.fillStyle = '#ffe27a'; ctx.fillText(label, cr.x, y - 3);
  }
}
function drawCreature(cr) {
  const flash = cr.hitFlash > 0;
  ctx.save();
  ctx.translate(cr.x, cr.y);
  if (cr.type === 'spider') {
    ctx.rotate(cr.ang);
    ctx.strokeStyle = '#1a1410'; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
    ctx.beginPath();
    for (let side = -1; side <= 1; side += 2) for (let i = 0; i < 4; i++) {
      const sw = Math.sin(cr.t * 3 + i) * 2, bx = 4 - i * 3;
      ctx.moveTo(bx, side * 4); ctx.lineTo(bx + 6 - i * 4 + sw, side * 18); ctx.lineTo(bx + 12 - i * 9 + sw, side * 26);
    }
    ctx.stroke();
    ctx.fillStyle = flash ? '#ffffff' : '#2a211c';
    ctx.beginPath(); ctx.ellipse(-9, 0, 13, 11, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(6, 0, 8, 7, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#8a3a1a'; ctx.beginPath(); ctx.ellipse(-10, 0, 7, 4, 0, 0, TAU); ctx.fill();   // back marking
    ctx.fillStyle = '#ff3a2a';
    for (const [ex, ey] of [[11, -2.5], [11, 2.5], [9, -4.5], [9, 4.5]]) { ctx.beginPath(); ctx.arc(ex, ey, 1.3, 0, TAU); ctx.fill(); }
    if (cr.munch > 0) { ctx.fillStyle = '#e8e0d0'; ctx.fillRect(13, -1, 3, 2); }
  } else if (cr.type === 'ladybug') {
    ctx.rotate(cr.ang);
    if (cr.state === 'flipped') {
      ctx.fillStyle = '#2a1a14'; ctx.beginPath(); ctx.ellipse(0, 0, 20, 17, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#140c08'; ctx.lineWidth = 2; ctx.beginPath();
      for (let side = -1; side <= 1; side += 2) for (let i = 0; i < 3; i++) { const w = Math.sin(cr.flipT * 18 + i) * 4; ctx.moveTo(-6 + i * 6, side * 6); ctx.lineTo(-6 + i * 6 + w, side * 16); }
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#140c08'; ctx.lineWidth = 2; ctx.beginPath();
      for (let side = -1; side <= 1; side += 2) for (let i = 0; i < 3; i++) { const w = Math.sin(cr.t * 8 + i + side) * 2; ctx.moveTo(-6 + i * 6, side * 12); ctx.lineTo(-6 + i * 6 + w, side * 22); }
      ctx.stroke();
      ctx.fillStyle = '#140c08'; ctx.beginPath(); ctx.ellipse(17, 0, 7, 9, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = flash ? '#ffffff' : '#e0282e'; ctx.beginPath(); ctx.ellipse(0, 0, 20, 18, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#140c08'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(19, 0); ctx.lineTo(-19, 0); ctx.stroke();
      ctx.fillStyle = '#140c08';
      for (const [sx, sy, r] of [[6, -8, 3.2], [6, 8, 3.2], [-7, -9, 3.6], [-7, 9, 3.6], [-14, -3, 2.6], [-14, 3, 2.6]]) { ctx.beginPath(); ctx.arc(sx, sy, r, 0, TAU); ctx.fill(); }
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.ellipse(4, -9, 7, 3, -0.3, 0, TAU); ctx.fill();
    }
  } else if (cr.type === 'wasp' || cr.type === 'drone' || cr.type === 'bee') {
    const big = cr.type === 'bee', s = big ? 2.4 : cr.type === 'drone' ? 0.8 : 1;
    ctx.fillStyle = 'rgba(20,10,0,0.25)'; ctx.beginPath(); ctx.ellipse(6 * s, 10 * s, 12 * s, 6 * s, 0, 0, TAU); ctx.fill();   // shadow
    ctx.rotate(cr.ang); ctx.scale(s, s);
    const flap = 0.6 + 0.4 * Math.sin(cr.t * 60);
    ctx.fillStyle = 'rgba(230,245,255,0.55)'; ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.ellipse(-2, -8 * flap, 9, 4.5, -0.4, 0, TAU); ctx.moveTo(7, 8 * flap); ctx.ellipse(-2, 8 * flap, 9, 4.5, 0.4, 0, TAU); ctx.fill(); ctx.stroke();
    const yellow = big ? '#ffc23a' : cr.type === 'drone' ? '#f0b030' : '#ffd21f';
    ctx.fillStyle = flash ? '#ffffff' : yellow;
    ctx.beginPath(); ctx.ellipse(-8, 0, big ? 10 : 9, big ? 7 : 5, 0, 0, TAU); ctx.fill();   // abdomen
    ctx.fillStyle = '#1a1208';
    for (const bx of [-12, -7]) { ctx.beginPath(); ctx.ellipse(bx, 0, 1.6, big ? 6.6 : 4.7, 0, 0, TAU); ctx.fill(); }
    if (!big) { ctx.beginPath(); ctx.moveTo(-17, -1); ctx.lineTo(-21, 0); ctx.lineTo(-17, 1); ctx.fill(); }   // stinger
    ctx.fillStyle = big ? '#7a4a1a' : '#2a1e08'; ctx.beginPath(); ctx.ellipse(1, 0, 4.5, 4, 0, 0, TAU); ctx.fill();   // thorax
    ctx.fillStyle = '#1a1208'; ctx.beginPath(); ctx.ellipse(7, 0, 3.5, 3.8, 0, 0, TAU); ctx.fill();   // head
    if (big) {   // the queen wears a crown
      ctx.fillStyle = '#ffd700'; ctx.strokeStyle = '#7a5200'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(5, -3); ctx.lineTo(9, -3.6); ctx.lineTo(7.5, -1.4); ctx.lineTo(10, 0); ctx.lineTo(7.5, 1.4); ctx.lineTo(9, 3.6); ctx.lineTo(5, 3); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }
  ctx.restore();
  if (cr.type === 'bee') hpBar(cr, 90, 58, 'Queen Bee');
  else if (cr.type === 'spider') hpBar(cr, 40, 34);
  else if (cr.type === 'ladybug' && cr.state !== 'flipped') hpBar(cr, 40, 30);
  else if (cr.type === 'wasp') hpBar(cr, 26, 22);
}

// ---- random map events ----

// ============================================================
//  Main update
// ============================================================

let titleFocus = null;
function updateCamera(dt) {
  let tx, ty, tz;
  const base = clamp(Math.min(W, H) / 760, 0.6, 1.05);
  if (state === 'dying') {
    tx = stats.deathX; ty = stats.deathY; tz = base * 1.7;
  } else if (player && (state === 'playing' || state === 'victory' || state === 'over')) {
    tx = player.queen.x; ty = player.queen.y;
    tz = base * (1 - 0.35 * Math.min(1, colonySize(player) / 250));
  } else {
    // title: follow the biggest colony around
    if (!titleFocus || !titleFocus.alive || Math.random() < dt / 8) {
      titleFocus = colonies.filter(c => c.alive).sort((a, b) => colonySize(b) - colonySize(a))[0] || null;
    }
    tx = titleFocus ? titleFocus.queen.x : WORLD_W / 2;
    ty = titleFocus ? titleFocus.queen.y : WORLD_H / 2;
    tz = base * 0.85;
  }
  const k = 1 - Math.exp(-5 * dt);
  cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k;
  cam.zoom += (tz - cam.zoom) * (1 - Math.exp(-2 * dt));
  const vw = W / cam.zoom, vh = H / cam.zoom, m = 80;
  cam.x = vw > WORLD_W + 2 * m ? WORLD_W / 2 : clamp(cam.x, vw / 2 - m, WORLD_W - vw / 2 + m);
  cam.y = vh > WORLD_H + 2 * m ? WORLD_H / 2 : clamp(cam.y, vh / 2 - m, WORLD_H - vh / 2 + m);
}

// ============================================================
//  Rendering
// ============================================================
let dirtPattern = null;
function makeDirtPattern() {
  const s = 512;
  const pc = document.createElement('canvas');
  pc.width = pc.height = s;
  const p = pc.getContext('2d');
  p.fillStyle = '#6e4a2a';
  p.fillRect(0, 0, s, s);
  // mottled patches
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = rand(20, 70);
    const g = p.createRadialGradient(x, y, 0, x, y, r);
    const dark = Math.random() < 0.5;
    g.addColorStop(0, dark ? 'rgba(60,36,16,0.22)' : 'rgba(140,100,60,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    p.fillStyle = g;
    for (const ox of [-s, 0, s]) for (const oy of [-s, 0, s]) {
      p.save(); p.translate(ox, oy); p.beginPath(); p.arc(x, y, r, 0, TAU); p.fill(); p.restore();
    }
  }
  // speckles
  for (let i = 0; i < 2600; i++) {
    const v = Math.random();
    p.fillStyle = v < 0.5 ? `rgba(40,24,10,${rand(0.15, 0.4)})` : `rgba(170,130,85,${rand(0.1, 0.3)})`;
    p.fillRect(Math.random() * s, Math.random() * s, rand(1, 2.4), rand(1, 2.4));
  }
  // pebbles
  for (let i = 0; i < 26; i++) {
    const x = rand(10, s - 10), y = rand(10, s - 10), rx = rand(2.5, 6), ry = rx * rand(0.6, 0.9), rot = rand(0, TAU);
    p.fillStyle = 'rgba(30,18,8,0.35)';
    p.beginPath(); p.ellipse(x + 1.2, y + 1.5, rx, ry, rot, 0, TAU); p.fill();
    const tone = randInt(110, 160);
    p.fillStyle = `rgb(${tone},${tone - 22},${tone - 45})`;
    p.beginPath(); p.ellipse(x, y, rx, ry, rot, 0, TAU); p.fill();
    p.fillStyle = 'rgba(255,240,210,0.25)';
    p.beginPath(); p.ellipse(x - rx * 0.3, y - ry * 0.3, rx * 0.4, ry * 0.3, rot, 0, TAU); p.fill();
  }
  dirtPattern = ctx.createPattern(pc, 'repeat');
}

// Current camera transform components (device pixels)
let TZ = 1, TEX = 0, TEY = 0;
function setCameraTransform() {
  TZ = DPR * cam.zoom;
  TEX = DPR * (W / 2 - cam.x * cam.zoom + shakeX);
  TEY = DPR * (H / 2 - cam.y * cam.zoom + shakeY);
  ctx.setTransform(TZ, 0, 0, TZ, TEX, TEY);
}

let antCtx = ctx;   // target context for drawAnt (swapped for the title logo)
// Draw an ant in its own local frame (facing +x). Worker body length ~13 units.
// Body layout per bug type (local units, facing +x). Workers ~13 units long.
function bodyGeo(bt, q) {
  switch (bt) {
    case 'termite': return { abX: q ? -6.6 : -4.3, abRx: q ? 6.8 : 4.2, abRy: q ? 4.1 : 2.4, waist: null,
      thx: 0.7, thRx: 1.6, thRy: 1.5, hx: 3.5, hRx: 2.1, hRy: 1.9, legScale: 0.95, antennae: 'straight' };
    case 'wasp': return { abX: q ? -6.2 : -5.1, abRx: q ? 5.2 : 4.2, abRy: q ? 2.9 : 2.2, waist: [-0.9, 1.3, 0.45],
      thx: 0.6, thRx: 1.9, thRy: 1.5, hx: 3.5, hRx: 1.7, hRy: 1.9, legScale: 1, antennae: 'bent' };
    case 'beetle': return { abX: -2.3, abRx: 4.9, abRy: 3.6, waist: null,
      thx: 2.2, thRx: 1.4, thRy: 2.3, hx: 3.9, hRx: 1.1, hRy: 1.4, legScale: 0.9, antennae: 'short' };
    case 'spider': return { abX: -3.7, abRx: 3.6, abRy: 3.2, waist: [-0.2, 0.5, 0.5],
      thx: 1.4, thRx: 2.4, thRy: 2.0, hx: 3.2, hRx: 0.9, hRy: 1.1, legs: 8, antennae: 'none' };
    case 'roach': return { abX: -2.0, abRx: 5.8, abRy: 3.1, waist: null,
      thx: 2.7, thRx: 1.6, thRy: 2.8, hx: 4.1, hRx: 1.0, hRy: 1.3, legScale: 1.15, antennae: 'long' };
    default: return { abX: q ? -5.4 : -4.3, abRx: q ? 4.9 : 3.6, abRy: q ? 3.3 : 2.6, waist: [-0.9, 0.8, 0.7],
      thx: 0.4, thRx: 1.9, thRy: 1.4, hx: 3.6, hRx: 1.8, hRy: 1.7, legScale: 1, antennae: 'bent' };
  }
}

function drawAnt(x, y, ang, s, c, walk, isQueen, seed = 0) {
  const ctx = antCtx;
  const skin = c.skin;
  let body = c.color, dark = c.dark;
  if (skin && skin.rainbow) {
    const hue = (time * 70 + seed * 23) % 360;
    body = `hsl(${hue},85%,62%)`; dark = `hsl(${hue},70%,28%)`;
  }
  if (skin && skin.alpha) ctx.globalAlpha = skin.alpha + (isQueen ? 0.2 : 0);
  const co = Math.cos(ang) * s * TZ, si = Math.sin(ang) * s * TZ;
  ctx.setTransform(co, si, -si, co, x * TZ + TEX, y * TZ + TEY);

  const bt = (skin && skin.body) || 'ant';
  const G = bodyGeo(bt, isQueen);
  const { abX, abRx, abRy, thx, hx, hRx, hRy } = G;

  // legs (tripod gait) + antennae / mandibles
  ctx.strokeStyle = dark;
  ctx.lineWidth = isQueen ? 0.75 : 0.95;
  ctx.beginPath();
  if (G.legs === 8) {   // spider: four long jointed legs a side
    const rx = [1.2, 0.4, -0.4, -1.2], fxs = [5.6, 2.4, -1.8, -5.4];
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 4; i++) {
        const sw = Math.sin(walk + ((i + (side > 0 ? 1 : 0)) % 2) * Math.PI) * 1.3;
        const r0 = thx + rx[i], fx = thx + fxs[i] + sw, fy = side * (i === 0 || i === 3 ? 6.4 : 7);
        ctx.moveTo(r0, side * 0.8);
        ctx.lineTo(r0 + (fx - r0) * 0.45, side * 4.9);
        ctx.lineTo(fx, fy);
      }
    }
  } else {
    const ls = G.legScale;
    const roots = [thx + 0.7, thx - 0.4, thx - 1.5], feet = [thx + 3.8, thx - 0.2, thx - 4.8];
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 3; i++) {
        const phase = ((i + (side > 0 ? 1 : 0)) % 2) * Math.PI;
        const sw = Math.sin(walk + phase) * 1.5;
        const fx = feet[i] + sw, fy = side * (i === 1 ? 5.6 : 5.1) * ls;
        const kx = roots[i] + (fx - roots[i]) * 0.35 + (i === 0 ? 0.6 : i === 2 ? -0.6 : 0), ky = side * 3.4 * ls;
        ctx.moveTo(roots[i], side * 0.6);
        ctx.lineTo(kx, ky);
        ctx.lineTo(fx, fy);
      }
    }
  }
  for (let side = -1; side <= 1; side += 2) {
    const aw = Math.sin(walk * 0.7 + side) * 0.5;
    const ax = hx + hRx * 0.6;
    if (G.antennae === 'bent') {
      ctx.moveTo(ax, side * 0.8); ctx.lineTo(ax + 1.6, side * 2.0); ctx.lineTo(ax + 3.4, side * (1.6 + aw));
    } else if (G.antennae === 'straight') {
      ctx.moveTo(ax, side * 0.8); ctx.lineTo(ax + 2.8, side * (2.5 + aw * 0.5));
    } else if (G.antennae === 'short') {
      ctx.moveTo(ax, side * 0.7); ctx.lineTo(ax + 1.4, side * 1.7); ctx.lineTo(ax + 2.1, side * 1.5);
    } else if (G.antennae === 'long') {
      ctx.moveTo(ax, side * 0.6); ctx.quadraticCurveTo(ax + 4, side * (0.8 + aw), ax + 7.5, side * (4.2 + aw));
    }
  }
  if (bt === 'termite' || (skin && skin.mandibles)) {   // pincer jaws
    for (let side = -1; side <= 1; side += 2) {
      ctx.moveTo(hx + hRx - 0.4, side * 0.7); ctx.quadraticCurveTo(hx + hRx + 1.2, side * 0.9, hx + hRx + 1.5, side * 0.1);
    }
  }
  ctx.stroke();

  // wings
  const fl = Math.sin(time * 18) * 0.04;
  if (skin && skin.mothWings) {                       // broad furry moth wings
    ctx.fillStyle = skin.mothWings; ctx.strokeStyle = dark; ctx.lineWidth = 0.35;
    ctx.beginPath();
    ctx.ellipse(-1.8, -3.4, 5.2, 3.4, 0.55 + fl, 0, TAU);
    ctx.moveTo(-1.8 + 5.2, 3.4); ctx.ellipse(-1.8, 3.4, 5.2, 3.4, -0.55 - fl, 0, TAU);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(60,40,20,0.45)';            // eye-spots
    ctx.beginPath(); ctx.arc(-3, -4.4, 0.9, 0, TAU); ctx.moveTo(-2.1, 4.4); ctx.arc(-3, 4.4, 0.9, 0, TAU); ctx.fill();
  } else if (bt === 'wasp') {                         // narrow wasp wings, every caste
    ctx.fillStyle = 'rgba(225,240,255,0.45)'; ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 0.3;
    ctx.beginPath();
    ctx.ellipse(-2.6, -2.3, 5.6, 1.4, 0.3 + fl, 0, TAU);
    ctx.moveTo(-2.6 + 5.6, 2.3); ctx.ellipse(-2.6, 2.3, 5.6, 1.4, -0.3 - fl, 0, TAU);
    ctx.fill(); ctx.stroke();
  } else if ((bt === 'ant' || bt === 'termite') && (isQueen || (skin && skin.workerWings))) {  // folded wings
    ctx.fillStyle = skin && skin.id === 'bee' ? 'rgba(220,240,255,0.5)' : 'rgba(235,245,255,0.38)';
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 0.35;
    ctx.beginPath();
    ctx.ellipse(-5.2, -2.4, 6.2, 2.1, 0.28 + fl, 0, TAU);
    ctx.moveTo(-5.2 + 6.2, 2.4);
    ctx.ellipse(-5.2, 2.4, 6.2, 2.1, -0.28 - fl, 0, TAU);
    ctx.fill(); ctx.stroke();
  }

  // body: abdomen, waist, thorax, head (+ wasp stinger)
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(abX + abRx, 0); ctx.ellipse(abX, 0, abRx, abRy, 0, 0, TAU);
  if (G.waist) { const [wx, wrx, wry] = G.waist; ctx.moveTo(wx + wrx, 0); ctx.ellipse(wx, 0, wrx, wry, 0, 0, TAU); }
  ctx.moveTo(thx + G.thRx, 0); ctx.ellipse(thx, 0, G.thRx, G.thRy, 0, 0, TAU);
  ctx.moveTo(hx + hRx, 0); ctx.ellipse(hx, 0, hRx, hRy, 0, 0, TAU);
  if (bt === 'wasp' && !(skin && skin.stinger === false)) {
    const tip = abX - abRx;
    ctx.moveTo(tip + 0.5, -0.55); ctx.lineTo(tip - 1.9, 0); ctx.lineTo(tip + 0.5, 0.55); ctx.closePath();
  }
  ctx.fill();
  ctx.strokeStyle = dark;
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // body-type details
  if (bt === 'beetle') {          // split wing-cases
    ctx.strokeStyle = dark; ctx.lineWidth = 0.45;
    ctx.beginPath(); ctx.moveTo(abX + abRx - 0.1, 0); ctx.lineTo(abX - abRx + 0.4, 0); ctx.stroke();
  } else if (bt === 'roach') {    // pale shield rim and folded-wing seam
    ctx.strokeStyle = (skin && skin.rim) || 'rgba(255,220,170,0.6)'; ctx.lineWidth = 0.55;
    ctx.beginPath(); ctx.ellipse(thx, 0, G.thRx * 0.85, G.thRy * 0.85, 0, -1.2, 1.2); ctx.stroke();
    ctx.strokeStyle = dark; ctx.lineWidth = 0.35;
    ctx.beginPath(); ctx.moveTo(abX + abRx - 1.2, 0); ctx.lineTo(abX - abRx + 0.6, 0.35);
    ctx.moveTo(abX + abRx - 1.2, 0); ctx.lineTo(abX - abRx + 1.4, -0.9); ctx.stroke();
  } else if (bt === 'termite') {  // soft segment rings
    ctx.strokeStyle = 'rgba(90,60,30,0.28)'; ctx.lineWidth = 0.3;
    ctx.beginPath();
    for (const f of [-0.55, -0.15, 0.25, 0.6]) {
      const sx = abX + abRx * f, ry = abRy * Math.sqrt(1 - f * f);
      ctx.moveTo(sx, -ry); ctx.quadraticCurveTo(sx - 0.5, 0, sx, ry);
    }
    ctx.stroke();
  } else if (bt === 'spider') {   // cluster of eyes
    ctx.fillStyle = '#0c0a08';
    ctx.beginPath();
    for (const [ex, ey, er] of [[2.9, -0.45, 0.32], [2.9, 0.45, 0.32], [2.5, -1.05, 0.22], [2.5, 1.05, 0.22]]) {
      ctx.moveTo(thx + ex - 1.4 + er, ey); ctx.arc(thx + ex - 1.4, ey, er, 0, TAU);
    }
    ctx.fill();
  }

  if (skin) {
    if (skin.head) {     // contrasting head
      ctx.fillStyle = skin.head;
      ctx.beginPath(); ctx.moveTo(hx + hRx, 0); ctx.ellipse(hx, 0, hRx, hRy, 0, 0, TAU); ctx.fill();
    }
    if (skin.horns) {    // stag beetle antlers
      ctx.strokeStyle = skin.head || dark; ctx.lineWidth = 0.9; ctx.lineCap = 'round';
      ctx.beginPath();
      for (let side = -1; side <= 1; side += 2) {
        ctx.moveTo(hx + 0.6, side * 0.8); ctx.quadraticCurveTo(hx + 3.2, side * 3, hx + 4.6, side * 0.5);
        ctx.moveTo(hx + 2.6, side * 1.9); ctx.lineTo(hx + 3.1, side * 1.1);
      }
      ctx.stroke(); ctx.lineCap = 'butt';
    }
    if (skin.glowTail) { // firefly lantern
      const gx = abX - abRx * 0.55, gr = abRy * 0.62;
      ctx.fillStyle = 'rgba(230,255,110,0.35)';
      ctx.beginPath(); ctx.arc(gx, 0, gr * 1.8, 0, TAU); ctx.fill();
      ctx.fillStyle = '#eeff7a';
      ctx.beginPath(); ctx.ellipse(gx, 0, gr * 1.1, gr, 0, 0, TAU); ctx.fill();
    }
    if (skin.hourglass) { // black widow mark
      ctx.fillStyle = skin.hourglass;
      ctx.beginPath();
      ctx.moveTo(abX - 1.3, -0.9); ctx.lineTo(abX + 1.3, -0.9); ctx.lineTo(abX, 0); ctx.closePath();
      ctx.moveTo(abX - 1.3, 0.9); ctx.lineTo(abX + 1.3, 0.9); ctx.lineTo(abX, 0); ctx.closePath();
      ctx.fill();
    }
    if (skin.stripes) {  // bumblebee bands across the abdomen
      ctx.fillStyle = skin.stripes;
      ctx.beginPath();
      for (const f of [-0.45, 0.1]) {
        const sx = abX + abRx * f, ry = abRy * Math.sqrt(1 - f * f) * 0.97;
        ctx.moveTo(sx + abRx * 0.16, 0); ctx.ellipse(sx, 0, abRx * 0.16, ry, 0, 0, TAU);
      }
      ctx.fill();
    }
    if (skin.spots) {    // ladybug spots and centre seam
      ctx.fillStyle = skin.spots;
      ctx.beginPath();
      for (const [fx, fy] of [[-0.45, -0.45], [-0.45, 0.45], [0.15, -0.5], [0.15, 0.5], [-0.8, 0]]) {
        const r = abRy * 0.2;
        ctx.moveTo(abX + abRx * fx + r, abRy * fy); ctx.arc(abX + abRx * fx, abRy * fy, r, 0, TAU);
      }
      ctx.fill();
      ctx.strokeStyle = skin.spots; ctx.lineWidth = 0.35;
      ctx.beginPath(); ctx.moveTo(abX + abRx, 0); ctx.lineTo(abX - abRx, 0); ctx.stroke();
    }
    if (skin.stars) {    // twinkling specks (frost crystals / galaxy stars)
      ctx.fillStyle = skin.stars;
      ctx.beginPath();
      for (const [fx, fy, r] of [[-0.5, -0.4, 0.3], [-0.1, 0.45, 0.25], [0.35, -0.2, 0.22], [-0.75, 0.3, 0.2], [0.05, -0.6, 0.18]]) {
        const rr = abRy * r * 0.8;
        ctx.moveTo(abX + abRx * fx + rr, abRy * fy); ctx.arc(abX + abRx * fx, abRy * fy, rr, 0, TAU);
      }
      ctx.moveTo(0.9, -0.3); ctx.arc(0.6, -0.3, 0.3, 0, TAU);
      ctx.fill();
    }
    if (skin.cracks) {   // glowing lava cracks
      ctx.strokeStyle = skin.cracks; ctx.lineWidth = 0.45;
      ctx.beginPath();
      ctx.moveTo(abX + abRx * 0.8, -abRy * 0.1); ctx.lineTo(abX + abRx * 0.3, abRy * 0.3);
      ctx.lineTo(abX - abRx * 0.1, -abRy * 0.2); ctx.lineTo(abX - abRx * 0.6, abRy * 0.35); ctx.lineTo(abX - abRx * 0.85, 0);
      ctx.moveTo(abX - abRx * 0.1, -abRy * 0.2); ctx.lineTo(abX - abRx * 0.2, -abRy * 0.7);
      ctx.moveTo(1.4, -0.5); ctx.lineTo(0.2, 0.4);
      ctx.stroke();
    }
    if (skin.visor) {    // robot eye strip
      ctx.strokeStyle = skin.visor; ctx.lineWidth = 0.55;
      ctx.beginPath(); ctx.moveTo(hx + 0.7, -1.2); ctx.lineTo(hx + 1, 0); ctx.lineTo(hx + 0.7, 1.2); ctx.stroke();
    }
    if (skin.leaf && !isQueen) {   // leafcutter workers carry a leaf fragment
      ctx.fillStyle = '#5fbf3a'; ctx.strokeStyle = '#2f6e1c'; ctx.lineWidth = 0.35;
      ctx.beginPath(); ctx.ellipse(7.2, -0.6, 3.1, 2.1, -0.5, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(5.2, 0.6); ctx.lineTo(9.2, -1.8); ctx.stroke();
    }
    if (skin.embers && isQueen) {   // glowing embers on the fire queen
      ctx.fillStyle = `rgba(255,200,60,${0.5 + 0.4 * Math.sin(time * 9)})`;
      ctx.beginPath();
      for (const [fx, fy] of [[-0.3, -0.3], [-0.6, 0.35], [0.1, 0.2]]) {
        ctx.moveTo(abX + abRx * fx + 0.6, abRy * fy); ctx.arc(abX + abRx * fx, abRy * fy, 0.6, 0, TAU);
      }
      ctx.fill();
    }
  }

  // shine
  ctx.fillStyle = 'rgba(255,255,255,0.32)';
  ctx.beginPath();
  ctx.moveTo(abX - 0.4 + abRx * 0.38, -abRy * 0.35);
  ctx.ellipse(abX - 0.4, -abRy * 0.35, abRx * 0.38, abRy * 0.22, 0, 0, TAU);
  ctx.moveTo(hx + 0.3 + 0.6, -0.6);
  ctx.ellipse(hx + 0.3, -0.6, 0.6, 0.35, 0, 0, TAU);
  ctx.fill();

  if (isQueen) {  // crown on the head; grows with the colony's milestones
    const lvl = c.crownLevel || 0, cs = 1 + 0.2 * lvl;
    if (lvl >= 4) {   // legendary glow behind the crown
      ctx.fillStyle = `rgba(255,220,90,${0.35 + 0.2 * Math.sin(time * 6)})`;
      ctx.beginPath(); ctx.arc(4 + hx - 3.6, 0, 3.6 * cs, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = c.crownColor || '#ffd700';
    ctx.strokeStyle = '#7a5200';
    ctx.lineWidth = 0.35;
    ctx.beginPath();
    const dx = hx - 3.6;   // sit the crown on this body type's head
    const P = (px, py) => [2.4 + dx + (px - 2.4) * cs, py * cs];
    ctx.moveTo(...P(2.4, -2.1));
    ctx.lineTo(...P(5.2, -2.5));
    ctx.lineTo(...P(3.9, -1.0));
    ctx.lineTo(...P(5.9, 0));
    ctx.lineTo(...P(3.9, 1.0));
    ctx.lineTo(...P(5.2, 2.5));
    ctx.lineTo(...P(2.4, 2.1));
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = c.isPlayer ? '#e0283c' : '#3de0ff';
    ctx.beginPath(); ctx.arc(3.2 + dx, 0, 0.55 * cs, 0, TAU); ctx.fill();
    if (lvl >= 2) {   // side gems
      ctx.fillStyle = '#3de0ff';
      ctx.beginPath();
      ctx.arc(...P(4.6, -1.9), 0.4 * cs, 0, TAU); ctx.moveTo(...P(5.0, 1.9)); ctx.arc(...P(4.6, 1.9), 0.4 * cs, 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// Workers are stamped from cached pre-rendered sprites (one per colour / skin /
// leg frame) instead of redrawing every body part of every ant each frame.
const SPR_RES = 4, SPR_OX = 13, SPR_OY = 8, SPR_FRAMES = 6;
const SPR_W = SPR_OX * 2 * SPR_RES, SPR_H = SPR_OY * 2 * SPR_RES;
const spriteCache = new Map();
function antSprite(col, walk, seed) {
  const frame = Math.floor((((walk % TAU) + TAU) % TAU) / TAU * SPR_FRAMES) % SPR_FRAMES;
  const skin = col.skin;
  let hue = -1;
  if (skin && skin.rainbow) hue = Math.floor(((time * 70 + seed * 23) % 360) / 20) * 20;
  const key = col.color + '|' + (skin ? skin.id : '') + '|' + frame + '|' + hue;
  let spr = spriteCache.get(key);
  if (spr) return spr;
  if (spriteCache.size > 800) spriteCache.clear();   // safety valve
  spr = document.createElement('canvas');
  spr.width = SPR_W; spr.height = SPR_H;
  let look = col;
  if (hue >= 0) {
    look = { color: `hsl(${hue},85%,62%)`, dark: `hsl(${hue},70%,28%)`, isPlayer: col.isPlayer, skin: { ...skin, rainbow: false } };
  }
  const saved = [TZ, TEX, TEY, time];
  antCtx = spr.getContext('2d');
  TZ = SPR_RES; TEX = SPR_OX * SPR_RES; TEY = SPR_OY * SPR_RES; time = 0;
  drawAnt(0, 0, 0, 1, look, frame / SPR_FRAMES * TAU, false, 0);
  antCtx = ctx; [TZ, TEX, TEY, time] = saved;
  spriteCache.set(key, spr);
  return spr;
}

// The static ground is drawn once per world into a big offscreen image; each
// frame only copies the visible part (far cheaper than re-filling a pattern).
const BG_SCALE = 0.8;
let bgCanvas = null;
function buildBackground() {
  if (!dirtPattern) makeDirtPattern();
  bgCanvas = bgCanvas || document.createElement('canvas');
  bgCanvas.width = Math.ceil(WORLD_W * BG_SCALE); bgCanvas.height = Math.ceil(WORLD_H * BG_SCALE);
  const g = bgCanvas.getContext('2d', { alpha: false });
  g.setTransform(BG_SCALE, 0, 0, BG_SCALE, 0, 0);
  if (TH === 'war') warGround(g);
  else if (TH === 'picnic') picnicGround(g);
  else {
  g.fillStyle = dirtPattern;
  g.fillRect(0, 0, WORLD_W, WORLD_H);
  // faint grid
  g.strokeStyle = 'rgba(40,24,10,0.18)'; g.lineWidth = 1.2;
  g.beginPath();
  for (let x = 100; x < WORLD_W; x += 100) { g.moveTo(x, 0); g.lineTo(x, WORLD_H); }
  for (let y = 100; y < WORLD_H; y += 100) { g.moveTo(0, y); g.lineTo(WORLD_W, y); }
  g.stroke();
  }
  // puddles
  for (const pd of puddles) {
    if (TH === 'war') { warPuddle(g, pd); continue; }
    g.save(); g.translate(pd.x, pd.y); g.rotate(pd.rot);
    g.fillStyle = 'rgba(40,30,20,0.35)'; g.beginPath(); g.ellipse(2, 3, pd.rx + 6, pd.ry + 5, 0, 0, TAU); g.fill();
    const pg = g.createRadialGradient(-pd.rx * 0.3, -pd.ry * 0.3, 4, 0, 0, pd.rx);
    pg.addColorStop(0, 'rgba(150,190,215,0.85)'); pg.addColorStop(1, 'rgba(70,105,135,0.85)');
    g.fillStyle = pg; g.beginPath(); g.ellipse(0, 0, pd.rx, pd.ry, 0, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(210,235,250,0.5)'; g.lineWidth = 2;
    g.beginPath(); g.ellipse(-pd.rx * 0.25, -pd.ry * 0.3, pd.rx * 0.45, pd.ry * 0.25, 0, Math.PI * 1.1, Math.PI * 1.8); g.stroke();
    g.restore();
  }
  // rocks
  for (const rk of rocks) {
    if (TH === 'war') { warRock(g, rk); continue; }
    const poly = (ox, oy, sc) => { g.beginPath(); rk.pts.forEach(([px, py], i) => i ? g.lineTo(rk.x + ox + px * sc, rk.y + oy + py * sc) : g.moveTo(rk.x + ox + px * sc, rk.y + oy + py * sc)); g.closePath(); };
    g.fillStyle = 'rgba(25,15,5,0.45)'; poly(6, 8, 1); g.fill();                        // shadow
    g.fillStyle = `rgb(${rk.tone},${rk.tone - 8},${rk.tone - 20})`; poly(0, 0, 1); g.fill();
    g.fillStyle = 'rgba(255,245,225,0.22)'; poly(-rk.r * 0.18, -rk.r * 0.2, 0.62); g.fill();   // lit top
    g.strokeStyle = 'rgba(40,30,20,0.55)'; g.lineWidth = 2; poly(0, 0, 1); g.stroke();
    g.strokeStyle = 'rgba(40,30,20,0.35)'; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(rk.x - rk.r * 0.3, rk.y - rk.r * 0.1); g.lineTo(rk.x + rk.r * 0.05, rk.y + rk.r * 0.2); g.lineTo(rk.x + rk.r * 0.35, rk.y + rk.r * 0.1); g.stroke();
  }
  // fungus gardens
  for (const gd of gardens) {
    if (TH === 'war') { warGarden(g, gd); continue; }
    const grd = g.createRadialGradient(gd.x, gd.y, 5, gd.x, gd.y, GARDEN_R);
    grd.addColorStop(0, 'rgba(120,160,70,0.5)'); grd.addColorStop(0.75, 'rgba(95,130,55,0.35)'); grd.addColorStop(1, 'rgba(90,120,50,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(gd.x, gd.y, GARDEN_R, 0, TAU); g.fill();
    g.lineWidth = 2; g.setLineDash([6, 6]); g.strokeStyle = 'rgba(200,230,150,0.45)';
    g.beginPath(); g.arc(gd.x, gd.y, GARDEN_R, 0, TAU); g.stroke(); g.setLineDash([]);
    for (const m of gd.shrooms) {
      const mx = gd.x + m.dx, my = gd.y + m.dy;
      g.fillStyle = '#e8dcc0'; g.fillRect(mx - m.r * 0.18, my, m.r * 0.36, m.r * 0.8);
      g.fillStyle = m.tone < 0.5 ? '#c9674a' : '#d9b27a';
      g.beginPath(); g.ellipse(mx, my, m.r, m.r * 0.65, 0, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255,245,220,0.7)';
      g.beginPath(); g.arc(mx - m.r * 0.35, my - m.r * 0.2, m.r * 0.18, 0, TAU); g.arc(mx + m.r * 0.3, my - m.r * 0.1, m.r * 0.13, 0, TAU); g.fill();
    }
  }
  // tunnel holes
  for (const h of tunnels) {
    if (TH === 'war') { warTunnel(g, h); continue; }
    g.fillStyle = '#8a6440'; g.beginPath(); g.arc(h.x, h.y, HOLE_R + 12, 0, TAU); g.fill();
    g.fillStyle = '#a07650'; g.beginPath(); g.arc(h.x - 3, h.y - 3, HOLE_R + 8, 0, TAU); g.fill();
    const hg = g.createRadialGradient(h.x, h.y, 2, h.x, h.y, HOLE_R);
    hg.addColorStop(0, '#050201'); hg.addColorStop(1, '#2a180a');
    g.fillStyle = hg; g.beginPath(); g.arc(h.x, h.y, HOLE_R, 0, TAU); g.fill();
    g.strokeStyle = TUNNEL_COLORS[h.group]; g.lineWidth = 2.5;
    g.beginPath(); g.arc(h.x, h.y, HOLE_R + 12, 0, TAU); g.stroke();
    g.fillStyle = TUNNEL_COLORS[h.group];
    for (let i = 0; i <= h.group; i++) { g.beginPath(); g.arc(h.x - h.group * 5 + i * 10, h.y + HOLE_R + 20, 3.5, 0, TAU); g.fill(); }
  }
}

function render() {
  if (!dirtPattern) makeDirtPattern();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = look().clear;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  setCameraTransform();
  const vw = W / cam.zoom, vh = H / cam.zoom;
  const L = cam.x - vw / 2 - 40, R = cam.x + vw / 2 + 40, T = cam.y - vh / 2 - 40, B = cam.y + vh / 2 + 40;

  // ground: one pre-rendered image of the whole world (dirt, grid, gardens, tunnels)
  if (!bgCanvas) buildBackground();
  {
    const x0 = clamp(L, 0, WORLD_W), y0 = clamp(T, 0, WORLD_H), x1 = clamp(R, 0, WORLD_W), y1 = clamp(B, 0, WORLD_H);
    if (x1 > x0 && y1 > y0) ctx.drawImage(bgCanvas, x0 * BG_SCALE, y0 * BG_SCALE, (x1 - x0) * BG_SCALE, (y1 - y0) * BG_SCALE, x0, y0, x1 - x0, y1 - y0);
  }
  // world border
  ctx.strokeStyle = look().border;
  ctx.lineWidth = 8;
  ctx.strokeRect(-4, -4, WORLD_W + 8, WORLD_H + 8);

  // live parts of the structures: who holds each garden, and the player's tunnel cooldown
  for (const g of gardens) {
    if (g.x + GARDEN_R < L || g.x - GARDEN_R > R || g.y + GARDEN_R < T || g.y - GARDEN_R > B) continue;
    if (g.owner || g.contested) {
      ctx.lineWidth = 2 / cam.zoom;
      ctx.setLineDash([6 / cam.zoom, 6 / cam.zoom]);
      ctx.strokeStyle = g.contested ? 'rgba(255,90,70,0.8)' : g.owner.color;
      ctx.beginPath(); ctx.arc(g.x, g.y, GARDEN_R, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (g.owner) {  // harvest progress
      ctx.strokeStyle = g.owner.color;
      ctx.lineWidth = 4 / cam.zoom;
      ctx.beginPath(); ctx.arc(g.x, g.y, GARDEN_R + 6, -Math.PI / 2, -Math.PI / 2 + (g.acc / GARDEN_RATE) * TAU); ctx.stroke();
    }
  }
  if (player && player.alive && player.tunnelCd > 0) {
    for (const h of tunnels) {
      if (h.x < L || h.x > R || h.y < T || h.y > B || dist(player.queen.x, player.queen.y, h.x, h.y) > 400) continue;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath(); ctx.moveTo(h.x, h.y);
      ctx.arc(h.x, h.y, HOLE_R, -Math.PI / 2, -Math.PI / 2 + (player.tunnelCd / TUNNEL_CD) * TAU); ctx.fill();
    }
  }

  // ground splats
  for (const p of particles) {
    if (p.type !== 'splat' || p.x < L || p.x > R || p.y < T || p.y > B) continue;
    ctx.globalAlpha = 0.45 * Math.min(1, p.life / p.max * 1.5);
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(p.x + p.r * 0.8, p.y - p.r * 0.5, p.r * 0.45, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // food crumbs (batched)
  if (TH === 'war') warFood(L, R, T, B);
  else if (TH === 'picnic') picnicFood(L, R, T, B);
  else {
  ctx.fillStyle = 'rgba(120,255,90,0.16)';
  ctx.beginPath();
  for (const f of food) {
    if (f.honey || f.x < L || f.x > R || f.y < T || f.y > B) continue;
    ctx.moveTo(f.x + f.r * 2 * f.age, f.y); ctx.arc(f.x, f.y, f.r * 2 * f.age, 0, TAU);
  }
  ctx.fill();
  ctx.fillStyle = '#5cc93a';
  ctx.beginPath();
  for (const f of food) {
    if (f.honey || f.x < L || f.x > R || f.y < T || f.y > B) continue;
    const r = f.r * f.age;
    ctx.moveTo(f.x + r, f.y); ctx.arc(f.x, f.y, r, 0, TAU);
    ctx.moveTo(f.x + f.ox + r * 0.7, f.y + f.oy); ctx.arc(f.x + f.ox, f.y + f.oy, r * 0.7, 0, TAU);
  }
  ctx.fill();
  ctx.fillStyle = '#b8ff8c';
  ctx.beginPath();
  for (const f of food) {
    if (f.honey || f.x < L || f.x > R || f.y < T || f.y > B) continue;
    const r = f.r * f.age * 0.35;
    ctx.moveTo(f.x - r * 0.8 + r, f.y - r); ctx.arc(f.x - r * 0.8, f.y - r, r, 0, TAU);
  }
  ctx.fill();
  }

  // honey drops (worth double)
  ctx.fillStyle = '#ffc23a'; ctx.strokeStyle = '#9a6a00'; ctx.lineWidth = 1;
  for (const f of food) {
    if (!f.honey || f.x < L || f.x > R || f.y < T || f.y > B) continue;
    ctx.beginPath(); ctx.arc(f.x, f.y, f.r * f.age, 0, TAU); ctx.fill(); ctx.stroke();
  }
  // spider webs, flood water, golden crumb
  for (const cr of creatures) if (cr.type === 'spider' && cr.x > L - 90 && cr.x < R + 90 && cr.y > T - 90 && cr.y < B + 90) drawWeb(cr);
  if (flood) drawFlood(L, R, T, B);
  if (golden) drawGolden();

  // power-ups: drawn live when only a few are on screen (keeps the flicker), from cached sprites when many are
  let puOnScreen = 0;
  for (const pu of powerups) if (pu.x >= L && pu.x <= R && pu.y >= T && pu.y <= B) puOnScreen++;
  const puCached = puOnScreen > 6;
  for (const pu of powerups) {
    if (pu.x < L || pu.x > R || pu.y < T || pu.y > B) continue;
    if (puCached && pu.age > 0.34) {
      const by = pu.y + Math.sin(time * 3 + pu.bob) * 3;
      ctx.drawImage(powerupSprite(pu.type), pu.x - 32, by - 32, 64, 64);
      continue;
    }
    const info = POWER_INFO[pu.type];
    const pop = Math.min(1, pu.age * 3), by = pu.y + Math.sin(time * 3 + pu.bob) * 3;
    const glow = ctx.createRadialGradient(pu.x, by, 2, pu.x, by, 26 * pop);
    glow.addColorStop(0, info.glow + '0.55)'); glow.addColorStop(1, info.glow + '0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(pu.x, by, 26 * pop, 0, TAU); ctx.fill();
    const k = pop * 1.3;
    ctx.lineJoin = 'round';
    if (TH === 'war') { if (pu.type === 'frenzy') drawIncendiary(pu.x, by, k); else drawSupplyDrop(pu.x, by, k); }
    else {
      if (TH === 'picnic') picnicPlate(pu.x, by, k);
      if (pu.type === 'frenzy') drawChili(pu.x, by, k); else drawSugarCube(pu.x, by, k);
    }
    ctx.lineJoin = 'miter';
  }

  // active power-up auras
  for (const c of colonies) {
    if (!c.alive) continue;
    const q = c.queen;
    if (q.x < L - 200 || q.x > R + 200 || q.y < T - 200 || q.y > B + 200) continue;
    if (c.frenzy > 0) {
      ctx.strokeStyle = `rgba(255,70,50,${0.35 + 0.25 * Math.sin(time * 10)})`;
      ctx.lineWidth = 5 / cam.zoom;
      ctx.beginPath(); ctx.arc(q.x, q.y, c.outerR + 8, 0, TAU); ctx.stroke();
    }
    if (c.rush > 0) {
      const s = Math.hypot(q.vx, q.vy);
      if (s > 30) {
        ctx.strokeStyle = 'rgba(120,215,255,0.55)';
        ctx.lineWidth = 2 / cam.zoom;
        ctx.beginPath();
        for (let i = -2; i <= 2; i++) {
          const ox = -q.vy / s * i * 6, oy = q.vx / s * i * 6;
          ctx.moveTo(q.x - q.vx / s * 16 + ox, q.y - q.vy / s * 16 + oy);
          ctx.lineTo(q.x - q.vx / s * (40 + Math.abs(i) * -5) + ox, q.y - q.vy / s * (40 + Math.abs(i) * -5) + oy);
        }
        ctx.stroke();
      }
    }
  }

  // player charge target marker
  if (player && player.alive && player.charge > 0) {
    const pulse = 1 + Math.sin(time * 14) * 0.12;
    const rr = (14 + 3.5 * Math.sqrt(colonySize(player))) * pulse;
    ctx.strokeStyle = 'rgba(255,215,80,0.7)';
    ctx.lineWidth = 2 / cam.zoom;
    ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.arc(player.chargeX, player.chargeY, rr, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
  }

  // charge status ring around the player's colony
  if (player && player.alive && state === 'playing' && player.charge <= 0) {
    const q = player.queen, rr = player.outerR + 12;
    if (player.chargeCd <= 0) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 4);
      ctx.strokeStyle = `rgba(255,214,90,${0.35 + pulse * 0.35})`;
      ctx.lineWidth = (2 + pulse) / cam.zoom;
      ctx.setLineDash([10 / cam.zoom, 7 / cam.zoom]);
      ctx.lineDashOffset = -time * 20 / cam.zoom;
      ctx.beginPath(); ctx.arc(q.x, q.y, rr, 0, TAU); ctx.stroke();
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
    } else {
      const frac = 1 - player.chargeCd / PLAYER_CHARGE_CD;
      ctx.strokeStyle = 'rgba(255,214,90,0.3)';
      ctx.lineWidth = 2 / cam.zoom;
      ctx.beginPath(); ctx.arc(q.x, q.y, rr, -Math.PI / 2, -Math.PI / 2 + frac * TAU); ctx.stroke();
    }
  }

  // grace-period shield bubbles
  for (const c of colonies) {
    if (!c.alive || c.grace <= 0) continue;
    const q = c.queen, fade = Math.min(1, c.grace / 2);
    ctx.fillStyle = `rgba(160,230,140,${0.07 * fade})`;
    ctx.strokeStyle = `rgba(170,240,150,${(0.35 + 0.15 * Math.sin(time * 5)) * fade})`;
    ctx.lineWidth = 2 / cam.zoom;
    ctx.beginPath(); ctx.arc(q.x, q.y, 24, 0, TAU); ctx.fill(); ctx.stroke();
  }

  // royal aura for high milestone queens
  for (const c of colonies) {
    if (!c.alive || (c.crownLevel || 0) < 3) continue;
    const q = c.queen, pulse = 0.5 + 0.5 * Math.sin(time * 3);
    ctx.strokeStyle = `rgba(255,215,90,${0.25 + 0.2 * pulse})`;
    ctx.lineWidth = 3 / cam.zoom;
    ctx.beginPath(); ctx.arc(q.x, q.y, 24 + pulse * 4, 0, TAU); ctx.stroke();
    ctx.strokeStyle = `rgba(255,240,170,${0.15 + 0.15 * (1 - pulse)})`;
    ctx.beginPath(); ctx.arc(q.x, q.y, 30 + (1 - pulse) * 5, 0, TAU); ctx.stroke();
  }

  // queen shadows / glows
  for (const c of colonies) {
    if (!c.alive) continue;
    const q = c.queen;
    if (q.x < L || q.x > R || q.y < T || q.y > B) continue;
    if (c.isPlayer) {
      const g = ctx.createRadialGradient(q.x, q.y, 4, q.x, q.y, 36);
      const gc = c.skin ? c.skin.glow : '255,220,90';
      g.addColorStop(0, `rgba(${gc},0.45)`);
      g.addColorStop(1, `rgba(${gc},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(q.x, q.y, 36, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = 'rgba(20,10,2,0.3)';
    ctx.beginPath(); ctx.ellipse(q.x + 3, q.y + 5, 16, 11, q.ang, 0, TAU); ctx.fill();
  }

  if (TH === 'war') warPerimeters(L, R, T, B);

  // workers
  for (const c of colonies) {
    if (!c.alive) continue;
    for (const w of c.workers) {
      if (w.x < L || w.x > R || w.y < T || w.y > B) continue;
      const spr = antSprite(w.col, w.walk, w.id);
      const k = 0.95 * TZ / SPR_RES, co = Math.cos(w.ang) * k, si = Math.sin(w.ang) * k;
      ctx.setTransform(co, si, -si, co, w.x * TZ + TEX, w.y * TZ + TEY);
      ctx.drawImage(spr, -SPR_OX * SPR_RES, -SPR_OY * SPR_RES);
    }
  }
  // ground creatures
  setCameraTransform();
  for (const cr of creatures) if ((cr.type === 'spider' || cr.type === 'ladybug') && cr.x > L - 40 && cr.x < R + 40 && cr.y > T - 40 && cr.y < B + 40) { drawCreature(cr); if (TH === 'war') warHostile(cr); }
  // queens on top
  for (const c of colonies) {
    if (!c.alive) continue;
    const q = c.queen;
    if (q.x < L || q.x > R || q.y < T || q.y > B) continue;
    drawAnt(q.x, q.y, q.ang, 2.1, c, q.walk, true);
  }
  setCameraTransform();
  // flying creatures and the burning sunbeam
  for (const cr of creatures) if ((cr.type === 'wasp' || cr.type === 'bee' || cr.type === 'drone') && cr.x > L - 90 && cr.x < R + 90 && cr.y > T - 90 && cr.y < B + 90) { drawCreature(cr); if (TH === 'war') warHostile(cr); }
  if (magnifier) drawMagnifier();

  // flying particles (little squares: much cheaper than arcs)
  for (const p of particles) {
    if (p.type === 'splat' || p.x < L || p.x > R || p.y < T || p.y > B) continue;
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.fillStyle = p.color;
    if (p.type === 'crown') {   // falling crowns (conquest effect)
      const r = p.r;
      ctx.beginPath();
      ctx.moveTo(p.x - r, p.y + r * 0.6); ctx.lineTo(p.x - r, p.y - r * 0.4); ctx.lineTo(p.x - r * 0.5, p.y); ctx.lineTo(p.x, p.y - r * 0.8);
      ctx.lineTo(p.x + r * 0.5, p.y); ctx.lineTo(p.x + r, p.y - r * 0.4); ctx.lineTo(p.x + r, p.y + r * 0.6); ctx.closePath(); ctx.fill();
    } else ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
  }
  ctx.globalAlpha = 1;

  // size tags above enemy queens
  const psize = player && player.alive ? colonySize(player) : -1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const c of colonies) {
    if (!c.alive) continue;
    const q = c.queen;
    if (q.x < L || q.x > R || q.y < T || q.y > B) continue;
    const s = colonySize(c);
    const label = String(s);
    const fs = 13 / cam.zoom;
    ctx.font = `bold ${fs}px "Trebuchet MS", sans-serif`;
    const tw = ctx.measureText(label).width + 12 / cam.zoom, th = 18 / cam.zoom;
    const ty = q.y - (c.workers.length ? c.outerR + 16 : 34);
    let bg = TH === 'war' ? 'rgba(241,234,216,0.92)' : 'rgba(30,20,10,0.75)', fg = TH === 'war' ? TH_INK : '#fff';
    if (c.isPlayer) { bg = player.color; fg = isDarkColor(player.color) ? '#fff6dc' : '#2a1606'; }
    else if (psize >= 0 && state === 'playing') {
      if (s < psize) { bg = TH === 'war' ? 'rgba(61,106,53,0.92)' : 'rgba(40,120,40,0.85)'; fg = '#e8ffd8'; }
      else if (s > psize) { bg = TH === 'war' ? 'rgba(179,38,30,0.92)' : 'rgba(150,30,25,0.85)'; fg = '#ffe0da'; }
    }
    roundRect(ctx, q.x - tw / 2, ty - th / 2, tw, th, 6 / cam.zoom);
    ctx.fillStyle = bg; ctx.fill();
    if (c.isPlayer) {   // gold rim so your tag reads on any skin colour
      ctx.strokeStyle = '#ffd54a'; ctx.lineWidth = 1.5 / cam.zoom; ctx.stroke();
    }
    ctx.fillStyle = c.color;
    if (TH === 'war') {   // map unit marker: box for you, diamond for hostiles
      const mx = q.x - tw / 2 - 7 / cam.zoom, m = 5 / cam.zoom;
      ctx.beginPath();
      if (c.isPlayer) ctx.rect(mx - m, ty - m * 0.7, m * 2, m * 1.4);
      else { ctx.moveTo(mx, ty - m); ctx.lineTo(mx + m, ty); ctx.lineTo(mx, ty + m); ctx.lineTo(mx - m, ty); ctx.closePath(); }
      ctx.fill(); ctx.strokeStyle = TH_INK; ctx.lineWidth = 1 / cam.zoom; ctx.stroke();
    } else { ctx.beginPath(); ctx.arc(q.x - tw / 2 - 5 / cam.zoom, ty, 4 / cam.zoom, 0, TAU); ctx.fill(); }
    ctx.fillStyle = fg;
    ctx.fillText(label, q.x, ty + 0.5 / cam.zoom);

    if (c.human && !c.isPlayer) {
      ctx.font = `bold ${12 / cam.zoom}px "Trebuchet MS", sans-serif`;
      ctx.lineWidth = 3 / cam.zoom; ctx.strokeStyle = 'rgba(20,20,30,0.85)';
      ctx.strokeText(c.name, q.x, ty - 16 / cam.zoom);
      ctx.fillStyle = '#ffffff'; ctx.fillText(c.name, q.x, ty - 16 / cam.zoom);
    }
    if (c.ghost) {
      ctx.font = `bold ${12 / cam.zoom}px "Trebuchet MS", sans-serif`;
      ctx.lineWidth = 3 / cam.zoom; ctx.strokeStyle = 'rgba(20,30,50,0.85)';
      ctx.strokeText(`Your Past Self (best ${best.peak})`, q.x, ty - 16 / cam.zoom);
      ctx.fillStyle = '#cfe6ff'; ctx.fillText(`Your Past Self (best ${best.peak})`, q.x, ty - 16 / cam.zoom);
    }
    // status icons to the right of the tag: shield while immune, tunnel while recharging
    const z = cam.zoom;
    let ix = q.x + tw / 2 + 11 / z;
    if (c.grace > 0) { drawShieldIcon(ix, ty, 8 / z, c.grace); ix += 18 / z; }
    if (c.tunnelCd > 0 || c.isPlayer) drawTunnelIcon(ix, ty, 7 / z, c.tunnelCd / TUNNEL_CD);
  }

  // floaters
  for (const f of floaters) {
    const a = Math.max(0, f.life / f.max);
    if (f.type === 'ring') {
      ctx.strokeStyle = f.color;
      ctx.globalAlpha = a;
      ctx.lineWidth = 4 * a + 1;
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (1 - a) + 10, 0, TAU); ctx.stroke();
    } else {
      ctx.globalAlpha = Math.min(1, a * 2);
      ctx.font = `bold ${f.size / cam.zoom}px "Trebuchet MS", sans-serif`;
      ctx.lineWidth = 3 / cam.zoom;
      ctx.strokeStyle = 'rgba(40,20,5,0.85)';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
  }
  ctx.globalAlpha = 1;

  // screen space UI
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawNightAndMoon();
  if (raining > 0) drawRain();
  if (state === 'dying') {   // dark red vignette during the replay
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.7);
    g.addColorStop(0, 'rgba(60,0,0,0)'); g.addColorStop(1, 'rgba(60,0,0,0.65)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  drawBanners();
  if (state === 'playing' || state === 'paused' || state === 'over' || state === 'victory') {
    // text-heavy panels are redrawn into cached images a few times a second, then just copied each frame
    cachedLayer('hud', 66, 0, 0, 340, 460, drawHUD);
    drawMusicHint();
    cachedLayer('lb', 200, W - 250, 0, 250, 200, drawLeaderboard);
    drawMinimap();
  }
  drawPerf();
}

// Small shield glyph (immunity). Blinks during its last 2 seconds.
function drawShieldIcon(x, y, r, remaining) {
  if (remaining < 2 && Math.sin(time * 18) < 0) return;
  ctx.beginPath();
  ctx.moveTo(x - r * 0.85, y - r * 0.8);
  ctx.quadraticCurveTo(x, y - r * 1.15, x + r * 0.85, y - r * 0.8);
  ctx.lineTo(x + r * 0.8, y - r * 0.1);
  ctx.quadraticCurveTo(x + r * 0.7, y + r * 0.7, x, y + r * 1.1);
  ctx.quadraticCurveTo(x - r * 0.7, y + r * 0.7, x - r * 0.8, y - r * 0.1);
  ctx.closePath();
  ctx.fillStyle = '#8fdc78';
  ctx.fill();
  ctx.lineWidth = r * 0.22;
  ctx.strokeStyle = '#1e4a14';
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';   // highlight stripe
  ctx.beginPath();
  ctx.moveTo(x - r * 0.1, y - r * 0.85); ctx.lineTo(x + r * 0.1, y - r * 0.85);
  ctx.lineTo(x + r * 0.1, y + r * 0.8); ctx.lineTo(x - r * 0.1, y + r * 0.8);
  ctx.fill();
}

// Small tunnel-hole glyph; frac = share of cooldown still remaining (0 = ready).
function drawTunnelIcon(x, y, r, frac) {
  ctx.fillStyle = '#9a7048';
  ctx.beginPath(); ctx.arc(x, y, r * 1.25, 0, TAU); ctx.fill();
  ctx.fillStyle = '#0c0603';
  ctx.beginPath(); ctx.arc(x, y, r * 0.8, 0, TAU); ctx.fill();
  if (frac > 0) {
    ctx.fillStyle = 'rgba(20,12,6,0.7)';    // grey-out wedge for the remaining cooldown
    ctx.beginPath(); ctx.moveTo(x, y);
    ctx.arc(x, y, r * 1.3, -Math.PI / 2, -Math.PI / 2 + frac * TAU); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#c9a0ff';
    ctx.lineWidth = r * 0.3;
    ctx.beginPath(); ctx.arc(x, y, r * 1.3, -Math.PI / 2 + frac * TAU, Math.PI * 1.5); ctx.stroke();
  } else {
    ctx.strokeStyle = '#8fe07a';            // ready
    ctx.lineWidth = r * 0.3;
    ctx.beginPath(); ctx.arc(x, y, r * 1.3, 0, TAU); ctx.stroke();
  }
}

// Fire Chili pickup: a curved red pepper with a green stem
// Cached HUD layers and power-up sprites
const layers = {};
function cachedLayer(id, every, x, y, w, h, fn) {
  const L = layers[id] || (layers[id] = { cv: document.createElement('canvas'), t: -1e9, dpr: 0, x: 0, w: 0, h: 0 });
  const now = performance.now();
  if (now - L.t > every || L.dpr !== DPR || L.x !== x || L.w !== w || L.h !== h) {
    L.t = now; L.dpr = DPR; L.x = x; L.w = w; L.h = h;
    L.cv.width = Math.ceil(w * DPR); L.cv.height = Math.ceil(h * DPR);
    const main = ctx;
    ctx = L.cv.getContext('2d');
    ctx.setTransform(DPR, 0, 0, DPR, -x * DPR, -y * DPR);
    try { fn(); } finally { ctx = main; }
  }
  ctx.drawImage(L.cv, x, y, w, h);
}
const puSprites = new Map();
function powerupSprite(type) {
  const key = type + '|' + TH;
  let cv = puSprites.get(key);
  if (cv) return cv;
  const res = 3, half = 32;
  cv = document.createElement('canvas');
  cv.width = cv.height = half * 2 * res;
  const g = cv.getContext('2d');
  g.setTransform(res, 0, 0, res, half * res, half * res);
  const info = POWER_INFO[type], k = 1.3, saved = time;
  time = 0.3;   // a frame where the flame / twinkle is showing
  const glow = g.createRadialGradient(0, 0, 2, 0, 0, 26);
  glow.addColorStop(0, info.glow + '0.55)'); glow.addColorStop(1, info.glow + '0)');
  g.fillStyle = glow; g.beginPath(); g.arc(0, 0, 26, 0, TAU); g.fill();
  g.lineJoin = 'round';
  if (TH === 'war') { if (type === 'frenzy') drawIncendiary(0, 0, k, g); else drawSupplyDrop(0, 0, k, g); }
  else {
    if (TH === 'picnic') picnicPlate(0, 0, k, g);
    if (type === 'frenzy') drawChili(0, 0, k, g); else drawSugarCube(0, 0, k, g);
  }
  time = saved;
  puSprites.set(key, cv);
  return cv;
}
function drawChili(x, y, k, g = ctx) {
  g.fillStyle = '#e8261c';
  g.strokeStyle = '#6e0c06';
  g.lineWidth = 1.2 * k;
  g.beginPath();
  g.moveTo(x - 7 * k, y - 6 * k);
  g.bezierCurveTo(x + 2 * k, y - 9 * k, x + 9 * k, y - 2 * k, x + 7 * k, y + 5 * k);
  g.bezierCurveTo(x + 6 * k, y + 9 * k, x + 3 * k, y + 11 * k, x + 1 * k, y + 12 * k);
  g.bezierCurveTo(x + 2 * k, y + 6 * k, x - 1 * k, y - 1 * k, x - 7 * k, y - 1 * k);
  g.closePath();
  g.fill(); g.stroke();
  g.strokeStyle = 'rgba(255,220,200,0.75)';   // shine
  g.lineWidth = 1.3 * k;
  g.beginPath(); g.moveTo(x - 3 * k, y - 5 * k); g.quadraticCurveTo(x + 3 * k, y - 5 * k, x + 4.5 * k, y); g.stroke();
  g.fillStyle = '#3f9e2a';                    // calyx + stem
  g.strokeStyle = '#1d4d12';
  g.lineWidth = 0.9 * k;
  g.beginPath(); g.ellipse(x - 7 * k, y - 3.5 * k, 2.2 * k, 3.4 * k, 0.3, 0, TAU); g.fill(); g.stroke();
  g.strokeStyle = '#3f9e2a';
  g.lineWidth = 1.6 * k;
  g.beginPath(); g.moveTo(x - 8 * k, y - 6 * k); g.quadraticCurveTo(x - 11 * k, y - 9 * k, x - 9 * k, y - 12 * k); g.stroke();
  // little flame licks while it waits to be eaten
  const f = 0.6 + 0.4 * Math.sin(time * 12 + x);
  g.fillStyle = `rgba(255,170,40,${0.7 * f})`;
  g.beginPath();
  g.moveTo(x + 2 * k, y - 8 * k); g.quadraticCurveTo(x + 5 * k, y - 12 * k * f, x + 3 * k, y - 15 * k * f);
  g.quadraticCurveTo(x + 7 * k, y - 11 * k, x + 6 * k, y - 7 * k); g.closePath(); g.fill();
}

// Sugar Rush pickup: a sparkling sugar cube drawn in 3/4 view
function drawSugarCube(x, y, k, g = ctx) {
  const s = 7.5 * k, h = s * 0.55;          // half-width of a face, depth of the top face
  const top = [[x, y - s - h], [x + s, y - s], [x, y - s + h], [x - s, y - s]];
  const left = [[x - s, y - s], [x, y - s + h], [x, y + s * 0.95], [x - s, y + s * 0.95 - h]];
  const right = [[x, y - s + h], [x + s, y - s], [x + s, y + s * 0.95 - h], [x, y + s * 0.95]];
  const face = (pts, fill) => {
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillStyle = fill; g.fill();
  };
  face(left, '#dde8f2');
  face(right, '#c3d3e2');
  face(top, '#ffffff');
  // crisp outline and edges
  g.strokeStyle = '#8fa6bc';
  g.lineWidth = 0.9 * k;
  g.beginPath();
  g.moveTo(top[0][0], top[0][1]); g.lineTo(top[1][0], top[1][1]); g.lineTo(right[2][0], right[2][1]);
  g.lineTo(right[3][0], right[3][1]); g.lineTo(left[3][0], left[3][1]); g.lineTo(top[3][0], top[3][1]);
  g.closePath();
  g.moveTo(top[3][0], top[3][1]); g.lineTo(top[2][0], top[2][1]); g.lineTo(top[1][0], top[1][1]);
  g.moveTo(top[2][0], top[2][1]); g.lineTo(right[3][0], right[3][1]);
  g.stroke();
  // grainy crystal texture on the side faces
  g.fillStyle = 'rgba(140,165,190,0.55)';
  for (const [fx, fy] of [[-0.6, 0.1], [-0.35, 0.45], [-0.75, 0.55], [-0.2, 0.05], [0.3, 0.2], [0.6, 0.0], [0.45, 0.55], [0.75, 0.4], [0.2, 0.6]]) {
    g.fillRect(x + fx * s, y + fy * s, 0.9 * k, 0.9 * k);
  }
  // loose grains beside the cube
  g.fillStyle = '#ffffff';
  for (const [dx, dy, r] of [[10, 6, 1.4], [12.5, 3, 1], [-11, 7, 1.2]]) {
    g.fillRect(x + (dx - r) * k, y + (dy - r) * k, 2 * r * k, 2 * r * k);
  }
  // twinkle on the top corner
  const tw = 0.5 + 0.5 * Math.sin(time * 6 + x * 0.1);
  const sx = x + s * 0.45, sy = y - s - h * 0.35, sr = (1.5 + 2.5 * tw) * k;
  g.fillStyle = `rgba(255,255,255,${0.5 + 0.5 * tw})`;
  g.beginPath();
  g.moveTo(sx, sy - sr); g.lineTo(sx + sr * 0.25, sy - sr * 0.25); g.lineTo(sx + sr, sy);
  g.lineTo(sx + sr * 0.25, sy + sr * 0.25); g.lineTo(sx, sy + sr); g.lineTo(sx - sr * 0.25, sy + sr * 0.25);
  g.lineTo(sx - sr, sy); g.lineTo(sx - sr * 0.25, sy - sr * 0.25);
  g.closePath(); g.fill();
}

function panel(x, y, w, h) {
  const lk = look();
  roundRect(ctx, x, y, w, h, lk.radius);
  ctx.fillStyle = lk.panel;
  ctx.fill();
  ctx.strokeStyle = lk.panelEdge;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawHUD() {
  if (!player) return;
  const x = 14, y = 14, w = 210, h = 104;
  panel(x, y, w, h);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#d8c090';
  ctx.font = 'bold 12px "Trebuchet MS", sans-serif';
  ctx.fillText('COLONY SIZE', x + 14, y + 22);
  ctx.fillStyle = isDarkColor(player.color) ? '#ffd54a' : player.color;
  ctx.font = 'bold 34px "Trebuchet MS", sans-serif';
  const sizeText = String(player.alive ? colonySize(player) : stats.finalSize);
  ctx.fillText(sizeText, x + 14, y + 56);
  const sizeW = ctx.measureText(sizeText).width;
  ctx.fillStyle = '#d8c090';
  ctx.font = '12px "Trebuchet MS", sans-serif';
  ctx.fillText('workers', x + 20 + sizeW, y + 56);

  // food progress
  ctx.fillText('Next worker', x + 14, y + 78);
  for (let i = 0; i < FOOD_PER_WORKER; i++) {
    ctx.beginPath();
    ctx.arc(x + 100 + i * 16, y + 74, 5, 0, TAU);
    ctx.fillStyle = i < player.food ? '#6fe04a' : 'rgba(255,255,255,0.15)';
    ctx.fill();
  }

  // charge
  ctx.fillStyle = '#d8c090';
  ctx.fillText('Charge', x + 14, y + 96);
  const bx = x + 70, bw = w - 84, by = y + 88;
  roundRect(ctx, bx, by, bw, 10, 5);
  ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fill();
  let frac, col, lbl;
  if (player.charge > 0) { frac = player.charge / CHARGE_TIME; col = '#ff9a3c'; lbl = 'CHARGING'; }
  else if (player.chargeCd > 0) { frac = 1 - player.chargeCd / PLAYER_CHARGE_CD; col = '#8a7a5a'; lbl = ''; }
  else { frac = 1; col = '#f5c542'; lbl = 'READY [CLICK]'; }
  if (frac > 0.02) { roundRect(ctx, bx, by, bw * frac, 10, 5); ctx.fillStyle = col; ctx.fill(); }
  if (lbl) {
    ctx.fillStyle = '#3a2208';
    ctx.font = 'bold 8px "Trebuchet MS", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(lbl, bx + bw / 2, by + 8);
    ctx.textAlign = 'left';
  }

  // rivals remaining, speed, grace period
  const lines = [[`Lv ${prog.level} ${titleFor(prog.level)}`, '#d9c0ff']];
  if (player.alive && player.grace > 0) lines.push([`Protected: ${Math.ceil(player.grace)}s`, '#9fe08a']);
  if (player.frenzy > 0) lines.push([`Fire Chili: ${Math.ceil(player.frenzy)}s`, '#ff7a64']);
  if (player.rush > 0) lines.push([`Sugar Rush: ${Math.ceil(player.rush)}s`, '#7fd4ff']);
  lines.push(player.tunnelCd > 0 ? [`Tunnels: ${Math.ceil(player.tunnelCd)}s`, 'rgba(245,232,200,0.6)'] : ['Tunnels: ready', 'rgba(245,232,200,0.8)']);
  if (raining > 0) lines.push([`Rainstorm: ${Math.ceil(raining)}s (everyone slowed)`, '#8fd0ff']);
  if (picnic) lines.push([`Picnic drop - ${Math.ceil(picnic.t)}s left (see minimap)`, '#ff9a8a']);
  if (golden) lines.push([`Golden Crumb: ${Math.floor(golden.progress * 100)}% eaten (see minimap)`, '#ffd54a']);
  if (magnifier) lines.push([`Magnifying glass: ${Math.ceil(magnifier.t)}s`, '#fff2a0']);
  if (flood) lines.push([`Flood from the ${flood.side}: ${Math.ceil(flood.dur - flood.t)}s`, '#7fc4ff']);
  if (migration) lines.push([`Migration: ${Math.ceil(migration.t)}s`, '#b8ff8c']);
  if (nightT > 0) lines.push([`Night: ${Math.ceil(nightT)}s`, '#b0b8ff']);
  if (bloodMoon > 0) lines.push([`Blood Moon: ${Math.ceil(bloodMoon)}s`, '#ff7a6a']);
  if (sugarRain > 0) lines.push([`Sugar Rain: ${Math.ceil(sugarRain)}s`, '#8fd8ff']);
  const boss = creatures.find(k => k.type === 'bee');
  if (boss) lines.push([`Queen Bee: ${Math.ceil(boss.hp / boss.max * 100)}% health`, '#ffc23a']);
  const sinceConquer = net.serverT - stats.lastConquerSrv;
  if (state === 'playing' && stats.streak >= 1 && sinceConquer <= STREAK_WINDOW) {
    lines.push([`Streak x${stats.streak} - next conquest in ${Math.ceil(STREAK_WINDOW - sinceConquer)}s for bonus!`, '#ffb060']);
  }
  const onGarden = gardens.find(g => g.owner === player);
  if (onGarden) lines.push(['Farming fungus garden', '#b8ff8c']);
  else if (gardens.some(g => g.contested && dist(g.x, g.y, player.queen.x, player.queen.y) < GARDEN_R)) lines.push(['Garden contested!', '#ff8a70']);
  if (TH !== 'default') panel(x, y + h + 4, 300, 38 + lines.length * 18);   // backing so the text reads on a light map
  ctx.fillStyle = 'rgba(245,232,200,0.8)';
  ctx.font = '12px "Trebuchet MS", sans-serif';
  ctx.fillText(`Room ${net.room} (${diff().name})   Players: ${humanCount()}   Speed: ${stats.speed || 100}%`, x + 4, y + h + 18);
  ctx.font = 'bold 13px "Trebuchet MS", sans-serif';
  lines.forEach(([t, col], i) => {
    const ly = y + h + 36 + i * 18;
    if (i === 0) { drawLevelBadge(ctx, x + 12, ly - 4, 9, prog.level, false, false); ctx.fillStyle = col; ctx.fillText(t, x + 26, ly); }
    else { ctx.fillStyle = col; ctx.fillText(t, x + 4, ly); }
  });
}

function drawRain() {
  const fade = Math.min(1, raining / 2, (RAIN_TIME - raining) / 1.5);
  ctx.fillStyle = `rgba(30,50,80,${0.22 * fade})`;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = `rgba(200,225,255,${0.45 * fade})`;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  for (let i = 0; i < 140; i++) {   // streaks that fall with time
    const sx = (i * 137.5 + time * 90) % (W + 60) - 30, sy = (i * 71.3 + time * 900 * (0.8 + (i % 5) * 0.08)) % (H + 40) - 20;
    ctx.moveTo(sx, sy); ctx.lineTo(sx - 5, sy + 16);
  }
  ctx.stroke();
  if (RAIN_TIME - raining < 0.25) { ctx.fillStyle = `rgba(255,255,255,${0.5 * (1 - (RAIN_TIME - raining) / 0.25)})`; ctx.fillRect(0, 0, W, H); }   // lightning
}

function drawBanners() {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  banners.forEach((b, i) => {
    const age = b.max - b.life;
    const pop = age < 0.18 ? 1 + 0.6 * (1 - age / 0.18) : 1;     // punch in
    const alpha = Math.min(1, b.life / 0.4);
    const y = H * 0.16 + 20 + i * 76;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(W / 2, y); ctx.scale(pop, pop);
    ctx.font = `900 ${b.size}px ${look().bannerFont}`;
    ctx.lineWidth = 7; ctx.strokeStyle = look().bannerEdge; ctx.lineJoin = 'round';
    ctx.strokeText(b.text, 0, 0);
    ctx.fillStyle = b.color; ctx.fillText(b.text, 0, 0);
    if (b.sub) {
      ctx.font = 'bold 17px "Trebuchet MS", sans-serif';
      ctx.lineWidth = 4; ctx.strokeText(b.sub, 0, b.size * 0.62);
      ctx.fillStyle = '#fff4d6'; ctx.fillText(b.sub, 0, b.size * 0.62);
    }
    ctx.restore();
  });
}

function drawMusicHint() {
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = '12px "Trebuchet MS", sans-serif';
  ctx.fillStyle = TH === 'war' ? 'rgba(31,29,24,0.75)' : 'rgba(245,232,200,0.65)';
  ctx.fillText(`Music: ${music.on ? 'on' : 'off'} [M]   Options [Esc]   Ping ${perfStats.ping} ms   Stats [F3]`, 14, H - 14);
}

function drawLeaderboard() {
  const alive = colonies.filter(c => c.alive).sort((a, b) => colonySize(b) - colonySize(a));
  const top = alive.slice(0, 5);
  const pRank = player && player.alive ? alive.indexOf(player) : -1;
  const extra = pRank >= 5 ? 1 : 0;
  const w = 220, rowH = 22, h = 36 + (top.length + extra) * rowH + 6;
  const x = W - w - 14, y = 14;
  panel(x, y, w, h);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd54a';
  ctx.font = 'bold 14px "Trebuchet MS", sans-serif';
  ctx.fillText('LEADERBOARD', x + w / 2, y + 22);

  const row = (c, rank, ry) => {
    const me = c.isPlayer;
    if (me) {
      roundRect(ctx, x + 6, ry - 15, w - 12, 20, 6);
      ctx.fillStyle = 'rgba(245,197,66,0.2)'; ctx.fill();
    }
    ctx.textAlign = 'left';
    ctx.font = (me ? 'bold ' : '') + '13px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#d8c090';
    ctx.fillText(rank + '.', x + 12, ry);
    ctx.fillStyle = c.color;
    ctx.beginPath(); ctx.arc(x + 38, ry - 4, 5, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = me ? '#ffe27a' : '#f5e8c8';
    ctx.fillText(me ? 'You' : (c.human ? '\u2605 ' : '') + c.name, x + 50, ry);
    ctx.textAlign = 'right';
    ctx.fillText(String(colonySize(c)), x + w - 14, ry);
  };
  top.forEach((c, i) => row(c, i + 1, y + 44 + i * rowH));
  if (extra) row(player, pRank + 1, y + 44 + top.length * rowH);
}

const miniCache = { cv: null, w: 0, dpr: 0, t: -1 };
function drawMinimap() {
  const mw = Math.min(220, W * 0.32), mh = mw * WORLD_H / WORLD_W;
  const x = W - mw - 14, y = H - mh - 14;
  panel(x - 4, y - 4, mw + 8, mh + 8);
  const sx = mw / WORLD_W, sy = mh / WORLD_H;

  // background, food specks and structures change slowly: redraw them a few times a second
  if (!miniCache.cv || miniCache.w !== mw || miniCache.dpr !== DPR || time - miniCache.t > 0.4 || time < miniCache.t) {
    const cv = miniCache.cv || document.createElement('canvas');
    cv.width = Math.ceil(mw * DPR); cv.height = Math.ceil(mh * DPR);
    const m = cv.getContext('2d');
    m.setTransform(DPR, 0, 0, DPR, 0, 0);
    m.fillStyle = look().mini;
    m.fillRect(0, 0, mw, mh);
    if (TH === 'war') {
      m.strokeStyle = 'rgba(93,126,163,0.45)'; m.lineWidth = 1; m.beginPath();
      for (let gx = 400; gx < WORLD_W; gx += 400) { m.moveTo(gx * sx, 0); m.lineTo(gx * sx, mh); }
      for (let gy = 400; gy < WORLD_H; gy += 400) { m.moveTo(0, gy * sy); m.lineTo(mw, gy * sy); }
      m.stroke();
    }
    m.fillStyle = TH === 'war' ? 'rgba(90,100,40,0.6)' : TH === 'picnic' ? 'rgba(200,120,255,0.8)' : 'rgba(120,230,90,0.35)';
    for (let i = 0; i < food.length; i += 2) m.fillRect(food[i].x * sx, food[i].y * sy, 1, 1);
    m.fillStyle = 'rgba(140,200,90,0.5)';
    for (const g of gardens) { m.beginPath(); m.arc(g.x * sx, g.y * sy, Math.max(3, GARDEN_R * sx), 0, TAU); m.fill(); }
    m.fillStyle = 'rgba(120,170,210,0.6)';
    for (const pd of puddles) { m.beginPath(); m.ellipse(pd.x * sx, pd.y * sy, pd.rx * sx, pd.ry * sy, pd.rot, 0, TAU); m.fill(); }
    m.fillStyle = 'rgba(150,140,125,0.9)';
    for (const rk of rocks) { m.beginPath(); m.arc(rk.x * sx, rk.y * sy, Math.max(1.5, rk.r * sx), 0, TAU); m.fill(); }
    m.lineWidth = 1.5;
    for (const h of tunnels) {
      m.fillStyle = '#120a04'; m.strokeStyle = TUNNEL_COLORS[h.group];
      m.beginPath(); m.arc(h.x * sx, h.y * sy, 3, 0, TAU); m.fill(); m.stroke();
    }
    Object.assign(miniCache, { cv, w: mw, dpr: DPR, t: time });
  }
  ctx.drawImage(miniCache.cv, x, y, mw, mh);
  for (const pu of powerups) {
    ctx.fillStyle = POWER_INFO[pu.type].color;
    ctx.fillRect(x + pu.x * sx - 1.5, y + pu.y * sy - 1.5, 3, 3);
  }
  if (flood) {
    const c = floodCov();
    ctx.fillStyle = 'rgba(80,150,220,0.45)';
    if (flood.side === 'left') ctx.fillRect(x, y, mw * c, mh); else if (flood.side === 'right') ctx.fillRect(x + mw * (1 - c), y, mw * c, mh);
    else if (flood.side === 'top') ctx.fillRect(x, y, mw, mh * c); else ctx.fillRect(x, y + mh * (1 - c), mw, mh * c);
  }
  for (const cr of creatures) {
    const big = cr.type === 'bee';
    ctx.fillStyle = cr.type === 'spider' ? '#d0d0d8' : cr.type === 'ladybug' ? '#ff4a4a' : '#ffd23a';
    ctx.beginPath(); ctx.arc(x + cr.x * sx, y + cr.y * sy, big ? 4 : cr.type === 'drone' ? 1 : 2, 0, TAU); ctx.fill();
  }
  if (magnifier) { ctx.fillStyle = '#fffbe0'; ctx.beginPath(); ctx.arc(x + magnifier.x * sx, y + magnifier.y * sy, 3.5, 0, TAU); ctx.fill(); }
  if (golden) {
    ctx.strokeStyle = `rgba(255,213,74,${0.6 + 0.4 * Math.sin(time * 7)})`; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x + golden.x * sx, y + golden.y * sy, 5 + 2 * Math.sin(time * 7), 0, TAU); ctx.stroke();
  }
  if (picnic) {   // pulsing picnic marker
    ctx.strokeStyle = `rgba(255,120,120,${0.5 + 0.5 * Math.sin(time * 6)})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x + picnic.x * sx, y + picnic.y * sy, 6 + 2 * Math.sin(time * 6), 0, TAU); ctx.stroke();
  }

  // viewport
  const vw = W / cam.zoom, vh = H / cam.zoom;
  ctx.strokeStyle = TH === 'war' ? 'rgba(31,29,24,0.6)' : 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + (cam.x - vw / 2) * sx, y + (cam.y - vh / 2) * sy, vw * sx, vh * sy);

  for (const c of colonies) {
    if (!c.alive) continue;
    const r = 2.5 + Math.sqrt(colonySize(c)) * 0.55;
    const px = x + c.queen.x * sx, py = y + c.queen.y * sy;
    ctx.beginPath(); ctx.arc(px, py, r, 0, TAU);
    ctx.fillStyle = c.color; ctx.fill();
    ctx.strokeStyle = c.isPlayer ? '#fff' : c.human ? '#ffe27a' : 'rgba(0,0,0,0.6)';
    ctx.lineWidth = c.isPlayer || c.human ? 2 : 1;
    ctx.stroke();
  }
}

// ============================================================
//  Title logo
// ============================================================
function drawLogo(sk = SKINS[selectedSkin]) {
  const lc = document.getElementById('logo');
  const l = lc.getContext('2d');
  const d = Math.min(2, window.devicePixelRatio || 1);
  lc.width = 160 * d; lc.height = 90 * d;   // (resizing also clears the old picture)
  lc.style.width = '160px'; lc.style.height = '90px';
  l.setTransform(d, 0, 0, d, 0, 0);
  // soft neutral ground shadow that fades out fully inside the canvas (reads on every theme)
  l.save(); l.translate(80, 74); l.scale(1, 0.2);
  const g = l.createRadialGradient(0, 0, 0, 0, 0, 72);
  g.addColorStop(0, 'rgba(0,0,0,0.32)'); g.addColorStop(0.6, 'rgba(0,0,0,0.14)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  l.fillStyle = g; l.beginPath(); l.arc(0, 0, 72, 0, TAU); l.fill();
  l.restore();

  const saved = [TZ, TEX, TEY];
  TZ = d; TEX = 0; TEY = 0;
  antCtx = l;
  const gold = { color: sk.color, dark: shade(sk.color, -0.5), isPlayer: true, skin: sk };
  drawAnt(34, 64, -Math.PI / 2 - 0.5, 1.5, gold, 1.2, false);
  drawAnt(126, 64, -Math.PI / 2 + 0.5, 1.5, gold, 2.4, false);
  drawAnt(16, 80, -Math.PI / 2 - 0.2, 1.2, gold, 0.4, false);
  drawAnt(144, 80, -Math.PI / 2 + 0.2, 1.2, gold, 3.1, false);
  drawAnt(80, 50, -Math.PI / 2, 3.2, gold, 0, true);
  antCtx = ctx;
  [TZ, TEX, TEY] = saved;
}

// ============================================================
//  Background music (Web Audio, generated on the fly - no audio files)
// ============================================================
const music = { ctx: null, master: null, sfxBus: null, noise: null, on: true, next: 0, step: 0 };
const MUSIC_MAX = 0.2, SFX_MAX = 0.55;
const settings = { music: 0.7, sfx: 0.8, gfx: 'auto', diff: 'normal', theme: 'default' };
try { Object.assign(settings, JSON.parse(localStorage.getItem('qoth-settings') || '{}')); } catch (e) {}
// Difficulty presets: AI aggression, reflexes, rival spawn rate and starting sizes, plus XP reward

function musicLevel() { return music.on ? MUSIC_MAX * settings.music : 0; }
function applyAudioSettings() {
  if (!music.ctx) return;
  music.master.gain.setTargetAtTime(musicLevel(), music.ctx.currentTime, 0.05);
  music.sfxBus.gain.setTargetAtTime(SFX_MAX * settings.sfx, music.ctx.currentTime, 0.05);
}
const STEP = 60 / 150 / 4;   // 16th notes at a driving 150 BPM
const midi = m => 440 * Math.pow(2, (m - 69) / 12);
// Am - F - C - G - Am - F - G - E : [bass root, chord tones] per bar
const CHORDS = [
  [45, [57, 60, 64]], [41, [53, 57, 60]], [48, [55, 60, 64]], [43, [55, 59, 62]],
  [45, [57, 60, 64]], [41, [53, 57, 60]], [43, [55, 59, 62]], [40, [56, 59, 64]],
];
// lead hook for the chorus, one note per 8th (-1 = rest), 8 bars
const HOOK = [
  69, -1, 72, -1, 76, -1, 74, 72,   72, -1, 69, -1, 65, -1, 69, -1,
  67, -1, 72, -1, 76, -1, 79, -1,   77, -1, 76, -1, 74, -1, 71, -1,
  81, -1, 79, -1, 76, -1, 72, -1,   77, -1, 76, -1, 72, -1, 69, -1,
  71, -1, 74, -1, 79, -1, 83, -1,   80, -1, -1, -1, 76, -1, -1, -1,
];
const BASS_PAT = [0, 0, 12, 0, 0, 0, 12, 0, 0, 0, 12, 0, 0, 12, 0, 12];   // pumping octaves
const ARP_PAT = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1, 2, 3];
function startMusic() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  if (!music.ctx) {
    music.ctx = new AC();
    music.master = music.ctx.createGain();
    music.master.gain.value = musicLevel();
    music.sfxBus = music.ctx.createGain();
    music.sfxBus.gain.value = SFX_MAX * settings.sfx;
    music.sfxBus.connect(music.ctx.destination);
    const lp = music.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 9000;
    music.master.connect(lp); lp.connect(music.ctx.destination);
    const len = Math.floor(music.ctx.sampleRate * 1.0);   // 1s of white noise, looped for drums and risers
    music.noise = music.ctx.createBuffer(1, len, music.ctx.sampleRate);
    const nd = music.noise.getChannelData(0);
    for (let i = 0; i < len; i++) nd[i] = Math.random() * 2 - 1;
    music.next = music.ctx.currentTime + 0.1;
    setInterval(scheduleMusic, 40);
  }
  if (music.ctx.state === 'suspended') music.ctx.resume();
}

function toggleMusic() {
  music.on = !music.on;
  applyAudioSettings();
  document.querySelectorAll('input[data-setting="music"]').forEach(el => el.closest('.slider').classList.toggle('muted', !music.on));
}

// oscillator voice through its own closing low-pass filter
function synth(freq, t, dur, type, vol, cutoff = 4000, attack = 0.004, detune = 0, vibrato = 0) {
  const o = music.ctx.createOscillator(), f = music.ctx.createBiquadFilter(), g = music.ctx.createGain();
  o.type = type; o.frequency.value = freq; o.detune.value = detune;
  if (vibrato) {
    const lfo = music.ctx.createOscillator(), lg = music.ctx.createGain();
    lfo.frequency.value = 6; lg.gain.value = freq * vibrato;
    lfo.connect(lg); lg.connect(o.frequency);
    lfo.start(t + 0.08); lfo.stop(t + dur + 0.05);
  }
  f.type = 'lowpass';
  f.frequency.setValueAtTime(cutoff, t);
  f.frequency.exponentialRampToValueAtTime(Math.max(200, cutoff * 0.25), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(f); f.connect(g); g.connect(music.master);
  o.start(t); o.stop(t + dur + 0.05);
}

// filtered noise: drums, cymbals, and (with endFreq) a rising sweep
function noiseHit(t, dur, vol, type, freq, q = 1, endFreq = 0) {
  const src = music.ctx.createBufferSource(), f = music.ctx.createBiquadFilter(), g = music.ctx.createGain();
  src.buffer = music.noise; src.loop = true;
  f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  if (endFreq) f.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + (endFreq ? dur * 0.9 : 0.003));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(music.master);
  src.start(t); src.stop(t + dur + 0.05);
}

function kick(t) {
  const o = music.ctx.createOscillator(), g = music.ctx.createGain();
  o.frequency.setValueAtTime(160, t);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
  g.gain.setValueAtTime(0.9, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  o.connect(g); g.connect(music.master);
  o.start(t); o.stop(t + 0.25);
}
function snare(t, vol = 1) {
  noiseHit(t, 0.16, 0.42 * vol, 'bandpass', 1900, 0.8);
  synth(190, t, 0.09, 'triangle', 0.16 * vol, 3000);
}
function hat(t, open) { noiseHit(t, open ? 0.14 : 0.035, open ? 0.12 : 0.1, 'highpass', 8500); }

function scheduleMusic() {
  if (!music.ctx) return;
  const now = music.ctx.currentTime;
  if (music.next < now) music.next = now + 0.05;   // catch up after a stalled tab
  while (music.next < now + 0.3) {
    const i = music.step, t = music.next;
    const barAll = Math.floor(i / 16), bar = barAll % 8, s16 = i % 16;
    const chorus = Math.floor(barAll / 8) % 2 === 1;   // every other 8 bars the lead kicks in
    const [root, tones] = CHORDS[bar];
    const fill = bar === 7 && s16 >= 8;                 // snare roll into the next section

    // drums: four on the floor, snare on 2 & 4, 16th hats (open off-beats in the chorus)
    if (s16 % 4 === 0) kick(t);
    if (!fill && (s16 === 4 || s16 === 12)) snare(t);
    if (fill) snare(t, 0.35 + (s16 - 8) * 0.08);
    if (!fill) hat(t, chorus && s16 % 4 === 2);
    if (s16 === 0 && bar === 0) noiseHit(t, 1.2, 0.2, 'highpass', 5000);               // crash on the drop
    if (bar === 7 && s16 === 0) noiseHit(t, 16 * STEP, 0.16, 'bandpass', 400, 2, 6000);  // riser

    // pumping bass
    synth(midi(root + BASS_PAT[s16]), t, STEP * 0.9, 'sawtooth', 0.2, 1400, 0.003);

    // fast arpeggio over the chord, an octave up
    const arp = [...tones, tones[0] + 12, tones[1] + 12];
    synth(midi(arp[ARP_PAT[s16]] + 12), t, STEP * 0.8, 'square', chorus ? 0.035 : 0.045, 3500, 0.002);

    // chorus lead: two slightly detuned saws for a thick, soaring hook
    if (chorus && s16 % 2 === 0) {
      const m = HOOK[(bar * 8 + s16 / 2) % HOOK.length];
      if (m > 0) {
        synth(midi(m + 12), t, STEP * 3.2, 'sawtooth', 0.06, 5000, 0.01, -8, 0.004);
        synth(midi(m + 12), t, STEP * 3.2, 'sawtooth', 0.06, 5000, 0.01, 8, 0.004);
      }
    }
    music.next += STEP;
    music.step = (i + 1) % (16 * 16);
  }
}

// ============================================================
//  Sound effects (synthesised; routed through their own volume bus)
// ============================================================
const sfxLast = {};
function tone(freq, t, dur, type, vol, endFreq = 0, attack = 0.005) {
  const o = music.ctx.createOscillator(), g = music.ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(music.sfxBus);
  o.start(t); o.stop(t + dur + 0.03);
}
function noiseBurst(t, dur, vol, freq, type = 'highpass') {
  const src = music.ctx.createBufferSource(), f = music.ctx.createBiquadFilter(), g = music.ctx.createGain();
  src.buffer = music.noise; src.loop = true;
  f.type = type; f.frequency.value = freq;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(music.sfxBus);
  src.start(t); src.stop(t + dur + 0.03);
}
// minimum gap (ms) between repeats of each sound, so swarms don't turn into noise
const SFX_GAP = { thunder: 800, event: 500, combo: 300, milestone: 400, eat: 70, hatch: 110, fight: 80, charge: 150, power: 200, tunnel: 200, conquer: 300, rival: 400, lose: 500, victory: 500, click: 40, garden: 350 };
function playSfx(name, vol = 1) {
  if (!music.ctx || settings.sfx <= 0 || music.ctx.state !== 'running') return;
  const nowMs = performance.now();
  if (nowMs - (sfxLast[name] || 0) < (SFX_GAP[name] || 50)) return;
  sfxLast[name] = nowMs;
  const t = music.ctx.currentTime + 0.01;
  switch (name) {
    case 'eat':     tone(rand(820, 980), t, 0.07, 'sine', 0.12 * vol, 1400); break;
    case 'hatch':   tone(520, t, 0.1, 'triangle', 0.16 * vol, 900); tone(1040, t + 0.05, 0.08, 'sine', 0.07 * vol); break;
    case 'fight':   noiseBurst(t, 0.05, 0.12 * vol, rand(2500, 4000)); tone(rand(180, 260), t, 0.05, 'square', 0.03 * vol, 90); break;
    case 'charge':  noiseBurst(t, 0.35, 0.18 * vol, 900, 'bandpass'); tone(220, t, 0.3, 'sawtooth', 0.06 * vol, 520, 0.03); break;
    case 'power':   [0, 4, 7, 12, 16].forEach((st, i) => tone(midi(76 + st), t + i * 0.045, 0.18, 'sine', 0.1 * vol)); break;
    case 'tunnel':  tone(700, t, 0.22, 'sine', 0.16 * vol, 160, 0.01); tone(180, t + 0.2, 0.25, 'sine', 0.14 * vol, 820, 0.01); break;
    case 'conquer': [60, 64, 67, 72].forEach((m, i) => tone(midi(m + 12), t + i * 0.08, 0.3, 'triangle', 0.16 * vol)); break;
    case 'rival':   tone(midi(55), t, 0.25, 'triangle', 0.08 * vol); tone(midi(52), t + 0.12, 0.3, 'triangle', 0.07 * vol); break;
    case 'lose':    [67, 64, 60, 55].forEach((m, i) => tone(midi(m), t + i * 0.18, 0.45, 'triangle', 0.16 * vol)); break;
    case 'victory': [60, 64, 67, 72, 67, 72, 76, 79].forEach((m, i) => tone(midi(m + 12), t + i * 0.11, 0.35, 'triangle', 0.15 * vol)); break;
    case 'garden':  tone(1500, t, 0.08, 'sine', 0.05 * vol, 1900); break;
    case 'combo':     [72, 76, 79, 84, 88].forEach((m, i) => tone(midi(m), t + i * 0.05, 0.25, 'square', 0.07 * vol)); tone(midi(96), t + 0.25, 0.4, 'triangle', 0.1 * vol); break;
    case 'milestone': [60, 67, 72, 76, 79, 84].forEach((m, i) => tone(midi(m + 12), t + i * 0.07, 0.5, 'triangle', 0.13 * vol)); noiseBurst(t, 0.6, 0.05 * vol, 6000); break;
    case 'thunder':   noiseBurst(t, 1.6, 0.35 * vol, 180, 'lowpass'); tone(55, t, 1.2, 'sine', 0.25 * vol, 35); break;
    case 'event':     [67, 72, 76, 79].forEach((m, i) => tone(midi(m), t + i * 0.09, 0.35, 'triangle', 0.14 * vol)); break;
    case 'click':   tone(1100, t, 0.04, 'triangle', 0.08 * vol, 800); break;
  }
}
function onScreen(x, y, pad = 60) {
  return Math.abs(x - cam.x) < W / 2 / cam.zoom + pad && Math.abs(y - cam.y) < H / 2 / cam.zoom + pad;
}

// ============================================================
//  Menus: settings sliders, options (pause), main menu
// ============================================================
function saveSettings() { try { localStorage.setItem('qoth-settings', JSON.stringify(settings)); } catch (e) {} }
function syncSliders() {
  document.querySelectorAll('input[data-setting]').forEach(el => {
    const v = Math.round(settings[el.dataset.setting] * 100);
    el.value = v;
    el.closest('.slider').querySelector('.val').textContent = v + '%';
  });
}
document.querySelectorAll('input[data-setting]').forEach(el => {
  el.addEventListener('input', () => {
    settings[el.dataset.setting] = el.value / 100;
    startMusic();
    if (el.dataset.setting === 'music' && !music.on && el.value > 0) { music.on = true; }
    applyAudioSettings(); syncSliders(); saveSettings();
  });
  el.addEventListener('change', () => { if (el.dataset.setting === 'sfx') playSfx('hatch'); });
});
syncSliders();
function applyDiffUI() {
  document.querySelectorAll('[data-diff]').forEach(b => b.classList.toggle('on', b.dataset.diff === settings.diff));
  document.getElementById('diffHint').textContent = (DIFFS[settings.diff] || DIFFS.normal).hint + ' - each difficulty is a separate world';
}
document.querySelectorAll('[data-diff]').forEach(b => b.addEventListener('click', () => {
  settings.diff = b.dataset.diff; saveSettings(); applyDiffUI();
  switchRoom(document.getElementById('roomInput').value, settings.diff);
}));
applyDiffUI();
function applyGfx() {
  document.querySelectorAll('[data-gfx]').forEach(b => b.classList.toggle('on', b.dataset.gfx === settings.gfx));
  if (settings.gfx === 'high') quality = 1;
  else if (settings.gfx === 'low') quality = 0.6;
  perf.acc = 0; perf.n = 0; perf.good = 0;
  resize();
}
document.querySelectorAll('[data-gfx]').forEach(b => b.addEventListener('click', () => {
  settings.gfx = b.dataset.gfx; saveSettings(); applyGfx();
}));

// ============================================================
//  Visual themes (looks only: nothing here changes gameplay)
// ============================================================
let TH = 'default';   // cached copy of settings.theme, set by applyTheme()
const TH_INK = '#1f1d18', TH_RED = '#b3261e', TH_GOLD = '#c9a227', TH_GREEN = '#3d6a35';
function thRng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

// ---------- War Room: a paper field map on a commander's table ----------
function warGround(g) {
  const r = thRng(1234);
  g.fillStyle = '#efe6cf'; g.fillRect(0, 0, WORLD_W, WORLD_H);
  g.fillStyle = 'rgba(180,160,120,0.35)';
  for (let i = 0; i < 9000; i++) g.fillRect(r() * WORLD_W, r() * WORLD_H, 2, 2);
  // coffee-ring stains and pencil smudges
  for (let i = 0; i < 6; i++) {
    const x = r() * WORLD_W, y = r() * WORLD_H, rr = 50 + r() * 60;
    g.strokeStyle = 'rgba(150,110,60,0.12)'; g.lineWidth = 6;
    g.beginPath(); g.arc(x, y, rr, r() * TAU, r() * TAU + 5); g.stroke();
  }
  // contour lines (hills)
  g.lineWidth = 2;
  for (let h = 0; h < 16; h++) {
    const hx = r() * WORLD_W, hy = r() * WORLD_H, R = 120 + r() * 200, n = 3 + Math.floor(r() * 4), sd = r() * 10;
    g.strokeStyle = 'rgba(160,120,74,0.42)';
    for (let k = 1; k <= n; k++) {
      const rad = R * k / n;
      g.beginPath();
      for (let i = 0; i <= 72; i++) {
        const a = i / 72 * TAU, rr = rad * (1 + 0.13 * Math.sin(3 * a + sd + k * 0.3) + 0.07 * Math.sin(5 * a + sd * 2));
        const px = hx + Math.cos(a) * rr, py = hy + Math.sin(a) * rr * 0.8;
        i ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.stroke();
    }
    g.fillStyle = 'rgba(160,120,74,0.7)'; g.font = '20px "Courier New", monospace'; g.textAlign = 'center';
    g.fillText(String(40 + n * 20), hx, hy + 6);
  }
  // dirt roads
  g.strokeStyle = 'rgba(138,106,58,0.45)'; g.lineWidth = 5; g.setLineDash([26, 14]);
  for (let i = 0; i < 3; i++) {
    g.beginPath(); g.moveTo(0, r() * WORLD_H);
    g.bezierCurveTo(WORLD_W * 0.3, r() * WORLD_H, WORLD_W * 0.6, r() * WORLD_H, WORLD_W, r() * WORLD_H); g.stroke();
  }
  g.setLineDash([]);
  // map grid with coordinates
  g.strokeStyle = 'rgba(93,126,163,0.2)'; g.lineWidth = 1.5; g.beginPath();
  for (let x = 100; x < WORLD_W; x += 100) { g.moveTo(x, 0); g.lineTo(x, WORLD_H); }
  for (let y = 100; y < WORLD_H; y += 100) { g.moveTo(0, y); g.lineTo(WORLD_W, y); }
  g.stroke();
  g.strokeStyle = 'rgba(93,126,163,0.45)'; g.lineWidth = 3; g.beginPath();
  for (let x = 400; x < WORLD_W; x += 400) { g.moveTo(x, 0); g.lineTo(x, WORLD_H); }
  for (let y = 400; y < WORLD_H; y += 400) { g.moveTo(0, y); g.lineTo(WORLD_W, y); }
  g.stroke();
  g.fillStyle = 'rgba(93,126,163,0.6)'; g.font = 'bold 22px "Courier New", monospace'; g.textAlign = 'left';
  for (let x = 0; x < WORLD_W; x += 400) for (let y = 0; y < WORLD_H; y += 400) {
    g.fillText('ABCDEFGHIJ'[x / 400] + (y / 400 + 1), x + 10, y + 28);
  }
}
function warPuddle(g, pd) {
  g.save(); g.translate(pd.x, pd.y); g.rotate(pd.rot);
  g.fillStyle = '#a9c8dc'; g.strokeStyle = '#3d6f93'; g.lineWidth = 3;
  g.beginPath(); g.ellipse(0, 0, pd.rx, pd.ry, 0, 0, TAU); g.fill(); g.stroke();
  g.strokeStyle = 'rgba(61,111,147,0.5)'; g.lineWidth = 2;
  for (let k = -2; k <= 2; k++) {
    g.beginPath();
    for (let i = -pd.rx * 0.6; i <= pd.rx * 0.6; i += 6) { const py = k * pd.ry * 0.28 + Math.sin(i * 0.12) * 3; i === -pd.rx * 0.6 ? g.moveTo(i, py) : g.lineTo(i, py); }
    g.stroke();
  }
  g.restore();
  g.fillStyle = '#2c5878'; g.font = 'italic bold 18px "Courier New", monospace'; g.textAlign = 'center';
  g.fillText('WATER', pd.x, pd.y + Math.max(pd.rx, pd.ry) * 0.5 + 34);
}
function warRock(g, rk) {
  const pts = rk.pts.map(([px, py]) => [rk.x + px, rk.y + py]);
  g.fillStyle = '#d3c9ad'; g.strokeStyle = TH_INK; g.lineWidth = 2.5;
  g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath(); g.fill(); g.stroke();
  g.strokeStyle = '#3b3a36'; g.lineWidth = 1.6; g.beginPath();   // hachures: short strokes pointing into the high ground
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    for (let t = 0.12; t < 1; t += 0.2) {
      const px = ax + (bx - ax) * t, py = ay + (by - ay) * t, dx = px - rk.x, dy = py - rk.y, d = Math.hypot(dx, dy) || 1;
      g.moveTo(px, py); g.lineTo(px - dx / d * rk.r * 0.28, py - dy / d * rk.r * 0.28);
    }
  }
  g.stroke();
}
function warGarden(g, gd) {
  g.save(); g.beginPath(); g.arc(gd.x, gd.y, GARDEN_R, 0, TAU); g.fillStyle = 'rgba(61,106,53,0.14)'; g.fill(); g.clip();
  g.strokeStyle = 'rgba(61,106,53,0.35)'; g.lineWidth = 2; g.beginPath();
  for (let i = -GARDEN_R * 2; i < GARDEN_R * 2; i += 12) { g.moveTo(gd.x + i, gd.y - GARDEN_R); g.lineTo(gd.x + i + GARDEN_R * 2, gd.y + GARDEN_R); }
  g.stroke(); g.restore();
  g.strokeStyle = TH_GREEN; g.lineWidth = 3; g.beginPath(); g.arc(gd.x, gd.y, GARDEN_R, 0, TAU); g.stroke();
  // tent symbol and a few supply crates
  g.fillStyle = '#f6f0df'; g.lineWidth = 2.5;
  g.beginPath(); g.moveTo(gd.x - 22, gd.y + 12); g.lineTo(gd.x, gd.y - 18); g.lineTo(gd.x + 22, gd.y + 12); g.closePath(); g.fill(); g.stroke();
  g.beginPath(); g.moveTo(gd.x, gd.y - 18); g.lineTo(gd.x, gd.y + 12); g.stroke();
  for (const [dx, dy] of [[-42, 28], [38, 30], [-4, 46]]) warCrate(g, gd.x + dx, gd.y + dy, 7, '#b08850');
  g.fillStyle = TH_GREEN; g.font = 'bold 17px "Courier New", monospace'; g.textAlign = 'center';
  g.fillText('SUPPLY DEPOT', gd.x, gd.y - GARDEN_R - 10);
}
function warCrate(g, x, y, h, fill) {
  g.fillStyle = fill; g.strokeStyle = TH_INK; g.lineWidth = 1.6;
  g.fillRect(x - h, y - h, h * 2, h * 2); g.strokeRect(x - h, y - h, h * 2, h * 2);
  g.beginPath(); g.moveTo(x - h, y - h); g.lineTo(x + h, y + h); g.moveTo(x + h, y - h); g.lineTo(x - h, y + h); g.stroke();
}
function warTunnel(g, h) {
  const col = TUNNEL_COLORS[h.group];
  g.fillStyle = 'rgba(239,230,207,0.9)'; g.beginPath(); g.arc(h.x, h.y, HOLE_R + 14, 0, TAU); g.fill();
  g.fillStyle = '#2a2620'; g.beginPath(); g.arc(h.x, h.y, HOLE_R, 0, TAU); g.fill();
  g.strokeStyle = TH_INK; g.lineWidth = 3; g.beginPath(); g.arc(h.x, h.y, HOLE_R + 12, 0, TAU); g.stroke();
  g.strokeStyle = col; g.lineWidth = 3; g.beginPath(); g.arc(h.x, h.y, HOLE_R + 17, 0, TAU); g.stroke();
  g.strokeStyle = TH_INK; g.lineWidth = 3; g.beginPath();   // four arrows pointing in
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + Math.PI / 4, c = Math.cos(a), s = Math.sin(a), o = HOLE_R + 30, i = HOLE_R + 20;
    g.moveTo(h.x + c * o, h.y + s * o); g.lineTo(h.x + c * i, h.y + s * i);
    g.moveTo(h.x + c * (i + 6) - s * 5, h.y + s * (i + 6) + c * 5); g.lineTo(h.x + c * i, h.y + s * i); g.lineTo(h.x + c * (i + 6) + s * 5, h.y + s * (i + 6) - c * 5);
  }
  g.stroke();
  g.fillStyle = TH_INK; g.font = 'bold 16px "Courier New", monospace'; g.textAlign = 'center';
  g.fillText('TUNNEL ' + 'ABC'[h.group], h.x, h.y + HOLE_R + 48);
}
function warFood(L, R, T, B) {
  ctx.beginPath();
  for (const f of food) {
    if (f.honey || f.x < L || f.x > R || f.y < T || f.y > B) continue;
    const h = f.r * f.age;
    ctx.rect(f.x - h, f.y - h, h * 2, h * 2);
  }
  ctx.fillStyle = '#7d8a3a'; ctx.fill();
  ctx.strokeStyle = TH_INK; ctx.lineWidth = 1; ctx.stroke();
  ctx.beginPath();
  for (const f of food) {
    if (f.honey || f.x < L || f.x > R || f.y < T || f.y > B) continue;
    const h = f.r * f.age;
    ctx.moveTo(f.x - h, f.y - h); ctx.lineTo(f.x + h, f.y + h); ctx.moveTo(f.x + h, f.y - h); ctx.lineTo(f.x - h, f.y + h);
  }
  ctx.lineWidth = 0.7; ctx.stroke();
}
// Fire Chili as an incendiary canister
function drawIncendiary(x, y, k, g = ctx) {
  const s = k * 1.3;
  g.save(); g.translate(x, y); g.scale(s, s);
  g.fillStyle = '#c8281c'; g.strokeStyle = TH_INK; g.lineWidth = 1.1;
  roundRect(g, -6, -9, 12, 17, 3); g.fill(); g.stroke();
  g.fillStyle = '#555'; g.fillRect(-3, -12, 6, 3); g.strokeRect(-3, -12, 6, 3);
  g.fillStyle = '#f1ead8';
  g.beginPath(); g.moveTo(0, -5); g.quadraticCurveTo(4, 0, 1.5, 4); g.quadraticCurveTo(0, 1, -1.5, 4); g.quadraticCurveTo(-4, 0, 0, -5); g.fill();
  const f = 0.6 + 0.4 * Math.sin(time * 12 + x);
  g.fillStyle = `rgba(255,170,40,${0.7 * f})`;
  g.beginPath(); g.moveTo(-2, -12); g.quadraticCurveTo(0, -12 - 6 * f, 2, -12); g.fill();
  g.restore();
}
// Sugar Rush as a parachute supply drop
function drawSupplyDrop(x, y, k, g = ctx) {
  const s = k * 1.1;
  g.save(); g.translate(x, y + Math.sin(time * 2 + x) * 1.5); g.scale(s, s);
  g.fillStyle = '#f8f5ec'; g.strokeStyle = TH_INK; g.lineWidth = 1.1;
  g.beginPath(); g.arc(0, -8, 11, Math.PI, 0); g.quadraticCurveTo(5.5, -10, 0, -8); g.quadraticCurveTo(-5.5, -10, -11, -8); g.fill(); g.stroke();
  g.lineWidth = 0.7; g.beginPath(); g.moveTo(-11, -8); g.lineTo(-3, 4); g.moveTo(11, -8); g.lineTo(3, 4); g.moveTo(0, -8); g.lineTo(0, 4); g.stroke();
  g.fillStyle = '#fbfbf8'; g.lineWidth = 1; g.fillRect(-4.5, 3, 9, 8); g.strokeRect(-4.5, 3, 9, 8);
  g.fillStyle = TH_RED; g.fillRect(-0.8, 4.5, 1.6, 5); g.fillRect(-2.5, 6.2, 5, 1.6);
  g.restore();
}
// dashed perimeter around each colony's guard ring
function warPerimeters(L, R, T, B) {
  ctx.lineWidth = 1.6 / cam.zoom;
  ctx.setLineDash([8 / cam.zoom, 6 / cam.zoom]); ctx.lineDashOffset = -time * 12 / cam.zoom;
  for (const c of colonies) {
    if (!c.alive || !c.workers.length) continue;
    const q = c.queen, rr = c.outerR + 6;
    if (q.x + rr < L || q.x - rr > R || q.y + rr < T || q.y - rr > B) continue;
    ctx.strokeStyle = c.color; ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.arc(q.x, q.y, rr, 0, TAU); ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.lineDashOffset = 0;
}
// red hostile diamond around creatures
function warHostile(cr) {
  if (cr.type === 'drone') return;
  const R = cr.r + (cr.type === 'bee' ? 18 : 12);
  ctx.strokeStyle = TH_RED; ctx.lineWidth = 2.5 / cam.zoom;
  ctx.beginPath(); ctx.moveTo(cr.x, cr.y - R); ctx.lineTo(cr.x + R, cr.y); ctx.lineTo(cr.x, cr.y + R); ctx.lineTo(cr.x - R, cr.y); ctx.closePath(); ctx.stroke();
  if (cr.type === 'bee') {
    const R2 = R + 7;
    ctx.lineWidth = 1.2 / cam.zoom;
    ctx.beginPath(); ctx.moveTo(cr.x, cr.y - R2); ctx.lineTo(cr.x + R2, cr.y); ctx.lineTo(cr.x, cr.y + R2); ctx.lineTo(cr.x - R2, cr.y); ctx.closePath(); ctx.stroke();
  }
  const label = { spider: 'HOSTILE', ladybug: 'HOSTILE', wasp: 'RECON', bee: 'HVT' }[cr.type] || 'HOSTILE';
  ctx.font = `bold ${11 / cam.zoom}px "Courier New", monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = TH_RED; ctx.fillText(label, cr.x, cr.y + R + 9 / cam.zoom);
}
function warStar(x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.43 : r; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
  ctx.closePath();
}

// ---------- Garden Picnic: grass, gingham blankets and flowers ----------
function picnicGround(g) {
  const r = thRng(777);
  g.fillStyle = '#6cbb4c'; g.fillRect(0, 0, WORLD_W, WORLD_H);
  for (let i = 0; i < 140; i++) {   // soft light and dark patches
    const x = r() * WORLD_W, y = r() * WORLD_H, rr = 80 + r() * 220;
    const gr = g.createRadialGradient(x, y, 0, x, y, rr);
    gr.addColorStop(0, r() < 0.5 ? 'rgba(40,110,40,0.22)' : 'rgba(170,220,110,0.22)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, rr, 0, TAU); g.fill();
  }
  g.lineWidth = 2; g.lineCap = 'round';   // grass blades, batched by colour
  for (const col of ['rgba(60,140,50,0.55)', 'rgba(130,200,90,0.5)', 'rgba(40,110,40,0.45)']) {
    g.strokeStyle = col; g.beginPath();
    for (let i = 0; i < 5000; i++) { const x = r() * WORLD_W, y = r() * WORLD_H; g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 6, y - 6 - r() * 6); }
    g.stroke();
  }
  // gingham picnic blankets
  for (let i = 0; i < 6; i++) {
    const x = 300 + r() * (WORLD_W - 600), y = 300 + r() * (WORLD_H - 600), w = 300 + r() * 180, h = 220 + r() * 120, rot = (r() - 0.5) * 0.7;
    g.save(); g.translate(x, y); g.rotate(rot);
    g.fillStyle = 'rgba(20,60,20,0.25)'; g.fillRect(-w / 2 + 8, -h / 2 + 10, w, h);
    g.fillStyle = '#fbf7ee'; g.fillRect(-w / 2, -h / 2, w, h);
    g.fillStyle = 'rgba(226,64,64,0.45)';
    for (let sx = -w / 2; sx < w / 2; sx += 40) g.fillRect(sx, -h / 2, 20, h);
    for (let sy = -h / 2; sy < h / 2; sy += 40) g.fillRect(-w / 2, sy, w, 20);
    g.strokeStyle = 'rgba(160,40,40,0.5)'; g.lineWidth = 3; g.strokeRect(-w / 2, -h / 2, w, h);
    g.restore();
  }
  // flowers
  for (let i = 0; i < 420; i++) {
    const x = r() * WORLD_W, y = r() * WORLD_H, s = 4 + r() * 4;
    g.fillStyle = ['#ffffff', '#fff27a', '#ffb3d1', '#c9b3ff'][Math.floor(r() * 4)];
    for (let p = 0; p < 5; p++) { const a = p / 5 * TAU; g.beginPath(); g.arc(x + Math.cos(a) * s * 0.7, y + Math.sin(a) * s * 0.7, s * 0.5, 0, TAU); g.fill(); }
    g.fillStyle = '#f5b021'; g.beginPath(); g.arc(x, y, s * 0.35, 0, TAU); g.fill();
  }
  g.strokeStyle = 'rgba(30,80,30,0.14)'; g.lineWidth = 1.2; g.beginPath();   // faint mowing lines
  for (let x = 100; x < WORLD_W; x += 100) { g.moveTo(x, 0); g.lineTo(x, WORLD_H); }
  for (let y = 100; y < WORLD_H; y += 100) { g.moveTo(0, y); g.lineTo(WORLD_W, y); }
  g.stroke();
}
// food as little green grapes
function picnicFood(L, R, T, B) {
  ctx.beginPath();
  for (const f of food) {
    if (f.honey || f.x < L || f.x > R || f.y < T || f.y > B) continue;
    const r = f.r * f.age * 1.05;
    ctx.moveTo(f.x + r, f.y); ctx.arc(f.x, f.y, r, 0, TAU);
    ctx.moveTo(f.x + f.ox + r * 0.8, f.y + f.oy); ctx.arc(f.x + f.ox, f.y + f.oy, r * 0.8, 0, TAU);
  }
  ctx.fillStyle = '#a24ad0'; ctx.fill();
  ctx.strokeStyle = '#4a1466'; ctx.lineWidth = 0.9; ctx.stroke();
  ctx.beginPath();
  for (const f of food) {
    if (f.honey || f.x < L || f.x > R || f.y < T || f.y > B) continue;
    const r = f.r * f.age;
    ctx.moveTo(f.x, f.y - r); ctx.lineTo(f.x + r * 0.6, f.y - r * 1.9);
  }
  ctx.strokeStyle = '#7a5a2a'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.beginPath();
  for (const f of food) {
    if (f.honey || f.x < L || f.x > R || f.y < T || f.y > B) continue;
    const r = f.r * f.age * 0.3;
    ctx.moveTo(f.x - r + r, f.y - r * 1.2); ctx.arc(f.x - r, f.y - r * 1.2, r, 0, TAU);
  }
  ctx.fill();
}
// a paper plate under each picnic power-up
function picnicPlate(x, y, k, g = ctx) {
  g.fillStyle = 'rgba(20,60,20,0.25)'; g.beginPath(); g.ellipse(x + 2, y + 4, 17 * k, 12 * k, 0, 0, TAU); g.fill();
  g.fillStyle = '#ffffff'; g.strokeStyle = '#d9d2c2'; g.lineWidth = 1.2;
  g.beginPath(); g.ellipse(x, y + 2, 16 * k, 11 * k, 0, 0, TAU); g.fill(); g.stroke();
  g.beginPath(); g.ellipse(x, y + 2, 11 * k, 7.5 * k, 0, 0, TAU); g.stroke();
}

// ---------- shared hooks ----------
const TH_LOOK = {
  default: { clear: '#24160a', border: 'rgba(20,10,3,0.8)', panel: 'rgba(30,18,8,0.72)', panelEdge: 'rgba(212,168,67,0.55)', radius: 12, mini: '#4a3019', bannerFont: '"Trebuchet MS", sans-serif', bannerEdge: 'rgba(40,18,4,0.9)' },
  war: { clear: '#15202b', border: 'rgba(31,29,24,0.9)', panel: 'rgba(21,32,43,0.86)', panelEdge: 'rgba(201,185,143,0.8)', radius: 3, mini: '#e6dcc2', bannerFont: 'Impact, "Arial Black", sans-serif', bannerEdge: 'rgba(21,32,43,0.95)' },
  picnic: { clear: '#3f7f33', border: 'rgba(47,93,42,0.9)', panel: 'rgba(38,84,34,0.8)', panelEdge: 'rgba(255,255,255,0.75)', radius: 16, mini: '#5aa643', bannerFont: '"Trebuchet MS", sans-serif', bannerEdge: 'rgba(150,30,30,0.9)' },
};
function look() { return TH_LOOK[TH] || TH_LOOK.default; }
function themedRuleIcon(g, icon, dot) {
  if (TH === 'picnic') {
    if (icon !== 'crumb') return false;
    for (const [x, y] of [[11, 17], [18, 18], [14.5, 11]]) { g.fillStyle = '#a24ad0'; g.strokeStyle = '#4a1466'; g.lineWidth = 1; g.beginPath(); g.arc(x, y, 5, 0, TAU); g.fill(); g.stroke(); dot(x - 1.6, y - 1.8, 1.4, 'rgba(255,255,255,0.75)'); }
    g.strokeStyle = '#7a5a2a'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(14.5, 6); g.lineTo(17, 2.5); g.stroke();
    return true;
  }
  // War Room
  switch (icon) {
    case 'crumb': warCrate(g, 11, 17, 5, '#7d8a3a'); warCrate(g, 20, 12, 4.5, '#7d8a3a'); return true;
    case 'chili': drawIncendiary(15, 16, 0.85, g); return true;
    case 'sugar': drawSupplyDrop(15, 17, 0.95, g); return true;
    case 'garden':
      g.fillStyle = 'rgba(61,106,53,0.25)'; g.strokeStyle = '#6fae5f'; g.lineWidth = 2; g.beginPath(); g.arc(15, 15, 13, 0, TAU); g.fill(); g.stroke();
      g.fillStyle = '#f6f0df'; g.strokeStyle = TH_INK; g.lineWidth = 1.3; g.beginPath(); g.moveTo(8, 20); g.lineTo(15, 8); g.lineTo(22, 20); g.closePath(); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(15, 8); g.lineTo(15, 20); g.stroke(); return true;
    case 'tunnel':
      dot(15, 15, 13, '#efe6cf'); dot(15, 15, 6, '#2a2620');
      g.strokeStyle = TH_INK; g.lineWidth = 1.6; g.beginPath(); g.arc(15, 15, 10, 0, TAU); g.stroke();
      g.strokeStyle = '#c9a0ff'; g.lineWidth = 2; g.beginPath(); g.arc(15, 15, 13, 0, TAU); g.stroke(); return true;
    case 'terrain': {
      g.fillStyle = '#a9c8dc'; g.strokeStyle = '#3d6f93'; g.lineWidth = 1.4; g.beginPath(); g.ellipse(19, 21, 10, 6, -0.2, 0, TAU); g.fill(); g.stroke();
      const pts = [[4, 17], [7, 7], [14, 4], [19, 9], [17, 17], [10, 20]];
      g.fillStyle = '#d3c9ad'; g.strokeStyle = TH_INK; g.lineWidth = 1.3; g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.fill(); g.stroke();
      g.lineWidth = 1; g.beginPath(); for (const [x, y] of pts) { g.moveTo(x, y); g.lineTo(x + (11 - x) * 0.3, y + (12 - y) * 0.3); } g.stroke();
      return true;
    }
  }
  return false;
}
function applyTheme() {
  TH = TH_LOOK[settings.theme] ? settings.theme : 'default';
  document.body.dataset.theme = TH;
  document.querySelectorAll('[data-theme-opt]').forEach(b => b.classList.toggle('on', b.dataset.themeOpt === TH));
  if (bgCanvas) buildBackground();
  miniCache.t = -1;
  drawRuleIcons();
}
document.querySelectorAll('[data-theme-opt]').forEach(b => b.addEventListener('click', () => {
  settings.theme = b.dataset.themeOpt; saveSettings(); applyTheme();
}));

function openOptions() {
  if (state !== 'playing') return;
  state = 'paused';
  document.getElementById('optionsScreen').classList.remove('hidden');
}
function closeOptions() {
  if (state !== 'paused') return;
  state = 'playing';
  document.getElementById('optionsScreen').classList.add('hidden');
}
function goToMenu(lost = false) {
  if ((state === 'paused' || state === 'playing') && player && player.alive && !lost) {
    stats.endTime = time - stats.start;
    recordBest(false, stats.endTime); checkAchievements(false); saveLife();
    awardXP(matchXP(false).total);
  }
  for (const id of ['optionsScreen', 'overScreen', 'winScreen']) document.getElementById(id).classList.add('hidden');
  document.getElementById('optionsBtn').classList.add('hidden');
  send({ t: 'leave' });
  net.myId = 0; net.joining = false; player = null;
  state = 'title';
  updateNetStatus();
  document.querySelectorAll('.skin').forEach(b => b.classList.toggle('sel', +b.dataset.i === selectedSkin));
  drawLogo();
  document.getElementById('titleScreen').classList.remove('hidden');
}
document.getElementById('optionsBtn').addEventListener('click', openOptions);
document.getElementById('resumeBtn').addEventListener('click', closeOptions);
document.getElementById('quitBtn').addEventListener('click', goToMenu);
document.querySelectorAll('.menuBtn').forEach(b => b.addEventListener('click', goToMenu));
// every button gives a little click; the first interaction anywhere starts the menu music
document.addEventListener('click', e => { if (e.target.closest('button')) { startMusic(); playSfx('click'); } });
window.addEventListener('pointerdown', startMusic);
window.addEventListener('keydown', startMusic);

// ============================================================
//  Multiplayer: connection, snapshots, interpolation, input
// ============================================================
const INTERP = 0.1;   // seconds the view runs behind the server, to smooth over network jitter
const CR_R = { spider: 16, ladybug: 20, wasp: 11, bee: 30, drone: 9 };
const qs = new URLSearchParams(location.search);
const cleanRoom = s => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
const net = {
  ws: null, connected: false, room: cleanRoom(qs.get('room')) || 'public',
  diff: DIFFS[qs.get('diff')] ? qs.get('diff') : (DIFFS[settings.diff] ? settings.diff : 'normal'),
  myId: 0, joining: false, snaps: [], offset: null, serverT: 0, retry: 0, players: 0,
  info: new Map(), cols: new Map(), wobj: new Map(), cobj: new Map(), foodSeen: new Map(), puSeen: new Map(),
  queue: [], lastSend: 0, lastIn: null, mapGardens: [],
  lastAnts: new Map(), foodMap: new Map(), far: [], lastH: {},
};
if (qs.get('diff')) settings.diff = net.diff;
const decoder = new TextDecoder();

function wsUrl() {
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?room=' + encodeURIComponent(net.room) + '&diff=' + net.diff;
}
function connect() {
  if (net.ws) { net.ws.onclose = null; try { net.ws.close(); } catch (e) {} }
  net.connected = false; net.snaps = []; net.offset = null; net.myId = 0; net.info.clear(); net.cols.clear();
  net.wobj.clear(); net.cobj.clear(); net.foodSeen.clear(); net.puSeen.clear(); net.queue = [];
  net.lastAnts = new Map(); net.foodMap = new Map(); net.far = []; net.lastH = {};
  colonies = []; food = []; powerups = []; creatures = []; particles = []; floaters = [];
  updateNetStatus('Connecting...');
  let ws;
  try { ws = new WebSocket(wsUrl()); } catch (e) { updateNetStatus('Could not connect to the game server'); return; }
  ws.binaryType = 'arraybuffer';
  net.ws = ws;
  ws.onopen = () => { net.connected = true; net.retry = 0; updateNetStatus(); };
  ws.onmessage = e => {
    if (typeof e.data === 'string') onJson(JSON.parse(e.data));
    else onSnapshot(e.data);
  };
  ws.onclose = () => {
    net.connected = false;
    if (state === 'playing' || state === 'paused' || state === 'dying') {
      addBanner('CONNECTION LOST', 'Reconnecting to the server...', '#ff8a7a', 3, 40);
      goToMenu(true);
    }
    updateNetStatus('Disconnected - reconnecting...');
    setTimeout(connect, Math.min(8000, 1000 * ++net.retry));
  };
}
function send(obj) { if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify(obj)); }

function onJson(m) {
  if (m.t === 'pong') { perfStats.ping = Math.round(performance.now() - m.n); return; }
  if (m.t === 'hello') { net.players = m.players.length; updateNetStatus(); }
  else if (m.t === 'map') applyMap(m);
  else if (m.t === 'joined') {
    net.myId = m.id; net.joining = false;
    beginMatch();
  } else if (m.t === 'full') {
    net.joining = false;
    updateNetStatus('This room is full - try another room name');
  }
}

function applyMap(m) {
  rocks = m.rocks; puddles = m.puddles; tunnels = m.tunnels;
  net.mapGardens = m.gardens.map(g => ({ x: g.x, y: g.y, shrooms: g.shrooms, owner: null, contested: false, acc: 0 }));
  gardens = net.mapGardens;
  if (m.diff && m.diff !== net.diff) { net.diff = m.diff; }
  buildBackground(); miniCache.t = -1;
}

// ---------- snapshots ----------
function onSnapshot(buf) {
  try { decodeSnapshot(buf); } catch (err) { console.error('bad snapshot, reconnecting', err); connect(); }
}
function decodeSnapshot(buf) {
  const dv = new DataView(buf);
  const hl = dv.getUint32(0, true);
  const h = JSON.parse(decoder.decode(new Uint8Array(buf, 4, hl)));
  let o = 4 + hl;
  for (const id in h.info) {
    const [name, color, skinId, crown, human] = h.info[id];
    net.info.set(+id, { name, color, skin: SKINS.find(k => k.id === skinId) || null, crown, human: !!human });
  }
  // binary part: ants and food as changes against the previous snapshot (see server/world.js snapshotFor)
  const bytes = new Uint8Array(buf);
  const varint = () => { let v = 0, mul = 1, b; do { b = bytes[o++]; v += (b & 127) * mul; mul *= 128; } while (b & 128); return v; };
  const ants = new Map();   // colony id -> array of ants
  const antIndex = new Map(), prevAnts = net.lastAnts;
  for (let i = 0; i < h.ac.length; i += 2) {
    const arr = [];
    let id = 0;
    for (let k = 0; k < h.ac[i + 1]; k++) {
      const v = varint(), full = v % 2 === 1;
      id += Math.floor(v / 2);
      let qx, qy;
      if (full) { qx = dv.getUint16(o, true); qy = dv.getUint16(o + 2, true); o += 4; }
      else { const p = prevAnts.get(id); qx = p.qx + dv.getInt8(o); qy = p.qy + dv.getInt8(o + 1); o += 2; }
      const a = { id, qx, qy, x: qx / 8, y: qy / 8, ang: bytes[o++] / 255 * TAU, col: h.ac[i] };
      arr.push(a); antIndex.set(id, a);
    }
    ants.set(h.ac[i], arr);
  }
  net.lastAnts = antIndex;
  const vw = W / 2 / cam.zoom, vh = H / 2 / cam.zoom;
  const inView = (x, y) => Math.abs(x - cam.x) < vw && Math.abs(y - cam.y) < vh;
  const fm = net.foodMap;
  let nRem = varint(), fid = 0;
  for (let k = 0; k < nRem; k++) {
    fid += varint();
    const f = fm.get(fid);
    if (f) { fm.delete(fid); if (inView(f.x, f.y)) queueFx(h.time, () => crumbFlecks(f.x, f.y)); }
  }
  const nAdd = varint(); fid = 0;
  for (let k = 0; k < nAdd; k++) {
    fid += varint();
    const r = bytes[o + 4];
    const old = fm.get(fid);
    fm.set(fid, { id: fid, x: dv.getUint16(o, true) / 8, y: dv.getUint16(o + 2, true) / 8, r: (r & 127) / 20, honey: r >= 128, age: old ? old.age : 0 });
    o += 5;
  }
  const foods = [...fm.values()];
  // parts the server leaves out when unchanged: reuse the previous ones
  for (const key of ['pu', 'gd', 'ev', 'cr', 'st']) if (h[key] === undefined) h[key] = net.lastH[key];
  if (!h.pu) h.pu = []; if (!h.gd) h.gd = []; if (!h.ev) h.ev = {}; if (!h.cr) h.cr = [];
  net.lastH = h;
  if (h.far) net.far = h.far;
  const colIndex = new Map();
  for (const c of h.cols) colIndex.set(c[0], c);
  const allCols = h.cols.slice();
  for (const c of net.far) if (!colIndex.has(c[0])) { colIndex.set(c[0], c); allCols.push(c); }
  const crIndex = new Map();
  for (const c of h.cr) crIndex.set(c[0], c);
  const snap = { time: h.time, h, ants, antIndex, foods, colIndex, crIndex, allCols };
  const now = performance.now() / 1000;
  const off = h.time - now;
  if (net.offset === null || Math.abs(off - net.offset) > 0.5) net.offset = off;
  else net.offset += (off - net.offset) * 0.05;
  // ants that vanished inside the view since the last snapshot have fallen: leave a splat
  const prev = net.snaps[net.snaps.length - 1];
  if (prev) {
    for (const a of prev.antIndex.values()) {
      if (antIndex.has(a.id) || !inView(a.x, a.y)) continue;
      const info = net.info.get(a.col);
      if (info) queueFx(h.time, () => splat(a.x, a.y, info.color, info.dark || shade(info.color, -0.5)));
    }
  }
  net.snaps.push(snap);
  if (net.snaps.length > 12) net.snaps.shift();
  // events play when the delayed view reaches them
  if (h.e) for (const e of h.e) queueFx(h.time, () => onEvent(e, false));
  if (h.p) for (const e of h.p) queueFx(h.time, () => onEvent(e, true));
  if (h.sfx) queueFx(h.time, () => { for (const n of h.sfx) playSfx(n); });
  if (h.srv) perfStats.srv = h.srv;
  if (h.life) for (const k in h.life) life[k] = (life[k] || 0) + h.life[k];
  if (h.lifeMax) for (const k in h.lifeMax) life[k] = Math.max(life[k] || 0, h.lifeMax[k]);
  if (h.st && state !== 'title') {
    stats.kills = h.st.k; stats.streak = h.st.s; stats.lastConquerSrv = h.st.lc; stats.speed = h.st.sp;
    stats.bestStreak = Math.max(stats.bestStreak || 0, h.st.s);
  }
  if (h.me === 0 && net.myId && state === 'playing' && !net.joining) {
    // our colony is gone without a death notice (should not happen): back to the menu
  }
}
function queueFx(t, fn) { net.queue.push({ t, fn }); }
function splat(x, y, color, dark) {
  particles.push({ type: 'splat', x, y, color, life: 3, max: 3, r: rand(3, 5) });
  for (let i = 0; i < 3; i++) {
    const a = rand(0, TAU), s = rand(30, 90);
    particles.push({ type: 'fleck', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, color: dark, life: 0.5, max: 0.5, r: 1.3 });
  }
}
function crumbFlecks(x, y) {
  for (let i = 0; i < 3; i++) {
    const a = rand(0, TAU), s = rand(20, 60);
    particles.push({ type: 'fleck', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, color: '#9dff6e', life: 0.4, max: 0.4, r: 1.4 });
  }
}

function onEvent(e, mine) {
  switch (e.t) {
    case 'ring': floaters.push({ type: 'ring', x: e.x, y: e.y, color: e.color, life: e.life, max: e.life, r: e.r }); break;
    case 'text': floaters.push({ type: 'text', text: e.text, x: e.x, y: e.y, color: e.color, life: e.life, max: e.life, size: e.size }); break;
    case 'banner': addBanner(e.text, e.sub, e.color, e.life, e.size); break;
    case 'shake': addShake(e.a); break;
    case 'sfx':
      if (e.x === undefined) playSfx(e.name);
      else if (state === 'playing' && onScreen(e.x, e.y)) playSfx(e.name, e.vol || 1);
      break;
    case 'smoke':
      particles.push({ type: 'spark', x: e.x + rand(-20, 20), y: e.y + rand(-20, 20), vx: rand(-10, 10), vy: rand(-60, -30), color: 'rgba(90,80,70,0.8)', life: 0.9, max: 0.9, r: 2.5 });
      break;
    case 'burst':
      for (let i = 0; i < 24; i++) {
        const a = rand(0, TAU), sp = rand(60, 200);
        particles.push({ type: 'spark', x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, color: i % 2 ? '#ffe27a' : '#ffffff', life: 0.9, max: 0.9, r: 2 });
      }
      break;
    case 'conquest': {
      particles.push({ type: 'splat', x: e.x, y: e.y, color: e.lc, life: 5, max: 5, r: 11 });
      for (let i = 0; i < 16; i++) {
        const a = rand(0, TAU), s = rand(60, 180);
        particles.push({ type: 'fleck', x: e.x, y: e.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, color: i % 2 ? e.lc : e.wc, life: 0.8, max: 0.8, r: 2 });
      }
      floaters.push({ type: 'ring', x: e.x, y: e.y, color: e.wc, life: 0.9, max: 0.9, r: 90 });
      if (e.win !== net.myId && e.lose !== net.myId && state === 'playing') {
        if (onScreen(e.x, e.y, 200)) playSfx('rival');
        if (onScreen(e.x, e.y, 100)) addShake(4);
      }
      break;
    }
    case 'power': {
      const info = POWER_INFO[e.type];
      floaters.push({ type: 'ring', x: e.x, y: e.y, color: info.color, life: 0.8, max: 0.8, r: 60 });
      for (let i = 0; i < 12; i++) {
        const a = rand(0, TAU), sp = rand(60, 160);
        particles.push({ type: 'spark', x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, color: info.color, life: 0.6, max: 0.6, r: 2 });
      }
      if (e.by === net.myId && player) floaters.push({ type: 'text', text: info.msg, x: player.queen.x, y: player.queen.y - 50, color: info.color, life: 2, max: 2, size: 18 });
      else if (state === 'playing') floaters.push({ type: 'text', text: `${e.name} took ${info.name}`, x: e.x, y: e.y - 20, color: info.color, life: 1.6, max: 1.6, size: 13 });
      break;
    }
    case 'tunnel':
      for (const [x, y, g] of [[e.ax, e.ay, e.ag], [e.bx, e.by, e.bg]]) {
        floaters.push({ type: 'ring', x, y, color: TUNNEL_COLORS[g], life: 0.7, max: 0.7, r: 50 });
        for (let i = 0; i < 10; i++) {
          const a = rand(0, TAU), sp = rand(40, 120);
          particles.push({ type: 'fleck', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, color: '#8a6440', life: 0.6, max: 0.6, r: 2 });
        }
      }
      break;
    case 'teleport': cam.x += e.dx; cam.y += e.dy; break;
    case 'milestone': if (player && MILESTONES[e.i]) reachMilestone(MILESTONES[e.i]); break;
    case 'won': {
      floaters.push({ type: 'text', text: `Conquered ${e.name}! +${e.size}`, x: e.x, y: e.y - 30, color: '#ffe27a', life: 2, max: 2, size: 22 });
      playSfx('conquer');
      if (e.streak >= 2) playSfx('combo');
      if (e.human) addBanner('PLAYER CONQUERED!', `You took ${e.name}'s colony`, '#ffd54a', 2.4, 40);
      addShake(9 + Math.min(e.streak, 5) * 2);
      playKillFx(e.x, e.y);
      hitStop = Math.max(hitStop, 0.1);
      break;
    }
    case 'died':
      if (!mine || state !== 'playing' && state !== 'paused') break;
      stats.finalSize = e.size; stats.killedBy = e.by; stats.peak = Math.max(stats.peak, e.peak);
      stats.kills = e.kills; stats.bestStreak = Math.max(stats.bestStreak, e.bestStreak);
      stats.deathX = e.x; stats.deathY = e.y; stats.deathCause = e.cause; stats.endTime = e.time;
      if (player) player.alive = false;
      net.myId = 0;
      document.getElementById('optionsScreen').classList.add('hidden');
      startDeathCam({ name: e.by });
      break;
  }
}

// ---------- per-frame: rebuild the world from the two snapshots around the view time ----------
function interpolateWorld(dt) {
  const snaps = net.snaps;
  if (!snaps.length) return;
  const now = performance.now() / 1000;
  const rt = now + net.offset - INTERP;
  let a = snaps[0], b = snaps[0];
  for (let i = 0; i < snaps.length; i++) {
    if (snaps[i].time <= rt) a = snaps[i];
    if (snaps[i].time >= rt) { b = snaps[i]; break; }
    b = snaps[i];
  }
  const span = b.time - a.time;
  const k = span > 0 ? clamp((rt - a.time) / span, 0, 1) : 1;
  net.serverT = a.time + span * k;
  while (net.queue.length && net.queue[0].t <= net.serverT) net.queue.shift().fn();
  if (net.queue.length > 400) net.queue.splice(0, net.queue.length - 400);
  const lerp = (p, q) => p + (q - p) * k;
  const near = (ax, ay, bx, by) => Math.abs(ax - bx) < 150 && Math.abs(ay - by) < 150;

  // colonies
  const list = [];
  for (const cb of b.allCols) {
    const id = cb[0], ca = a.colIndex.get(id) || cb, info = net.info.get(id);
    if (!info) continue;
    let c = net.cobj.get(id);
    if (!c) {
      c = { id, name: info.name, color: info.color, dark: shade(info.color, info.color === '#26262b' ? -0.6 : -0.5),
            skin: info.skin, crownColor: info.crown || '#ffd700', human: info.human, alive: true, workers: [], n: 0,
            queen: { x: cb[1], y: cb[2], vx: 0, vy: 0, ang: 0, walk: 0 }, outerR: RING0, frenzy: 0, rush: 0, grace: 0,
            tunnelCd: 0, charge: 0, chargeCd: 0, chargeX: cb[1], chargeY: cb[2], crownLevel: 0, food: 0 };
      info.dark = c.dark;
      net.cobj.set(id, c);
    }
    c.alive = true; c.isPlayer = id === net.myId && net.myId !== 0; c.seen = time;
    const q = c.queen, jump = !near(ca[1], ca[2], cb[1], cb[2]);
    const nx = jump ? cb[1] : lerp(ca[1], cb[1]), ny = jump ? cb[2] : lerp(ca[2], cb[2]);
    if (dt > 0) {
      const sp = Math.hypot(nx - q.x, ny - q.y) / dt;
      if (sp < 2000) { q.vx += ((nx - q.x) / dt - q.vx) * 0.3; q.vy += ((ny - q.y) / dt - q.vy) * 0.3; q.walk += Math.min(sp, 400) * dt * 0.13; }
    }
    q.x = nx; q.y = ny;
    c.n = cb[3];
    if (cb.length > 4) {
      q.ang = ca.length > 4 ? lerpAngle(ca[4], cb[4], k) : cb[4];
      c.outerR = cb[5];
      const f = cb[6];
      c.frenzy = f & 1 ? 1 : 0; c.rush = f & 2 ? 1 : 0; c.human = !!(f & 8);
      c.grace = cb[7]; c.tunnelCd = cb[8]; c.chargeX = cb[9]; c.chargeY = cb[10]; c.crownLevel = cb[11];
      c.charge = cb[12]; c.chargeCd = cb[13];
    }
    // workers
    const arrB = b.ants.get(id);
    const ws = c.workers; ws.length = 0;
    if (arrB) {
      for (const wb of arrB) {
        const wa = a.antIndex.get(wb.id);
        let w = net.wobj.get(wb.id);
        if (!w) { w = { id: wb.id, x: wb.x, y: wb.y, ang: wb.ang, walk: Math.random() * 10, col: c }; net.wobj.set(wb.id, w); }
        let x = wb.x, y = wb.y, ang = wb.ang;
        if (wa && near(wa.x, wa.y, wb.x, wb.y)) { x = lerp(wa.x, wb.x); y = lerp(wa.y, wb.y); ang = lerpAngle(wa.ang, wb.ang, k); }
        const moved = Math.hypot(x - w.x, y - w.y);
        w.walk += Math.max(moved, 12 * dt) * 0.3;
        w.x = x; w.y = y; w.ang = ang; w.col = c; w.seen = time;
        ws.push(w);
      }
    }
    list.push(c);
  }
  colonies = list;
  if (net.wobj.size > 4000 || Math.random() < 0.02) for (const [id, w] of net.wobj) if (w.seen !== time) net.wobj.delete(id);
  if (Math.random() < 0.01) for (const [id, c] of net.cobj) if (time - c.seen > 5) net.cobj.delete(id);
  const me = net.myId ? net.cobj.get(net.myId) : null;
  if (me && me.alive && colonies.includes(me)) player = me;

  // food (static: newest snapshot) with a pop-in when it first appears
  food = b.foods;
  for (const f of food) {
    let s = net.foodSeen.get(f.id);
    if (s === undefined) { s = time; net.foodSeen.set(f.id, s); }
    f.age = Math.min(1, (time - s) * 2 + (s === 0 ? 1 : 0));
    f.ox = ((f.id * 37) % 30) / 10 - 1.5; f.oy = ((f.id * 53) % 30) / 10 - 1.5;
  }
  if (net.foodSeen.size > 3000) net.foodSeen.clear();
  powerups = b.h.pu.map(([id, x, y, t]) => {
    let s = net.puSeen.get(id);
    if (s === undefined) { s = time; net.puSeen.set(id, s); }
    return { id, x, y, type: t === 0 ? 'frenzy' : 'rush', age: time - s, bob: id % 7 };
  });
  b.h.gd.forEach(([owner, contested, acc], i) => {
    const g = gardens[i];
    if (!g) return;
    g.owner = owner ? net.cobj.get(owner) || null : null; g.contested = !!contested; g.acc = acc;
  });
  // creatures
  creatures = b.h.cr.map(cb => {
    const ca = a.crIndex.get(cb[0]) || cb;
    let cr = net.cobj.get('c' + cb[0]);
    if (!cr) { cr = { t: 0 }; net.cobj.set('c' + cb[0], cr); }
    cr.t += dt; cr.seen = time;
    const jump = !near(ca[2], ca[3], cb[2], cb[3]);
    Object.assign(cr, { id: cb[0], type: cb[1], x: jump ? cb[2] : lerp(ca[2], cb[2]), y: jump ? cb[3] : lerp(ca[3], cb[3]),
      ang: lerpAngle(ca[4], cb[4], k), hp: cb[5], max: cb[6], state: cb[7] ? 'flipped' : '', flipT: 4, hitFlash: cb[8] ? 0.1 : 0,
      munch: cb[9] ? 0.2 : 0, webR: cb[10], webSeed: cb[11], r: CR_R[cb[1]] || 12 });
    return cr;
  });
  // map events
  const ev = b.h.ev, eva = a.h.ev;
  raining = ev.rain || 0; quakeTime = ev.quake || 0;
  picnic = ev.picnic ? { x: ev.picnic[0], y: ev.picnic[1], t: ev.picnic[2] } : null;
  magnifier = ev.mag ? { x: eva.mag ? lerp(eva.mag[0], ev.mag[0]) : ev.mag[0], y: eva.mag ? lerp(eva.mag[1], ev.mag[1]) : ev.mag[1], t: ev.mag[2] } : null;
  flood = ev.flood ? { side: ev.flood[0], t: ev.flood[1], dur: ev.flood[2] } : null;
  migration = ev.mig ? { t: ev.mig } : null;
  nightT = ev.night || 0; bloodMoon = ev.blood || 0; sugarRain = ev.sugar || 0;
  golden = ev.golden ? { x: ev.golden[0], y: ev.golden[1], progress: ev.golden[2], lead: net.cobj.get(ev.golden[3]) || null } : null;
  if (quakeTime > 0) addShake(6 * Math.min(1, quakeTime));
  if (player && player.isPlayer) player.food = (b.h.st && b.h.st.fd) || 0;
}

// ---------- input to the server ----------
const perfStats = { ping: 0, srv: null, show: false, fps: 60, frameMs: 0, lastPing: 0 };
window.addEventListener('keydown', e => { if (e.code === 'F3') { e.preventDefault(); perfStats.show = !perfStats.show; } });
function drawPerf() {
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  if (!perfStats.show) return;
  const s = perfStats.srv || {};
  const lines = [
    `FPS ${Math.round(perfStats.fps)}   frame ${perfStats.frameMs.toFixed(1)} ms   detail ${Math.round(quality * 100)}%`,
    `Ping ${perfStats.ping} ms   download ${s.kbps ?? '-'} KB/s`,
    `Server: step ${s.step ?? '-'} ms   load ${s.load ?? '-'}%`,
    `On screen: ${colonies.reduce((a, c) => a + c.workers.length, 0)} ants, ${food.length} crumbs, ${particles.length} effects`,
  ];
  const x = 14, y = H - 120, w = 360, h = lines.length * 17 + 12;
  panel(x, y, w, h);
  ctx.font = '12px ui-monospace, Consolas, monospace';
  lines.forEach((l, i) => {
    const bad = (i === 0 && perfStats.fps < 40) || (i === 1 && perfStats.ping > 150) || (i === 2 && s.load > 70);
    ctx.fillStyle = bad ? '#ff8a7a' : '#e8f5d8';
    ctx.fillText(l, x + 10, y + 19 + i * 17);
  });
}
function sendInput(now) {
  if (net.connected && now - perfStats.lastPing > 2000) { perfStats.lastPing = now; send({ t: 'ping', n: now }); }
  if (!net.connected || now - net.lastSend < 33) return;
  net.lastSend = now;
  const msg = { t: 'in', cx: Math.round(cam.x), cy: Math.round(cam.y), hw: Math.round(W / 2 / cam.zoom), hh: Math.round(H / 2 / cam.zoom) };
  if (player && player.alive && (state === 'playing' || state === 'paused')) {
    // paused (options open): stand still and brace
    const m = state === 'paused' ? player.queen : screenToWorld(mouse.x, mouse.y);
    msg.x = Math.round(m.x); msg.y = Math.round(m.y);
  }
  send(msg);
}
function tryPlayerCharge() {
  if (state !== 'playing' || !player || !player.alive) return;
  if (player.chargeCd > 0 || player.charge > 0) return;
  const m = screenToWorld(mouse.x, mouse.y);
  send({ t: 'ch', x: Math.round(m.x), y: Math.round(m.y) });
  player.chargeCd = 0.2;   // don't spam while the server confirms
}
function enemyCount() { let n = 0; for (const c of colonies) if (c.alive && c.id !== net.myId) n++; return n; }
function diff() { return DIFFS[net.diff] || DIFFS.normal; }
function humanCount() { let n = 0; for (const c of colonies) if (c.human) n++; return n; }

// ---------- joining a match ----------
function startGame() {
  startMusic();
  if (!net.connected) { updateNetStatus('Not connected yet - please wait a moment'); return; }
  if (net.joining || state === 'playing') return;
  const nameEl = document.getElementById('nameInput');
  const name = (nameEl && nameEl.value.trim()) || 'Player';
  try { localStorage.setItem('coio-name', name); } catch (e) {}
  net.joining = true;
  send({ t: 'join', name, skin: SKINS[selectedSkin].id, crown: (COSMETICS.crown.find(o => o.id === prog.crown) || COSMETICS.crown[0]).color });
}
function beginMatch() {
  state = 'playing';
  player = null;
  stats = { start: time, kills: 0, peak: 5, finalSize: 0, killedBy: '', endTime: 0, streak: 0, bestStreak: 0, lastConquerSrv: -99,
            milestone: 0, deathCause: '', deathX: 0, deathY: 0, charges: 0, newAch: [], achTimer: 0, diff: net.diff, trailT: 0, speed: 100, topDone: false,
            chargesAtStart: life.charges };
  life.games++;
  banners = []; shake = 0; hitStop = 0;
  checkAchievements();
  mouse.x = W / 2; mouse.y = H / 2;
  for (const id of ['titleScreen', 'overScreen', 'winScreen', 'optionsScreen']) document.getElementById(id).classList.add('hidden');
  document.getElementById('optionsBtn').classList.remove('hidden');
  const me = net.cobj.get(net.myId);
  if (me) { cam.x = me.queen.x; cam.y = me.queen.y; }
}

// ---------- the client's own per-frame update (effects, camera, achievements) ----------
function clientUpdate(dt) {
  time += dt;
  interpolateWorld(dt);
  if ((state === 'playing' || state === 'paused') && player && player.alive) {
    const n = colonySize(player), elapsed = time - stats.start;
    stats.peak = Math.max(stats.peak, n);
    life.bestPeak = Math.max(life.bestPeak, n);
    life.longest = Math.max(life.longest, elapsed);
    if (n >= 50 && elapsed <= 120) life.blitz = 1;
    if (n >= 30 && life.charges === stats.chargesAtStart) life.pacifist = 1;
    if (stats.diff === 'nightmare') { life.nmPeak = Math.max(life.nmPeak, n); life.nmLongest = Math.max(life.nmLongest, elapsed); }
    // top of the hill: #1 on the leaderboard with 100+ ants
    if (!stats.topDone && n >= 100 && colonies.every(c => c === player || colonySize(c) < n)) {
      stats.topDone = true; life.wins++; if (stats.diff === 'nightmare') life.nmWins++;
      addBanner('KING OF THE HILL!', 'Your colony is the biggest on the map', '#ffd54a', 3, 46);
      playSfx('victory'); addShake(8);
    }
    if (prog.trail !== 'none' && (stats.trailT -= dt) <= 0) {
      const q = player.queen;
      if (Math.hypot(q.vx, q.vy) > 40) { stats.trailT = 0.03; spawnTrail(q); }
    }
    stats.achTimer -= dt;
    if (stats.achTimer <= 0) { stats.achTimer = 0.5; checkAchievements(); }
  }
  for (const p of particles) {
    p.life -= dt;
    if (p.vx !== undefined) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.9; p.vy *= 0.9; }
  }
  particles = particles.filter(p => p.life > 0);
  if (particles.length > 700) particles.splice(0, particles.length - 700);
  for (const f of floaters) { f.life -= dt; if (f.type === 'text') f.y -= 22 * dt; }
  floaters = floaters.filter(f => f.life > 0);
  updateCamera(dt);
}

// ---------- room / name controls on the main menu ----------
function inviteLink() { return location.origin + '/?room=' + encodeURIComponent(net.room) + '&diff=' + net.diff; }
function updateNetStatus(msg) {
  const el = document.getElementById('netStatus');
  if (!el) return;
  if (msg) { el.textContent = msg; el.classList.add('warn'); return; }
  el.classList.remove('warn');
  const humansIn = humanCount();
  el.textContent = net.connected
    ? `Connected to room "${net.room}" (${diff().name})` + (humansIn ? ` - ${humansIn} ${humansIn === 1 ? 'player' : 'players'} in game` : ' - nobody playing yet')
    : 'Connecting...';
}
function switchRoom(room, diffKey) {
  room = cleanRoom(room) || 'public';
  if (room === net.room && diffKey === net.diff && net.connected) return;
  net.room = room; net.diff = diffKey;
  const url = new URL(location.href);
  url.searchParams.set('room', room); url.searchParams.set('diff', diffKey);
  history.replaceState(null, '', url);
  connect();
}

// ---------- lobby: name, room and invite link ----------
function initLobby() {
  const nameEl = document.getElementById('nameInput'), roomEl = document.getElementById('roomInput');
  try { nameEl.value = localStorage.getItem('coio-name') || ''; } catch (e) {}
  roomEl.value = net.room;
  settings.diff = net.diff; applyDiffUI();
  const go = () => switchRoom(roomEl.value, settings.diff);
  roomEl.addEventListener('change', go);
  roomEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); roomEl.blur(); } });
  document.getElementById('inviteBtn').addEventListener('click', () => {
    go();
    const link = inviteLink(), btn = document.getElementById('inviteBtn');
    const done = ok => { btn.textContent = ok ? 'Link copied!' : link; setTimeout(() => { btn.textContent = 'Copy invite link'; }, 2500); };
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => done(true), () => done(false)); else done(false);
  });
  setInterval(() => { if (state === 'title' && net.connected) updateNetStatus(); }, 1000);
}

// ============================================================
//  Loop
// ============================================================
let last = performance.now();
const perf = { acc: 0, n: 0, good: 0 };
function adaptQuality(raw) {
  if (settings.gfx !== 'auto') return;
  if (raw > 0.25) return;                // tab was hidden / stalled: ignore
  perf.acc += raw; perf.n++;
  if (perf.acc < 1) return;
  const fps = perf.n / perf.acc;
  perf.acc = 0; perf.n = 0;
  if (fps < 48 && quality > 0.55) { quality = Math.max(0.55, quality - 0.15); perf.good = 0; resize(); }
  else if (fps > 58 && quality < 1) { if (++perf.good >= 4) { quality = Math.min(1, quality + 0.1); perf.good = 0; resize(); } }
  else perf.good = 0;
}

function frame(now) {
  let dt = (now - last) / 1000;
  last = now;
  const rawDt = dt;
  adaptQuality(dt);
  if (dt > 0.05) dt = 0.05;
  const realDt = dt;
  if (hitStop > 0) hitStop -= realDt;                           // freeze frame on big hits
  else clientUpdate(dt);
  sendInput(now);
  if (state === 'dying') { deathTimer -= realDt; if (deathTimer <= 0) endGame(false); }
  if (state === 'title') drawCosPreview(realDt);
  shake = Math.max(0, shake - realDt * 30);
  shakeX = (Math.random() * 2 - 1) * shake; shakeY = (Math.random() * 2 - 1) * shake;
  for (const b of banners) b.life -= realDt;
  banners = banners.filter(b => b.life > 0);
  const r0 = performance.now();
  render();
  perfStats.frameMs = perfStats.frameMs * 0.9 + (performance.now() - r0) * 0.1;
  if (rawDt > 0) perfStats.fps = perfStats.fps * 0.95 + (1 / Math.max(rawDt, 0.001)) * 0.05;
  requestAnimationFrame(frame);
}

document.getElementById('playBtn').addEventListener('click', startGame);
document.getElementById('restartBtn').addEventListener('click', startGame);
document.getElementById('againBtn').addEventListener('click', startGame);

// Small drawn icons for the How to play panel
function drawRuleIcons() {
  const d = Math.min(2, window.devicePixelRatio || 1);
  document.querySelectorAll('canvas[data-icon]').forEach(cv => {
    cv.width = 30 * d; cv.height = 30 * d;
    const g = cv.getContext('2d');
    g.setTransform(d, 0, 0, d, 0, 0);
    g.lineJoin = 'round'; g.lineCap = 'round';
    const dot = (x, y, r, c) => { g.fillStyle = c; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); };
    if (TH !== 'default' && themedRuleIcon(g, cv.dataset.icon, dot)) return;
    switch (cv.dataset.icon) {
      case 'crumb':
        dot(15, 15, 9, 'rgba(120,255,90,0.2)'); dot(14, 16, 5.5, '#5cc93a'); dot(17.5, 13.5, 4, '#5cc93a'); dot(12.5, 13.5, 1.8, '#b8ff8c'); break;
      case 'guard':
        for (let i = 0; i < 10; i++) { const a = i / 10 * TAU; dot(15 + Math.cos(a) * 11, 15 + Math.sin(a) * 11, 2.2, '#f5c542'); }
        dot(15, 15, 4.5, '#f5c542'); g.strokeStyle = '#7a5200'; g.lineWidth = 1; g.beginPath(); g.arc(15, 15, 4.5, 0, TAU); g.stroke(); break;
      case 'charge':
        g.strokeStyle = '#ffd54a'; g.lineWidth = 2;
        for (const y of [9, 15, 21]) { g.beginPath(); g.moveTo(4, y); g.lineTo(16, y); g.stroke(); }
        g.fillStyle = '#ff9a3c'; g.beginPath(); g.moveTo(16, 6); g.lineTo(27, 15); g.lineTo(16, 24); g.closePath(); g.fill(); break;
      case 'crown':
        g.fillStyle = '#ffd700'; g.strokeStyle = '#7a5200'; g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(5, 23); g.lineTo(4, 9); g.lineTo(10, 15); g.lineTo(15, 6); g.lineTo(20, 15); g.lineTo(26, 9); g.lineTo(25, 23); g.closePath(); g.fill(); g.stroke();
        dot(15, 18, 2, '#e0283c'); break;
      case 'danger':
        g.fillStyle = '#e0402a'; g.strokeStyle = '#6a1208'; g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(15, 4); g.lineTo(27, 25); g.lineTo(3, 25); g.closePath(); g.fill(); g.stroke();
        g.fillStyle = '#fff'; g.fillRect(13.8, 10, 2.4, 9); dot(15, 22, 1.4, '#fff'); break;
      case 'tags':
        g.fillStyle = 'rgba(40,120,40,0.95)'; roundRect(g, 2, 4, 16, 10, 4); g.fill();
        g.fillStyle = 'rgba(150,30,25,0.95)'; roundRect(g, 12, 16, 16, 10, 4); g.fill();
        g.fillStyle = '#fff'; g.font = 'bold 8px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('12', 10, 9.5); g.fillText('48', 20, 21.5); break;
      case 'streak':
        g.font = '900 15px "Trebuchet MS", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.lineWidth = 3; g.strokeStyle = '#5a1a04'; g.strokeText('x2', 15, 16); g.fillStyle = '#ff9a3c'; g.fillText('x2', 15, 16); break;
      case 'chili': drawChili(16, 15, 0.95, g); break;
      case 'sugar': drawSugarCube(15, 17, 1.05, g); break;
      case 'garden': {
        const gr = g.createRadialGradient(15, 16, 2, 15, 16, 14);
        gr.addColorStop(0, 'rgba(120,170,70,0.9)'); gr.addColorStop(1, 'rgba(90,120,50,0.1)');
        g.fillStyle = gr; g.beginPath(); g.arc(15, 16, 14, 0, TAU); g.fill();
        for (const [x, y, r, c] of [[10, 13, 5, '#c9674a'], [20, 18, 4, '#d9b27a']]) {
          g.fillStyle = '#e8dcc0'; g.fillRect(x - 1, y, 2, r * 0.9);
          g.fillStyle = c; g.beginPath(); g.ellipse(x, y, r, r * 0.65, 0, 0, TAU); g.fill();
          dot(x - r * 0.35, y - r * 0.2, r * 0.18, 'rgba(255,245,220,0.8)');
        }
        break;
      }
      case 'tunnel':
        dot(15, 15, 13, '#8a6440'); dot(14, 14, 11, '#a07650'); dot(15, 15, 8, '#0c0603');
        g.strokeStyle = '#c9a0ff'; g.lineWidth = 2; g.beginPath(); g.arc(15, 15, 13, 0, TAU); g.stroke(); break;
      case 'terrain':
        g.fillStyle = 'rgba(90,130,160,0.9)'; g.beginPath(); g.ellipse(19, 21, 10, 6, -0.2, 0, TAU); g.fill();
        g.fillStyle = '#8f8676'; g.beginPath(); g.moveTo(4, 17); g.lineTo(7, 7); g.lineTo(14, 4); g.lineTo(19, 9); g.lineTo(17, 17); g.lineTo(10, 20); g.closePath(); g.fill();
        g.fillStyle = 'rgba(255,245,225,0.3)'; g.beginPath(); g.moveTo(7, 9); g.lineTo(13, 6); g.lineTo(15, 10); g.lineTo(9, 12); g.closePath(); g.fill(); break;
      case 'storm':
        g.fillStyle = '#b8c4d4';
        g.beginPath(); g.arc(10, 12, 6, 0, TAU); g.arc(17, 9, 7, 0, TAU); g.arc(22, 13, 5, 0, TAU); g.rect(10, 12, 12, 6); g.fill();
        g.fillStyle = '#ffd54a'; g.beginPath(); g.moveTo(16, 17); g.lineTo(12, 24); g.lineTo(15, 24); g.lineTo(13, 29); g.lineTo(19, 21); g.lineTo(16, 21); g.lineTo(18, 17); g.closePath(); g.fill();
        g.strokeStyle = '#8fd0ff'; g.lineWidth = 1.4;
        for (const x of [7, 23]) { g.beginPath(); g.moveTo(x, 20); g.lineTo(x - 2, 25); g.stroke(); }
        break;
    }
  });
}

// Title-screen skin picker: each option shows its queen and two workers
function buildSkinPicker() {
  document.querySelectorAll('.skins').forEach(fillSkinPicker);
}
function fillSkinPicker(box) {
  box.innerHTML = '';
  SKINS.forEach((sk, i) => {
    const btn = document.createElement('button');
    const locked = !skinUnlocked(sk);
    btn.className = 'skin' + (i === selectedSkin ? ' sel' : '') + (locked ? ' locked' : '');
    btn.dataset.i = i;
    const ach = achForSkin(sk);
    btn.title = locked && ach ? `Locked - achievement "${ach.name}": ${ach.desc}` : sk.name;
    const cv = document.createElement('canvas');
    const d = Math.min(2, window.devicePixelRatio || 1);
    cv.width = 56 * d; cv.height = 48 * d;
    btn.appendChild(cv);
    btn.appendChild(document.createTextNode(sk.name));
    if (locked) { const li = document.createElement('span'); li.className = 'lockico'; btn.appendChild(li); }
    btn.addEventListener('click', () => {
      const info = document.getElementById('skinInfo');
      document.querySelectorAll('.skin').forEach(b => b.classList.remove('peek'));
      if (!skinUnlocked(sk)) {   // locked: preview it and say how to unlock it
        btn.classList.add('peek');
        drawLogo(sk);
        const cur = ach ? Math.min(ach.goal, life[ach.key] || 0) : 0;
        info.textContent = ach ? `${sk.name} is locked - unlock it with "${ach.name}": ${ach.desc}${ach.goal > 1 ? ` (${cur}/${ach.goal})` : ''}` : `${sk.name} is locked`;
        return;
      }
      info.textContent = '';
      selectedSkin = i;
      try { localStorage.setItem('qoth-skin', sk.id); } catch (e) {}
      document.querySelectorAll('.skin').forEach(b => b.classList.toggle('sel', +b.dataset.i === i));
      drawLogo();
    });
    box.appendChild(btn);
    drawSkinPreview(cv, sk, d);
  });
}
function drawSkinPreview(cv, sk, d) {
  const colony = { color: sk.color, dark: shade(sk.color, -0.5), isPlayer: true, skin: sk };
  const saved = [TZ, TEX, TEY];
  antCtx = cv.getContext('2d'); TZ = d; TEX = 0; TEY = 0;
  drawAnt(12, 33, -Math.PI / 2 - 0.3, 1, colony, 1, false, 3);
  drawAnt(44, 33, -Math.PI / 2 + 0.3, 1, colony, 2, false, 9);
  drawAnt(28, 27, -Math.PI / 2, 1.7, colony, 0, true, 0);
  antCtx = ctx; [TZ, TEX, TEY] = saved;
}

applyGfx();
applyTheme();
renderProfile();
checkAchievements(false);
if (!skinUnlocked(SKINS[selectedSkin])) selectedSkin = 0;
drawRuleIcons();
buildSkinPicker();
renderBest();
updateAchButton();
document.getElementById('achBtn').addEventListener('click', openAchievements);
document.getElementById('achClose').addEventListener('click', () => document.getElementById('achScreen').classList.add('hidden'));
document.addEventListener('visibilitychange', () => { if (document.hidden) saveLife(); });
drawLogo();
initLobby();
connect();   // the live world plays behind the title screen
cam.zoom = 0.8;
requestAnimationFrame(frame);
