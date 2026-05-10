/**
 * MogMatch — script.js
 * Full client-side logic:
 *  - Screen navigation (Lobby, Arena, Solo, Leaderboard)
 *  - WebSocket connection + reconnection
 *  - WebRTC peer connection (offer/answer/ICE)
 *  - Solo face rating (sends frame to server even without opponent)
 *  - Arena face rating (both users rated after match)
 *  - Score display, tier badges, bar animations
 *  - Round timer with SVG ring
 *  - Verdict banner (who mogged who)
 *  - Leaderboard (localStorage + server sync)
 *  - Scan animation overlay
 *  - Toast notifications
 *  - Debug bar
 *  - Reconnection logic with exponential backoff
 */

'use strict';

/* ════════════════════════════════════════════════════════════════
   CONSTANTS & CONFIG
════════════════════════════════════════════════════════════════ */
const CFG = {
  WS_URL:           `ws://${location.hostname}:${location.port || 3000}/ws`,
  ROUND_SECONDS:    30,
  SCAN_DELAY_MS:    3500,   // how long after match to scan
  SCAN_DURATION_MS: 2500,   // how long scan animation plays
  RECONNECT_BASE:   1000,   // ms base for reconnect backoff
  RECONNECT_MAX:    16000,  // ms max reconnect wait
  TIMER_CIRC:       113.1,  // SVG circle circumference (r=18)
  LB_KEY:           'mogmatch_leaderboard_v2',
  MAX_LB_ENTRIES:   100,
};

/* ════════════════════════════════════════════════════════════════
   TIER DEFINITIONS
════════════════════════════════════════════════════════════════ */
const TIERS = [
  { key: 'chad',      label: 'Chad',      min: 9.0,  color: '#cc77ff', emoji: '👑' },
  { key: 'chadlite',  label: 'Chad-Lite', min: 8.0,  color: '#00e5ff', emoji: '😎' },
  { key: 'htn',       label: 'HTN',       min: 7.0,  color: '#aaff3e', emoji: '🔥' },
  { key: 'mtn',       label: 'MTN',       min: 6.0,  color: '#ffe600', emoji: '😐' },
  { key: 'ltn',       label: 'LTN',       min: 5.0,  color: '#ffaa00', emoji: '😶' },
  { key: 'sub5',      label: 'Sub-5',     min: 3.0,  color: '#ff6b35', emoji: '😔' },
  { key: 'sub3',      label: 'Sub-3',     min: 0,    color: '#ff2d55', emoji: '💀' },
];

function getTier(score) {
  for (const t of TIERS) {
    if (score >= t.min) return t;
  }
  return TIERS[TIERS.length - 1];
}

function getTierByKey(key) {
  return TIERS.find(t => t.key === key) || TIERS[TIERS.length - 1];
}

/* ════════════════════════════════════════════════════════════════
   DOM REFERENCES
════════════════════════════════════════════════════════════════ */
const el = {};

function cacheDOM() {
  const ids = [
    // Screens
    'screen-lobby', 'screen-arena', 'screen-solo',
    // Lobby
    'btn-enter-arena', 'btn-solo-rate', 'btn-open-leaderboard',
    // Arena header
    'btn-back-lobby', 'btn-skip',
    'status-pill', 'status-label',
    'timer-num', 'timer-circle',
    // Arena cams
    'vid-local', 'vid-remote',
    'canvas-local', 'canvas-remote',
    'scan-you', 'scan-opp',
    'score-you', 'score-opp',
    'tier-you', 'tier-opp',
    'bar-you', 'bar-opp',
    'waiting-panel', 'waiting-text',
    'verdict-content', 'verdict-emoji', 'verdict-text',
    'debug-bar', 'debug-text',
    'toast',
    // Solo
    'btn-back-from-solo', 'btn-solo-scan', 'btn-solo-leaderboard',
    'vid-solo', 'canvas-solo',
    'scan-solo',
    'solo-score-big', 'solo-tier-label',
    'solo-bar-fill', 'solo-tier-breakdown',
    // Leaderboard modal
    'modal-leaderboard', 'lb-backdrop',
    'btn-close-leaderboard', 'btn-lb-submit',
    'lb-name-input', 'lb-body',
    // Name modal
    'modal-name',
    'name-prompt-input', 'btn-name-cancel', 'btn-name-confirm',
  ];
  ids.forEach(id => {
    const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    el[key] = document.getElementById(id);
    if (!el[key]) console.warn(`[DOM] Missing element: #${id}`);
  });
}

