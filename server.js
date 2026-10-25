#!/usr/bin/env node
'use strict';
// Qiyam-e Iranian — persistent online server (v1.5.1)
// Zero dependencies: plain Node >= 18 (built-in http/crypto/fs). Authoritative for inventory,
// tribes, bricks (castle building), wars and resource nodes. Run:  node server.js
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const VERSION = '1.5.3';
function loadWorldSeed() {
  if (process.env.WORLD_SEED !== undefined) {
    const n = Number.parseInt(process.env.WORLD_SEED, 10);
    if (Number.isFinite(n)) return n >>> 0;
  }
  const seedFile = path.join(DATA_DIR, 'world_seed.txt');
  try {
    const saved = Number.parseInt(fs.readFileSync(seedFile, 'utf8').trim(), 10);
    if (Number.isFinite(saved)) return saved >>> 0;
  } catch (_) { /* first run */ }
  let seed = crypto.randomInt(1, 0x7fffffff);
  // Keep a repeatable migration seed when upgrading an existing server with saved tribes/bricks.
  // New installations receive a unique random world.
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE);
      seed = crypto.createHash('sha256').update(raw).digest().readUInt32BE(0) || seed;
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(seedFile, String(seed));
  } catch (e) { console.error('world seed save failed:', e.message); }
  return seed >>> 0;
}
const WORLD_SEED = loadWorldSeed();

// ---------------------------------------------------------------- constants
const W = 6480, H = 5056, CELL = 16;           // ~10x the area of the 2048x1600 solo map
const SPAWN = { x: W / 2, y: H - 420, r: 260 };  // safe, neutral spawn plaza
const TICK_MS = 100;
const MAX_PLAYERS_PER_TRIBE = 30;
const envInt = (k, d) => (process.env[k] !== undefined ? parseInt(process.env[k], 10) : d);
const WAR_PREP_MS = envInt('WAR_PREP_MS', 10 * 60 * 1000);
const WAR_LEN_MS = envInt('WAR_LEN_MS', 60 * 60 * 1000);
const TRUCE_MS = envInt('TRUCE_MS', 3 * 60 * 60 * 1000);
const NEW_TRIBE_TRUCE_MS = envInt('NEW_TRIBE_TRUCE_MS', 30 * 60 * 1000);
const HEART_HP = envInt('HEART_HP', 1200);
const NODE_RESPAWN_MS = 120 * 1000;
const PLAYER_HP = 100;
const BASE_TERRITORY = 224;       // px radius around the tribe heart
const TERRITORY_STEP = 96;
const MAX_TERRITORY_LVL = 5;
const FOUND_COST = { wood: 20, stone: 12, coins: 10 };
const WAR_COST = { coins: envInt('WAR_COIN_COST', 50) };
const START_INV = { wood: 30, stone: 16, food: 5, iron: 0, coins: 30 };

const BRICKS = {
  wood:  { name: 'دیوار چوبی', cost: { wood: 2 }, hp: 60, solid: true },
  stone: { name: 'دیوار سنگی', cost: { stone: 2 }, hp: 160, solid: true },
  iron:  { name: 'دیوار آهنی', cost: { stone: 2, iron: 1 }, hp: 320, solid: true },
  gate:  { name: 'دروازه', cost: { wood: 4, iron: 1 }, hp: 140, solid: true, gate: true },
  tower: { name: 'برج', cost: { stone: 6, iron: 2 }, hp: 400, solid: true },
  floor: { name: 'کف سنگفرش', cost: { stone: 1 }, hp: 40, solid: false },
  torch: { name: 'مشعل', cost: { wood: 1 }, hp: 20, solid: false },
  heart: { name: 'قلب قبیله', cost: {}, hp: HEART_HP, solid: true, heart: true },
};
const NODE_DEF = {
  tree: { res: 'wood', hp: 3, bonus: 2 },
  rock: { res: 'stone', hp: 4, bonus: 2 },
  bush: { res: 'food', hp: 2, bonus: 2 },
  ore:  { res: 'iron', hp: 5, bonus: 2 },
};
const MOB_DEFS = {
  fox:    { name: 'روباه', hp: 14, speed: 70, dmg: 0, range: 0, detect: 0, cd: 1000, fw: 32, scale: 0.9, mode: 'flee', drop: { food: 2 } },
  boar:   { name: 'گراز وحشی', hp: 30, speed: 45, dmg: 7, range: 18, detect: 0, cd: 1500, fw: 32, scale: 1.0, mode: 'neutral', drop: { food: 4 } },
  wolf:   { name: 'گرگ', hp: 26, speed: 70, dmg: 6, range: 20, detect: 150, cd: 1000, fw: 48, scale: 1.0, mode: 'hostile', drop: { food: 2, coins: 1 } },
  goblin: { name: 'راهزن چابک', hp: 22, speed: 62, dmg: 5, range: 20, detect: 130, cd: 1100, fw: 32, scale: 1.0, mode: 'hostile', drop: { coins: 3, food: 1 } },
  raider: { name: 'غارتگر', hp: 40, speed: 50, dmg: 8, range: 22, detect: 140, cd: 1300, fw: 32, scale: 1.1, mode: 'hostile', drop: { coins: 5, wood: 1 } },
  bandit: { name: 'شمشیرزن راهزن', hp: 48, speed: 46, dmg: 9, range: 26, detect: 150, cd: 1400, fw: 32, scale: 1.0, mode: 'hostile', drop: { coins: 7, iron: 1 } },
  orc:    { name: 'راهزن زورمند', hp: 60, speed: 36, dmg: 11, range: 24, detect: 120, cd: 1600, fw: 32, scale: 1.25, mode: 'hostile', drop: { coins: 8, iron: 1 } },
};
const MOB_COUNT = envInt('MOB_COUNT', 300);
const MOB_RESPAWN_MS = 90 * 1000;
const PLAYER_HIT_DMG = 12;
const TRIBE_COLORS = ['#e05a4f', '#4f8fe0', '#5ac46a', '#e0b84f', '#a56be0', '#e08a4f', '#4fd0d0', '#e06ba5'];

// ---------------------------------------------------------------- utils
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const now = () => Date.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const key = (gx, gy) => gx + ',' + gy;
function cleanName(s, max) { s = String(s || '').replace(/[\u0000-\u001f<>\u202a-\u202e]/g, '').trim().replace(/\s+/g, ' '); return s.slice(0, max); }
function canAfford(inv, cost) { for (const k in cost) if ((inv[k] || 0) < cost[k]) return false; return true; }
function pay(inv, cost) { for (const k in cost) inv[k] = (inv[k] || 0) - cost[k]; }
function give(inv, cost, mul) { for (const k in cost) inv[k] = (inv[k] || 0) + Math.floor(cost[k] * mul); }

