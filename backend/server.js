import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import connectDB from "./config/db.js";
import Exam from "./models/Exam.js";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import examRoutes from "./routes/exams.js";
import attemptRoutes from "./routes/attempts.js";
import miscRoutes from "./routes/misc.js";
import { scheduleDailyRunner } from "./scheduler/promotion.js";
import aiRoutes from "./routes/ai.routes.js";
import faceRoutes from "./routes/face.routes.js";



dotenv.config(); // Load environment variables

const app = express();
const httpServer = http.createServer(app);
connectDB(); // Connect to MongoDB

// Middleware
// Allow one or more frontend origins via env: CLIENT_URLS (comma-separated) or CLIENT_URL; defaults to '*'
const originsEnv = process.env.CLIENT_URLS || process.env.CLIENT_URL || "*";
const corsOptions =
  originsEnv === "*"
    ? { origin: "*" }
    : {
        origin: originsEnv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
app.use(cors(corsOptions)); // Allow frontend to connect
app.use(express.json()); // Parse JSON body

// Socket.io Setup
const io = new Server(httpServer, {
  cors: corsOptions,
});

io.on("connection", (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);

  // When faculty joins an exam live room
  socket.on("faculty:join", ({ examId }) => {
    socket.join(`exam_${examId}_faculty`);
    // Notify students that faculty is here, so they can send streams
    socket.to(`exam_${examId}`).emit("faculty:online");
  });

  // When faculty authenticates globally for dashboard alerts
  socket.on("faculty:authenticate", ({ facultyId }) => {
    socket.join(`faculty_${facultyId}`);
  });

  // When student joins an exam
  socket.on("student:join", ({ examId, studentId, studentName }) => {
    socket.examId = examId;
    socket.studentId = studentId;
    socket.join(`exam_${examId}`);
    // Notify faculty in that exam room
    socket.to(`exam_${examId}_faculty`).emit("student:joined", { socketId: socket.id, studentId, studentName });
  });

  // Signaling for WebRTC
  socket.on("faculty:request_offer", ({ studentSocketId }) => {
    io.to(studentSocketId).emit("faculty:request_offer", { facultySocketId: socket.id });
  });

  socket.on("webrtc:offer", ({ targetSocketId, offer, studentId, studentName }) => {
    io.to(targetSocketId).emit("webrtc:offer", { senderSocketId: socket.id, offer, studentId, studentName });
  });

  socket.on("webrtc:answer", ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit("webrtc:answer", { senderSocketId: socket.id, answer });
  });

  socket.on("webrtc:candidate", ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit("webrtc:candidate", { senderSocketId: socket.id, candidate });
  });

  // Proctoring violations forwarding
  socket.on("student:violation", async ({ examId, studentId, type }) => {
    socket.to(`exam_${examId}_faculty`).emit("student:violation", { studentId, type });
    
    // Send global alert to faculty owner
    try {
      const exam = await Exam.findById(examId).select("createdBy");
      if (exam && exam.createdBy) {
        io.to(`faculty_${exam.createdBy}`).emit("faculty:alert", { studentId, examId, type });
      }
    } catch(e) {}
  });

  // Settings & Debug config forward
  socket.on("faculty:toggle_autosubmit", ({ examId, enabled }) => {
    socket.to(`exam_${examId}`).emit("config:autosubmit", { enabled });
  });

  // Remote Proctoring Interventions
  socket.on("faculty:warning", ({ targetSocketId, message }) => {
    io.to(targetSocketId).emit("faculty:warning", { message });
  });

  socket.on("faculty:force_submit", ({ targetSocketId }) => {
    io.to(targetSocketId).emit("faculty:force_submit");
  });

  socket.on("disconnect", () => {
    console.log(`🔌 Socket disconnected: ${socket.id}`);
    if (socket.studentId && socket.examId) {
      socket.to(`exam_${socket.examId}_faculty`).emit("student:left", { studentId: socket.studentId });
    }
  });
});


// Routes
app.use("/api/ai", aiRoutes);
app.use("/api/face", faceRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/exams", examRoutes);
app.use("/api/attempts", attemptRoutes);
app.use("/api", miscRoutes);

// Schedule academic promotion cycles (semester/year)
scheduleDailyRunner();

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Default route
app.get("/", (req, res) => {
  res.send("API is running...");
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

const PORT = process.env.PORT || 5000;

httpServer.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

