"""
test_gaze.py — live webcam debug view
Shows h_ratio and v_ratio in real time so you can calibrate thresholds.
Press Q to quit.
"""
import cv2
import mediapipe as mp
from utils.gaze_tracker import _gaze_direction, LEFT_IRIS, RIGHT_IRIS

mp_mesh = mp.solutions.face_mesh
mesh = mp_mesh.FaceMesh(static_image_mode=False, max_num_faces=1,
                         refine_landmarks=True, min_detection_confidence=0.5,
                         min_tracking_confidence=0.5)

cap = cv2.VideoCapture(0)
while True:
    ret, frame = cap.read()
    if not ret:
        break

    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    res = mesh.process(rgb)

    if res.multi_face_landmarks:
        lm = res.multi_face_landmarks[0].landmark
        gaze = _gaze_direction(lm)
        if gaze:
            txt = (f"h={gaze['h_ratio']:.2f}  v={gaze['v_ratio']:.2f}"
                   f"  {gaze['direction']}  away={gaze['looking_away']}")
            color = (0, 0, 255) if gaze["looking_away"] else (0, 200, 0)
            cv2.putText(frame, txt, (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)

        # Draw iris landmarks
        h, w = frame.shape[:2]
        for idx in LEFT_IRIS + RIGHT_IRIS:
            px = int(lm[idx].x * w)
            py = int(lm[idx].y * h)
            cv2.circle(frame, (px, py), 2, (255, 100, 0), -1)
    else:
        cv2.putText(frame, "no face", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0,0,255), 2)

    cv2.imshow("Gaze Debug", frame)
    if cv2.waitKey(1) & 0xFF == ord("q"):
        break

cap.release()
cv2.destroyAllWindows()