"""
face_db.py
==========
Face Registration & Verification Module for Proctored Testing System.

Dependencies:
    pip install face_recognition opencv-python numpy Pillow

Flow (per Process_flow_1.pdf):
    Registration  → register_face()
    Verification  → verify_face()
    Proctoring    → uses verify_face() + count_faces_in_frame() in a loop

Privacy note:
    Only face embeddings (128 floats) are stored — NOT the raw image.
    The original photo cannot be reconstructed from an embedding.

Preprocessing note:
    All images pass through preprocess_image() before embedding.
    This applies CLAHE (Contrast Limited Adaptive Histogram Equalization)
    in the LAB colour space to normalise brightness and local contrast.
    Colour information is fully preserved — this is NOT grayscale conversion.

Windows / numpy note:
    dlib 19.22 is incompatible with numpy 2.x on Windows.
    Always use numpy < 2.0 in this environment (numpy==1.26.4 recommended).
    Images are loaded via OpenCV + PIL to guarantee a dlib-compatible
    uint8 RGB array regardless of platform or image format.
"""

import sqlite3
import logging
from contextlib import contextmanager

import cv2
import face_recognition
import numpy as np
from PIL import Image as PILImage

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("face_db")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DB_PATH = "face_db.db"
DEFAULT_VERIFY_THRESHOLD = 0.55   # lower = tighter match


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
@contextmanager
def get_db(db_path=DB_PATH):
    """
    Context manager that yields (conn, cursor) and always closes cleanly.
    Rolls back on exception so the DB is never left in a bad state.
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    try:
        yield conn, cursor
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(db_path=DB_PATH):
    """
    Create the student_faces table if it does not exist.
    Safe to call on every startup — uses CREATE TABLE IF NOT EXISTS.

    Schema
    ------
    student_id  : TEXT  PRIMARY KEY
    embedding   : BLOB  (serialised numpy float64 array - 128 floats, ~1KB)
    created_at  : TEXT  (ISO-8601 timestamp, auto-filled by SQLite)

    Note: raw images are NOT stored to avoid privacy/compliance issues.
    """
    with get_db(db_path) as (_, cursor):
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS student_faces (
                student_id  TEXT PRIMARY KEY,
                embedding   BLOB NOT NULL,
                created_at  TEXT DEFAULT (datetime('now'))
            )
        """)
    logger.info("Database initialised at '%s'.", db_path)


# ---------------------------------------------------------------------------
# Embedding helpers
# ---------------------------------------------------------------------------
def embedding_to_bytes(embedding):
    """Serialise a face embedding (float64 array) to bytes for storage."""
    return embedding.astype(np.float64).tobytes()


def bytes_to_embedding(raw):
    """Deserialise stored bytes back to a float64 numpy array."""
    return np.frombuffer(raw, dtype=np.float64)


# ---------------------------------------------------------------------------
# Image loading helper
# ---------------------------------------------------------------------------
def load_image_rgb(image_path):
    """
    Load an image from disk and return a uint8 RGB numpy array that is
    guaranteed to be compatible with dlib/face_recognition on all platforms.

    Why not face_recognition.load_image_file?
    -----------------------------------------
    On Windows with numpy 2.x, dlib 19.22 raises:
        RuntimeError: Unsupported image type, must be 8bit gray or RGB image.
    even when the array looks correct (right shape, dtype, contiguous).
    This is a known numpy 2.x / dlib 19.22 ABI incompatibility.

    Why not cv2.imread alone?
    -------------------------
    cv2.imread returns BGR. Passing BGR to face_recognition gives wrong
    embeddings (colours are swapped). We must convert to RGB.

    Why PIL .convert("RGB")?
    ------------------------
    PIL's convert("RGB") normalises the memory layout and colour mode,
    producing an array that dlib accepts reliably even on numpy 1.26.x.
    It also handles edge cases like CMYK JPEGs or palette PNGs automatically.

    Parameters
    ----------
    image_path : str — path to image file (JPEG, PNG, etc.)

    Returns
    -------
    np.ndarray — HxWx3 uint8 array in RGB order, or None if read failed.
    """
    bgr = cv2.imread(str(image_path))
    if bgr is None:
        return None
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    pil_img = PILImage.fromarray(rgb).convert("RGB")
    return np.array(pil_img, dtype=np.uint8)


