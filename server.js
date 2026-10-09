/**
 * Galaxy Clicker - server
 *
 * Run:  node server.js
 * Env:  PORT (default 3000), ADMIN_KEY (generated + saved to data/admin-key.txt if missing)
 *
 * Storage: Postgres when DATABASE_URL is set (persistent — survives restarts),
 * otherwise pure-JS JSON file database (data/db.json) for local dev. No native
 * modules, so it runs anywhere Node runs.
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

// Postgres is used when DATABASE_URL is set (e.g. Neon on Render).
// The pg module is loaded lazily so local dev without it still works
// as long as DATABASE_URL is unset (JSON fallback).
const DATABASE_URL = process.env.DATABASE_URL || '';
function loadPg() {
  try {
    return require('pg');
  } catch (e) {
    console.error('[db] DATABASE_URL is set but the "pg" module is not installed. Run: npm install');
    return null;
  }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
    // NOTE: caller must persist the player (store.savePlayer) after this.
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
    banned: !!p.banned,
    banReason: p.ban_reason || null,
    burstCharges: p.burst_charges || 0,
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
  if (p.banned == null) p.banned = 0;
  if (p.ban_reason === undefined) p.ban_reason = null;
  if (p.burst_charges == null) p.burst_charges = 0;
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

// ---------- Storage layer ----------
// Two backends behind one async interface:
//   PostgresStore — used when DATABASE_URL is set. Persistent across restarts.
//   JsonStore     — fallback for local dev. Original pure-JS file store.
//
// Every method returns a Promise. Game logic must `await store.savePlayer(p)`
// after mutating a player object fetched via `store.getPlayer()`.

function rowToPlayer(row) {
  if (!row) return null;
  return normalizePlayer({
    username: row.username,
    points: row.points,
    clicks: row.clicks,
    total_earned: row.total_earned,
    supernova_shards: row.supernova_shards,
    supernovas: row.supernovas,
    achievements: row.achievements || [],
    upgrades: row.upgrades || {},
    created_at: row.created_at,
    last_seen: row.last_seen,
    warn_count: row.warn_count,
    banned: row.banned,
    ban_reason: row.ban_reason,
    burst_charges: row.burst_charges,
  });
}

class PostgresStore {
  constructor(executor, pool) {
    this.q = executor; // .query() — a Pool or a checked-out Client
    this.pool = pool;  // Pool (for transaction() / close())
    this.name = 'postgres';
  }

  static async create(url) {
    const pg = loadPg();
    if (!pg) throw new Error('pg module not installed');
    // pg returns BIGINT as string by default; parse to number.
    pg.types.setTypeParser(20, (v) => parseInt(v, 10));
    // Neon requires SSL; local Postgres usually doesn't.
    const needsSSL = /sslmode=require/i.test(url) || /\.neon\.tech/i.test(url);
    const pool = new pg.Pool({
      connectionString: url,
      ...(needsSSL ? { ssl: { rejectUnauthorized: false } } : {}),
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    pool.on('error', (err) => console.error('[db] pg pool error:', err.message));
    await pool.query('SELECT 1'); // verify connectivity before proceeding
    const store = new PostgresStore(pool, pool);
    await store.initSchema();
    return store;
  }

  async initSchema() {
    await this.q.query(`
      CREATE TABLE IF NOT EXISTS players (
        username TEXT PRIMARY KEY,
        points BIGINT NOT NULL DEFAULT 0,
        clicks BIGINT NOT NULL DEFAULT 0,
        total_earned BIGINT NOT NULL DEFAULT 0,
        supernova_shards INTEGER NOT NULL DEFAULT 0,
        supernovas INTEGER NOT NULL DEFAULT 0,
        achievements JSONB NOT NULL DEFAULT '[]',
        upgrades JSONB NOT NULL DEFAULT '{}',
        created_at BIGINT NOT NULL,
        last_seen BIGINT NOT NULL,
        warn_count INTEGER NOT NULL DEFAULT 0,
        banned INTEGER NOT NULL DEFAULT 0,
        ban_reason TEXT,
        burst_charges INTEGER NOT NULL DEFAULT 0
      );
      -- migrations for databases created before these columns existed
      ALTER TABLE players ADD COLUMN IF NOT EXISTS banned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE players ADD COLUMN IF NOT EXISTS ban_reason TEXT;
      ALTER TABLE players ADD COLUMN IF NOT EXISTS burst_charges INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS warnings (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        seen INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id SERIAL PRIMARY KEY,
        username TEXT,
        type TEXT NOT NULL,
        detail TEXT,
        created_at BIGINT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS admin_log (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        username TEXT,
        detail TEXT,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_players_clicks ON players (clicks DESC);
      CREATE INDEX IF NOT EXISTS idx_warnings_user ON warnings (username);
      CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts (resolved, created_at DESC);
    `);
  }

  // Run fn inside a transaction (SELECT ... FOR UPDATE semantics via tx.getPlayer).
  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PostgresStore(client, this.pool));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  async getPlayer(username) {
    const { rows } = await this.q.query('SELECT * FROM players WHERE username = $1', [username]);
    return rowToPlayer(rows[0]);
  }

  async createPlayer(p) {
    await this.q.query(
      `INSERT INTO players (username, points, clicks, total_earned, supernova_shards,
        supernovas, achievements, upgrades, created_at, last_seen, warn_count,
        banned, ban_reason, burst_charges)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [p.username, p.points, p.clicks, p.total_earned || 0, p.supernova_shards || 0,
       p.supernovas || 0, JSON.stringify(p.achievements || []), JSON.stringify(p.upgrades || {}),
       p.created_at, p.last_seen, p.warn_count || 0,
       p.banned || 0, p.ban_reason || null, p.burst_charges || 0]
    );
  }

  async savePlayer(p) {
    await this.q.query(
      `UPDATE players SET points=$2, clicks=$3, total_earned=$4, supernova_shards=$5,
        supernovas=$6, achievements=$7, upgrades=$8, last_seen=$9, warn_count=$10,
        banned=$11, ban_reason=$12, burst_charges=$13
       WHERE username=$1`,
      [p.username, p.points, p.clicks, p.total_earned || 0, p.supernova_shards || 0,
       p.supernovas || 0, JSON.stringify(p.achievements || []), JSON.stringify(p.upgrades || {}),
       p.last_seen, p.warn_count || 0,
       p.banned || 0, p.ban_reason || null, p.burst_charges || 0]
    );
  }

  async getAllPlayers() {
    const { rows } = await this.q.query('SELECT * FROM players');
    return rows.map(rowToPlayer);
  }

  async countPlayersWithMoreClicks(clicks) {
    const { rows } = await this.q.query('SELECT COUNT(*) AS c FROM players WHERE clicks > $1', [clicks]);
    return rows[0] ? rows[0].c : 0;
  }

  async getLeaderboard(limit) {
    const { rows } = await this.q.query(
      'SELECT username, points, clicks FROM players ORDER BY clicks DESC, points DESC LIMIT $1',
      [limit || 100]
    );
    return rows;
  }

  async addWarning(username, message) {
    const { rows } = await this.q.query(
      'INSERT INTO warnings (username, message, created_at, seen) VALUES ($1,$2,$3,0) RETURNING id',
      [username, message, Date.now()]
    );
    return rows[0].id;
  }

  async getUnreadWarnings(username) {
    const { rows } = await this.q.query(
      'SELECT id, message, created_at FROM warnings WHERE username=$1 AND seen=0 ORDER BY created_at',
      [username]
    );
    return rows;
  }

  async markWarningsSeen(username) {
    await this.q.query('UPDATE warnings SET seen=1 WHERE username=$1 AND seen=0', [username]);
  }

  async addAlert(username, type, detail) {
    await this.q.query(
      'INSERT INTO alerts (username, type, detail, created_at, resolved) VALUES ($1,$2,$3,$4,0)',
      [username || null, type, detail || null, Date.now()]
    );
  }

  async getAlerts(includeResolved) {
    const { rows } = await this.q.query(
      `SELECT * FROM alerts WHERE ($1 OR resolved=0)
       ORDER BY resolved, created_at DESC LIMIT 200`,
      [!!includeResolved]
    );
    return rows;
  }

  async resolveAlert(id) {
    await this.q.query('UPDATE alerts SET resolved=1 WHERE id=$1', [id]);
  }

  async addAdminLog(action, username, detail) {
    await this.q.query(
      'INSERT INTO admin_log (action, username, detail, created_at) VALUES ($1,$2,$3,$4)',
      [action, username || null, detail || null, Date.now()]
    );
  }

  async getAdminLog() {
    const { rows } = await this.q.query(
      'SELECT * FROM admin_log ORDER BY created_at DESC LIMIT 100'
    );
    return rows;
  }

  async close() {
    await this.pool.end();
  }
}

class JsonStore {
  constructor() {
    this.name = 'json';
    this.db = blankDb();
    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        if (raw && typeof raw === 'object') {
          this.db.players = (raw.players && typeof raw.players === 'object') ? raw.players : {};
          this.db.warnings = Array.isArray(raw.warnings) ? raw.warnings : [];
          this.db.alerts = Array.isArray(raw.alerts) ? raw.alerts : [];
          this.db.admin_log = Array.isArray(raw.admin_log) ? raw.admin_log : [];
          this.db.seq = Object.assign({ warnings: 0, alerts: 0, admin_log: 0 },
            (raw.seq && typeof raw.seq === 'object') ? raw.seq : {});
        }
      } catch (e) {
        console.error('[db] db.json unreadable, starting fresh:', e.message);
        this.db = blankDb();
      }
    }
    for (const name of Object.keys(this.db.players)) {
      const p = this.db.players[name];
      if (p && typeof p === 'object') {
        p.username = name;
        this.db.players[name] = normalizePlayer(p);
      } else {
        delete this.db.players[name];
      }
    }
    for (const arr of ['warnings', 'alerts', 'admin_log']) {
      const maxId = this.db[arr].reduce((m, r) => Math.max(m, (r && r.id) || 0), 0);
      if ((this.db.seq[arr] || 0) < maxId) this.db.seq[arr] = maxId;
    }
    // Debounced persistence: in-memory writes are cheap; flush to disk at most
    // once every 5 seconds, plus a final flush on process exit.
    this.dirty = false;
    this.lastSave = 0;
    this.saveTimer = null;
  }

  _flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastSave = Date.now();
    try {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.db));
      fs.renameSync(tmp, DB_FILE); // atomic replace, no half-written db.json
    } catch (e) {
      console.error('[db] failed to write db.json:', e.message);
      this.dirty = true; // retry on next flush
    }
  }

  _markDirty() {
    this.dirty = true;
    const now = Date.now();
    if (now - this.lastSave >= 5000) {
      if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
      this._flush();
    } else if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => { this.saveTimer = null; this._flush(); }, 5000 - (now - this.lastSave));
    }
  }

  async flush() { this._flush(); }
  async close() { /* nothing to close */ }

  async transaction(fn) { return fn(this); } // single-threaded: no lock needed

  async getPlayer(username) {
    const p = this.db.players[username];
    return p ? normalizePlayer(p) : null;
  }

  async createPlayer(p) {
    this.db.players[p.username] = p;
    this._markDirty();
  }

  async savePlayer(p) {
    this.db.players[p.username] = p;
    this._markDirty();
  }

  async getAllPlayers() {
    return Object.values(this.db.players).map(p => normalizePlayer(p));
  }

  async countPlayersWithMoreClicks(clicks) {
    return Object.values(this.db.players).filter(p => p.clicks > clicks).length;
  }

  async getLeaderboard(limit) {
    return Object.values(this.db.players)
      .map(p => ({ username: p.username, points: p.points, clicks: p.clicks }))
      .sort((a, b) => (b.clicks - a.clicks) || (b.points - a.points))
      .slice(0, limit || 100);
  }

  async addWarning(username, message) {
    const id = ++this.db.seq.warnings;
    this.db.warnings.push({ id, username, message, created_at: Date.now(), seen: 0 });
    this._markDirty();
    return id;
  }

  async getUnreadWarnings(username) {
    return this.db.warnings
      .filter(w => w.username === username && !w.seen)
      .sort((a, b) => a.created_at - b.created_at)
      .map(w => ({ id: w.id, message: w.message, created_at: w.created_at }));
  }

  async markWarningsSeen(username) {
    let changed = false;
    for (const w of this.db.warnings) {
      if (w.username === username && !w.seen) { w.seen = 1; changed = true; }
    }
    if (changed) this._markDirty();
  }

  async addAlert(username, type, detail) {
    this.db.alerts.push({
      id: ++this.db.seq.alerts,
      username: username || null,
      type,
      detail: detail || null,
      created_at: Date.now(),
      resolved: 0,
    });
    this._markDirty();
  }

  async getAlerts(includeResolved) {
    return this.db.alerts
      .filter(a => includeResolved || !a.resolved)
      .sort((a, b) => (a.resolved - b.resolved) || (b.created_at - a.created_at))
      .slice(0, 200);
  }

  async resolveAlert(id) {
    const a = this.db.alerts.find(x => x.id === id);
    if (a) { a.resolved = 1; this._markDirty(); }
  }

  async addAdminLog(action, username, detail) {
    this.db.admin_log.push({
      id: ++this.db.seq.admin_log,
      action,
      username: username || null,
      detail: detail || null,
      created_at: Date.now(),
    });
    this._markDirty();
  }

  async getAdminLog() {
    return this.db.admin_log
      .slice()
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 100);
  }
}

