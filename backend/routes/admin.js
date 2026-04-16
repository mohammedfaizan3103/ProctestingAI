import express from "express";
import bcrypt from "bcryptjs";
import User from "../models/User.js";
import Student from "../models/Student.js";
import auth from "../middleware/authMiddleware.js";
import multer from "multer";
import XLSX from "xlsx";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Admin-only: Create a faculty account
// POST /api/admin/faculty
router.post("/faculty", auth, auth.requireRole("admin"), async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ message: "name, email and password are required" });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res
        .status(400)
        .json({ message: "User with this email already exists" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      role: "faculty",
    });

    return res.status(201).json({
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Admin-only: List all faculty
// GET /api/admin/faculty
router.get("/faculty", auth, auth.requireRole("admin"), async (_req, res) => {
  try {
    const faculty = await User.find({ role: "faculty" })
      .select("name email role createdAt")
      .sort({ createdAt: -1 });
    return res.json(faculty);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Admin: List users with filters
// GET /api/admin/users?role=student|faculty&search=&department=&college=&section=&year=&semester=
router.get("/users", auth, auth.requireRole("admin"), async (req, res) => {
  try {
    const {
      role,
      search,
      department,
      college,
      section,
      year,
      semester,
      limit = 200,
      page = 1,
      sort = "-createdAt",
    } = req.query;

    const q = {};
    if (role) q.role = role;
    if (department) q.department = department;
    if (college) q.college = college;
    if (section !== undefined) {
      const n = Number(section);
      if (!Number.isNaN(n)) q.section = n;
    }
    if (year !== undefined) {
      const n = Number(year);
      if (!Number.isNaN(n)) q.year = n;
    }
    if (semester !== undefined) {
      const n = Number(semester);
      if (!Number.isNaN(n)) q.semester = n;
    }
    if (search) {
      const s = String(search).trim();
      q.$or = [
        { name: { $regex: s, $options: "i" } },
        { email: { $regex: s, $options: "i" } },
        { rollno: { $regex: s, $options: "i" } },
      ];
    }

    const lim = Math.max(1, Math.min(500, Number(limit) || 200));
    const pg = Math.max(1, Number(page) || 1);
    const skip = (pg - 1) * lim;

    const [items, total] = await Promise.all([
      User.find(q)
        .select(
          "name email rollno role college year department section semester createdAt"
        )
        .sort(sort)
        .skip(skip)
        .limit(lim),
      User.countDocuments(q),
    ]);

    return res.json({ items, total, page: pg, limit: lim });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Admin: Update a user
// PATCH /api/admin/users/:id
router.patch(
  "/users/:id",
  auth,
  auth.requireRole("admin"),
  async (req, res) => {
    try {
      const id = req.params.id;
      const allowed = [
        "name",
        "email",
        "rollno",
        "college",
        "year",
        "department",
        "section",
        "semester",
      ];
      const update = {};
      for (const k of allowed) {
        if (req.body[k] !== undefined) update[k] = req.body[k];
      }

      // Normalize numeric fields
      if (update.section !== undefined) update.section = Number(update.section);
      if (update.year !== undefined) update.year = Number(update.year);
      if (update.semester !== undefined)
        update.semester = Number(update.semester);

      const user = await User.findByIdAndUpdate(id, update, {
        new: true,
        runValidators: true,
      }).select("-password");

      if (!user) return res.status(404).json({ message: "User not found" });
      return res.json(user);
    } catch (err) {
      console.error(err);
      // Likely duplicate key error for email/rollno
      if (err && err.code === 11000) {
        return res
          .status(400)
          .json({ message: "Duplicate key", keyValue: err.keyValue });
      }
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Admin: Reset a user's password
// POST /api/admin/users/:id/reset-password { toRollno?: boolean }
router.post(
  "/users/:id/reset-password",
  auth,
  auth.requireRole("admin"),
  async (req, res) => {
    try {
      const id = req.params.id;
      const { toRollno = true } = req.body || {};
      const user = await User.findById(id);
      if (!user) return res.status(404).json({ message: "User not found" });

      let newPassword = "changeme123";
      if (toRollno && user.rollno) newPassword = String(user.rollno);

      const salt = await bcrypt.genSalt(10);
      user.password = await bcrypt.hash(newPassword, salt);
      await user.save();

      return res.json({ ok: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// List Student roster (directory)
// GET /api/admin/students?search=&department=&college=&section=&year=&semester=&limit=&page=&sort=
router.get("/students", auth, auth.requireRole("admin"), async (req, res) => {
  try {
    const {
      search,
      department,
      college,
      section,
      year,
      semester,
      limit = 200,
      page = 1,
      sort = "-createdAt",
    } = req.query;

    const q = {};
    if (department) q.department = department;
    if (college) q.college = college;
    if (section !== undefined) {
      const n = Number(section);
      if (!Number.isNaN(n)) q.section = n;
    }
    if (year !== undefined) {
      const n = Number(year);
      if (!Number.isNaN(n)) q.year = n;
    }
    if (semester !== undefined) {
      const n = Number(semester);
      if (!Number.isNaN(n)) q.semester = n;
    }
    if (search) {
      const s = String(search).trim();
      q.$or = [
        { name: { $regex: s, $options: "i" } },
        { email: { $regex: s, $options: "i" } },
        { rollno: { $regex: s, $options: "i" } },
      ];
    }

    const lim = Math.max(1, Math.min(500, Number(limit) || 200));
    const pg = Math.max(1, Number(page) || 1);
    const skip = (pg - 1) * lim;

    const [items, total] = await Promise.all([
      Student.find(q).sort(sort).skip(skip).limit(lim),
      Student.countDocuments(q),
    ]);

    return res.json({ items, total, page: pg, limit: lim });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Admin-only: Bulk upload students via CSV/XLSX
// POST /api/admin/students/upload (form-data: file)
router.post(
  "/students/upload",
  auth,
  auth.requireRole("admin"),
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }
      // Parse buffer with xlsx; supports .csv, .xlsx, .xls
      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      // Helper to normalize header keys
      const norm = (s) =>
        String(s || "")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");

      let created = 0;
      let skipped = 0;
      const errors = [];

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        // Build a case-insensitive map
        const map = {};
        Object.keys(r).forEach((k) => (map[norm(k)] = r[k]));

        const rollno = String(map["rollno"] || map["rollnumber"] || "").trim();
        const name = String(map["name"] || "").trim();
        const dept = String(map["dept"] || map["department"] || "").trim();
        const college = String(map["college"] || "").trim();
        const sectionRaw = String(map["section"] || "").trim();
        const semRaw = String(map["semester"] || map["sem"] || "").trim();

        if (!rollno || !name) {
          skipped++;
          errors.push({ row: i + 2, error: "Missing rollno or name" });
          continue;
        }

        // Prepare derived fields
        const section = sectionRaw ? Number(sectionRaw) : undefined;
        const semester = semRaw ? Number(semRaw) : undefined;
        const year = semester
          ? Math.max(1, Math.min(4, Math.ceil(semester / 2)))
          : undefined;

        // Skip if roster already has this student by rollno
        const existing = await Student.findOne({ rollno });
        if (existing) {
          skipped++;
          continue;
        }

        try {
          await Student.create({
            rollno,
            name,
            email: `${rollno}@students.local`,
            college: college || undefined,
            year,
            department: dept || undefined,
            section:
              typeof section === "number" && !Number.isNaN(section)
                ? section
                : undefined,
            semester:
              typeof semester === "number" && !Number.isNaN(semester)
                ? semester
                : undefined,
          });
          created++;
        } catch (e) {
          skipped++;
          errors.push({ row: i + 2, error: e.message });
        }
      }

      return res.json({ total: rows.length, created, skipped, errors });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to process file" });
    }
  }
);

export default router;