/* ════════════════════════════════════════════════════════════════
   APP STATE
════════════════════════════════════════════════════════════════ */
const state = {
  // Current screen
  screen: 'lobby',

  // Camera streams
  localStream: null,
  soloStream:  null,

  // WebSocket
  ws:             null,
  wsConnected:    false,
  wsReconnecting: false,
  reconnectTimer: null,
  reconnectDelay: CFG.RECONNECT_BASE,

  // WebRTC
  peerConn:  null,
  roomId:    null,
  inRoom:    false,

  // Scores
  myScore:   null,
  oppScore:  null,
  soloScore: null,

  // Round timer
  roundTimer:  null,
  secondsLeft: CFG.ROUND_SECONDS,

  // Scan
  scanTimeout: null,

  // Leaderboard
  pendingScore:    null,
  pendingTierKey:  null,

  // Leaderboard tab
  lbTab: 'top',
};

/* ════════════════════════════════════════════════════════════════
   LEADERBOARD (localStorage)
════════════════════════════════════════════════════════════════ */
const LB = {
  load() {
    try {
      return JSON.parse(localStorage.getItem(CFG.LB_KEY) || '[]');
    } catch { return []; }
  },

  save(entries) {
    try {
      localStorage.setItem(CFG.LB_KEY, JSON.stringify(entries.slice(0, CFG.MAX_LB_ENTRIES)));
    } catch(e) { console.warn('[LB] Save failed:', e); }
  },

  add(name, score, tierKey) {
    const entries = LB.load();
    entries.push({
      id:      Date.now(),
      name:    name.trim().slice(0, 20) || 'Anonymous',
      score:   score,
      tier:    tierKey,
      ts:      Date.now(),
    });
    LB.save(entries);
    return entries;
  },

  getTop(n = 20) {
    return LB.load()
      .sort((a, b) => b.score - a.score)
      .slice(0, n);
  },

  getRecent(n = 20) {
    return LB.load()
      .sort((a, b) => b.ts - a.ts)
      .slice(0, n);
  },

  getByTier() {
    const entries = LB.load();
    const grouped = {};
    TIERS.forEach(t => { grouped[t.key] = []; });
    entries.forEach(e => {
      if (grouped[e.tier]) grouped[e.tier].push(e);
    });
    return grouped;
  },

  formatDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
};

/* ════════════════════════════════════════════════════════════════
   SCREEN NAVIGATION
════════════════════════════════════════════════════════════════ */
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = document.getElementById(`screen-${name}`);
  if (screen) screen.classList.add('active');
  state.screen = name;
  debug(`Screen: ${name}`);
}

/* ════════════════════════════════════════════════════════════════
   CAMERA HELPERS
════════════════════════════════════════════════════════════════ */
async function startCamera(videoEl, facingMode = 'user') {
  const constraints = {
    video: {
      facingMode,
      width:  { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  };
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    videoEl.srcObject = stream;
    await videoEl.play().catch(() => {});
    return stream;
  } catch (err) {
    showToast(`Camera error: ${err.message}`);
    throw err;
  }
}

function stopStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach(t => t.stop());
}

function captureFrame(videoEl, canvasEl) {
  const w = videoEl.videoWidth  || 640;
  const h = videoEl.videoHeight || 480;
  canvasEl.width  = w;
  canvasEl.height = h;
  const ctx = canvasEl.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, w, h);
  return canvasEl.toDataURL('image/jpeg', 0.75);
}

/* ════════════════════════════════════════════════════════════════
   SCAN ANIMATION
════════════════════════════════════════════════════════════════ */
function showScan(scanEl) {
  if (!scanEl) return;
  scanEl.classList.add('active');
}

