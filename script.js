/**
 * MogMatch — script.js (Python backend version)
 * Uses native WebSocket — no Socket.IO, no Node required.
 */

const WS_URL        = `ws://${location.host}/ws`;
const ROUND_SECONDS = 30;
const SCAN_DELAY_MS = 4000;

const TIERS = [
  { label: 'Chad',      min: 9.0, css: 'chad'      },
  { label: 'Chad-Lite', min: 8.0, css: 'chadlite'  },
  { label: 'HTN',       min: 7.0, css: 'htn'       },
  { label: 'MTN',       min: 6.0, css: 'mtn'       },
  { label: 'LTN',       min: 5.0, css: 'ltn'       },
  { label: 'Sub-5',     min: 3.0, css: 'sub5'      },
  { label: 'Sub-3',     min: 0,   css: 'sub3'      },
];
const getTier = score => TIERS.find(t => score >= t.min) ?? TIERS.at(-1);

const $ = id => document.getElementById(id);

const lobby         = $('lobby');
const arena         = $('arena');
const startBtn      = $('start-btn');
const skipBtn       = $('skip-btn');
const localVideo    = $('local-video');
const remoteVideo   = $('remote-video');
const localCanvas   = $('local-canvas');
const remoteCanvas  = $('remote-canvas');
const yourScoreEl   = $('your-score');
const yourTierEl    = $('your-tier');
const yourBarEl     = $('your-bar');
const oppScoreEl    = $('opp-score');
const oppTierEl     = $('opp-tier');
const oppBarEl      = $('opp-bar');
const statusDot     = $('status-dot');
const statusText    = $('status-text');
const waitingOvl    = $('waiting-overlay');
const verdictBanner = $('verdict-banner');
const verdictIcon   = $('verdict-icon');
const verdictTextEl = $('verdict-text');
const timerNum      = $('timer-num');
const timerRing     = $('timer-ring');
const toastEl       = $('toast');

let localStream  = null;
let peerConn     = null;
let ws           = null;
let roomId       = null;
let roundTimer   = null;
let scanTimeout  = null;
let secondsLeft  = ROUND_SECONDS;
const CIRC       = 163.4;

startBtn.addEventListener('click', async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    localVideo.srcObject = localStream;
    switchScreen(lobby, arena);
    initWS();
  } catch (err) {
    showToast('Camera denied: ' + err.message);
  }
});

skipBtn.addEventListener('click', () => {
  resetRound();
  wsSend({ type: 'skip' });
});

function switchScreen(from, to) {
  from.classList.remove('active');
  to.classList.add('active');
}

function initWS() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    setStatus('searching', 'Finding match...');
    wsSend({ type: 'find_match' });
  };
  ws.onmessage = async e => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'matched':
        roomId = msg.room;
        setStatus('live', 'Matched!');
        waitingOvl.classList.add('hidden');
        await setupPeer(msg.initiator);
        break;
      case 'signal':
        if (!peerConn) break;
        if (msg.sdp) {
          await peerConn.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          if (msg.sdp.type === 'offer') {
            const answer = await peerConn.createAnswer();
            await peerConn.setLocalDescription(answer);
            wsSend({ type: 'signal', sdp: peerConn.localDescription });
          }
        }
        if (msg.candidate) await peerConn.addIceCandidate(new RTCIceCandidate(msg.candidate));
        break;
      case 'scores':
        displayScore('you', msg.yourScore);
        displayScore('opp', msg.oppScore);
        showVerdict(msg.yourScore, msg.oppScore);
        break;
      case 'opponent_left':
        resetRound();
        setStatus('searching', 'Opponent left. Finding new match...');
        wsSend({ type: 'find_match' });
        break;
      case 'status':
        setStatus('searching', msg.msg);
        break;
    }
  };
  ws.onclose = () => setStatus('idle', 'Disconnected');
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

