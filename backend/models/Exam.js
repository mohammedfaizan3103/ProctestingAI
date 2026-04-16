import mongoose from "mongoose";

const QuestionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["single", "mcq", "text"],
      required: true,
    },
    text: { type: String, required: true },
    // Optional short tag/extra info per question (e.g., CO1, CO2)
    additionalInfo: { type: String, default: "" },
    options: [{ type: String }], // required for choice questions
    correctAnswers: [{ type: Number }], // indexes into options (single: length 1)
    points: { type: Number, default: 1, min: 0 },
  },
  { _id: false }
);

const ExamSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String },
    durationMins: { type: Number, required: true, min: 1 },
    window: {
      start: { type: Date, required: true },
      end: { type: Date, required: true },
    },
    questions: { type: [QuestionSchema], default: [] },
    assignmentCriteria: {
      college: { type: String },
      year: [{ type: Number, min: 1, max: 4 }],
      department: [{ type: String }],
      section: [{ type: Number, min: 1, max: 5 }],
      // Optional: target specific semesters; when specified, students must match
      semester: [{ type: Number, min: 1, max: 8 }],
    },
    // Faculty-granted per-student retake tokens for this exam
    // Each entry gives a student N additional starts after a submission/invalid
    retakeGrants: {
      type: [
        new mongoose.Schema(
          {
            studentId: {
              type: mongoose.Schema.Types.ObjectId,
              ref: "User",
              required: true,
              index: true,
            },
            remaining: { type: Number, default: 1, min: 0 },
            grantedAt: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    proctoringTier: {
      type: String,
      enum: ["full", "snapshot", "event-only"],
      default: "full"
    },
  },
  { timestamps: true }
);

// Validate window using a pre-validate hook (works for nested objects)
ExamSchema.pre("validate", function (next) {
  const w = this.window || {};
  if (!w.start || !w.end) {
    this.invalidate("window", "Exam window requires start and end");
  } else if (new Date(w.end).getTime() <= new Date(w.start).getTime()) {
    this.invalidate("window.end", "Exam window end must be after start");
  }
  next();
});

// Per-question consistency checks
ExamSchema.path("questions").validate(function (questions) {
  for (const q of questions) {
    if (q.type === "single" || q.type === "mcq") {
      if (!q.options || q.options.length < 2) return false;
      if (!Array.isArray(q.correctAnswers)) return false;
      // single expects exactly one correct answer
      if (q.type === "single" && q.correctAnswers.length !== 1) return false;
      // ensure indexes are in range
      if (q.correctAnswers.some((idx) => idx < 0 || idx >= q.options.length))
        return false;
    }
    if (q.type === "text") {
      // text shouldn't have options/correctAnswers (but tolerate empty)
      /* no-op */
    }
  }
  return true;
}, "Invalid questions configuration");

export default mongoose.model("Exam", ExamSchema);