// ---------------------------------------------------------------- world generation (deterministic)
function genWorld(seed) {
  const rnd = mulberry32(seed);
  const lakes = [];
  for (let i = 0; i < 16; i++) {
    for (let t = 0; t < 40; t++) {
      const r = 110 + rnd() * 240, x = 300 + rnd() * (W - 600), y = 700 + rnd() * (H - 1300);
      if (dist(x, y, SPAWN.x, SPAWN.y) < SPAWN.r + r + 200) continue;
      if (lakes.some(l => dist(x, y, l[0], l[1]) < l[2] + r + 160)) continue;
      lakes.push([Math.round(x), Math.round(y), Math.round(r)]); break;
    }
  }
  const snowY = 820;                                  // northern snowfield / mountains
  const nodes = [];
  const inLake = (x, y, pad) => lakes.some(l => dist(x, y, l[0], l[1]) < l[2] + pad);
  const add = (kind, n, yMin, yMax) => {
    let made = 0, tries = 0;
    while (made < n && tries < n * 30) {
      tries++;
      const x = 40 + rnd() * (W - 80), y = yMin + rnd() * (yMax - yMin);
      if (inLake(x, y, 24)) continue;
      if (dist(x, y, SPAWN.x, SPAWN.y) < 90) continue;
      nodes.push([nodes.length, kind, Math.round(x), Math.round(y)]); made++;
    }
  };
  add('tree', 1500, 60, H - 60);
  add('rock', 520, 60, H - 60);
  add('bush', 520, 900, H - 60);
  add('ore', 130, 60, 2200);
  add('ore', 90, 60, snowY + 200);                     // extra iron in the mountains
  return { seed, w: W, h: H, lakes, snowY, nodes, spawn: [SPAWN.x, SPAWN.y, SPAWN.r] };
}
const WORLD = genWorld(WORLD_SEED);
const spawnRnd = mulberry32((WORLD_SEED ^ (Date.now() & 0x7fffffff) ^ 0x6d2b79f5) >>> 0);
const nodeById = new Map(WORLD.nodes.map(n => [n[0], { id: n[0], kind: n[1], x: n[2], y: n[3], hp: NODE_DEF[n[1]].hp, deadUntil: 0 }]));
function pickMobKind(x, y, rnd) {
  const d = dist(x, y, SPAWN.x, SPAWN.y); const r = rnd();
  if (y < WORLD.snowY + 120) return r < 0.6 ? 'wolf' : (r < 0.85 ? 'orc' : 'bandit');
  if (d < 700) return 'fox';
  if (d < 1500) return r < 0.25 ? 'fox' : (r < 0.5 ? 'boar' : (r < 0.8 ? 'wolf' : 'goblin'));
  if (d < 2600) return r < 0.15 ? 'boar' : (r < 0.4 ? 'wolf' : (r < 0.6 ? 'goblin' : (r < 0.8 ? 'bandit' : 'raider')));
  return r < 0.1 ? 'wolf' : (r < 0.3 ? 'goblin' : (r < 0.5 ? 'raider' : (r < 0.8 ? 'bandit' : 'orc')));
}
const mobs = new Map();
(function genMobs() {
  const rnd = mulberry32(WORLD_SEED + 99);
  let made = 0, tries = 0;
  while (made < MOB_COUNT && tries < MOB_COUNT * 40) {
    tries++;
    const x = 120 + rnd() * (W - 240), y = 120 + rnd() * (H - 240);
    if (WORLD.lakes.some(l => dist(x, y, l[0], l[1]) < l[2] + 30)) continue;
    if (dist(x, y, SPAWN.x, SPAWN.y) < SPAWN.r + 120) continue;
    const kind = pickMobKind(x, y, rnd), d = MOB_DEFS[kind];
    mobs.set(made, { id: made, kind, x: Math.round(x), y: Math.round(y), hx: Math.round(x), hy: Math.round(y), hp: d.hp, dead: false, deadUntil: 0, wanderAt: 0, dx: 0, dy: 0, nextAtk: 0, anim: 'idle', animUntil: 0, flip: 0, agro: null });
    made++;
  }
})();
function isWater(x, y) { return WORLD.lakes.some(l => dist(x, y, l[0], l[1]) < l[2] * 0.92); }
function relocateNode(n) {
  const yMin = n.kind === 'bush' ? WORLD.snowY + 80 : 60;
  const yMax = H - 60;
  for (let i = 0; i < 160; i++) {
    const x = Math.round(40 + spawnRnd() * (W - 80));
    const y = Math.round(yMin + spawnRnd() * (yMax - yMin));
    if (isWater(x, y) || nearSpawn(x, y, 100)) continue;
    if (inAnyTerritory(x, y, 60)) continue;
    let crowded = false;
    for (const other of nodeById.values()) {
      if (other.id !== n.id && other.deadUntil <= now() && dist(x, y, other.x, other.y) < 26) { crowded = true; break; }
    }
    if (crowded) continue;
    n.x = x; n.y = y;
    const row = WORLD.nodes[n.id];
    if (row) { row[2] = x; row[3] = y; }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- persistent state
let S = { players: {}, tribes: {}, bricks: {}, wars: [], nextId: 1, savedAt: 0 };
function loadState() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ }
  for (const f of [STATE_FILE, STATE_FILE + '.bak']) {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (d && d.players && d.tribes && d.bricks) { S = Object.assign(S, d); console.log('state loaded from', f); return; }
    } catch (e) { /* try next */ }
  }
  console.log('fresh state');
}
let dirty = false;
function saveState() {
  if (!dirty) return;
  try {
    S.savedAt = now();
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(S));
    if (fs.existsSync(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_FILE + '.bak');
    fs.renameSync(tmp, STATE_FILE);
    dirty = false;
  } catch (e) { console.error('save failed', e.message); }
}
loadState();
setInterval(saveState, 20000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { dirty = true; saveState(); process.exit(0); });

