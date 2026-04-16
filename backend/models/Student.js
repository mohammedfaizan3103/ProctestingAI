import mongoose from "mongoose";

// Roster of students uploaded by admin. Not used for authentication.
const StudentSchema = new mongoose.Schema(
  {
    // University-issued roll number (unique identifier)
    rollno: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },

    // Optional contact
    email: { type: String },

    // Academic profile
    college: { type: String },
    year: { type: Number, min: 1, max: 4 },
    department: { type: String },
    section: { type: Number, min: 1, max: 5 },
    semester: { type: Number, min: 1, max: 8 },
    // Promotion cycle guards to avoid double increments within same cycle
    // Format: 'YYYY-01' for January cycle, 'YYYY-07' for July cycle
    lastSemCycle: { type: String },
    lastYearCycle: { type: String },
  },
  { timestamps: true }
);

export default mongoose.model("Student", StudentSchema);