async function setupPeer(initiator) {
  peerConn = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));
  peerConn.ontrack = e => { remoteVideo.srcObject = e.streams[0]; };
  peerConn.onicecandidate = e => { if (e.candidate) wsSend({ type: 'signal', candidate: e.candidate }); };
  peerConn.onconnectionstatechange = () => {
    if (peerConn.connectionState === 'connected') { setStatus('live', 'Live'); startRound(); }
  };
  if (initiator) {
    const offer = await peerConn.createOffer();
    await peerConn.setLocalDescription(offer);
    wsSend({ type: 'signal', sdp: peerConn.localDescription });
  }
}

function startRound() {
  secondsLeft = ROUND_SECONDS;
  updateTimerUI(secondsLeft);
  clearInterval(roundTimer);
  roundTimer = setInterval(() => {
    secondsLeft--;
    updateTimerUI(secondsLeft);
    if (secondsLeft <= 0) { clearInterval(roundTimer); endRound(); }
  }, 1000);
  clearTimeout(scanTimeout);
  scanTimeout = setTimeout(sendSnapshot, SCAN_DELAY_MS);
}

function endRound() {
  showToast('Round over! Finding next match...');
  setTimeout(() => { resetRound(); wsSend({ type: 'find_match' }); }, 2000);
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

function sendSnapshot() {
  const frame = captureFrame(localVideo, localCanvas);
  wsSend({ type: 'analyze_frame', frame });
}

function captureFrame(video, canvas) {
  canvas.width  = video.videoWidth  || 320;
  canvas.height = video.videoHeight || 240;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.7);
}

function displayScore(who, score) {
  const tier = getTier(score);
  const num  = who === 'you' ? yourScoreEl : oppScoreEl;
  const lbl  = who === 'you' ? yourTierEl  : oppTierEl;
  const bar  = who === 'you' ? yourBarEl   : oppBarEl;
  animateNumber(num, score);
  lbl.textContent = tier.label;
  lbl.className = 'score-tier tier-' + tier.css;
  bar.className = 'score-bar-fill bar-' + tier.css;
  bar.style.width = (score / 10 * 100) + '%';
}

function animateNumber(el, target) {
  let i = 0;
  const steps = 20;
  const iv = setInterval(() => {
    el.textContent = ((target / steps) * ++i).toFixed(1);
    if (i >= steps) { clearInterval(iv); el.textContent = target.toFixed(1); }
  }, 40);
}

function resetScoreUI(who) {
  (who === 'you' ? yourScoreEl : oppScoreEl).textContent = '—';
  const lbl = who === 'you' ? yourTierEl : oppTierEl;
  const bar = who === 'you' ? yourBarEl  : oppBarEl;
  lbl.textContent = who === 'you' ? 'Scanning...' : 'Waiting...';
  lbl.className = 'score-tier';
  bar.className = 'score-bar-fill';
  bar.style.width = '0%';
}

function showVerdict(mine, theirs) {
  verdictBanner.classList.remove('hidden');
  const diff = mine - theirs;
  if (Math.abs(diff) < 0.3) {
    verdictIcon.textContent = '⚖️'; verdictTextEl.textContent = 'EVEN MOG — Balanced encounter';
  } else if (diff > 0) {
    verdictIcon.textContent = '👑'; verdictTextEl.textContent = `YOU MOG (+${diff.toFixed(1)})`;
  } else {
    verdictIcon.textContent = '💀'; verdictTextEl.textContent = `YOU GOT MOGGED (${diff.toFixed(1)})`;
  }
}

function updateTimerUI(s) {
  timerNum.textContent = s;
  timerRing.style.strokeDashoffset = CIRC - (s / ROUND_SECONDS) * CIRC;
  timerRing.style.stroke = s <= 10 ? 'var(--danger)' : 'var(--accent)';
}

function setStatus(state, text) {
  statusDot.className = state !== 'idle' ? state : '';
  statusText.textContent = text;
}

let toastTimer;
function showToast(msg, ms = 3000) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), ms);
}
