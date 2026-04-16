## ProcTesting – Proctored Exams (MERN)

ProcTesting is a full‑stack proctoring platform for creating, delivering, and reviewing online exams with built‑in anti‑cheat protections. It includes role‑based dashboards for students and faculty, a professional Exam Editor with question import, and exports of submissions to CSV/Excel.

### Features

- Role‑based dashboards with clear role badges (Student/Faculty)
- Secure Exam Runner
  - Fullscreen requirement, copy/cut/context‑menu and text selection disabled
  - Tab/app switching detection with friendly warnings and countdown overlay
  - Auto‑submit after violation timeout; no premature “time expired” text
  - Navbar is hidden during exams
- Exam Editor (Tailwind styled)
  - Basics, Scheduling, Assignment, and Questions sections
  - Question cards with duplicate/remove actions
  - Import questions from Google Sheets (CSV/TSV) or Google Docs (text)
- Submissions review for faculty
  - View attempts with populated student details (name, email, roll no.)
  - Inspect proctoring events per attempt
  - Export submissions to CSV or Excel (.xlsx) with auto‑filters and readable column sizing

### Tech stack

- Frontend: React 18 + Vite, Tailwind CSS v4
- Backend: Node.js + Express, MongoDB + Mongoose, JWT auth

### Folder structure

```
backend/
	server.js        # Express app entry
	config/db.js     # MongoDB connection
	middleware/
	models/
	routes/
frontend/
	src/
		pages/         # Pages (Dashboard, ExamEditor, ExamRunner, etc.)
		components/
		utils/api.js   # Axios instance and API helpers
	vite.config.js
```

---

## Getting started

### Prerequisites

- Node.js (LTS recommended)
- MongoDB (local or cloud, e.g., MongoDB Atlas)

### Backend setup

1. Create a `.env` file in `backend/` with:

```
MONGO_URI=mongodb://localhost:27017/proctesting    # or your Atlas URI
JWT_SECRET=replace-with-a-strong-secret
PORT=5000                                          # optional; defaults to 5000
CLIENT_URL=http://localhost:5173                   # Vite dev URL for CORS
GOOGLE_API_KEY=your-gemini-api-key                 # API key for the Python Langchain agent
```

2. Set up the Python virtual environment for the AI Agent:

```
cd backend/services/ai
python -m venv venv
# On Windows:
venv\Scripts\activate
# On macOS/Linux:
source venv/bin/activate
# On Git Bash:
source venv/Scripts/activate

pip install -r requirements.txt
# Go back to the backend directory
cd ../..
```

3. Install Node dependencies and start the server:

```
cd backend
npm install
npm start
```

The server exposes REST APIs at `http://localhost:5000/api`.

### Frontend setup

1. Create a `.env` file in `frontend/` (you can copy from `.env.example`):

```
VITE_API_BASE=http://localhost:5000/api
```

2. Install and run the dev server:

```
cd frontend
npm install
npm run dev
```

3. Open the printed URL (typically `http://localhost:5173`).

**For production deployment**, see [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed instructions on configuring environment variables for platforms like Vercel, Netlify, or Render.

---

## Importing questions (Exam Editor)

Open the Exam Editor and click “Import”. You can paste content or choose a file.

Supported formats:

- Google Sheets (CSV/TSV)
  - Headers: `text, type, options, correct, points`
  - Options separated by `|` or `;;`
  - Multiple correct answers should be comma‑separated (e.g., `A,B` or `1,3`)
  - If a CSV field contains commas (e.g., `A,B`), wrap it in quotes

Example CSV:

```
text,type,options,correct,points
What is 2+2?,single,2 | 3 | 4 | 5,3,1
Select prime numbers,mcq,2 | 3 | 4 | 5,"A,B",3
Explain Newton's second law,text,,,5
```

- Google Docs (plain text)
  - Example block:

```
Q: What is 2+2?
A) 2
B) 3
C) 4
D) 5
Correct: C
Points: 1
```

You can choose to replace existing questions or append the parsed ones.

---

## Exporting submissions (Faculty)

On the Submissions page for an exam, use the top‑right buttons:

- Export CSV – downloads a `.csv` with columns:

  - SNo, AttemptID, StudentName, StudentEmail, RollNo, Status, Score, Violations, StartedAt, SubmittedAt
  - Timestamps are ISO‑8601 strings (UTC)

- Export Excel – downloads a `.xlsx` with:
  - The same columns as above
  - AutoFilter enabled on the header row
  - Column widths sized for readability
  - Date cells formatted as `yyyy-mm-dd hh:mm:ss` (displayed in your local timezone by Excel)

Filenames are timestamped, e.g., `exam_<examId>_submissions_YYYYMMDD_HHMM.*`.

---

## Available scripts

Backend:

```
cd backend
npm start     # runs nodemon server.js
```

Frontend:

```
cd frontend
npm run dev      # Start Vite dev server
npm run build    # Production build
npm run preview  # Preview the production build
```

---

## Troubleshooting

- MongoDB connection fails
  - Verify `MONGO_URI` and that MongoDB is running/reachable
- CORS errors in browser
  - Ensure `CLIENT_URL` in backend `.env` matches your frontend origin
- Invalid token / unauthorized
  - Set a valid `JWT_SECRET` and ensure the frontend stores/sends the token
- API not reachable from frontend
  - Confirm backend port and base URL in `frontend/src/utils/api.js`

---