# ---------------------------------------------------------------------------
# Preprocessing
# ---------------------------------------------------------------------------
def preprocess_image(rgb_image):
    """
    Apply CLAHE (Contrast Limited Adaptive Histogram Equalization) to an
    RGB image to normalise brightness and local contrast.

    WHY CLAHE AND NOT GRAYSCALE
    ---------------------------
    dlib's face recognition model (used by face_recognition) was trained on
    colour (RGB) images. Converting to grayscale discards the chrominance
    channels that the model's convolutional layers rely on for distinguishing
    facial features — this degrades embedding quality and increases distance
    scores even for the same person.

    CLAHE instead operates only on the L (Lightness) channel of the LAB
    colour space, leaving the A (green-red) and B (blue-yellow) colour
    channels completely untouched. The result is a brightness-normalised
    image that is still fully colour, so dlib receives input that matches
    its training distribution.

    WHY LAB COLOUR SPACE
    --------------------
    LAB separates luminance (L) from colour (A, B), so contrast can be
    enhanced without shifting hues or saturating colours. Applying CLAHE
    directly on RGB would enhance each channel independently, distorting
    colours and skewing the resulting embeddings.

    WHY CLAHE OVER PLAIN HISTOGRAM EQUALIZATION
    --------------------------------------------
    Plain HE equalises the entire image globally. In a frame where a bright
    window sits behind the student, HE crushes the face into darkness.
    CLAHE divides the image into small tiles and equalises each independently,
    then blends the borders. The clipLimit caps amplification per tile so
    noise in dark regions is not over-boosted.

    PARAMETERS CHOSEN
    -----------------
    clipLimit=2.0      Standard value; keeps enhancement moderate.
                       Values above 3.0 start introducing visible halos.
    tileGridSize=(8,8) Divides a typical webcam frame into 64 tiles —
                       fine-grained enough to handle local shadows (e.g. one
                       side of the face darker than the other) without making
                       tile boundaries visible.

    Parameters
    ----------
    rgb_image : np.ndarray
        An HxWx3 uint8 array in RGB order.

    Returns
    -------
    np.ndarray
        CLAHE-enhanced image in RGB order, same shape and dtype as input.
    """
    # Step 1: RGB -> BGR -> LAB  (OpenCV works in BGR internally)
    bgr = cv2.cvtColor(rgb_image, cv2.COLOR_RGB2BGR)
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)

    # Step 2: Split into L, A, B channels
    l_channel, a_channel, b_channel = cv2.split(lab)

    # Step 3: Apply CLAHE only to L (lightness) — colour channels untouched
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l_enhanced = clahe.apply(l_channel)

    # Step 4: Merge enhanced L back with original A and B
    lab_enhanced = cv2.merge([l_enhanced, a_channel, b_channel])

    # Step 5: LAB -> BGR -> RGB to return in the format face_recognition expects
    bgr_enhanced = cv2.cvtColor(lab_enhanced, cv2.COLOR_LAB2BGR)
    rgb_enhanced = cv2.cvtColor(bgr_enhanced, cv2.COLOR_BGR2RGB)

    return rgb_enhanced


# ---------------------------------------------------------------------------
# Core API
# ---------------------------------------------------------------------------
def register_face(image_path, student_id, db_path=DB_PATH):
    """
    Register a student's face from a still image.
    Only the embedding is saved - the image file is never stored in the DB.

    Parameters
    ----------
    image_path : path to the student's photo (JPEG / PNG / etc.)
    student_id : unique identifier (e.g. roll number)
    db_path    : path to the SQLite database file

    Returns
    -------
    dict with keys:
        status     : "success" | "error"
        student_id : echoed on success
        message    : human-readable detail on error
    """
    image = load_image_rgb(image_path)
    if image is None:
        return {"status": "error", "message": "Could not read image file."}

    image = preprocess_image(image)

    face_locations = face_recognition.face_locations(image, model="hog")

    if len(face_locations) == 0:
        return {"status": "error", "message": "No face detected in the image."}
    if len(face_locations) > 1:
        return {"status": "error", "message": f"{len(face_locations)} faces detected; exactly one required."}

    embeddings = face_recognition.face_encodings(image, face_locations)
    if not embeddings:
        return {"status": "error", "message": "Could not compute face embedding."}

    embedding_bytes = embedding_to_bytes(embeddings[0])

    with get_db(db_path) as (_, cursor):
        cursor.execute(
            "INSERT OR REPLACE INTO student_faces (student_id, embedding) VALUES (?, ?)",
            (student_id, embedding_bytes),
        )

    logger.info("Registered student '%s'.", student_id)
    return {"status": "success", "student_id": student_id}


