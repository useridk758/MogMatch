/**
 * MogMatch — script.js
 * Handles: Camera, WebRTC peer connection, Socket.IO signaling,
 *           score display, tier UI, round timer, verdict banner.
 */

// ────────────────────────────────────────────────────────────
// CONFIG
// ────────────────────────────────────────────────────────────
const SERVER_URL = window.location.origin; // same origin as Express
const ROUND_SECONDS = 30;
const SCAN_DELAY_MS = 4000; // wait after match before scanning

// ────────────────────────────────────────────────────────────
// TIER LOGIC  (matches server-side tiers)
// ────────────────────────────────────────────────────────────
const TIERS = [
  { key: 'chad',      label: 'Chad',      min: 9.0,  css: 'chad'     },
  { key: 'chadlite',  label: 'Chad-Lite', min: 8.0,  css: 'chadlite' },
  { key: 'htn',       label: 'HTN',       min: 7.0,  css: 'htn'      },
  { key: 'mtn',       label: 'MTN',       min: 6.0,  css: 'mtn'      },
  { key: 'ltn',       label: 'LTN',       min: 5.0,  css: 'ltn'      },
  { key: 'sub5',      label: 'Sub-5',     min: 3.0,  css: 'sub5'     },
  { key: 'sub3',      label: 'Sub-3',     min: 0,    css: 'sub3'     },
];

function getTier(score) {
  for (const t of TIERS) if (score >= t.min) return t;
  return TIERS[TIERS.length - 1];
}

// ────────────────────────────────────────────────────────────
// DOM REFS
// ────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const lobby       = $('lobby');
const arena       = $('arena');
const startBtn    = $('start-btn');
const skipBtn     = $('skip-btn');

const localVideo  = $('local-video');
const remoteVideo = $('remote-video');
const localCanvas = $('local-canvas');
const remoteCanvas= $('remote-canvas');

const yourScore   = $('your-score');
const yourTier    = $('your-tier');
const yourBar     = $('your-bar');
const oppScore    = $('opp-score');
const oppTier     = $('opp-tier');
const oppBar      = $('opp-bar');

const statusDot   = $('status-dot');
const statusText  = $('status-text');
const waitingOvl  = $('waiting-overlay');
const verdictBanner = $('verdict-banner');
const verdictIcon = $('verdict-icon');
const verdictTextEl = $('verdict-text');
const timerNum    = $('timer-num');
const timerRing   = $('timer-ring');
const toastEl     = $('toast');

// ────────────────────────────────────────────────────────────
// STATE
// ────────────────────────────────────────────────────────────
let localStream   = null;
let peerConn      = null;
let socket        = null;
let roomId        = null;
let myScore       = null;
let oppScoreVal   = null;
let roundTimer    = null;
let scanTimeout   = null;
let secondsLeft   = ROUND_SECONDS;
const CIRC        = 163.4; // svg ring circumference

// ────────────────────────────────────────────────────────────
// LOBBY → ARENA
// ────────────────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    localVideo.srcObject = localStream;
    switchScreen(lobby, arena);
    initSocket();
  } catch (err) {
    showToast('Camera denied: ' + err.message);
  }
});

skipBtn.addEventListener('click', () => {
  resetRound();
  socket && socket.emit('skip');
});

// ────────────────────────────────────────────────────────────
// SCREEN HELPER
// ────────────────────────────────────────────────────────────
function switchScreen(from, to) {
  from.classList.remove('active');
  to.classList.add('active');
}

// ────────────────────────────────────────────────────────────
// SOCKET.IO
// ────────────────────────────────────────────────────────────
function initSocket() {
  // Socket.IO client loaded from server via <script src="/socket.io/socket.io.js">
  socket = io(SERVER_URL);

  socket.on('connect', () => {
    setStatus('searching', 'Finding match...');
    socket.emit('find_match');
  });

  socket.on('matched', async ({ room, initiator }) => {
    roomId = room;
    setStatus('live', 'Matched!');
    waitingOvl.classList.add('hidden');
    await setupPeer(initiator);
  });

  socket.on('signal', async ({ sdp, candidate }) => {
    if (!peerConn) return;
    if (sdp) {
      await peerConn.setRemoteDescription(new RTCSessionDescription(sdp));
      if (sdp.type === 'offer') {
        const answer = await peerConn.createAnswer();
        await peerConn.setLocalDescription(answer);
        socket.emit('signal', { room: roomId, sdp: peerConn.localDescription });
      }
    }
    if (candidate) {
      await peerConn.addIceCandidate(new RTCIceCandidate(candidate));
    }
  });

  // Server broadcasts scores from AI analysis
  socket.on('scores', ({ yourScore: ys, oppScore: os }) => {
    myScore    = ys;
    oppScoreVal = os;
    displayScore('you', ys);
    displayScore('opp', os);
    showVerdict(ys, os);
  });

  socket.on('opponent_left', () => {
    resetRound();
    setStatus('searching', 'Opponent left. Finding new match...');
    socket.emit('find_match');
  });

  socket.on('disconnect', () => setStatus('idle', 'Disconnected'));
}

