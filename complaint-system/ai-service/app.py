"""
AI Audio Verification microservice (YAMNet).

POST /analyze   multipart/form-data, field "audio"   ->  JSON result (see yamnet_classifier.py)
GET  /health    -> engine info

Run:   python app.py
Test:  MOCK_MODE=1 python app.py      (fake classifier - testing only)
"""

import os
import shutil
import subprocess
import tempfile

import numpy as np
from flask import Flask, jsonify, request

import yamnet_classifier as yc

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024

TARGET_SR = 16000
MAX_SECONDS = 30  # analyse at most the first 30 s of a clip


def _decode_with_ffmpeg(path: str) -> np.ndarray:
    """Fallback decoder for formats libsndfile can't read (webm/opus, m4a, some mp3...)."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        try:
            import imageio_ffmpeg
            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            ffmpeg = None
    if ffmpeg:
        try:
            proc = subprocess.run(
                [ffmpeg, "-nostdin", "-v", "error", "-i", path, "-t", str(MAX_SECONDS), "-ac", "1", "-ar", str(TARGET_SR),
                 "-f", "f32le", "-"],
                capture_output=True, timeout=60,
            )
            if proc.returncode == 0 and len(proc.stdout) > 0:
                return np.frombuffer(proc.stdout, dtype=np.float32).copy()
        except Exception:
            pass

    # High-quality fallback using librosa (always resamples to TARGET_SR mono float32)
    try:
        import librosa
        y, _ = librosa.load(path, sr=TARGET_SR, mono=True, duration=MAX_SECONDS)
        return y.astype(np.float32)
    except Exception as exc:
        raise RuntimeError(f"Could not decode audio: {exc}")


def load_audio(file_storage) -> np.ndarray:
    """Load an uploaded clip -> mono float32 at 16 kHz."""
    import soundfile as sf

    ext = os.path.splitext(file_storage.filename or "")[1] or ".wav"
    # mkstemp + close (NamedTemporaryFile can't be reopened on Windows while still open)
    fd, path = tempfile.mkstemp(suffix=ext)
    os.close(fd)
    try:
        file_storage.save(path)
        try:
            with sf.SoundFile(path) as source:
                # Bound memory before decoding; browser recordings already use 16 kHz.
                if source.samplerate == TARGET_SR:
                    wav = source.read(frames=TARGET_SR * MAX_SECONDS, dtype="float32", always_2d=True)
                    return wav.mean(axis=1, dtype=np.float32)
        except Exception:
            pass
        return _decode_with_ffmpeg(path)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


@app.route("/", methods=["GET", "POST"])
def index():
    if request.method == "POST":
        return analyze()
    return jsonify({"status": "ok", "service": "AI Audio Verification microservice (YAMNet)", **yc.model_info()})


@app.route("/health", methods=["GET"])
def health():
    info = yc.model_info()
    ready = info["loaded"] and not yc.MOCK_MODE
    return jsonify({"status": "ok" if ready else "unavailable", **info}), 200 if ready else 503


@app.route("/warmup", methods=["GET"])
def warmup():
    """
    Pre-load the model.  Called by the backend at startup and by Render health
    checks so the worker is ready before the first real request arrives.
    """
    if not yc.MOCK_MODE:
        try:
            yc.load_model()
        except Exception as exc:
            return jsonify({"status": "error", "message": str(exc), **yc.model_info()}), 500
    return jsonify({"status": "ok", "message": "model ready", **yc.model_info()})


@app.route("/analyze", methods=["POST"])
def analyze():
    import gc
    if "audio" not in request.files:
        return jsonify({"error": "No 'audio' file provided"}), 400
    try:
        waveform = load_audio(request.files["audio"])
    except Exception as exc:
        return jsonify({"error": f"Could not process audio: {exc}"}), 422
    if len(waveform) < 1600:  # < 0.1 s
        return jsonify({"error": "Audio clip is empty or too short"}), 422
    try:
        res = yc.classify_audio(waveform, TARGET_SR)
        gc.collect()
        return jsonify(res)
    except Exception as exc:
        gc.collect()
        return jsonify({"error": f"Classification failed: {exc}"}), 500


# Warm up model on startup so the first user request is responsive
if not yc.MOCK_MODE:
    try:
        yc.load_model()
        print("YAMNet model loaded successfully.")
    except Exception as _e:
        print(f"Notice: Model will load on demand ({_e})")

if __name__ == "__main__":
    if yc.MOCK_MODE:
        print("*** MOCK_MODE=1: results are FAKE. Do not use for real verification. ***")
    port = int(os.environ.get("PORT", os.environ.get("AI_SERVICE_PORT", 5001)))
    host = os.environ.get("HOST", "0.0.0.0")
    print(f"Starting AI service on http://{host}:{port}")
    app.run(host=host, port=port, debug=False, threaded=False)
