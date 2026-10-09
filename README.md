# 🌌 Galaxy Clicker

A web-based clicker game with a galaxy theme, leaderboards, and admin cheat detection.

## Quick start

```bash
cd ~/workspace/your_files/galaxy-clicker
npm install   # only needed once
node server.js
```

Then open **http://localhost:3000** in your browser (works on your phone too — same Wi-Fi, use your computer's IP).

## How it works

- **No accounts.** Players pick a username (1–24 chars). First come, first served.
- **No point cap.** Clicks add 1 point each, forever.
- **Google sign-in:** the button is on the login screen as a hook — wire up Google Identity Services in `public/game.js` (`$('google-btn')` listener) when ready.
- **Auto-clickers are allowed.** The server rate-limits at ~30 clicks/sec with burst headroom; floods just get a "slow down" message, never a ban.
- **Score faking is blocked.** The client never sends a score — every click is a server request, and the server computes the total.

## Admin

**Admin panel:** http://localhost:3000/admin.html (mobile-friendly, big tap targets)

**Your admin key:** on first run the server prints it and saves it to `data/admin-key.txt`. Keep it secret. You can also set it via the `ADMIN_KEY` environment variable.

**What you can do:**
- 🔍 Search any player by username → see points, clicks, rank, warnings
- ⭐ Give points (any amount, no cap)
- 🗑️ Reset a player to 0 (asks for confirmation)
- ⚠️ Warn a player (they see it as a banner in the game)
- 🚨 View cheat alerts with the username attached — then warn or reset right from the alert

**Cheat detection** (auto-clickers are fine, these are the real cheats):
| Alert type | Meaning |
|---|---|
| `score_mismatch` | Client claimed a score far from the server's truth — possible tampering |
| `inhuman_rate` | Sustained >45 clicks/sec over 10s — beyond any auto-clicker |
| `malformed` | NaN/Infinity/negative values sent — someone poking at the API |

Alerts are throttled (1 per player per type per 5 min) so your panel doesn't flood. When you warn or reset from an alert, it auto-marks the alert resolved.

**Audit trail:** every admin action (give/reset/warn) is logged — see "Recent admin actions" at the bottom of the panel, or `GET /api/admin/log`.

## API reference

| Method & path | Auth | Body | What it does |
|---|---|---|---|
| `POST /api/register` | — | `{username}` | Claim a username |
| `POST /api/click` | — | `{username, clientScore?}` | +1 point, server-validated |
| `GET /api/leaderboard` | — | — | Top 100 |
| `GET /api/player/:username` | — | — | Stats + rank |
| `POST /api/admin/give` | key | `{username, amount}` | Add points, no cap |
| `POST /api/admin/reset` | key | `{username}` | Points → 0 |
| `POST /api/admin/warn` | key | `{username, message}` | In-game warning banner |
| `GET /api/admin/alerts` | key | — | Cheat alerts (`?all=1` incl. resolved) |
| `POST /api/admin/alerts/:id/resolve` | key | — | Dismiss an alert |
| `GET /api/admin/players?q=` | key | — | Search players |
| `GET /api/admin/log` | key | — | Admin action audit trail |

Admin key goes in the `x-admin-key` header.

## Config (env vars)

| Var | Default | What |
|---|---|---|
| `PORT` | `3000` | Server port |
| `ADMIN_KEY` | generated | Your admin key (else saved to `data/admin-key.txt`) |
| `RESERVED_USERNAMES` | `cody,admin,galaxyclicker,system` | Usernames nobody can register |

## Data

SQLite database at `data/galaxy-clicker.db` (WAL mode). Back it up by copying the file while the server is stopped.