// ---------------------------------------------------------------- runtime (not persisted)
const conns = new Map();          // pid -> conn
const live = new Map();           // pid -> {x,y,f,hp,lastPos,lastHit,lastGather,lastChat,lastPlace}
function playerById(pid) { return S.players[pid]; }
function tribeOf(p) { return p && p.tribe ? S.tribes[p.tribe] : null; }
function tribeId(name) { const k = String(name || '').toLowerCase(); for (const id in S.tribes) if (S.tribes[id].name.toLowerCase() === k) return id; return null; }

// ---------------------------------------------------------------- minimal WebSocket (RFC 6455)
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsFrame(str) {
  const payload = Buffer.from(str, 'utf8'); const n = payload.length; let head;
  if (n < 126) head = Buffer.from([0x81, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}
class Conn {
  constructor(sock) { this.sock = sock; this.buf = Buffer.alloc(0); this.pid = null; this.alive = true; this.msgTimes = []; this.lastPong = now(); this.frag = null; }
  send(obj) { if (!this.alive) return; try { this.sock.write(wsFrame(JSON.stringify(obj))); } catch (e) { this.close(); } }
  close() { if (!this.alive) return; this.alive = false; try { this.sock.end(Buffer.from([0x88, 0])); } catch (e) { /* ignore */ } try { this.sock.destroy(); } catch (e) { /* ignore */ } onClose(this); }
  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > 1 << 20) return this.close();
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0; let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 32768) return this.close();
      if (!masked) return this.close();
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4); const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 0x8) return this.close();
      if (op === 0x9) { try { this.sock.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); } catch (e) { /* ignore */ } continue; }
      if (op === 0xa) { this.lastPong = now(); continue; }
      if (op === 0x1 || op === 0x0) {
        if (op === 0x1) this.frag = data; else this.frag = Buffer.concat([this.frag || Buffer.alloc(0), data]);
        if (fin) { const text = this.frag.toString('utf8'); this.frag = null; this.onText(text); } else if (this.frag.length > 32768) return this.close();
      }
    }
  }
  onText(text) {
    const t = now(); this.msgTimes = this.msgTimes.filter(x => t - x < 1000); this.msgTimes.push(t);
    if (this.msgTimes.length > 60) return;                // rate limit: 60 msgs/sec
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(this, m); } catch (e) { console.error('handler error', m.t, e); }
  }
}
const SECURE = !!(process.env.TLS_CERT && process.env.TLS_KEY);
function httpHandler(req, res) {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ ok: true, version: VERSION, secure: SECURE, online: conns.size, tribes: Object.keys(S.tribes).length })); return; }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Qiyam-e Iranian server ' + VERSION + '\n');
}
// Direct TLS: set TLS_CERT and TLS_KEY (PEM paths) -> wss://host:PORT. Behind Caddy/nginx/Cloudflare/Render/Railway/Fly leave them unset (the proxy terminates TLS).
const server = SECURE
  ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, httpHandler)
  : http.createServer(httpHandler);