def verify_face(live_image, student_id, threshold=DEFAULT_VERIFY_THRESHOLD, db_path=DB_PATH):
    """
    Verify whether a live image matches the registered face.

    Parameters
    ----------
    live_image : file path (str) OR a BGR numpy array (from cv2.VideoCapture)
    student_id : student to compare against
    threshold  : distance cut-off - lower means stricter
    db_path    : path to the SQLite database file

    Returns
    -------
    dict with keys:
        match      : bool
        confidence : float  (0-1, higher is better)
        distance   : float  (lower is better)
        message    : present only on error
    """
    with get_db(db_path) as (_, cursor):
        cursor.execute(
            "SELECT embedding FROM student_faces WHERE student_id = ?",
            (student_id,),
        )
        row = cursor.fetchone()

    if row is None:
        return {"status": "error", "message": f"No face registered for '{student_id}'."}

    stored_embedding = bytes_to_embedding(row["embedding"])

    # --- Load live image into a dlib-compatible uint8 RGB array ---
    if isinstance(live_image, str):
        # File path — use the same load_image_rgb helper for consistency
        live_rgb = load_image_rgb(live_image)
        if live_rgb is None:
            return {"status": "error", "message": "Could not read live image file."}

    elif isinstance(live_image, np.ndarray):
        # Webcam frame from cv2.VideoCapture — arrives as BGR uint8
        if live_image.ndim == 2:
            # Grayscale — convert to RGB
            live_rgb = cv2.cvtColor(live_image, cv2.COLOR_GRAY2RGB)
        elif live_image.shape[2] == 4:
            # BGRA — drop alpha then convert
            live_rgb = cv2.cvtColor(live_image[:, :, :3], cv2.COLOR_BGR2RGB)
        else:
            live_rgb = cv2.cvtColor(live_image, cv2.COLOR_BGR2RGB)

        if live_rgb.dtype != np.uint8:
            live_rgb = (live_rgb / live_rgb.max() * 255).astype(np.uint8)

        # Run through PIL to guarantee dlib-compatible memory layout
        live_rgb = np.array(PILImage.fromarray(live_rgb).convert("RGB"), dtype=np.uint8)

    else:
        return {"status": "error", "message": "live_image must be a file path or numpy array."}

    live_rgb = preprocess_image(live_rgb)

    face_locations = face_recognition.face_locations(live_rgb, model="hog")

    if len(face_locations) == 0:
        return {"status": "error", "message": "No face detected in live image.", "face_count": 0}
    if len(face_locations) > 1:
        return {"status": "error", "message": "Multiple faces detected.", "face_count": len(face_locations)}

    live_embeddings = face_recognition.face_encodings(live_rgb, face_locations)
    if not live_embeddings:
        return {"status": "error", "message": "Could not compute live face embedding."}

    live_embedding = live_embeddings[0]

    distance = float(np.linalg.norm(stored_embedding - live_embedding))
    confidence = round(max(0.0, 1.0 - distance), 4)
    is_match = distance < threshold

    logger.debug(
        "verify_face | student=%s | distance=%.4f | threshold=%.4f | match=%s",
        student_id, distance, threshold, is_match,
    )

    return {
        "match": is_match,
        "confidence": confidence,
        "distance": round(distance, 4),
        "face_count": 1,
    }


def count_faces_in_frame(frame):
    """
    Return the number of faces detected in a BGR video frame.

    Used by the proctoring loop to flag:
        0  -> no face detected
        1  -> normal
        >1 -> multiple people
    """
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    rgb = np.array(PILImage.fromarray(rgb).convert("RGB"), dtype=np.uint8)
    rgb = preprocess_image(rgb)
    locations = face_recognition.face_locations(rgb, model="hog")
    return len(locations)


def delete_student(student_id, db_path=DB_PATH):
    """Remove a student's registration from the database."""
    with get_db(db_path) as (_, cursor):
        cursor.execute(
            "DELETE FROM student_faces WHERE student_id = ?", (student_id,)
        )
        deleted = cursor.rowcount

    if deleted:
        logger.info("Deleted registration for '%s'.", student_id)
        return {"status": "success", "student_id": student_id}
    return {"status": "error", "message": f"No record found for '{student_id}'."}


def list_students(db_path=DB_PATH):
    """Return a list of all registered student IDs."""
    with get_db(db_path) as (_, cursor):
        cursor.execute("SELECT student_id FROM student_faces ORDER BY student_id")
        return [row["student_id"] for row in cursor.fetchall()]

