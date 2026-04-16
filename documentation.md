# ProcteredMERN Comprehensive Documentation

## 1. Overview

ProcteredMERN is a MERN-stack (MongoDB, Express, React, Node.js) application for administering, taking, proctoring, and managing online exams in an academic context. It supports:

- Role-based access: `admin`, `faculty`, `student`.
- Dual student identity modes: legacy `User` documents and roster-only `Student` documents.
- Exam authoring with flexible question types (single choice, multiple choice, text/manual grading).
- Assignment of exams to cohorts via academic filters (college, department, year, section, semester).
- Attempt lifecycle management: start, autosave, submit, scoring, retake grants.
- Lightweight proctoring (tab blur, visibility hidden, fullscreen exit, inactivity return timeout) with violation/event logging.
- Academic promotion cycles (semester/year increments) via a scheduled runner.
- Bulk student roster upload from CSV/XLS/XLSX.
- Contact form with Brevo (SendInBlue) transactional emails.

## 2. Repository Structure (High-Level)

```
backend/
  server.js                # Express app entry
  config/db.js             # Mongo connection
  middleware/authMiddleware.js
  models/                  # Mongoose schemas
  routes/                  # REST API endpoints
  scheduler/promotion.js   # Academic promotion cycle
frontend/
  src/
    pages/                 # React route pages
    components/            # UI components (Navbar, Footer)
    utils/api.js           # Axios API wrapper
    config/config.js       # Frontend config
  vite.config.js           # Vite build config
  public/                  # Static assets (upload template)
```

## 3. Technology & Dependencies

### Core Stack

- Runtime: Node.js (Express backend), React 18 (frontend), Vite build tool
- Database: MongoDB (via Mongoose ODM)
- Styling/UX: Tailwind CSS, AOS animations, Lucide React icons
- Data Transport: Axios (HTTP), JSON over REST
- Auth: JWT (jsonwebtoken) + bcrypt hashing
- File Handling: Multer (memory storage), xlsx (Excel/CSV parsing)
- Email: Nodemailer (potential fallback), Brevo SDK (`sib-api-v3-sdk`) for contact form
- Scheduling: `setInterval` based daily runner (promotion cycles)

### Backend Dependencies

| Package        | Purpose                                      |
| -------------- | -------------------------------------------- |
| express        | HTTP server & routing                        |
| mongoose       | MongoDB ODM & schema validation              |
| jsonwebtoken   | JWT signing & verification                   |
| bcryptjs       | Password hashing & comparison                |
| cors           | Cross-origin resource sharing configuration  |
| dotenv         | Environment variable loading                 |
| multer         | Multipart form-data parsing (student upload) |
| nodemailer     | Email sending (alternative path)             |
| sib-api-v3-sdk | Brevo transactional email API                |
| xlsx           | Parse CSV/XLS/XLSX for student roster        |
| nodemon (dev)  | Auto-reload during development               |

### Frontend Dependencies

| Package           | Purpose                                  |
| ----------------- | ---------------------------------------- |
| react / react-dom | UI library                               |
| react-router-dom  | Client-side routing                      |
| axios             | HTTP client abstraction                  |
| tailwindcss       | Utility-first CSS framework              |
| @tailwindcss/vite | Tailwind integration for Vite            |
| lucide-react      | Icon set                                 |
| aos               | Scroll animations                        |
| xlsx              | Client-side CSV/XLSX handling (optional) |

### Frontend Dev Dependencies

| Package                         | Purpose                                |
| ------------------------------- | -------------------------------------- |
| vite                            | Dev server & bundler                   |
| @vitejs/plugin-react            | React fast refresh/JSX transform       |
| eslint (+ plugins)              | Linting                                |
| @types/react / @types/react-dom | Type hints (JS projects can still use) |
| globals                         | Shared ESLint globals                  |

### Architectural Highlights

- Separation of `User` vs `Student` documents enables roster management without forcing authentication records for every student (dual-mode login supported).
- Retake grants stored per exam enabling controlled reattempts.
- Proctoring events stored both inline (`violations` array in `Attempt`) and as standalone `ProctoringEvent` documents for detailed review.

## 4. Environment Configuration

Create a `.env` file in `backend/` based on `ENV-TEMPLATE.md` (if present) or the variables below:

```
PORT=5000
MONGO_URI=mongodb+srv://<user>:<pass>@cluster/dbname
JWT_SECRET=super-secret-jwt-value
CLIENT_URL=http://localhost:5173
# OR multiple origins separated by comma
CLIENT_URLS=http://localhost:5173,https://your-frontend.example

# Brevo (SendInBlue) email
BREVO_API_KEY=your-brevo-api-key
BREVO_SENDER_EMAIL=no-reply@example.com
BREVO_SENDER_NAME=Exam Platform
CONTACT_RECEIVER=admin@example.com

# Optional SMTP fallback (if implementing nodemailer path)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=smtp-user
SMTP_PASS=smtp-pass
```

Frontend environment variable (Vite): set in `.env` or `.env.local` inside `frontend/`:

```
VITE_API_BASE_URL=http://localhost:5000
```

The frontend normalizes this to `.../api` automatically.

## 5. Data Models

### User

Fields: `name`, `email` (unique), `rollno` (optional for student), `password` (hashed), `role (student|faculty|admin)`, academic profile (college, year, department, section, semester). Stored in Mongo collection `teachers` (custom collection name) while retaining model name `User`.

### Student (Roster Only)

Fields: `rollno` (unique), `name`, optional `email`, academic profile fields, plus cycle guard tags: `lastSemCycle`, `lastYearCycle` to prevent multiple promotions within the same window.

### Exam

- `title`, `description`, `durationMins`.
- `window.start` & `window.end` for availability.
- `questions[]`: each with `type (single|mcq|text)`, `text`, optional `options`, `correctAnswers` indexes, `points`.
- `assignmentCriteria`: filters by `college`, arrays for `year`, `department`, `section`, `semester`.
- `retakeGrants`: per student retake tokens `{ studentId, remaining, grantedAt }`.
- Validation hooks enforce window correctness and question integrity.

### Attempt

- Links: `examId`, `studentId`, `studentRef ('User'|'Student')` for principal tracing.
- Status: `in-progress | submitted | invalid`.
- Timing: `startedAt`, `submittedAt`.
- `answers[]`: `{ questionIndex, value }` supporting number/string/arrays.
- Proctoring: `violations[]` aggregated.
- Scoring: `score`, `manualNeeded` (true if any text questions).

### ProctoringEvent

Separate log documents for each violation: `{ attemptId, type, at, meta }` enabling audit trails distinct from attempt roll-up.

## 6. Authentication & Authorization

- JWT tokens (1h expiry) signed with `JWT_SECRET`.
- Two student login paths:
  1. `/api/auth/login-user` (against `User` collection; verifies roster presence for students).
  2. `/api/auth/login-student` (against `Student` roster only; password defaults to `rollno`).
- Middleware `authMiddleware` validates token, attaches `req.user = { id, role, model }`.
- Role gating via `auth.requireRole('admin', 'faculty', 'student')`.

### Profile & Password Management

- `/api/auth/profile` for updating faculty/admin fields.
- `/api/auth/change-password` for authenticated non-roster students (i.e., `User` model). Roster-only (`Student`) login does not currently support password change.

## 7. Exam Lifecycle

1. Faculty creates exam: `POST /api/exams` with question array & window.
2. Student fetches assigned upcoming/active exams: `GET /api/exams/available` (matching assignment criteria & not past end time).
3. Student starts attempt: `POST /api/attempts/start` → returns sanitized exam (answers stripped of correctness and sensitive data).
4. Client may periodically save: `POST /api/attempts/save` (partial answers).
5. Submission: `POST /api/attempts/submit` → auto-scores non-text questions; marks manualNeeded if text present.
6. Faculty lists attempts: `GET /api/attempts/exam/:examId/attempts`.
7. Faculty grants retake: `POST /api/attempts/exam/:examId/grant-retake`; subsequent start consumes a token.

### Timing Enforcement

- Attempt validity window = `startedAt + durationMins`.
- On save/submit after time expiration: save blocked (for save); submit still accepted but late.
- Expired in-progress attempts may be flagged `invalid` on next start check.

## 8. Scoring Logic

- Single choice: exact index match.
- Multiple choice: set equality (size and membership) for full points, no partial credit.
- Text questions: excluded from auto score; trigger `manualNeeded` flag.

## 9. Proctoring & Violations

Events recorded when client sends `POST /api/attempts/:id/proctor { type, meta }`.
Supported types:

