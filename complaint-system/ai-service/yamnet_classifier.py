"""
YAMNet-based audio verification for the Residential Complaint Management System.

HOW IT WORKS
------------
1. The clip is resampled to 16 kHz mono (done in app.py).
2. It is cut into 0.975-second windows every 0.5 s. Each window goes through the
   real YAMNet network, which returns a score (0-1) for each of 521 AudioSet sounds.
3. Because complaint clips are usually short bursts (a few barks, a bang, someone
   shouting) with quiet gaps in between, we do NOT average the whole clip - that
   lets the quiet parts "win" and a dog-barking clip gets labelled "Silence".
   Instead we score every window, ignore the silent ones, and for each complaint
   category take the strongest windows.
4. YAMNet labels are mapped to complaint categories by EXACT label name (the
   previous substring matching mis-fired, e.g. "Music" matched dozens of labels).
5. Loudness is measured on the non-silent part of the clip only.

MODEL
-----
The YAMNet model (Apache-2.0, Google) is bundled in ./models/yamnet.tflite together
with its class map, so no TensorFlow Hub download or internet access is needed and
the install is small. Set YAMNET_MODEL_PATH to use a different .tflite file.

MOCK_MODE=1 skips the neural network completely (testing only - results are fake).
"""

import os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.environ.get("YAMNET_MODEL_PATH", os.path.join(HERE, "models", "yamnet.tflite"))
CLASS_MAP_PATH = os.environ.get("YAMNET_CLASS_MAP_PATH", os.path.join(HERE, "models", "yamnet_class_map.txt"))
MOCK_MODE = os.environ.get("MOCK_MODE", "0") == "1"

WINDOW = 15600  # 0.975 s at 16 kHz - fixed input size of YAMNet
HOP = 8000      # 0.5 s
SILENCE_LABEL = "Silence"

# Complaint category  ->  exact YAMNet (AudioSet) labels that count as evidence for it.
CATEGORY_LABELS = {
    "Dog Barking": ["Dog", "Bark", "Yip", "Howl", "Bow-wow", "Growling", "Whimper (dog)", "Canidae, dogs, wolves"],
    "Shouting": ["Shout", "Yell", "Bellow", "Whoop", "Screaming", "Children shouting"],
    "Loud Music": [
        "Music", "Musical instrument", "Drum kit", "Drum machine", "Bass drum", "Snare drum",
        "Guitar", "Electric guitar", "Bass guitar", "Keyboard (musical)", "Pop music", "Hip hop music",
        "Rock music", "Disco", "Electronic music", "House music", "Techno", "Dance music",
        "Electronic dance music", "Singing", "Song", "Music of Bollywood", "Music of Latin America",
        "Music of Asia", "Carnatic music", "Folk music", "Classical music", "Vocal music",
    ],
    "Construction Noise": [
        "Hammer", "Jackhammer", "Drill", "Power tool", "Sawing", "Chainsaw", "Sanding",
        "Filing (rasp)", "Tools", "Dental drill, dentist's drill", "Lawn mower",
    ],
    "Crying": ["Crying, sobbing", "Baby cry, infant cry", "Wail, moan", "Whimper"],
    "Banging / Slamming": ["Slam", "Bang", "Thump, thud", "Smash, crash", "Clatter", "Whack, thwack", "Boom"],
    "Party / Crowd Noise": ["Crowd", "Hubbub, speech noise, speech babble", "Cheering", "Applause"],
}

# Broad parent labels that say little by themselves.
GENERIC_LABELS = {"Animal", "Domestic animals, pets", "Speech", "Inside, small room", "Vehicle", "Engine", "Tools"}

# Minimum category score for us to name a category at all (otherwise "Other").
MIN_CATEGORY_SCORE = 0.15

_interpreter = None
_input_index = None
_output_index = None
_class_names = None
_label_to_index = None


def load_model():
    """Load the bundled YAMNet tflite model once (called at service start-up)."""
    global _interpreter, _input_index, _output_index, _class_names, _label_to_index
    if _interpreter is not None:
        return

    if not os.path.exists(MODEL_PATH):
        raise FileNotFoundError(f"YAMNet model not found at {MODEL_PATH}")
    with open(CLASS_MAP_PATH, encoding="utf-8") as f:
        _class_names = [line.strip() for line in f if line.strip()]
    if len(_class_names) != 521:
        raise ValueError(f"Expected 521 YAMNet class names, found {len(_class_names)}")
    _label_to_index = {name: i for i, name in enumerate(_class_names)}

    try:
        from ai_edge_litert.interpreter import Interpreter
    except ImportError:
        try:
            from tflite_runtime.interpreter import Interpreter
        except ImportError:
            from tensorflow.lite.python.interpreter import Interpreter

    interp = Interpreter(model_path=MODEL_PATH)
    interp.allocate_tensors()
    _input_index = interp.get_input_details()[0]["index"]
    _output_index = interp.get_output_details()[0]["index"]
    _interpreter = interp

    # Sanity check: every label we rely on must exist in the class map.
    missing = [l for labels in CATEGORY_LABELS.values() for l in labels if l not in _label_to_index]
    if missing:
        print(f"[yamnet] WARNING: labels not in class map (ignored): {missing}")


def model_info():
    return {
        "engine": "mock" if MOCK_MODE else "YAMNet (tflite)",
        "model_path": None if MOCK_MODE else MODEL_PATH,
        "loaded": MOCK_MODE or _interpreter is not None,
        "categories": list(CATEGORY_LABELS.keys()),
    }