def proctor_check(frame_image, student_id, run_reverify=False, threshold=DEFAULT_VERIFY_THRESHOLD, db_path=DB_PATH):
    """
    Single proctoring snapshot check. Called every few seconds during an exam.

    Checks
    ------
    1. Face count  — always runs
         0 faces  -> "no_face"
         >1 faces -> "multiple_faces"
         1 face   -> "ok" (or proceeds to reverify if requested)

    2. Re-verification — runs only when run_reverify=True
         Compares the live face embedding against the registered one.
         Triggers "identity_mismatch" if distance >= threshold.

    Parameters
    ----------
    frame_image  : file path (str) OR BGR numpy array from cv2
    student_id   : registered student to check against
    run_reverify : bool — whether to run identity check this cycle
    threshold    : Euclidean distance cut-off (default 0.55)
    db_path      : SQLite DB path

    Returns
    -------
    dict:
        status      : "ok" | "no_face" | "multiple_faces" | "identity_mismatch" | "error"
        face_count  : int (always present)
        run_reverify: bool (echoed)
        confidence  : float | None  (only when reverify ran and succeeded)
        distance    : float | None  (only when reverify ran and succeeded)
        message     : str | None    (only on error or mismatch detail)
    """

    # --- Load and preprocess image ---
    if isinstance(frame_image, str):
        rgb = load_image_rgb(frame_image)
        if rgb is None:
            return {"status": "error", "face_count": 0, "run_reverify": run_reverify, "message": "Could not read image."}
    elif isinstance(frame_image, np.ndarray):
        if frame_image.ndim == 2:
            rgb = cv2.cvtColor(frame_image, cv2.COLOR_GRAY2RGB)
        elif frame_image.shape[2] == 4:
            rgb = cv2.cvtColor(frame_image[:, :, :3], cv2.COLOR_BGR2RGB)
        else:
            rgb = cv2.cvtColor(frame_image, cv2.COLOR_BGR2RGB)
        if rgb.dtype != np.uint8:
            rgb = (rgb / rgb.max() * 255).astype(np.uint8)
        rgb = np.array(PILImage.fromarray(rgb).convert("RGB"), dtype=np.uint8)
    else:
        return {"status": "error", "face_count": 0, "run_reverify": run_reverify, "message": "Invalid image input type."}

    rgb = preprocess_image(rgb)

    # --- Step 1: Face count check ---
    face_locations = face_recognition.face_locations(rgb, model="hog")
    face_count = len(face_locations)

    if face_count == 0:
        logger.info("proctor_check | student=%s | no_face", student_id)
        return {
            "status": "no_face",
            "face_count": 0,
            "run_reverify": run_reverify,
            "confidence": None,
            "distance": None,
        }

    if face_count > 1:
        logger.info("proctor_check | student=%s | multiple_faces=%d", student_id, face_count)
        return {
            "status": "multiple_faces",
            "face_count": face_count,
            "run_reverify": run_reverify,
            "confidence": None,
            "distance": None,
        }

    # --- Step 2: Re-verification (optional) ---
    if not run_reverify:
        return {
            "status": "ok",
            "face_count": 1,
            "run_reverify": False,
            "confidence": None,
            "distance": None,
        }

    # Fetch stored embedding
    with get_db(db_path) as (_, cursor):
        cursor.execute(
            "SELECT embedding FROM student_faces WHERE student_id = ?",
            (student_id,),
        )
        row = cursor.fetchone()

    if row is None:
        return {
            "status": "error",
            "face_count": 1,
            "run_reverify": True,
            "message": f"No registered face found for '{student_id}'.",
            "confidence": None,
            "distance": None,
        }

    stored_embedding = bytes_to_embedding(row["embedding"])

    live_encodings = face_recognition.face_encodings(rgb, face_locations)
    if not live_encodings:
        return {
            "status": "error",
            "face_count": 1,
            "run_reverify": True,
            "message": "Could not compute embedding from live frame.",
            "confidence": None,
            "distance": None,
        }

    distance = float(np.linalg.norm(stored_embedding - live_encodings[0]))
    confidence = round(max(0.0, 1.0 - distance), 4)
    is_match = distance < threshold

    status = "ok" if is_match else "identity_mismatch"

    logger.info(
        "proctor_check | student=%s | reverify | distance=%.4f | match=%s",
        student_id, distance, is_match,
    )

    return {
        "status": status,
        "face_count": 1,
        "run_reverify": True,
        "confidence": confidence,
        "distance": round(distance, 4),
    }


# ---------------------------------------------------------------------------
# Quick smoke-test (run this file directly)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys

    init_db()

    if len(sys.argv) == 3:
        action, path = sys.argv[1], sys.argv[2]
        if action == "register":
            print(register_face(path, student_id="demo_student"))
        elif action == "verify":
            print(verify_face(path, student_id="demo_student"))
    else:
        print("Usage:  python face_db.py register <image>")
        print("        python face_db.py verify   <image>")
        print("\nRegistered students:", list_students())