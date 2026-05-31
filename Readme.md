# ProcTesting

A full-stack AI-augmented online examination and proctoring platform integrating computer vision identity verification, real-time faculty monitoring, and retrieval-augmented question generation.

-----

## Overview

ProcTesting is a MERN-stack web application designed to address the limitations of existing online proctoring systems: binary violation detection, lack of live faculty oversight, isolated question generation tools, and poor support for low-bandwidth environments.

The platform unifies exam authoring, identity verification, behavioral proctoring, and academic administration into a single deployable system. A Python/FastAPI microservice handles all compute-intensive AI and computer vision workloads independently from the Node.js backend.

-----

## Architecture

```
React (Vite)          Node.js / Express          Python / FastAPI
-----------           -----------------          ----------------
Student Portal   <->  Auth, Exams, Scoring  <->  Face Registration
Faculty Portal        Socket.IO relay            Face Verification
Admin Portal          WebRTC signaling           Gaze Tracking
                      MongoDB Atlas              RAG Question Gen
```

Services communicate over HTTPS. JWTs are issued on login and passed between services. The Python microservice is stateless; all session state is held in-process via a module-level registry (replaceable with Redis for multi-worker deployments).

-----

## Features

**Computer Vision Proctoring (Python/FastAPI)**

- Face registration via dlib HOG detector and ResNet-34 face encoder (128-dimensional float64 embeddings)
- CLAHE preprocessing in LAB colorspace to normalize brightness without discarding chrominance
- Euclidean distance verification with configurable threshold (default: 0.55)
- Four-state classification per proctoring snapshot: verified, no-face, wrong-face, multiple-faces
- Optional periodic re-verification toggle (`run_reverify`) to reduce API load
- Gaze tracking via MediaPipe Face Mesh with `refine_landmarks=True`
- Iris position computed by averaging the four ring landmarks per eye (indices 469-472 right, 474-477 left) in normalized coordinate space
- Cumulative penalty scoring: weighted sum of total away duration and offence count, with a repeat-offender multiplier at five or more offences
- Grace period logic (1.5 s) to suppress transient glances

**Real-Time Faculty Invigilation**

- Socket.IO event relay from student exam runners to faculty dashboard
- Violations (face events, fullscreen exit, tab switch, gaze deviation) pushed in real time
- Students sorted on faculty dashboard by live integrity/penalty score
- Faculty-initiated remote auto-submit via Socket.IO
- WebRTC peer-to-peer live camera streaming from student to faculty browser

**Browser-Side Lockdown**

- Fullscreen enforcement with violation events on exit
- Clipboard and right-click blocking
- Browser and OS shortcut prevention (Alt+Tab, Escape, F11)
- Tab blur and visibility tracking via Page Visibility API
- Automatic exam submission on threshold violations

**RAG-Based Question Generation**

- Textbook ingestion (PDF, plain text) via LangChain loaders and splitters
- FAISS vector store for semantic chunk retrieval
- Table-of-contents extraction for fast-fail topic checks before LLM invocation
- Two-stage relevance filtering prior to grounded generation
- Llama model via Ollama for fully local, hallucination-mitigated generation
- Output formatted for direct import into the exam editor

**Exam Management and Administration**

- Single-choice, multiple-choice, and text question types
- Question import from CSV, TSV, Google Sheets URL, Google Docs, and plain text
- Bulk student enrollment via CSV/XLS/XLSX with header normalization
- Automated semester and year promotion (January/July cycle guards)
- Per-attempt result export to CSV and formatted Excel workbooks with auto-filters
- SHA-256 tamper detection on submitted exam artifacts

-----

## Technology Stack

|Component       |Technology                                                  |
|----------------|------------------------------------------------------------|
|Frontend        |React 18, Vite, Tailwind CSS v4, Lucide Icons               |
|Real-Time Client|Socket.IO client, WebRTC                                    |
|Backend API     |Node.js, Express.js, MongoDB (Mongoose), JWT                |
|Real-Time Server|Socket.IO, WebRTC signaling relay                           |
|File Handling   |Multer, xlsx, node-fetch, form-data                         |
|Email           |Brevo transactional email SDK                               |
|AI Microservice |Python, FastAPI, Uvicorn                                    |
|CV / ML         |OpenCV 4.8.1, MediaPipe 0.10.9, face-recognition, dlib 19.22|
|Vector Store    |FAISS + LangChain                                           |
|LLM             |Llama via Ollama                                            |
|Database        |MongoDB Atlas, SQLite (face embeddings)                     |
|Deployment      |Vercel (Frontend), Render (Backend), MongoDB Atlas          |

