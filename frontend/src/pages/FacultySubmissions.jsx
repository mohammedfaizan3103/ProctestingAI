import { useCallback, useEffect, useState } from "react";
import * as XLSX from "xlsx";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  getProctorEvents,
  listAttemptsForExam,
  grantRetake,
  getExam,
  getMarksheet,
  verifyHash,
} from "../utils/api";

const FacultySubmissions = () => {
  const navigate = useNavigate();
  const { examId } = useParams();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [events, setEvents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [examTitle, setExamTitle] = useState("");

  // Sanitize exam title to be used safely as a filename (Windows-friendly)
  const sanitizeFileName = (name) => {
    if (!name || typeof name !== "string") return "exam";
    // Replace invalid characters <>:"/\|?* and control chars, trim dots/spaces at end
    const cleaned = name
      .replace(/[<>:"/\\|?*]/g, "_")
      .replace(/[\u0000-\u001F\u007F]/g, "_")
      .replace(/\s+/g, " ")
      .trim();
    // Avoid trailing dots/spaces
    return cleaned.replace(/[\.\s]+$/g, "").slice(0, 150) || "exam";
  };

  const exportQuestionPaper = async () => {
    try {
      const { jsPDF } = await import("jspdf");
      const { data } = await getExam(examId);
      const exam = data || {};
      const title = exam?.title || examTitle || "exam";
      const durationMins = Number(exam?.durationMins);
      const description = exam?.description || "";
      const questions = Array.isArray(exam?.questions) ? exam.questions : [];

      const totalMarks = questions.reduce((sum, q) => {
        const pts = Number(q?.points);
        return sum + (Number.isFinite(pts) ? pts : 0);
      }, 0);

      const formatMark = (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return "-";
        return n.toFixed(2).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
      };

      const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const now = new Date();
      const base = sanitizeFileName(title);

      const doc = new jsPDF({ unit: "mm", format: "a4" });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const margin = 14;
      const contentW = pageW - margin * 2;
      const lineGap = 5;
      let y = margin;

      const ensureSpace = (neededMm) => {
        if (y + neededMm <= pageH - margin) return;
        doc.addPage();
        y = margin;
      };

      // Header
      doc.setTextColor(15, 23, 42);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      const titleLines = doc.splitTextToSize(String(title || ""), contentW);
      doc.text(titleLines, margin, y);
      y += titleLines.length * 7;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(51, 65, 85);
      const leftMeta = `Duration: ${Number.isFinite(durationMins) ? `${formatMark(durationMins)} mins` : "-"}`;
      const rightMeta = `Total Marks: ${formatMark(totalMarks)}`;
      doc.text(leftMeta, margin, y);
      doc.text(rightMeta, pageW - margin, y, { align: "right" });
      y += 5;
      doc.text(`Generated: ${now.toLocaleString()}`, margin, y);
      doc.text(`Questions: ${String(questions.length)}`, pageW - margin, y, {
        align: "right",
      });
      y += 6;
      doc.setDrawColor(226, 232, 240);
      doc.setLineWidth(0.6);
      doc.line(margin, y, pageW - margin, y);
      y += 7;

      if (String(description || "").trim()) {
        doc.setFontSize(10);
        doc.setTextColor(51, 65, 85);
        const descLines = doc.splitTextToSize(String(description), contentW);
        ensureSpace(descLines.length * lineGap + 4);
        doc.text(descLines, margin, y);
        y += descLines.length * lineGap + 6;
      }

      // Questions
      questions.forEach((q, idx) => {
        const qType = String(q?.type || "").trim();
        const qText = String(q?.text || "").trim();
        const info = String(q?.additionalInfo || "").trim();
        const pts = Number(q?.points);
        const options = Array.isArray(q?.options)
          ? q.options.map((o) => String(o ?? "").trim()).filter(Boolean)
          : [];
        const correctAnswers = Array.isArray(q?.correctAnswers)
          ? q.correctAnswers
              .map((v) => Number(v))
              .filter((v) => Number.isInteger(v) && v >= 0)
          : [];

        const correctLineText =
          qType === "single" || qType === "mcq"
            ? (() => {
                const parts = correctAnswers
                  .map((oi) => {
                    const label = letters[oi] || String(oi + 1);
                    const opt = options[oi] ? ` ${options[oi]}` : "";
                    return `${label}.${opt}`.trim();
                  })
                  .filter(Boolean);
                return `Correct Answer: ${parts.length ? parts.join(", ") : "-"}`;
              })()
            : "";

        // Estimate block height conservatively to avoid awkward splits.
        const marksReserve = 30;
        const infoReserve = info ? 56 : 0;
        const qLines = doc.splitTextToSize(
          `Q${idx + 1}. ${qText}`,
          contentW - marksReserve - infoReserve
        );
        const infoHeaderLines = info
          ? doc.splitTextToSize(info, infoReserve - 4)
          : [];
        const optLines =
          qType === "single" || qType === "mcq"
            ? options.reduce((acc, opt, oi) => {
                const label = letters[oi] || String(oi + 1);
                const lines = doc.splitTextToSize(
                  `${label}. ${opt}`,
                  contentW - 6
                );
                acc.push(...lines);
                return acc;
              }, [])
            : [];
        const correctLines = correctLineText
          ? doc.splitTextToSize(correctLineText, contentW - 6)
          : [];

        const extraForText = qType === "text" ? 5 * 8 : 0;
        const approxHeight =
          Math.max(qLines.length * lineGap, infoHeaderLines.length * 4) +
          (optLines.length ? optLines.length * 4 + 3 : 0) +
          (correctLines.length ? correctLines.length * 4 + 3 : 0) +
          extraForText +
          10;
        ensureSpace(approxHeight);

        // Question header line + marks
        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        doc.setTextColor(15, 23, 42);
        const qPrefix = `Q${idx + 1}. `;
        const textStartX = margin;
        const marksText = `Marks: ${Number.isFinite(pts) ? formatMark(pts) : "-"}`;
        doc.text(marksText, pageW - margin, y, { align: "right" });
        if (infoHeaderLines.length) {
          doc.setFont("helvetica", "normal");
          doc.setFontSize(9.5);
          doc.setTextColor(71, 85, 105);
          doc.text(infoHeaderLines, pageW - margin - marksReserve, y, {
            align: "right",
          });
          doc.setFont("helvetica", "bold");
          doc.setFontSize(11);
          doc.setTextColor(15, 23, 42);
        }

        // Render the question text in wrapped lines (keeping space for marks on the first line)
        const firstLineMaxW = contentW - marksReserve - infoReserve;
        const firstLine = doc.splitTextToSize(`${qPrefix}${qText}`, firstLineMaxW);
        doc.text(firstLine, textStartX, y);
        y += Math.max(firstLine.length * lineGap, infoHeaderLines.length * 4);

        if (qType === "single" || qType === "mcq") {
          doc.setFont("helvetica", "normal");
          doc.setFontSize(10);
          doc.setTextColor(15, 23, 42);
          options.forEach((opt, oi) => {
            const label = letters[oi] || String(oi + 1);
            const lines = doc.splitTextToSize(
              `${label}. ${opt}`,
              contentW - 6
            );
            ensureSpace(lines.length * 4 + 2);
            doc.text(lines, margin + 3, y);
            y += lines.length * 4 + 1;
          });
          if (correctLines.length) {
            doc.setFont("helvetica", "bold");
            doc.setFontSize(10);
            doc.setTextColor(15, 23, 42);
            ensureSpace(correctLines.length * 4 + 2);
            doc.text(correctLines, margin + 3, y);
            y += correctLines.length * 4 + 2;
          }
          y += 2;
        }

        if (qType === "text") {
          doc.setDrawColor(203, 213, 225);
          doc.setLineWidth(0.3);
          for (let i = 0; i < 5; i++) {
            ensureSpace(8);
            doc.line(margin, y + 6, pageW - margin, y + 6);
            y += 8;
          }
        }

        // Separator
        doc.setDrawColor(226, 232, 240);
        doc.setLineWidth(0.4);
        ensureSpace(8);
        doc.line(margin, y, pageW - margin, y);
        y += 8;
      });

      doc.save(`${base}-question-paper.pdf`);
    } catch (e) {
      alert(
        e?.response?.data?.message ||
          e?.response?.data?.error ||
          "Failed to download question paper"
      );
    }
  };

  // For Excel export: only Roll number and Marks
  const toExportRowsXLSX = useCallback(() => {
    return (rows || []).map((a) => ({
      RollNo: a.student?.rollNo || "",
      Marks: typeof a.score === "number" ? a.score : "",
    }));
  }, [rows]);

  // For CSV export: only Roll number and Marks
  const toExportRowsCSV = useCallback(() => {
    return (rows || []).map((a) => ({
      RollNo: a.student?.rollNo || "",
      Marks: typeof a.score === "number" ? a.score : "",
    }));
  }, [rows]);

  // (No timestamp needed in filenames per requirement)

  const exportXLSX = () => {
    if (!rows?.length) return;
    const data = toExportRowsXLSX();
    const ws = XLSX.utils.json_to_sheet(data);
    // Set autofilter over the entire table
    if (ws["!ref"]) {
      const range = XLSX.utils.decode_range(ws["!ref"]);
      ws["!autofilter"] = { ref: XLSX.utils.encode_range(range) };
      // Compute column widths (wch) based on content (simple heuristic)
      const headers = Object.keys(data[0] || {});
      const cols = headers.map((h) => ({
        wch: Math.min(String(h).length + 6, 40),
      }));
      ws["!cols"] = cols;
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Submissions");
    const fname = `${sanitizeFileName(examTitle || "exam")}.xlsx`;
    XLSX.writeFile(wb, fname, {
      bookType: "xlsx",
      compression: true,
    });
  };

  const exportCSV = () => {
    if (!rows?.length) return;
    const data = toExportRowsCSV();
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Submissions");
    const fname = `${sanitizeFileName(examTitle || "exam")}.csv`;
    XLSX.writeFile(wb, fname, {
      bookType: "csv",
      FS: ",",
    });
  };

  const exportMarksheet = async () => {
    try {
      const { data } = await getMarksheet(examId);
      const sheetRows = data?.rows || [];
      if (!sheetRows.length) {
        alert("No submitted attempts to export.");
        return;
      }

      // Compute Total on the client as a fallback (and to guarantee the column exists).
      const normalizedRows = sheetRows.map((row) => {
        const r = { ...(row || {}) };
        if (typeof r.Total !== "number" || !Number.isFinite(r.Total)) {
          let total = 0;
          for (const [k, v] of Object.entries(r)) {
            if (k === "RollNo" || k === "Total") continue;
            if (typeof v === "number" && Number.isFinite(v)) total += v;
          }
          r.Total = total;
        }
        return r;
      });

      // Stable column order: RollNo first, Total last, all other columns in between.
      const seen = new Set();
      const mid = [];
      for (const r of normalizedRows) {
        for (const k of Object.keys(r || {})) {
          if (k === "RollNo" || k === "Total") continue;
          if (!seen.has(k)) {
            seen.add(k);
            mid.push(k);
          }
        }
      }
      const headers = ["RollNo", ...mid, "Total"];

      const ws = XLSX.utils.json_to_sheet(normalizedRows, { header: headers });
      if (ws["!ref"]) {
        const range = XLSX.utils.decode_range(ws["!ref"]);
        ws["!autofilter"] = { ref: XLSX.utils.encode_range(range) };

        // Basic readability improvements (no custom colors/fonts):
        // - Freeze header row + RollNo column
        // - Set reasonable column widths
        // - Format numeric marks to show decimals cleanly
        ws["!sheetViews"] = [
          {
            state: "frozen",
            xSplit: 1,
            ySplit: 1,
            topLeftCell: "B2",
            activePane: "bottomRight",
          },
        ];

        const widths = headers.map((h) => {
          let maxLen = String(h || "").length;
          for (let i = 0; i < normalizedRows.length; i++) {
            const v = normalizedRows[i]?.[h];
            const len = v == null ? 0 : String(v).length;
            if (len > maxLen) maxLen = len;
          }
          // Keep within a sane range for visibility
          const wch = Math.min(Math.max(maxLen + 2, 10), 42);
          return { wch };
        });
        ws["!cols"] = widths;

        // Apply a numeric format for all numeric cells except header row.
        for (let r = range.s.r + 1; r <= range.e.r; r++) {
          for (let c = range.s.c; c <= range.e.c; c++) {
            const addr = XLSX.utils.encode_cell({ r, c });
            const cell = ws[addr];
            if (!cell) continue;
            if (cell.t === "n") cell.z = "0.##";
          }
        }
      }
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Marksheet");
      const base = sanitizeFileName(examTitle || data?.examTitle || "exam");
      const fname = `${base}-marksheet.xlsx`;
      XLSX.writeFile(wb, fname, {
        bookType: "xlsx",
        compression: true,
      });
    } catch (e) {
      alert(
        e?.response?.data?.message ||
          e?.response?.data?.error ||
          "Failed to export marksheet"
      );
    }
  };

  const fetchAttempts = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await listAttemptsForExam(examId);
      setRows(data || []);
    } catch (e) {
      setError(
        e?.response?.data?.message ||
          e?.response?.data?.error ||
          "Failed to load attempts"
      );
    } finally {
      setLoading(false);
    }
  }, [examId]);

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
    // Fetch attempts and exam title in parallel
    fetchAttempts();
    (async () => {
      try {
        const { data } = await getExam(examId);
        setExamTitle(data?.title || "");
      } catch {
        setExamTitle("");
      }
    })();
  }, [navigate, fetchAttempts]);

  const viewEvents = async (attemptId) => {
    setSelected(attemptId);
    setEvents([]);
    try {
      const { data } = await getProctorEvents(attemptId);
      setEvents(data || []);
    } catch {
      setEvents([]);
    }
  };

  const onGrantRetake = async (studentId) => {
    const input = window.prompt("How many retakes to grant?", "1");
    if (input == null) return; // cancelled
    const count = Math.max(1, Number(input) || 1);
    try {
      const { data } = await grantRetake(examId, studentId, count);
      alert(
        `Retake granted. Remaining for student: ${data?.remaining ?? count}`
      );
      // No need to refetch attempts immediately; optional refresh
      // await fetchAttempts();
    } catch (e) {
      alert(
        e?.response?.data?.message ||
          e?.response?.data?.error ||
          "Failed to grant retake"
      );
    }
  };

  const handleVerifyHash = async (attemptId) => {
    try {
      const { data } = await verifyHash(attemptId);
      if (data.verified) {
        alert("✅ Integrity Verified! The submission data matches the blockchain hash:\n\n" + data.storedHash);
      } else {
        alert("❌ INTEGRITY BREACH! The submission data has been tampered with or does not match the stored blockchain hash.");
      }
    } catch (e) {
      alert(
        e?.response?.data?.message ||
          e?.response?.data?.error ||
          "Failed to verify hash"
      );
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-4">
      <div className="flex items-start sm:items-center justify-between gap-2 sm:gap-4 flex-col sm:flex-row">
        <h1 className="text-3xl font-bold">Submissions</h1>
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          <button
            onClick={exportCSV}
            disabled={!rows.length}
            className="px-3 py-2 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            title="Download submissions as CSV"
          >
            Export CSV
          </button>
          <button
            onClick={exportXLSX}
            disabled={!rows.length}
            className="px-3 py-2 rounded-md bg-emerald-600 text-slate-900 font-semibold hover:bg-emerald-500 disabled:opacity-50"
            title="Download submissions as Excel (.xlsx)"
          >
            Export Excel
          </button>
          <button
            onClick={exportMarksheet}
            disabled={!rows.length}
            className="px-3 py-2 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            title="Download marksheet (RollNo x Question marks) as Excel (.xlsx)"
          >
            Export Marksheet
          </button>
          <button
            onClick={exportQuestionPaper}
            className="px-3 py-2 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"
            title="Download a neatly formatted question paper (PDF)"
          >
            Download Question Paper (PDF)
          </button>
          <Link
            to={`/faculty/exams/`}
            className="text-emerald-700 hover:underline ml-2"
          >
            Back to exam
          </Link>
        </div>
      </div>

      {error && (
        <div className="bg-red-100 text-red-700 px-4 py-2 rounded">{error}</div>
      )}

      <div className="bg-white rounded shadow overflow-x-auto">
        <table className="w-full table-auto min-w-max">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-3">Attempt</th>
              <th className="text-left p-3">Student</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Score</th>
              <th className="text-left p-3">Integrity Score</th>
              <th className="text-left p-3">Violations</th>
              <th className="text-left p-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-4 text-center text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-4 text-center text-gray-500">
                  No attempts yet.
                </td>
              </tr>
            ) : (
              rows.map((a) => {
                const studentName =
                  a.student?.name || a.student?.email || a.studentId;
                const studentMeta = a.student?.rollNo
                  ? ` (${a.student.rollNo})`
                  : "";
                return (
                  <tr key={a._id} className="border-t">
                    <td className="p-3 text-sm">{a._id}</td>
                    <td className="p-3 text-sm">
                      {studentName}
                      {studentMeta}
                    </td>
                    <td className="p-3">{a.status}</td>
                    <td className="p-3">{a.score}</td>
                    <td className="p-3">
                      {a.integrityScore !== undefined ? (
                        <span className={`px-2 py-1 rounded text-xs font-bold text-white ${
                          a.integrityScore >= 80 ? 'bg-emerald-500' : a.integrityScore >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                        }`}>
                          {a.integrityScore}/100
                        </span>
                      ) : (
                        <span className="text-gray-400">N/A</span>
                      )}
                    </td>
                    <td className="p-3">{a.violationsCount}</td>
                    <td className="p-3">
                      <button
                        className="text-emerald-700 hover:underline"
                        onClick={() => viewEvents(a._id)}
                      >
                        View events
                      </button>
                      <button
                        className="ml-3 text-indigo-600 font-bold hover:underline"
                        onClick={() => handleVerifyHash(a._id)}
                        title="Verify decentralized blockchain integrity hash"
                      >
                       Verify Hash
                      </button>
                      {a.student?._id && (
                        <button
                          className="ml-3 text-emerald-700 hover:underline"
                          onClick={() => onGrantRetake(a.student._id)}
                          title="Allow this student to retake the test"
                        >
                          Grant retake
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="bg-white rounded shadow p-4">
          <div className="flex items-start sm:items-center justify-between mb-2 gap-2 flex-col sm:flex-row">
            <h2 className="text-xl font-semibold">
              Proctoring events for {selected}
            </h2>
            <button
              className="text-sm text-gray-600"
              onClick={() => {
                setSelected(null);
                setEvents([]);
              }}
            >
              Close
            </button>
          </div>
          {events.length === 0 ? (
            <div className="text-gray-500">No events.</div>
          ) : (
            <ul className="list-disc pl-5 space-y-1">
              {events.map((e) => {
                const friendly = {
                  "visibility-hidden": {
                    label: "Switched away from the test",
                    help: "Tab or app not visible",
                  },
                  "tab-blur": {
                    label: "Left the test window",
                    help: "Window lost focus or alt-tab",
                  },
                  "fullscreen-exit": {
                    label: "Exited fullscreen",
                    help: "Fullscreen turned off",
                  },
                  "return-timeout": {
                    label: "Return timeout",
                    help: "Took too long to come back",
                  },
                  "face-absent": {
                    label: "No face detected",
                    help: "Student not visible to webcam",
                  },
                  "face-mismatch": {
                    label: "Identity mismatch",
                    help: "Different person detected",
                  },
                  "face-multiple": {
                    label: "Multiple faces",
                    help: "More than one person detected in frame",
                  },
                  "gaze-away": {
                    label: "Looking away",
                    help: "Sustained focus off-screen",
                  },
                  "gaze-no-face": {
                    label: "Gaze face not visible",
                    help: "Face missing during gaze check",
                  },
                }[e.type] || { label: e.type, help: "" };
                return (
                  <li key={e._id} className="text-sm">
                    <span className="font-medium">{friendly.label}</span>
                    {friendly.help ? ` – ${friendly.help}` : ""}
                    {e.meta?.penalty_score ? ` (Penalty Score: ${e.meta.penalty_score.toFixed(2)})` : ""}
                    {e.meta?.confidence ? ` (Confidence: ${(e.meta.confidence*100).toFixed(0)}%)` : ""} @{" "}
                    {new Date(e.createdAt).toLocaleString()}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default FacultySubmissions;
