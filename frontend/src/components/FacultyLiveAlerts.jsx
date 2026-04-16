import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { io } from "socket.io-client";
import { AlertTriangle, X } from "lucide-react";

const FacultyLiveAlerts = () => {
  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    const userStr = localStorage.getItem("user");
    if (!userStr) return;
    const user = JSON.parse(userStr);
    if (user.role !== "faculty") return;
    
    // Fallback logic for user ID
    const facultyId = user._id || user.id || user.userId;
    if (!facultyId) return;

    const socket = io(import.meta.env.VITE_API_URL || `http://${window.location.hostname}:5000`, {
      transports: ["websocket"],
    });

    socket.on("connect", () => {
      socket.emit("faculty:authenticate", { facultyId });
    });

    socket.on("faculty:alert", (data) => {
      const newAlert = {
        id: Date.now() + Math.random(),
        ...data,
      };
      setAlerts((prev) => {
        // Prevent duplicate spam for the same student/type in a short window
        const exists = prev.find(a => a.studentId === data.studentId && a.type === data.type);
        if (exists) return prev;
        return [...prev, newAlert];
      });
      
      // Auto dismiss after 10s
      setTimeout(() => {
        setAlerts((prev) => prev.filter((a) => a.id !== newAlert.id));
      }, 10000);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  if (alerts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-3 pointer-events-none">
      {alerts.map((alert) => (
        <div key={alert.id} className="bg-slate-900 border-l-4 border-rose-500 rounded-lg shadow-2xl p-4 w-80 pointer-events-auto transform transition-all flex flex-col">
          <div className="flex justify-between items-start mb-2">
            <div className="flex items-center gap-2 text-rose-400">
              <AlertTriangle size={18} />
              <span className="font-bold text-sm uppercase tracking-wide">Live Alert</span>
            </div>
            <button onClick={() => setAlerts(prev => prev.filter(a => a.id !== alert.id))} className="text-slate-400 hover:text-white">
              <X size={16} />
            </button>
          </div>
          <p className="text-slate-300 text-sm mb-3 break-words">
            A <span className="font-bold text-rose-400">{alert.type}</span> violation was detected during Exam <span className="font-mono text-slate-400 text-xs">{alert.examId.slice(-6)}</span>.
          </p>
          <Link
            to={`/faculty/exams/${alert.examId}/live`}
            onClick={() => setAlerts(prev => prev.filter(a => a.id !== alert.id))}
            className="bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/50 text-rose-300 text-xs font-semibold px-3 py-1.5 rounded-md text-center transition-colors"
          >
            Monitor Live
          </Link>
        </div>
      ))}
    </div>
  );
};

export default FacultyLiveAlerts;