function hideScan(scanEl) {
  if (!scanEl) return;
  scanEl.classList.remove('active');
}

function runScanThenScore(scanEl, doneCallback) {
  showScan(scanEl);
  setTimeout(() => {
    hideScan(scanEl);
    if (doneCallback) doneCallback();
  }, CFG.SCAN_DURATION_MS);
}

/* ════════════════════════════════════════════════════════════════
   SCORE DISPLAY HELPERS
════════════════════════════════════════════════════════════════ */
function animateCount(el, from, to, durationMs) {
  if (!el) return;
  const startTime  = performance.now();
  const range      = to - from;

  function step(now) {
    const elapsed  = now - startTime;
    const progress = Math.min(elapsed / durationMs, 1);
    const ease     = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    const current  = from + range * ease;
    el.textContent = current.toFixed(1);
    if (progress < 1) requestAnimationFrame(step);
    else el.textContent = to.toFixed(1);
  }
  requestAnimationFrame(step);
}

function applyScoreToPanel(scoreEl, tierEl, barEl, score) {
  const tier = getTier(score);

  // Animate number
  animateCount(scoreEl, 0, score, 900);

  // Tier label
  if (tierEl) {
    tierEl.textContent = tier.label;
    // Remove all tier classes
    tierEl.className = 'res-tier';
    tierEl.classList.add(`tc-${tier.key}`);
    tierEl.style.color = tier.color;
  }

  // Bar fill
  if (barEl) {
    barEl.className = 'res-bar-fill';
    barEl.classList.add(`bc-${tier.key}`);
    requestAnimationFrame(() => {
      barEl.style.width = `${(score / 10) * 100}%`;
    });
  }
}

function resetPanel(scoreEl, tierEl, barEl, defaultTierText) {
  if (scoreEl) scoreEl.textContent = '—';
  if (tierEl)  { tierEl.textContent = defaultTierText; tierEl.style.color = ''; tierEl.className = 'res-tier'; }
  if (barEl)   { barEl.style.width = '0%'; barEl.className = 'res-bar-fill'; }
}

/* ════════════════════════════════════════════════════════════════
   VERDICT BANNER
════════════════════════════════════════════════════════════════ */
function showVerdict(mine, theirs) {
  if (!el.verdictContent) return;
  const diff = mine - theirs;
  let emoji, text;

  if (Math.abs(diff) < 0.25) {
    emoji = '⚖️';
    text  = `EVEN MOG — Both rated ${mine.toFixed(1)}`;
  } else if (diff > 0) {
    emoji = '👑';
    text  = `YOU MOG by ${diff.toFixed(1)} — ${getTier(mine).label} vs ${getTier(theirs).label}`;
  } else {
    emoji = '💀';
    text  = `MOGGED by ${Math.abs(diff).toFixed(1)} — ${getTier(mine).label} vs ${getTier(theirs).label}`;
  }

  el.verdictEmoji.textContent = emoji;
  el.verdictText.textContent  = text;
  el.verdictContent.classList.add('visible');
}

function hideVerdict() {
  if (el.verdictContent) el.verdictContent.classList.remove('visible');
}

/* ════════════════════════════════════════════════════════════════
   ROUND TIMER
════════════════════════════════════════════════════════════════ */
function updateTimerUI(seconds) {
  if (!el.timerNum || !el.timerCircle) return;
  el.timerNum.textContent = seconds;
  const offset = CFG.TIMER_CIRC - (seconds / CFG.ROUND_SECONDS) * CFG.TIMER_CIRC;
  el.timerCircle.style.strokeDashoffset = offset;
  el.timerCircle.style.stroke = seconds <= 8 ? '#ff2d55' : '#e8ff00';
}

function startRoundTimer() {
  clearInterval(state.roundTimer);
  state.secondsLeft = CFG.ROUND_SECONDS;
  updateTimerUI(state.secondsLeft);

  state.roundTimer = setInterval(() => {
    state.secondsLeft--;
    updateTimerUI(state.secondsLeft);
    if (state.secondsLeft <= 0) {
      clearInterval(state.roundTimer);
      onRoundEnd();
    }
  }, 1000);
}