def _frame_scores(waveform: np.ndarray) -> np.ndarray:
    """Run YAMNet over sliding windows -> array [n_windows, 521]."""
    if len(waveform) < WINDOW:
        waveform = np.pad(waveform, (0, WINDOW - len(waveform)))
    out = []
    for start in range(0, len(waveform) - WINDOW + 1, HOP):
        chunk = waveform[start:start + WINDOW].astype(np.float32)
        _interpreter.set_tensor(_input_index, chunk)
        _interpreter.invoke()
        out.append(_interpreter.get_tensor(_output_index)[0].copy())
    return np.array(out)


def _window_rms(waveform: np.ndarray) -> np.ndarray:
    if len(waveform) < WINDOW:
        waveform = np.pad(waveform, (0, WINDOW - len(waveform)))
    vals = []
    for start in range(0, len(waveform) - WINDOW + 1, HOP):
        chunk = waveform[start:start + WINDOW]
        vals.append(float(np.sqrt(np.mean(np.square(chunk)))))
    return np.array(vals)


def _noise_level(active_rms: float):
    """
    Relative loudness of the non-silent part of the recording.
    NOTE: phone/laptop microphones are not calibrated, so this is a RELATIVE level
    (dBFS), not a true decibel-SPL reading. Thresholds are starting points - tune them
    with recordings from your own building.
    """
    db = 20 * np.log10(max(active_rms, 1e-6))
    if active_rms < 0.02:
        level = "LOW"
    elif active_rms < 0.08:
        level = "MEDIUM"
    else:
        level = "HIGH"
    return level, round(float(db), 1)


def _top_k_mean(values: np.ndarray, k: int = 2) -> float:
    if len(values) == 0:
        return 0.0
    k = min(k, len(values))
    return float(np.sort(values)[-k:].mean())


def classify_audio(waveform: np.ndarray, sample_rate: int = 16000) -> dict:
    """
    waveform: 1-D float32 mono array at 16 kHz.
    Returns {
      top_category, confidence, noise_level, noise_db_relative,
      active_fraction, top_predictions: [{label, score}], category_scores: {...}, mock
    }
    """
    if sample_rate != 16000:
        raise ValueError("classify_audio expects 16 kHz audio")

    rms_windows = _window_rms(waveform)

    if MOCK_MODE:
        overall = float(np.sqrt(np.mean(np.square(waveform)))) if len(waveform) else 0.0
        level, db = _noise_level(overall)
        if overall < 0.01:
            cat, conf = "Silence", 0.85
        else:
            options = [("Dog Barking", 0.78), ("Loud Music", 0.71), ("Shouting", 0.66), ("Construction Noise", 0.74)]
            cat, conf = options[int(overall * 1000) % len(options)]
        return {"top_category": cat, "confidence": conf, "noise_level": level, "noise_db_relative": db,
                "active_fraction": 1.0, "top_predictions": [{"label": cat, "score": conf}],
                "category_scores": {}, "mock": True}

    load_model()
    scores = _frame_scores(waveform)                      # [n, 521]
    n = len(scores)
    silence_idx = _label_to_index[SILENCE_LABEL]
    silence_score = scores[:, silence_idx]

    # A window is "active" if YAMNet doesn't think it's silence AND it isn't electrically quiet.
    active = (silence_score < 0.5) & (rms_windows[:n] > 0.003)
    active_fraction = float(active.mean())

    # Loudness measured only on the part of the clip where something is actually happening.
    if active.any():
        active_rms = float(np.sqrt(np.mean(np.square(rms_windows[:n][active]))))
    else:
        active_rms = float(np.sqrt(np.mean(np.square(rms_windows[:n])))) if n else 0.0
    level, db = _noise_level(active_rms)

    # Nothing happening in the clip -> Silence (admin will review manually).
    if not active.any():
        return {
            "top_category": "Silence", "confidence": round(float(silence_score.mean()), 3),
            "noise_level": "LOW", "noise_db_relative": db, "active_fraction": 0.0,
            "top_predictions": [{"label": SILENCE_LABEL, "score": round(float(silence_score.mean()), 3)}],
            "category_scores": {}, "mock": False,
        }

    act = scores[active]                                   # only the non-silent windows

    category_scores = {}
    for cat, labels in CATEGORY_LABELS.items():
        idxs = [_label_to_index[l] for l in labels if l in _label_to_index]
        per_window = act[:, idxs].max(axis=1)              # best matching label per window
        category_scores[cat] = round(_top_k_mean(per_window, 2), 3)

    # Raw top labels (strongest window per label), for the "AI evidence report".
    raw = act.max(axis=0)
    raw[silence_idx] = 0.0
    top_idx = raw.argsort()[-5:][::-1]
    top_predictions = [{"label": _class_names[i], "score": round(float(raw[i]), 3)} for i in top_idx]

    best_cat = max(category_scores, key=category_scores.get)
    best_score = category_scores[best_cat]
    mapped = {l for labels in CATEGORY_LABELS.values() for l in labels}
    strongest = top_predictions[0]
    # If a clearly stronger sound exists that is NOT one of our complaint categories
    # (e.g. a siren or rain), don't force a wrong category - report "Other".
    outranked = strongest["label"] not in mapped and strongest["score"] > best_score + 0.2 \
        and strongest["label"] not in GENERIC_LABELS
    if best_score >= MIN_CATEGORY_SCORE and not outranked:
        top_category, confidence = best_cat, best_score
    else:
        top_category, confidence = "Other", top_predictions[0]["score"]

    return {
        "top_category": top_category,
        "confidence": round(float(confidence), 3),
        "noise_level": level,
        "noise_db_relative": db,
        "active_fraction": round(active_fraction, 2),
        "top_predictions": top_predictions,
        "category_scores": category_scores,
        "mock": False,
    }
