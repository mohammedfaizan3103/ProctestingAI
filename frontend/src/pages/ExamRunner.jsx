import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  logProctorEvent,
  saveAttempt,
  startAttempt,
  submitAttempt,
  registerFace,
  checkFace,
  sendGazeFrame,
  endGazeSession,
} from "../utils/api";
import MarkdownRenderer from "../components/MarkdownRenderer";
import { io } from "socket.io-client";
import { evaluateDeviceCapabilities } from "../utils/deviceMetrics";

const RETURN_TIMEOUT_SECONDS = 10;
const AUTOSAVE_MS = 3000;
const FACE_CHECK_INTERVAL_MS = 10000; // check every 10 s
// If a student leaves fullscreen/tab twice, we'll auto-submit
const SERIOUS_VIOLATION_TYPES = new Set([
  "fullscreen-exit",
  "visibility-hidden",
  "tab-blur",
  "window-resize",
  "face-mismatch",
  "face-multiple",
]);
const AUTO_SUBMIT_AFTER_SERIOUS_COUNT = 2;

const ExamRunner = () => {
  const { examId } = useParams();
  const navigate = useNavigate();

  const [state, setState] = useState({
    loading: false,
    error: "",
    attemptId: null,
    exam: null,
    endAt: null,
    answers: {},
    remaining: 0,
    violations: 0,
    overlay: null,
    started: false,
    submitted: false,
    result: null,
    showSubmitConfirm: false,
    // Face proctoring state
    faceStep: "capture",   // "capture" | "registering" | "done" | "error"
    faceError: "",
    faceRegistered: false,
    faceStatus: "ok",      // "ok" | "face-absent" | "face-mismatch" | "face-multiple" | "gaze-away" | "gaze-no-face" | "checking"
    lastCheckTime: null,
  });

  const intervalRef = useRef(null);
  const saveTimerRef = useRef(null);
  const answersRef = useRef({});
  const ignoreFsChangeRef = useRef(false);
  const proctorListenersAttached = useRef(false);
  const isSubmittingRef = useRef(false);
  const seriousViolationCountRef = useRef(0);
  // Face proctoring refs
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const faceCheckIntervalRef = useRef(null);
  const gazeCheckIntervalRef = useRef(null);
  const studentIdRef = useRef("");
  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const autoSubmitEnabledRef = useRef(true);
  const proctoringTierRef = useRef("full");
  const handleSubmitRef = useRef(null);

  const requestFullscreen = async () => {
    const el = document.documentElement;
    if (el.requestFullscreen && !document.fullscreenElement) {
      try {
        ignoreFsChangeRef.current = true;
        await el.requestFullscreen();
        // Give browser time to process fullscreen
        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch (e) {
        console.error("Fullscreen request failed:", e);
        ignoreFsChangeRef.current = false;
      }
    }
  };

  const exitFullscreen = async () => {
    if (document.fullscreenElement && document.exitFullscreen) {
      try {
        await document.exitFullscreen();
      } catch (e) {
        console.error("Exit fullscreen failed:", e);
      }
    }
  };

  const syncCountdown = (endISO) => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    const end = new Date(endISO).getTime();
    intervalRef.current = setInterval(() => {
      const now = Date.now();
      const diff = Math.max(0, Math.floor((end - now) / 1000));
      setState((s) => ({ ...s, remaining: diff }));
    }, 500);
  };

  // Use useCallback to stabilize handleSubmit reference
  const handleSubmit = useCallback(
    async (auto = false) => {
      if (isSubmittingRef.current) return;
      if (!state.attemptId || state.submitted) return;

      // If manual submit, show confirmation first
      if (!auto) {
        setState((s) => ({ ...s, showSubmitConfirm: true }));
        return;
      }

      // Auto-submit (time expired or violations)
      isSubmittingRef.current = true;

      try {
        // Flush any pending autosave so latest answers are persisted before submit
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        const payload = Object.entries(answersRef.current).map(([k, v]) => ({
          questionIndex: Number(k),
          value: v,
        }));
        if (payload.length > 0) {
          try {
            await saveAttempt(state.attemptId, payload);
          } catch {}
        }
        const { data } = await submitAttempt(state.attemptId, payload);
        setState((s) => ({
          ...s,
          submitted: true,
          result: data,
          showSubmitConfirm: false,
        }));
      } catch (e) {
        const res = e?.response?.data;
        if (res && res.score !== undefined) {
          setState((s) => ({
            ...s,
            submitted: true,
            result: res,
            showSubmitConfirm: false,
          }));
        } else {
          setState((s) => ({
            ...s,
            error:
              e?.response?.data?.message ||
              e?.response?.data?.error ||
              "Failed to submit",
            showSubmitConfirm: false,
          }));
        }
      } finally {
        isSubmittingRef.current = false;
        try {
          if (studentIdRef.current) await endGazeSession(studentIdRef.current);
        } catch (err) {}
        await exitFullscreen();
      }
    },
    [state.attemptId, state.submitted]
  );

  // Keep ref in sync so socket/timer callbacks always call the latest version
  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  const confirmSubmit = async () => {
    if (isSubmittingRef.current) return;
    if (!state.attemptId || state.submitted) return;

    isSubmittingRef.current = true;

    try {
      // Flush any pending autosave so latest answers are persisted before submit
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const payload = Object.entries(answersRef.current).map(([k, v]) => ({
        questionIndex: Number(k),
        value: v,
      }));
      if (payload.length > 0) {
        try {
          await saveAttempt(state.attemptId, payload);
        } catch {}
      }
      const { data } = await submitAttempt(state.attemptId, payload);
      setState((s) => ({
        ...s,
        submitted: true,
        result: data,
        showSubmitConfirm: false,
      }));
    } catch (e) {
      const res = e?.response?.data;
      if (res && res.score !== undefined) {
        setState((s) => ({
          ...s,
          submitted: true,
          result: res,
          showSubmitConfirm: false,
        }));
      } else {
        setState((s) => ({
          ...s,
          error:
            e?.response?.data?.message ||
            e?.response?.data?.error ||
            "Failed to submit",
          showSubmitConfirm: false,
        }));
      }
    } finally {
      isSubmittingRef.current = false;
      try {
        if (studentIdRef.current) await endGazeSession(studentIdRef.current);
      } catch (err) {}
      await exitFullscreen();
    }
  };

  const cancelSubmit = () => {
    setState((s) => ({ ...s, showSubmitConfirm: false }));
  };

  const registerViolation = useCallback(
    async (type, meta) => {
      if (!state.attemptId || state.submitted) return;

      try {
        await logProctorEvent(state.attemptId, type, meta);
      } catch {
        // ignore logging failure
      }

      if (socketRef.current) {
        socketRef.current.emit("student:violation", { examId, studentId: studentIdRef.current, type });
      }

      // Track serious violations and auto-submit after threshold
      if (SERIOUS_VIOLATION_TYPES.has(type)) {
        seriousViolationCountRef.current += 1;
        if (
          autoSubmitEnabledRef.current &&
          seriousViolationCountRef.current >= AUTO_SUBMIT_AFTER_SERIOUS_COUNT
        ) {
          // Immediate auto-submit on repeated serious violation if enabled
          await handleSubmit(true);
          return;
        }
      }

      const until = Date.now() + RETURN_TIMEOUT_SECONDS * 1000;
      setState((s) => ({
        ...s,
        violations: s.violations + 1,
        overlay: { reason: type, until },
      }));

      const check = setInterval(() => {
        const returned =
          document.fullscreenElement && document.visibilityState === "visible";
        const now = Date.now();
        if (returned) {
          clearInterval(check);
          setTimeout(() => {
            setState((s2) => ({ ...s2, overlay: null }));
          }, 1000);
          return;
        }
        if (now >= until) {
          clearInterval(check);
          setState((s2) => ({ ...s2, overlay: null }));
          if (autoSubmitEnabledRef.current) {
            handleSubmit(true);
          }
        }
      }, 250);
    },
    [state.attemptId, state.submitted, handleSubmit]
  );

  /** Capture a JPEG blob from the webcam video element. */
  const captureSnapshot = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight || video.readyState < 2) {
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    return new Promise((resolve) =>
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.85)
    );
  }, []);

  /** Start the webcam stream and attach it to the video element. */
  const startWebcam = useCallback(async () => {
    try {
      if (streamRef.current) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
      });
      // Safety check: if component unmounted or already has stream while awaiting
      if (!videoRef.current || streamRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch (err) {
      console.error("Webcam access failed:", err);
      setState((s) => ({ ...s, faceStep: "error", faceError: "Camera access denied. Please allow camera permissions and refresh." }));
    }
  }, []);

  /** Stop the webcam stream. */
  const stopWebcam = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (faceCheckIntervalRef.current) {
      clearTimeout(faceCheckIntervalRef.current);
      faceCheckIntervalRef.current = null;
    }
    if (gazeCheckIntervalRef.current) {
      clearTimeout(gazeCheckIntervalRef.current);
      gazeCheckIntervalRef.current = null;
    }
    try {
      if (studentIdRef.current) endGazeSession(studentIdRef.current);
    } catch {}
  }, []);

  /** Register the visible webcam frame as the student's face. */
  const handleCaptureFace = useCallback(async () => {
    setState((s) => ({ ...s, faceStep: "registering", faceError: "" }));
    try {
      const blob = await captureSnapshot();
      if (!blob) throw new Error("Could not capture image from webcam.");
      const { data } = await registerFace(studentIdRef.current, blob);
      if (data.status === "success") {
        setState((s) => ({ ...s, faceStep: "done", faceRegistered: true }));
      } else {
        setState((s) => ({
          ...s,
          faceStep: "capture",
          faceError: data.message || "Face not detected. Please look directly into the camera.",
        }));
      }
    } catch (err) {
      const msg =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        err.message ||
        "Registration failed. Please try again.";
      setState((s) => ({ ...s, faceStep: "capture", faceError: msg }));
    }
  }, [captureSnapshot]);

  const startFaceCheckLoop = useCallback(
    (attemptId) => {
      const runLoop = async () => {
        if (proctoringTierRef.current === "event-only") return;
        if (!streamRef.current || !studentIdRef.current) return;
        try {
          const video = videoRef.current;
          
          // CRITICAL: If the video element lost its stream (e.g. after a re-mount), re-attach it
          if (video && !video.srcObject && streamRef.current) {
            console.log("📷 [Proctor] Stream was detached, re-attaching...");
            video.srcObject = streamRef.current;
            video.play().catch(e => console.error("📷 [Proctor] Play failed during re-attach:", e));
          }

          const blob = await captureSnapshot();
          if (!blob) {
            console.warn("📷 [Proctor] Capture failed:", {
              hasVideo: !!video,
              width: video?.videoWidth,
              height: video?.videoHeight,
              readyState: video?.readyState,
              paused: video?.paused,
              hasSrc: !!video?.srcObject
            });
            // Try to force play if it was paused by browser optimization
            if (video && video.paused) {
              console.log("📷 [Proctor] Video was paused, attempting to resume...");
              video.play().catch(e => console.error("📷 [Proctor] Resume failed:", e));
            }
          } else {
            const { data } = await checkFace(studentIdRef.current, blob);
            console.log("📷 [Proctor] Check result:", data.violation_type, data.face_count, data.confidence);
            
            // Map Python service names to our canonical event type names
            const FACE_VIOLATION_MAP = {
              no_face: "face-absent",
              wrong_face: "face-mismatch",
              multiple_faces: "face-multiple",
            };
            const rawType = data.violation_type || data.status; // Support both endpoints
            const vtype = FACE_VIOLATION_MAP[rawType] || rawType;
            
            setState((s) => ({ 
              ...s, 
              faceStatus: vtype === "none" || vtype === "ok" ? "ok" : vtype,
              lastCheckTime: new Date().toLocaleTimeString(),
            }));

            if (vtype && vtype !== "none" && vtype !== "service_unavailable") {
              console.warn("🚨 [Proctor] VIOLATION detected:", vtype);
              if (socketRef.current) {
                socketRef.current.emit("student:violation", { examId, studentId: studentIdRef.current, type: vtype });
              }
              await logProctorEvent(attemptId, vtype, {
                confidence: data.confidence,
                face_count: data.face_count,
              });
              if (SERIOUS_VIOLATION_TYPES.has(vtype)) {
                seriousViolationCountRef.current += 1;
              }
              const until = Date.now() + RETURN_TIMEOUT_SECONDS * 1000;
              setState((s) => ({
                ...s,
                violations: s.violations + 1,
                overlay: { reason: vtype, until },
              }));
            } else if (vtype === "none") {
              // Clear overlay if face is now ok (auto-resume)
              setState((s) => {
                if (s.overlay && s.overlay.reason && s.overlay.reason.startsWith("face-")) {
                  return { ...s, overlay: null };
                }
                return s;
              });
            }
          }
        } catch (err) {
          console.error("📷 [Proctor] Face check error:", err);
        }

        if (streamRef.current) {
           let nextInterval = FACE_CHECK_INTERVAL_MS;
           if (proctoringTierRef.current === "snapshot") {
              nextInterval = Math.floor(Math.random() * (45000 - 15000 + 1)) + 15000;
           }
           faceCheckIntervalRef.current = setTimeout(runLoop, nextInterval);
        }
      };

      if (proctoringTierRef.current !== "event-only") {
        faceCheckIntervalRef.current = setTimeout(runLoop, FACE_CHECK_INTERVAL_MS);
      }
    },
    [captureSnapshot, examId]
  );

  const startGazeCheckLoop = useCallback(
    (attemptId) => {
      const runLoop = async () => {
        if (proctoringTierRef.current === "event-only") return;
        if (!streamRef.current || !studentIdRef.current) return;
        try {
          const video = videoRef.current;
          if (video && !video.srcObject && streamRef.current) {
            video.srcObject = streamRef.current;
            video.play().catch(e => console.error("👀 [Gaze] Play failed during re-attach:", e));
          }

          const blob = await captureSnapshot();
          if (blob) {
            const { data } = await sendGazeFrame(studentIdRef.current, blob);
            console.log("👀 [Gaze] Check result:", data);

            let vtype = "ok";
            if (data.status === "no_face") {
              vtype = "gaze-no-face";
            } else if (data.looking_away) {
              vtype = "gaze-away";
            }

            setState((s) => ({ 
              ...s, 
              faceStatus: vtype === "ok" ? s.faceStatus : vtype, // Update status if there's a gaze issue
              lastCheckTime: new Date().toLocaleTimeString(),
            }));

            if (vtype !== "ok") {
              console.warn("🚨 [Gaze] VIOLATION detected:", vtype);
              if (socketRef.current) {
                socketRef.current.emit("student:violation", { examId, studentId: studentIdRef.current, type: vtype });
              }
              await logProctorEvent(attemptId, vtype, {
                direction: data.direction,
                penalty_score: data.penalty_score,
              });
              const until = Date.now() + RETURN_TIMEOUT_SECONDS * 1000;
              setState((s) => ({
                ...s,
                violations: s.violations + 1,
                overlay: { reason: vtype, until },
              }));
            } else {
              // Clear overly if gaze is now ok (auto-resume)
              setState((s) => {
                if (s.overlay && s.overlay.reason && s.overlay.reason.startsWith("gaze-")) {
                  return { ...s, overlay: null };
                }
                return s;
              });
            }
          }
        } catch (err) {
          console.error("👀 [Gaze] Gaze check error:", err);
        }

        if (streamRef.current) {
           let nextInterval = 5000;
           if (proctoringTierRef.current === "snapshot") {
              nextInterval = Math.floor(Math.random() * (30000 - 10000 + 1)) + 10000;
           }
           gazeCheckIntervalRef.current = setTimeout(runLoop, nextInterval);
        }
      };

      if (proctoringTierRef.current !== "event-only") {
        gazeCheckIntervalRef.current = setTimeout(runLoop, 5000);
      }
    },
    [captureSnapshot, examId]
  );

  const performStart = async () => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const metrics = await evaluateDeviceCapabilities();

      const { data } = await startAttempt(examId, { 
        deviceInfo: metrics.deviceInfo,
        proctoringTier: metrics.tier
      });
      const { attemptId, exam, serverEndTime } = data;

      const facultyTier = exam.proctoringTier || "full";
      const tierLevels = { "event-only": 0, "snapshot": 1, "full": 2 };
      const chosenTier = tierLevels[facultyTier] < tierLevels[metrics.tier] ? facultyTier : metrics.tier;
      proctoringTierRef.current = chosenTier;

      // Populate student ID reference early for socket usage
      const storedUser = localStorage.getItem("user");
      if (storedUser) {
        const u = JSON.parse(storedUser);
        studentIdRef.current = u.rollno || u.email || u._id || "";
      }

      // Socket and WebRTC Setup
      const socket = io(import.meta.env.VITE_API_URL || `http://${window.location.hostname}:5000`, {
        transports: ["websocket"],
      });
      socketRef.current = socket;

      socket.on("connect", () => {
        socket.emit("student:join", {
          examId,
          studentId: studentIdRef.current,
          studentName: JSON.parse(localStorage.getItem("user"))?.name || "Student",
        });
      });

      socket.on("faculty:online", () => {
        // Re-announce presence if faculty joins late or reconnects
        socket.emit("student:join", {
          examId,
          studentId: studentIdRef.current,
          studentName: JSON.parse(localStorage.getItem("user"))?.name || "Student",
        });
      });

      socket.on("config:autosubmit", ({ enabled }) => {
        autoSubmitEnabledRef.current = enabled;
      });

      socket.on("faculty:warning", ({ message }) => {
        setState((s) => ({
          ...s,
          overlay: {
            reason: "faculty-warning",
            until: Date.now() + 10000,
            message: message
          }
        }));
        registerViolation("faculty-warning", { message });
      });

      socket.on("faculty:force_submit", () => {
        // Use ref to avoid stale closure - handleSubmit captured at socket
        // setup time has state.attemptId === null
        if (handleSubmitRef.current) handleSubmitRef.current(true);
      });

      socket.on("faculty:request_offer", async ({ facultySocketId }) => {
        try {
          // Close any existing peer connection to avoid race conditions
          // when multiple request_offer events arrive in quick succession
          if (peerConnectionRef.current) {
            try { peerConnectionRef.current.close(); } catch {}
            peerConnectionRef.current = null;
          }

          const pc = new RTCPeerConnection({
            iceServers: [
              { urls: "stun:stun.l.google.com:19302" }
            ],
          });
          peerConnectionRef.current = pc;

          // Wait until the webcam stream is acquired on slower/mobile devices
          let waitCycles = 0;
          while (!streamRef.current && waitCycles < 20) {
             await new Promise(r => setTimeout(r, 500));
             waitCycles++;
          }

          if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => pc.addTrack(track, streamRef.current));
          }

          pc.onicecandidate = (event) => {
            if (event.candidate) {
              socket.emit("webrtc:candidate", { targetSocketId: facultySocketId, candidate: event.candidate });
            }
          };

          const offer = await pc.createOffer();
          // Verify this PC is still the current one (another request_offer may have replaced it)
          if (peerConnectionRef.current !== pc) {
            pc.close();
            return;
          }
          await pc.setLocalDescription(offer);
          socket.emit("webrtc:offer", {
            targetSocketId: facultySocketId,
            offer,
            studentId: studentIdRef.current,
            studentName: JSON.parse(localStorage.getItem("user"))?.name || "Student"
          });
        } catch (err) {
          console.error("WebRTC Error:", err);
        }
      });

      socket.on("webrtc:answer", async ({ answer }) => {
        const pc = peerConnectionRef.current;
        if (pc && pc.signalingState === "have-local-offer") {
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(answer));
          } catch (e) {
            console.error("Failed to set remote answer:", e);
          }
        }
      });

      socket.on("webrtc:candidate", async ({ candidate }) => {
        if (peerConnectionRef.current) {
          try {
            await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.error("Failed to add ICE candidate:", e);
          }
        }
      });

      // Request fullscreen FIRST
      await requestFullscreen();

      // Wait longer for fullscreen to stabilize
      await new Promise((resolve) => setTimeout(resolve, 800));

      // Now set started to true - this will trigger proctoring listeners
      setState((s) => ({
        ...s,
        loading: false,
        attemptId,
        exam,
        endAt: serverEndTime,
        started: true,
      }));

      // Ensure studentId is set in ref before starting loop
      const stored = localStorage.getItem("user");
      if (stored) {
        const u = JSON.parse(stored);
        studentIdRef.current = u.rollno || u.email || u._id || "";
      }

      // Start face check loop during exam
      startFaceCheckLoop(attemptId);
      startGazeCheckLoop(attemptId);

      syncCountdown(serverEndTime);

      // Reset the ignore flag after everything is set up
      setTimeout(() => {
        ignoreFsChangeRef.current = false;
      }, 1000);
    } catch (e) {
      setState((s) => ({
        ...s,
        loading: false,
        error:
          e?.response?.data?.message ||
          e?.response?.data?.error ||
          "Failed to start attempt",
      }));
      await exitFullscreen();
    }
  };

  useEffect(() => {
    if (state.submitted) {
      stopWebcam();
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    }
  }, [state.submitted, stopWebcam]);

  useEffect(() => {
    const stored = localStorage.getItem("user");
    if (!stored) {
      navigate("/login");
      return;
    }
    const u = JSON.parse(stored);
    if (u.role !== "student") {
      navigate("/");
      return;
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      stopWebcam();
      if (socketRef.current) socketRef.current.disconnect();
      if (peerConnectionRef.current) peerConnectionRef.current.close();
    };
  }, [examId, navigate]);

  // Auto-start webcam as soon as the student is authenticated
  useEffect(() => {
    const stored = localStorage.getItem("user");
    if (stored) {
      const u = JSON.parse(stored);
      studentIdRef.current = u.rollno || u.email || u._id || "";
      
      // Start webcam immediately so it's ready for registration AND background proctoring
      startWebcam();
    }
    
    return () => {
      stopWebcam();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount


  // Auto-submit when time runs out - DISABLED
  // useEffect(() => {
  //   if (
  //     state.remaining === 0 &&
  //     state.attemptId &&
  //     !state.submitted &&
  //     !isSubmittingRef.current
  //   ) {
  //     handleSubmit(true);
  //   }
  // }, [state.remaining, state.attemptId, state.submitted, handleSubmit]);

  // Proctoring handlers - attach only once
  useEffect(() => {
    if (
      !state.started ||
      !state.attemptId ||
      state.submitted ||
      proctorListenersAttached.current
    ) {
      return;
    }

    proctorListenersAttached.current = true;

    const onVisibility = async () => {
      if (document.visibilityState === "hidden" && !state.submitted) {
        await registerViolation("visibility-hidden", { reason: "tab hidden" });
      }
    };

    const onBlur = async () => {
      if (!state.submitted) {
        await registerViolation("tab-blur");
      }
    };

    const onFsChange = async () => {
      // Always check the ignore flag first
      if (ignoreFsChangeRef.current) {
        return; // Don't reset the flag here
      }

      if (!document.fullscreenElement && !state.submitted) {
        // Try to immediately restore fullscreen once to reduce false positives
        try {
          await requestFullscreen();
        } catch {}
        setTimeout(async () => {
          if (!document.fullscreenElement && !state.submitted) {
            await registerViolation("fullscreen-exit");
          }
        }, 200);
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    document.addEventListener("fullscreenchange", onFsChange);

    // Detect suspicious window resizing (e.g., minimize or unmaximize while exam active)
    const onResize = async () => {
      if (state.submitted) return;
      const w = window.innerWidth;
      const h = window.innerHeight;
      // Heuristic: if window height is very small or significantly smaller than screen,
      // we consider it a violation even if fullscreen flag didn't fire
      const shrunkTooMuch =
        h < screen.availHeight * 0.6 || w < screen.availWidth * 0.6;
      if (shrunkTooMuch) {
        await registerViolation("window-resize", {
          w,
          h,
          sw: screen.availWidth,
          sh: screen.availHeight,
        });
      }
    };
    window.addEventListener("resize", onResize);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("fullscreenchange", onFsChange);
      window.removeEventListener("resize", onResize);
      proctorListenersAttached.current = false;
    };
  }, [state.started, state.attemptId, state.submitted, registerViolation]);

  // Anti-cheat: block copy/cut and common shortcuts; best-effort attempt to block Alt+Tab
  useEffect(() => {
    if (!state.started || state.submitted) return;

    const preventKeys = (e) => {
      const key = (e.key || "").toLowerCase();
      // Block common clipboard/print/save/select-all shortcuts
      if ((e.ctrlKey || e.metaKey) && ["c", "x", "p", "s", "a"].includes(key)) {
        e.preventDefault();
        e.stopPropagation();
      }
      // Best-effort: try to prevent Alt+Tab (OS-level; may not be capturable)
      if (e.altKey && key === "tab") {
        e.preventDefault();
        e.stopPropagation();
      }
      // Attempt to block F11 (browser fullscreen toggle) and Escape (exit fullscreen)
      if (key === "f11" || key === "escape") {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const prevent = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };

    document.addEventListener("keydown", preventKeys, true);
    document.addEventListener("copy", prevent, true);
    document.addEventListener("cut", prevent, true);
    document.addEventListener("contextmenu", prevent, true);
    const beforeUnload = (e) => {
      // Warn before leaving or reloading during exam
      e.preventDefault();
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", beforeUnload);

    return () => {
      document.removeEventListener("keydown", preventKeys, true);
      document.removeEventListener("copy", prevent, true);
      document.removeEventListener("cut", prevent, true);
      document.removeEventListener("contextmenu", prevent, true);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [state.started, state.submitted]);

  // Disable text selection and drag while exam is active
  useEffect(() => {
    if (!state.started || state.submitted) return undefined;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const onSelectStart = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onDragStart = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("selectstart", onSelectStart, true);
    document.addEventListener("dragstart", onDragStart, true);
    return () => {
      document.body.style.userSelect = prevUserSelect;
      document.removeEventListener("selectstart", onSelectStart, true);
      document.removeEventListener("dragstart", onDragStart, true);
    };
  }, [state.started, state.submitted]);

  const scheduleSave = (answersPatch) => {
    setState((s) => {
      const next = { ...s.answers, ...answersPatch };
      answersRef.current = next;
      return { ...s, answers: next };
    });
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      const payload = Object.entries(answersRef.current).map(([k, v]) => ({
        questionIndex: Number(k),
        value: v,
      }));
      try {
        await saveAttempt(state.attemptId, payload);
      } catch {
        // ignore autosave failure
      }
    }, AUTOSAVE_MS);
  };

  const handleChange = (qIdx, value) => {
    scheduleSave({ [qIdx]: value });
  };

  const exitAfterSubmit = () => {
    navigate("/exams");
  };

  const exam = state.exam;
  const secs = state.remaining;
  const mm = Math.floor(secs / 60);
  const ss = (secs % 60).toString().padStart(2, "0");

  return (
    <div className="max-w-5xl mx-auto p-4">
      {/* Persistent Video Element - MUST remain mounted throughout all states */}
      <div className={(!state.started && !state.faceRegistered) ? "mb-4 rounded overflow-hidden border border-gray-300 bg-black max-w-[420px]" : ""}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={(!state.started && !state.faceRegistered) ? "w-full block" : ""}
          style={
            (state.started || state.faceRegistered)
              ? {
                  position: "fixed",
                  top: 0,
                  right: 0,
                  width: "240px",
                  height: "180px",
                  opacity: 0.05,
                  pointerEvents: "none",
                  zIndex: -100,
                }
              : {}
          }
        />
      </div>

      {state.loading && <div className="p-6">Loading...</div>}
      {state.error && <div className="p-6 text-red-600">{state.error}</div>}

      {!state.loading && !state.error && (
        <>
      {/* ── Pre-exam: Face capture step ────────────────────────────────────────── */}
      {!state.started && (
        <div className="max-w-3xl mx-auto py-6">
          {!state.faceRegistered ? (
            <div>
              <h1 className="text-2xl font-bold mb-2">Face Verification Required</h1>
              <p className="text-gray-700 mb-4">
                Before the exam begins, we need to capture your face for identity
                verification. Please ensure good lighting and look directly at the
                camera. Your camera will remain active during the exam.
              </p>
              
              {state.faceError && (
                <p className="text-red-600 mb-3 text-sm">{state.faceError}</p>
              )}
              <div className="flex gap-3 items-center">
                <button
                  className="bg-indigo-600 text-white px-4 py-2 rounded disabled:opacity-60"
                  onClick={handleCaptureFace}
                  disabled={state.faceStep === "registering"}
                >
                  {state.faceStep === "registering" ? "Registering..." : "Capture Face"}
                </button>
                <button className="text-gray-700" onClick={() => navigate(-1)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-4">
                <span className="text-green-600 text-2xl">✓</span>
                <h1 className="text-2xl font-bold">Face captured successfully</h1>
              </div>
              <p className="text-gray-700 mb-4">
                Your identity has been verified. When you start, the exam will
                enter fullscreen and proctoring (fullscreen + face recognition)
                will begin. Please avoid switching tabs or exiting fullscreen.
              </p>
              <div className="flex gap-3">
                <button
                  className="bg-indigo-600 text-white px-4 py-2 rounded"
                  onClick={performStart}
                >
                  Begin Exam
                </button>
                <button className="text-gray-700" onClick={() => navigate(-1)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Main Exam UI ─────────────────────────────────────────────────────── */}
      {state.started && (
        <>

        {/* Persistent Hidden Video for Background proctoring handled above */}

      {/* Real-time face status indicator */}
      {state.started && !state.submitted && (
        <div 
          className={`fixed top-4 left-4 z-[60] flex items-center gap-2 px-3 py-1.5 rounded-full backdrop-blur-md border text-xs pointer-events-none transition-colors duration-300 ${
            state.faceStatus === "ok" 
              ? "bg-black/60 border-white/20 text-white" 
              : "bg-red-600/90 border-red-400 text-white animate-pulse"
          }`}
          title="Live Proctoring active"
        >
          <div className={`w-2 h-2 rounded-full ${state.faceStatus === "ok" ? "bg-green-500" : "bg-white"}`} />
          <span>
            {state.faceStatus === "ok" ? "Face Proctoring Active" : 
             state.faceStatus === "face-absent" ? "No Face Detected — Attention!" :
             state.faceStatus === "face-mismatch" ? "Identity Mismatch — Flagged!" :
             state.faceStatus === "face-multiple" ? "Multiple Faces — Flagged!" :
             "Proctoring status: " + state.faceStatus}
          </span>
        </div>
      )}

      {state.overlay && !state.submitted && (
        <div className="fixed inset-0 bg-black/70 text-white flex flex-col items-center justify-center z-50">
          <h2 className="text-2xl font-bold mb-2">Stay on the exam</h2>
          {(() => {
            const map = {
              "visibility-hidden": {
                title: "You switched away from the test",
                detail:
                  "Please keep this tab visible. Switching to other apps or tabs isn't allowed during the exam.",
              },
              "tab-blur": {
                title: "You left the test window",
                detail:
                  "Please keep the exam window active. Clicking outside or alt-tabbing counts as a violation.",
              },
              "fullscreen-exit": {
                title: "You exited fullscreen",
                detail:
                  "The exam must remain in fullscreen. Please return to fullscreen to continue.",
              },
              "return-timeout": {
                title: "You took too long to return",
                detail:
                  "Please stay within the exam window and avoid leaving for extended periods.",
              },
              "face-absent": {
                title: "No face detected",
                detail:
                  "Your face is not visible to the camera. Please ensure you are sitting in front of the webcam.",
              },
              "face-mismatch": {
                title: "Identity mismatch detected",
                detail:
                  "The face detected does not match the registered student. This has been flagged for review.",
              },
              "face-multiple": {
                title: "Multiple faces detected",
                detail:
                  "More than one person is visible in the camera. Only the registered student may be present during the exam.",
              },
              "gaze-away": {
                title: "Looking away detected",
                detail:
                  "You appear to be looking away from the screen. Please keep your focus on the test.",
              },
              "gaze-no-face": {
                title: "Face not visible for gaze tracking",
                detail:
                  "Please ensure you are sitting correctly so the webcam can track your gaze.",
              },
              "faculty-warning": {
                title: "Warning from Proctor",
                detail: state.overlay.message || "Please fix your behavior immediately.",
              },
            };
            const v = map[state.overlay.reason] || {
              title: "Activity outside the exam detected",
              detail:
                "Please keep the exam window focused and in fullscreen for the duration of the test.",
            };
            return (
              <>
                <div className="text-lg font-semibold mb-1">{v.title}</div>
                <p className="mb-4 text-sm text-gray-200">{v.detail}</p>
              </>
            );
          })()}
          {typeof state.overlay.until === "number" && (
            <div className="mb-4 text-sm text-gray-200">
              Warning will clear in{" "}
              {Math.max(
                0,
                Math.ceil((state.overlay.until - Date.now()) / 1000)
              )}
              s
            </div>
          )}
          <button
            className="bg-white text-black px-4 py-2 rounded"
            onClick={async () => {
              await requestFullscreen();
              setState(s => ({ ...s, overlay: null }));
            }}
          >
            Return now
          </button>
        </div>
      )}

      {state.showSubmitConfirm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md mx-4">
            <h2 className="text-xl font-bold mb-4">Submit Exam</h2>
            <p className="text-gray-700 mb-6">
              Are you sure you want to submit your exam? This action cannot be
              undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                className="px-4 py-2 text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
                onClick={cancelSubmit}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
                onClick={confirmSubmit}
              >
                Submit
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-start sm:items-center justify-between gap-2 sm:gap-4 flex-col sm:flex-row mb-4">
        <h1 className="text-2xl font-bold">{exam.title}</h1>
        <div
          className={`text-lg font-semibold ${
            state.remaining === 0 ? "text-red-600" : ""
          }`}
        >
          {`Time left: ${mm}:${ss}`}
        </div>
      </div>

      {/* Removed the time-expired paragraph that briefly showed at start */}

      <p className="text-gray-700 mb-4">{exam.description}</p>

      {state.submitted && (
        <div className="bg-white rounded shadow p-6 my-4">
          <h2 className="text-xl font-semibold mb-2">Test submitted</h2>
          {state.result && (
            <div className="text-gray-800">
              <div>
                Score:{" "}
                <span className="font-semibold">{state.result.score}</span>
              </div>
              {state.result.manualNeeded && (
                <div className="text-sm text-gray-600">
                  Some answers require manual grading. Final score may change.
                </div>
              )}
              <div className="text-sm text-gray-600">
                Submitted at:{" "}
                {state.result.submittedAt
                  ? new Date(state.result.submittedAt).toLocaleString()
                  : "-"}
              </div>
            </div>
          )}
          <div className="pt-3">
            <button
              className="bg-indigo-600 text-white px-4 py-2 rounded"
              onClick={exitAfterSubmit}
            >
              Exit test
            </button>
          </div>
        </div>
      )}

      {!state.submitted && (
        <div className="space-y-4">
          {exam.questions.map((q, idx) => (
            <div key={idx} className="bg-white rounded shadow p-4">
              <div className="font-medium mb-2 flex items-start gap-2">
                <span className="mt-0.5">Q{idx + 1}.</span>
                <div className="flex-1 overflow-x-auto"><MarkdownRenderer content={q.text} /></div>
                <span className="text-sm text-gray-500 shrink-0 mt-0.5">({q.points} pts)</span>
              </div>
              {q.type === "text" && (
                <textarea
                  className="border rounded w-full px-3 py-2"
                  rows={3}
                  value={state.answers[idx] || ""}
                  onChange={(e) => handleChange(idx, e.target.value)}
                  disabled={state.submitted}
                />
              )}
              {q.type === "single" && (
                <div className="space-y-1">
                  {(q.options || []).map((opt, oi) => (
                    <label key={oi} className="block">
                      <input
                        type="radio"
                        name={`q-${idx}`}
                        checked={state.answers[idx] === oi}
                        onChange={() => handleChange(idx, oi)}
                        disabled={state.submitted}
                      />{" "}
                      <div className="ml-2 flex-1 overflow-x-auto inline-block align-top"><MarkdownRenderer content={opt} /></div>
                    </label>
                  ))}
                </div>
              )}
              {q.type === "mcq" && (
                <div className="space-y-1">
                  {(q.options || []).map((opt, oi) => (
                    <label key={oi} className="block">
                      <input
                        type="checkbox"
                        checked={
                          Array.isArray(state.answers[idx]) &&
                          state.answers[idx].includes(oi)
                        }
                        disabled={state.submitted}
                        onChange={(e) => {
                          const prev = new Set(
                            Array.isArray(state.answers[idx])
                              ? state.answers[idx]
                              : []
                          );
                          e.target.checked ? prev.add(oi) : prev.delete(oi);
                          handleChange(
                            idx,
                            Array.from(prev).sort((a, b) => a - b)
                          );
                        }}
                      />{" "}
                      <div className="ml-2 flex-1 overflow-x-auto inline-block align-top"><MarkdownRenderer content={opt} /></div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="py-4">
        {!state.submitted ? (
          <button
            className="bg-green-600 text-white px-4 py-2 rounded"
            onClick={() => handleSubmit(false)}
          >
            Submit test
          </button>
        ) : (
          <button
            className="bg-indigo-600 text-white px-4 py-2 rounded"
            onClick={exitAfterSubmit}
          >
            Exit test
          </button>
        )}
      </div>
        </>
      )}
        </>
      )}
    </div>
  );
};

export default ExamRunner;
