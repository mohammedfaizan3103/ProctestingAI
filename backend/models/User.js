import mongoose from "mongoose";

const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    // Login identifier (email) — for bulk-uploaded students we will synthesize one from roll number
    email: { type: String, required: true, unique: true, index: true },
    // University issued Roll Number used as username for students
    rollno: { type: String, unique: true, sparse: true, index: true },
    password: { type: String, required: true },

    // Role-based access
    role: {
      type: String,
      enum: ["student", "faculty", "admin"],
      default: "student",
      index: true,
    },

    // Student profile fields (optional for non-students)
    college: { type: String },
    year: { type: Number, min: 1, max: 4 },
    department: { type: String },
    section: { type: Number, min: 1, max: 5 },
    // Optional explicit semester (1..14 etc.). If set, year may be derived as ceil(semester/2)
    semester: { type: Number, min: 1, max: 8 },
  },
  { timestamps: true }
);

// Store faculty/teachers in the 'teachers' collection while keeping the model name 'User'
// to avoid widespread code changes. This only changes the underlying MongoDB collection name.
export default mongoose.model("User", UserSchema, "teachers");
