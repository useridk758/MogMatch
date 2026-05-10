"""
MogMatch — server.py
FastAPI + WebSockets signaling server.
Handles: matchmaking, WebRTC signaling, AI frame scoring,
         solo scoring, leaderboard endpoints, static file serving.

Run:
    uvicorn server:app --host 0.0.0.0 --port 3000 --reload
"""

import asyncio
import base64
import json
import logging
import random
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

# ── Optional AI dependencies ────────────────────────────────────
try:
    from deepface import DeepFace
    import cv2
    import numpy as np
    DEEPFACE_AVAILABLE = True
    logging.info("[scorer] DeepFace available")
except ImportError:
    DEEPFACE_AVAILABLE = False
    logging.warning("[scorer] DeepFace not installed — using heuristic scorer")

# ── Logging setup ───────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("mogmatch")

# ═══════════════════════════════════════════════════════════════
# APP SETUP
# ═══════════════════════════════════════════════════════════════
app = FastAPI(title="MogMatch", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

HERE = Path(__file__).parent

# ── Static file routes ──────────────────────────────────────────
SERVE_EXTS = {".html", ".css", ".js", ".ico", ".png", ".jpg", ".svg", ".webp"}

@app.get("/")
async def serve_index():
    return FileResponse(str(HERE / "index.html"))

@app.get("/{filename}")
async def serve_static(filename: str):
    path = HERE / filename
    if path.exists() and path.suffix in SERVE_EXTS:
        return FileResponse(str(path))
    raise HTTPException(status_code=404, detail="Not found")

# ═══════════════════════════════════════════════════════════════
# TIER DEFINITIONS (mirrors client-side)
# ═══════════════════════════════════════════════════════════════
TIERS = [
    {"key": "chad",      "label": "Chad",      "min": 9.0},
    {"key": "chadlite",  "label": "Chad-Lite", "min": 8.0},
    {"key": "htn",       "label": "HTN",       "min": 7.0},
    {"key": "mtn",       "label": "MTN",       "min": 6.0},
    {"key": "ltn",       "label": "LTN",       "min": 5.0},
    {"key": "sub5",      "label": "Sub-5",     "min": 3.0},
    {"key": "sub3",      "label": "Sub-3",     "min": 0.0},
]

def get_tier(score: float) -> dict:
    for t in TIERS:
        if score >= t["min"]:
            return t
    return TIERS[-1]

# ═══════════════════════════════════════════════════════════════
# IN-MEMORY STATE
# ═══════════════════════════════════════════════════════════════
# Queue of WebSockets waiting to be matched
match_queue: deque = deque()

# Active rooms: room_id -> {members, frames, scores, created_at}
rooms: Dict[str, dict] = {}

# WebSocket -> room_id
ws_room: Dict[int, str] = {}

# In-memory leaderboard (resets on restart; use DB for production)
leaderboard: List[dict] = []

# ═══════════════════════════════════════════════════════════════
# LEADERBOARD REST ENDPOINTS
# ═══════════════════════════════════════════════════════════════
@app.get("/api/leaderboard")
async def get_leaderboard(limit: int = 50, sort: str = "score"):
    entries = sorted(leaderboard, key=lambda e: -e["score"] if sort == "score" else -e["ts"])
    return JSONResponse({"entries": entries[:limit]})

@app.post("/api/leaderboard")
async def post_leaderboard(data: dict):
    name  = str(data.get("name",  "Anonymous"))[:20].strip() or "Anonymous"
    score = float(data.get("score", 5.0))
    score = max(0.0, min(10.0, score))
    tier  = get_tier(score)
    entry = {
        "id":    str(uuid.uuid4())[:8],
        "name":  name,
        "score": round(score, 2),
        "tier":  tier["key"],
        "ts":    int(time.time() * 1000),
    }
    leaderboard.append(entry)
    leaderboard.sort(key=lambda e: -e["score"])
    if len(leaderboard) > 500:
        leaderboard[:] = leaderboard[:500]
    log.info(f"[LB] {name} → {score} ({tier['label']})")
    return JSONResponse({"ok": True, "entry": entry})

# ═══════════════════════════════════════════════════════════════
# SCORING ENGINE
# ═══════════════════════════════════════════════════════════════
def _rand_score(bias: float = 5.5, spread: float = 2.0) -> float:
    """Gaussian random score centered on bias."""
    score = random.gauss(bias, spread)
    return round(max(0.0, min(10.0, score)), 2)

def _compute_deepface_score(analysis: dict) -> float:
    """Map DeepFace analysis dict to 0-10 PSL proxy score."""
    base = 5.2

    # ── Emotion component ────────────────────────────────────
    emotion_weights = {
        "neutral":  0.6,
        "happy":    0.9,
        "calm":     0.5,
        "surprise": 0.0,
        "sad":     -0.9,
        "fear":    -1.1,
        "angry":   -0.6,
        "disgust": -1.0,
    }
    dominant = str(analysis.get("dominant_emotion", "neutral")).lower()
    base += emotion_weights.get(dominant, 0.0)

    # ── Age component ────────────────────────────────────────
    age = float(analysis.get("age", 25))
    if   18 <= age <= 24: base += 0.9
    elif 24 <  age <= 30: base += 0.6
    elif 30 <  age <= 38: base += 0.2
    elif 38 <  age <= 50: base -= 0.3
    elif age > 50:        base -= 0.7
    elif age < 18:        base -= 0.4

    # ── Face region size (proxy for clarity/centrality) ──────
    region = analysis.get("region", {})
    w = float(region.get("w", 0))
    h = float(region.get("h", 0))
    area = w * h
    if   area > 50000: base += 0.7
    elif area > 25000: base += 0.3
    elif area < 5000:  base -= 0.5

    # ── Gaussian noise for natural variance ──────────────────
    base += random.gauss(0, 0.55)

    return round(max(0.0, min(10.0, base)), 2)

def _score_b64_frame(b64_str: str) -> float:
    """Decode a base64 image and score it. Falls back gracefully."""
    if not b64_str:
        return _rand_score()

    # Strip data URI prefix if present
    if "," in b64_str:
        b64_str = b64_str.split(",", 1)[1]

    if not DEEPFACE_AVAILABLE:
        return _rand_score()

    try:
        img_bytes = base64.b64decode(b64_str)
        np_arr    = np.frombuffer(img_bytes, np.uint8)
        img       = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        if img is None or img.size == 0:
            log.warning("[scorer] Could not decode image")
            return _rand_score()

        results = DeepFace.analyze(
            img_path          = img,
            actions           = ["age", "emotion"],
            enforce_detection = False,
            silent            = True,
        )

        if isinstance(results, list):
            results = results[0]

        score = _compute_deepface_score(results)
        log.info(f"[scorer] DeepFace → {score} "
                 f"(emotion={results.get('dominant_emotion')}, age={results.get('age')})")
        return score

    except Exception as exc:
        log.warning(f"[scorer] DeepFace error: {exc}")
        return _rand_score()

async def score_frame_async(b64: str) -> float:
    """Run scoring in thread pool to avoid blocking."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _score_b64_frame, b64)

# ═══════════════════════════════════════════════════════════════
# MATCHMAKING HELPERS
# ═══════════════════════════════════════════════════════════════
async def safe_send(ws: WebSocket, msg: dict) -> bool:
    """Send JSON message, return False if connection broken."""
    try:
        await ws.send_text(json.dumps(msg))
        return True
    except Exception:
        return False

async def is_alive(ws: WebSocket) -> bool:
    """Ping a socket to check it's still open."""
    return await safe_send(ws, {"type": "ping"})

async def leave_room(ws: WebSocket) -> None:
    """Remove a socket from its current room, notify partner."""
    rid = ws_room.pop(id(ws), None)
    if not rid or rid not in rooms:
        return

    room = rooms[rid]
    partner = next((m for m in room["members"] if m is not ws), None)

    if partner:
        ws_room.pop(id(partner), None)
        await safe_send(partner, {"type": "opponent_left"})

    rooms.pop(rid, None)
    log.info(f"[room] {rid} closed")

async def remove_from_queue(ws: WebSocket) -> None:
    try:
        match_queue.remove(ws)
    except ValueError:
        pass

async def do_matchmaking(ws: WebSocket) -> None:
    """Try to pair ws with a queued socket."""
    # Remove any stale self entries
    await remove_from_queue(ws)
    await leave_room(ws)

    partner: Optional[WebSocket] = None

    # Find a live partner
    while match_queue:
        candidate = match_queue.popleft()
        if candidate is ws:
            continue
        if await is_alive(candidate):
            partner = candidate
            break
        else:
            ws_room.pop(id(candidate), None)
            log.info("[queue] Removed dead socket from queue")

    if partner:
        room_id = str(uuid.uuid4())[:8]
        rooms[room_id] = {
            "members":    [ws, partner],
            "frames":     {},
            "scores":     {},
            "created_at": time.time(),
        }
        ws_room[id(ws)]      = room_id
        ws_room[id(partner)] = room_id

        await safe_send(ws,      {"type": "matched", "room": room_id, "initiator": True})
        await safe_send(partner, {"type": "matched", "room": room_id, "initiator": False})
        log.info(f"[match] {room_id}: {id(ws)} <-> {id(partner)}")
    else:
        match_queue.append(ws)
        pos = list(match_queue).index(ws) + 1
        await safe_send(ws, {"type": "queued", "position": pos, "msg": f"In queue (#{pos})..."})
        log.info(f"[queue] Added socket, depth={len(match_queue)}")

async def handle_analyze_frame(ws: WebSocket, msg: dict) -> None:
    """Score both frames when both users have submitted."""
    rid = ws_room.get(id(ws))
    if not rid or rid not in rooms:
        return

    room = rooms[rid]
    frame = msg.get("frame", "")
    room["frames"][id(ws)] = frame

    if len(room["frames"]) >= 2:
        members = room["members"]
        if len(members) < 2:
            return

        ws1, ws2 = members[0], members[1]
        b1 = room["frames"].get(id(ws1), "")
        b2 = room["frames"].get(id(ws2), "")

        log.info(f"[score] Scoring room {rid}...")
        s1, s2 = await asyncio.gather(
            score_frame_async(b1),
            score_frame_async(b2),
        )

        room["scores"] = {id(ws1): s1, id(ws2): s2}
        log.info(f"[score] {rid}: {s1} / {s2}")

        await safe_send(ws1, {"type": "scores", "yourScore": s1, "oppScore": s2})
        await safe_send(ws2, {"type": "scores", "yourScore": s2, "oppScore": s1})

# ═══════════════════════════════════════════════════════════════
# WEBSOCKET ENDPOINT
# ═══════════════════════════════════════════════════════════════
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    log.info(f"[ws] Connected: {id(ws)}")

    try:
        while True:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=60.0)

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await safe_send(ws, {"type": "error", "msg": "Invalid JSON"})
                continue

            kind = msg.get("type", "")

            # ── Find match ──────────────────────────────────
            if kind == "find_match":
                log.info(f"[ws] {id(ws)} find_match")
                await do_matchmaking(ws)

            # ── WebRTC signal passthrough ───────────────────
            elif kind == "signal":
                rid = ws_room.get(id(ws))
                if rid and rid in rooms:
                    room = rooms[rid]
                    partner = next((m for m in room["members"] if m is not ws), None)
                    if partner:
                        await safe_send(partner, {
                            "type":      "signal",
                            "sdp":       msg.get("sdp"),
                            "candidate": msg.get("candidate"),
                        })

            # ── Frame analysis (arena) ──────────────────────
            elif kind == "analyze_frame":
                asyncio.create_task(handle_analyze_frame(ws, msg))

            # ── Solo score ──────────────────────────────────
            elif kind == "solo_score":
                frame = msg.get("frame", "")
                log.info(f"[solo] Scoring solo frame...")
                score = await score_frame_async(frame)
                log.info(f"[solo] Score: {score}")
                await safe_send(ws, {"type": "solo_score", "score": score})

            # ── Skip ────────────────────────────────────────
            elif kind == "skip":
                log.info(f"[ws] {id(ws)} skip")
                await leave_room(ws)
                await do_matchmaking(ws)

            # ── Pong (response to server ping) ──────────────
            elif kind == "pong":
                pass

            else:
                log.warning(f"[ws] Unknown message type: {kind}")

    except asyncio.TimeoutError:
        log.info(f"[ws] {id(ws)} timed out (60s no message)")
    except WebSocketDisconnect:
        log.info(f"[ws] {id(ws)} disconnected")
    except Exception as exc:
        log.error(f"[ws] {id(ws)} error: {exc}")
    finally:
        await leave_room(ws)
        await remove_from_queue(ws)
        log.info(f"[ws] {id(ws)} cleaned up")

# ═══════════════════════════════════════════════════════════════
# BACKGROUND TASK — clean stale rooms
# ═══════════════════════════════════════════════════════════════
async def cleanup_stale_rooms():
    """Remove rooms older than 10 minutes every 2 minutes."""
    while True:
        await asyncio.sleep(120)
        now = time.time()
        stale = [rid for rid, r in rooms.items() if now - r["created_at"] > 600]
        for rid in stale:
            log.info(f"[cleanup] Removing stale room {rid}")
            room = rooms.pop(rid, {})
            for m in room.get("members", []):
                ws_room.pop(id(m), None)

@app.on_event("startup")
async def startup():
    asyncio.create_task(cleanup_stale_rooms())
    log.info("MogMatch server started")

# ═══════════════════════════════════════════════════════════════
# HEALTH CHECK
# ═══════════════════════════════════════════════════════════════
@app.get("/health")
async def health():
    return {
        "status":       "ok",
        "queue":        len(match_queue),
        "rooms":        len(rooms),
        "leaderboard":  len(leaderboard),
        "deepface":     DEEPFACE_AVAILABLE,
    }
