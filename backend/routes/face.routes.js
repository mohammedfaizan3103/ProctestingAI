/**
 * face.routes.js
 * ---------------
 * Thin proxy layer between the MERN backend and the Python FastAPI
 * face-recognition microservice (default: http://localhost:8000).
 *
 * Routes:
 *   POST /api/face/register/:studentId  → Python /register/{student_id}
 *   POST /api/face/check/:studentId     → Python /proctor-check/{student_id}
 *
 * Why proxy instead of calling Python directly from the browser?
 *   • Single origin for the frontend — no extra CORS config required.
 *   • Auth middleware can be applied here centrally.
 *   • Python service URL is kept server-side only.
 */

import express from "express";
import fetch from "node-fetch";
import FormData from "form-data";
import multer from "multer";
import auth from "../middleware/authMiddleware.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const FACE_SERVICE_URL =
  process.env.FACE_SERVICE_URL || "http://localhost:8000";

/**
 * Helper: forward a multipart/form-data image buffer to the Python service.
 * Returns the parsed JSON response or throws on HTTP errors.
 */
async function forwardImageToPython(url, imageBuffer, filename = "frame.jpg") {
  const form = new FormData();
  form.append("file", imageBuffer, {
    filename,
    contentType: "image/jpeg",
  });

  const response = await fetch(url, {
    method: "POST",
    body: form,
    headers: form.getHeaders(),
  });

  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data?.detail || "Python service error");
    error.status = response.status;
    throw error;
  }
  return data;
}

/**
 * POST /api/face/register/:studentId
 * Register a student's face before the exam begins.
 * Expects multipart/form-data with field "image" (JPEG/PNG blob).
 */
router.post(
  "/register/:studentId",
  auth,
  upload.single("image"),
  async (req, res) => {
    const { studentId } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: "No image file provided." });
    }

    try {
      const result = await forwardImageToPython(
        `${FACE_SERVICE_URL}/register/${encodeURIComponent(studentId)}`,
        req.file.buffer,
        req.file.originalname || "capture.jpg"
      );
      return res.json(result);
    } catch (err) {
      console.error("[face.routes] register error:", err.message);
      return res
        .status(err.status || 502)
        .json({ error: err.message || "Face service unavailable." });
    }
  }
);

/**
 * POST /api/face/check/:studentId
 * Periodic proctoring check — called every ~15 s during an exam.
 * Expects multipart/form-data with field "image".
 * Returns: { violation_type, match, confidence, distance, face_count }
 */
router.post(
  "/check/:studentId",
  auth,
  upload.single("image"),
  async (req, res) => {
    const { studentId } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: "No image file provided." });
    }

    try {
      const result = await forwardImageToPython(
        `${FACE_SERVICE_URL}/proctor-check/${encodeURIComponent(studentId)}`,
        req.file.buffer,
        req.file.originalname || "frame.jpg"
      );
      return res.json(result);
    } catch (err) {
      console.error("[face.routes] check error:", err.message);
      // If the Python service is down, return a safe "skip" response
      // so the exam is not disrupted by an infrastructure failure.
      return res.status(200).json({
        violation_type: "service_unavailable",
        match: null,
        message: "Face service temporarily unavailable.",
      });
    }
  }
);

/**
 * GET /api/face/gaze/active
 * See active sessions
 */
router.get("/gaze/active", auth, async (req, res) => {
  try {
    const response = await fetch(`${FACE_SERVICE_URL}/gaze/active`);
    const data = await response.json();
    return res.json(data);
  } catch (err) {
    return res.status(502).json({ error: "Face service unavailable." });
  }
});

/**
 * POST /api/face/gaze/frame/:studentId
 */
router.post(
  "/gaze/frame/:studentId",
  auth,
  upload.single("image"),
  async (req, res) => {
    const { studentId } = req.params;
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided." });
    }
    try {
      const result = await forwardImageToPython(
        `${FACE_SERVICE_URL}/gaze/frame/${encodeURIComponent(studentId)}`,
        req.file.buffer,
        req.file.originalname || "frame.jpg"
      );
      return res.json(result);
    } catch (err) {
      return res.status(200).json({
        status: "service_unavailable",
        message: "Face service temporarily unavailable.",
      });
    }
  }
);

/**
 * GET /api/face/gaze/summary/:studentId
 */
router.get("/gaze/summary/:studentId", auth, async (req, res) => {
  const { studentId } = req.params;
  try {
    const response = await fetch(`${FACE_SERVICE_URL}/gaze/summary/${encodeURIComponent(studentId)}`);
    const data = await response.json();
    return res.json(data);
  } catch (err) {
    return res.status(200).json({
      status: "service_unavailable",
      message: "Face service temporarily unavailable.",
    });
  }
});

/**
 * POST /api/face/gaze/end/:studentId
 */
router.post("/gaze/end/:studentId", auth, async (req, res) => {
  const { studentId } = req.params;
  try {
    const response = await fetch(`${FACE_SERVICE_URL}/gaze/end/${encodeURIComponent(studentId)}`, { method: "POST" });
    const data = await response.json();
    return res.json(data);
  } catch (err) {
    return res.status(200).json({
      status: "service_unavailable",
      message: "Face service temporarily unavailable.",
    });
  }
});

export default router;
