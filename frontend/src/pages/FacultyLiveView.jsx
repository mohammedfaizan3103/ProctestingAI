import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { io } from "socket.io-client";
import { AlertCircle, Maximize2, Users, LayoutGrid, X, ShieldAlert, CheckCircle2 } from "lucide-react";

const StudentVideoCard = ({ student, isPinned, onClick }) => {
  const videoRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && student.stream) {
      videoRef.current.srcObject = student.stream;
    }
  }, [student.stream]);

  const hasViolation = student.violation && student.violation !== "ok";

  return (
    <div
      onClick={onClick}
      className={`relative overflow-hidden bg-slate-900 rounded-xl cursor-pointer transition-all duration-300 ease-out group ${
        hasViolation
          ? "ring-4 ring-red-500 shadow-[0_0_20px_rgba(239,68,68,0.7)]"
          : "ring-1 ring-slate-700/50 hover:ring-indigo-500/80 hover:shadow-xl hover:shadow-indigo-500/20"
      } ${isPinned ? "hidden" : "block"}`}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-cover aspect-video transition-transform duration-700 group-hover:scale-[1.03]"
      />

      <div className="absolute inset-0 bg-gradient-to-t from-slate-900/90 via-transparent to-slate-900/40 pointer-events-none" />

      <div className="absolute top-3 left-3 right-3 flex justify-between items-start pointer-events-none">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.8)]" />
          <span className="bg-slate-900/60 backdrop-blur-md text-slate-100 text-xs px-2.5 py-1 rounded-md font-medium tracking-wide truncate max-w-[120px] shadow-sm border border-slate-700/50">
            {student.studentName}
          </span>
        </div>
        {hasViolation && (
          <span className="bg-red-500/90 backdrop-blur-sm text-white text-[10px] uppercase font-bold tracking-wider px-2.5 py-1 rounded-md animate-pulse shadow-lg border border-red-400">
            {student.violation.replace("gaze-", "").replace("face-", "")} Alert
          </span>
        )}
      </div>

      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
        <div className="bg-black/50 backdrop-blur-sm p-3 rounded-full text-white transform translate-y-4 group-hover:translate-y-0 transition-all duration-300">
          <Maximize2 size={24} strokeWidth={1.5} />
        </div>
      </div>
    </div>
  );
};

