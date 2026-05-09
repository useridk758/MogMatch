"""
MogMatch — server.py
FastAPI + WebSockets server. Replaces index.js entirely.
No Node.js required.

Run:
    uvicorn server:app --host 0.0.0.0 --port 3000 --reload
"""

import asyncio
import base64
import json
import random
import uuid
from collections import deque
from typing import Dict, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

# ── Optional DeepFace ────────────────────────────────────────
try:
    from deepface import DeepFace
    import cv2
    import numpy as np
    DEEPFACE_AVAILABLE = True
except ImportError:
    DEEPFACE_AVAILABLE = False

# ────────────────────────────────────────────────────────────
app = FastAPI()

# Serve frontend static files (index.html, style.css, script.js)
app.mount("/static", StaticFiles(directory=".", html=True), name="static")

# ────────────────────────────────────────────────────────────
# STATE
# ────────────────────────────────────────────────────────────
queue: deque[WebSocket] = deque()

class Room:
    def __init__(self, room_id: str, members: List[WebSocket]):
        self.room_id  = room_id
        self.members  = members          # [ws1, ws2]
        self.frames:  Dict[int, str] = {}  # id(ws) -> b64 frame

rooms: Dict[str, Room] = {}
ws_to_room: Dict[int, str] = {}          # id(ws) -> room_id

# ────────────────────────────────────────────────────────────
# HELPERS
# ────────────────────────────────────────────────────────────
async def send(ws: WebSocket, msg: dict):
    try:
        await ws.send_text(json.dumps(msg))
    except Exception:
        pass

def rand_score() -> float:
    return round(random.uniform(2.5, 9.5), 2)

def get_partner(room: Room, ws: WebSocket) -> Optional[WebSocket]:
    for m in room.members:
        if m is not ws:
            return m
    return None

async def leave_room(ws: WebSocket):
    rid = ws_to_room.pop(id(ws), None)
    if not rid or rid not in rooms:
        return
    room = rooms[rid]
    partner = get_partner(room, ws)
    if partner:
        await send(partner, {"type": "opponent_left"})
        ws_to_room.pop(id(partner), None)
    del rooms[rid]

# ────────────────────────────────────────────────────────────
# AI SCORING
# ────────────────────────────────────────────────────────────
def compute_score(analysis: dict) -> float:
    base = 5.0
    emotion_map = {
        "neutral": 0.5, "happy": 0.8, "calm": 0.6,
        "surprise": 0.0, "sad": -0.8, "fear": -1.0,
        "angry": -0.5, "disgust": -0.8,
    }
    emotion = analysis.get("dominant_emotion", "neutral").lower()
    base += emotion_map.get(emotion, 0.0)

    age = analysis.get("age", 25)
    if   18 <= age <= 28: base += 0.8
    elif 28 <  age <= 35: base += 0.4
    elif 35 <  age <= 45: base += 0.0
    else:                 base -= 0.4

    region = analysis.get("region", {})
    area = region.get("w", 0) * region.get("h", 0)
    if area > 40000:   base += 0.5
    elif area > 20000: base += 0.2

    base += random.gauss(0, 0.6)
    return round(max(0.0, min(10.0, base)), 2)

def score_frame(b64: str) -> float:
    if not DEEPFACE_AVAILABLE:
        return rand_score()
    try:
        img_bytes = base64.b64decode(b64)
        np_arr    = np.frombuffer(img_bytes, np.uint8)
        img       = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        if img is None:
            return rand_score()
        result = DeepFace.analyze(
            img_path=img,
            actions=["age", "emotion"],
            enforce_detection=False,
            silent=True,
        )
        if isinstance(result, list):
            result = result[0]
        return compute_score(result)
    except Exception:
        return rand_score()

async def score_and_broadcast(room: Room):
    ws1, ws2 = room.members
    b64_1 = room.frames.get(id(ws1), "")
    b64_2 = room.frames.get(id(ws2), "")

    # Run blocking DeepFace in thread pool
    loop = asyncio.get_event_loop()
    s1, s2 = await asyncio.gather(
        loop.run_in_executor(None, score_frame, b64_1),
        loop.run_in_executor(None, score_frame, b64_2),
    )

    await send(ws1, {"type": "scores", "yourScore": s1, "oppScore": s2})
    await send(ws2, {"type": "scores", "yourScore": s2, "oppScore": s1})

# ────────────────────────────────────────────────────────────
# WEBSOCKET ENDPOINT
# ────────────────────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            raw  = await ws.receive_text()
            msg  = json.loads(raw)
            kind = msg.get("type")

            # ── Find match ──────────────────────────────────
            if kind == "find_match":
                await leave_room(ws)

                # Remove stale entries from queue
                stale = [q for q in queue if q is ws]
                for s in stale:
                    queue.remove(s)

                if queue:
                    partner = queue.popleft()
                    room_id = str(uuid.uuid4())[:8]
                    room    = Room(room_id, [ws, partner])
                    rooms[room_id]    = room
                    ws_to_room[id(ws)]      = room_id
                    ws_to_room[id(partner)] = room_id

                    await send(ws,      {"type": "matched", "room": room_id, "initiator": True})
                    await send(partner, {"type": "matched", "room": room_id, "initiator": False})
                else:
                    queue.append(ws)
                    await send(ws, {"type": "status", "msg": "In queue..."})

            # ── WebRTC signal passthrough ────────────────────
            elif kind == "signal":
                rid = ws_to_room.get(id(ws))
                if rid and rid in rooms:
                    partner = get_partner(rooms[rid], ws)
                    if partner:
                        await send(partner, {
                            "type":      "signal",
                            "sdp":       msg.get("sdp"),
                            "candidate": msg.get("candidate"),
                        })

            # ── Frame for AI analysis ────────────────────────
            elif kind == "analyze_frame":
                rid = ws_to_room.get(id(ws))
                if rid and rid in rooms:
                    room = rooms[rid]
                    room.frames[id(ws)] = msg.get("frame", "")
                    if len(room.frames) >= 2:
                        asyncio.create_task(score_and_broadcast(room))

            # ── Skip ────────────────────────────────────────
            elif kind == "skip":
                await leave_room(ws)
                queue.append(ws)
                await send(ws, {"type": "status", "msg": "In queue..."})

    except WebSocketDisconnect:
        await leave_room(ws)
        try:
            queue.remove(ws)
        except ValueError:
            pass
    except Exception:
        await leave_room(ws)
