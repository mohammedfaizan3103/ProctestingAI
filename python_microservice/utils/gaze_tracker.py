"""
gaze_tracker.py — corrected iris indices + normalized-space ratio math
"""

import time
import logging
import cv2
import numpy as np

logger = logging.getLogger("gaze_tracker")

try:
    import mediapipe as mp
    _mp_face_mesh = mp.solutions.face_mesh
    MEDIAPIPE_AVAILABLE = True
except ImportError:
    MEDIAPIPE_AVAILABLE = False
    logger.warning("mediapipe not installed — gaze tracking unavailable.")

# ---------------------------------------------------------------------------
# Correct MediaPipe iris landmark indices (refine_landmarks=True → 478 points)
# RIGHT_IRIS = 469-472, LEFT_IRIS = 474-477
# Index [0] of each group is the centre point
# ---------------------------------------------------------------------------
RIGHT_IRIS_CENTER = 473   # centre of right iris (from camera = person's right)
LEFT_IRIS_CENTER  = 468   # NOTE: 468 is actually right iris point 0 in older docs
                           # confirmed correct indices below:
RIGHT_IRIS = [469, 470, 471, 472]
LEFT_IRIS  = [474, 475, 476, 477]

# Eye corner landmarks (these are standard, same in all versions)
# Right eye (person's right, camera's left)
R_EYE_LEFT  = 33    # outer corner
R_EYE_RIGHT = 133   # inner corner (towards nose)
R_EYE_TOP   = 159
R_EYE_BOT   = 145

# Left eye (person's left, camera's right)
L_EYE_LEFT  = 362   # inner corner (towards nose)
L_EYE_RIGHT = 263   # outer corner
L_EYE_TOP   = 386
L_EYE_BOT   = 374

# ---------------------------------------------------------------------------
# Tuning — widen thresholds so normal straight-ahead gaze is comfortable
# ---------------------------------------------------------------------------
GAZE_H_MIN = 0.35   # h_ratio below this = looking left
GAZE_H_MAX = 0.65   # h_ratio above this = looking right
GAZE_V_MIN = 0.30   # v_ratio below this = looking up
GAZE_V_MAX = 0.70   # v_ratio above this = looking down

GRACE_PERIOD_S             = 1.5
W_TIME                     = 0.4
W_OFFENCE                  = 2.0
REPEAT_OFFENDER_THRESHOLD  = 5
REPEAT_OFFENDER_MULTIPLIER = 1.5