function stopRoundTimer() {
  clearInterval(state.roundTimer);
  state.roundTimer = null;
  updateTimerUI(CFG.ROUND_SECONDS);
}

function onRoundEnd() {
  debug('Round ended — finding next match');
  showToast('Round over! Finding next match...');
  setTimeout(() => {
    resetArena();
    wsSend({ type: 'find_match' });
  }, 2200);
}

/* ════════════════════════════════════════════════════════════════
   STATUS PILL
════════════════════════════════════════════════════════════════ */
function setStatus(state_str, label) {
  if (!el.statusPill) return;
  el.statusPill.className = `status-pill ${state_str}`;
  if (el.statusLabel) el.statusLabel.textContent = label;
}

/* ════════════════════════════════════════════════════════════════
   TOAST
════════════════════════════════════════════════════════════════ */
let toastTimer;
function showToast(msg, ms = 3000) {
  if (!el.toast) return;
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast?.classList.add('hidden'), ms);
}

/* ════════════════════════════════════════════════════════════════
   DEBUG BAR
════════════════════════════════════════════════════════════════ */
function debug(msg) {
  console.log(`[MogMatch] ${msg}`);
  if (el.debugText) el.debugText.textContent = msg;
}

/* ════════════════════════════════════════════════════════════════
   WEBSOCKET — CONNECTION & RECONNECTION
════════════════════════════════════════════════════════════════ */
function connectWS() {
  if (state.ws && state.ws.readyState <= WebSocket.OPEN) {
    state.ws.close();
  }

  debug(`Connecting to ${CFG.WS_URL}...`);
  setStatus('searching', 'Connecting...');

  try {
    state.ws = new WebSocket(CFG.WS_URL);
  } catch (err) {
    debug(`WS creation failed: ${err.message}`);
    scheduleReconnect();
    return;
  }

  state.ws.onopen = () => {
    debug('WebSocket connected');
    state.wsConnected = true;
    state.wsReconnecting = false;
    state.reconnectDelay = CFG.RECONNECT_BASE;
    clearTimeout(state.reconnectTimer);
    setStatus('searching', 'Finding match...');
    wsSend({ type: 'find_match' });
  };

  state.ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); }
    catch { return; }
    handleWSMessage(msg);
  };

  state.ws.onerror = (err) => {
    debug(`WS error: ${JSON.stringify(err.type)}`);
  };

  state.ws.onclose = (evt) => {
    state.wsConnected = false;
    debug(`WS closed (${evt.code})`);
    setStatus('error', 'Disconnected');
    if (state.screen === 'arena') scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (state.wsReconnecting) return;
  state.wsReconnecting = true;
  const delay = state.reconnectDelay;
  state.reconnectDelay = Math.min(state.reconnectDelay * 2, CFG.RECONNECT_MAX);
  debug(`Reconnecting in ${delay}ms...`);
  setStatus('searching', `Reconnecting...`);
  state.reconnectTimer = setTimeout(() => {
    state.wsReconnecting = false;
    connectWS();
  }, delay);
}

function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  } else {
    debug(`WS not open — dropped message: ${obj.type}`);
  }
}

