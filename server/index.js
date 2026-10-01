'use strict';
// ============================================================
//  Colony.io server: serves the game files and runs one shared world per room.
//  Start with `npm start` (PORT env var, default 3000).
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createWorld } = require('./world.js');
const { NET, DIFFS, SKINS, WORLD_W, WORLD_H } = require('../shared/constants.js');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const STATIC = { '/': 'public/index.html' };
const ALLOWED_DIRS = ['public', 'shared'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

// ---------- static files ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url.pathname === '/stats') { statsPage(url, res); return; }
  let rel = STATIC[url.pathname] || url.pathname.replace(/^\/+/, '');
  if (!rel.includes('/')) rel = 'public/' + rel;   // /client.js -> public/client.js
  const file = path.normalize(path.join(ROOT, rel));
  const top = path.relative(ROOT, file).split(path.sep)[0];
  if (!file.startsWith(ROOT) || !ALLOWED_DIRS.includes(top)) { res.writeHead(404); res.end('Not found'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- visitor stats (private page at /stats?key=STATS_KEY) ----------
// Kept in memory only: the numbers start again from zero whenever the server restarts or wakes from sleep.
const STATS_KEY = process.env.STATS_KEY || '';
const salt = crypto.randomBytes(16).toString('hex');
const totals = { since: Date.now(), connections: 0, games: 0, visitors: new Set(), peakOnline: 0, peakPlaying: 0 };
function visitorId(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  // a salted hash, so the server never keeps anyone's IP address
  return crypto.createHash('sha256').update(salt + ip + (req.headers['user-agent'] || '')).digest('hex').slice(0, 16);
}
function liveCounts() {
  let online = 0, playing = 0;
  for (const room of rooms.values()) for (const s of room.sessions) { online++; if (s.colony && s.colony.alive) playing++; }
  return { online, playing };
}
function noteCounts() {
  const { online, playing } = liveCounts();
  totals.peakOnline = Math.max(totals.peakOnline, online);
  totals.peakPlaying = Math.max(totals.peakPlaying, playing);
  return { online, playing };
}
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function statsPage(url, res) {
  if (!STATS_KEY || url.searchParams.get('key') !== STATS_KEY) {
    res.writeHead(STATS_KEY ? 403 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(STATS_KEY ? 'Wrong or missing key. Open /stats?key=YOUR_STATS_KEY' : 'Stats are off. Set the STATS_KEY environment variable to turn them on.');
    return;
  }
  const { online, playing } = liveCounts();
  const up = Math.floor((Date.now() - totals.since) / 1000);
  const upText = `${Math.floor(up / 3600)}h ${Math.floor(up / 60) % 60}m`;
  const rows = [...rooms.values()].map(r => {
    const players = [...r.sessions].filter(s => s.colony && s.colony.alive);
    const w = r.world.stats();
    return `<tr><td>${esc(r.name)}</td><td>${esc(DIFFS[r.diff].name)}</td><td>${players.length}</td><td>${r.sessions.size - players.length}</td>` +
      `<td>${players.map(s => esc(s.name) + ' (' + s.colony.workers.length + ')').join(', ') || '-'}</td><td>${w.ants}</td></tr>`;
  }).join('') || '<tr><td colspan="6">No rooms open right now</td></tr>';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5"><title>Colony.io stats</title>
<style>body{font-family:system-ui,sans-serif;background:#1f140b;color:#f5e8c8;margin:0;padding:20px 16px}h1{color:#ffd54a;margin:0 0 4px;font-size:24px}
.sub{color:#c8ae7a;font-size:13px;margin-bottom:18px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;max-width:900px}
.card{background:#3a2614;border:1px solid #6b4a24;border-radius:10px;padding:10px 12px}.card b{display:block;font-size:28px;color:#ffd54a;font-variant-numeric:tabular-nums}
.card span{font-size:12px;color:#d8c090;text-transform:uppercase;letter-spacing:1px}h2{font-size:15px;color:#ffd54a;margin:22px 0 8px}
.wrap{overflow-x:auto;max-width:900px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #4a3218}th{color:#d8c090;font-weight:600}</style></head>
<body><h1>Colony.io stats</h1><div class="sub">Live, refreshes every 5 seconds. Totals count since the server last started (${upText} ago).</div>
<div class="grid">
<div class="card"><b>${online}</b><span>Online now</span></div>
<div class="card"><b>${playing}</b><span>In a game now</span></div>
<div class="card"><b>${totals.visitors.size}</b><span>Unique visitors</span></div>
<div class="card"><b>${totals.connections}</b><span>Visits</span></div>
<div class="card"><b>${totals.games}</b><span>Games started</span></div>
<div class="card"><b>${totals.peakPlaying}</b><span>Most playing at once</span></div>
</div>
<h2>Open rooms</h2><div class="wrap"><table><tr><th>Room</th><th>Difficulty</th><th>Playing</th><th>Watching menu</th><th>Players (ants)</th><th>Ants in world</th></tr>${rows}</table></div>
</body></html>`);
}

// ---------- rooms ----------
const rooms = new Map();   // key "name:diff" -> { key, name, world, sessions: Set, emptySince }
function cleanRoomName(s) { return String(s || 'public').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'public'; }
function getRoom(name, diff) {
  const key = name + ':' + diff;
  let room = rooms.get(key);
  if (!room) {
    room = { key, name, diff, world: createWorld(diff), sessions: new Set(), emptySince: 0, tick: 0 };
    rooms.set(key, room);
    console.log(`room created: ${key} (${rooms.size} rooms)`);
  }
  return room;
}
function roomPlayers(room) {
  return [...room.sessions].filter(s => s.colony && s.colony.alive).map(s => s.name);
}

// ---------- connections ----------
// light compression: snapshots shrink by about 40% for very little CPU
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 16 * 1024,
  perMessageDeflate: { zlibDeflateOptions: { level: 1, memLevel: 7 }, serverMaxWindowBits: 13, threshold: 256 },
});
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const diff = DIFFS[url.searchParams.get('diff')] ? url.searchParams.get('diff') : 'normal';
  const room = getRoom(cleanRoomName(url.searchParams.get('room')), diff);
  totals.connections++;
  if (totals.visitors.size < 100000) totals.visitors.add(visitorId(req));
  const session = {
    ws, room, colony: null, name: 'Player', out: [], sfx: new Set(), life: {}, lifeMax: {}, known: new Set(),
    view: { x: WORLD_W / 2, y: WORLD_H / 2, hw: 700, hh: 450 }, mapV: 0, alive: true,
  };
  room.sessions.add(session);
  noteCounts();
  room.emptySince = 0;
  send(session, { t: 'hello', room: room.name, diff, players: roomPlayers(room) });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const w = room.world;
    if (m.t === 'in') {
      const n = v => (typeof v === 'number' && isFinite(v) ? v : 0);
      if (session.colony && session.colony.alive) {
        session.colony.input.x = Math.max(0, Math.min(WORLD_W, n(m.x)));
        session.colony.input.y = Math.max(0, Math.min(WORLD_H, n(m.y)));
      }
      session.view.x = n(m.cx); session.view.y = n(m.cy);
      session.view.hw = Math.max(200, Math.min(1600, n(m.hw)));
      session.view.hh = Math.max(150, Math.min(1100, n(m.hh)));
    } else if (m.t === 'ch') {
      if (session.colony) w.humanCharge(session.colony, m.x, m.y);
    } else if (m.t === 'join') {
      if (session.colony && session.colony.alive) return;
      const humans = [...room.sessions].filter(s => s.colony && s.colony.alive).length;
      if (humans >= NET.MAX_HUMANS) { send(session, { t: 'full' }); return; }
      session.name = String(m.name || 'Player').replace(/[<>]/g, '').trim().slice(0, 16) || 'Player';
      const skin = SKINS.find(k => k.id === m.skin) ? m.skin : 'gold';
      const crown = /^#[0-9a-f]{6}$/i.test(m.crown || '') ? m.crown : '#ffd700';
      session.out = []; session.sfx.clear(); session.life = {}; session.lifeMax = {};
      session.colony = w.addHuman(session, session.name, skin, crown);
      totals.games++;
      const now = noteCounts();
      console.log(`game started: "${session.name}" in room ${room.key} - ${now.playing} playing, ${now.online} online`);
      send(session, { t: 'joined', id: session.colony.id, diff });
    } else if (m.t === 'leave') {
      w.releaseHuman(session.colony);
      session.colony = null;
    } else if (m.t === 'dbg' && process.env.COLONY_DEBUG === '1') {
      w.debug(String(m.cmd), session.colony);
    } else if (m.t === 'ping') {
      send(session, { t: 'pong', n: m.n });
    }
  });
  ws.on('close', () => {
    session.alive = false;
    room.world.releaseHuman(session.colony);
    session.colony = null;
    room.sessions.delete(session);
    if (!room.sessions.size) room.emptySince = Date.now();
  });
  ws.on('error', () => {});
});

function send(session, obj) {
  if (session.ws.readyState === 1) session.ws.send(JSON.stringify(obj));
}

// ---------- game loop ----------
const STEP = 1 / NET.TICK_HZ;
const SNAP_EVERY = Math.round(NET.TICK_HZ / NET.SNAP_HZ);
let last = process.hrtime.bigint(), acc = 0;
// load measurement for the in-game performance panel (F3)
const perf = { busy: 0, since: Date.now(), load: 0 };
setInterval(() => {
  const now = process.hrtime.bigint();
  acc += Number(now - last) / 1e9;
  last = now;
  let steps = 0;
  while (acc >= STEP && steps < 4) { acc -= STEP; steps++; tick(); }
  if (acc > STEP * 4) acc = 0;   // fell far behind (e.g. the machine slept): don't try to catch up
  perf.busy += Number(process.hrtime.bigint() - now) / 1e6;
  if (Date.now() - perf.since >= 1000) {
    perf.load = Math.round(perf.busy / (Date.now() - perf.since) * 100);
    perf.busy = 0; perf.since = Date.now();
    for (const room of rooms.values()) for (const s of room.sessions) {
      const sent = s.ws._socket ? s.ws._socket.bytesWritten : 0;
      s.kbps = Math.round((sent - (s.sentBytes || 0)) / 102.4) / 10;
      s.sentBytes = sent;
      s.wantSrv = true;
    }
  }
  // forget rooms nobody has been in for a while
  for (const [key, room] of rooms) {
    if (!room.sessions.size && room.emptySince && Date.now() - room.emptySince > 30000) { rooms.delete(key); console.log(`room closed: ${key}`); }
  }
}, 1000 / NET.TICK_HZ);

function tick() {
  for (const room of rooms.values()) {
    if (!room.sessions.size) continue;   // nobody watching: freeze the world
    const t0 = process.hrtime.bigint();
    room.world.update(STEP);
    room.stepMs = (room.stepMs || 0) * 0.98 + Number(process.hrtime.bigint() - t0) / 1e6 * 0.02;
    if (++room.tick % SNAP_EVERY) continue;
    const events = room.world.takeEvents();
    for (const s of room.sessions) {
      if (s.ws.readyState !== 1) continue;
      if (s.mapV !== room.world.mapVersion) { s.mapV = room.world.mapVersion; s.ws.send(JSON.stringify(room.world.mapData())); }
      if (s.ws.bufferedAmount > 512 * 1024) continue;   // slow connection: skip a frame rather than pile up lag
      const { head, bin } = room.world.snapshotFor(s);
      if (events.length) head.e = events;
      if (s.out.length) { head.p = s.out; s.out = []; }
      if (s.sfx.size) { head.sfx = [...s.sfx]; s.sfx.clear(); }
      if (Object.keys(s.life).length) { head.life = s.life; s.life = {}; }
      if (Object.keys(s.lifeMax).length) { head.lifeMax = s.lifeMax; s.lifeMax = {}; }
      if (s.wantSrv) { s.wantSrv = false; head.srv = { step: Math.round(room.stepMs * 100) / 100, load: perf.load, kbps: s.kbps || 0 }; }
      const json = Buffer.from(JSON.stringify(head));
      const msg = Buffer.allocUnsafe(4 + json.length + bin.length);
      msg.writeUInt32LE(json.length, 0);
      json.copy(msg, 4);
      bin.copy(msg, 4 + json.length);
      s.ws.send(msg);
    }
  }
}

server.listen(PORT, () => console.log(`Colony.io running on http://localhost:${PORT}`));