server.on('upgrade', (req, sock) => {
  const k = req.headers['sec-websocket-key'];
  if (!k || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const acc = crypto.createHash('sha1').update(k + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = new Conn(sock);
  sock.on('data', d => c.feed(d)); sock.on('close', () => c.close()); sock.on('error', () => c.close());
});

// ---------------------------------------------------------------- broadcast helpers
function sendAll(obj, except) { const s = wsFrame(JSON.stringify(obj)); for (const [pid, c] of conns) if (c.alive && pid !== except) { try { c.sock.write(s); } catch (e) { /* ignore */ } } }
function sendTribe(tid, obj) { for (const [pid, c] of conns) { const p = S.players[pid]; if (p && p.tribe === tid) c.send(obj); } }
function toast(pid, text, kind) { const c = conns.get(pid); if (c) c.send({ t: 'toast', text, kind: kind || 'info' }); }
function err(c, text) { c.send({ t: 'err', text }); }
function pubTribe(id) {
  const t = S.tribes[id]; if (!t) return null;
  const members = Object.keys(S.players).filter(pid => S.players[pid].tribe === id);
  return { id, name: t.name, color: t.color, leader: t.leader, leaderName: (S.players[t.leader] || {}).name || '?', hx: t.hx, hy: t.hy, lvl: t.lvl, radius: territoryRadius(t),
    members: members.length, online: members.filter(m => conns.has(m)).length, treasury: t.treasury, truceUntil: t.truceUntil || 0 };
}
const allTribes = () => Object.keys(S.tribes).map(pubTribe);
function territoryRadius(t) { return BASE_TERRITORY + TERRITORY_STEP * t.lvl; }
function publicWars() { return S.wars.map(w => ({ id: w.id, a: w.a, b: w.b, start: w.start, end: w.end, peaceBy: w.peaceBy || null })); }
function warBetween(a, b) { return S.wars.find(w => (w.a === a && w.b === b) || (w.a === b && w.b === a)); }
function warActive(w) { const t = now(); return t >= w.start && t < w.end; }
function activeWarOf(tid) { return S.wars.filter(w => (w.a === tid || w.b === tid) && warActive(w)); }
function myInv(pid) { return S.players[pid].inv; }
function sendInv(pid) { const c = conns.get(pid); if (c) c.send({ t: 'inv', inv: myInv(pid) }); }
function pubPlayerMe(pid) { const p = S.players[pid]; return { id: pid, name: p.name, inv: p.inv, tribe: p.tribe || null, hp: (live.get(pid) || {}).hp || PLAYER_HP }; }
function brickList() { const out = []; for (const k in S.bricks) { const b = S.bricks[k]; out.push([b.gx, b.gy, b.kind, b.tribe, b.hp]); } return out; }

// ---------------------------------------------------------------- message handling
function handle(c, m) {
  if (m.t === 'hello') return onHello(c, m);
  if (!c.pid) return;
  const pid = c.pid, p = S.players[pid], L = live.get(pid);
  if (!p || !L) return;
  switch (m.t) {
    case 'pos': {
      const x = Number(m.x), y = Number(m.y); if (!isFinite(x) || !isFinite(y)) return;
      const dt = Math.max(0.05, (now() - L.lastPos) / 1000);
      const d = dist(x, y, L.x, L.y);
      if (d > 320 * dt + 40) { c.send({ t: 'tp', x: L.x, y: L.y }); return; }   // speed hack / desync -> snap back
      L.x = clamp(x, 8, W - 8); L.y = clamp(y, 8, H - 8); L.f = m.f ? 1 : 0; L.a = String(m.a || 'idle').slice(0, 8); L.lastPos = now(); break;
    }
    case 'gather': return onGather(c, p, L, m);
    case 'tribe_create': return onTribeCreate(c, p, L, m);
    case 'tribe_join': return onTribeJoin(c, p, m);
    case 'tribe_leave': return onTribeLeave(c, p, true);
    case 'tribe_kick': return onTribeKick(c, p, m);
    case 'tribe_donate': return onDonate(c, p, m);
    case 'tribe_expand': return onExpand(c, p);
    case 'tribe_list': return c.send({ t: 'tribes', tribes: allTribes(), wars: publicWars() });
    case 'tribe_members': return onMembers(c, p);
    case 'place': return onPlace(c, p, L, m);
    case 'remove': return onRemove(c, p, L, m);
    case 'war_declare': return onWarDeclare(c, p, m);
    case 'peace': return onPeace(c, p, m);
    case 'hit_brick': return onHitBrick(c, p, L, m);
    case 'hit_player': return onHitPlayer(c, p, L, m);
    case 'hit_mob': return onHitMob(c, p, L, m);
    case 'chat': return onChat(c, p, L, m);
    case 'ping': return c.send({ t: 'pong', ts: m.ts });
  }
}

function onHello(c, m) {
  if (c.pid) return;
  const token = String(m.token || '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return err(c, 'توکن نامعتبر است.');
  const name = cleanName(m.name, 16);
  if (name.length < 2) return err(c, 'نام باید حداقل ۲ نویسه باشد.');
  let pid = null;
  for (const id in S.players) if (S.players[id].token === token) { pid = id; break; }
  if (!pid) {
    if (Object.values(S.players).some(p => p.name.toLowerCase() === name.toLowerCase())) return err(c, 'این نام قبلاً گرفته شده است.');
    pid = 'p' + (S.nextId++);
    S.players[pid] = { token, name, inv: Object.assign({}, START_INV), tribe: null, created: now() };
    dirty = true;
  } else if (S.players[pid].name !== name) {
    if (Object.values(S.players).some(p => p !== S.players[pid] && p.name.toLowerCase() === name.toLowerCase())) return err(c, 'این نام قبلاً گرفته شده است.');
    S.players[pid].name = name; dirty = true;
  }
  const old = conns.get(pid); if (old && old !== c) { old.send({ t: 'kicked', text: 'از دستگاه دیگری وارد شدی.' }); old.close(); }
  c.pid = pid; conns.set(pid, c);
  const p = S.players[pid];
  if (p.tribe && !S.tribes[p.tribe]) p.tribe = null;
  const t = tribeOf(p);
  const sx = t ? t.hx : SPAWN.x + (Math.random() - 0.5) * 80, sy = t ? t.hy + 40 : SPAWN.y + (Math.random() - 0.5) * 80;
  live.set(pid, { x: sx, y: sy, f: 0, a: 'idle', hp: PLAYER_HP, lastPos: now(), lastHit: 0, lastGather: 0, lastChat: 0, lastPlace: 0 });
  c.send({ t: 'welcome', version: VERSION, you: pubPlayerMe(pid), pos: [sx, sy], world: WORLD, bricks: brickList(), tribes: allTribes(),
    wars: publicWars(), mdefs: MOB_DEFS, players: [...conns.keys()].filter(i => i !== pid).map(i => [i, S.players[i].name]), bdefs: BRICKS, costs: { found: FOUND_COST, war: WAR_COST }, serverTime: now(),
    deadNodes: [...nodeById.values()].filter(n => n.deadUntil > now()).map(n => n.id) });
  sendAll({ t: 'pj', id: pid, name: p.name, tribe: p.tribe || null }, pid);
  console.log('login', p.name, pid, 'online', conns.size);
}
function onClose(c) {
  if (c.pid && conns.get(c.pid) === c) { conns.delete(c.pid); sendAll({ t: 'pl', id: c.pid }); console.log('logout', (S.players[c.pid] || {}).name, 'online', conns.size); }
}

function onGather(c, p, L, m) {
  const n = nodeById.get(Number(m.id)); if (!n) return;
  const t = now();
  if (t - L.lastGather < 300) return;
  if (n.deadUntil > t) return;
  if (dist(L.x, L.y, n.x, n.y) > 70) return;
  L.lastGather = t;
  const def = NODE_DEF[n.kind];
  n.hp -= 1; p.inv[def.res] = (p.inv[def.res] || 0) + 1;
  if (Math.random() < 0.15) p.inv.coins = (p.inv.coins || 0) + 1 + Math.floor(Math.random() * 2);   // small coin finds
  if (n.hp <= 0) {
    p.inv[def.res] += def.bonus; n.deadUntil = t + NODE_RESPAWN_MS; n.hp = def.hp;
    sendAll({ t: 'node_dead', id: n.id });
    setTimeout(() => {
      if (!nodeById.has(n.id)) return;
      if (relocateNode(n)) sendAll({ t: 'node_move', id: n.id, x: n.x, y: n.y });
      n.deadUntil = 0;
      sendAll({ t: 'node_alive', id: n.id });
    }, NODE_RESPAWN_MS + 50);
  }
  dirty = true; sendInv(c.pid);
}

function nearSpawn(x, y, pad) { return dist(x, y, SPAWN.x, SPAWN.y) < SPAWN.r + pad; }
function onTribeCreate(c, p, L, m) {
  if (p.tribe) return err(c, 'اول باید از قبیله‌ی فعلی خارج شوی.');
  const name = cleanName(m.name, 18);
  if (name.length < 2) return err(c, 'نام قبیله باید حداقل ۲ نویسه باشد.');
  if (tribeId(name)) return err(c, 'این نام قبیله قبلاً گرفته شده است.');
  if (!canAfford(p.inv, FOUND_COST)) return err(c, 'منابع کافی نیست.');
  const hx = Math.round(L.x / CELL) * CELL, hy = Math.round(L.y / CELL) * CELL;
  if (isWater(hx, hy)) return err(c, 'روی آب نمی‌شود قلعه ساخت.');
  if (nearSpawn(hx, hy, 380)) return err(c, 'خیلی نزدیک میدان مرکزی است.');
  if (hx < 400 || hy < 400 || hx > W - 400 || hy > H - 400) return err(c, 'خیلی نزدیک لبه‌ی نقشه است.');
  for (const id in S.tribes) { const t = S.tribes[id]; if (dist(hx, hy, t.hx, t.hy) < territoryRadius(t) + BASE_TERRITORY + TERRITORY_STEP * MAX_TERRITORY_LVL + 120) return err(c, 'قلمرو قبیله‌ی دیگری نزدیک است؛ جای دورتری بیاب.'); }
  pay(p.inv, FOUND_COST);
  const id = 't' + (S.nextId++);
  const color = /^#[0-9a-fA-F]{6}$/.test(String(m.color || '')) ? m.color : TRIBE_COLORS[Object.keys(S.tribes).length % TRIBE_COLORS.length];
  S.tribes[id] = { name, color, leader: c.pid, hx, hy, lvl: 0, treasury: { wood: 0, stone: 0, iron: 0, food: 0, coins: 0 }, created: now(), truceUntil: now() + NEW_TRIBE_TRUCE_MS };
  p.tribe = id;
  const hb = { gx: hx / CELL, gy: hy / CELL, kind: 'heart', tribe: id, hp: BRICKS.heart.hp };
  S.bricks[key(hb.gx, hb.gy)] = hb;
  dirty = true; sendInv(c.pid);
  sendAll({ t: 'brick_add', b: [hb.gx, hb.gy, hb.kind, hb.tribe, hb.hp] });
  sendAll({ t: 'tribes', tribes: allTribes(), wars: publicWars() });
  c.send({ t: 'me', you: pubPlayerMe(c.pid) });
  sendAll({ t: 'toast', text: 'قبیله‌ی «' + name + '» بنیان نهاده شد!', kind: 'quest' });
}
function onTribeJoin(c, p, m) {
  if (p.tribe) return err(c, 'اول باید از قبیله‌ی فعلی خارج شوی.');
  const id = S.tribes[m.id] ? m.id : tribeId(m.name); const t = S.tribes[id]; if (!t) return err(c, 'قبیله پیدا نشد.');
  const cnt = Object.values(S.players).filter(x => x.tribe === id).length;
  if (cnt >= MAX_PLAYERS_PER_TRIBE) return err(c, 'ظرفیت قبیله پر است.');
  p.tribe = id; dirty = true;
  c.send({ t: 'me', you: pubPlayerMe(c.pid) });
  sendAll({ t: 'tribes', tribes: allTribes(), wars: publicWars() });
  sendTribe(id, { t: 'toast', text: p.name + ' به قبیله پیوست.', kind: 'good' });
}
function onTribeLeave(c, p, selfAction) {
  const id = p.tribe; const t = S.tribes[id]; if (!t) return;
  if (t.leader === c.pid) {
    const others = Object.keys(S.players).filter(pid => S.players[pid].tribe === id && pid !== c.pid);
    if (others.length === 0) { dissolveTribe(id, 'قبیله منحل شد.'); return; }
    t.leader = others.sort((a, b) => (conns.has(b) ? 1 : 0) - (conns.has(a) ? 1 : 0))[0];
    sendTribe(id, { t: 'toast', text: S.players[t.leader].name + ' رهبر جدید قبیله شد.', kind: 'quest' });
  }
  p.tribe = null; dirty = true;
  c.send({ t: 'me', you: pubPlayerMe(c.pid) });
  sendAll({ t: 'tribes', tribes: allTribes(), wars: publicWars() });
}
function dissolveTribe(id, text) {
  for (const k of Object.keys(S.bricks)) if (S.bricks[k].tribe === id) { const b = S.bricks[k]; delete S.bricks[k]; sendAll({ t: 'brick_del', gx: b.gx, gy: b.gy }); }
  S.wars = S.wars.filter(w => w.a !== id && w.b !== id);
  for (const pid in S.players) if (S.players[pid].tribe === id) { S.players[pid].tribe = null; const cc = conns.get(pid); if (cc) cc.send({ t: 'me', you: pubPlayerMe(pid) }); toast(pid, text, 'bad'); }
  delete S.tribes[id]; dirty = true;
  sendAll({ t: 'tribes', tribes: allTribes(), wars: publicWars() });
}
function onTribeKick(c, p, m) {
  const t = tribeOf(p); if (!t || t.leader !== c.pid) return err(c, 'فقط رهبر می‌تواند اخراج کند.');
  const tp = S.players[m.pid]; if (!tp || tp.tribe !== p.tribe || m.pid === c.pid) return;
  tp.tribe = null; dirty = true; const cc = conns.get(m.pid); if (cc) { cc.send({ t: 'me', you: pubPlayerMe(m.pid) }); toast(m.pid, 'از قبیله اخراج شدی.', 'bad'); }
  sendAll({ t: 'tribes', tribes: allTribes(), wars: publicWars() });
  onMembers(c, p);
}
function onMembers(c, p) {
  const id = p.tribe; const t = S.tribes[id]; if (!t) return;
  const list = Object.keys(S.players).filter(pid => S.players[pid].tribe === id).map(pid => ({ id: pid, name: S.players[pid].name, online: conns.has(pid), leader: pid === t.leader }));
  c.send({ t: 'members', list, treasury: t.treasury });
}
function onDonate(c, p, m) {
  const t = tribeOf(p); if (!t) return err(c, 'در قبیله‌ای نیستی.');
  const r = String(m.res); const n = Math.floor(Number(m.n));
  if (!['wood', 'stone', 'iron', 'food', 'coins'].includes(r) || !(n > 0)) return;
  if ((p.inv[r] || 0) < n) return err(c, 'به اندازه‌ی کافی نداری.');
  p.inv[r] -= n; t.treasury[r] = (t.treasury[r] || 0) + n; dirty = true; sendInv(c.pid);
  sendTribe(p.tribe, { t: 'toast', text: p.name + ' ' + n + ' ' + r + ' به خزانه داد.', kind: 'good' }); onMembers(c, p);
}
function onExpand(c, p) {
  const t = tribeOf(p); if (!t || t.leader !== c.pid) return err(c, 'فقط رهبر می‌تواند قلمرو را گسترش دهد.');
  if (t.lvl >= MAX_TERRITORY_LVL) return err(c, 'قلمرو به حداکثر رسیده است.');
  const cost = { stone: 20 * (t.lvl + 1), wood: 20 * (t.lvl + 1), coins: 25 * (t.lvl + 1) };
  if (!canAfford(t.treasury, cost)) return err(c, 'خزانه‌ی قبیله کافی نیست: سنگ ' + cost.stone + '، چوب ' + cost.wood + '، سکه ' + cost.coins);
  const nr = BASE_TERRITORY + TERRITORY_STEP * (t.lvl + 1);
  for (const id in S.tribes) { if (id === p.tribe) continue; const o = S.tribes[id]; if (dist(t.hx, t.hy, o.hx, o.hy) < nr + territoryRadius(o) + 40) return err(c, 'قلمرو به قبیله‌ی دیگری می‌خورد.'); }
  pay(t.treasury, cost); t.lvl++; dirty = true;
  sendAll({ t: 'tribes', tribes: allTribes(), wars: publicWars() });
  sendTribe(p.tribe, { t: 'toast', text: 'قلمرو قبیله گسترش یافت!', kind: 'quest' }); onMembers(c, p);
}

function inTerritory(t, x, y) { return dist(x, y, t.hx, t.hy) <= territoryRadius(t); }
function onPlace(c, p, L, m) {
  const t = tribeOf(p); if (!t) return err(c, 'برای ساخت باید عضو قبیله باشی.');
  const def = BRICKS[m.kind]; if (!def || def.heart) return;
  const gx = Math.floor(Number(m.gx)), gy = Math.floor(Number(m.gy)); if (!isFinite(gx) || !isFinite(gy)) return;
  const cx = gx * CELL, cy = gy * CELL;
  if (now() - L.lastPlace < 60) return; L.lastPlace = now();
  if (dist(L.x, L.y, cx, cy) > 140) return err(c, 'خیلی دوری.');
  if (!inTerritory(t, cx, cy)) return err(c, 'بیرون از قلمرو قبیله نمی‌شود ساخت.');
  if (isWater(cx, cy)) return err(c, 'روی آب نمی‌شود ساخت.');
  if (S.bricks[key(gx, gy)]) return err(c, 'این خانه پر است.');
  if (dist(cx, cy, L.x, L.y) < 7 && def.solid) return err(c, 'روی خودت نمی‌شود دیوار گذاشت.');
  for (const [opid, ol] of live) if (opid !== c.pid && def.solid && dist(cx, cy, ol.x, ol.y) < 8) return err(c, 'کسی آنجا ایستاده است.');
  if (!canAfford(p.inv, def.cost)) return err(c, 'منابع کافی نیست.');
  pay(p.inv, def.cost);
  const b = { gx, gy, kind: m.kind, tribe: p.tribe, hp: def.hp };
  S.bricks[key(gx, gy)] = b; dirty = true; sendInv(c.pid);
  sendAll({ t: 'brick_add', b: [gx, gy, b.kind, b.tribe, b.hp] });
}
function onRemove(c, p, L, m) {
  const gx = Math.floor(Number(m.gx)), gy = Math.floor(Number(m.gy));
  const b = S.bricks[key(gx, gy)]; if (!b || b.tribe !== p.tribe || b.kind === 'heart') return;
  if (dist(L.x, L.y, gx * CELL, gy * CELL) > 140) return;
  give(p.inv, BRICKS[b.kind].cost, 0.5);
  delete S.bricks[key(gx, gy)]; dirty = true; sendInv(c.pid); sendAll({ t: 'brick_del', gx, gy });
}

function onWarDeclare(c, p, m) {
  const t = tribeOf(p); if (!t || t.leader !== c.pid) return err(c, 'فقط رهبر قبیله می‌تواند اعلان جنگ کند.');
  const tid = S.tribes[m.target] ? m.target : tribeId(m.name); const tt = S.tribes[tid];
  if (!tt || tid === p.tribe) return err(c, 'قبیله‌ی هدف پیدا نشد.');
  if (warBetween(p.tribe, tid)) return err(c, 'میان شما جنگ برقرار است.');
  if ((t.truceUntil || 0) > now()) return err(c, 'قبیله‌ی شما هنوز در دوران آتش‌بس است.');
  if ((tt.truceUntil || 0) > now()) return err(c, 'قبیله‌ی هدف در دوران آتش‌بس است و نمی‌شود به آن حمله کرد.');
  if (!canAfford(t.treasury, WAR_COST)) return err(c, 'خزانه‌ی قبیله برای اعلان جنگ کافی نیست (' + WAR_COST.coins + ' سکه).');
  pay(t.treasury, WAR_COST);
  const w = { id: 'w' + (S.nextId++), a: p.tribe, b: tid, start: now() + WAR_PREP_MS, end: now() + WAR_PREP_MS + WAR_LEN_MS };
  S.wars.push(w); dirty = true;
  sendAll({ t: 'wars', wars: publicWars() });
  sendAll({ t: 'toast', text: '⚔ قبیله‌ی «' + t.name + '» به قبیله‌ی «' + tt.name + '» اعلان جنگ کرد! نبرد تا ۱۰ دقیقه‌ی دیگر آغاز می‌شود.', kind: 'bad' });
}
function endWar(w, reason) { S.wars = S.wars.filter(x => x !== w); dirty = true; sendAll({ t: 'wars', wars: publicWars() }); if (reason) sendAll({ t: 'toast', text: reason, kind: 'quest' }); }
function onPeace(c, p, m) {
  const t = tribeOf(p); if (!t || t.leader !== c.pid) return err(c, 'فقط رهبر می‌تواند صلح ببندد.');
  const w = S.wars.find(x => x.id === m.war && (x.a === p.tribe || x.b === p.tribe)); if (!w) return;
  if (w.peaceBy && w.peaceBy !== p.tribe) {
    const na = S.tribes[w.a], nb = S.tribes[w.b];
    if (na) na.truceUntil = now() + TRUCE_MS; if (nb) nb.truceUntil = now() + TRUCE_MS;
    return endWar(w, '🕊 صلح میان «' + (na || {}).name + '» و «' + (nb || {}).name + '» بسته شد.');
  }
  w.peaceBy = p.tribe; sendAll({ t: 'wars', wars: publicWars() });
  const other = S.tribes[w.a === p.tribe ? w.b : w.a]; if (other) sendTribe(w.a === p.tribe ? w.b : w.a, { t: 'toast', text: 'قبیله‌ی «' + t.name + '» پیشنهاد صلح داده است.', kind: 'quest' });
}
function onHitBrick(c, p, L, m) {
  const gx = Math.floor(Number(m.gx)), gy = Math.floor(Number(m.gy)); const b = S.bricks[key(gx, gy)]; if (!b) return;
  const t = now(); if (t - L.lastHit < 380) return;
  if (!p.tribe || b.tribe === p.tribe) return;
  const w = warBetween(p.tribe, b.tribe); if (!w || !warActive(w)) return err(c, 'برای حمله به این قلعه باید جنگ فعال باشد.');
  if (dist(L.x, L.y, gx * CELL, gy * CELL) > 56) return;
  L.lastHit = t;
  const dmg = 12; b.hp -= dmg; dirty = true;
  if (b.hp <= 0) {
    delete S.bricks[key(gx, gy)]; sendAll({ t: 'brick_del', gx, gy, boom: 1 });
    if (b.kind === 'heart') return onHeartDestroyed(w, b.tribe, p.tribe, c.pid);
  } else sendAll({ t: 'brick_hp', gx, gy, hp: b.hp });
}
function onHeartDestroyed(w, loserId, winnerId, killerPid) {
  const L = S.tribes[loserId], Wn = S.tribes[winnerId]; if (!L || !Wn) return endWar(w);
  const loot = {};
  for (const r of ['wood', 'stone', 'iron', 'food', 'coins']) { const take = Math.floor((L.treasury[r] || 0) * 0.4); L.treasury[r] -= take; Wn.treasury[r] = (Wn.treasury[r] || 0) + take; loot[r] = take; }
  const hb = { gx: L.hx / CELL, gy: L.hy / CELL, kind: 'heart', tribe: loserId, hp: Math.floor(BRICKS.heart.hp * 0.25) };
  S.bricks[key(hb.gx, hb.gy)] = hb; sendAll({ t: 'brick_add', b: [hb.gx, hb.gy, hb.kind, hb.tribe, hb.hp] });
  L.truceUntil = now() + TRUCE_MS; Wn.truceUntil = now() + NEW_TRIBE_TRUCE_MS;
  // also shatter a share of the loser's outer walls
  const outer = Object.values(S.bricks).filter(b => b.tribe === loserId && b.kind !== 'heart' && dist(b.gx * CELL, b.gy * CELL, L.hx, L.hy) > 80);
  for (const b of outer) if (Math.random() < 0.25) { delete S.bricks[key(b.gx, b.gy)]; sendAll({ t: 'brick_del', gx: b.gx, gy: b.gy, boom: 1 }); }
  endWar(w, '🏆 قبیله‌ی «' + Wn.name + '» قلب قبیله‌ی «' + L.name + '» را درهم شکست و غنیمت گرفت!');
}
function onHitPlayer(c, p, L, m) {
  const tp = S.players[m.pid], tl = live.get(m.pid); if (!tp || !tl || m.pid === c.pid) return;
  if (!p.tribe || !tp.tribe || p.tribe === tp.tribe) return;
  const w = warBetween(p.tribe, tp.tribe); if (!w || !warActive(w)) return;
  const t = now(); if (t - L.lastHit < 450) return;
  if (dist(L.x, L.y, tl.x, tl.y) > 52) return;
  if (nearSpawn(tl.x, tl.y, 0) || (tl.protectedUntil || 0) > t) return;
  L.lastHit = t; tl.hp -= 14;
  if (tl.hp <= 0) { killPlayer(m.pid, '☠ ' + p.name + ' ' + tp.name + ' را از پا درآورد.'); }
  else { const cc = conns.get(m.pid); if (cc) cc.send({ t: 'hp', hp: tl.hp, from: c.pid }); }
}
function killPlayer(pid, text) {
  const tp = S.players[pid], tl = live.get(pid); if (!tp || !tl) return;
  tl.hp = PLAYER_HP; tl.protectedUntil = now() + 6000;
  const tt = S.tribes[tp.tribe]; const rx = tt ? tt.hx : SPAWN.x, ry = tt ? tt.hy + 40 : SPAWN.y;
  tl.x = rx; tl.y = ry; tl.lastPos = now();
  const cc = conns.get(pid); if (cc) { cc.send({ t: 'tp', x: rx, y: ry, dead: 1 }); cc.send({ t: 'hp', hp: tl.hp }); }
  if (text) sendAll({ t: 'toast', text, kind: 'bad' });
}
function damagePlayer(pid, amount, text) {
  const tl = live.get(pid); if (!tl) return;
  tl.hp -= amount;
  if (tl.hp <= 0) return killPlayer(pid, text);
  const cc = conns.get(pid); if (cc) cc.send({ t: 'hp', hp: tl.hp, from: 'mob' });
}
function onHitMob(c, p, L, m) {
  const mob = mobs.get(Number(m.id)); if (!mob || mob.dead) return;
  const t = now(); if (t - L.lastHit < 380) return;
  if (dist(L.x, L.y, mob.x, mob.y) > 52) return;
  L.lastHit = t;
  const d = MOB_DEFS[mob.kind];
  mob.hp -= PLAYER_HIT_DMG; mob.agro = c.pid; mob.flee = t + 4000;
  if (mob.hp <= 0) {
    mob.dead = true; mob.deadUntil = t + MOB_RESPAWN_MS;
    const loot = {}; for (const k in d.drop) loot[k] = d.drop[k] + (k === 'coins' ? Math.floor(Math.random() * 3) : 0);
    give(p.inv, loot, 1); dirty = true; sendInv(c.pid);
    c.send({ t: 'toast', text: d.name + ' شکست خورد.', kind: 'good' });
    sendAll({ t: 'mob_die', id: mob.id, x: mob.x, y: mob.y });
  }
}
function inAnyTerritory(x, y, pad) { for (const id in S.tribes) { const t = S.tribes[id]; if (dist(x, y, t.hx, t.hy) < territoryRadius(t) + pad) return t; } return null; }
function mobCanStand(x, y) { return x > 20 && y > 20 && x < W - 20 && y < H - 20 && !isWater(x, y) && !inAnyTerritory(x, y, 30) && !nearSpawn(x, y, 40); }
function mobTick() {
  const t = now(); const players = [];
  for (const [pid, L] of live) if (conns.has(pid)) players.push([pid, L]);
  for (const mob of mobs.values()) {
    const d = MOB_DEFS[mob.kind];
    if (mob.dead) { if (t >= mob.deadUntil) { mob.dead = false; mob.hp = d.hp; mob.x = mob.hx; mob.y = mob.hy; mob.agro = null; } continue; }
    if (mob.animUntil && t > mob.animUntil) { mob.anim = 'idle'; mob.animUntil = 0; }
    // anything near a player? (skip cheap work for far-away mobs)
    let nearest = null, nd = 1e9;
    for (const [pid, L] of players) { const dd = dist(mob.x, mob.y, L.x, L.y); if (dd < nd) { nd = dd; nearest = [pid, L]; } }
    if (!nearest || nd > 900) { continue; }
    let tgt = null;
    const canHit = ([pid, L]) => !nearSpawn(L.x, L.y, 0) && !inAnyTerritory(L.x, L.y, 0) && (L.protectedUntil || 0) < t;
    if (d.mode === 'hostile' && nd < d.detect && canHit(nearest)) tgt = nearest;
    if (d.mode !== 'flee' && mob.agro && live.get(mob.agro) && conns.has(mob.agro)) { const L = live.get(mob.agro); if (dist(mob.x, mob.y, L.x, L.y) < 420 && canHit([mob.agro, L])) tgt = [mob.agro, L]; else mob.agro = null; }
    if (dist(mob.x, mob.y, mob.hx, mob.hy) > 520) { tgt = null; mob.agro = null; mob.hp = Math.min(d.hp, mob.hp + 5); mob.dx = Math.sign(mob.hx - mob.x); mob.dy = Math.sign(mob.hy - mob.y); mob.wanderAt = t + 1500; }
    const step = d.speed * 0.2; let vx = 0, vy = 0;
    if (d.mode === 'flee') {
      if (nd < 130) { vx = mob.x - nearest[1].x; vy = mob.y - nearest[1].y; const n = Math.hypot(vx, vy) || 1; vx = vx / n * step * 1.2; vy = vy / n * step * 1.2; }
    } else if (tgt) {
      const L = tgt[1]; const dd = dist(mob.x, mob.y, L.x, L.y);
      if (dd > d.range * 0.85) { vx = (L.x - mob.x) / dd * step; vy = (L.y - mob.y) / dd * step; }
      else if (t >= mob.nextAtk) { mob.nextAtk = t + d.cd; mob.anim = 'attack'; mob.animUntil = t + 350; damagePlayer(tgt[0], d.dmg, '☠ ' + d.name + ' ' + S.players[tgt[0]].name + ' را از پا درآورد.'); }
      mob.flip = L.x < mob.x ? 1 : 0;
    } else {
      if (t >= mob.wanderAt) { mob.wanderAt = t + 1500 + Math.random() * 2500; if (Math.random() < 0.55) { const a = Math.random() * 6.283; mob.dx = Math.cos(a); mob.dy = Math.sin(a); } else { mob.dx = 0; mob.dy = 0; } if (dist(mob.x, mob.y, mob.hx, mob.hy) > 160) { mob.dx = Math.sign(mob.hx - mob.x); mob.dy = Math.sign(mob.hy - mob.y); } }
      vx = mob.dx * step * 0.35; vy = mob.dy * step * 0.35;
    }
    if (vx || vy) {
      const nx = mob.x + vx, ny = mob.y + vy;
      if (mobCanStand(nx, ny)) { mob.x = nx; mob.y = ny; if (Math.abs(vx) > 0.05) mob.flip = vx < 0 ? 1 : 0; if (mob.anim === 'idle') mob.anim = 'walk'; }
      else { mob.dx = -mob.dx; mob.dy = -mob.dy; }
    } else if (mob.anim === 'walk') mob.anim = 'idle';
    // pushed into a fresh territory -> go home
    if (inAnyTerritory(mob.x, mob.y, 20)) { mob.x = mob.hx; mob.y = mob.hy; if (inAnyTerritory(mob.x, mob.y, 20)) { mob.dead = true; mob.deadUntil = t + MOB_RESPAWN_MS * 3; } }
  }
  // per-player snapshot of nearby mobs
  for (const [pid, L] of players) {
    const list = [];
    for (const mob of mobs.values()) { if (mob.dead) continue; if (Math.abs(mob.x - L.x) > 700 || Math.abs(mob.y - L.y) > 520) continue; list.push([mob.id, mob.kind, Math.round(mob.x), Math.round(mob.y), mob.hp, mob.flip, mob.anim]); }
    const c = conns.get(pid); if (c) c.send({ t: 'mobs', m: list });
  }
}
function onChat(c, p, L, m) {
  const t = now(); if (t - L.lastChat < 800) return; L.lastChat = t;
  const text = cleanName(m.text, 120); if (!text) return;
  if (m.scope === 'tribe') { if (!p.tribe) return err(c, 'در قبیله‌ای نیستی.'); sendTribe(p.tribe, { t: 'chat', scope: 'tribe', from: p.name, text }); }
  else sendAll({ t: 'chat', scope: 'all', from: p.name, tribe: (tribeOf(p) || {}).name || '', text });
}

// ---------------------------------------------------------------- main loop
setInterval(() => {
  const t = now();
  // snapshots
  const arr = [];
  for (const [pid, L] of live) if (conns.has(pid)) arr.push([pid, Math.round(L.x), Math.round(L.y), L.f, L.a, L.hp, (S.players[pid] || {}).tribe || '']);
  if (arr.length && conns.size) sendAll({ t: 'snap', p: arr });
  if (Math.floor(t / TICK_MS) % 2 === 0) mobTick();
  // expire wars
  for (const w of S.wars.slice()) if (t >= w.end) endWar(w, 'جنگ بی‌نتیجه پایان یافت.');
  // slow heart regen outside war
  if (Math.floor(t / TICK_MS) % 100 === 0) for (const k in S.bricks) { const b = S.bricks[k]; const d = BRICKS[b.kind]; if (d && b.hp < d.hp && !(b.tribe && activeWarOf(b.tribe).length)) { b.hp = Math.min(d.hp, b.hp + 6); dirty = true; } }
  // idle cleanup
  for (const [pid, c] of conns) if (t - c.lastPong > 120000) c.close();
}, TICK_MS);
setInterval(() => { for (const [, c] of conns) { try { c.sock.write(Buffer.from([0x89, 0])); } catch (e) { /* ignore */ } } }, 25000);

function lanIps() { try { const os = require('os'); const out = []; for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address); return out; } catch (e) { return []; } }
server.listen(PORT, () => console.log('Qiyam server ' + VERSION + (SECURE ? ' [TLS: wss]' : ' [plain: put a TLS proxy in front for wss]') + ' listening on :' + PORT + '  world ' + W + 'x' + H + '  nodes ' + WORLD.nodes.length))
setTimeout(() => { const ips = lanIps(); console.log('\nمتصل شدن از گوشی (همان وای‌فای):'); for (const ip of ips) console.log('   ' + (SECURE ? 'wss://' : 'ws://') + ip + ':' + PORT); console.log('روی خود این دستگاه: ws://127.0.0.1:' + PORT + '\n'); }, 300);
