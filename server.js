/**
 * Galaxy Clicker - server
 *
 * Run:  node server.js
 * Env:  PORT (default 3000), ADMIN_KEY (generated + saved to data/admin-key.txt if missing)
 *
 * Anti-cheat model:
 *  - Auto-clickers are ALLOWED. No punishment for fast clicking.
 *  - Score fabrication is BLOCKED: the client never sends a score.
 *    Every click is a POST /api/click, the server increments and returns the total.
 *  - Suspicious patterns (NaN/Infinity/negative values, client score mismatch,
 *    inhuman sustained rates) are logged to the alerts table WITH the username.
 *    The admin decides: warn the player or reset them to 0.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

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

// ---------- Database ----------
const db = new Database(path.join(DATA_DIR, 'galaxy-clicker.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS players (
  username   TEXT PRIMARY KEY,
  points     INTEGER NOT NULL DEFAULT 0,
  clicks     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  warn_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS warnings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seen       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT,
  type       TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL,
  resolved   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS admin_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  username   TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
`);

// Upgrade-system migration: add columns to databases created before upgrades existed
(function migrateUpgradeColumns() {
  const cols = db.prepare('PRAGMA table_info(players)').all().map(c => c.name);
  const needed = [
    ['click_power', 'INTEGER NOT NULL DEFAULT 1'],
    ['auto_clickers', 'INTEGER NOT NULL DEFAULT 0'],
    ['multiplier', 'INTEGER NOT NULL DEFAULT 1'],
  ];
  for (const [col, ddl] of needed) {
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE players ADD COLUMN ${col} ${ddl}`);
      console.log(`[migrate] added players.${col}`);
    }
  }
})();

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

// Alert logging, throttled: max 1 alert per (username, type) per 5 minutes
const alertThrottle = new Map();
const insertAlert = db.prepare(
  'INSERT INTO alerts (username, type, detail, created_at) VALUES (?,?,?,?)'
);
function logAlert(username, type, detail) {
  const key = `${username}|${type}`;
  const now = Date.now();
  const last = alertThrottle.get(key);
  if (last && now - last < 5 * 60 * 1000) return;
  alertThrottle.set(key, now);
  insertAlert.run(username || null, type, detail || null, now);
}

const insertAdminLog = db.prepare(
  'INSERT INTO admin_log (action, username, detail, created_at) VALUES (?,?,?,?)'
);
function logAdmin(action, username, detail) {
  insertAdminLog.run(action, username || null, detail || null, Date.now());
}

const getPlayer = db.prepare('SELECT * FROM players WHERE username = ?');
const touchPlayer = db.prepare('UPDATE players SET last_seen = ? WHERE username = ?');

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
  return db.prepare(
    'SELECT id, message, created_at FROM warnings WHERE username = ? AND seen = 0 ORDER BY created_at ASC'
  ).all(username);
}
function markWarningsSeen(username) {
  db.prepare('UPDATE warnings SET seen = 1 WHERE username = ? AND seen = 0').run(username);
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
  if (getPlayer.get(name)) {
    return res.status(409).json({ error: 'Username is taken. Pick another.' });
  }
  const now = Date.now();
  db.prepare(
    'INSERT INTO players (username, points, clicks, created_at, last_seen, warn_count) VALUES (?,?,?,?,?,0)'
  ).run(name, 0, 0, now, now);
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
  const player = getPlayer.get(name);
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
  db.prepare('UPDATE players SET points = points + ?, clicks = clicks + 1, last_seen = ? WHERE username = ?')
    .run(gain, now, name);
  const updated = getPlayer.get(name);

  const warnings = unreadWarnings(name);
  if (warnings.length) markWarningsSeen(name);

  res.json({
    username: name,
    points: updated.points,
    clicks: updated.clicks,
    perClick: gain,
    warnings: warnings.map(w => ({ message: w.message, at: w.created_at })),
  });
});

// Leaderboard: top 100
app.get('/api/leaderboard', (req, res) => {
  const rows = db.prepare(
    'SELECT username, points, clicks FROM players ORDER BY points DESC, clicks ASC LIMIT 100'
  ).all();
  res.json({ leaders: rows });
});

// Player stats (public, read-only)
app.get('/api/player/:username', (req, res) => {
  const name = req.params.username;
  if (!isValidUsername(name)) return res.status(400).json({ error: 'Invalid username.' });
  const player = getPlayer.get(norm(name));
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  const rankRow = db.prepare(
    'SELECT COUNT(*) AS c FROM players WHERE points > ?'
  ).get(player.points);
  res.json(Object.assign({
    username: player.username,
    points: player.points,
    clicks: player.clicks,
    warnings: player.warn_count,
    rank: rankRow.c + 1,
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
  const player = getPlayer.get(name);
  if (!player) {
    res.status(404).json({ error: 'Player not found. Register first.' });
    return null;
  }
  return { name, player };
}

// Atomic purchase helper: deduct cost and apply effect only if affordable.
// Returns the fresh player row, or null if not enough points.
function atomicPurchase(name, cost, effectSql, effectArgs) {
  const now = Date.now();
  const info = db.prepare(
    `UPDATE players SET points = points - ?, last_seen = ?, ${effectSql} WHERE username = ? AND points >= ?`
  ).run(cost, now, ...effectArgs, name, cost);
  if (info.changes === 0) return null;
  return getPlayer.get(name);
}

// Buy +1 click power. Cost = round(50 * level^1.5), no cap.
app.post('/api/upgrade/click', (req, res) => {
  const buyer = validateBuyer(req, res);
  if (!buyer) return;
  const { name, player } = buyer;
  const level = player.click_power || 1;
  const cost = clickPowerCost(level);
  const updated = atomicPurchase(name, cost, 'click_power = click_power + 1', []);
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
  const updated = atomicPurchase(name, cost, 'auto_clickers = auto_clickers + 1', []);
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
  const updated = atomicPurchase(name, next.cost, 'multiplier = ?', [next.tier]);
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
  const player = getPlayer.get(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  db.prepare('UPDATE players SET points = points + ? WHERE username = ?').run(amount, name);
  logAdmin('give', name, `+${amount}`);
  res.json({ username: name, points: getPlayer.get(name).points });
});

// Reset player to 0
app.post('/api/admin/reset', requireAdmin, (req, res) => {
  const { username } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  const name = norm(username);
  const player = getPlayer.get(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  db.prepare('UPDATE players SET points = 0 WHERE username = ?').run(name);
  logAdmin('reset', name, `was ${player.points}`);
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
  const player = getPlayer.get(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  const msg = message.trim();
  db.prepare('INSERT INTO warnings (username, message, created_at) VALUES (?,?,?)')
    .run(name, msg, Date.now());
  db.prepare('UPDATE players SET warn_count = warn_count + 1 WHERE username = ?').run(name);
  logAdmin('warn', name, msg);
  res.json({ ok: true });
});

// Suspicious-activity alerts
app.get('/api/admin/alerts', requireAdmin, (req, res) => {
  const includeResolved = req.query.all === '1';
  const rows = db.prepare(
    `SELECT * FROM alerts ${includeResolved ? '' : 'WHERE resolved = 0 '}
     ORDER BY resolved ASC, created_at DESC LIMIT 200`
  ).all();
  res.json({ alerts: rows });
});

app.post('/api/admin/alerts/:id/resolve', requireAdmin, (req, res) => {
  db.prepare('UPDATE alerts SET resolved = 1 WHERE id = ?').run(req.params.id);
  logAdmin('alert_resolve', null, `alert #${req.params.id}`);
  res.json({ ok: true });
});

// Recent admin actions (audit trail)
app.get('/api/admin/log', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM admin_log ORDER BY created_at DESC LIMIT 100').all();
  res.json({ log: rows });
});

// Admin: list/search players
app.get('/api/admin/players', requireAdmin, (req, res) => {
  const q = (req.query.q || '').trim();
  let rows;
  if (q) {
    rows = db.prepare(
      'SELECT username, points, clicks, warn_count, last_seen FROM players WHERE username LIKE ? ORDER BY points DESC LIMIT 50'
    ).all(`%${q}%`);
  } else {
    rows = db.prepare(
      'SELECT username, points, clicks, warn_count, last_seen FROM players ORDER BY points DESC LIMIT 50'
    ).all();
  }
  res.json({ players: rows });
});

// Passive income: every second, each player with auto-clickers earns
// auto_clickers * multiplier points. Single atomic UPDATE, no per-player loop.
setInterval(() => {
  try {
    db.prepare(
      'UPDATE players SET points = points + (auto_clickers * multiplier) WHERE auto_clickers > 0'
    ).run();
  } catch (e) {
    console.error('auto-income tick failed:', e.message);
  }
}, 1000);

app.listen(PORT, () => {
  console.log(`🌌 Galaxy Clicker live on http://localhost:${PORT}`);
  console.log(`   Admin key: ${ADMIN_KEY}`);
  console.log(`   (saved in data/admin-key.txt — keep it secret)`);
});
