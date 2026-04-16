import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { createExam, generateAIQuestions, getExam, listMyExams, updateExam } from "../utils/api";
import MarkdownRenderer from "../components/MarkdownRenderer";

// --- Import helpers ---
// Simple CSV parser with quoted-field support
const parseCSV = (text, delimiter = ",") => {
  const rows = [];
  let row = [];
  let curr = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        curr += '"';
        i += 2;
        continue;
      }
      inQuotes = !inQuotes;
      i++;
      continue;
    }
    if (!inQuotes && ch === delimiter) {
      row.push(curr);
      curr = "";
      i++;
      continue;
    }
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && next === "\n") i++;
      row.push(curr);
      rows.push(row);
      row = [];
      curr = "";
      i++;
      continue;
    }
    curr += ch;
    i++;
  }
  if (curr.length || row.length) {
    row.push(curr);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim()));
};

const headerIndexMap = (headerRow) => {
  const map = {};
  headerRow.forEach((h, idx) => {
    const key = (h || "").toLowerCase().trim();
    if (!key) return;
    map[key] = idx;
  });
  return map;
};

const toIndicesFromCorrect = (correctRaw, options) => {
  if (!correctRaw) return [];
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const parts = String(correctRaw)
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const idxs = [];
  parts.forEach((p) => {
    const li = letters.indexOf(p.toUpperCase());
    if (li >= 0 && li < options.length) {
      idxs.push(li);
      return;
    }
    if (/^\d+$/.test(p)) {
      const n = parseInt(p, 10);
      const zero = n > 0 && n <= options.length ? n - 1 : n;
      if (zero >= 0 && zero < options.length) idxs.push(zero);
      return;
    }
    const byText = options.findIndex(
      (o) => o.trim().toLowerCase() === p.toLowerCase()
    );
    if (byText >= 0) idxs.push(byText);
  });
  return Array.from(new Set(idxs)).sort((a, b) => a - b);
};

const buildQuestion = ({ type, text, additionalInfo, options, correct, points }) => {
  const qText = (text || "").trim();
  const info = (additionalInfo || "").trim();
  const pts = Number(points || 1) || 1;
  const opts = (options || []).map((o) => String(o).trim()).filter(Boolean);

  let qType = type;
  if (!qType) qType = opts.length ? "single" : "text";
  if (!["single", "mcq", "text"].includes(qType)) {
    qType = opts.length ? "single" : "text";
  }

  if (qType === "text") {
    return {
      type: "text",
      text: qText,
      additionalInfo: info,
      options: [],
      correctAnswers: [],
      points: pts,
    };
  }

  const indices = toIndicesFromCorrect(correct, opts);
  const corr =
    qType === "single" ? (indices[0] != null ? [indices[0]] : [0]) : indices;
  const finalOpts = opts.length >= 2 ? opts : [...opts, ""].slice(0, 2);
  return {
    type: qType,
    text: qText,
    additionalInfo: info,
    options: finalOpts,
    correctAnswers: corr,
    points: pts,
  };
};

// Sheets CSV/TSV parser, accepts headers: text,type,options,correct,points,additionalInfo
const parseFromSheets = (raw, delimiter = ",") => {
  const rows = parseCSV(raw, delimiter);
  if (!rows.length) return [];
  const header = rows[0].map((h) => (h || "").toLowerCase());
  const hasHeader = [
    "text",
    "question",
    "type",
    "options",
    "correct",
    "points",
    "additionalinfo",
    "info",
  ].some((h) => header.includes(h));
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const hmap = hasHeader
    ? headerIndexMap(rows[0])
    : { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4 };
  return dataRows
    .map((r) => {
      const get = (keyOrIdx) =>
        typeof keyOrIdx === "number"
          ? r[keyOrIdx] || ""
          : r[hmap[keyOrIdx]] || "";
      const text = get(
        hmap.text !== undefined
          ? "text"
          : hmap.question !== undefined
          ? "question"
          : 0
      );
      const additionalInfo =
        get("additionalinfo") || get("info") || get("co") || "";
      const type = (get("type") || "").toLowerCase();
      const rawOptions = get("options") || get(2) || "";
      const options = rawOptions
        .split(/\s*\|\s*|\s*;;\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
      const correct = get("correct") || get(3) || "";
      const points = get("points") || get(4) || "1";
      if (!String(text).trim()) return null;
      return buildQuestion({ type, text, additionalInfo, options, correct, points });
    })
    .filter(Boolean);
};

// Docs parser: blocks separated by blank lines. Lines:
// Q: question text
// A) option, B) option ...
// Correct: A,B or 1,2 or option text
// Points: n
const parseFromDocs = (raw) => {
  const blocks = raw
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const letterLineRe = /^\s*([A-Za-z])[\)\.\-]\s+(.+)$/;
  const result = [];
  blocks.forEach((block) => {
    const lines = block
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return;
    let qText = lines[0].replace(/^Q(?:uestion)?\s*[:\-\.\)]\s*/i, "").trim();
    if (!qText) qText = lines[0];
    const options = [];
    let correctRaw = "";
    let type = "";
    let points = "";
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const opt = letterLineRe.exec(line);
      if (opt) {
        options.push(opt[2].trim());
        continue;
      }
      if (/^correct\s*[:\-]/i.test(line)) {
        correctRaw = line.replace(/^correct\s*[:\-]\s*/i, "").trim();
        continue;
      }
      if (/^answer\s*[:\-]/i.test(line)) {
        correctRaw = line.replace(/^answer\s*[:\-]\s*/i, "").trim();
        continue;
      }
      if (/^type\s*[:\-]/i.test(line)) {
        type = line
          .replace(/^type\s*[:\-]\s*/i, "")
          .trim()
          .toLowerCase();
        continue;
      }
      if (/^points?\s*[:\-]/i.test(line)) {
        points = line.replace(/^points?\s*[:\-]\s*/i, "").trim();
        continue;
      }
    }
    if (!type)
      type =
        options.length === 0
          ? "text"
          : /,|;|\|/.test(correctRaw)
          ? "mcq"
          : "single";
    result.push(
      buildQuestion({ type, text: qText, options, correct: correctRaw, points })
    );
  });
  return result;
};

const emptyQuestion = (type = "single") => {
  if (type === "text") {
    return {
      type: "text",
      text: "",
      additionalInfo: "",
      options: [],
      correctAnswers: [],
      points: 1,
    };
  }
  if (type === "mcq") {
    return {
      type: "mcq",
      text: "",
      additionalInfo: "",
      options: ["", ""],
      correctAnswers: [],
      points: 1,
    };
  }
  return {
    type: "single",
    text: "",
    additionalInfo: "",
    options: ["", ""],
    correctAnswers: [0],
    points: 1,
  };
};

