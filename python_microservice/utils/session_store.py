"""
session_store.py
================
In-memory registry of active GazeSession objects, keyed by student_id.

FastAPI is stateless between requests but runs in a single process,
so a module-level dict is safe for a single-worker dev/prototype deployment.

If you scale to multiple uvicorn workers, replace this with Redis.
"""

from utils.gaze_tracker import GazeSession

_sessions = {}   # student_id -> GazeSession


def get_or_create(student_id):
    if student_id not in _sessions:
        _sessions[student_id] = GazeSession(student_id)
    return _sessions[student_id]


def get(student_id):
    return _sessions.get(student_id)


def end_session(student_id):
    session = _sessions.pop(student_id, None)
    if session:
        summary = session.summary()
        session.close()
        return summary
    return None


def active_sessions():
    return list(_sessions.keys())