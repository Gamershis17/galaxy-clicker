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
//           click_power, auto_clickers, multiplier }
const DB_FILE = path.join(DATA_DIR, 'db.json');

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
  // upgrade-system defaults for data written before upgrades existed
  if (p.click_power == null) p.click_power = 1;
  if (p.auto_clickers == null) p.auto_clickers = 0;
  if (p.multiplier == null) p.multiplier = 1;
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

// ---------- Upgrade costs ----------
const clickPowerCost = (level) => Math.max(1, Math.round(50 * Math.pow(level, 1.5)));
const autoClickerCost = (count) => Math.max(1, Math.round(100 * Math.pow(count + 1, 1.8)));
const MULT_TIERS = [
  { tier: 2, cost: 500 },
  { tier: 5, cost: 5000 },
  { tier: 10, cost: 25000 },
];
function nextMultiplier(current) {
  for (const t of MULT_TIERS) if (t.tier > current) return t;
  return null;
}
function upgradeSnapshot(player) {
  const cp = player.click_power || 1;
  const ac = player.auto_clickers || 0;
  const m = player.multiplier || 1;
  return {
    clickPower: cp,
    autoClickers: ac,
    multiplier: m,
    perClick: cp * m,
    perSecond: ac * m,
    costs: {
      clickPower: clickPowerCost(cp),
      autoClicker: autoClickerCost(ac),
      multiplier: nextMultiplier(m), // {tier, cost} or null when maxed
    },
  };
}

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
  db.players[name] = normalizePlayer({
    username: name,
    points: 0,
    clicks: 0,
    created_at: now,
    last_seen: now,
    warn_count: 0,
    click_power: 1,
    auto_clickers: 0,
    multiplier: 1,
  });
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
    const passiveWindow = (player.auto_clickers || 0) * (player.multiplier || 1) * 20;
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
  const gain = (player.click_power || 1) * (player.multiplier || 1);
  player.points += gain;
  player.clicks += 1;
  player.last_seen = now;
  saveDb();

  const warnings = unreadWarnings(name);
  if (warnings.length) markWarningsSeen(name);

  res.json({
    username: name,
    points: player.points,
    clicks: player.clicks,
    perClick: gain,
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

// Player stats (public, read-only)
app.get('/api/player/:username', (req, res) => {
  const name = req.params.username;
  if (!isValidUsername(name)) return res.status(400).json({ error: 'Invalid username.' });
  const player = getPlayer(norm(name));
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  const rank = Object.values(db.players).filter(p => p.points > player.points).length + 1;
  res.json(Object.assign({
    username: player.username,
    points: player.points,
    clicks: player.clicks,
    warnings: player.warn_count,
    rank,
  }, upgradeSnapshot(player)));
});

// ----- Upgrade API (server-validated purchases, no cap on levels) -----

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
// (Single-threaded Node: check-then-update with no awaits between is atomic,
// matching the old conditional UPDATE ... WHERE points >= ?.)
function atomicPurchase(name, cost, applyEffect) {
  const player = getPlayer(name);
  if (!player || player.points < cost) return null;
  player.points -= cost;
  player.last_seen = Date.now();
  applyEffect(player);
  saveDb();
  return player;
}

// Buy +1 click power. Cost = round(50 * level^1.5), no cap.
app.post('/api/upgrade/click', (req, res) => {
  const buyer = validateBuyer(req, res);
  if (!buyer) return;
  const { name, player } = buyer;
  const level = player.click_power || 1;
  const cost = clickPowerCost(level);
  const updated = atomicPurchase(name, cost, (p) => { p.click_power = (p.click_power || 1) + 1; });
  if (!updated) {
    return res.status(400).json({ error: `Need ${cost.toLocaleString('en-US')} points for Click Power Lv ${level + 1}.` });
  }
  logAdmin('upgrade_click', name, `Lv ${level} -> ${updated.click_power}, cost ${cost}`);
  res.json(Object.assign({ ok: true, points: updated.points }, upgradeSnapshot(updated)));
});

// Buy one auto-clicker. Cost = round(100 * (count+1)^1.8), no cap.
app.post('/api/upgrade/auto', (req, res) => {
  const buyer = validateBuyer(req, res);
  if (!buyer) return;
  const { name, player } = buyer;
  const count = player.auto_clickers || 0;
  const cost = autoClickerCost(count);
  const updated = atomicPurchase(name, cost, (p) => { p.auto_clickers = (p.auto_clickers || 0) + 1; });
  if (!updated) {
    return res.status(400).json({ error: `Need ${cost.toLocaleString('en-US')} points for another auto-clicker.` });
  }
  logAdmin('upgrade_auto', name, `${count} -> ${updated.auto_clickers}, cost ${cost}`);
  res.json(Object.assign({ ok: true, points: updated.points }, upgradeSnapshot(updated)));
});

// Buy the next multiplier tier (x2 -> x5 -> x10), one-time each.
app.post('/api/upgrade/multiplier', (req, res) => {
  const buyer = validateBuyer(req, res);
  if (!buyer) return;
  const { name, player } = buyer;
  const { tier } = req.body || {};
  const current = player.multiplier || 1;
  const next = nextMultiplier(current);
  if (!next) {
    return res.status(400).json({ error: 'Already at max multiplier (x10).' });
  }
  if (tier !== undefined && tier !== next.tier) {
    logAlert(name, 'malformed', `tried to buy multiplier tier ${String(tier)}, expected ${next.tier}`);
    return res.status(400).json({ error: `Next multiplier is x${next.tier}.` });
  }
  const updated = atomicPurchase(name, next.cost, (p) => { p.multiplier = next.tier; });
  if (!updated) {
    return res.status(400).json({ error: `Need ${next.cost.toLocaleString('en-US')} points for x${next.tier} multiplier.` });
  }
  logAdmin('upgrade_multiplier', name, `x${current} -> x${next.tier}, cost ${next.cost}`);
  res.json(Object.assign({ ok: true, points: updated.points }, upgradeSnapshot(updated)));
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
  saveDb();
  logAdmin('reset', name, `was ${was}`);
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

// Passive income: every second, each player with auto-clickers earns
// auto_clickers * multiplier points. Save is debounced (max 1 flush / 5s).
setInterval(() => {
  try {
    let changed = false;
    for (const p of Object.values(db.players)) {
      const ac = p.auto_clickers || 0;
      if (ac > 0) {
        p.points += ac * (p.multiplier || 1);
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