const FacultyLiveView = () => {
  const { examId } = useParams();
  const navigate = useNavigate();
  const [students, setStudents] = useState({});
  const [pinnedStudentId, setPinnedStudentId] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [autoSubmitEnabled, setAutoSubmitEnabled] = useState(() => {
    const saved = localStorage.getItem(`proctor_autosubmit_${examId}`);
    return saved !== null ? saved === "true" : true;
  });
  const autoSubmitRef = useRef(autoSubmitEnabled);

  const socketRef = useRef(null);
  const peersRef = useRef({});

  const updateStudent = useCallback((id, patch) => {
    setStudents((prev) => ({
      ...prev,
      [id]: { ...prev[id], ...patch },
    }));
  }, []);

  const handleToggleAutoSubmit = () => {
    const newState = !autoSubmitEnabled;
    setAutoSubmitEnabled(newState);
    autoSubmitRef.current = newState;
    localStorage.setItem(`proctor_autosubmit_${examId}`, String(newState));
    if (socketRef.current) {
      socketRef.current.emit("faculty:toggle_autosubmit", { examId, enabled: newState });
    }
  };

  const handleIssueWarning = (socketId) => {
    const msg = window.prompt("Enter warning message for the student:");
    if (!msg) return;
    if (socketRef.current) {
      socketRef.current.emit("faculty:warning", { targetSocketId: socketId, message: msg });
    }
  };

  const handleForceSubmit = (socketId) => {
    if (!window.confirm("Are you sure you want to force submit for this student? This action cannot be undone.")) return;
    if (socketRef.current) {
      socketRef.current.emit("faculty:force_submit", { targetSocketId: socketId });
    }
  };

  useEffect(() => {
    const userStr = localStorage.getItem("user");
    if (!userStr) {
      navigate("/login");
      return;
    }
    const user = JSON.parse(userStr);
    if (user.role !== "faculty") {
      navigate("/");
      return;
    }

    const socket = io(import.meta.env.VITE_API_URL || `http://${window.location.hostname}:5000`, {
      transports: ["websocket"],
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setIsConnected(true);
      socket.emit("faculty:join", { examId });
      // Tell everyone current state of autosubmit
      socket.emit("faculty:toggle_autosubmit", { examId, enabled: autoSubmitEnabled });
    });

    socket.on("disconnect", () => {
      setIsConnected(false);
    });

    socket.on("student:joined", ({ socketId, studentId, studentName }) => {
      console.log("Student joined:", studentName);
      setStudents((prev) => {
        // Keep existing logs if student reconnected
        const existingLogs = prev[studentId]?.logs || [];
        return {
          ...prev,
          [studentId]: {
            ...prev[studentId],
            studentId,
            studentName,
            socketId,
            violation: null,
            logs: existingLogs,
          }
        };
      });

      socket.emit("faculty:request_offer", { studentSocketId: socketId });
      socket.emit("faculty:toggle_autosubmit", { examId, enabled: autoSubmitRef.current });
    });

    socket.on("student:left", ({ studentId }) => {
      console.log("Student disconnected:", studentId);
      setStudents((prev) => {
        const copy = { ...prev };
        delete copy[studentId];
        return copy;
      });
      if (peersRef.current[studentId]) {
        peersRef.current[studentId].close();
        delete peersRef.current[studentId];
      }
      setPinnedStudentId((prev) => (prev === studentId ? null : prev));
    });

    socket.on("webrtc:offer", async ({ senderSocketId, offer, studentId, studentName }) => {
      // If an existing peer connection exists for this student, close it
      // and create a fresh one. A reused PC in 'stable' state cannot
      // accept a new offer, which causes the video to never connect.
      if (peersRef.current[studentId]) {
        try { peersRef.current[studentId].close(); } catch {}
        delete peersRef.current[studentId];
      }

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      peersRef.current[studentId] = pc;

      pc.ontrack = (event) => {
        updateStudent(studentId, { stream: event.streams[0] });
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("webrtc:candidate", {
            targetSocketId: senderSocketId,
            candidate: event.candidate,
          });
        }
      };

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit("webrtc:answer", {
          targetSocketId: senderSocketId,
          answer,
        });
      } catch (e) {
        console.error("Failed to process WebRTC offer for", studentId, e);
      }
    });

    socket.on("webrtc:candidate", async ({ senderSocketId, candidate }) => {
      const studentEntry = Object.values(students).find(s => s.socketId === senderSocketId);
      if (studentEntry && peersRef.current[studentEntry.studentId]) {
        try {
          await peersRef.current[studentEntry.studentId].addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error("Error adding ice candidate", e);
        }
      }
    });

    socket.on("student:violation", ({ studentId, type }) => {
      const timestamp = new Date().toLocaleTimeString();
      setStudents((prev) => {
        const student = prev[studentId];
        if (!student) return prev;
        
        const updatedLogs = [{ type, timestamp }, ...(student.logs || [])];
        
        return {
          ...prev,
          [studentId]: {
            ...student,
            violation: type,
            logs: updatedLogs
          }
        };
      });

      // Clear the active visual highlight after 5 seconds
      setTimeout(() => {
        setStudents((prev) => {
          const s = prev[studentId];
          if (s && s.violation === type) {
            return { ...prev, [studentId]: { ...s, violation: null } };
          }
          return prev;
        });
      }, 5000);
    });

    return () => {
      socket.disconnect();
      Object.values(peersRef.current).forEach((pc) => pc.close());
    };
  }, [examId, navigate, updateStudent]);

  const studentList = Object.values(students);
  const pinnedStudent = pinnedStudentId ? students[pinnedStudentId] : null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-8 font-sans selection:bg-indigo-500/30">
      <div className="max-w-[1400px] mx-auto">
        <header className="flex flex-col lg:flex-row lg:items-center justify-between mb-8 gap-4 bg-slate-900/50 p-6 rounded-2xl border border-slate-800 backdrop-blur-lg">
          <div>
            <h1 className="text-3xl font-extrabold bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
              Live Proctoring Dashboard
            </h1>
            <p className="text-slate-400 mt-1 flex items-center gap-2 text-sm">
              <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
              {isConnected ? "Connected to signaling server" : "Reconnecting..."}
              <span className="mx-2 text-slate-700">|</span>
              Exam ID: <span className="font-mono text-slate-300">{examId}</span>
            </p>
          </div>
          
          <div className="flex flex-col sm:flex-row items-center gap-4">
             {/* Debug Panel Toggle */}
             <div className="flex items-center gap-3 bg-slate-800/60 px-4 py-2.5 rounded-xl border border-slate-700/50">
               <span className="text-sm font-medium text-slate-300">Auto-Submit on Violations</span>
               <button 
                 onClick={handleToggleAutoSubmit}
                 className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-900 ${
                   autoSubmitEnabled ? 'bg-indigo-500' : 'bg-slate-600'
                 }`}
               >
                 <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                   autoSubmitEnabled ? 'translate-x-6' : 'translate-x-1'
                 }`} />
               </button>
             </div>

             <div className="flex items-center gap-2 px-4 py-2.5 bg-slate-800/50 rounded-xl border border-slate-700/50">
               <Users size={18} className="text-indigo-400" />
               <span className="font-medium">{studentList.length} Online</span>
             </div>
             
             <button
              onClick={() => navigate("/faculty/exams")}
              className="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl transition-colors font-medium border border-slate-700 border-b-2 hover:border-slate-600 active:border-b active:translate-y-px"
            >
              Exit View
            </button>
          </div>
        </header>

        {studentList.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-32 bg-slate-900/20 rounded-3xl border border-slate-800 border-dashed">
            <div className="w-20 h-20 rounded-full bg-slate-800 flex items-center justify-center mb-6 shadow-xl text-slate-500">
               <LayoutGrid size={32} />
            </div>
            <h2 className="text-2xl font-bold text-slate-300 mb-2">Waiting for students...</h2>
            <p className="text-slate-500 max-w-md text-center">
              Students taking this exam will automatically appear here once they connect and enable their cameras.
            </p>
          </div>
        ) : (
          <div className={`grid grid-cols-1 ${pinnedStudent ? 'lg:grid-cols-4 lg:gap-8' : ''} gap-6`}>
            
            {/* Pinned View Area */}
            {pinnedStudent && (
              <div className="lg:col-span-3 space-y-6 animate-in fade-in slide-in-from-bottom-8 duration-500">
                <div className="relative rounded-2xl overflow-hidden bg-black border border-slate-700/50 shadow-2xl">
                  {pinnedStudent.stream ? (
                     <video
                        ref={el => { if (el) el.srcObject = pinnedStudent.stream; }}
                        autoPlay
                        playsInline
                        muted
                        className="w-full aspect-video object-contain"
                     />
                  ) : (
                    <div className="w-full aspect-video flex items-center justify-center text-slate-600">
                      No Stream
                    </div>
                  )}
                  <div className="absolute top-4 left-4 right-4 flex justify-between items-start">
                     <span className="bg-slate-900/80 backdrop-blur-md px-4 py-2 rounded-lg text-lg font-bold text-white shadow-lg border border-slate-700/50">
                       {pinnedStudent.studentName}
                     </span>
                     <div className="flex gap-2">
                       <button
                         onClick={() => handleIssueWarning(pinnedStudent?.socketId)}
                         className="bg-amber-500/20 hover:bg-amber-500/40 border border-amber-500/50 backdrop-blur-md px-3 py-1.5 p-2 text-sm rounded-lg text-amber-300 transition-colors"
                       >
                         Send Warning
                       </button>
                       <button
                         onClick={() => handleForceSubmit(pinnedStudent?.socketId)}
                         className="bg-rose-500/20 hover:bg-rose-500/40 border border-rose-500/50 backdrop-blur-md px-3 py-1.5 text-sm rounded-lg text-rose-300 transition-colors cursor-pointer"
                       >
                         Force Submit
                       </button>
                       <button
                         onClick={() => setPinnedStudentId(null)}
                         className="bg-black/50 hover:bg-black/80 backdrop-blur-md p-2 rounded-full text-white transition-colors ml-2"
                         title="Close Pinned View"
                       >
                         <X size={20} />
                       </button>
                     </div>
                  </div>
                </div>

                <div className="bg-slate-900/50 rounded-2xl p-6 border border-slate-800 backdrop-blur-lg">
                   <h3 className="text-xl font-bold mb-6 flex items-center gap-2">
                     <AlertCircle className="text-indigo-400" size={20} /> Event Log History
                   </h3>
                   <div className="space-y-3 max-h-64 overflow-y-auto pr-2 custom-scrollbar">
                     {(!pinnedStudent.logs || pinnedStudent.logs.length === 0) ? (
                        <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-300 flex items-center gap-3">
                           <CheckCircle2 size={18} className="text-emerald-400" />
                           <span className="font-medium">No violations recorded. Behavior normal.</span>
                        </div>
                     ) : (
                        pinnedStudent.logs.map((log, idx) => (
                          <div key={idx} className="p-4 bg-slate-800/50 border border-slate-700/50 rounded-xl text-slate-300 flex items-start justify-between gap-3 group hover:bg-slate-700/50 transition-colors">
                             <div className="flex items-start gap-4">
                               <div className="mt-1">
                                 <ShieldAlert size={18} className="text-rose-400" />
                               </div>
                               <div>
                                 <p className="font-bold text-white uppercase tracking-wider text-sm mb-0.5">{log.type}</p>
                                 <p className="text-xs text-slate-400 opacity-80">Security event logged</p>
                               </div>
                             </div>
                             <span className="text-xs font-mono text-slate-500 bg-slate-900 px-2 py-1 rounded-md border border-slate-800">{log.timestamp}</span>
                          </div>
                        ))
                     )}
                   </div>
                </div>
              </div>
            )}

            {/* Grid Area */}
            <div className={`grid grid-cols-1 ${pinnedStudent ? 'sm:grid-cols-2 lg:grid-cols-1 place-content-start' : 'sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4'} gap-4 md:gap-6 lg:col-span-1`}>
              {studentList.map(student => (
                <StudentVideoCard 
                  key={student.studentId} 
                  student={student} 
                  isPinned={pinnedStudentId === student.studentId}
                  onClick={() => setPinnedStudentId(student.studentId)}
                />
              ))}
            </div>

          </div>
        )}
      </div>
    </div>
  );
};

export default FacultyLiveView;
