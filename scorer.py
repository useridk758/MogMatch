#!/usr/bin/env python3
"""
MogMatch — scorer.py
Receives JSON { "frames": ["<base64>", "<base64>"] } on stdin.
Returns JSON { "scores": [float, float] } on stdout.

Uses DeepFace for facial analysis + a scoring formula that maps
detected attributes to a 0–10 attractiveness-proxy score.

Install deps:
    pip install deepface opencv-python-headless numpy

Note: DeepFace downloads model weights on first run (~300 MB).
For production, pre-download weights or swap in your own model.
"""

import sys
import json
import base64
import tempfile
import os
import random

# ─── Attempt DeepFace import; fall back to random if unavailable ───
try:
    from deepface import DeepFace
    import cv2
    import numpy as np
    DEEPFACE_AVAILABLE = True
except ImportError:
    DEEPFACE_AVAILABLE = False


# ────────────────────────────────────────────────────────────
# TIER BOUNDARIES (informational, scoring is continuous 0-10)
# ────────────────────────────────────────────────────────────
TIERS = [
    (9.0, "Chad"),
    (8.0, "Chad-Lite"),
    (7.0, "HTN"),
    (6.0, "MTN"),
    (5.0, "LTN"),
    (3.0, "Sub-5"),
    (0.0, "Sub-3"),
]

def get_tier(score: float) -> str:
    for threshold, label in TIERS:
        if score >= threshold:
            return label
    return "Sub-3"


# ────────────────────────────────────────────────────────────
# SCORING FORMULA
# ────────────────────────────────────────────────────────────
def compute_score_from_analysis(analysis: dict) -> float:
    """
    Maps DeepFace analysis attributes to a 0–10 proxy score.
    
    Factors used:
      - Dominant emotion  (calm/neutral/happy boosted; fear/sad/angry penalized)
      - Age symmetry      (youth slightly boosted; extreme ages penalized)
      - Face confidence   (detection confidence from DeepFace)
    
    This is a heuristic proxy, NOT a true attractiveness model.
    Replace with a dedicated model for production use.
    """

    base = 5.0  # start at average

    # ── Emotion bonus/penalty ────────────────────────────
    emotion_map = {
        "neutral":   0.5,
        "happy":     0.8,
        "calm":      0.6,
        "surprise":  0.0,
        "sad":      -0.8,
        "fear":     -1.0,
        "angry":    -0.5,
        "disgust":  -0.8,
    }
    dominant_emotion = analysis.get("dominant_emotion", "neutral").lower()
    base += emotion_map.get(dominant_emotion, 0.0)

    # ── Age factor ───────────────────────────────────────
    age = analysis.get("age", 25)
    if   18 <= age <= 28: age_bonus =  0.8
    elif 28 <  age <= 35: age_bonus =  0.4
    elif 35 <  age <= 45: age_bonus =  0.0
    elif age  > 45:       age_bonus = -0.4
    else:                 age_bonus = -0.2   # <18 shouldn't happen
    base += age_bonus

    # ── Face region size as proxy for camera clarity ─────
    region = analysis.get("region", {})
    w = region.get("w", 0)
    h = region.get("h", 0)
    face_area = w * h
    if face_area > 40000:  base += 0.5
    elif face_area > 20000: base += 0.2

    # ── Add controlled noise for variety ─────────────────
    noise = random.gauss(0, 0.6)
    base += noise

    return round(max(0.0, min(10.0, base)), 2)


def analyze_frame(b64_str: str) -> float:
    """Decode base64 image, run DeepFace, return score 0-10."""
    img_bytes = base64.b64decode(b64_str)
    np_arr    = np.frombuffer(img_bytes, np.uint8)
    img       = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

    if img is None:
        return round(random.uniform(3.0, 7.0), 2)

    try:
        results = DeepFace.analyze(
            img_path   = img,
            actions    = ['age', 'emotion'],
            enforce_detection = False,
            silent     = True,
        )
        # analyze returns list when multiple faces detected; use first
        if isinstance(results, list):
            results = results[0]
        return compute_score_from_analysis(results)

    except Exception as e:
        print(f"[scorer] DeepFace error: {e}", file=sys.stderr)
        return round(random.uniform(3.0, 7.0), 2)


def fallback_score(_b64_str: str) -> float:
    """Random score when DeepFace isn't installed."""
    return round(random.uniform(2.0, 9.5), 2)


# ────────────────────────────────────────────────────────────
# MAIN
# ────────────────────────────────────────────────────────────
def main():
    raw = sys.stdin.read().strip()
    if not raw:
        print(json.dumps({"error": "no input"}))
        sys.exit(1)

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"JSON parse error: {e}"}))
        sys.exit(1)

    frames = payload.get("frames", [])
    scores = []

    scorer = analyze_frame if DEEPFACE_AVAILABLE else fallback_score

    for f in frames:
        try:
            score = scorer(f)
        except Exception as e:
            print(f"[scorer] frame error: {e}", file=sys.stderr)
            score = round(random.uniform(3.0, 7.0), 2)
        scores.append(score)

    # Pad if needed
    while len(scores) < 2:
        scores.append(round(random.uniform(3.0, 7.0), 2))

    print(json.dumps({"scores": scores[:2]}))


if __name__ == "__main__":
    main()
