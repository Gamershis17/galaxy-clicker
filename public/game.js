/* Galaxy Clicker — frontend */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const gate = $('gate'), game = $('game');
  const usernameInput = $('username-input'), playBtn = $('play-btn'), gateError = $('gate-error');
  const clicker = $('clicker'), pointsEl = $('points'), rankLine = $('rank-line');
  const board = $('leaderboard'), warnBanner = $('warn-banner');
  const userChip = $('user-chip'), userChipName = $('user-chip-name');

  let username = localStorage.getItem('gc_username') || null;
  let points = 0;
  let clicking = false;
  let perClick = 1, perSecond = 0;

  // ---------- animated starfield ----------
  const canvas = $('stars'), ctx = canvas.getContext('2d');
  let stars = [];
  function sizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    stars = Array.from({ length: Math.min(220, window.innerWidth * window.innerHeight / 6000) }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.6 + 0.3,
      tw: Math.random() * Math.PI * 2,
      sp: 0.5 + Math.random() * 1.5,
    }));
  }
  sizeCanvas();
  window.addEventListener('resize', sizeCanvas);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function drawStars(t) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of stars) {
      const a = reducedMotion ? 0.8 : 0.35 + 0.65 * Math.abs(Math.sin(t / 900 * s.sp + s.tw));
      ctx.globalAlpha = a;
      ctx.fillStyle = '#dfe6ff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (!reducedMotion) requestAnimationFrame(drawStars);
  }
  requestAnimationFrame(drawStars);

  // occasional shooting star
  if (!reducedMotion) {
    setInterval(() => {
      if (document.hidden || Math.random() < 0.45) return;
      const x0 = Math.random() * canvas.width * 0.7;
      const y0 = Math.random() * canvas.height * 0.35;
      const el = document.createElement('div');
      el.className = 'shooting-star';
      el.style.cssText = `position:fixed;z-index:1;left:${x0}px;top:${y0}px;width:120px;height:2px;` +
        `background:linear-gradient(90deg,#fff,transparent);transform:rotate(-25deg);` +
        `animation:shoot 0.7s ease-out forwards;pointer-events:none;`;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 750);
    }, 6000);
  }
  const style = document.createElement('style');
  style.textContent = '@keyframes shoot{from{opacity:1;transform:rotate(-25deg) translateX(0)}to{opacity:0;transform:rotate(-25deg) translateX(-260px)}}';
  document.head.appendChild(style);

  // ---------- helpers ----------
  async function api(path, opts) {
    const res = await fetch(path, Object.assign(
      { headers: { 'Content-Type': 'application/json' } }, opts || {}));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }
  function fmt(n) { return n.toLocaleString('en-US'); }

  function showWarnings(warnings) {
    if (!warnings || !warnings.length) return;
    warnBanner.textContent = '⚠️ Admin warning: ' + warnings.map(w => w.message).join(' | ');
    warnBanner.classList.remove('hidden');
  }

  // ---------- username gate ----------
  async function enterAs(name) {
    gateError.classList.add('hidden');
    try {
      const data = await api('/api/register', {
        method: 'POST', body: JSON.stringify({ username: name }),
      });
      username = data.username;
      points = data.points;
      localStorage.setItem('gc_username', username);
      showGame();
    } catch (e) {
      // 409 = taken: if it's OUR saved name, just load it
      if (e.message.includes('taken') && localStorage.getItem('gc_username') === name) {
        username = name;
        showGame();
        refreshMe();
        return;
      }
      gateError.textContent = e.message;
      gateError.classList.remove('hidden');
    }
  }

  playBtn.addEventListener('click', () => {
    const name = usernameInput.value.trim();
    if (!name) { gateError.textContent = 'Type a username first.'; gateError.classList.remove('hidden'); return; }
    enterAs(name);
  });
  usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') playBtn.click(); });

  $('change-name').addEventListener('click', () => {
    localStorage.removeItem('gc_username');
    username = null;
    game.classList.add('hidden');
    userChip.classList.add('hidden');
    gate.classList.remove('hidden');
    usernameInput.value = '';
    usernameInput.focus();
  });

  // Google sign-in hook — wire Google Identity Services here later.
  $('google-btn').addEventListener('click', () => {
    gateError.textContent = 'Google sign-in is coming soon. Pick a username to play now.';
    gateError.classList.remove('hidden');
  });

  function showGame() {
    gate.classList.add('hidden');
    game.classList.remove('hidden');
    userChip.classList.remove('hidden');
    userChipName.textContent = username;
    pointsEl.textContent = fmt(points);
    refreshBoard();
    refreshMe();
  }

  // ---------- clicking ----------
  function floatPlus(x, y, amount) {
    const el = document.createElement('div');
    el.className = 'float-plus';
    el.textContent = '+' + fmt(amount);
    el.style.left = (x - 10 + (Math.random() * 30 - 15)) + 'px';
    el.style.top = (y - 10) + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 850);
  }

  clicker.addEventListener('pointerdown', (e) => {
    if (!username || clicking) return;
    clicking = true;
    api('/api/click', { method: 'POST', body: JSON.stringify({ username, clientScore: points }) })
      .then((data) => {
        points = data.points;
        if (data.perClick) perClick = data.perClick;
        pointsEl.textContent = fmt(points);
        floatPlus(e.clientX, e.clientY, data.perClick || 1);
        showWarnings(data.warnings);
      })
      .catch((err) => {
        if (err.message.includes('slow down')) {
          $('click-hint').textContent = 'Whoa, easy! Catching up…';
          setTimeout(() => { $('click-hint').textContent = 'Tap the planet!'; }, 1500);
        } else if (err.message.includes('Register')) {
          localStorage.removeItem('gc_username');
          location.reload();
        }
      })
      .finally(() => { clicking = false; });
  });

  // ---------- leaderboard + self ----------
  async function refreshBoard() {
    try {
      const data = await api('/api/leaderboard');
      board.innerHTML = '';
      data.leaders.slice(0, 20).forEach((p, i) => {
        const li = document.createElement('li');
        if (p.username === username) li.className = 'me';
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '.';
        li.innerHTML = `<span>${medal} ${escapeHtml(p.username)}</span><span class="pts">${fmt(p.points)}</span>`;
        board.appendChild(li);
      });
      if (!data.leaders.length) board.innerHTML = '<li class="muted">No clickers yet. Be the first!</li>';
    } catch (e) { /* offline? try later */ }
  }

  async function refreshMe() {
    if (!username) return;
    try {
      const p = await api('/api/player/' + encodeURIComponent(username));
      points = p.points;
      pointsEl.textContent = fmt(points);
      rankLine.textContent = p.rank ? `Rank #${p.rank} · ${fmt(p.clicks)} clicks` : '';
      if (p.perClick) perClick = p.perClick;
      if (typeof p.perSecond === 'number') perSecond = p.perSecond;
      renderUpgrades(p);
    } catch (e) { /* ignore */ }
  }

  // ---------- upgrades ----------
  function renderUpgrades(p) {
    const upgErr = $('upg-error');
    upgErr.classList.add('hidden');
    $('rates').innerHTML = `<b>+${fmt(p.perClick || 1)}</b> per click · <b>+${fmt(p.perSecond || 0)}</b>/sec`;

    // Click Power
    $('upg-click-lvl').textContent = 'Lv ' + p.clickPower;
    $('upg-click-desc').textContent = `+${fmt(p.perClick)} per click → Lv ${p.clickPower + 1} = +${fmt((p.clickPower + 1) * p.multiplier)}`;
    const clickBtn = $('buy-click');
    const clickCost = p.costs.clickPower;
    clickBtn.textContent = `Buy — ${fmt(clickCost)} pts`;
    clickBtn.disabled = points < clickCost;

    // Auto-Clicker
    $('upg-auto-lvl').textContent = p.autoClickers + ' owned';
    $('upg-auto-desc').textContent = `Earns ${fmt(p.perSecond)}/sec passively → next adds ${fmt(p.multiplier)}/sec`;
    const autoBtn = $('buy-auto');
    const autoCost = p.costs.autoClicker;
    autoBtn.textContent = `Buy — ${fmt(autoCost)} pts`;
    autoBtn.disabled = points < autoCost;

    // Multiplier
    $('upg-mult-lvl').textContent = 'x' + p.multiplier;
    const multBtn = $('buy-mult');
    if (p.costs.multiplier) {
      const nm = p.costs.multiplier;
      $('upg-mult-desc').textContent = `Boosts ALL earnings → x${nm.tier} multiplies clicks AND auto-clickers`;
      multBtn.textContent = `Buy x${nm.tier} — ${fmt(nm.cost)} pts`;
      multBtn.disabled = points < nm.cost;
      multBtn.classList.remove('maxed');
    } else {
      $('upg-mult-desc').textContent = 'Maxed out! You earn 10x on everything.';
      multBtn.textContent = 'MAX';
      multBtn.disabled = true;
      multBtn.classList.add('maxed');
    }
  }

  async function buyUpgrade(path) {
    const upgErr = $('upg-error');
    upgErr.classList.add('hidden');
    try {
      const data = await api(path, { method: 'POST', body: JSON.stringify({ username }) });
      points = data.points;
      pointsEl.textContent = fmt(points);
      perClick = data.perClick;
      perSecond = data.perSecond;
      renderUpgrades(data);
    } catch (e) {
      upgErr.textContent = e.message;
      upgErr.classList.remove('hidden');
    }
  }

  $('buy-click').addEventListener('click', () => buyUpgrade('/api/upgrade/click'));
  $('buy-auto').addEventListener('click', () => buyUpgrade('/api/upgrade/auto'));
  $('buy-mult').addEventListener('click', () => buyUpgrade('/api/upgrade/multiplier'));

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- boot ----------
  if (username) {
    showGame();
  } else {
    usernameInput.focus();
  }
  setInterval(() => { if (username) refreshBoard(); }, 10000);
})();