/* ════════════════════════════════════════════════════════════════
   WEBSOCKET MESSAGE HANDLER
════════════════════════════════════════════════════════════════ */
function handleWSMessage(msg) {
  debug(`← ${msg.type}`);

  switch (msg.type) {

    case 'matched':
      state.roomId = msg.room;
      state.inRoom = true;
      debug(`Matched in room ${msg.room}, initiator=${msg.initiator}`);
      setStatus('live', 'Matched!');
      showToast('Opponent found!');
      el.waitingPanel?.classList.add('hidden');
      setupPeerConnection(msg.initiator);
      break;

    case 'signal':
      handleSignal(msg);
      break;

    case 'scores':
      // Both scored from server
      state.myScore  = msg.yourScore;
      state.oppScore = msg.oppScore;
      hideScan(el.scanYou);
      hideScan(el.scanOpp);
      applyScoreToPanel(el.scoreYou, el.tierYou, el.barYou, msg.yourScore);
      applyScoreToPanel(el.scoreOpp, el.tierOpp, el.barOpp, msg.oppScore);
      showVerdict(msg.yourScore, msg.oppScore);
      // Save to leaderboard automatically with generic name
      state.pendingScore   = msg.yourScore;
      state.pendingTierKey = getTier(msg.yourScore).key;
      debug(`Scores received: you=${msg.yourScore} opp=${msg.oppScore}`);
      break;

    case 'solo_score':
      // Score for solo mode
      state.soloScore = msg.score;
      hideScan(el.scanSolo);
      applySoloScore(msg.score);
      debug(`Solo score: ${msg.score}`);
      break;

    case 'opponent_left':
      debug('Opponent left');
      showToast('Opponent disconnected');
      resetArena();
      wsSend({ type: 'find_match' });
      break;

    case 'status':
      setStatus('searching', msg.msg || 'Waiting...');
      debug(`Server status: ${msg.msg}`);
      break;

    case 'queued':
      setStatus('searching', `In queue (pos ${msg.position || '?'})...`);
      debug(`Queued at position ${msg.position}`);
      break;

    case 'ping':
      wsSend({ type: 'pong' });
      break;

    case 'error':
      showToast(`Server error: ${msg.msg}`);
      debug(`Server error: ${msg.msg}`);
      break;

    default:
      debug(`Unknown message type: ${msg.type}`);
  }
}

/* ════════════════════════════════════════════════════════════════
   WEBRTC — PEER CONNECTION
════════════════════════════════════════════════════════════════ */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.services.mozilla.com' },
];

async function setupPeerConnection(initiator) {
  if (state.peerConn) {
    state.peerConn.close();
    state.peerConn = null;
  }

  debug(`Setting up peer, initiator=${initiator}`);

  state.peerConn = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Add local tracks
  if (state.localStream) {
    state.localStream.getTracks().forEach(track => {
      state.peerConn.addTrack(track, state.localStream);
    });
  }

  // Remote stream → remote video
  state.peerConn.ontrack = (evt) => {
    debug('Got remote track');
    if (el.vidRemote) {
      el.vidRemote.srcObject = evt.streams[0];
      el.vidRemote.play().catch(() => {});
    }
  };

  // ICE candidate relay
  state.peerConn.onicecandidate = (evt) => {
    if (evt.candidate) {
      wsSend({ type: 'signal', room: state.roomId, candidate: evt.candidate });
    }
  };

  // Connection state changes
  state.peerConn.onconnectionstatechange = () => {
    const cs = state.peerConn?.connectionState;
    debug(`PeerConn state: ${cs}`);
    if (cs === 'connected') {
      setStatus('live', 'Live');
      onPeerConnected();
    } else if (cs === 'failed' || cs === 'disconnected') {
      debug('Peer connection failed/disconnected');
      resetArena();
      wsSend({ type: 'find_match' });
    }
  };

  // ICE state for debugging
  state.peerConn.oniceconnectionstatechange = () => {
    debug(`ICE state: ${state.peerConn?.iceConnectionState}`);
  };

  if (initiator) {
    const offer = await state.peerConn.createOffer({ offerToReceiveVideo: true });
    await state.peerConn.setLocalDescription(offer);
    wsSend({ type: 'signal', room: state.roomId, sdp: state.peerConn.localDescription });
    debug('Sent offer');
  }
}

async function handleSignal(msg) {
  if (!state.peerConn) {
    debug('Signal arrived but no peerConn — ignoring');
    return;
  }

  if (msg.sdp) {
    try {
      await state.peerConn.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      debug(`Set remote SDP (${msg.sdp.type})`);

      if (msg.sdp.type === 'offer') {
        const answer = await state.peerConn.createAnswer();
        await state.peerConn.setLocalDescription(answer);
        wsSend({ type: 'signal', room: state.roomId, sdp: state.peerConn.localDescription });
        debug('Sent answer');
      }
    } catch (err) {
      debug(`SDP error: ${err.message}`);
    }
  }

  if (msg.candidate) {
    try {
      await state.peerConn.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } catch (err) {
      debug(`ICE candidate error: ${err.message}`);
    }
  }
}

