/* 🌌 Galaxy Clicker — polished rebuild frontend */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const gate = $('gate'), game = $('game');
  const usernameInput = $('username-input'), playBtn = $('play-btn'), gateError = $('gate-error');
  const userChip = $('user-chip'), userChipName = $('user-chip-name');
  const warnBanner = $('warn-banner'), board = $('leaderboard');

  let username = localStorage.getItem('gc_username') || null;

  // ---------- state ----------
  let S = null; // full player snapshot from server
  let buyMode = 1; // 1 | 10 | 'max'

  // session-only mechanics (never sent as truth — server validates)
  let combo = 1, comboTimer = null, lastTapAt = 0, tapStreak = 0;
  let burstUntil = 0; // timestamp when stardust burst 2x expires
  let burstClicksBanked = 0; // clicks counted toward next burst unlock
  // admin-granted burst charges: 1 charge = 50 banked clicks = 1 free burst.
  // tracked per-username in localStorage so charges are converted exactly once.
  function burstSeenKey() { return 'gc_burst_seen_' + username; }
  function getBurstSeen() { return parseInt(localStorage.getItem(burstSeenKey()) || '0', 10) || 0; }
  function setBurstSeen(n) { try { localStorage.setItem(burstSeenKey(), String(n)); } catch (e) {} }
  let soundOn = localStorage.getItem('gc_sound') !== '0';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- helpers ----------
  async function api(path, opts) {
    const res = await fetch(path, Object.assign(
      { headers: { 'Content-Type': 'application/json' } }, opts || {}));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }
  function fmt(n) {
    n = Math.floor(Number(n) || 0);
    if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.?0+$/, '') + 'K';
    return n.toLocaleString('en-US');
  }
  function fmtFull(n) { return Math.floor(Number(n) || 0).toLocaleString('en-US'); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- sound (tiny Web Audio blips, no assets) ----------
  let audioCtx = null;
  function blip(freq, dur, type) {
    if (!soundOn || reducedMotion) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.12, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + dur);
    } catch (e) { /* audio unavailable */ }
  }
  const sndTap = () => blip(520 + Math.random() * 120, 0.08);
  const sndCrit = () => { blip(880, 0.12, 'square'); setTimeout(() => blip(1320, 0.15, 'square'), 60); };
  const sndBuy = () => blip(660, 0.1, 'triangle');
  const sndAch = () => { blip(784, 0.12, 'triangle'); setTimeout(() => blip(1046, 0.18, 'triangle'), 90); };

  function applySoundLabel() {
    const b = $('sound-toggle');
    b.textContent = 'Sound: ' + (soundOn ? 'On' : 'Off');
    b.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
  }

  // ---------- background (kept from perf build) ----------
  const bg = $('bg'), galaxyEl = $('galaxy'), dustBox = $('dust');
  function detectLowPower() {
    try {
      if (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory < 4) return true;
      const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');
      if (mobile && typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency <= 4) return true;
    } catch (e) {}
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

  (function buildGalaxy() {
    try {
      const Ssize = 512, c = document.createElement('canvas');
      c.width = c.height = Ssize;
      const g = c.getContext('2d');
      const cx = Ssize / 2, cy = Ssize / 2;
      let rg = g.createRadialGradient(cx, cy, 0, cx, cy, 140);
      rg.addColorStop(0, 'rgba(255,244,220,0.95)');
      rg.addColorStop(0.25, 'rgba(255,214,150,0.55)');
      rg.addColorStop(0.6, 'rgba(150,110,255,0.16)');
      rg.addColorStop(1, 'rgba(150,110,255,0)');
      g.fillStyle = rg; g.fillRect(0, 0, Ssize, Ssize);
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
    } catch (e) {}
  })();

  const canvas = $('stars'), ctx = canvas.getContext('2d');
  const STAR_COLORS = ['#dfe6ff', '#dfe6ff', '#ffffff', '#bfe3ff', '#ffe9b8', '#ffd6f5'];
  let stars = [];
  function sizeCanvas() {
    canvas.width = window.innerWidth; canvas.height = window.innerHeight;
    const area = window.innerWidth * window.innerHeight;
    const count = perfMode ? Math.min(90, Math.floor(area / 12000)) : Math.min(140, Math.floor(area / 9000));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width, y: Math.random() * canvas.height,
      r: Math.random() * 1.6 + 0.3, tw: Math.random() * Math.PI * 2,
      sp: 0.5 + Math.random() * 1.5, c: STAR_COLORS[(Math.random() * STAR_COLORS.length) | 0],
    }));
  }
  sizeCanvas();
  window.addEventListener('resize', () => {
    sizeCanvas();
    if (reducedMotion || perfMode) requestAnimationFrame(drawStars);
  });
  function drawStars(t) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of stars) {
      const a = (reducedMotion || perfMode) ? 0.8 : 0.35 + 0.65 * Math.abs(Math.sin(t / 900 * s.sp + s.tw));
      ctx.globalAlpha = a; ctx.fillStyle = s.c;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (!reducedMotion && !perfMode) requestAnimationFrame(drawStars);
  }
  requestAnimationFrame(drawStars);

  if (!reducedMotion && !perfMode && dustBox) {
    for (let i = 0; i < 6; i++) {
      const d = document.createElement('div');
      d.className = 'mote';
      const sz = 2 + Math.random() * 4;
      d.style.width = sz + 'px'; d.style.height = sz + 'px';
      d.style.left = (Math.random() * 100) + '%'; d.style.top = (Math.random() * 100) + '%';
      d.style.animationDuration = (18 + Math.random() * 22).toFixed(1) + 's';
      d.style.animationDelay = (-Math.random() * 30).toFixed(1) + 's';
      d.style.setProperty('--dx', ((Math.random() - 0.5) * 130).toFixed(0) + 'px');
      d.style.setProperty('--dy', ((Math.random() - 0.5) * 130).toFixed(0) + 'px');
      dustBox.appendChild(d);
    }
  }
  if (!reducedMotion && !perfMode) {
    setInterval(() => {
      if (document.hidden || Math.random() < 0.3) return;
      const el = document.createElement('div');
      el.className = 'shooting-star';
      el.style.cssText = 'position:fixed;z-index:1;left:' + (Math.random() * canvas.width * 0.7) + 'px;' +
        'top:' + (Math.random() * canvas.height * 0.35) + 'px;width:' + (100 + Math.random() * 60) + 'px;height:2px;' +
        'background:linear-gradient(90deg,#fff,rgba(160,220,255,0));transform:rotate(-25deg);' +
        'box-shadow:0 0 10px rgba(255,255,255,0.9);animation:shoot 0.55s ease-out forwards;pointer-events:none;';
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 600);
    }, 4000);
    const st = document.createElement('style');
    st.textContent = '@keyframes shoot{from{opacity:1;transform:rotate(-25deg) translateX(0)}to{opacity:0;transform:rotate(-25deg) translateX(-220px)}}';
    document.head.appendChild(st);
  }
  if (!reducedMotion && !perfMode && bg) {
    let tx = 0, ty = 0, cx = 0, cy = 0, running = false;
    function tick() {
      cx += (tx - cx) * 0.06; cy += (ty - cy) * 0.06;
      bg.style.transform = 'translate3d(' + (cx * 20).toFixed(1) + 'px,' + (cy * 20).toFixed(1) + 'px,0)';
      if (Math.abs(tx - cx) > 0.0008 || Math.abs(ty - cy) > 0.0008) requestAnimationFrame(tick);
      else running = false;
    }
    function kick() { if (!running) { running = true; requestAnimationFrame(tick); } }
    window.addEventListener('pointermove', (e) => {
      tx = e.clientX / window.innerWidth - 0.5; ty = e.clientY / window.innerHeight - 0.5; kick();
    }, { passive: true });
  }

  // ---------- username gate ----------
  async function enterAs(name) {
    gateError.classList.add('hidden');
    try {
      await api('/api/register', { method: 'POST', body: JSON.stringify({ username: name }) });
    } catch (e) {
      if (!e.message.includes('taken')) {
        gateError.textContent = e.message;
        gateError.classList.remove('hidden');
        return;
      }
      // username taken = existing player, just log in as them
    }
    username = name;
    localStorage.setItem('gc_username', username);
    showGame();
  }
  playBtn.addEventListener('click', () => {
    const name = usernameInput.value.trim();
    if (!name) { gateError.textContent = 'Type a username first.'; gateError.classList.remove('hidden'); return; }
    enterAs(name);
  });
  usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') playBtn.click(); });
  $('change-name').addEventListener('click', () => {
    localStorage.removeItem('gc_username');
    username = null; S = null;
    game.classList.add('hidden'); userChip.classList.add('hidden');
    gate.classList.remove('hidden');
    usernameInput.value = ''; usernameInput.focus();
  });

  function showGame() {
    gate.classList.add('hidden'); game.classList.remove('hidden');
    userChip.classList.remove('hidden'); userChipName.textContent = username;
    applySoundLabel();
    switchTab(activeTab, false);
    refreshMe(); refreshBoard();
  }

  function showWarnings(warnings) {
    if (!warnings || !warnings.length) return;
    warnBanner.textContent = '⚠️ Admin warning: ' + warnings.map(w => w.message).join(' | ');
    warnBanner.classList.remove('hidden');
  }

  // ---------- render ----------
  const ACH_DEFS = [
    ['clicks_100', '100 clicks'], ['clicks_1000', '1,000 clicks'],
    ['earned_10k', '10K earned'], ['earned_1m', '1M earned'],
    ['upgrades_10', '10 upgrades'], ['upgrades_50', '50 upgrades'],
    ['supernova_1', 'First supernova'], ['hold_100k', 'Hold 100K stars'],
  ];

  function renderAll() {
    if (!S) return;
    // stats
    $('stat-stars').textContent = fmt(S.points);
    $('stat-stars-sub').textContent = fmt(S.totalEarned) + ' earned all time';
    // per-click shown includes active burst/combo for clarity
    const burstActive = Date.now() < burstUntil;
    const effClick = S.perClick * combo * (burstActive ? 2 : 1);
    $('stat-perclick').textContent = fmt(effClick);
    $('stat-persec').textContent = fmt(S.perSecond * (burstActive ? 2 : 1));
    $('stat-clicks').textContent = fmt(S.clicks);
    $('stat-clicks-sub').textContent = fmt(S.supernovaShards) + ' supernova shards · ' + fmt(S.supernovas) + ' supernovas';
    // rank
    $('rank-pill').textContent = 'Rank: ' + S.rank;
    $('mult-pill').textContent = 'Multiplier ×' + S.multiplier.toFixed(2);
    if (S.nextRank) {
      const prog = Math.min(1, S.totalEarned / S.nextRank.at);
      $('rank-progress').style.width = (prog * 100).toFixed(1) + '%';
      $('next-rank-pill').textContent = 'Next: ' + S.nextRank.name + ' at ' + fmt(S.nextRank.at);
    } else {
      $('rank-progress').style.width = '100%';
      $('next-rank-pill').textContent = 'Max rank achieved!';
    }
    // combo line
    const cl = $('combo-line');
    if (combo > 1 || burstActive) {
      const parts = [];
      if (combo > 1) parts.push('🔥 Combo ×' + combo.toFixed(2));
      if (burstActive) parts.push('✨ Stardust ×2 (' + Math.ceil((burstUntil - Date.now()) / 1000) + 's)');
      cl.textContent = parts.join(' · ');
      cl.classList.remove('hidden');
    } else cl.classList.add('hidden');
    // burst button
    const bb = $('burst-btn');
    if (burstActive) {
      bb.textContent = '✨ Burst active (' + Math.ceil((burstUntil - Date.now()) / 1000) + 's)';
      bb.disabled = true;
    } else {
      bb.textContent = 'Stardust Burst (' + Math.max(0, 50 - burstClicksBanked) + ' clicks to go)';
      bb.disabled = burstClicksBanked < 50;
    }
    // supernova
    const THRESH = 100000;
    $('supernova-desc').textContent =
      'Earn 100K total stars to go supernova. Progress: ' + fmt(S.totalEarned) + ' / 100K. ' +
      'Shards give +10% each, forever (until full reset). You have ' + S.supernovaShards + ' shards.';
    const sb = $('supernova-btn');
    if (S.totalEarned >= THRESH) {
      const shards = Math.floor(S.totalEarned / THRESH);
      sb.textContent = '🌟 Go Supernova — gain ' + shards + ' shard' + (shards > 1 ? 's' : '');
      sb.disabled = false;
    } else {
      sb.textContent = 'Go Supernova — need 100K earned';
      sb.disabled = true;
    }
    renderAchievements();
    renderUpgrades();
  }

  function renderAchievements() {
    const grid = $('ach-grid');
    const have = new Set(S.achievements || []);
    grid.innerHTML = '';
    for (const [id, name] of ACH_DEFS) {
      const d = document.createElement('span');
      d.className = 'ach-pill' + (have.has(id) ? ' earned' : '');
      d.textContent = (have.has(id) ? '✓ ' : '') + name;
      grid.appendChild(d);
    }
  }

  function toastAchievements(ids) {
    if (!ids || !ids.length) return;
    sndAch();
    const names = ids.map(id => (ACH_DEFS.find(a => a[0] === id) || [id, id])[1]);
    // simple floating toast
    const t = document.createElement('div');
    t.className = 'float-plus';
    t.style.cssText = 'left:50%;top:38%;transform:translateX(-50%);font-size:1.2rem;color:var(--cyan);';
    t.textContent = '🏆 ' + names.join(', ');
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  function renderUpgrades() {
    const list = $('upg-list');
    list.innerHTML = '';
    for (const u of S.upgrades) {
      const item = document.createElement('div');
      item.className = 'upg-item';
      // cost for current buy mode
      let label, cost, canBuy;
      if (buyMode === 'max') {
        // estimate max affordable (client-side; server is authoritative)
        let c = 0, spent = 0, lvl = u.level;
        while (c < 1000) {
          const cc = Math.round(cost1(u, lvl + c));
          if (spent + cc > S.points) break;
          spent += cc; c++;
        }
        label = c > 0 ? 'BUY ×' + c : 'BUY';
        cost = spent; canBuy = c > 0;
      } else {
        let total = 0;
        for (let i = 0; i < buyMode; i++) total += Math.round(cost1(u, u.level + i));
        label = 'BUY ×' + buyMode;
        cost = total; canBuy = S.points >= total;
      }
      const eachTxt = u.tapEach ? '+' + fmt(u.tapEach) + ' / tap each' : '+' + fmt(u.secEach) + ' / sec each';
      const totalTxt = u.tapEach ? 'Total: +' + fmt(u.totalTap) + ' / tap' : 'Total: +' + fmt(u.totalSec) + ' / sec';
      item.innerHTML =
        '<div class="upg-icon">' + u.icon + '</div>' +
        '<div class="upg-info"><div class="upg-name">' + esc(u.name) + '</div>' +
        '<div class="upg-effect">' + esc(u.short) + '</div>' +
        '<div class="upg-owned">Owned ' + u.level + ' · ' + eachTxt + ' · ' + totalTxt + '</div></div>' +
        '<button class="upg-buy" type="button" ' + (canBuy ? '' : 'disabled') + '>' +
        label + '<small>' + fmt(cost) + ' stars</small></button>';
      if (canBuy) {
        item.querySelector('.upg-buy').addEventListener('click', () => buyUpgrade(u.id));
      }
      list.appendChild(item);
    }
  }
  // client-side single-level cost mirror (server is authoritative)
  function cost1(u, level) {
    const base = { stellar_gloves: 15, nebula_collector: 50, comet_miner: 300, quantum_fingers: 900, pulsar_engine: 1800, star_forge: 8500, supernova_core: 42000, void_tap: 120000, black_hole: 350000, galaxy_swarm: 2200000 }[u.id] || 15;
    return Math.max(1, Math.round(base * Math.pow(1.15, level)));
  }

  // ---------- data ----------
  async function refreshMe() {
    if (!username) return;
    try {
      const p = await api('/api/player/' + encodeURIComponent(username));
      const prevAch = new Set((S && S.achievements) || []);
      S = p;
      // convert newly-granted admin burst charges into banked clicks (once each)
      const seen = getBurstSeen();
      if ((p.burstCharges || 0) > seen) {
        burstClicksBanked += (p.burstCharges - seen) * 50;
        setBurstSeen(p.burstCharges);
      }
      renderAll();
      const fresh = (p.achievements || []).filter(a => !prevAch.has(a));
      // don't toast on first load
      if (prevAch.size > 0) toastAchievements(fresh);
    } catch (e) { /* offline — try later */ }
  }

  async function refreshBoard() {
    try {
      const data = await api('/api/leaderboard');
      board.innerHTML = '';
      data.leaders.slice(0, 20).forEach((p, i) => {
        const li = document.createElement('li');
        if (p.username === username) li.className = 'me';
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '.';
        li.innerHTML = '<span>' + medal + ' ' + esc(p.username) + '</span><span class="pts">' + fmt(p.clicks) + ' clicks</span>';
        board.appendChild(li);
      });
      if (!data.leaders.length) board.innerHTML = '<li class="muted">No clickers yet. Be the first!</li>';
    } catch (e) {}
  }

  // ---------- tapping ----------
  const core = $('core');
  let clicking = false;

  function stardustBurst(x, y) {
    if (reducedMotion || perfMode) return;
    for (let i = 0; i < 12; i++) {
      const el = document.createElement('div');
      el.className = 'stardust';
      const ang = Math.random() * Math.PI * 2;
      const dist = 40 + Math.random() * 90;
      el.style.left = x + 'px'; el.style.top = y + 'px';
      el.style.setProperty('--bx', (Math.cos(ang) * dist).toFixed(0) + 'px');
      el.style.setProperty('--by', (Math.sin(ang) * dist).toFixed(0) + 'px');
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 750);
    }
  }
  function floatText(x, y, text, crit) {
    const el = document.createElement('div');
    el.className = 'float-plus' + (crit ? ' crit' : '');
    el.textContent = text;
    el.style.left = (x - 14 + (Math.random() * 28)) + 'px';
    el.style.top = (y - 12) + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 850);
  }

  function bumpCombo() {
    const now = Date.now();
    if (now - lastTapAt < 900) tapStreak++;
    else tapStreak = 1;
    lastTapAt = now;
    // combo scales with streak: 1 + min(streak/25, 1) → up to x2
    combo = 1 + Math.min(1, tapStreak / 25);
    if (comboTimer) clearTimeout(comboTimer);
    comboTimer = setTimeout(() => { combo = 1; tapStreak = 0; renderAll(); }, 2000);
  }

  function handleCoreTap(clientX, clientY) {
    if (!username || clicking || !S) return;
    clicking = true;
    bumpCombo();
    const burstActive = Date.now() < burstUntil;
    // client predicts combo; server validates bounds and rolls crit itself
    const comboSend = Math.min(2, Math.max(1, combo * (burstActive ? 2 : 1)));
    api('/api/click', {
      method: 'POST',
      body: JSON.stringify({ username, clientScore: S.points, comboMult: comboSend }),
    }).then((data) => {
      S.points = data.points; S.clicks = data.clicks;
      if (data.perClick) { /* server-computed gain */ }
      // update local snapshot cheaply (full refresh every few clicks)
      S.totalEarned += data.perClick || 0;
      burstClicksBanked++;
      if (data.crit) { sndCrit(); floatText(clientX, clientY, 'CRIT ×5! +' + fmt(data.perClick), true); }
      else { sndTap(); floatText(clientX, clientY, '+' + fmt(data.perClick), false); }
      stardustBurst(clientX, clientY);
      if (data.newAchievements && data.newAchievements.length) {
        for (const a of data.newAchievements) if (!S.achievements.includes(a)) S.achievements.push(a);
        toastAchievements(data.newAchievements);
      }
      showWarnings(data.warnings);
      renderAll();
    }).catch((err) => {
      if (String(err.message).includes('slow down')) {
        floatText(clientX, clientY, 'whoa…', false);
      } else if (String(err.message).includes('Register')) {
        localStorage.removeItem('gc_username');
        location.reload();
      }
    }).finally(() => { clicking = false; });
  }

  core.addEventListener('pointerdown', (e) => { handleCoreTap(e.clientX, e.clientY); });

  // ---------- stardust burst ----------
  $('burst-btn').addEventListener('click', () => {
    if (burstClicksBanked < 50 || Date.now() < burstUntil) return;
    burstClicksBanked = 0;
    burstUntil = Date.now() + 10000;
    sndBuy();
    renderAll();
    // tick the countdown display
    const iv = setInterval(() => {
      if (Date.now() >= burstUntil) { clearInterval(iv); }
      renderAll();
    }, 1000);
  });

  // ---------- upgrades ----------
  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const m = b.dataset.mode;
      buyMode = m === 'max' ? 'max' : parseInt(m, 10);
      renderUpgrades();
    });
  });

  async function buyUpgrade(id) {
    const errEl = $('upg-error');
    errEl.classList.add('hidden');
    try {
      const data = await api('/api/upgrade/buy', {
        method: 'POST', body: JSON.stringify({ username, upgradeId: id, mode: buyMode }),
      });
      S = Object.assign(S, data);
      delete S.ok; delete S.bought;
      sndBuy();
      toastAchievements(data.newAchievements);
      renderAll();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
    }
  }

  // ---------- supernova ----------
  $('supernova-btn').addEventListener('click', async () => {
    if (!S || S.totalEarned < 100000) return;
    const shards = Math.floor(S.totalEarned / 100000);
    if (!confirm('Go supernova? You\'ll reset stars, clicks, and upgrades to 0 and gain ' + shards + ' shard' + (shards > 1 ? 's' : '') + ' (+10% each, forever).')) return;
    try {
      const data = await api('/api/supernova', { method: 'POST', body: JSON.stringify({ username }) });
      S = Object.assign(S, data);
      delete S.ok; delete S.shardsGained;
      burstClicksBanked = 0; combo = 1; tapStreak = 0;
      sndAch();
      toastAchievements(data.newAchievements);
      renderAll();
    } catch (e) { alert(e.message); }
  });

  // ---------- sound toggle ----------
  $('sound-toggle').addEventListener('click', () => {
    soundOn = !soundOn;
    localStorage.setItem('gc_sound', soundOn ? '1' : '0');
    applySoundLabel();
    if (soundOn) sndTap();
  });

  // ---------- admin text commands (key-gated) ----------
  const cmdInput = $('cmd-input'), cmdOut = $('cmd-out');
  const cmdKeyRow = $('cmd-key-row'), cmdKey = $('cmd-key');
  let cmdKeyVal = localStorage.getItem('gc_admin_key') || '';
  if (!cmdKeyVal) cmdKeyRow.classList.remove('hidden');

  function cmdPrint(t) {
    cmdOut.classList.remove('hidden');
    cmdOut.textContent += t + '\n';
    cmdOut.scrollTop = cmdOut.scrollHeight;
  }
  function parseAmount(s) {
    const m = /^([\d.]+)\s*([kmb])?$/i.exec((s || '').trim());
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (!isFinite(n) || n < 0) return null;
    const suf = (m[2] || '').toLowerCase();
    if (suf === 'k') n *= 1e3; else if (suf === 'm') n *= 1e6; else if (suf === 'b') n *= 1e9;
    return Math.floor(n);
  }
  async function adminFetch(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json', 'x-admin-key': cmdKeyVal },
    }, opts || {}));
    const data = await res.json().catch(() => ({}));
    if (res.status === 403) throw new Error('wrong admin key');
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }
  async function runCommand(raw) {
    const parts = raw.trim().split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase();
    const arg = parts.slice(1).join(' ');
    cmdPrint('> ' + raw);
    try {
      if (!cmdKeyVal) { cmdPrint('Set your admin key first (field below).'); return; }
      switch (cmd) {
        case 'help':
          cmdPrint('give <amt> · set stars <amt> · reset stars · reset all · max · shards <n>');
          cmdPrint('max upgrades · set clicks <n> · unlock all · supernova now [n] · give burst <n>');
          cmdPrint('ban <user> [reason] · unban <user> · wipe <user>');
          break;
        case 'give': {
          const amt = parseAmount(arg);
          if (amt == null || amt <= 0) { cmdPrint('usage: give <amount>  (e.g. give 500k)'); break; }
          const r = await adminFetch('/api/admin/give', { method: 'POST', body: JSON.stringify({ username, amount: amt }) });
          cmdPrint('gave ' + fmtFull(amt) + ' → ' + fmtFull(r.points) + ' stars');
          break;
        }
        case 'reset': {
          if (/^stars$/i.test(arg)) {
            await adminFetch('/api/admin/reset-stars', { method: 'POST', body: JSON.stringify({ username }) });
            cmdPrint('stars reset to 0 (upgrades kept)');
          } else if (/^all$/i.test(arg)) {
            if (!confirm('Full reset? Wipes stars, upgrades, shards, achievements.')) { cmdPrint('cancelled'); break; }
            await adminFetch('/api/admin/reset', { method: 'POST', body: JSON.stringify({ username }) });
            cmdPrint('full reset done');
          } else cmdPrint('usage: reset stars | reset all');
          break;
        }
        case 'max': {
          if (/^upgrades$/i.test(arg)) {
            const r = await adminFetch('/api/admin/max-upgrades', { method: 'POST', body: JSON.stringify({ username }) });
            cmdPrint('all 10 upgrades → Lv 1000. per/sec: ' + fmtFull(Math.floor(r.perSecond)));
          } else {
            const r = await adminFetch('/api/admin/give', { method: 'POST', body: JSON.stringify({ username, amount: 1000000000000 }) });
            cmdPrint('maxed → ' + fmtFull(r.points) + ' stars. go wild.');
          }
          break;
        }
        case 'shards': {
          const n = parseInt(arg, 10);
          if (!n || n <= 0) { cmdPrint('usage: shards <n>'); break; }
          const r = await adminFetch('/api/admin/shards', { method: 'POST', body: JSON.stringify({ username, amount: n }) });
          cmdPrint('shards → ' + r.shards + ' total');
          break;
        }
        case 'ban': {
          const m = /^(\S+)(?:\s+(.*))?$/.exec(arg);
          if (!m) { cmdPrint('usage: ban <user> [reason]'); break; }
          await adminFetch('/api/admin/ban', { method: 'POST', body: JSON.stringify({ username: m[1], reason: m[2] || '' }) });
          cmdPrint(m[1] + ' banned.' + (m[2] ? ' reason: ' + m[2] : ''));
          break;
        }
        case 'unban': {
          if (!arg) { cmdPrint('usage: unban <user>'); break; }
          await adminFetch('/api/admin/unban', { method: 'POST', body: JSON.stringify({ username: arg }) });
          cmdPrint(arg + ' unbanned.');
          break;
        }
        case 'burst': {
          const n = parseInt(arg, 10);
          if (!n || n <= 0) { cmdPrint('usage: burst <n>  (grants n free stardust bursts)'); break; }
          const r = await adminFetch('/api/admin/give-burst', { method: 'POST', body: JSON.stringify({ username, charges: n }) });
          cmdPrint('burst charges → ' + r.burstCharges + ' total (' + n + ' free burst' + (n > 1 ? 's' : '') + ' banked)');
          break;
        }
        case 'set': {
          // extended: set stars <amt> | set clicks <n>
          let m = /^stars\s+(.+)$/i.exec(arg);
          if (m) {
            const amt = parseAmount(m[1]);
            if (amt == null) { cmdPrint('usage: set stars <amount>'); break; }
            const r = await adminFetch('/api/admin/set-stars', { method: 'POST', body: JSON.stringify({ username, amount: amt }) });
            cmdPrint('stars set to ' + fmtFull(r.points));
            break;
          }
          m = /^clicks\s+(.+)$/i.exec(arg);
          if (m) {
            const n = parseAmount(m[1]);
            if (n == null) { cmdPrint('usage: set clicks <n>'); break; }
            await adminFetch('/api/admin/set-clicks', { method: 'POST', body: JSON.stringify({ username, clicks: n }) });
            cmdPrint('clicks set to ' + fmtFull(n));
            break;
          }
          cmdPrint('usage: set stars <amount> | set clicks <n>');
          break;
        }
        case 'unlock': {
          if (!/^all$/i.test(arg)) { cmdPrint('usage: unlock all'); break; }
          await adminFetch('/api/admin/unlock-all', { method: 'POST', body: JSON.stringify({ username }) });
          cmdPrint('all achievements unlocked.');
          break;
        }
        case 'supernova': {
          if (!/^now(?:\s+(\d+))?$/i.test(arg)) { cmdPrint('usage: supernova now [shards]'); break; }
          const m = /^now(?:\s+(\d+))?$/i.exec(arg);
          const body = { username };
          if (m[1]) body.shards = parseInt(m[1], 10);
          const r = await adminFetch('/api/admin/supernova-now', { method: 'POST', body: JSON.stringify(body) });
          cmdPrint('supernova! +' + r.shardsGained + ' shards (×' + r.multiplier + ')');
          break;
        }
        case 'wipe': {
          if (!arg) { cmdPrint('usage: wipe <user>  (full data wipe)'); break; }
          if (!confirm('Wipe ALL data for ' + arg + '?')) { cmdPrint('cancelled'); break; }
          await adminFetch('/api/admin/reset-player', { method: 'POST', body: JSON.stringify({ username: arg }) });
          cmdPrint(arg + ' wiped clean.');
          break;
        }
        default:
          cmdPrint('unknown command. try "help".');
      }
    } catch (e) {
      cmdPrint('error: ' + e.message);
      if (String(e.message).includes('admin key')) {
        cmdKeyVal = '';
        localStorage.removeItem('gc_admin_key');
        cmdKeyRow.classList.remove('hidden');
      }
    }
    refreshMe();
  }
  $('cmd-run').addEventListener('click', () => {
    const v = cmdInput.value.trim();
    if (v) { cmdInput.value = ''; runCommand(v); }
  });
  cmdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('cmd-run').click(); });
  $('cmd-key-save').addEventListener('click', () => {
    const k = cmdKey.value.trim();
    if (!k) return;
    cmdKeyVal = k;
    localStorage.setItem('gc_admin_key', k);
    cmdKeyRow.classList.add('hidden');
    cmdPrint('key saved.');
  });

  // ---------- tab navigation ----------
  const TAB_IDS = ['game', 'upgrades', 'leaderboard'];
  let activeTab = 'game';
  try {
    const saved = localStorage.getItem('gc_tab');
    if (saved && TAB_IDS.indexOf(saved) !== -1) activeTab = saved;
  } catch (e) {}
  function switchTab(id, save) {
    if (TAB_IDS.indexOf(id) === -1) return;
    activeTab = id;
    if (save !== false) {
      try { localStorage.setItem('gc_tab', id); } catch (e) {}
    }
    for (const t of TAB_IDS) {
      const panel = $('tab-' + t), btn = $('tabbtn-' + t);
      if (panel) panel.classList.toggle('active', t === id);
      if (btn) {
        btn.classList.toggle('active', t === id);
        btn.setAttribute('aria-selected', t === id ? 'true' : 'false');
      }
    }
    if (id === 'leaderboard') refreshBoard();
    window.scrollTo(0, 0);
  }
  for (const t of TAB_IDS) {
    const btn = $('tabbtn-' + t);
    if (btn) btn.addEventListener('click', () => switchTab(t));
  }

  // ---------- admin gear (key-gated shortcut to /admin.html) ----------
  const keyModal = $('key-modal'), keyModalInput = $('key-modal-input'),
        keyModalError = $('key-modal-error');
  function openKeyModal() {
    keyModalError.classList.add('hidden');
    keyModalInput.value = localStorage.getItem('gc_admin_key') || '';
    keyModal.classList.remove('hidden');
    keyModalInput.focus();
  }
  function closeKeyModal() { keyModal.classList.add('hidden'); }
  $('admin-gear').addEventListener('click', openKeyModal);
  $('key-modal-cancel').addEventListener('click', closeKeyModal);
  keyModal.addEventListener('click', (e) => { if (e.target === keyModal) closeKeyModal(); });
  keyModalInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('key-modal-submit').click(); });
  $('key-modal-submit').addEventListener('click', async () => {
    const k = keyModalInput.value.trim();
    keyModalError.classList.add('hidden');
    if (!k) {
      keyModalError.textContent = 'Enter your admin key.';
      keyModalError.classList.remove('hidden');
      return;
    }
    try {
      const res = await fetch('/api/admin/alerts', { headers: { 'x-admin-key': k } });
      if (res.status === 403) throw new Error('Wrong key. Try again.');
      if (!res.ok) throw new Error('Server error (' + res.status + ')');
      localStorage.setItem('gc_admin_key', k);
      cmdKeyVal = k; // keep the inline admin commands in sync
      const kr = $('cmd-key-row');
      if (kr) kr.classList.add('hidden');
      location.href = '/admin.html'; // auto-unlocks: admin.js reads gc_admin_key
    } catch (e) {
      keyModalError.textContent = e.message;
      keyModalError.classList.remove('hidden');
    }
  });

  // ---------- perf toggle ----------
  const perfToggle = $('perf-toggle');
  if (perfToggle) {
    perfToggle.addEventListener('click', () => {
      perfMode = !perfMode;
      localStorage.setItem('gc_perf_mode', perfMode ? '1' : '0');
      applyPerfClass();
      location.reload();
    });
  }

  // ---------- boot ----------
  if (username) showGame();
  else usernameInput.focus();
  // passive income ticks server-side every second; refresh stats on a beat
  setInterval(() => { if (username && S) refreshMe(); }, 5000);
  setInterval(() => { if (username) refreshBoard(); }, 15000);
})();