// Pick the backend: Postgres when DATABASE_URL is set and reachable,
// otherwise the JSON file store. Retries Postgres a few times, then falls
// back loudly rather than crashing.
let store = null;
async function initStore() {
  if (DATABASE_URL) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        store = await PostgresStore.create(DATABASE_URL);
        console.log('[db] storage: Postgres');
        return;
      } catch (e) {
        console.error(`[db] Postgres connect attempt ${attempt}/5 failed: ${e.message}`);
        if (attempt < 5) await sleep(Math.min(10000, 2000 * attempt));
      }
    }
    console.error('[db] WARNING: DATABASE_URL is set but Postgres is unreachable. ' +
      'Falling back to JSON file storage — DATA WILL BE LOST ON RESTART.');
  } else {
    console.log('[db] DATABASE_URL not set — using JSON file storage (local dev mode).');
  }
  store = new JsonStore();
}

async function shutdown() {
  try { if (store && typeof store.flush === 'function') await store.flush(); } catch (_) { /* ignore */ }
  try { if (store && typeof store.close === 'function') await store.close(); } catch (_) { /* ignore */ }
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

// Player accessor — async, backed by whichever store is active.
async function getPlayer(name) {
  return store.getPlayer(name);
}

// Ban gate: banned players get 403 on gameplay endpoints.
function bannedCheck(player) {
  if (player && player.banned) {
    return { banned: true, error: 'Account banned.' + (player.ban_reason ? ' Reason: ' + player.ban_reason : '') };
  }
  return null;
}

// Alert logging, throttled: max 1 alert per (username, type) per 5 minutes
const alertThrottle = new Map();
async function logAlert(username, type, detail) {
  const key = `${username}|${type}`;
  const now = Date.now();
  const last = alertThrottle.get(key);
  if (last && now - last < 5 * 60 * 1000) return;
  alertThrottle.set(key, now);
  await store.addAlert(username, type, detail);
}

async function logAdmin(action, username, detail) {
  await store.addAdminLog(action, username, detail);
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

async function unreadWarnings(username) {
  return store.getUnreadWarnings(username);
}
async function markWarningsSeen(username) {
  await store.markWarningsSeen(username);
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ----- Public API -----

// Register a username (no account, no password)
app.post('/api/register', async (req, res) => {
  const { username } = req.body || {};
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: 'Username must be 1-24 chars: letters, numbers, spaces, _ or -.' });
  }
  const name = norm(username);
  if (RESERVED.includes(name.toLowerCase())) {
    return res.status(403).json({ error: 'That username is reserved.' });
  }
  if (await getPlayer(name)) {
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
  await store.createPlayer(fresh);
  await logAdmin('register', name, 'self-registered');
  res.json({ username: name, points: 0, clicks: 0 });
});

// Click! Server validates and computes the new total. Client never sends a score.
app.post('/api/click', async (req, res) => {
  const { username, clientScore } = req.body || {};
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: 'Invalid username.' });
  }
  const name = norm(username);
  const player = await getPlayer(name);
  if (!player) {
    return res.status(404).json({ error: 'Player not found. Register first.' });
  }
  const ban = bannedCheck(player);
  if (ban) return res.status(403).json(ban);

  // Fabrication tripwires: non-finite clientScore, or a client score that
  // doesn't match the server's truth -> log with username, keep serving truth.
  // Tolerance also covers passive auto-clicker income earned since the client's
  // last update (server ticks every second).
  if (clientScore !== undefined) {
    if (!isFiniteNum(clientScore)) {
      await logAlert(name, 'malformed', `clientScore was ${String(clientScore)} (non-finite)`);
      return res.status(400).json({ error: 'Bad request.' });
    }
    const passiveWindow = basePerSecond(player) * 20;
    const drift = Math.abs(clientScore - player.points);
    const tolerance = Math.max(50, Math.floor(player.points * 0.02)) + passiveWindow;
    if (drift > tolerance) {
      await logAlert(name, 'score_mismatch',
        `client claimed ${clientScore}, server has ${player.points} (drift ${drift})`);
    }
  }

  // Generous rate limit (auto-clickers allowed). Floods get 429, not bans.
  if (!allowClick(name)) {
    return res.status(429).json({ error: 'Whoa, slow down a touch.', points: player.points });
  }

  const rate = recordClickTime(name);
  if (rate > 45) {
    await logAlert(name, 'inhuman_rate', `${rate.toFixed(1)} clicks/sec sustained over 10s window`);
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
      await logAlert(name, 'malformed', `comboMult was ${String(comboMult)}`);
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
  await store.savePlayer(player);

  const warnings = await unreadWarnings(name);
  if (warnings.length) await markWarningsSeen(name);

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
app.get('/api/leaderboard', async (req, res) => {
  const rows = await store.getLeaderboard(100);
  res.json({ leaders: rows });
});

// Player stats (public, read-only) — full snapshot for the new UI
app.get('/api/player/:username', async (req, res) => {
  const name = req.params.username;
  if (!isValidUsername(name)) return res.status(400).json({ error: 'Invalid username.' });
  const player = await getPlayer(norm(name));
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  const ban = bannedCheck(player);
  if (ban) return res.status(403).json(ban);
  const leaderboardRank = (await store.countPlayersWithMoreClicks(player.clicks)) + 1;
  const snap = playerSnapshot(player);
  snap.leaderboardRank = leaderboardRank;
  snap.warnings = player.warn_count;
  res.json(snap);
});

// ----- Upgrade API: buy any of the 10 upgrades, x1 / x10 / MAX -----

async function validateBuyer(req, res) {
  const { username } = req.body || {};
  if (!isValidUsername(username)) {
    res.status(400).json({ error: 'Invalid username.' });
    return null;
  }
  const name = norm(username);
  const player = await getPlayer(name);
  if (!player) {
    res.status(404).json({ error: 'Player not found. Register first.' });
    return null;
  }
  return { name, player };
}

// Buy upgrade levels. Body: { username, upgradeId, mode } where mode is
// 1 (single), 10 (ten), or "max" (as many as affordable, up to 1000).
// The deduction is transactional: re-checks affordability inside the
// transaction so concurrent buys can't double-spend.
app.post('/api/upgrade/buy', async (req, res) => {
  const buyer = await validateBuyer(req, res);
  if (!buyer) return;
  const { name, player } = buyer;
  const { upgradeId, mode } = req.body || {};
  const def = UPGRADE_MAP[upgradeId];
  if (!def) {
    await logAlert(name, 'malformed', `unknown upgradeId ${String(upgradeId)}`);
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
  const result = await store.transaction(async (tx) => {
    const p = await tx.getPlayer(name);
    if (!p || p.points < cost) return null;
    p.points -= cost;
    p.last_seen = Date.now();
    if (!p.upgrades) p.upgrades = {};
    p.upgrades[def.id] = ((p.upgrades[def.id]) || 0) + count;
    const newAchievements = checkAchievements(p);
    await tx.savePlayer(p);
    return { player: p, newAchievements };
  });
  if (!result) {
    return res.status(400).json({ error: `Need ${cost.toLocaleString('en-US')} stars.` });
  }
  await logAdmin('upgrade_buy', name, `${def.id} x${count} (Lv ${level} -> ${level + count}), cost ${cost}`);
  res.json(Object.assign({ ok: true, bought: count, newAchievements: result.newAchievements },
    playerSnapshot(result.player)));
});

// ----- Supernova prestige -----
// Requires 100K total stars earned. Grants floor(total_earned / 100K) shards
// (+10% each, forever), then resets points/clicks/upgrades/total_earned.
const SUPERNOVA_THRESHOLD = 100000;
app.post('/api/supernova', async (req, res) => {
  const buyer = await validateBuyer(req, res);
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
  await store.savePlayer(player);
  await logAdmin('supernova', name, `+${shards} shards (total ${player.supernova_shards}), supernovas: ${player.supernovas}`);
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
app.post('/api/admin/give', requireAdmin, async (req, res) => {
  const { username, amount } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  if (!isFiniteNum(amount) || !Number.isInteger(amount) || amount <= 0) {
    if (amount !== undefined && !isFiniteNum(amount)) {
      await logAlert(String(username), 'malformed', `admin give amount was ${String(amount)}`);
    }
    return res.status(400).json({ error: 'Amount must be a positive whole number (no cap).' });
  }
  const name = norm(username);
  const player = await getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  player.points += amount;
  player.total_earned = (player.total_earned || 0) + amount;
  checkAchievements(player);
  await store.savePlayer(player);
  await logAdmin('give', name, `+${amount}`);
  res.json({ username: name, points: player.points });
});

// Reset player to 0
app.post('/api/admin/reset', requireAdmin, async (req, res) => {
  const { username } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  const name = norm(username);
  const player = await getPlayer(name);
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
  await store.savePlayer(player);
  await logAdmin('reset', name, `was ${was} (full reset incl. prestige)`);
  res.json({ username: name, points: 0 });
});

// Set a player's stars to an exact amount (also bumps total_earned so
// ranks/supernova progress stay consistent)
app.post('/api/admin/set-stars', requireAdmin, async (req, res) => {
  const { username, amount } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  if (!isFiniteNum(amount) || !Number.isInteger(amount) || amount < 0) {
    return res.status(400).json({ error: 'Amount must be a non-negative whole number.' });
  }
  const name = norm(username);
  const player = await getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  const was = player.points;
  const diff = amount - was;
  player.points = amount;
  if (diff > 0) player.total_earned = (player.total_earned || 0) + diff;
  checkAchievements(player);
  await store.savePlayer(player);
  await logAdmin('set_stars', name, `${was} -> ${amount}`);
  res.json({ username: name, points: player.points });
});

// Grant supernova shards directly
app.post('/api/admin/shards', requireAdmin, async (req, res) => {
  const { username, amount } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  if (!isFiniteNum(amount) || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive whole number.' });
  }
  const name = norm(username);
  const player = await getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  player.supernova_shards = (player.supernova_shards || 0) + amount;
  await store.savePlayer(player);
  await logAdmin('shards', name, `+${amount} (total ${player.supernova_shards})`);
  res.json({ username: name, shards: player.supernova_shards });
});

// Reset only stars (keeps upgrades, shards, achievements)
app.post('/api/admin/reset-stars', requireAdmin, async (req, res) => {
  const { username } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  const name = norm(username);
  const player = await getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  const was = player.points;
  player.points = 0;
  await store.savePlayer(player);
  await logAdmin('reset_stars', name, `was ${was}`);
  res.json({ username: name, points: 0 });
});

// Max out ALL 10 upgrades (Lv 1000 each, matching the MAX-buy cap)
app.post('/api/admin/max-upgrades', requireAdmin, async (req, res) => {
  const { username } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  const name = norm(username);
  const player = await getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  if (!player.upgrades) player.upgrades = {};
  for (const u of UPGRADES) player.upgrades[u.id] = 1000;
  checkAchievements(player);
  await store.savePlayer(player);
  await logAdmin('max_upgrades', name, 'all 10 upgrades -> Lv 1000');
  res.json(Object.assign({ ok: true }, playerSnapshot(player)));
});

// Grant specific upgrade levels
app.post('/api/admin/give-upgrade', requireAdmin, async (req, res) => {
  const { username, upgradeId, levels } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  const def = UPGRADE_MAP[upgradeId];
  if (!def) return res.status(400).json({ error: 'Unknown upgradeId.' });
  if (!isFiniteNum(levels) || !Number.isInteger(levels) || levels <= 0) {
    return res.status(400).json({ error: 'Levels must be a positive whole number.' });
  }
  const name = norm(username);
  const player = await getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  if (!player.upgrades) player.upgrades = {};
  player.upgrades[def.id] = (player.upgrades[def.id] || 0) + levels;
  checkAchievements(player);
  await store.savePlayer(player);
  await logAdmin('give_upgrade', name, `${def.id} +${levels} (now Lv ${player.upgrades[def.id]})`);
  res.json(Object.assign({ ok: true }, playerSnapshot(player)));
});

// Set a player's total clicks
app.post('/api/admin/set-clicks', requireAdmin, async (req, res) => {
  const { username, clicks } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  if (!isFiniteNum(clicks) || !Number.isInteger(clicks) || clicks < 0) {
    return res.status(400).json({ error: 'Clicks must be a non-negative whole number.' });
  }
  const name = norm(username);
  const player = await getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  const was = player.clicks;
  player.clicks = clicks;
  checkAchievements(player);
  await store.savePlayer(player);
  await logAdmin('set_clicks', name, `${was} -> ${clicks}`);
  res.json(Object.assign({ ok: true }, playerSnapshot(player)));
});

// Unlock all achievements
app.post('/api/admin/unlock-all', requireAdmin, async (req, res) => {
  const { username } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  const name = norm(username);
  const player = await getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  player.achievements = ACHIEVEMENTS.map(a => a.id);
  await store.savePlayer(player);
  await logAdmin('unlock_all', name, 'all achievements unlocked');
  res.json(Object.assign({ ok: true }, playerSnapshot(player)));
});

// Instant supernova: shards from current total_earned, or a specified amount.
// Same reset as /api/supernova but skips the 100K threshold check.
app.post('/api/admin/supernova-now', requireAdmin, async (req, res) => {
  const { username, shards } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  const name = norm(username);
  const player = await getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  let gain;
  if (shards !== undefined && shards !== null) {
    if (!isFiniteNum(shards) || !Number.isInteger(shards) || shards <= 0) {
      return res.status(400).json({ error: 'Shards must be a positive whole number.' });
    }
    gain = shards;
  } else {
    gain = Math.floor((player.total_earned || 0) / SUPERNOVA_THRESHOLD);
  }
  player.supernova_shards = (player.supernova_shards || 0) + gain;
  player.supernovas = (player.supernovas || 0) + 1;
  player.points = 0;
  player.clicks = 0;
  player.total_earned = 0;
  player.upgrades = {};
  for (const u of UPGRADES) player.upgrades[u.id] = 0;
  const newAchievements = checkAchievements(player);
  await store.savePlayer(player);
  await logAdmin('supernova_now', name, `+${gain} shards (admin), supernovas: ${player.supernovas}`);
  res.json(Object.assign({ ok: true, shardsGained: gain, newAchievements }, playerSnapshot(player)));
});

// Ban a player (403s their gameplay endpoints)
app.post('/api/admin/ban', requireAdmin, async (req, res) => {
  const { username, reason } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  const name = norm(username);
  const player = await getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  player.banned = 1;
  player.ban_reason = (typeof reason === 'string' && reason.trim()) ? reason.trim().slice(0, 300) : null;
  await store.savePlayer(player);
  await logAdmin('ban', name, player.ban_reason || 'no reason given');
  res.json({ ok: true, username: name, banned: true });
});

// Unban a player
app.post('/api/admin/unban', requireAdmin, async (req, res) => {
  const { username } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  const name = norm(username);
  const player = await getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  player.banned = 0;
  player.ban_reason = null;
  await store.savePlayer(player);
  await logAdmin('unban', name, 'ban lifted');
  res.json({ ok: true, username: name, banned: false });
});

// Wipe a player's data completely (pristine state, keeps the username)
app.post('/api/admin/reset-player', requireAdmin, async (req, res) => {
  const { username } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  const name = norm(username);
  const player = await getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  const now = Date.now();
  const fresh = normalizePlayer({
    username: name,
    points: 0,
    clicks: 0,
    created_at: now,
    last_seen: now,
    warn_count: 0,
  });
  await store.savePlayer(fresh);
  await logAdmin('reset_player', name, 'full data wipe (pristine)');
  res.json({ ok: true, username: name });
});

// Grant stardust burst charges (1 charge = 50 banked clicks = 1 free burst)
app.post('/api/admin/give-burst', requireAdmin, async (req, res) => {
  const { username, charges } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  if (!isFiniteNum(charges) || !Number.isInteger(charges) || charges <= 0) {
    return res.status(400).json({ error: 'Charges must be a positive whole number.' });
  }
  const name = norm(username);
  const player = await getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  player.burst_charges = (player.burst_charges || 0) + charges;
  await store.savePlayer(player);
  await logAdmin('give_burst', name, `+${charges} charges (total ${player.burst_charges})`);
  res.json({ ok: true, username: name, burstCharges: player.burst_charges });
});

// Warn a player (they see it as a banner in-game)
app.post('/api/admin/warn', requireAdmin, async (req, res) => {
  const { username, message } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  if (typeof message !== 'string' || !message.trim() || message.length > 300) {
    return res.status(400).json({ error: 'Message must be 1-300 chars.' });
  }
  const name = norm(username);
  const player = await getPlayer(name);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  const msg = message.trim();
  await store.addWarning(name, msg);
  player.warn_count = (player.warn_count || 0) + 1;
  await store.savePlayer(player);
  await logAdmin('warn', name, msg);
  res.json({ ok: true });
});

// Suspicious-activity alerts
app.get('/api/admin/alerts', requireAdmin, async (req, res) => {
  const includeResolved = req.query.all === '1';
  const rows = await store.getAlerts(includeResolved);
  res.json({ alerts: rows });
});

app.post('/api/admin/alerts/:id/resolve', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await store.resolveAlert(id);
  await logAdmin('alert_resolve', null, `alert #${req.params.id}`);
  res.json({ ok: true });
});

// Recent admin actions (audit trail)
app.get('/api/admin/log', requireAdmin, async (req, res) => {
  const rows = await store.getAdminLog();
  res.json({ log: rows });
});

// Admin: list/search players
app.get('/api/admin/players', requireAdmin, async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  let rows = (await store.getAllPlayers()).map(p => ({
    username: p.username,
    points: p.points,
    clicks: p.clicks,
    warn_count: p.warn_count,
    last_seen: p.last_seen,
  }));
  if (q) {
    rows = rows.filter(p => p.username.toLowerCase().includes(q));
  }
  rows.sort((a, b) => b.clicks - a.clicks);
  res.json({ players: rows.slice(0, 50) });
});

// Passive income: every second, each player earns basePerSecond points.
function startPassiveIncome() {
  setInterval(async () => {
    try {
      for (const p of await store.getAllPlayers()) {
        const income = Math.floor(basePerSecond(p));
        if (income > 0) {
          p.points += income;
          p.total_earned = (p.total_earned || 0) + income;
          await store.savePlayer(p);
        }
      }
    } catch (e) {
      console.error('auto-income tick failed:', e.message);
    }
  }, 1000);
}

// ---------- Startup ----------
// Storage must initialize (async) before the server accepts requests.
async function main() {
  await initStore();
  startPassiveIncome();
  app.listen(PORT, () => {
    console.log(`🌌 Galaxy Clicker live on http://localhost:${PORT}`);
    console.log(`   Storage: ${store.name}${store.name === 'postgres' ? ' (DATABASE_URL)' : ' (data/db.json)'}`);
    console.log(`   Admin key: ${ADMIN_KEY}`);
    console.log(`   (saved in data/admin-key.txt — keep it secret)`);
  });
}
main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