/* ════════════════════════════════════════════════════════════════
   WHEN PEER IS CONNECTED — start round
════════════════════════════════════════════════════════════════ */
function onPeerConnected() {
  debug('Peer connected! Starting round.');
  startRoundTimer();

  // After delay, trigger scan animation then send frame
  clearTimeout(state.scanTimeout);
  state.scanTimeout = setTimeout(() => {
    showScan(el.scanYou);
    showScan(el.scanOpp);

    setTimeout(() => {
      const frame = captureFrame(el.vidLocal, el.canvasLocal);
      wsSend({ type: 'analyze_frame', room: state.roomId, frame });
      debug('Sent frame for analysis');
    }, CFG.SCAN_DURATION_MS);
  }, CFG.SCAN_DELAY_MS);
}

/* ════════════════════════════════════════════════════════════════
   ARENA RESET
════════════════════════════════════════════════════════════════ */
function resetArena() {
  debug('Resetting arena');

  // Close peer connection
  if (state.peerConn) {
    state.peerConn.close();
    state.peerConn = null;
  }

  // Clear remote video
  if (el.vidRemote) el.vidRemote.srcObject = null;

  // Stop timers
  stopRoundTimer();
  clearTimeout(state.scanTimeout);

  // Reset UI
  hideVerdict();
  hideScan(el.scanYou);
  hideScan(el.scanOpp);
  resetPanel(el.scoreYou, el.tierYou, el.barYou, 'Scanning...');
  resetPanel(el.scoreOpp, el.tierOpp, el.barOpp, 'Waiting...');

  // Show waiting overlay
  if (el.waitingPanel) el.waitingPanel.classList.remove('hidden');

  state.roomId   = null;
  state.inRoom   = false;
  state.myScore  = null;
  state.oppScore = null;

  setStatus('searching', 'Finding match...');
}

/* ════════════════════════════════════════════════════════════════
   SOLO RATING
════════════════════════════════════════════════════════════════ */
function applySoloScore(score) {
  const tier = getTier(score);

  // Big score number
  animateCount(el.soloScoreBig, 0, score, 1000);

  // Tier label
  if (el.soloTierLabel) {
    el.soloTierLabel.textContent = `${tier.emoji} ${tier.label}`;
    el.soloTierLabel.style.color = tier.color;
  }

  // Bar
  if (el.soloBarFill) {
    el.soloBarFill.style.background = tier.color;
    requestAnimationFrame(() => {
      el.soloBarFill.style.width = `${(score / 10) * 100}%`;
    });
  }

  // Breakdown
  renderTierBreakdown(score);

  // Save pending for leaderboard
  state.pendingScore   = score;
  state.pendingTierKey = tier.key;
}

function renderTierBreakdown(currentScore) {
  if (!el.soloTierBreakdown) return;
  el.soloTierBreakdown.innerHTML = '';

  TIERS.slice().reverse().forEach(tier => {
    const row = document.createElement('div');
    row.className = 'tier-breakdown-row';
    if (currentScore >= tier.min) row.classList.add('active');

    const rangeEnd = (() => {
      const idx = TIERS.findIndex(t => t.key === tier.key);
      return idx > 0 ? TIERS[idx - 1].min : 10;
    })();

    row.style.color = tier.color;
    row.innerHTML = `
      <span class="tbr-range">${tier.min}–${rangeEnd}</span>
      <span class="tbr-name">${tier.label}</span>
      <span class="tbr-dot"></span>
    `;
    el.soloTierBreakdown.appendChild(row);
  });
}

