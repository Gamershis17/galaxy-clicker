/* Galaxy Clicker — frontend */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const gate = $('gate'), game = $('game');
  const usernameInput = $('username-input'), playBtn = $('play-btn'), gateError = $('gate-error');
  const clicker = $('clicker'), pointsEl = $('points'), rankLine = $('rank-line');
  const heroPoints = $('hero-points');
  const board = $('leaderboard'), warnBanner = $('warn-banner');
  const userChip = $('user-chip'), userChipName = $('user-chip-name');

  let username = localStorage.getItem('gc_username') || null;
  let points = 0;
  let clicking = false;
  let perClick = 1, perSecond = 0;

  // ---------- big animated points tracker ----------
  // Top score-card updates instantly; the hero number tweens toward it.
  let displayedPoints = 0, tweenRaf = null;
  function setPoints(v) {
    v = Math.max(0, Math.floor(v) || 0);
    pointsEl.textContent = fmt(v);
    if (reducedMotion) {
      displayedPoints = v;
      heroPoints.textContent = fmt(v);
      return;
    }
    if (tweenRaf) cancelAnimationFrame(tweenRaf);
    const from = displayedPoints, start = performance.now();
    const dur = Math.min(450, 140 + Math.abs(v - from) * 1.5);
    function step(t) {
      const k = Math.min(1, (t - start) / Math.max(1, dur));
      const e = 1 - Math.pow(1 - k, 3);
      displayedPoints = Math.round(from + (v - from) * e);
      heroPoints.textContent = fmt(displayedPoints);
      if (k < 1) tweenRaf = requestAnimationFrame(step);
      else tweenRaf = null;
    }
    tweenRaf = requestAnimationFrame(step);
    // little pop on increase
    if (v > from) {
      heroPoints.classList.remove('pop');
      void heroPoints.offsetWidth;
      heroPoints.classList.add('pop');
    }
  }

  // ---------- animated galaxy background ----------
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const bg = $('bg'), galaxyEl = $('galaxy'), dustBox = $('dust');

  // ---------- performance mode ----------
  // Full visuals by default; auto-drops to performance mode on low-memory or
  // low-core mobile devices. The user can toggle anytime from the footer.
  function detectLowPower() {
    try {
      if (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory < 4) return true;
      const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');
      if (mobile && typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency <= 4) return true;
    } catch (e) { /* ignore */ }
    return false;
  }
  const perfPref = localStorage.getItem('gc_perf_mode');
  let perfMode = perfPref === null ? detectLowPower() : perfPref === '1';
  function applyPerfClass() {
    document.body.classList.toggle('perf', perfMode);
    const t = $('perf-toggle');
    if (t) {
      t.textContent = perfMode ? '✨ Full visuals' : '⚡ Performance mode';
      t.setAttribute('aria-pressed', perfMode ? 'true' : 'false');
    }
  }
  applyPerfClass();

  // spiral galaxy texture: rendered once, rotated by cheap GPU CSS animation
  (function buildGalaxy() {
    try {
      const S = 512, c = document.createElement('canvas'); // was 640 — smaller is plenty for a bg
      c.width = c.height = S;
      const g = c.getContext('2d');
      const cx = S / 2, cy = S / 2;
      // bright core
      let rg = g.createRadialGradient(cx, cy, 0, cx, cy, 140);
      rg.addColorStop(0, 'rgba(255,244,220,0.95)');
      rg.addColorStop(0.25, 'rgba(255,214,150,0.55)');
      rg.addColorStop(0.6, 'rgba(150,110,255,0.16)');
      rg.addColorStop(1, 'rgba(150,110,255,0)');
      g.fillStyle = rg;
      g.fillRect(0, 0, S, S);
      // three spiral arms, tilted for a dynamic angle (220/arm, was 650 — ~1/3 the cost)
      const arms = 3, per = 220;
      for (let a = 0; a < arms; a++) {
        for (let i = 0; i < per; i++) {
          const t = i / per;
          const ang = a * (Math.PI * 2 / arms) + t * 4.6;
          const r = 26 + t * 285;
          const spread = (1 - t) * 26 + 6;
          const x = cx + Math.cos(ang) * r + (Math.random() - 0.5) * spread * 2;
          const y = cy + Math.sin(ang) * r * 0.62 + (Math.random() - 0.5) * spread * 2;
          const b = Math.random();
          let col;
          if (t < 0.3) col = 'rgba(255,225,170,' + (0.5 + b * 0.5).toFixed(2) + ')';
          else if (t < 0.65) col = 'rgba(190,170,255,' + (0.3 + b * 0.45).toFixed(2) + ')';
          else col = 'rgba(140,190,255,' + (0.15 + b * 0.35).toFixed(2) + ')';
          g.fillStyle = col;
          const sz = b > 0.92 ? 2.4 : 1.3;
          g.fillRect(x, y, sz, sz);
        }
      }
      galaxyEl.style.backgroundImage = 'url(' + c.toDataURL() + ')';
    } catch (e) { /* canvas unavailable — nebulae carry the background */ }
  })();

  // ---------- animated starfield (multi-color twinkle) ----------
  const canvas = $('stars'), ctx = canvas.getContext('2d');
  const STAR_COLORS = ['#dfe6ff', '#dfe6ff', '#ffffff', '#bfe3ff', '#ffe9b8', '#ffd6f5'];
  let stars = [];
  function sizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    // perf mode: even fewer stars; normal mode: 140 cap (was 220)
    const area = window.innerWidth * window.innerHeight;
    const count = perfMode
      ? Math.min(90, Math.floor(area / 12000))
      : Math.min(140, Math.floor(area / 9000));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.6 + 0.3,
      tw: Math.random() * Math.PI * 2,
      sp: 0.5 + Math.random() * 1.5,
      c: STAR_COLORS[(Math.random() * STAR_COLORS.length) | 0],
    }));
  }
  sizeCanvas();
  window.addEventListener('resize', () => {
    sizeCanvas();
    // static modes have no rAF loop, so repaint once after resize
    if (reducedMotion || perfMode) requestAnimationFrame(drawStars);
  });
  function drawStars(t) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of stars) {
      // perf mode / reduced motion: static, no per-frame twinkle loop
      const a = (reducedMotion || perfMode) ? 0.8 : 0.35 + 0.65 * Math.abs(Math.sin(t / 900 * s.sp + s.tw));
      ctx.globalAlpha = a;
      ctx.fillStyle = s.c;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (!reducedMotion && !perfMode) requestAnimationFrame(drawStars);
  }
  requestAnimationFrame(drawStars);

  // drifting dust motes (cheap CSS particles) — skipped entirely in perf mode
  if (!reducedMotion && !perfMode && dustBox) {
    for (let i = 0; i < 6; i++) {
      const d = document.createElement('div');
      d.className = 'mote';
      const sz = 2 + Math.random() * 4;
      d.style.width = sz + 'px';
      d.style.height = sz + 'px';
      d.style.left = (Math.random() * 100) + '%';
      d.style.top = (Math.random() * 100) + '%';
      d.style.animationDuration = (18 + Math.random() * 22).toFixed(1) + 's';
      d.style.animationDelay = (-Math.random() * 30).toFixed(1) + 's';
      d.style.setProperty('--dx', ((Math.random() - 0.5) * 130).toFixed(0) + 'px');
      d.style.setProperty('--dy', ((Math.random() - 0.5) * 130).toFixed(0) + 'px');
      dustBox.appendChild(d);
    }
  }

  // shooting stars — skipped entirely in perf mode; calmer cadence otherwise
  if (!reducedMotion && !perfMode) {
    const TRAILS = [
      'linear-gradient(90deg,#fff,rgba(160,220,255,0))',
      'linear-gradient(90deg,#fff,rgba(255,210,130,0))',
      'linear-gradient(90deg,#fff,rgba(200,170,255,0))',
    ];
    setInterval(() => {
      if (document.hidden || Math.random() < 0.3) return;
      const x0 = Math.random() * canvas.width * 0.7;
      const y0 = Math.random() * canvas.height * 0.35;
      const w = 100 + Math.random() * 60; // shorter trails than before (was 150–260)
      const el = document.createElement('div');
      el.className = 'shooting-star';
      el.style.cssText = 'position:fixed;z-index:1;left:' + x0 + 'px;top:' + y0 + 'px;width:' + w + 'px;height:2px;' +
        'background:' + TRAILS[(Math.random() * TRAILS.length) | 0] + ';transform:rotate(-25deg);' +
        'box-shadow:0 0 10px rgba(255,255,255,0.9);' +
        'animation:shoot 0.55s ease-out forwards;pointer-events:none;';
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 600);
    }, 4000); // was 2800ms
  }
  const style = document.createElement('style');
  style.textContent = '@keyframes shoot{from{opacity:1;transform:rotate(-25deg) translateX(0)}to{opacity:0;transform:rotate(-25deg) translateX(-220px)}}';
  document.head.appendChild(style);

  // gentle parallax on mouse / device tilt (GPU transform on one wrapper).
  // Runs only while settling — no permanent rAF loop — and is off in perf mode.
  if (!reducedMotion && !perfMode && bg) {
    let tx = 0, ty = 0, cx = 0, cy = 0, parallaxRunning = false;
    function parallaxTick() {
      cx += (tx - cx) * 0.06;
      cy += (ty - cy) * 0.06;
      bg.style.transform = 'translate3d(' + (cx * 20).toFixed(1) + 'px,' + (cy * 20).toFixed(1) + 'px,0)';
      if (Math.abs(tx - cx) > 0.0008 || Math.abs(ty - cy) > 0.0008) {
        requestAnimationFrame(parallaxTick);
      } else {
        parallaxRunning = false;
      }
    }
    function kickParallax() {
      if (parallaxRunning) return;
      parallaxRunning = true;
      requestAnimationFrame(parallaxTick);
    }
    window.addEventListener('pointermove', (e) => {
      tx = e.clientX / window.innerWidth - 0.5;
      ty = e.clientY / window.innerHeight - 0.5;
      kickParallax();
    }, { passive: true });
    window.addEventListener('deviceorientation', (e) => {
      if (e.gamma == null || e.beta == null) return;
      tx = Math.max(-1, Math.min(1, e.gamma / 28));
      ty = Math.max(-1, Math.min(1, (e.beta - 45) / 28));
      kickParallax();
    }, { passive: true });
  }

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
    setPoints(points);
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
        setPoints(points);
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
      setPoints(points);
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
      setPoints(points);
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

  // ---------- performance toggle ----------
  const perfToggle = $('perf-toggle');
  if (perfToggle) {
    perfToggle.addEventListener('click', () => {
      perfMode = !perfMode;
      localStorage.setItem('gc_perf_mode', perfMode ? '1' : '0');
      applyPerfClass();
      // reload so all background subsystems re-init cleanly in the new mode
      location.reload();
    });
  }

  // ---------- boot ----------
  if (username) {
    showGame();
  } else {
    usernameInput.focus();
  }
  setInterval(() => { if (username) refreshBoard(); }, 10000);
})();
