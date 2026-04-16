# Gaze API Integration Guide

This guide explains the gaze endpoints exposed by the Python microservice and how to integrate them into the existing MERN proctoring flow.

## 1) Where These APIs Live

The gaze APIs are in the Python FastAPI service (default: `http://localhost:8000`).

Current app architecture:

- Frontend (React) talks to Node backend (`/api/...`)
- Node backend proxies proctoring calls to Python microservice
- Python returns gaze/face analysis results
- Node stores violations in MongoDB (`Attempt`, `ProctoringEvent`)

Recommended pattern: keep frontend calling Node only (same as current face flow), and let Node proxy to Python.

## 2) Gaze API Reference

## `POST /gaze/frame/{student_id}`

Send one webcam frame for gaze analysis.

Use case:

- Call periodically during exam (recommended every 5 seconds)

Request:

- Path param: `student_id` (string)
- Content-Type: `multipart/form-data`
- Form field: `file` (image: jpg/png)

Response (typical):

```json
{
  "status": "ok",
  "looking_away": false,
  "direction": "center",
  "h_ratio": 0.49,
  "v_ratio": 0.51,
  "offence_count": 0,
  "total_away_s": 0.0,
  "penalty_score": 0.0,
  "event_logged": false
}
```

Notes:

- Session auto-creates on first frame for that `student_id`
- `status` can be `ok`, `no_face`, or `error`

## `GET /gaze/summary/{student_id}`

Get current (mid-session) cumulative summary without closing session.

Use case:

- Poll for dashboard stats, or fetch summary before final submission

Response includes:

- `student_id`
- `session_duration_s`
- `offence_count`
- `total_away_s`
- `penalty_score`
- `events` (array)

## `POST /gaze/end/{student_id}`

Ends the active gaze session and returns final summary.

Use case:

- Call once when exam ends/submits/leaves

Response:

- Summary fields + `status: "ended"`

Important:

- This clears in-memory session resources in Python

## `GET /gaze/active`

List active gaze sessions.

Use case:

- Faculty/admin monitoring of currently tracked students

Response:

```json
{
  "active_sessions": ["22A91A0501", "22A91A0502"]
}
```

## 3) Integration Steps (With Your Existing App)

## Step 1: Ensure services are running

1. Start Python microservice on port `8000`.
2. Start Node backend on port `5000`.
3. Set backend env `FACE_SERVICE_URL=http://localhost:8000` (or deployed Python URL).

Even though variable name says `FACE_SERVICE_URL`, it should point to the same Python service that hosts gaze endpoints.

## Step 2: Add backend proxy routes for gaze

In backend route layer (same place as face routes), add Node endpoints that forward to:

- `POST /gaze/frame/:studentId` -> Python `POST /gaze/frame/{student_id}`
- `GET /gaze/summary/:studentId` -> Python `GET /gaze/summary/{student_id}`
- `POST /gaze/end/:studentId` -> Python `POST /gaze/end/{student_id}`
- `GET /gaze/active` -> Python `GET /gaze/active`

Recommended Node path examples:

- `POST /api/face/gaze/frame/:studentId`
- `GET /api/face/gaze/summary/:studentId`
- `POST /api/face/gaze/end/:studentId`
- `GET /api/face/gaze/active`

Why this is best for your app:

- Reuses existing auth middleware pattern
- Keeps frontend on one base URL (`/api`)
- Avoids browser-to-Python CORS complexity

## Step 3: Add frontend API helpers

In frontend API utility, add wrappers to call the Node proxy routes:

- `sendGazeFrame(studentId, imageBlob)`
- `getGazeSummary(studentId)`
- `endGazeSession(studentId)`
- `getActiveGazeSessions()` (faculty/admin)

For frame upload, use multipart with form key `image` in frontend, and map it to Python `file` in backend proxy (same pattern used in current face route).

## Step 4: Hook into exam lifecycle

In exam runner flow:

1. After attempt start and webcam ready, start a gaze interval (e.g. every 5s).
2. Each tick:
   - capture webcam frame
   - call `sendGazeFrame(...)`
   - if `looking_away === true`, log a proctor violation to existing endpoint (`/api/attempts/:id/proctor`)
3. On submit/timeout/unmount:
   - clear interval
   - call `endGazeSession(studentId)` once
   - optionally save returned summary in violation `meta`

Suggested violation mapping for consistency:

- Python `status=no_face` -> `face-absent` (or new `gaze-no-face`)
- Python `looking_away=true` -> `gaze-away`
- Python service down -> `service_unavailable`

## Step 5: Update Mongo enums before logging new gaze event types

Your schemas currently enforce allowed event types.

If you log new gaze-specific types (like `gaze-away`), add them to both enum lists:

- `backend/models/Attempt.js` (Violation schema enum)
- `backend/models/ProctoringEvent.js` (event enum)

Without this, Mongo validation will reject save/create for new event types.

## Step 6: Faculty dashboard labels

If you add new event types (`gaze-away`, `gaze-no-face`), extend the friendly label map in faculty submissions UI so events render readable text.

## 4) Minimal Request Examples

## Frame upload

```bash
curl -X POST "http://localhost:8000/gaze/frame/22A91A0501" \
  -F "file=@frame.jpg"
```

## Mid-session summary

```bash
curl "http://localhost:8000/gaze/summary/22A91A0501"
```

## End session

```bash
curl -X POST "http://localhost:8000/gaze/end/22A91A0501"
```

## Active sessions

```bash
curl "http://localhost:8000/gaze/active"
```

## 5) Recommended Operational Rules

- Keep gaze interval at 5 seconds to reduce load and still capture behavior.
- Always call `/gaze/end/{student_id}` on exam completion to avoid stale sessions.
- Fail open for temporary Python outages (do not force-submit exam); just log service issue.
- Store summary metrics (`offence_count`, `total_away_s`, `penalty_score`) in event metadata for post-exam review.

## 6) Quick Checklist

- [ ] Python service running and reachable
- [ ] `FACE_SERVICE_URL` points to Python service
- [ ] Backend has gaze proxy routes
- [ ] Frontend has gaze API helpers
- [ ] Exam runner starts/stops gaze loop correctly
- [ ] New gaze event types added to Mongo enums (if used)
- [ ] Faculty dashboard supports gaze labels
