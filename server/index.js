'use strict';
// ============================================================
//  Colony.io server: serves the game files and runs one shared world per room.
//  Start with `npm start` (PORT env var, default 3000).
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
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
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const diff = DIFFS[url.searchParams.get('diff')] ? url.searchParams.get('diff') : 'normal';
  const room = getRoom(cleanRoomName(url.searchParams.get('room')), diff);
  const session = {
    ws, room, colony: null, name: 'Player', out: [], sfx: new Set(), life: {}, lifeMax: {}, known: new Set(),
    view: { x: WORLD_W / 2, y: WORLD_H / 2, hw: 700, hh: 450 }, mapV: 0, alive: true,
  };
  room.sessions.add(session);
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
setInterval(() => {
  const now = process.hrtime.bigint();
  acc += Number(now - last) / 1e9;
  last = now;
  let steps = 0;
  while (acc >= STEP && steps < 4) { acc -= STEP; steps++; tick(); }
  if (acc > STEP * 4) acc = 0;   // fell far behind (e.g. the machine slept): don't try to catch up
  // forget rooms nobody has been in for a while
  for (const [key, room] of rooms) {
    if (!room.sessions.size && room.emptySince && Date.now() - room.emptySince > 30000) { rooms.delete(key); console.log(`room closed: ${key}`); }
  }
}, 1000 / NET.TICK_HZ);

function tick() {
  for (const room of rooms.values()) {
    if (!room.sessions.size) continue;   // nobody watching: freeze the world
    room.world.update(STEP);
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