-----

## Python Microservice Setup

**Prerequisites**

- Python 3.10
- dlib 19.22 pre-built wheel (do not install from source on Windows)

**Installation**

```bash
cd python_microservice
python -m venv venv
venv\Scripts\activate          # Windows
# source venv/bin/activate     # Linux / macOS

pip install numpy==1.26.4      # must be pinned before dlib
pip install dlib-19.22.99-cp310-cp310-win_amd64.whl   # use your platform wheel
pip install face_recognition
pip install opencv-python==4.8.1.78
pip install mediapipe==0.10.9
pip install protobuf==3.20.3
pip install fastapi uvicorn python-multipart
```

> **Note:** dlib 19.22 is incompatible with numpy 2.x on Windows due to an ABI mismatch. Pinning `numpy==1.26.4` is required. Installing numpy after dlib from a pre-built wheel is the safest order.

**Run**

```bash
uvicorn main:app --reload --port 8000
```

-----

## API Reference (Python Microservice)

|Method|Endpoint                     |Description                                                  |
|------|-----------------------------|-------------------------------------------------------------|
|POST  |`/register/{student_id}`     |Register a face embedding for a student                      |
|POST  |`/verify/{student_id}`       |Verify a live image against a stored embedding               |
|POST  |`/proctor/check/{student_id}`|Periodic proctoring snapshot (face count + optional reverify)|
|POST  |`/gaze/frame/{student_id}`   |Submit a frame for gaze tracking                             |
|GET   |`/gaze/summary/{student_id}` |Retrieve cumulative gaze session summary                     |
|POST  |`/gaze/end/{student_id}`     |Close the gaze session on exam submission                    |
|GET   |`/students`                  |List all registered student IDs                              |
|DELETE|`/students/{student_id}`     |Remove a student registration                                |

**Proctoring snapshot response statuses:** `ok`, `no_face`, `multiple_faces`, `identity_mismatch`, `error`

**Query parameter:** `?run_reverify=true` on `/proctor/check/` enables identity comparison this cycle.

-----

## Face Verification - How It Works

Registration stores a 128-dimensional float64 embedding computed by dlibâs ResNet-34 model. No raw image is stored.

At verification time, the Euclidean distance between the live embedding and the stored embedding is computed:

```
d = ||e_live - e_reg||_2
```

A match is declared when `d < 0.55`. Confidence is reported as `max(0, 1 - d)`.

All images pass through CLAHE preprocessing (clipLimit 2.0, 8x8 tile grid) applied only to the L channel in LAB colorspace, preserving chrominance for the convolutional layers.

-----

## Gaze Tracking - How It Works

MediaPipe Face Mesh produces 478 landmarks when `refine_landmarks=True`. Iris position is computed by averaging the four ring landmark coordinates per eye (right iris: 469-472, left iris: 474-477) in normalized [0, 1] space.

Horizontal ratio per eye:

```
r_h = (x_iris - x_outer_corner) / eye_width
```

Final ratios are averaged across both eyes. A student is flagged as looking away when:

```
H not in [0.35, 0.65]  or  V not in [0.30, 0.70]
```

Cumulative penalty score:

```
P = (T_away * 0.4 + N_off * 2.0) * m

where m = 1.5 if N_off >= 5, else 1.0
```

A 1.5-second grace period suppresses transient glances below offence threshold.

-----

## Project Structure

```
/
├── frontend/                  React 18 SPA (Vite)
├── backend/                   Node.js / Express API + Socket.IO
└── python_microservice/
    ├── main.py                FastAPI entry point and route definitions
    └── utils/
        ├── face_db.py         Face registration, verification, proctoring check
        ├── gaze_tracker.py    GazeSession class, iris math, penalty scoring
        └── session_store.py   In-memory GazeSession registry
```

---