- `tab-blur`
- `visibility-hidden`
- `fullscreen-exit`
- `return-timeout`
  Stored both inline (`attempt.violations`) and as separate `ProctoringEvent` documents for chronological review via `GET /api/attempts/:id/events` (authorized student owner or faculty exam owner).

## 10. Academic Promotion Cycle

`scheduler/promotion.js` runs `runPromotionCycle()` immediately on startup and every 12 hours. Logic:

- Semester increments (Jan & Jul cycles) with guard `lastSemCycle`.
- Year increments only during July cycle with guard `lastYearCycle`.
- Prevents duplicate increments within cycle tags `YYYY-01` / `YYYY-07`.

## 11. Bulk Student Upload Workflow

Endpoint: `POST /api/admin/students/upload` (admin only).

- Accepts file in memory via Multer (`file` field).
- Parsed with `xlsx`: first sheet → JSON rows.
- Normalizes headers (case-insensitive, alphanumeric).
- Derives `year` from `semester` when provided: `year = ceil(semester / 2)`.
- Creates roster `Student` documents with synthesized email `<rollno>@students.local` if missing.
- Aggregates results: `created`, `skipped`, `errors[]` with row-level detail.

## 12. Contact Form & Email Delivery

Endpoint: `POST /api/contact` (public).

- Validates basic presence & email format.
- Requires `BREVO_API_KEY`; constructs transactional email via Brevo SDK.
- Sender/reply details configurable (`BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`, `CONTACT_RECEIVER`).
- Provides JSON `{ ok: true, id }` (id may be message identifier when available).

## 13. CORS Configuration

In `server.js`:

- Reads `CLIENT_URLS` (comma-separated) or `CLIENT_URL` for allowed origins.
- Defaults to `*` if none provided (suitable only for development; tighten for production).

## 14. Frontend Architecture

- Routing pages under `src/pages/` (e.g., `Login`, `Register`, `ExamRunner`, `AdminUsers`).
- API abstraction `src/utils/api.js` centralizes axios baseURL normalizing `/api` suffix.
- Local storage token usage for authenticated requests (`localAuthHeader`).
- UI layering via shared components (Navbar, Footer).
- Tailwind and AOS supply utility styling & animations; icons from Lucide React.

## 15. End-to-End Setup Instructions

### Prerequisites

- Node.js ≥ 18.x
- MongoDB Atlas account or local MongoDB instance.

### Backend Setup

```bash
cd backend
cp ../ENV-TEMPLATE.md .env   # OR create .env manually
# Edit .env with proper values
npm install
npm run dev   # Starts nodemon on PORT (default 5000)
```

### Frontend Setup

```bash
cd frontend
npm install
npm run dev   # Starts Vite (default http://localhost:5173)
```

Ensure `VITE_API_BASE_URL` points to backend (e.g. `http://localhost:5000`).

### Test Basic Flow

1. Register a student (`POST /api/auth/register`) OR upload roster & login using roll number via `/api/auth/login-student`.
2. As admin, create a faculty user (`POST /api/admin/faculty`).
3. Faculty logs in, creates exam via UI (calls `POST /api/exams`).
4. Student sees exam in `GET /api/exams/available`, starts attempt, answers questions, submits.
5. Faculty reviews attempts and proctoring events.

## 16. Deployment Considerations

### Backend (Render or similar)

- Use `render.yaml` for service definition.
- Set environment variables (PORT, MONGO_URI, JWT_SECRET, BREVO keys, CORS origins).
- Optionally add a health check at `/health`.

### Frontend (Vercel)

- Use `vercel.json` if present for config overrides.
- Set `VITE_API_BASE_URL` to deployed backend base (without `/api`; client app will append).

### Production Hardening

- Restrict CORS origins strictly.
- Use longer JWT expiry with refresh token pattern (future enhancement).
- Add rate limiting (e.g., `express-rate-limit`) to login & contact endpoints.
- Enforce HTTPS and secure cookie (if migrating from pure Bearer tokens).
- Implement logging/monitoring (e.g., Winston + centralized log aggregator).
- Add input validation layer (e.g., Zod / Joi) to reduce reliance on implicit schema validation.

## 17. Security Notes

