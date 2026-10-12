import io
import os
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import imageio_ffmpeg
import numpy as np
import soundfile as sf
from werkzeug.datastructures import FileStorage

import app as service


def wav_upload(seconds=1, rate=16000, channels=1):
    stream = io.BytesIO()
    sf.write(stream, np.zeros((seconds * rate, channels), dtype=np.float32), rate, format="WAV")
    stream.seek(0)
    return FileStorage(stream=stream, filename="test.wav", content_type="audio/wav")


class AudioTests(unittest.TestCase):
    def test_long_audio_is_limited_and_mixed_to_mono(self):
        waveform = service.load_audio(wav_upload(seconds=35, channels=2))
        self.assertEqual(waveform.shape, (30 * 16000,))
        self.assertEqual(waveform.dtype, np.float32)

    def test_resampling(self):
        waveform = service.load_audio(wav_upload(rate=44100, channels=2))
        self.assertEqual(len(waveform), 16000)

    def test_phone_formats_with_bundled_decoder(self):
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        with tempfile.TemporaryDirectory() as folder:
            source = os.path.join(folder, "source.wav")
            sf.write(source, np.zeros(16000, dtype=np.float32), 16000)
            for extension, codec in [("m4a", "aac"), ("webm", "libopus")]:
                with self.subTest(extension=extension):
                    destination = os.path.join(folder, "test." + extension)
                    subprocess.run([ffmpeg, "-v", "error", "-i", source, "-c:a", codec, destination],
                                   check=True, capture_output=True, timeout=30)
                    with open(destination, "rb") as audio, patch.object(service.shutil, "which", return_value=None):
                        waveform = service.load_audio(FileStorage(stream=audio, filename="test." + extension))
                    self.assertGreaterEqual(len(waveform), 16000)
                    self.assertLess(len(waveform), 18000)

    def test_real_model_classifies_silence(self):
        self.assertFalse(service.yc.MOCK_MODE, "Run with MOCK_MODE=0 to test real inference")
        response = service.app.test_client().post("/analyze", data={"audio": (wav_upload().stream, "test.wav")})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertFalse(response.json["mock"])
        self.assertEqual(response.json["top_category"], "Silence")

    def test_bad_audio_returns_422(self):
        response = service.app.test_client().post("/analyze", data={"audio": (io.BytesIO(b"not audio"), "bad.m4a")})
        self.assertEqual(response.status_code, 422)

    def test_readiness_requires_real_loaded_model(self):
        client = service.app.test_client()
        for loaded, mock, expected in [(True, False, 200), (False, False, 503), (True, True, 503)]:
            with self.subTest(loaded=loaded, mock=mock), \
                    patch.object(service.yc, "model_info", return_value={"loaded": loaded}), \
                    patch.object(service.yc, "MOCK_MODE", mock):
                self.assertEqual(client.get("/health").status_code, expected)


if __name__ == "__main__":
    unittest.main()
