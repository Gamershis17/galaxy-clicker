/**
 * Galaxy Clicker - server
 *
 * Run:  node server.js
 * Env:  PORT (default 3000), ADMIN_KEY (generated + saved to data/admin-key.txt if missing)
 *
 * Storage: pure-JS JSON file database (data/db.json). No native modules, so it
 * runs anywhere Node runs (including hosts where native SQLite bindings fail).
 *
 * Anti-cheat model:
 *  - Auto-clickers are ALLOWED. No punishment for fast clicking.
 *  - Score fabrication is BLOCKED: the client never sends a score.
 *    Every click is a POST /api/click, the server increments and returns the total.
 *  - Suspicious patterns (NaN/Infinity/negative values, client score mismatch,
 *    inhuman sustained rates) are logged to the alerts list WITH the username.
 *    The admin decides: warn the player or reset them to 0.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Admin key ----------
let ADMIN_KEY = process.env.ADMIN_KEY;
const KEY_FILE = path.join(DATA_DIR, 'admin-key.txt');
if (!ADMIN_KEY) {
  if (fs.existsSync(KEY_FILE)) {
    ADMIN_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
  } else {
    ADMIN_KEY = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(KEY_FILE, ADMIN_KEY, { mode: 0o600 });
  }
}

// Usernames nobody can register (Cody's name stays his)
const RESERVED = (process.env.RESERVED_USERNAMES || 'cody,admin,galaxyclicker,system')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// ---------- JSON Database ----------
// Shape: { players: {username: player}, warnings: [], alerts: [], admin_log: [],
//          seq: { warnings: n, alerts: n, admin_log: n } }
// Player: { username, points, clicks, created_at, last_seen, warn_count,
//           total_earned, supernova_shards, supernovas, achievements[],
//           upgrades: { <upgradeId>: level } }
// Legacy fields (click_power, auto_clickers, multiplier) are migrated on load.
const DB_FILE = path.join(DATA_DIR, 'db.json');

// ---------- Game definitions ----------

// 10 upgrades. Cost = round(baseCost * 1.15^level). No level cap.
const UPGRADES = [
  { id: 'stellar_gloves',  name: 'Stellar Gloves',      icon: '✦', short: '+1 per tap',      baseCost: 15,      tap: 1,     sec: 0     },
  { id: 'nebula_collector',name: 'Nebula Collector',    icon: '◐', short: '+1 star / sec',    baseCost: 50,      tap: 0,     sec: 1     },
  { id: 'comet_miner',     name: 'Comet Miner',         icon: '☄', short: '+8 stars / sec',    baseCost: 300,     tap: 0,     sec: 8     },
  { id: 'quantum_fingers', name: 'Quantum Fingers',     icon: '✣', short: '+12 per tap',     baseCost: 900,     tap: 12,    sec: 0     },
  { id: 'pulsar_engine',   name: 'Pulsar Engine',       icon: '◎', short: '+45 stars / sec',  baseCost: 1800,    tap: 0,     sec: 45    },
  { id: 'star_forge',     name: 'Star Forge',          icon: '⬢', short: '+220 stars / sec', baseCost: 8500,    tap: 0,     sec: 220   },
  { id: 'supernova_core', name: 'Supernova Core',      icon: '⬣', short: '+1,400 stars / sec',baseCost: 42000,   tap: 0,     sec: 1400  },
  { id: 'void_tap',       name: 'Void Tap',            icon: '✧', short: '+180 per tap',     baseCost: 120000,  tap: 180,   sec: 0     },
  { id: 'black_hole',     name: 'Black Hole Harvester',icon: '●', short: '+9,000 stars / sec',baseCost: 350000,  tap: 0,     sec: 9000  },
  { id: 'galaxy_swarm',   name: 'Galaxy Swarm',        icon: '✹', short: '+55,000 stars / sec',baseCost: 2200000,tap: 0,     sec: 55000 },
];
const UPGRADE_MAP = Object.fromEntries(UPGRADES.map(u => [u.id, u]));
function upgradeCost(def, level) {
  return Math.max(1, Math.round(def.baseCost * Math.pow(1.15, level)));
}
// Total cost to buy `count` levels starting at `level`
function bulkCost(def, level, count) {
  let total = 0;
  for (let i = 0; i < count; i++) total += upgradeCost(def, level + i);
  return total;
}
// How many levels can be bought with `points` starting at `level` (for MAX buy)
function maxAffordable(def, level, points) {
  let count = 0, spent = 0;
  for (;;) {
    const c = upgradeCost(def, level + count);
    if (spent + c > points || count >= 1000) break;
    spent += c;
    count++;
  }
  return { count, cost: spent };
}

// Ranks by all-time stars earned
const RANKS = [
  { name: 'Stargazer',      at: 0 },
  { name: 'Nebula Walker',  at: 1000 },
  { name: 'Star Captain',   at: 100000 },
  { name: 'Galaxy Lord',    at: 10000000 },
  { name: 'Cosmic Emperor', at: 1000000000 },
];
function rankFor(totalEarned) {
  let r = RANKS[0], next = null;
  for (let i = 0; i < RANKS.length; i++) {
    if (totalEarned >= RANKS[i].at) r = RANKS[i];
    else { next = RANKS[i]; break; }
  }
  return { rank: r, next };
}

// Achievements
const ACHIEVEMENTS = [
  { id: 'clicks_100',   name: '100 clicks' },
  { id: 'clicks_1000',  name: '1,000 clicks' },
  { id: 'earned_10k',   name: '10K earned' },
  { id: 'earned_1m',    name: '1M earned' },
  { id: 'upgrades_10',  name: '10 upgrades' },
  { id: 'upgrades_50',  name: '50 upgrades' },
  { id: 'supernova_1',  name: 'First supernova' },
  { id: 'hold_100k',    name: 'Hold 100K stars' },
];
function totalUpgradeLevels(p) {
  let n = 0;
  for (const u of UPGRADES) n += (p.upgrades && p.upgrades[u.id]) || 0;
  return n;
}
function checkAchievements(p) {
  const have = new Set(p.achievements || []);
  const earned = [];
  const defs = [
    ['clicks_100',  p.clicks >= 100],
    ['clicks_1000', p.clicks >= 1000],
    ['earned_10k',  (p.total_earned || 0) >= 10000],
    ['earned_1m',   (p.total_earned || 0) >= 1000000],
    ['upgrades_10', totalUpgradeLevels(p) >= 10],
    ['upgrades_50', totalUpgradeLevels(p) >= 50],
    ['supernova_1', (p.supernovas || 0) >= 1],
    ['hold_100k',   p.points >= 100000],
  ];
  for (const [id, ok] of defs) {
    if (ok && !have.has(id)) { have.add(id); earned.push(id); }
  }
  if (earned.length) {
    p.achievements = [...have];
    saveDb();
  }
  return earned;
}

// Derived stats: per-tap and per-second BEFORE session multipliers (combo/crit/stardust)
function shardMultiplier(p) {
  return 1 + ((p.supernova_shards || 0) * 0.10);
}
function baseTapPower(p) {
  let bonus = 0;
  for (const u of UPGRADES) bonus += ((p.upgrades && p.upgrades[u.id]) || 0) * u.tap;
  return (1 + bonus) * shardMultiplier(p);
}
function basePerSecond(p) {
  let bonus = 0;
  for (const u of UPGRADES) bonus += ((p.upgrades && p.upgrades[u.id]) || 0) * u.sec;
  return bonus * shardMultiplier(p);
}
function playerSnapshot(p) {
  const rankInfo = rankFor(p.total_earned || 0);
  return {
    username: p.username,
    points: p.points,
    clicks: p.clicks,
    totalEarned: p.total_earned || 0,
    supernovaShards: p.supernova_shards || 0,
    supernovas: p.supernovas || 0,
    achievements: p.achievements || [],
    rank: rankInfo.rank.name,
    nextRank: rankInfo.next ? { name: rankInfo.next.name, at: rankInfo.next.at } : null,
    multiplier: Math.round(shardMultiplier(p) * 100) / 100,
    perClick: baseTapPower(p),
    perSecond: basePerSecond(p),
    upgrades: UPGRADES.map(u => {
      const level = (p.upgrades && p.upgrades[u.id]) || 0;
      return {
        id: u.id, name: u.name, icon: u.icon, short: u.short,
        level,
        tapEach: u.tap, secEach: u.sec,
        totalTap: level * u.tap,
        totalSec: level * u.sec,
        cost1: upgradeCost(u, level),
        cost10: bulkCost(u, level, 10),
      };
    }),
  };
}

function blankDb() {
  return {
    players: {},
    warnings: [],
    alerts: [],
    admin_log: [],
    seq: { warnings: 0, alerts: 0, admin_log: 0 },
  };
}

function normalizePlayer(p) {
  if (p.points == null) p.points = 0;
  if (p.clicks == null) p.clicks = 0;
  if (p.warn_count == null) p.warn_count = 0;
  // supernova / prestige fields
  if (p.total_earned == null) p.total_earned = p.points || 0;
  if (p.supernova_shards == null) p.supernova_shards = 0;
  if (p.supernovas == null) p.supernovas = 0;
  if (!Array.isArray(p.achievements)) p.achievements = [];
  // 10-upgrade system
  if (!p.upgrades || typeof p.upgrades !== 'object') p.upgrades = {};
  for (const u of UPGRADES) {
    if (p.upgrades[u.id] == null) p.upgrades[u.id] = 0;
  }
  // migrate legacy upgrade system (click_power / auto_clickers / multiplier)
  if (p.click_power != null || p.auto_clickers != null || p.multiplier != null) {
    const cp = p.click_power || 1;
    const ac = p.auto_clickers || 0;
    const m = p.multiplier || 1;
    // click_power Lv N = +N per tap; new base is 1 + stellar_gloves levels
    if (cp > 1) p.upgrades.stellar_gloves = Math.max(p.upgrades.stellar_gloves, cp - 1);
    // auto_clickers 1:1 to nebula_collector
    if (ac > 0) p.upgrades.nebula_collector = Math.max(p.upgrades.nebula_collector, ac);
    // multiplier -> supernova shards: x2=10, x5=40, x10=90 (+10% each)
    if (m > 1) p.supernova_shards = Math.max(p.supernova_shards, Math.round((m - 1) * 10));
    delete p.click_power;
    delete p.auto_clickers;
    delete p.multiplier;
  }
  return p;
}

let db;
(function loadDb() {
  db = blankDb();
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        db.players = (raw.players && typeof raw.players === 'object') ? raw.players : {};
        db.warnings = Array.isArray(raw.warnings) ? raw.warnings : [];
        db.alerts = Array.isArray(raw.alerts) ? raw.alerts : [];
        db.admin_log = Array.isArray(raw.admin_log) ? raw.admin_log : [];
        db.seq = Object.assign({ warnings: 0, alerts: 0, admin_log: 0 },
          (raw.seq && typeof raw.seq === 'object') ? raw.seq : {});
      }
    } catch (e) {
      console.error('[db] db.json unreadable, starting fresh:', e.message);
      db = blankDb();
    }
  }
  // normalize every player row (fills upgrade defaults on old data)
  for (const name of Object.keys(db.players)) {
    const p = db.players[name];
    if (p && typeof p === 'object') {
      p.username = name;
      db.players[name] = normalizePlayer(p);
    } else {
      delete db.players[name];
    }
  }
  // repair auto-increment counters so ids never collide
  for (const arr of ['warnings', 'alerts', 'admin_log']) {
    const maxId = db[arr].reduce((m, r) => Math.max(m, (r && r.id) || 0), 0);
    if ((db.seq[arr] || 0) < maxId) db.seq[arr] = maxId;
  }
})();

// Debounced persistence: writes are cheap in-memory ops; the file flush
// happens at most once every 5 seconds, plus a final flush on process exit.
let dirty = false;
let lastSave = 0;
let saveTimer = null;

function flushDb() {
  if (!dirty) return;
  dirty = false;
  lastSave = Date.now();
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE); // atomic replace, no half-written db.json
  } catch (e) {
    console.error('[db] failed to write db.json:', e.message);
    dirty = true; // retry on next flush
  }
}

function saveDb(immediate) {
  dirty = true;
  const now = Date.now();
  if (immediate || now - lastSave >= 5000) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    flushDb();
  } else if (!saveTimer) {
    saveTimer = setTimeout(() => { saveTimer = null; flushDb(); }, 5000 - (now - lastSave));
  }
}

function shutdown() {
  flushDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------- Upgrade helpers (legacy shims removed; see UPGRADES above) ----------

// ---------- Helpers ----------
function isValidUsername(name) {
  return typeof name === 'string'
    && name.trim().length >= 1
    && name.trim().length <= 24
    && /^[A-Za-z0-9 _-]+$/.test(name.trim());
}
const norm = (name) => name.trim();
function isFiniteNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

// Player accessors (replacing the old prepared statements)
function getPlayer(name) {
  return db.players[name] || null;
}

// Alert logging, throttled: max 1 alert per (username, type) per 5 minutes
const alertThrottle = new Map();
function logAlert(username, type, detail) {
  const key = `${username}|${type}`;
  const now = Date.now();
  const last = alertThrottle.get(key);
  if (last && now - last < 5 * 60 * 1000) return;
  alertThrottle.set(key, now);
  db.alerts.push({
    id: ++db.seq.alerts,
    username: username || null,
    type,
    detail: detail || null,
    created_at: now,
    resolved: 0,
  });
  saveDb();
}

function logAdmin(action, username, detail) {
  db.admin_log.push({
    id: ++db.seq.admin_log,
    action,
    username: username || null,
    detail: detail || null,
    created_at: Date.now(),
  });
  saveDb();
}

// In-memory click timestamps per user for rate analysis (auto-clickers OK,
// we only flag truly impossible sustained rates)
const clickTimes = new Map(); // username -> array of timestamps (ms)
function recordClickTime(username) {
  const now = Date.now();
  let arr = clickTimes.get(username);
  if (!arr) { arr = []; clickTimes.set(username, arr); }
  arr.push(now);
  // prune older than 60s, cap length
  while (arr.length && arr[0] < now - 60000) arr.shift();
  if (arr.length > 2000) arr.splice(0, arr.length - 2000);
  // rate over last 10 seconds
  const windowStart = now - 10000;
  let count = 0;
  for (let i = arr.length - 1; i >= 0 && arr[i] >= windowStart; i--) count++;
  return count / 10; // clicks per second
}

// Generous token bucket: allows auto-clickers (~20/sec), blocks floods.
// Capacity 150 burst, refill 30/sec.
const buckets = new Map();
function allowClick(username) {
  const now = Date.now();
  let b = buckets.get(username);
  if (!b) { b = { tokens: 150, last: now }; buckets.set(username, b); }
  const elapsed = (now - b.last) / 1000;
  b.tokens = Math.min(150, b.tokens + elapsed * 30);
  b.last = now;
  if (b.tokens >= 1) { b.tokens -= 1; return true; }
  return false;
}

function unreadWarnings(username) {
  return db.warnings
    .filter(w => w.username === username && !w.seen)
    .sort((a, b) => a.created_at - b.created_at)
    .map(w => ({ id: w.id, message: w.message, created_at: w.created_at }));
}
function markWarningsSeen(username) {
  let changed = false;
  for (const w of db.warnings) {
    if (w.username === username && !w.seen) { w.seen = 1; changed = true; }
  }
  if (changed) saveDb();
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ----- Public API -----

// Register a username (no account, no password)
app.post('/api/register', (req, res) => {
  const { username } = req.body || {};
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: 'Username must be 1-24 chars: letters, numbers, spaces, _ or -.' });
  }
  const name = norm(username);
  if (RESERVED.includes(name.toLowerCase())) {
    return res.status(403).json({ error: 'That username is reserved.' });
  }
  if (getPlayer(name)) {
    return res.status(409).json({ error: 'Username is taken. Pick another.' });
  }
  const now = Date.now();
  const fresh = normalizePlayer({
    username: name,
    points: 0,
    clicks: 0,
    created_at: now,
    last_seen: now,
    warn_count: 0,
  });
  db.players[name] = fresh;
  saveDb();
  logAdmin('register', name, 'self-registered');
  res.json({ username: name, points: 0, clicks: 0 });
});

// Click! Server validates and computes the new total. Client never sends a score.
app.post('/api/click', (req, res) => {
  const { username, clientScore } = req.body || {};
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: 'Invalid username.' });
  }
  const name = norm(username);
  const player = getPlayer(name);
  if (!player) {
    return res.status(404).json({ error: 'Player not found. Register first.' });
  }

  // Fabrication tripwires: non-finite clientScore, or a client score that
  // doesn't match the server's truth -> log with username, keep serving truth.
  // Tolerance also covers passive auto-clicker income earned since the client's
  // last update (server ticks every second).
  if (clientScore !== undefined) {
    if (!isFiniteNum(clientScore)) {
      logAlert(name, 'malformed', `clientScore was ${String(clientScore)} (non-finite)`);
      return res.status(400).json({ error: 'Bad request.' });
    }
    const passiveWindow = basePerSecond(player) * 20;
    const drift = Math.abs(clientScore - player.points);
    const tolerance = Math.max(50, Math.floor(player.points * 0.02)) + passiveWindow;
    if (drift > tolerance) {
      logAlert(name, 'score_mismatch',
        `client claimed ${clientScore}, server has ${player.points} (drift ${drift})`);
    }
  }

  // Generous rate limit (auto-clickers allowed). Floods get 429, not bans.
  if (!allowClick(name)) {
    return res.status(429).json({ error: 'Whoa, slow down a touch.', points: player.points });
  }

  const rate = recordClickTime(name);
  if (rate > 45) {
    logAlert(name, 'inhuman_rate', `${rate.toFixed(1)} clicks/sec sustained over 10s window`);
  }

  const now = Date.now();
  // Base gain; client applies crit (7% x5) and combo (up to x2) on top visually,
  // but the SERVER is authoritative — it grants baseTapPower. Crit/combo are
  // sent by the client as a claimed bonus which we validate within bounds.
  const { crit, comboMult } = req.body || {};
  let gain = baseTapPower(player);
  let appliedMult = 1;
  // Validate client-claimed combo: must be 1..2
  if (comboMult !== undefined) {
    if (!isFiniteNum(comboMult) || comboMult < 1 || comboMult > 2) {
      logAlert(name, 'malformed', `comboMult was ${String(comboMult)}`);
    } else {
      appliedMult = comboMult;
    }
  }
  // Validate client-claimed crit: must be boolean; server rolls its own 7%
  // to prevent crit-spoofing — we use server-side roll as truth.
  const serverCrit = Math.random() < 0.07;
  if (serverCrit) appliedMult *= 5;
  gain = Math.floor(gain * appliedMult);

  player.points += gain;
  player.total_earned = (player.total_earned || 0) + gain;
  player.clicks += 1;
  player.last_seen = now;
  const newAchievements = checkAchievements(player);
  saveDb();

  const warnings = unreadWarnings(name);
  if (warnings.length) markWarningsSeen(name);

  res.json({
    username: name,
    points: player.points,
    clicks: player.clicks,
    perClick: gain,
    crit: serverCrit,
    comboMult: appliedMult / (serverCrit ? 5 : 1),
    newAchievements,
    warnings: warnings.map(w => ({ message: w.message, at: w.created_at })),
  });
});

// Leaderboard: top 100
app.get('/api/leaderboard', (req, res) => {
  const rows = Object.values(db.players)
    .map(p => ({ username: p.username, points: p.points, clicks: p.clicks }))
    .sort((a, b) => (b.points - a.points) || (a.clicks - b.clicks))
    .slice(0, 100);
  res.json({ leaders: rows });
});

// Player stats (public, read-only) — full snapshot for the new UI
app.get('/api/player/:username', (req, res) => {
  const name = req.params.username;
  if (!isValidUsername(name)) return res.status(400).json({ error: 'Invalid username.' });
  const player = getPlayer(norm(name));
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  const leaderboardRank = Object.values(db.players).filter(p => p.points > player.points).length + 1;
  const snap = playerSnapshot(player);
  snap.leaderboardRank = leaderboardRank;
  snap.warnings = player.warn_count;
  res.json(snap);
});

// ----- Upgrade API: buy any of the 10 upgrades, x1 / x10 / MAX -----

function validateBuyer(req, res) {
  const { username } = req.body || {};
  if (!isValidUsername(username)) {
    res.status(400).json({ error: 'Invalid username.' });
    return null;
  }
  const name = norm(username);
  const player = getPlayer(name);
  if (!player) {
    res.status(404).json({ error: 'Player not found. Register first.' });
    return null;
  }
  return { name, player };
}

// Purchase helper: deduct cost and apply effect only if affordable.
// Returns the fresh player row, or null if not enough points.
function atomicPurchase(name, cost, applyEffect) {
  const player = getPlayer(name);
  if (!player || player.points < cost) return null;
  player.points -= cost;
  player.last_seen = Date.now();
  applyEffect(player);
  saveDb();
  return player;
}

// Buy upgrade levels. Body: { username, upgradeId, mode } where mode is
// 1 (single), 10 (ten), or "max" (as many as affordable, up to 1000).
app.post('/api/upgrade/buy', (req, res) => {
  const buyer = validateBuyer(req, res);
  if (!buyer) return;
  const { name, player } = buyer;
  const { upgradeId, mode } = req.body || {};
  const def = UPGRADE_MAP[upgradeId];
  if (!def) {
    logAlert(name, 'malformed', `unknown upgradeId ${String(upgradeId)}`);
    return res.status(400).json({ error: 'Unknown upgrade.' });
  }
  const level = (player.upgrades && player.upgrades[def.id]) || 0;
  let count, cost;
  if (mode === 'max') {
    const r = maxAffordable(def, level, player.points);
    count = r.count; cost = r.cost;
  } else {
    count = mode === 10 ? 10 : 1;
    cost = bulkCost(def, level, count);
  }
  if (count < 1) {
    return res.status(400).json({
      error: `Need ${upgradeCost(def, level).toLocaleString('en-US')} stars for ${def.name} Lv ${level + 1}.`,
    });
  }
  const updated = atomicPurchase(name, cost, (p) => {
    if (!p.upgrades) p.upgrades = {};
    p.upgrades[def.id] = ((p.upgrades[def.id]) || 0) + count;
  });
  if (!updated) {
    return res.status(400).json({ error: `Need ${cost.toLocaleString('en-US')} stars.` });
  }
  const newAchievements = checkAchievements(updated);
  logAdmin('upgrade_buy', name, `${def.id} x${count} (Lv ${level} -> ${level + count}), cost ${cost}`);
  res.json(Object.assign({ ok: true, bought: count, newAchievements }, playerSnapshot(updated)));
});

// ----- Supernova prestige -----
// Requires 100K total stars earned. Grants floor(total_earned / 100K) shards
// (+10% each, forever), then resets points/clicks/upgrades/total_earned.
const SUPERNOVA_THRESHOLD = 100000;
app.post('/api/supernova', (req, res) => {
  const buyer = validateBuyer(req, res);
  if (!buyer) return;
  const { name, player } = buyer;
  const earned = player.total_earned || 0;
  if (earned < SUPERNOVA_THRESHOLD) {
    return res.status(400).json({
      error: `Need ${(SUPERNOVA_THRESHOLD - earned).toLocaleString('en-US')} more stars earned to go supernova.`,
    });
  }
  const shards = Math.floor(earned / SUPERNOVA_THRESHOLD);
  player.supernova_shards = (player.supernova_shards || 0) + shards;
  player.supernovas = (player.supernovas || 0) + 1;
  player.points = 0;
  player.clicks = 0;
  player.total_earned = 0;
  player.upgrades = {};
  for (const u of UPGRADES) player.upgrades[u.id] = 0;
  const newAchievements = checkAchievements(player);
  saveDb();
  logAdmin('supernova', name, `+${shards} shards (total ${player.supernova_shards}), supernovas: ${player.supernovas}`);
  res.json(Object.assign({ ok: true, shardsGained: shards, newAchievements }, playerSnapshot(player)));
});

app.get('/api/status', (req, res) => {
  res.json({ ok: true, game: 'galaxy-clicker', time: Date.now() });
});

// ----- Admin API (key in x-admin-key header) -----
function requireAdmin(req, res, next) {
  if (req.header('x-admin-key') !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  next();
}

// Give points (no cap)
app.post('/api/admin/give', requireAdmin, (req, res) => {
  const { username, amount } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  if (!isFiniteNum(amount) || !Number.isInteger(amount) || amount <= 0) {
    if (amount !== undefined && !isFiniteNum(amount)) {
      logAlert(String(username), 'malformed', `admin give amount was ${String(amount)}`);
    }
    return res.status(400).json({ error: 'Amount must be a positive whole number (no cap).' });
  }
  const name = norm(username);
  const player = getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  player.points += amount;
  player.total_earned = (player.total_earned || 0) + amount;
  checkAchievements(player);
  saveDb();
  logAdmin('give', name, `+${amount}`);
  res.json({ username: name, points: player.points });
});

// Reset player to 0
app.post('/api/admin/reset', requireAdmin, (req, res) => {
  const { username } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  const name = norm(username);
  const player = getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  const was = player.points;
  player.points = 0;
  // full reset wipes prestige too (matches "until full reset" on shards)
  player.total_earned = 0;
  player.clicks = 0;
  player.supernova_shards = 0;
  player.supernovas = 0;
  player.achievements = [];
  player.upgrades = {};
  for (const u of UPGRADES) player.upgrades[u.id] = 0;
  saveDb();
  logAdmin('reset', name, `was ${was} (full reset incl. prestige)`);
  res.json({ username: name, points: 0 });
});

// Set a player's stars to an exact amount (also bumps total_earned so
// ranks/supernova progress stay consistent)
app.post('/api/admin/set-stars', requireAdmin, (req, res) => {
  const { username, amount } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  if (!isFiniteNum(amount) || !Number.isInteger(amount) || amount < 0) {
    return res.status(400).json({ error: 'Amount must be a non-negative whole number.' });
  }
  const name = norm(username);
  const player = getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  const was = player.points;
  const diff = amount - was;
  player.points = amount;
  if (diff > 0) player.total_earned = (player.total_earned || 0) + diff;
  checkAchievements(player);
  saveDb();
  logAdmin('set_stars', name, `${was} -> ${amount}`);
  res.json({ username: name, points: player.points });
});

// Grant supernova shards directly
app.post('/api/admin/shards', requireAdmin, (req, res) => {
  const { username, amount } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  if (!isFiniteNum(amount) || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive whole number.' });
  }
  const name = norm(username);
  const player = getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  player.supernova_shards = (player.supernova_shards || 0) + amount;
  saveDb();
  logAdmin('shards', name, `+${amount} (total ${player.supernova_shards})`);
  res.json({ username: name, shards: player.supernova_shards });
});

// Reset only stars (keeps upgrades, shards, achievements)
app.post('/api/admin/reset-stars', requireAdmin, (req, res) => {
  const { username } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  const name = norm(username);
  const player = getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  const was = player.points;
  player.points = 0;
  saveDb();
  logAdmin('reset_stars', name, `was ${was}`);
  res.json({ username: name, points: 0 });
});

// Warn a player (they see it as a banner in-game)
app.post('/api/admin/warn', requireAdmin, (req, res) => {
  const { username, message } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  if (typeof message !== 'string' || !message.trim() || message.length > 300) {
    return res.status(400).json({ error: 'Message must be 1-300 chars.' });
  }
  const name = norm(username);
  const player = getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  const msg = message.trim();
  db.warnings.push({
    id: ++db.seq.warnings,
    username: name,
    message: msg,
    created_at: Date.now(),
    seen: 0,
  });
  player.warn_count = (player.warn_count || 0) + 1;
  saveDb();
  logAdmin('warn', name, msg);
  res.json({ ok: true });
});

// Suspicious-activity alerts
app.get('/api/admin/alerts', requireAdmin, (req, res) => {
  const includeResolved = req.query.all === '1';
  const rows = db.alerts
    .filter(a => includeResolved || !a.resolved)
    .sort((a, b) => (a.resolved - b.resolved) || (b.created_at - a.created_at))
    .slice(0, 200);
  res.json({ alerts: rows });
});

app.post('/api/admin/alerts/:id/resolve', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const alert = db.alerts.find(a => a.id === id);
  if (alert) { alert.resolved = 1; saveDb(); }
  logAdmin('alert_resolve', null, `alert #${req.params.id}`);
  res.json({ ok: true });
});

// Recent admin actions (audit trail)
app.get('/api/admin/log', requireAdmin, (req, res) => {
  const rows = db.admin_log
    .slice()
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 100);
  res.json({ log: rows });
});

// Admin: list/search players
app.get('/api/admin/players', requireAdmin, (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  let rows = Object.values(db.players).map(p => ({
    username: p.username,
    points: p.points,
    clicks: p.clicks,
    warn_count: p.warn_count,
    last_seen: p.last_seen,
  }));
  if (q) {
    rows = rows.filter(p => p.username.toLowerCase().includes(q));
  }
  rows.sort((a, b) => b.points - a.points);
  res.json({ players: rows.slice(0, 50) });
});

// Passive income: every second, each player earns basePerSecond points.
// Save is debounced (max 1 flush / 5s).
setInterval(() => {
  try {
    let changed = false;
    for (const p of Object.values(db.players)) {
      const income = Math.floor(basePerSecond(p));
      if (income > 0) {
        p.points += income;
        p.total_earned = (p.total_earned || 0) + income;
        changed = true;
      }
    }
    if (changed) saveDb();
  } catch (e) {
    console.error('auto-income tick failed:', e.message);
  }
}, 1000);

app.listen(PORT, () => {
  console.log(`🌌 Galaxy Clicker live on http://localhost:${PORT}`);
  console.log(`   Admin key: ${ADMIN_KEY}`);
  console.log(`   (saved in data/admin-key.txt — keep it secret)`);
});