- Passwords hashed with bcrypt (salt rounds default 10).
- JWT secret must be strong & rotated periodically.
- Avoid exposing correctness data to students (sanitized questions exclude `correctAnswers`).
- Promotion script uses guards to prevent double increments—protect process uptime to ensure cycles run.
- Validate file uploads; currently any first sheet is processed—add MIME/type/size checks for robustness.
- Missing explicit rate limiting; recommended addition.

## 18. Extensibility Paths

- Add manual grading UI for text answers and adjust `score` after review.
- Implement per-question time limits or adaptive difficulty.
- Integrate WebSocket for real-time proctoring signals.
- Add analytics dashboards (exam performance, violation patterns).
- Support partial credit for MCQ (e.g., intersection scoring).
- Provide faculty export: attempts & events CSV.

## 19. API Endpoint Summary (Grouped)

### Auth

- `POST /api/auth/register` — create student `User`.
- `POST /api/auth/login-user` — login via `User` or `rollno`.
- `POST /api/auth/login-student` — roster-only student login.
- `GET /api/auth/user` — current user profile.
- `PUT /api/auth/profile` — update profile (non-roster students).
- `POST /api/auth/change-password` — change password.

### Admin

- `POST /api/admin/faculty` — create faculty.
- `GET /api/admin/faculty` — list faculty.
- `GET /api/admin/users` — filtered user list.
- `PATCH /api/admin/users/:id` — update user fields.
- `POST /api/admin/users/:id/reset-password` — reset password.
- `GET /api/admin/students` — roster listing.
- `POST /api/admin/students/upload` — bulk upload roster.

### Exams (Faculty)

- `POST /api/exams` — create exam.
- `GET /api/exams` — list faculty-owned exams.
- `GET /api/exams/:id` — get exam.
- `PUT /api/exams/:id` — update exam.
- `DELETE /api/exams/:id` — delete exam.

### Exams (Student)

- `GET /api/exams/available` — list assigned upcoming/active exams.

### Attempts (Student)

- `POST /api/attempts/start` — start attempt / retake.
- `POST /api/attempts/save` — save answers snapshot.
- `POST /api/attempts/submit` — submit & score.
- `GET /api/attempts/:id` — get own attempt.
- `POST /api/attempts/:id/proctor` — log proctor event.

### Attempts (Faculty)

- `GET /api/attempts/exam/:examId/attempts` — list attempts for exam.
- `POST /api/attempts/exam/:examId/grant-retake` — grant retake token(s).
- `GET /api/attempts/:id/events` — view proctoring events (also student owner).

### Misc

- `GET /health` — health check.
- `POST /api/contact` — send contact form email.

## 20. Local Development Tips

- Use two terminals: one in `backend` with `npm run dev`, one in `frontend` with `npm run dev`.
- Adjust `CLIENT_URLS` in backend `.env` to include the Vite dev origin.
- Inspect JWT in browser dev tools (localStorage token) for debugging.
- When modifying models, restart backend for schema changes effect.

## 21. Troubleshooting

| Issue               | Cause                        | Resolution                                              |
| ------------------- | ---------------------------- | ------------------------------------------------------- |
| 401 Unauthorized    | Missing/invalid JWT          | Re-login; ensure `Authorization: Bearer <token>` header |
| Exam not visible    | Assignment criteria mismatch | Verify student roster fields vs exam filters            |
| Upload skipped rows | Missing required columns     | Check template headers & row completeness               |
| Retake not allowed  | No remaining retake tokens   | Faculty must grant tokens before restart                |
| Contact error 500   | Missing Brevo API key        | Set `BREVO_API_KEY` in backend `.env`                   |

## 22. Technology & Dependencies (Quick Reference)

(Also covered in Section 3)
**Backend**: Node.js, Express, Mongoose, JWT, bcryptjs, Multer, xlsx, cors, dotenv, Nodemailer, Brevo SDK.
**Frontend**: React 18, React Router DOM, Axios, TailwindCSS, Lucide React, AOS, Vite.
**Other**: MongoDB Atlas/local, setInterval scheduling, CSV/XLSX parsing.

## 23. Future Improvements Checklist

- Replace interval scheduler with robust cron (e.g., node-cron) tied to UTC.
- Add refresh token & silent re-auth flow.
- Implement request rate limiting & IP-based abuse detection.
- Add unit/integration tests (Jest + Supertest + React Testing Library).
- Centralize logging + correlation IDs.
- Encrypt sensitive student data at rest (if required by policy).

---

Generated on: 2025-11-18
