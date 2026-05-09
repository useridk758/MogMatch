/**
 * MogMatch — index.js
 * Express + Socket.IO WebRTC signaling server.
 * Receives frame snapshots, sends them to Python AI scorer,
 * broadcasts scores back to both peers in the room.
 */

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');
const { spawn } = require('child_process');

// ────────────────────────────────────────────────────────────
// APP SETUP
// ────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 5e6   // 5 MB for base64 frames
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '.')));

// ────────────────────────────────────────────────────────────
// MATCHMAKING STATE
// ────────────────────────────────────────────────────────────
/** @type {string[]} socket IDs waiting for a match */
const queue = [];

/** @type {Map<string, { members: string[], frames: Map<string,string>, scores: Map<string,number> }>} */
const rooms = new Map();

// ────────────────────────────────────────────────────────────
// SOCKET HANDLERS
// ────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Find a match ────────────────────────────────────────
  socket.on('find_match', () => {
    // Remove from any existing room
    leaveCurrentRoom(socket);

    if (queue.length > 0) {
      const partnerId = queue.shift();
      const partner   = io.sockets.sockets.get(partnerId);
      if (!partner) {
        // Partner disconnected, try again next request
        queue.push(socket.id);
        return;
      }

      const roomId = `room_${Date.now()}`;
      rooms.set(roomId, {
        members: [socket.id, partnerId],
        frames:  new Map(),
        scores:  new Map(),
      });

      socket.join(roomId);
      partner.join(roomId);

      socket.data.room  = roomId;
      partner.data.room = roomId;

      // Initiator drives offer/answer
      socket.emit('matched',  { room: roomId, initiator: true  });
      partner.emit('matched', { room: roomId, initiator: false });

      console.log(`[match] ${socket.id} <-> ${partnerId} in ${roomId}`);
    } else {
      queue.push(socket.id);
      socket.emit('status', { msg: 'In queue...' });
    }
  });

  // ── WebRTC signaling passthrough ────────────────────────
  socket.on('signal', ({ room, sdp, candidate }) => {
    socket.to(room).emit('signal', { sdp, candidate });
  });

  // ── Frame for AI analysis ───────────────────────────────
  socket.on('analyze_frame', ({ room, frame }) => {
    const roomData = rooms.get(room);
    if (!roomData) return;

    roomData.frames.set(socket.id, frame);

    // Once both frames received, score both
    if (roomData.frames.size === roomData.members.length) {
      const [id1, id2] = roomData.members;
      const frames = [
        roomData.frames.get(id1),
        roomData.frames.get(id2),
      ];
      scoreFrames(frames)
        .then(([score1, score2]) => {
          roomData.scores.set(id1, score1);
          roomData.scores.set(id2, score2);

          // Send each user their own score and opponent's
          const s1 = io.sockets.sockets.get(id1);
          const s2 = io.sockets.sockets.get(id2);
          if (s1) s1.emit('scores', { yourScore: score1, oppScore: score2 });
          if (s2) s2.emit('scores', { yourScore: score2, oppScore: score1 });

          console.log(`[scores] ${roomData.members} → ${score1.toFixed(2)} / ${score2.toFixed(2)}`);
        })
        .catch(err => {
          console.error('[scorer]', err);
          // Fallback: random scores so UI still works
          const [s1, s2] = [randScore(), randScore()];
          io.to(id1).emit('scores', { yourScore: s1, oppScore: s2 });
          io.to(id2).emit('scores', { yourScore: s2, oppScore: s1 });
        });
    }
  });

  // ── Skip ────────────────────────────────────────────────
  socket.on('skip', () => {
    leaveCurrentRoom(socket);
    queue.push(socket.id);
    socket.emit('status', { msg: 'In queue...' });
  });

  // ── Disconnect ──────────────────────────────────────────
  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
    const qi = queue.indexOf(socket.id);
    if (qi !== -1) queue.splice(qi, 1);
    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

// ────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────
function leaveCurrentRoom(socket) {
  const room = socket.data.room;
  if (!room) return;
  socket.to(room).emit('opponent_left');
  socket.leave(room);
  socket.data.room = null;

  const roomData = rooms.get(room);
  if (roomData) {
    roomData.members = roomData.members.filter(id => id !== socket.id);
    if (roomData.members.length === 0) rooms.delete(room);
  }
}

function randScore() {
  return Math.round((Math.random() * 10) * 10) / 10;
}

// ────────────────────────────────────────────────────────────
// PYTHON AI SCORER  (spawns scorer.py)
// ────────────────────────────────────────────────────────────
/**
 * Sends two base64 JPEG frames to scorer.py via stdin (JSON),
 * receives JSON { scores: [float, float] } on stdout.
 * @param {string[]} frames  base64 data URIs
 * @returns {Promise<[number, number]>}
 */
function scoreFrames(frames) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      frames: frames.map(f => f.replace(/^data:image\/\w+;base64,/, ''))
    });

    const py = spawn('python3', ['scorer.py']);
    let stdout = '';
    let stderr = '';

    py.stdout.on('data', d => { stdout += d.toString(); });
    py.stderr.on('data', d => { stderr += d.toString(); });

    py.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`scorer.py exited ${code}: ${stderr}`));
      }
      try {
        const { scores } = JSON.parse(stdout.trim());
        resolve([
          Math.min(10, Math.max(0, scores[0])),
          Math.min(10, Math.max(0, scores[1])),
        ]);
      } catch (e) {
        reject(new Error('Bad JSON from scorer.py: ' + stdout));
      }
    });

    py.stdin.write(payload);
    py.stdin.end();
  });
}

// ────────────────────────────────────────────────────────────
// START
// ────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`MogMatch running → http://localhost:${PORT}`);
});