const ExamEditor = () => {
  const navigate = useNavigate();
  const { id } = useParams(); // if present => edit mode
  const isEdit = Boolean(id && id !== "new");

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: "",
    description: "",
    durationMins: 60,
    proctoringTier: "full",
    windowStart: "",
    windowEnd: "",
    assignment: {
      college: "",
      year: [],
      department: [],
      section: [],
      semester: [],
    },
    questions: [emptyQuestion()],
  });

  // Import modal state
  const [importOpen, setImportOpen] = useState(false);
  const [importMode, setImportMode] = useState("sheets"); // 'sheets' | 'docs'
  const [importDelimiter, setImportDelimiter] = useState(",");
  const [importInput, setImportInput] = useState("");
  const [parsedPreview, setParsedPreview] = useState([]);
  const [importError, setImportError] = useState("");
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [selectedFileName, setSelectedFileName] = useState("");

  // AI generate modal state
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiQuestions, setAiQuestions] = useState([]);
  const [aiReplaceExisting, setAiReplaceExisting] = useState(false);

  // Auto-fill from previous test state
  const [autofillOpen, setAutofillOpen] = useState(false);
  const [autofillExams, setAutofillExams] = useState([]);
  const [autofillSearch, setAutofillSearch] = useState("");
  const [autofillLoading, setAutofillLoading] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("user");
    if (!stored) {
      navigate("/login");
      return;
    }
    const u = JSON.parse(stored);
    if (u.role !== "faculty") {
      navigate("/");
      return;
    }
    if (isEdit) {
      loadExam();
    } else {
      // Load previous exams so faculty can auto-fill from one
      setAutofillLoading(true);
      listMyExams()
        .then(({ data }) => setAutofillExams(Array.isArray(data) ? data : []))
        .catch(() => setAutofillExams([]))
        .finally(() => setAutofillLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const loadExam = async () => {
    try {
      const { data } = await getExam(id);
      setForm({
        title: data.title || "",
        description: data.description || "",
        durationMins: data.durationMins || 60,
        proctoringTier: data.proctoringTier || "full",
        windowStart: data.window?.start
          ? toLocalDateTime(data.window.start)
          : "",
        windowEnd: data.window?.end ? toLocalDateTime(data.window.end) : "",
        assignment: {
          college: data.assignmentCriteria?.college || "",
          year: data.assignmentCriteria?.year || [],
          department: data.assignmentCriteria?.department || [],
          section: data.assignmentCriteria?.section || [],
          semester: data.assignmentCriteria?.semester || [],
        },
        questions:
          data.questions && data.questions.length > 0
            ? data.questions
            : [emptyQuestion()],
      });
    } catch (e) {
      setError(
        e?.response?.data?.message ||
          e?.response?.data?.error ||
          "Failed to load exam"
      );
    }
  };

  const toLocalDateTime = (iso) => {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mi = pad(d.getMinutes());
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
  };

  const fromLocalToISO = (val) => (val ? new Date(val).toISOString() : "");

  // Helpers to set default scheduling based on duration
  const nowLocal = () => {
    const d = new Date();
    d.setSeconds(0, 0);
    return toLocalDateTime(d.toISOString());
  };

  const addMinsLocal = (dtLocalStr, mins) => {
    const d = dtLocalStr ? new Date(dtLocalStr) : new Date();
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + Number(mins || 0));
    return toLocalDateTime(d.toISOString());
  };

  const updateQuestion = (idx, patch) => {
    setForm((f) => {
      const qs = [...f.questions];
      qs[idx] = { ...qs[idx], ...patch };
      return { ...f, questions: qs };
    });
  };

  const addQuestion = () =>
    setForm((f) => ({ ...f, questions: [...f.questions, emptyQuestion()] }));

  const addQuestionOfType = (type) =>
    setForm((f) => ({
      ...f,
      questions: [...f.questions, emptyQuestion(type)],
    }));

  const removeQuestion = (idx) =>
    setForm((f) => ({
      ...f,
      questions: f.questions.filter((_, i) => i !== idx),
    }));

  const duplicateQuestion = (idx) =>
    setForm((f) => {
      const qs = [...f.questions];
      const copy = JSON.parse(JSON.stringify(qs[idx]));
      qs.splice(idx + 1, 0, copy);
      return { ...f, questions: qs };
    });

  const setOption = (qIdx, optIdx, value) => {
    setForm((f) => {
      const qs = [...f.questions];
      const q = { ...qs[qIdx] };
      const opts = [...(q.options || [])];
      opts[optIdx] = value;
      q.options = opts;
      qs[qIdx] = q;
      return { ...f, questions: qs };
    });
  };

  const addOption = (qIdx) =>
    setForm((f) => {
      const qs = [...f.questions];
      const q = { ...qs[qIdx] };
      q.options = [...(q.options || []), ""];
      qs[qIdx] = q;
      return { ...f, questions: qs };
    });

  const removeOption = (qIdx, optIdx) =>
    setForm((f) => {
      const qs = [...f.questions];
      const q = { ...qs[qIdx] };
      q.options = (q.options || []).filter((_, i) => i !== optIdx);
      // also remove any correctAnswers referencing this index
      q.correctAnswers = (q.correctAnswers || [])
        .filter((i) => i !== optIdx)
        .map((i) => (i > optIdx ? i - 1 : i));
      qs[qIdx] = q;
      return { ...f, questions: qs };
    });

  const toggleCorrect = (qIdx, optIdx, isMulti) =>
    setForm((f) => {
      const qs = [...f.questions];
      const q = { ...qs[qIdx] };
      const curr = new Set(q.correctAnswers || []);
      if (isMulti) {
        if (curr.has(optIdx)) curr.delete(optIdx);
        else curr.add(optIdx);
        q.correctAnswers = Array.from(curr).sort((a, b) => a - b);
      } else {
        q.correctAnswers = [optIdx];
      }
      qs[qIdx] = q;
      return { ...f, questions: qs };
    });

  const onSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const toFiniteNumber = (value, fallback) => {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
      };

      const payload = {
        title: form.title,
        description: form.description,
        durationMins: Number(form.durationMins),
        proctoringTier: form.proctoringTier,
        window: {
          start: fromLocalToISO(form.windowStart),
          end: fromLocalToISO(form.windowEnd),
        },
        questions: form.questions.map((q) => ({
          type: q.type,
          text: q.text,
          additionalInfo: String(q.additionalInfo || "").trim(),
          options:
            q.type === "text" ? [] : (q.options || []).filter((s) => s !== ""),
          correctAnswers: q.type === "text" ? [] : q.correctAnswers || [],
          points: toFiniteNumber(q.points, 1),
        })),
        assignmentCriteria: {
          college: form.assignment.college || undefined,
          year: form.assignment.year,
          department: form.assignment.department,
          section: form.assignment.section,
          semester: form.assignment.semester,
        },
      };

      if (isEdit) {
        await updateExam(id, payload);
      } else {
        const { data } = await createExam(payload);
        // navigate to edit page of new exam
        navigate(`/faculty/exams/${data._id}`);
        return;
      }
      navigate("/faculty/exams");
    } catch (e) {
      setError(
        e?.response?.data?.message ||
          e?.response?.data?.error ||
          "Failed to save exam"
      );
    } finally {
      setSaving(false);
    }
  };

  // Initialize default window on create (not edit)
  useEffect(() => {
    if (isEdit) return;
    setForm((f) => {
      // Only set if empty to avoid overriding user input
      const start = f.windowStart || nowLocal();
      const end = f.windowEnd || addMinsLocal(start, f.durationMins || 60);
      return { ...f, windowStart: start, windowEnd: end };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit]);

  // When duration changes, if start is empty, set to now; always recompute end from start
  useEffect(() => {
    setForm((f) => {
      const start = f.windowStart || nowLocal();
      const end = addMinsLocal(start, f.durationMins || 60);
      return { ...f, windowStart: start, windowEnd: end };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.durationMins]);

  // Import parsing helpers inside component scope
  const runParse = (raw, mode, delimiter) => {
    try {
      setImportError("");
      const parsed =
        mode === "docs" ? parseFromDocs(raw) : parseFromSheets(raw, delimiter);
      setParsedPreview(parsed);
    } catch (e) {
      setParsedPreview([]);
      setImportError("Could not parse content. Check format and try again.");
    }
  };

  useEffect(() => {
    if (!importOpen) return;
    runParse(importInput, importMode, importDelimiter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importInput, importMode, importDelimiter, importOpen]);

  const handleFile = async (file) => {
    if (!file) return;
    setSelectedFileName(file.name);
    const text = await file.text();
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".csv")) setImportMode("sheets");
    else if (lower.endsWith(".tsv")) {
      setImportMode("sheets");
      setImportDelimiter("\t");
    } else if (lower.endsWith(".txt")) setImportMode("docs");
    setImportInput(text);
  };

  const addImportedQuestions = () => {
    if (!parsedPreview.length) return;
    setForm((f) => ({
      ...f,
      questions: replaceExisting
        ? [...parsedPreview]
        : [...f.questions, ...parsedPreview],
    }));
    setImportOpen(false);
    setImportInput("");
    setParsedPreview([]);
    setSelectedFileName("");
    setReplaceExisting(false);
  };


  // Map agent.py output → ExamEditor question format
  const mapAIQuestion = (q) => ({
    type: q.options && q.options.length >= 2 ? "single" : "text",
    text: q.question || "",
    options: q.options || [],
    correctAnswers: q.options && q.options.length ? [q.correctAnswerIndex ?? 0] : [],
    points: 1,
  });

  const handleAIGenerate = async () => {
    if (!aiPrompt.trim()) {
      setAiError("Please enter a prompt describing the questions you want.");
      return;
    }
    setAiLoading(true);
    setAiError("");
    setAiQuestions([]);
    try {
      const { data } = await generateAIQuestions(aiPrompt.trim());
      const mapped = (data.questions || []).map(mapAIQuestion);
      if (!mapped.length) {
        setAiError("No questions were generated. Try a more specific prompt.");
      } else {
        setAiQuestions(mapped);
      }
    } catch (e) {
      setAiError(
        e?.response?.data?.error ||
          "Failed to generate questions. Check your prompt and try again."
      );
    } finally {
      setAiLoading(false);
    }
  };

  const addAIQuestions = () => {
    if (!aiQuestions.length) return;
    setForm((f) => ({
      ...f,
      questions: aiReplaceExisting
        ? [...aiQuestions]
        : [...f.questions, ...aiQuestions],
    }));
    setAiOpen(false);
    setAiPrompt("");
    setAiQuestions([]);
    setAiReplaceExisting(false);
    setAiError("");
  };

  const applyAutofill = (exam) => {
    const start = nowLocal();
    const end = addMinsLocal(start, exam.durationMins || 60);
    setForm({
      title: exam.title || "",
      description: exam.description || "",
      durationMins: exam.durationMins || 60,
      proctoringTier: exam.proctoringTier || "full",
      windowStart: start,
      windowEnd: end,
      assignment: {
        college: exam.assignmentCriteria?.college || "",
        year: exam.assignmentCriteria?.year || [],
        department: exam.assignmentCriteria?.department || [],
        section: exam.assignmentCriteria?.section || [],
        semester: exam.assignmentCriteria?.semester || [],
      },
      questions: [emptyQuestion()],
    });
    setAutofillOpen(false);
    setAutofillSearch("");
  };

 
  const sampleCSV = `text,additionalInfo,type,options,correct,points
What is 2+2?,CO1,single,2 | 3 | 4 | 5,3,1
Select prime numbers,CO2,mcq,2 | 3 | 4 | 5,"A,B",3
Explain Newton's second law,,text,,,5`;


  const sampleDocs = `Q: What is 2+2?
A) 2
B) 3
C) 4
D) 5
Correct: C
Points: 1

Q: Select prime numbers
A) 2
B) 3
C) 4
D) 5
Correct: A,B
Points: 3

Q: Explain Newton's second law
Points: 5`;

  const years = [1, 2, 3, 4];
  const semesters = [1, 2, 3, 4, 5, 6, 7, 8];
  const sections = [1, 2, 3, 4, 5];

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="flex items-start sm:items-center justify-between gap-2 flex-col sm:flex-row mb-6">
        <h1 className="text-3xl font-bold text-slate-900">
          {isEdit ? "Edit Exam" : "Create Exam"}
        </h1>
        <div className="flex items-center gap-3">
          {!isEdit && (
            <button
              type="button"
              onClick={() => { setAutofillOpen(true); setAutofillSearch(""); }}
              disabled={autofillLoading}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-amber-50 border border-amber-300 text-amber-800 hover:bg-amber-100 transition-colors text-sm font-medium disabled:opacity-60"
              title="Copy settings from a previously created exam"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                <path fillRule="evenodd" d="M9.315 7.584C12.195 3.883 16.695 1.5 21.75 1.5a.75.75 0 0 1 .75.75c0 5.056-2.383 9.555-6.084 12.436A6.75 6.75 0 0 1 9.75 22.5a.75.75 0 0 1-.75-.75v-4.131A15.838 15.838 0 0 1 6.382 15H2.25a.75.75 0 0 1-.75-.75 6.75 6.75 0 0 1 7.815-6.666ZM15 6.75a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5Z" clipRule="evenodd" />
                <path d="M5.26 17.242a.75.75 0 1 0-.897-1.203 5.243 5.243 0 0 0-2.05 5.022.75.75 0 0 0 .625.627 5.243 5.243 0 0 0 5.022-2.051.75.75 0 1 0-1.202-.897 3.744 3.744 0 0 1-3.008 1.51c0-1.23.592-2.323 1.51-3.008Z" />
              </svg>
              {autofillLoading ? "Loading…" : "Auto-fill from previous"}
            </button>
          )}
          <button
            onClick={() => navigate("/faculty/exams")}
            className="inline-flex items-center gap-2 text-emerald-700 hover:text-emerald-800 hover:underline"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="w-4 h-4"
            >
              <path
                fillRule="evenodd"
                d="M9.53 3.22a.75.75 0 0 1 0 1.06L4.56 9.25H21a.75.75 0 0 1 0 1.5H4.56l4.97 4.97a.75.75 0 1 1-1.06 1.06l-6.25-6.25a.75.75 0 0 1 0-1.06l6.25-6.25a.75.75 0 0 1 1.06 0Z"
                clipRule="evenodd"
              />
            </svg>
            Back to list
          </button>
        </div>
      </div>

      {error && (
        <div
          className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded mb-4"
          role="alert"
          aria-live="polite"
        >
          {error}
        </div>
      )}

      <form
        onSubmit={onSave}
        className="bg-white rounded-lg shadow p-4 md:p-6 space-y-8"
      >
        {/* Basics */}
        <div className="space-y-4">
          <div className="border-b border-slate-200 pb-2">
            <h2 className="text-lg font-semibold text-slate-900">Basics</h2>
            <p className="text-sm text-slate-600">
              Core information students will see before starting.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Title
              </label>
              <input
                className="w-full px-3 py-2 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-white placeholder-slate-400"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Duration (mins)
              </label>
              <input
                type="number"
                min="1"
                className="w-full px-3 py-2 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-white"
                value={form.durationMins}
                onChange={(e) => {
                  const v = e.target.value;
                  setForm((f) => ({ ...f, durationMins: v }));
                }}
                required
              />
              <p className="help mt-1 text-xs text-slate-500">
                Total time allowed in minutes.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                AI Proctoring Tier
              </label>
              <select
                className="w-full px-3 py-2 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-white"
                value={form.proctoringTier}
                onChange={(e) => setForm({ ...form, proctoringTier: e.target.value })}
              >
                <option value="full">Full AI (Face & Gaze tracking)</option>
                <option value="snapshot">Snapshot AI (Infrequent checks)</option>
                <option value="event-only">Event Only (No Face Analytics, disables AI to save compute)</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Description
              </label>
              <textarea
                className="w-full px-3 py-2 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-white"
                rows={3}
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
              />
              <p className="help mt-1 text-xs text-slate-500">
                Optional short summary for students.
              </p>
            </div>
          </div>
        </div>

        {/* Scheduling */}
        <div className="space-y-4">
          <div className="border-b border-slate-200 pb-2">
            <h2 className="text-lg font-semibold text-slate-900">Scheduling</h2>
            <p className="text-sm text-slate-600">
              Define when the exam can be started by students.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Window start
              </label>
              <input
                type="datetime-local"
                className="w-full px-3 py-2 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-white"
                value={form.windowStart}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    windowStart: e.target.value,
                    // Keep end in sync with new start and current duration
                    windowEnd: addMinsLocal(
                      e.target.value,
                      f.durationMins || 60
                    ),
                  }))
                }
                required
              />
              <p className="help mt-1 text-xs text-slate-500">
                Local date and time when students can start.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Window end
              </label>
              <input
                type="datetime-local"
                className="w-full px-3 py-2 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-white"
                value={form.windowEnd}
                onChange={(e) =>
                  setForm({ ...form, windowEnd: e.target.value })
                }
                required
              />
              <p className="help mt-1 text-xs text-slate-500">
                Local date and time after which the exam can’t be started.
              </p>
            </div>
          </div>
        </div>

        {/* Assignment */}
        <div className="space-y-4">
          <div className="border-b border-slate-200 pb-2">
            <h2 className="text-lg font-semibold text-slate-900">
              Assignment criteria
            </h2>
            <p className="text-sm text-slate-600">
              Leave a field empty to apply to all. Use comma-separated lists for
              multiple departments.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                College
              </label>
              <input
                className="w-full px-3 py-2 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-white"
                value={form.assignment.college}
                onChange={(e) =>
                  setForm({
                    ...form,
                    assignment: { ...form.assignment, college: e.target.value },
                  })
                }
                placeholder="Optional"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Year
              </label>
              <div className="flex flex-wrap gap-3">
                {years.map((y) => (
                  <label
                    key={y}
                    className={`inline-flex items-center gap-2 px-2 py-1 rounded border text-sm ${
                      form.assignment.year.includes(y)
                        ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                        : "bg-slate-50 border-slate-200 text-slate-700"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="accent-emerald-600"
                      checked={form.assignment.year.includes(y)}
                      onChange={(e) => {
                        const set = new Set(form.assignment.year);
                        e.target.checked ? set.add(y) : set.delete(y);
                        setForm({
                          ...form,
                          assignment: {
                            ...form.assignment,
                            year: Array.from(set),
                          },
                        });
                      }}
                    />
                    <span>{y}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Semester
              </label>
              <div className="flex flex-wrap gap-3">
                {semesters.map((s) => (
                  <label
                    key={s}
                    className={`inline-flex items-center gap-2 px-2 py-1 rounded border text-sm ${
                      form.assignment.semester.includes(s)
                        ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                        : "bg-slate-50 border-slate-200 text-slate-700"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="accent-emerald-600"
                      checked={form.assignment.semester.includes(s)}
                      onChange={(e) => {
                        const set = new Set(form.assignment.semester);
                        e.target.checked ? set.add(s) : set.delete(s);
                        setForm({
                          ...form,
                          assignment: {
                            ...form.assignment,
                            semester: Array.from(set),
                          },
                        });
                      }}
                    />
                    <span>{s}</span>
                  </label>
                ))}
              </div>
              <p className="help mt-1 text-xs text-slate-500">
                If you specify semester(s), only students in those semesters
                will see the exam.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Department(s)
              </label>
              <input
                className="w-full px-3 py-2 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-white"
                placeholder="Comma separated e.g. CSE,EEE"
                value={form.assignment.department.join(", ")}
                onChange={(e) => {
                  const arr = e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  setForm({
                    ...form,
                    assignment: { ...form.assignment, department: arr },
                  });
                }}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Section(s)
              </label>
              <div className="flex flex-wrap gap-3">
                {sections.map((s) => (
                  <label
                    key={s}
                    className={`inline-flex items-center gap-2 px-2 py-1 rounded border text-sm ${
                      form.assignment.section.includes(s)
                        ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                        : "bg-slate-50 border-slate-200 text-slate-700"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="accent-emerald-600"
                      checked={form.assignment.section.includes(s)}
                      onChange={(e) => {
                        const set = new Set(form.assignment.section);
                        e.target.checked ? set.add(s) : set.delete(s);
                        setForm({
                          ...form,
                          assignment: {
                            ...form.assignment,
                            section: Array.from(set),
                          },
                        });
                      }}
                    />
                    <span>{s}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Questions */}
        <div className="space-y-4">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Questions
              </h2>
              <p className="text-sm text-slate-600">
                Create text or choice questions and assign points.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setAiOpen(true);
                  setAiError("");
                  setAiQuestions([]);
                }}
                className="px-3 py-2 rounded-md bg-indigo-600 text-white hover:bg-indigo-500 transition-colors inline-flex items-center gap-2 font-medium"
                title="Generate questions using AI"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                  <path fillRule="evenodd" d="M9 4.5a.75.75 0 0 1 .721.544l.813 2.846a3.75 3.75 0 0 0 2.576 2.576l2.846.813a.75.75 0 0 1 0 1.442l-2.846.813a3.75 3.75 0 0 0-2.576 2.576l-.813 2.846a.75.75 0 0 1-1.442 0l-.813-2.846a3.75 3.75 0 0 0-2.576-2.576l-2.846-.813a.75.75 0 0 1 0-1.442l2.846-.813A3.75 3.75 0 0 0 7.466 7.89l.813-2.846A.75.75 0 0 1 9 4.5ZM18 1.5a.75.75 0 0 1 .728.568l.258 1.036c.236.94.97 1.674 1.91 1.91l1.036.258a.75.75 0 0 1 0 1.456l-1.036.258c-.94.236-1.674.97-1.91 1.91l-.258 1.036a.75.75 0 0 1-1.456 0l-.258-1.036a2.625 2.625 0 0 0-1.91-1.91l-1.036-.258a.75.75 0 0 1 0-1.456l1.036-.258a2.625 2.625 0 0 0 1.91-1.91l.258-1.036A.75.75 0 0 1 18 1.5Z" clipRule="evenodd" />
                </svg>
                Use AI
              </button>
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                className="px-3 py-2 rounded-md bg-slate-900 text-white hover:bg-slate-800"
                title="Import from Google Sheets or Docs"
              >
                Import
              </button>
              <button
                type="button"
                onClick={() => addQuestionOfType("single")}
                className="px-3 py-2 rounded-md border border-slate-300 hover:bg-slate-50 text-slate-800"
              >
                Single choice
              </button>
              <button
                type="button"
                onClick={() => addQuestionOfType("mcq")}
                className="px-3 py-2 rounded-md border border-slate-300 hover:bg-slate-50 text-slate-800"
              >
                Multiple choice
              </button>
              <button
                type="button"
                onClick={() => addQuestionOfType("text")}
                className="px-3 py-2 rounded-md bg-emerald-600 text-slate-900 font-semibold hover:bg-emerald-500 transition-colors"
              >
                Text
              </button>
            </div>
          </div>
          {form.questions.map((q, idx) => {
            const isChoice = q.type === "single" || q.type === "mcq";
            const multi = q.type === "mcq";
            return (
              <div
                key={idx}
                className="rounded-lg border border-slate-200 bg-white p-4 space-y-3 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 flex-1">
                    <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-emerald-600 text-slate-900 text-sm font-semibold">
                      {idx + 1}
                    </span>
                    <select
                      className="w-auto px-3 py-2 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-white"
                      value={q.type}
                      onChange={(e) => {
                        const nextType = e.target.value;
                        if (nextType === "text") {
                          updateQuestion(idx, {
                            type: nextType,
                            options: [],
                            correctAnswers: [],
                          });
                        } else if (nextType === "single") {
                          const opts =
                            q.options && q.options.length
                              ? q.options
                              : ["", ""];
                          updateQuestion(idx, {
                            type: nextType,
                            options: opts,
                            correctAnswers: [0],
                          });
                        } else {
                          const opts =
                            q.options && q.options.length
                              ? q.options
                              : ["", ""];
                          updateQuestion(idx, {
                            type: nextType,
                            options: opts,
                            correctAnswers: [],
                          });
                        }
                      }}
                    >
                      <option value="single">Single choice</option>
                      <option value="mcq">Multiple choice</option>
                      <option value="text">Text</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => duplicateQuestion(idx)}
                      className="px-2 py-1 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"
                      title="Duplicate"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        className="w-4 h-4"
                      >
                        <path d="M7.5 3A2.25 2.25 0 0 0 5.25 5.25v9A2.25 2.25 0 0 0 7.5 16.5h6A2.25 2.25 0 0 0 15.75 14.25v-9A2.25 2.25 0 0 0 13.5 3h-6Z" />
                        <path d="M7.5 18.75A3.75 3.75 0 0 1 3.75 15V7.5a.75.75 0 0 1 1.5 0V15a2.25 2.25 0 0 0 2.25 2.25h7.5a.75.75 0 0 1 0 1.5h-7.5Z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeQuestion(idx)}
                      className="px-2 py-1 rounded-md border border-red-200 text-red-600 hover:bg-red-50"
                      title="Remove"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        className="w-4 h-4"
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.5 4.478V5.25h3.375a.75.75 0 0 1 0 1.5h-.62l-.76 11.083A3.75 3.75 0 0 1 14.757 21H9.243a3.75 3.75 0 0 1-3.738-3.167L4.745 6.75h-.62a.75.75 0 0 1 0-1.5H7.5v-.772A2.25 2.25 0 0 1 9.75 2.25h4.5A2.25 2.25 0 0 1 16.5 4.478Zm-6.75 0V5.25h4.5v-.772a.75.75 0 0 0-.75-.75h-3a.75.75 0 0 0-.75.75ZM9.75 9a.75.75 0 0 1 .75.75v6a.75.75 0 0 1-1.5 0v-6A.75.75 0 0 1 9.75 9Zm4.5 0a.75.75 0 0 1 .75.75v6a.75.75 0 0 1-1.5 0v-6A.75.75 0 0 1 14.25 9Z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>
                  </div>
                </div>

                <div className="flex flex-col md:flex-row md:items-center gap-3">
                  <input
                    className="border rounded-md flex-1 px-3 py-2 border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-white"
                    placeholder="Enter the question text"
                    value={q.text}
                    onChange={(e) =>
                      updateQuestion(idx, { text: e.target.value })
                    }
                  />
                  <div className="flex items-center gap-2">
                    <label className="text-sm text-slate-700">Info</label>
                    <input
                      className="border rounded-md w-28 px-3 py-2 border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-white"
                      placeholder="CO1"
                      value={q.additionalInfo || ""}
                      onChange={(e) =>
                        updateQuestion(idx, { additionalInfo: e.target.value })
                      }
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-sm text-slate-700">Points</label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      className="border rounded-md w-24 px-3 py-2 border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-white"
                      value={q.points}
                      onChange={(e) =>
                        updateQuestion(idx, { points: e.target.value })
                      }
                    />
                  </div>
                </div>

                {isChoice && (
                  <div className="space-y-2">
                    {(q.options || []).map((opt, oi) => (
                      <div key={oi} className="flex items-center gap-2">
                        {multi ? (
                          <input
                            type="checkbox"
                            className="accent-emerald-600"
                            checked={(q.correctAnswers || []).includes(oi)}
                            onChange={() => toggleCorrect(idx, oi, true)}
                          />
                        ) : (
                          <input
                            type="radio"
                            name={`q-${idx}-correct`}
                            className="accent-emerald-600"
                            checked={(q.correctAnswers || [])[0] === oi}
                            onChange={() => toggleCorrect(idx, oi, false)}
                          />
                        )}
                        <input
                          className="border rounded-md flex-1 px-3 py-2 border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-white"
                          placeholder={`Option ${oi + 1}`}
                          value={opt}
                          onChange={(e) => setOption(idx, oi, e.target.value)}
                        />
                        <button
                          type="button"
                          onClick={() => removeOption(idx, oi)}
                          className="text-sm text-red-600 hover:text-red-700 px-2 py-1 rounded-md hover:bg-red-50"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => addOption(idx)}
                      className="px-3 py-2 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"
                    >
                      + Add option
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="pt-2 flex items-center gap-3">
          <button
            disabled={saving}
            className="bg-emerald-600 text-slate-900 font-semibold px-4 py-2 rounded-md disabled:opacity-60 disabled:cursor-not-allowed hover:bg-emerald-500 transition-colors"
          >
            {saving ? "Saving..." : isEdit ? "Save changes" : "Create exam"}
          </button>
          <button
            type="button"
            onClick={() => navigate("/faculty/exams")}
            className="px-4 py-2 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
        </div>
      </form>
      {importOpen && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-slate-900/60"
            onClick={() => setImportOpen(false)}
          />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="w-full max-w-3xl bg-white rounded-lg shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
              <div className="px-5 py-4 border-b border-slate-200 flex items-start sm:items-center justify-between gap-2 flex-col sm:flex-row">
                <h3 className="text-lg font-semibold text-slate-900">
                  Import questions
                </h3>
                <button
                  onClick={() => setImportOpen(false)}
                  className="text-slate-500 hover:text-slate-700"
                  aria-label="Close import dialog"
                >
                  ✕
                </button>
              </div>

              <div className="px-5 py-4 space-y-4 flex-1 overflow-y-auto">
                <p className="text-sm text-slate-600">
                  Choose a document or paste content. Supported formats:
                </p>
                <ul className="list-disc pl-5 text-sm text-slate-700">
                  <li>
                    <span className="font-medium">
                      Google Sheets (CSV/TSV):
                    </span>{" "}
                    headers:{" "}
                    <code className="font-mono">
                      text, type, options, correct, points
                    </code>
                    . Options separated by <code className="font-mono">|</code>{" "}
                    or <code className="font-mono">;;</code>.
                  </li>
                  <li>
                    <span className="font-medium">Google Docs (Text):</span>{" "}
                    blocks like “Q: …”, lines “A) …”, “Correct: A,B”, “Points:
                    2”. Blank line between questions.
                  </li>
                </ul>
                <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded p-3">
                  <p className="mb-1">
                    <span className="font-semibold">CSV tip:</span> CSV uses
                    commas between columns. Each question is one row with
                    columns{" "}
                    <span className="font-mono">
                      text,type,options,correct,points
                    </span>
                    . If a value contains commas (e.g., multiple correct
                    answers), wrap it in quotes like{" "}
                    <span className="font-mono">"A,B"</span>.
                  </p>
                  <p>
                    <span className="font-semibold">
                      Multiple correct answers:
                    </span>{" "}
                    use commas (e.g., <span className="font-mono">A,B</span> or{" "}
                    <span className="font-mono">1,3</span>).
                  </p>
                </div>

                <div className="flex flex-col md:flex-row gap-3 md:items-center">
                  <div className="inline-flex rounded-md border border-slate-200 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setImportMode("sheets")}
                      className={`px-4 py-2 text-sm ${
                        importMode === "sheets"
                          ? "bg-slate-900 text-white"
                          : "bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      Google Sheets (CSV/TSV)
                    </button>
                    <button
                      type="button"
                      onClick={() => setImportMode("docs")}
                      className={`px-4 py-2 text-sm border-l border-slate-200 ${
                        importMode === "docs"
                          ? "bg-slate-900 text-white"
                          : "bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      Google Docs (Text)
                    </button>
                  </div>
                  {importMode === "sheets" && (
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-slate-700">
                        Delimiter
                      </label>
                      <select
                        value={importDelimiter}
                        onChange={(e) => setImportDelimiter(e.target.value)}
                        className="px-3 py-2 rounded-md border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      >
                        <option value=",">Comma (,)</option>
                        <option value="\t">Tab (TSV)</option>
                        <option value=";">Semicolon (;)</option>
                      </select>
                    </div>
                  )}
                  <div className="md:ml-auto flex items-center gap-2">
                    <label className="px-3 py-2 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer">
                      <input
                        type="file"
                        accept=".csv,.tsv,.txt"
                        className="hidden"
                        onChange={(e) => handleFile(e.target.files?.[0])}
                      />
                      Choose file
                    </label>
                    {selectedFileName && (
                      <span
                        className="text-xs text-slate-600 truncate max-w-[12rem]"
                        title={selectedFileName}
                      >
                        {selectedFileName}
                      </span>
                    )}
                  </div>
                </div>

                {importMode === "sheets" ? (
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(sampleCSV);
                        } catch {}
                      }}
                      className="px-3 py-2 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"
                    >
                      Copy CSV template
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(sampleDocs);
                        } catch {}
                      }}
                      className="px-3 py-2 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"
                    >
                      Copy Docs template
                    </button>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Paste{" "}
                    {importMode === "sheets"
                      ? "CSV/TSV from Sheets (File → Download → CSV/TSV)"
                      : "text from Google Docs"}
                  </label>
                  <textarea
                    rows={10}
                    value={importInput}
                    onChange={(e) => setImportInput(e.target.value)}
                    className="w-full px-3 py-2 rounded-md border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    placeholder={
                      importMode === "sheets"
                        ? 'text,additionalInfo,type,options,correct,points\nWhat is 2+2?,CO1,single,2 | 3 | 4 | 5,3,1\nSelect prime numbers,CO2,mcq,2 | 3 | 4 | 5,"A,B",3\nExplain Newton\'s second law,,text,,,5'
                        : "Q: What is 2+2?\nA) 2\nB) 3\nC) 4\nD) 5\nCorrect: C\nPoints: 1"
                    }
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    For options, separate with “|” (pipe) or “;;”. “Correct”
                    accepts letters (A,B), numbers (1,2), or option text. Use
                    commas for multiple answers.
                  </p>
                </div>

                {importError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded">
                    {importError}
                  </div>
                )}
                {!importError && (
                  <div className="flex items-start sm:items-center justify-between gap-2 flex-col sm:flex-row">
                    <p className="text-sm text-slate-600">
                      Parsed questions:{" "}
                      <span className="font-semibold text-slate-900">
                        {parsedPreview.length}
                      </span>
                    </p>
                    <label className="text-sm inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="accent-emerald-600"
                        checked={replaceExisting}
                        onChange={(e) => setReplaceExisting(e.target.checked)}
                      />
                      Replace existing questions
                    </label>
                  </div>
                )}

                <div className="space-y-2 max-h-48 overflow-auto">
                  {parsedPreview.slice(0, 3).map((q, i) => (
                    <div
                      key={i}
                      className="border border-slate-200 rounded-md p-3"
                    >
                      <div className="text-xs uppercase tracking-wide text-slate-500">
                        {q.type} • {q.points} pt{Number(q.points) > 1 ? "s" : ""}
                      </div>
                      <div className="text-slate-900 font-medium overflow-x-auto"><MarkdownRenderer content={q.text} /></div>
                      <div className="text-slate-900 font-medium">{q.text}</div>
                      {q.additionalInfo ? (
                        <div className="text-xs text-slate-500 mt-0.5">
                          {q.additionalInfo}
                        </div>
                      ) : null}
                      {q.options?.length ? (
                        <ul className="mt-1 text-sm text-slate-700 list-disc pl-5">
                          {q.options.map((o, oi) => (
                            <li
                              key={oi}
                              className={
                                (q.correctAnswers || []).includes(oi)
                                  ? "text-emerald-700"
                                  : ""
                              }
                            >
                              <span className="flex-1 overflow-x-auto inline-block align-top"><MarkdownRenderer content={o} /></span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ))}
                  {!parsedPreview.length && (
                    <div className="text-sm text-slate-500">
                      Paste content or choose a file to see a preview.
                    </div>
                  )}
                </div>
              </div>

              <div className="px-5 py-4 border-t border-slate-200 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setImportOpen(false)}
                  className="px-4 py-2 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!parsedPreview.length}
                  onClick={addImportedQuestions}
                  className="px-4 py-2 rounded-md bg-emerald-600 text-slate-900 font-semibold disabled:opacity-60 hover:bg-emerald-500"
                >
                  Import{" "}
                  {parsedPreview.length ? `(${parsedPreview.length})` : ""}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── AI Generate Modal ── */}
      {aiOpen && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-slate-900/60"
            onClick={() => !aiLoading && setAiOpen(false)}
          />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">

              {/* Header */}
              <div className="px-6 py-4 flex items-center justify-between bg-gradient-to-r from-indigo-600 to-violet-600">
                <div className="flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-white">
                    <path fillRule="evenodd" d="M9 4.5a.75.75 0 0 1 .721.544l.813 2.846a3.75 3.75 0 0 0 2.576 2.576l2.846.813a.75.75 0 0 1 0 1.442l-2.846.813a3.75 3.75 0 0 0-2.576 2.576l-.813 2.846a.75.75 0 0 1-1.442 0l-.813-2.846a3.75 3.75 0 0 0-2.576-2.576l-2.846-.813a.75.75 0 0 1 0-1.442l2.846-.813A3.75 3.75 0 0 0 7.466 7.89l.813-2.846A.75.75 0 0 1 9 4.5ZM18 1.5a.75.75 0 0 1 .728.568l.258 1.036c.236.94.97 1.674 1.91 1.91l1.036.258a.75.75 0 0 1 0 1.456l-1.036.258c-.94.236-1.674.97-1.91 1.91l-.258 1.036a.75.75 0 0 1-1.456 0l-.258-1.036a2.625 2.625 0 0 0-1.91-1.91l-1.036-.258a.75.75 0 0 1 0-1.456l1.036-.258a2.625 2.625 0 0 0 1.91-1.91l.258-1.036A.75.75 0 0 1 18 1.5Z" clipRule="evenodd" />
                  </svg>
                  <h3 className="text-lg font-bold text-white">Generate Questions with AI</h3>
                </div>
                <button
                  onClick={() => !aiLoading && setAiOpen(false)}
                  className="text-white/70 hover:text-white transition-colors"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              {/* Body */}
              <div className="px-6 py-5 flex-1 overflow-y-auto space-y-5">

                {/* Prompt section */}
                <div>
                  <label className="block text-sm font-semibold text-slate-800 mb-1">
                    Describe the questions you want
                  </label>
                  <p className="text-xs text-slate-500 mb-2">
                    Examples: &quot;Generate 5 single choice questions on Newton&apos;s laws, medium difficulty&quot; · &quot;10 MCQs on Python data structures, hard&quot;
                  </p>
                  <textarea
                    rows={3}
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    disabled={aiLoading}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleAIGenerate();
                    }}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 bg-white resize-none disabled:opacity-50"
                    placeholder="e.g. Generate 5 single choice questions on photosynthesis for 10th grade, easy difficulty"
                  />
                  <p className="mt-1 text-xs text-slate-400">Tip: Press Ctrl+Enter to generate</p>
                </div>

                <button
                  type="button"
                  onClick={handleAIGenerate}
                  disabled={aiLoading || !aiPrompt.trim()}
                  className="w-full py-2.5 rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 text-white font-semibold hover:from-indigo-500 hover:to-violet-500 disabled:opacity-60 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                >
                  {aiLoading ? (
                    <>
                      <svg className="animate-spin w-5 h-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Generating questions…
                    </>
                  ) : (
                    <>
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                        <path fillRule="evenodd" d="M9 4.5a.75.75 0 0 1 .721.544l.813 2.846a3.75 3.75 0 0 0 2.576 2.576l2.846.813a.75.75 0 0 1 0 1.442l-2.846.813a3.75 3.75 0 0 0-2.576 2.576l-.813 2.846a.75.75 0 0 1-1.442 0l-.813-2.846a3.75 3.75 0 0 0-2.576-2.576l-2.846-.813a.75.75 0 0 1 0-1.442l2.846-.813A3.75 3.75 0 0 0 7.466 7.89l.813-2.846A.75.75 0 0 1 9 4.5Z" clipRule="evenodd" />
                      </svg>
                      Generate Questions
                    </>
                  )}
                </button>

                {/* Error */}
                {aiError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm flex items-start gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 mt-0.5 shrink-0">
                      <path fillRule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003ZM12 8.25a.75.75 0 0 1 .75.75v3.75a.75.75 0 0 1-1.5 0V9a.75.75 0 0 1 .75-.75Zm0 8.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" clipRule="evenodd" />
                    </svg>
                    {aiError}
                  </div>
                )}

                {/* Loading placeholder */}
                {aiLoading && (
                  <div className="space-y-3">
                    {[1, 2, 3].map((n) => (
                      <div key={n} className="rounded-xl border border-slate-200 p-4 animate-pulse space-y-2">
                        <div className="h-3 bg-slate-200 rounded w-16" />
                        <div className="h-4 bg-slate-200 rounded w-3/4" />
                        <div className="space-y-1">
                          <div className="h-3 bg-slate-100 rounded w-1/2" />
                          <div className="h-3 bg-slate-100 rounded w-2/5" />
                          <div className="h-3 bg-slate-100 rounded w-1/3" />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Generated question cards */}
                {!aiLoading && aiQuestions.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-slate-700">
                        {aiQuestions.length} question{aiQuestions.length !== 1 ? "s" : ""} generated
                      </p>
                      <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-medium">
                        Ready to add
                      </span>
                    </div>
                    <div className="space-y-3 max-h-64 overflow-y-auto pr-1">
                      {aiQuestions.map((q, i) => (
                        <div key={i} className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs uppercase tracking-wide font-semibold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
                              {q.type === "single" ? "Single choice" : q.type === "mcq" ? "Multiple choice" : "Text"}
                            </span>
                            <span className="text-xs text-slate-400">Q{i + 1}</span>
                          </div>
                          <div className="text-sm font-medium text-slate-900 overflow-x-auto"><MarkdownRenderer content={q.text} /></div>
                          {q.options && q.options.length > 0 && (
                            <ul className="space-y-1">
                              {q.options.map((opt, oi) => (
                                <li
                                  key={oi}
                                  className={`text-xs flex items-center gap-2 px-2 py-1 rounded ${
                                    (q.correctAnswers || []).includes(oi)
                                      ? "bg-emerald-100 text-emerald-800 font-semibold"
                                      : "text-slate-600"
                                  }`}
                                >
                                  <span className="font-mono w-4 shrink-0 self-start mt-0.5">{String.fromCharCode(65 + oi)}.</span>
                                  <div className="flex-1 overflow-x-auto"><MarkdownRenderer content={opt} /></div>
                                  {(q.correctAnswers || []).includes(oi) && (
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5 ml-auto shrink-0 text-emerald-600">
                                      <path fillRule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z" clipRule="evenodd" />
                                    </svg>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {!aiLoading && aiQuestions.length === 0 && !aiError && (
                  <div className="text-center py-6 text-slate-400 text-sm">
                    Enter a prompt above and click &ldquo;Generate Questions&rdquo; to get started.
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <label className="text-sm inline-flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="accent-indigo-600"
                    checked={aiReplaceExisting}
                    onChange={(e) => setAiReplaceExisting(e.target.checked)}
                  />
                  <span className="text-slate-700">Replace existing questions</span>
                </label>
                <div className="flex items-center gap-3 ml-auto">
                  <button
                    type="button"
                    onClick={() => !aiLoading && setAiOpen(false)}
                    className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100 text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!aiQuestions.length || aiLoading}
                    onClick={addAIQuestions}
                    className="px-5 py-2 rounded-lg bg-indigo-600 text-white font-semibold hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                  >
                    {aiQuestions.length
                      ? `Add ${aiQuestions.length} question${aiQuestions.length !== 1 ? "s" : ""} to Form`
                      : "Add to Form"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Auto-fill from previous test Modal ── */}
      {autofillOpen && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-slate-900/60"
            onClick={() => setAutofillOpen(false)}
          />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">

              {/* Header */}
              <div className="px-6 py-4 flex items-center justify-between bg-gradient-to-r from-amber-500 to-orange-500">
                <div className="flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-white">
                    <path fillRule="evenodd" d="M9.315 7.584C12.195 3.883 16.695 1.5 21.75 1.5a.75.75 0 0 1 .75.75c0 5.056-2.383 9.555-6.084 12.436A6.75 6.75 0 0 1 9.75 22.5a.75.75 0 0 1-.75-.75v-4.131A15.838 15.838 0 0 1 6.382 15H2.25a.75.75 0 0 1-.75-.75 6.75 6.75 0 0 1 7.815-6.666ZM15 6.75a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5Z" clipRule="evenodd" />
                    <path d="M5.26 17.242a.75.75 0 1 0-.897-1.203 5.243 5.243 0 0 0-2.05 5.022.75.75 0 0 0 .625.627 5.243 5.243 0 0 0 5.022-2.051.75.75 0 1 0-1.202-.897 3.744 3.744 0 0 1-3.008 1.51c0-1.23.592-2.323 1.51-3.008Z" />
                  </svg>
                  <h3 className="text-lg font-bold text-white">Auto-fill from previous test</h3>
                </div>
                <button
                  onClick={() => setAutofillOpen(false)}
                  className="text-white/70 hover:text-white transition-colors"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              {/* Search */}
              <div className="px-5 pt-4 pb-2">
                <p className="text-sm text-slate-500 mb-3">
                  Select a previous exam. Its title, description, duration, assignment criteria, and questions will be copied into this form. The schedule window will be reset.
                </p>
                <input
                  type="text"
                  placeholder="Search by title…"
                  value={autofillSearch}
                  onChange={(e) => setAutofillSearch(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-400 bg-white text-sm"
                />
              </div>

              {/* Exam list */}
              <div className="px-5 pb-5 flex-1 overflow-y-auto space-y-2 mt-1">
                {(() => {
                  const filtered = autofillExams.filter((e) =>
                    (e.title || "").toLowerCase().includes(autofillSearch.toLowerCase())
                  );
                  if (!autofillExams.length) {
                    return (
                      <div className="text-center py-10 text-slate-400 text-sm">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 mx-auto mb-2 opacity-40">
                          <path d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V12.75A3.75 3.75 0 0 0 16.5 9h-1.875a1.875 1.875 0 0 1-1.875-1.875V5.25A3.75 3.75 0 0 0 9 1.5H5.625Z" />
                          <path d="M12.971 1.816A5.23 5.23 0 0 1 14.25 5.25v1.875c0 .207.168.375.375.375H16.5a5.23 5.23 0 0 1 3.434 1.279 9.768 9.768 0 0 0-6.963-6.963Z" />
                        </svg>
                        No previous exams found.
                      </div>
                    );
                  }
                  if (!filtered.length) {
                    return (
                      <div className="text-center py-8 text-slate-400 text-sm">
                        No exams match &ldquo;{autofillSearch}&rdquo;.
                      </div>
                    );
                  }
                  return filtered.map((exam) => (
                    <button
                      key={exam._id}
                      type="button"
                      onClick={() => applyAutofill(exam)}
                      className="w-full text-left rounded-xl border border-slate-200 bg-slate-50 hover:border-amber-400 hover:bg-amber-50 transition-colors px-4 py-3 group"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-slate-900 truncate group-hover:text-amber-800">
                            {exam.title || "(Untitled)"}
                          </p>
                          {exam.description && (
                            <p className="text-xs text-slate-500 truncate mt-0.5">{exam.description}</p>
                          )}
                          <div className="flex flex-wrap gap-3 mt-1.5">
                            <span className="text-xs text-slate-400">
                              ⏱ {exam.durationMins || 60} mins
                            </span>
                            <span className="text-xs text-slate-400">
                              📋 {exam.questions?.length ?? 0} question{(exam.questions?.length ?? 0) !== 1 ? "s" : ""}
                            </span>
                          </div>
                        </div>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 text-slate-300 group-hover:text-amber-500 shrink-0 mt-1">
                          <path fillRule="evenodd" d="M16.72 7.72a.75.75 0 0 1 1.06 0l3.75 3.75a.75.75 0 0 1 0 1.06l-3.75 3.75a.75.75 0 1 1-1.06-1.06l2.47-2.47H3a.75.75 0 0 1 0-1.5h16.19l-2.47-2.47a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                        </svg>
                      </div>
                    </button>
                  ));
                })()}
              </div>

              {/* Footer */}
              <div className="px-6 py-3 border-t border-slate-200 bg-slate-50 flex justify-end">
                <button
                  type="button"
                  onClick={() => setAutofillOpen(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100 text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExamEditor;
