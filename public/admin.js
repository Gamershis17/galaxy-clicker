/* Galaxy Clicker — admin panel (mobile-first, 48px+ tap targets) */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const keyGate = $('key-gate'), panel = $('panel');
  const keyInput = $('key-input'), keyError = $('key-error');
  const searchInput = $('search-input'), playerCard = $('player-card');
  const alertsEl = $('alerts'), alertCount = $('alert-count');

  let ADMIN_KEY = localStorage.getItem('gc_admin_key') || '';
  let showResolved = false;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  async function admin(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    }, opts || {}));
    const data = await res.json().catch(() => ({}));
    if (res.status === 403) {
      localStorage.removeItem('gc_admin_key');
      ADMIN_KEY = '';
      keyGate.classList.remove('hidden');
      panel.classList.add('hidden');
      throw new Error('Wrong key. Try again.');
    }
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  // ---------- unlock ----------
  $('unlock-btn').addEventListener('click', async () => {
    const k = keyInput.value.trim();
    if (!k) return;
    keyError.classList.add('hidden');
    ADMIN_KEY = k;
    try {
      await admin('/api/admin/alerts');
      localStorage.setItem('gc_admin_key', k);
      keyGate.classList.add('hidden');
      panel.classList.remove('hidden');
      loadAlerts();
      loadLog();
    } catch (e) {
      keyError.textContent = e.message;
      keyError.classList.remove('hidden');
    }
  });
  keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('unlock-btn').click(); });

  // ---------- player search + actions ----------
  async function findPlayer() {
    const name = searchInput.value.trim();
    if (!name) return;
    playerCard.classList.remove('hidden');
    playerCard.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const p = await admin('/api/player/' + encodeURIComponent(name));
      renderPlayer(p);
    } catch (e) {
      playerCard.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }
  $('search-btn').addEventListener('click', findPlayer);
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') findPlayer(); });

  function renderPlayer(p) {
    playerCard.innerHTML = `
      <div class="p-name">${esc(p.username)}</div>
      <div class="p-stats">
        <span>⭐ <b>${fmt(p.points)}</b> stars</span>
        <span>🌌 <b>${fmt(p.totalEarned || 0)}</b> earned</span>
        <span>👆 <b>${fmt(p.clicks)}</b> clicks</span>
        <span>💠 <b>${fmt(p.supernovaShards || 0)}</b> shards</span>
        <span>💥 <b>${fmt(p.supernovas || 0)}</b> novas</span>
        <span>🏅 <b>${esc(p.rank || '')}</b></span>
        <span>⚠️ <b>${p.warnings}</b> warns</span>
      </div>
      <div class="admin-actions">
        <label>Give stars (no cap)</label>
        <div class="action-row">
          <input id="give-amt" type="number" min="1" step="1" placeholder="amount" inputmode="numeric">
          <button id="give-btn" type="button">Give</button>
        </div>
        <label>Set stars (exact)</label>
        <div class="action-row">
          <input id="set-amt" type="number" min="0" step="1" placeholder="amount" inputmode="numeric">
          <button id="set-btn" class="btn-ghost" type="button">Set</button>
        </div>
        <label>Give supernova shards</label>
        <div class="action-row">
          <input id="shard-amt" type="number" min="1" step="1" placeholder="shards" inputmode="numeric">
          <button id="shard-btn" class="btn-ghost" type="button">Give shards</button>
        </div>
        <label>Warn player</label>
        <div class="action-row">
          <input id="warn-msg" type="text" maxlength="300" placeholder="warning message">
          <button id="warn-btn" class="btn-warn" type="button">Warn</button>
        </div>
        <button id="reset-btn" class="btn-danger" type="button">Full reset (wipes everything)</button>
      </div>
      <div class="power-section">
        <h3>⚡ Powerful Commands</h3>
        <div class="admin-actions">
          <div class="action-row">
            <button id="maxup-btn" type="button" style="flex:1">Max all upgrades (Lv 1000)</button>
          </div>
          <label>Give upgrade levels</label>
          <div class="action-row">
            <select id="upg-id">
              <option value="stellar_gloves">✦ Stellar Gloves</option>
              <option value="nebula_collector">◐ Nebula Collector</option>
              <option value="comet_miner">☄ Comet Miner</option>
              <option value="quantum_fingers">✣ Quantum Fingers</option>
              <option value="pulsar_engine">◎ Pulsar Engine</option>
              <option value="star_forge">⬢ Star Forge</option>
              <option value="supernova_core">⬣ Supernova Core</option>
              <option value="void_tap">✧ Void Tap</option>
              <option value="black_hole">● Black Hole Harvester</option>
              <option value="galaxy_swarm">✹ Galaxy Swarm</option>
            </select>
          </div>
          <div class="action-row">
            <input id="upg-lvls" type="number" min="1" step="1" placeholder="levels" inputmode="numeric">
            <button id="upg-btn" class="btn-ghost" type="button">Give upgrade</button>
          </div>
          <label>Set total clicks</label>
          <div class="action-row">
            <input id="clicks-amt" type="number" min="0" step="1" placeholder="clicks" inputmode="numeric">
            <button id="clicks-btn" class="btn-ghost" type="button">Set clicks</button>
          </div>
          <div class="action-row">
            <button id="unlock-btn2" class="btn-ghost" type="button" style="flex:1">Unlock all achievements</button>
          </div>
          <label>Instant supernova (optional shards)</label>
          <div class="action-row">
            <input id="nova-shards" type="number" min="1" step="1" placeholder="shards (blank = auto)" inputmode="numeric">
            <button id="nova-btn" class="btn-warn" type="button">Supernova now</button>
          </div>
          <label>Give stardust burst charges</label>
          <div class="action-row">
            <input id="burst-amt" type="number" min="1" step="1" placeholder="charges" inputmode="numeric">
            <button id="burst-btn" class="btn-ghost" type="button">Give burst</button>
          </div>
          <label>Ban player (reason optional)</label>
          <div class="action-row">
            <input id="ban-reason" type="text" maxlength="300" placeholder="reason">
            <button id="ban-btn" class="btn-danger" type="button">Ban</button>
          </div>
          <div class="action-row">
            <button id="unban-btn" class="btn-ghost" type="button" style="flex:1">Unban player</button>
          </div>
        </div>
      </div>`;
    const uname = p.username;

    $('give-btn').addEventListener('click', async () => {
      const amt = parseInt($('give-amt').value, 10);
      if (!amt || amt <= 0) { alert('Enter a positive amount.'); return; }
      try {
        const r = await admin('/api/admin/give', {
          method: 'POST', body: JSON.stringify({ username: uname, amount: amt }),
        });
        alert(`Gave ${fmt(amt)} to ${uname}. New total: ${fmt(r.points)}`);
        findPlayer();
      } catch (e) { alert(e.message); }
    });

    $('warn-btn').addEventListener('click', async () => {
      const msg = $('warn-msg').value.trim();
      if (!msg) { alert('Type a warning message.'); return; }
      try {
        await admin('/api/admin/warn', {
          method: 'POST', body: JSON.stringify({ username: uname, message: msg }),
        });
        alert(`Warned ${uname}.`);
        $('warn-msg').value = '';
        findPlayer();
      } catch (e) { alert(e.message); }
    });

    $('reset-btn').addEventListener('click', async () => {
      if (!confirm(`Full reset ${uname}? Wipes stars, upgrades, shards, achievements. Cannot be undone.`)) return;
      try {
        await admin('/api/admin/reset', {
          method: 'POST', body: JSON.stringify({ username: uname }),
        });
        alert(`${uname} fully reset.`);
        findPlayer();
      } catch (e) { alert(e.message); }
    });

    $('set-btn').addEventListener('click', async () => {
      const amt = parseInt($('set-amt').value, 10);
      if (amt == null || amt < 0 || !Number.isInteger(amt)) { alert('Enter a non-negative whole number.'); return; }
      try {
        const r = await admin('/api/admin/set-stars', {
          method: 'POST', body: JSON.stringify({ username: uname, amount: amt }),
        });
        alert(`Set ${uname} to ${fmt(r.points)} stars.`);
        findPlayer();
      } catch (e) { alert(e.message); }
    });

    $('shard-btn').addEventListener('click', async () => {
      const amt = parseInt($('shard-amt').value, 10);
      if (!amt || amt <= 0) { alert('Enter a positive number of shards.'); return; }
      try {
        const r = await admin('/api/admin/shards', {
          method: 'POST', body: JSON.stringify({ username: uname, amount: amt }),
        });
        alert(`Gave ${fmt(amt)} shards to ${uname}. Total: ${fmt(r.shards)}`);
        findPlayer();
      } catch (e) { alert(e.message); }
    });

    // ---------- powerful commands ----------
    $('maxup-btn').addEventListener('click', async () => {
      if (!confirm(`Max ALL 10 upgrades to Lv 1000 for ${uname}?`)) return;
      try {
        await admin('/api/admin/max-upgrades', {
          method: 'POST', body: JSON.stringify({ username: uname }),
        });
        alert(`${uname}: all upgrades maxed to Lv 1000.`);
        findPlayer();
      } catch (e) { alert(e.message); }
    });

    $('upg-btn').addEventListener('click', async () => {
      const upgradeId = $('upg-id').value;
      const levels = parseInt($('upg-lvls').value, 10);
      if (!levels || levels <= 0) { alert('Enter a positive number of levels.'); return; }
      try {
        await admin('/api/admin/give-upgrade', {
          method: 'POST', body: JSON.stringify({ username: uname, upgradeId, levels }),
        });
        alert(`Gave ${fmt(levels)} levels of ${upgradeId} to ${uname}.`);
        findPlayer();
      } catch (e) { alert(e.message); }
    });

    $('clicks-btn').addEventListener('click', async () => {
      const clicks = parseInt($('clicks-amt').value, 10);
      if (clicks == null || clicks < 0 || !Number.isInteger(clicks)) {
        alert('Enter a non-negative whole number.'); return;
      }
      try {
        const r = await admin('/api/admin/set-clicks', {
          method: 'POST', body: JSON.stringify({ username: uname, clicks }),
        });
        alert(`Set ${uname} to ${fmt(r.clicks)} clicks.`);
        findPlayer();
      } catch (e) { alert(e.message); }
    });

    $('unlock-btn2').addEventListener('click', async () => {
      try {
        await admin('/api/admin/unlock-all', {
          method: 'POST', body: JSON.stringify({ username: uname }),
        });
        alert(`${uname}: all 8 achievements unlocked.`);
        findPlayer();
      } catch (e) { alert(e.message); }
    });

    $('nova-btn').addEventListener('click', async () => {
      const shardsRaw = $('nova-shards').value.trim();
      const shards = shardsRaw ? parseInt(shardsRaw, 10) : undefined;
      if (shardsRaw && (!shards || shards <= 0)) { alert('Enter a positive shard count or leave blank.'); return; }
      if (!confirm(`Instant supernova for ${uname}? Resets stars/upgrades, grants shards.`)) return;
      try {
        const body = { username: uname };
        if (shards) body.shards = shards;
        const r = await admin('/api/admin/supernova-now', {
          method: 'POST', body: JSON.stringify(body),
        });
        alert(`${uname} went supernova! Shards gained: ${fmt(r.shardsGained || 0)}`);
        findPlayer();
      } catch (e) { alert(e.message); }
    });

    $('burst-btn').addEventListener('click', async () => {
      const charges = parseInt($('burst-amt').value, 10);
      if (!charges || charges <= 0) { alert('Enter a positive number of charges.'); return; }
      try {
        const r = await admin('/api/admin/give-burst', {
          method: 'POST', body: JSON.stringify({ username: uname, charges }),
        });
        alert(`Gave ${fmt(charges)} burst charges to ${uname}. Total: ${fmt(r.burstCharges)}`);
        findPlayer();
      } catch (e) { alert(e.message); }
    });

    $('ban-btn').addEventListener('click', async () => {
      const reason = $('ban-reason').value.trim();
      if (!confirm(`BAN ${uname}? They will be locked out of the game.${reason ? '\nReason: ' + reason : ''}`)) return;
      try {
        await admin('/api/admin/ban', {
          method: 'POST', body: JSON.stringify({ username: uname, reason }),
        });
        alert(`${uname} banned.`);
        findPlayer();
      } catch (e) { alert(e.message); }
    });

    $('unban-btn').addEventListener('click', async () => {
      try {
        await admin('/api/admin/unban', {
          method: 'POST', body: JSON.stringify({ username: uname }),
        });
        alert(`${uname} unbanned.`);
        findPlayer();
      } catch (e) { alert(e.message); }
    });
  }

  // ---------- alerts ----------
  async function loadAlerts() {
    alertsEl.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const data = await admin('/api/admin/alerts' + (showResolved ? '?all=1' : ''));
      const list = data.alerts;
      const open = list.filter(a => !a.resolved).length;
      alertCount.textContent = open ? `(${open} open)` : '(all clear)';
      if (!list.length) {
        alertsEl.innerHTML = '<p class="muted">No alerts. 🎉</p>';
        return;
      }
      alertsEl.innerHTML = '';
      for (const a of list) {
        const div = document.createElement('div');
        div.className = 'alert-item';
        if (a.resolved) div.style.opacity = '0.55';
        div.innerHTML = `
          <div class="a-head">
            <span class="a-user">${esc(a.username || '—')}</span>
            <span class="a-type">${esc(a.type)}</span>
          </div>
          <div class="a-detail">${esc(a.detail || '')}</div>
          <div class="a-time">${timeAgo(a.created_at)}${a.resolved ? ' · resolved' : ''}</div>
          <div class="a-btns">
            ${a.username && !a.resolved ? `
              <button class="btn-danger" data-act="reset" type="button">Reset to 0</button>
              <button class="btn-warn" data-act="warn" type="button">Warn</button>
              <button class="btn-ghost" data-act="resolve" type="button">Dismiss</button>
            ` : a.resolved ? '' : `
              <button class="btn-ghost" data-act="resolve" type="button">Dismiss</button>
            `}
          </div>`;
        div.querySelectorAll('button').forEach((btn) => {
          btn.addEventListener('click', () => alertAction(a, btn.dataset.act));
        });
        alertsEl.appendChild(div);
      }
    } catch (e) {
      alertsEl.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }

  async function alertAction(a, act) {
    try {
      if (act === 'resolve') {
        await admin(`/api/admin/alerts/${a.id}/resolve`, { method: 'POST' });
      } else if (act === 'reset') {
        if (!confirm(`Reset ${a.username} to 0 points?`)) return;
        await admin('/api/admin/reset', {
          method: 'POST', body: JSON.stringify({ username: a.username }),
        });
        await admin(`/api/admin/alerts/${a.id}/resolve`, { method: 'POST' });
      } else if (act === 'warn') {
        const msg = prompt(`Warning message for ${a.username}:`, 'Suspicious activity detected. Play fair!');
        if (!msg) return;
        await admin('/api/admin/warn', {
          method: 'POST', body: JSON.stringify({ username: a.username, message: msg }),
        });
        await admin(`/api/admin/alerts/${a.id}/resolve`, { method: 'POST' });
      }
      loadAlerts();
    } catch (e) { alert(e.message); }
  }

  $('refresh-alerts').addEventListener('click', loadAlerts);
  $('toggle-resolved').addEventListener('click', () => {
    showResolved = !showResolved;
    $('toggle-resolved').textContent = showResolved ? 'Hide resolved' : 'Show resolved';
    loadAlerts();
  });

  // ---------- audit log ----------
  async function loadLog() {
    try {
      const data = await admin('/api/admin/log');
      const el = $('admin-log');
      if (!data.log.length) { el.textContent = 'Nothing yet.'; return; }
      el.innerHTML = data.log.slice(0, 20).map(l =>
        `<div style="padding:8px 0;border-bottom:1px solid rgba(130,120,255,.15)">
           <b>${esc(l.action)}</b>${l.username ? ' → ' + esc(l.username) : ''}
           <span class="muted">${esc(l.detail || '')} · ${timeAgo(l.created_at)}</span>
         </div>`
      ).join('');
    } catch (e) { /* ignore */ }
  }

  // ---------- boot ----------
  if (ADMIN_KEY) {
    keyInput.value = ADMIN_KEY;
    $('unlock-btn').click();
  } else {
    keyInput.focus();
  }
  setInterval(() => { if (ADMIN_KEY && !panel.classList.contains('hidden')) loadAlerts(); }, 30000);
})();