def _iris_center(landmarks, iris_indices):
    """Average the 4 iris landmarks to get a stable centre point (normalized coords)."""
    xs = [landmarks[i].x for i in iris_indices]
    ys = [landmarks[i].y for i in iris_indices]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def _gaze_direction(landmarks):
    """
    Compute gaze ratios entirely in normalized [0,1] landmark space.
    No pixel multiplication needed — ratios are dimensionless.

    Uses RIGHT eye (person's right) as primary because it's more stable
    for front-facing webcam shots where face is roughly centred.
    Falls back to averaging both eyes for robustness.
    """
    # --- Right eye ---
    rx_left  = landmarks[R_EYE_LEFT].x
    rx_right = landmarks[R_EYE_RIGHT].x
    ry_top   = landmarks[R_EYE_TOP].y
    ry_bot   = landmarks[R_EYE_BOT].y

    rix, riy = _iris_center(landmarks, RIGHT_IRIS)

    r_eye_w = abs(rx_right - rx_left)
    r_eye_h = abs(ry_bot   - ry_top)

    # --- Left eye ---
    lx_left  = landmarks[L_EYE_LEFT].x
    lx_right = landmarks[L_EYE_RIGHT].x
    ly_top   = landmarks[L_EYE_TOP].y
    ly_bot   = landmarks[L_EYE_BOT].y

    lix, liy = _iris_center(landmarks, LEFT_IRIS)

    l_eye_w = abs(lx_right - lx_left)
    l_eye_h = abs(ly_bot   - ly_top)

    if r_eye_w < 0.005 or l_eye_w < 0.005:
        return None   # eye too small / side profile — skip frame

    # Horizontal ratio: how far iris is across the eye opening (0=left, 1=right)
    # Right eye: left anchor is outer corner (lower x), right anchor is inner
    r_h = (rix - min(rx_left, rx_right)) / r_eye_w
    # Left eye: left anchor is inner corner, right is outer corner
    l_h = (lix - min(lx_left, lx_right)) / l_eye_w

    # Average both eyes for horizontal (they should agree; averaging reduces noise)
    h_ratio = (r_h + l_h) / 2.0

    # Vertical ratio: how far iris is top-to-bottom (0=up, 1=down)
    r_v = (riy - min(ry_top, ry_bot)) / r_eye_h if r_eye_h > 0.005 else 0.5
    l_v = (liy - min(ly_top, ly_bot)) / l_eye_h if l_eye_h > 0.005 else 0.5
    v_ratio = (r_v + l_v) / 2.0

    h_ratio = max(0.0, min(1.0, h_ratio))
    v_ratio = max(0.0, min(1.0, v_ratio))

    looking_away = (
        h_ratio < GAZE_H_MIN
        or h_ratio > GAZE_H_MAX
        or v_ratio < GAZE_V_MIN
        or v_ratio > GAZE_V_MAX
    )

    if not looking_away:
        direction = "center"
    elif h_ratio < GAZE_H_MIN:
        direction = "left"
    elif h_ratio > GAZE_H_MAX:
        direction = "right"
    elif v_ratio < GAZE_V_MIN:
        direction = "up"
    else:
        direction = "down"

    return {
        "h_ratio": round(h_ratio, 3),
        "v_ratio": round(v_ratio, 3),
        "direction": direction,
        "looking_away": looking_away,
    }


