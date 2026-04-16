import mongoose from "mongoose";

const AnswerSchema = new mongoose.Schema(
  {
    questionIndex: { type: Number, required: true },
    value: { type: mongoose.Schema.Types.Mixed }, // number | number[] | string
  },
  { _id: false }
);

const ViolationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        "tab-blur",
        "visibility-hidden",
        "fullscreen-exit",
        "return-timeout",
        "window-resize",
        "face-absent",
        "face-mismatch",
        "face-multiple",
        "gaze-away",
        "gaze-no-face"
      ],
    },
    at: { type: Date, default: Date.now },
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false }
);

const AttemptSchema = new mongoose.Schema(
  {
    examId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Exam",
      required: true,
      index: true,
    },
    // Dynamic reference to student principal: can be a User (legacy) or Student (new)
    studentRef: {
      type: String,
      enum: ["User", "Student"],
      default: "User",
      required: true,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "studentRef",
      required: true,
      index: true,
    },
    startedAt: { type: Date, default: Date.now },
    submittedAt: { type: Date },
    status: {
      type: String,
      enum: ["in-progress", "submitted", "invalid"],
      default: "in-progress",
      index: true,
    },
    deviceInfo: {
      cores: { type: Number },
      memory: { type: Number },
      os: { type: String }
    },
    proctoringTier: {
      type: String,
      enum: ["full", "snapshot", "event-only"],
      default: "full"
    },
    answers: { type: [AnswerSchema], default: [] },
    score: { type: Number, default: 0 },
    integrityScore: { type: Number, default: 100 },
    blockchainHash: { type: String, default: null },
    manualNeeded: { type: Boolean, default: false },
    violations: { type: [ViolationSchema], default: [] },
  },
  { timestamps: true }
);

AttemptSchema.index(
  { examId: 1, studentId: 1, studentRef: 1 },
  { unique: false }
);

export default mongoose.model("Attempt", AttemptSchema);