async function doSoloScan() {
  if (!state.soloStream) {
    showToast('No camera active');
    return;
  }

  if (!el.btnSoloScan) return;
  el.btnSoloScan.disabled = true;
  el.btnSoloScan.textContent = 'Scanning...';

  showScan(el.scanSolo);

  setTimeout(() => {
    const frame = captureFrame(el.vidSolo, el.canvasSolo);
    wsSend({ type: 'solo_score', frame });
    debug('Sent solo frame');

    // If WS not connected, generate a local score
    if (!state.wsConnected) {
      debug('WS offline — using local score');
      setTimeout(() => {
        hideScan(el.scanSolo);
        const localScore = parseFloat((Math.random() * 4 + 4).toFixed(2));
        applySoloScore(localScore);
        el.btnSoloScan.disabled = false;
        el.btnSoloScan.innerHTML = '<span class="btn-icon">🔍</span><span>Scan Again</span>';
      }, CFG.SCAN_DURATION_MS);
    } else {
      setTimeout(() => {
        el.btnSoloScan.disabled = false;
        el.btnSoloScan.innerHTML = '<span class="btn-icon">🔍</span><span>Scan Again</span>';
      }, CFG.SCAN_DURATION_MS + 500);
    }
  }, 400);
}

/* ════════════════════════════════════════════════════════════════
   LEADERBOARD UI
════════════════════════════════════════════════════════════════ */
function openLeaderboard(withSubmit = false) {
  el.modalLeaderboard?.classList.remove('hidden');
  renderLeaderboard();

  // Show submit form if there's a pending score
  if (withSubmit && state.pendingScore !== null) {
    if (el.lbSubmitForm) el.lbSubmitForm.style.display = 'flex';
    if (el.lbNameInput)  el.lbNameInput.focus();
  } else {
    if (el.lbSubmitForm) el.lbSubmitForm.style.display = 'none';
  }
}

function closeLeaderboard() {
  el.modalLeaderboard?.classList.add('hidden');
}

function renderLeaderboard() {
  if (!el.lbBody) return;
  el.lbBody.innerHTML = '';

  switch (state.lbTab) {
    case 'top':    renderLBTop();    break;
    case 'recent': renderLBRecent(); break;
    case 'tiers':  renderLBTiers();  break;
  }
}

function makeLBRow(entry, rank) {
  const tier = getTierByKey(entry.tier);
  const row  = document.createElement('div');
  row.className = `lb-row lb-row-${rank}`;

  row.innerHTML = `
    <div class="lb-rank">${rank <= 3 ? ['🥇','🥈','🥉'][rank-1] : rank}</div>
    <div class="lb-name">${escapeHtml(entry.name)}</div>
    <div class="lb-score" style="color:${tier.color}">${entry.score.toFixed(1)}</div>
    <div class="lb-tier-badge" style="color:${tier.color}">${tier.label}</div>
    <div class="lb-date">${LB.formatDate(entry.ts)}</div>
  `;
  return row;
}

function renderLBTop() {
  const entries = LB.getTop(30);
  if (!entries.length) {
    el.lbBody.innerHTML = '<div class="lb-empty">No scores yet. Be the first to rate yourself!</div>';
    return;
  }
  entries.forEach((e, i) => el.lbBody.appendChild(makeLBRow(e, i + 1)));
}

function renderLBRecent() {
  const entries = LB.getRecent(30);
  if (!entries.length) {
    el.lbBody.innerHTML = '<div class="lb-empty">No scores yet.</div>';
    return;
  }
  entries.forEach((e, i) => el.lbBody.appendChild(makeLBRow(e, i + 1)));
}

function renderLBTiers() {
  const grouped = LB.getByTier();
  let hasAny = false;

  TIERS.forEach(tier => {
    const entries = (grouped[tier.key] || []).sort((a, b) => b.score - a.score);
    if (!entries.length) return;
    hasAny = true;

    const header = document.createElement('div');
    header.className = 'lb-tier-header';
    header.style.color = tier.color;
    header.textContent = `${tier.emoji} ${tier.label} (${entries.length})`;
    el.lbBody.appendChild(header);

    entries.slice(0, 5).forEach((e, i) => el.lbBody.appendChild(makeLBRow(e, i + 1)));
  });

  if (!hasAny) {
    el.lbBody.innerHTML = '<div class="lb-empty">No scores yet.</div>';
  }
}

