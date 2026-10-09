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
