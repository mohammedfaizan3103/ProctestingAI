import axios from "axios";

/**
 * Normalize the API base URL.
 * Ensures it always ends with /api (and no double slashes).
 */
const normalizeBase = (base) => {
  if (!base) return null;
  const trimmed = base.replace(/\/$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
};

/**
 * Use environment variable if available, otherwise fallback.
 * Example for Vite: VITE_API_BASE=https://your-backend.onrender.com
 * Example for CRA:  REACT_APP_API_BASE=https://your-backend.onrender.com
 */
const envBase = import.meta.env?.VITE_API_BASE_URL || `http://${window.location.hostname}:5000`;

const API_BASE = normalizeBase(envBase);

// console.log("🔗 Using API base:", API_BASE);

const API = axios.create({ baseURL: API_BASE });

/** ---------------- AUTH ---------------- **/
export const register = (formData) => API.post("/auth/register", formData);
export const login = (formData) => API.post("/auth/login", formData);
export const getCurrentUser = () => API.get("/auth/user", localAuthHeader());
export const updateProfile = (payload) =>
  API.put("/auth/profile", payload, localAuthHeader());
export const changePassword = (currentPassword, newPassword) =>
  API.post(
    "/auth/change-password",
    { currentPassword, newPassword },
    localAuthHeader()
  );

/** ---------------- HELPERS ---------------- **/
const authHeader = (token) => ({
  headers: { Authorization: `Bearer ${token}` },
});
const localAuthHeader = () => {
  const token = localStorage.getItem("token");
  return authHeader(token || "");
};

/** ---------------- ADMIN ---------------- **/
export const createFaculty = (data, token) =>
  API.post("/admin/faculty", data, authHeader(token));

export const listFaculty = (token) =>
  API.get("/admin/faculty", authHeader(token));

export const uploadStudents = (file, token) => {
  const form = new FormData();
  form.append("file", file);
  return API.post("/admin/students/upload", form, {
    headers: {
      ...(authHeader(token).headers || {}),
      "Content-Type": "multipart/form-data",
    },
  });
};

export const listUsers = (params, token) =>
  API.get("/admin/users", { ...authHeader(token), params });

export const updateUser = (id, payload, token) =>
  API.patch(`/admin/users/${id}`, payload, authHeader(token));

export const resetUserPassword = (id, toRollno = true, token) =>
  API.post(
    `/admin/users/${id}/reset-password`,
    { toRollno },
    authHeader(token)
  );

// Admin: list student roster (directory)
export const listStudents = (params, token) =>
  API.get("/admin/students", { ...authHeader(token), params });

/** ---------------- FACULTY ---------------- **/
export const listMyExams = () => API.get("/exams", localAuthHeader());
export const createExam = (payload) =>
  API.post("/exams", payload, localAuthHeader());
export const getExam = (id) => API.get(`/exams/${id}`, localAuthHeader());
export const updateExam = (id, payload) =>
  API.put(`/exams/${id}`, payload, localAuthHeader());
export const deleteExam = (id) => API.delete(`/exams/${id}`, localAuthHeader());

/** ---------------- AI ---------------- **/
export const generateAIQuestions = (prompt) =>
  API.post("/ai/generate-questions", { prompt }, localAuthHeader());

/** ---------------- STUDENT ---------------- **/
export const listAvailableExams = () =>
  API.get("/exams/available", localAuthHeader());

/** ---------------- ATTEMPTS ---------------- **/
export const startAttempt = (examId, payload = {}) =>
  API.post("/attempts/start", { examId, ...payload }, localAuthHeader());
export const saveAttempt = (attemptId, answers) =>
  API.post("/attempts/save", { attemptId, answers }, localAuthHeader());
export const submitAttempt = (attemptId, answers) =>
  API.post(
    "/attempts/submit",
    answers ? { attemptId, answers } : { attemptId },
    localAuthHeader()
  );
export const getAttempt = (attemptId) =>
  API.get(`/attempts/${attemptId}`, localAuthHeader());
export const logProctorEvent = (attemptId, type, meta) =>
  API.post(`/attempts/${attemptId}/proctor`, { type, meta }, localAuthHeader());
export const verifyHash = (attemptId) =>
  API.post(`/attempts/${attemptId}/verify-hash`, {}, localAuthHeader());

/** ---------------- REVIEW / RETAKES ---------------- **/
export const listAttemptsForExam = (examId) =>
  API.get(`/attempts/exam/${examId}/attempts`, localAuthHeader());
export const getProctorEvents = (attemptId) =>
  API.get(`/attempts/${attemptId}/events`, localAuthHeader());
export const grantRetake = (examId, studentId, count = 1) =>
  API.post(
    `/attempts/exam/${examId}/grant-retake`,
    { studentId, count },
    localAuthHeader()
  );
export const getMarksheet = (examId) =>
  API.get(`/attempts/exam/${examId}/marksheet`, localAuthHeader());

/** ---------------- CONTACT ---------------- **/
export const sendContactMessage = (payload) => API.post(`/contact`, payload);

/** ---------------- FACE PROCTORING ---------------- **/
/**
 * Register the student's face before the exam starts.
 * @param {string} studentId - the student's roll number
 * @param {Blob} imageBlob   - JPEG blob captured from webcam
 */
export const registerFace = (studentId, imageBlob) => {
  const form = new FormData();
  form.append("image", imageBlob, "capture.jpg");
  return API.post(`/face/register/${encodeURIComponent(studentId)}`, form, {
    headers: { ...localAuthHeader().headers, "Content-Type": "multipart/form-data" },
  });
};

/**
 * Periodic proctoring check during an exam.
 * @param {string} studentId - the student's roll number
 * @param {Blob} imageBlob   - JPEG blob from webcam snapshot
 * @returns {{ violation_type: string, match: boolean, confidence: number, face_count: number }}
 */
export const checkFace = (studentId, imageBlob) => {
  const form = new FormData();
  form.append("image", imageBlob, "frame.jpg");
  return API.post(`/face/check/${encodeURIComponent(studentId)}`, form, {
    headers: { ...localAuthHeader().headers, "Content-Type": "multipart/form-data" },
  });
};

/** ---------------- GAZE PROCTORING ---------------- **/

export const sendGazeFrame = (studentId, imageBlob) => {
  const form = new FormData();
  form.append("image", imageBlob, "frame.jpg");
  return API.post(`/face/gaze/frame/${encodeURIComponent(studentId)}`, form, {
    headers: { ...localAuthHeader().headers, "Content-Type": "multipart/form-data" },
  });
};

export const getGazeSummary = (studentId) => {
  return API.get(`/face/gaze/summary/${encodeURIComponent(studentId)}`, localAuthHeader());
};

export const endGazeSession = (studentId) => {
  return API.post(`/face/gaze/end/${encodeURIComponent(studentId)}`, {}, localAuthHeader());
};

export const getActiveGazeSessions = () => {
  return API.get(`/face/gaze/active`, localAuthHeader());
};