function submitToLeaderboard() {
  const name  = el.lbNameInput?.value?.trim() || 'Anonymous';
  const score = state.pendingScore;
  const tier  = state.pendingTierKey;

  if (score === null) {
    showToast('No score to submit');
    return;
  }

  LB.add(name, score, tier);
  state.pendingScore   = null;
  state.pendingTierKey = null;

  if (el.lbNameInput) el.lbNameInput.value = '';
  if (el.lbSubmitForm) el.lbSubmitForm.style.display = 'none';
  renderLeaderboard();
  showToast(`Submitted! ${name} — ${score.toFixed(1)}`);
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ════════════════════════════════════════════════════════════════
   EVENT LISTENERS
════════════════════════════════════════════════════════════════ */
function bindEvents() {

  /* ── Lobby ───────────────────────────────────────────────── */
  el.btnEnterArena?.addEventListener('click', async () => {
    try {
      state.localStream = await startCamera(el.vidLocal);
      showScreen('arena');
      connectWS();
    } catch (err) {
      showToast('Could not access camera');
    }
  });

  el.btnSoloRate?.addEventListener('click', async () => {
    try {
      state.soloStream = await startCamera(el.vidSolo);
      showScreen('solo');
      // Connect WS for solo scoring (optional, falls back to local)
      if (!state.wsConnected) connectWS();
    } catch (err) {
      showToast('Could not access camera');
    }
  });

  el.btnOpenLeaderboard?.addEventListener('click', () => openLeaderboard(false));

  /* ── Arena ───────────────────────────────────────────────── */
  el.btnBackLobby?.addEventListener('click', () => {
    resetArena();
    stopStream(state.localStream);
    state.localStream = null;
    if (state.ws) state.ws.close();
    showScreen('lobby');
  });

  el.btnSkip?.addEventListener('click', () => {
    debug('Skipped');
    resetArena();
    wsSend({ type: 'skip' });
  });

  /* ── Solo ────────────────────────────────────────────────── */
  el.btnBackFromSolo?.addEventListener('click', () => {
    hideScan(el.scanSolo);
    stopStream(state.soloStream);
    state.soloStream = null;
    showScreen('lobby');
  });

  el.btnSoloScan?.addEventListener('click', doSoloScan);

  el.btnSoloLeaderboard?.addEventListener('click', () => {
    if (state.pendingScore === null) {
      showToast('Scan yourself first!');
      return;
    }
    openLeaderboard(true);
  });

  /* ── Leaderboard modal ───────────────────────────────────── */
  el.btnCloseLeaderboard?.addEventListener('click', closeLeaderboard);
  el.lbBackdrop?.addEventListener('click', closeLeaderboard);

  el.btnLbSubmit?.addEventListener('click', submitToLeaderboard);

  el.lbNameInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitToLeaderboard();
  });

  // Tab switching
  document.querySelectorAll('.lb-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.lb-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.lbTab = tab.dataset.tab;
      renderLeaderboard();
    });
  });

  /* ── Name modal ──────────────────────────────────────────── */
  el.btnNameCancel?.addEventListener('click', () => {
    el.modalName?.classList.add('hidden');
  });

  el.btnNameConfirm?.addEventListener('click', () => {
    const name = el.namePromptInput?.value?.trim() || 'Anonymous';
    if (state.pendingScore !== null) {
      LB.add(name, state.pendingScore, state.pendingTierKey || 'sub3');
      state.pendingScore   = null;
      state.pendingTierKey = null;
      showToast('Score submitted to leaderboard!');
    }
    el.modalName?.classList.add('hidden');
  });

  /* ── Keyboard shortcuts ──────────────────────────────────── */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeLeaderboard();
      el.modalName?.classList.add('hidden');
    }
  });
}

/* ════════════════════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  cacheDOM();
  bindEvents();
  debug('MogMatch ready');
});