// ────────────────────────────────────────────────────────────
// WEBRTC
// ────────────────────────────────────────────────────────────
async function setupPeer(initiator) {
  peerConn = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));

  peerConn.ontrack = e => {
    remoteVideo.srcObject = e.streams[0];
  };

  peerConn.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('signal', { room: roomId, candidate: e.candidate });
    }
  };

  peerConn.onconnectionstatechange = () => {
    if (peerConn.connectionState === 'connected') {
      setStatus('live', 'Live');
      startRound();
    }
  };

  if (initiator) {
    const offer = await peerConn.createOffer();
    await peerConn.setLocalDescription(offer);
    socket.emit('signal', { room: roomId, sdp: peerConn.localDescription });
  }
}

// ────────────────────────────────────────────────────────────
// ROUND MANAGEMENT
// ────────────────────────────────────────────────────────────
function startRound() {
  secondsLeft = ROUND_SECONDS;
  updateTimerUI(secondsLeft);
  clearInterval(roundTimer);
  roundTimer = setInterval(() => {
    secondsLeft--;
    updateTimerUI(secondsLeft);
    if (secondsLeft <= 0) {
      clearInterval(roundTimer);
      endRound();
    }
  }, 1000);

  // Trigger snapshot for AI scoring after delay
  clearTimeout(scanTimeout);
  scanTimeout = setTimeout(sendSnapshots, SCAN_DELAY_MS);
}

function endRound() {
  showToast('Round over! Finding next match...');
  setTimeout(() => {
    resetRound();
    socket && socket.emit('find_match');
  }, 2000);
}

function resetRound() {
  clearInterval(roundTimer);
  clearTimeout(scanTimeout);
  peerConn && peerConn.close();
  peerConn = null;
  remoteVideo.srcObject = null;
  waitingOvl.classList.remove('hidden');
  verdictBanner.classList.add('hidden');
  setStatus('searching', 'Finding match...');
  resetScoreUI('you');
  resetScoreUI('opp');
  secondsLeft = ROUND_SECONDS;
  updateTimerUI(secondsLeft);
}

// ────────────────────────────────────────────────────────────
// SNAPSHOT → SERVER FOR AI ANALYSIS
// ────────────────────────────────────────────────────────────
function sendSnapshots() {
  const mySnap  = captureFrame(localVideo,  localCanvas);
  socket.emit('analyze_frame', { room: roomId, frame: mySnap });
}

function captureFrame(video, canvas) {
  canvas.width  = video.videoWidth  || 320;
  canvas.height = video.videoHeight || 240;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.7);
}

// ────────────────────────────────────────────────────────────
// SCORE UI
// ────────────────────────────────────────────────────────────
function displayScore(who, score) {
  const tier = getTier(score);
  const num  = who === 'you' ? yourScore   : oppScore;
  const lbl  = who === 'you' ? yourTier    : oppTier;
  const bar  = who === 'you' ? yourBar     : oppBar;

  // Animate number count-up
  animateNumber(num, score);
  lbl.textContent = tier.label;

  // Remove all tier classes
  lbl.className = 'score-tier';
  bar.className = 'score-bar-fill';
  lbl.classList.add('tier-' + tier.css);
  bar.classList.add('bar-' + tier.css);

  // Bar width = (score/10)*100%
  bar.style.width = (score / 10 * 100) + '%';
}

function animateNumber(el, target) {
  const steps = 20;
  const step  = target / steps;
  let current = 0;
  let i = 0;
  const iv = setInterval(() => {
    current += step;
    i++;
    el.textContent = Math.min(current, target).toFixed(1);
    if (i >= steps) {
      clearInterval(iv);
      el.textContent = target.toFixed(1);
    }
  }, 40);
}

function resetScoreUI(who) {
  const num = who === 'you' ? yourScore  : oppScore;
  const lbl = who === 'you' ? yourTier   : oppTier;
  const bar = who === 'you' ? yourBar    : oppBar;
  num.textContent = '—';
  lbl.textContent = who === 'you' ? 'Scanning...' : 'Waiting...';
  lbl.className = 'score-tier';
  bar.className = 'score-bar-fill';
  bar.style.width = '0%';
}

// ────────────────────────────────────────────────────────────
// VERDICT BANNER
// ────────────────────────────────────────────────────────────
function showVerdict(mine, theirs) {
  verdictBanner.classList.remove('hidden');
  const diff = mine - theirs;
  if (Math.abs(diff) < 0.3) {
    verdictIcon.textContent = '⚖️';
    verdictTextEl.textContent = 'EVEN MOG — Balanced encounter';
  } else if (diff > 0) {
    verdictIcon.textContent = '👑';
    verdictTextEl.textContent = `YOU MOG (+${diff.toFixed(1)})`;
  } else {
    verdictIcon.textContent = '💀';
    verdictTextEl.textContent = `YOU GOT MOGGED (${diff.toFixed(1)})`;
  }
}

// ────────────────────────────────────────────────────────────
// TIMER UI
// ────────────────────────────────────────────────────────────
function updateTimerUI(s) {
  timerNum.textContent = s;
  const offset = CIRC - (s / ROUND_SECONDS) * CIRC;
  timerRing.style.strokeDashoffset = offset;
  if (s <= 10) timerRing.style.stroke = 'var(--danger)';
  else         timerRing.style.stroke = 'var(--accent)';
}

// ────────────────────────────────────────────────────────────
// STATUS
// ────────────────────────────────────────────────────────────
function setStatus(state, text) {
  statusDot.className = '';
  if (state !== 'idle') statusDot.classList.add(state);
  statusText.textContent = text;
}

// ────────────────────────────────────────────────────────────
// TOAST
// ────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, ms = 3000) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), ms);
}