class GazeSession:
    def __init__(self, student_id):
        self.student_id         = student_id
        self.created_at         = time.time()
        self.offence_count      = 0
        self.total_away_seconds = 0.0
        self.events             = []
        self._looking_away        = False
        self._away_started_at     = None
        self._current_direction   = "center"
        self._current_away_logged = False

        if MEDIAPIPE_AVAILABLE:
            self._mesh = _mp_face_mesh.FaceMesh(
                static_image_mode=True,
                max_num_faces=1,
                refine_landmarks=True,        # essential for iris landmarks
                min_detection_confidence=0.5,
            )
        else:
            self._mesh = None

    def process_frame(self, frame_bgr, timestamp=None):
        if not MEDIAPIPE_AVAILABLE or self._mesh is None:
            return {"status": "error", "message": "mediapipe not available"}

        ts  = timestamp or time.time()
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        res = self._mesh.process(rgb)

        if not res.multi_face_landmarks:
            return self._handle_no_face(ts)

        landmarks = res.multi_face_landmarks[0].landmark
        gaze = _gaze_direction(landmarks)

        if gaze is None:
            # Side profile or closed eyes — treat as looking away
            return self._handle_no_face(ts)

        return self._update_state(gaze, ts)

    def _update_state(self, gaze, ts):
        looking_away = gaze["looking_away"]
        event_logged = False

        if looking_away and not self._looking_away:
            # Transition: center → looking away — start the timer
            self._looking_away      = True
            self._away_started_at   = ts
            self._current_direction = gaze["direction"]
            self._current_away_logged = False  # haven't logged this episode yet

        elif looking_away and self._looking_away:
            # Still looking away — update direction if changed
            self._current_direction = gaze["direction"]

            # If we've exceeded grace period and haven't logged this episode yet,
            # log the offence NOW (don't wait until they look back)
            ongoing_dur = ts - self._away_started_at
            if ongoing_dur >= GRACE_PERIOD_S and not self._current_away_logged:
                self.offence_count      += 1
                self._current_away_logged = True
                event_logged = True
                logger.info(
                    "gaze | student=%s | offence #%d (ongoing) | dir=%s | dur=%.1fs",
                    self.student_id, self.offence_count,
                    self._current_direction, ongoing_dur,
                )

        elif not looking_away and self._looking_away:
            # Transition: looking away → back to center — finalize the episode
            duration           = ts - self._away_started_at
            self._looking_away = False

            if duration >= GRACE_PERIOD_S:
                self.total_away_seconds += duration
                # If we didn't already count this as an offence while it was ongoing
                if not self._current_away_logged:
                    self.offence_count += 1
                    event_logged = True
                self.events.append({
                    "type":           "gaze_away",
                    "direction":      self._current_direction,
                    "duration_s":     round(duration, 2),
                    "timestamp":      ts,
                    "offence_number": self.offence_count,
                })
                logger.info(
                    "gaze | student=%s | offence #%d finalized | dir=%s | dur=%.1fs",
                    self.student_id, self.offence_count,
                    self._current_direction, duration,
                )

            self._current_away_logged = False

        # Compute live stats including any ongoing away episode
        live_away_s  = self.total_away_seconds
        live_offence = self.offence_count
        if self._looking_away and self._away_started_at is not None:
            ongoing = ts - self._away_started_at
            live_away_s += ongoing  # include current ongoing duration

        return {
            "status":        "ok",
            "looking_away":  looking_away,
            "direction":     gaze["direction"],
            "h_ratio":       gaze["h_ratio"],
            "v_ratio":       gaze["v_ratio"],
            "offence_count": live_offence,
            "total_away_s":  round(live_away_s, 2),
            "penalty_score": round(self._penalty_live(ts), 2),
            "event_logged":  event_logged,
        }

    def _handle_no_face(self, ts):
        if not self._looking_away:
            self._looking_away      = True
            self._away_started_at   = ts
            self._current_direction = "no_face"
            self._current_away_logged = False
        else:
            # Still no face — check if we should log the offence
            ongoing_dur = ts - self._away_started_at
            if ongoing_dur >= GRACE_PERIOD_S and not self._current_away_logged:
                self.offence_count += 1
                self._current_away_logged = True
                logger.info(
                    "gaze | student=%s | offence #%d (no_face, ongoing) | dur=%.1fs",
                    self.student_id, self.offence_count, ongoing_dur,
                )

        # Compute live stats including ongoing away episode
        live_away_s = self.total_away_seconds
        if self._looking_away and self._away_started_at is not None:
            live_away_s += (ts - self._away_started_at)

        return {
            "status":        "no_face",
            "looking_away":  True,
            "direction":     "no_face",
            "h_ratio":       None,
            "v_ratio":       None,
            "offence_count": self.offence_count,
            "total_away_s":  round(live_away_s, 2),
            "penalty_score": round(self._penalty_live(ts), 2),
            "event_logged":  False,
        }

    def _penalty(self):
        """Penalty based on finalized stats only (used in summary)."""
        base = (self.total_away_seconds * W_TIME) + (self.offence_count * W_OFFENCE)
        if self.offence_count >= REPEAT_OFFENDER_THRESHOLD:
            base *= REPEAT_OFFENDER_MULTIPLIER
        return base

    def _penalty_live(self, ts):
        """Penalty including any ongoing look-away episode."""
        away_s = self.total_away_seconds
        offences = self.offence_count
        if self._looking_away and self._away_started_at is not None:
            away_s += (ts - self._away_started_at)
        base = (away_s * W_TIME) + (offences * W_OFFENCE)
        if offences >= REPEAT_OFFENDER_THRESHOLD:
            base *= REPEAT_OFFENDER_MULTIPLIER
        return base

    def summary(self):
        return {
            "student_id":         self.student_id,
            "session_duration_s": round(time.time() - self.created_at, 1),
            "offence_count":      self.offence_count,
            "total_away_s":       round(self.total_away_seconds, 2),
            "penalty_score":      round(self._penalty(), 2),
            "events":             self.events,
        }

    def close(self):
        if self._mesh:
            self._mesh.close()
            self._mesh = None