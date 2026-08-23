import json
import importlib.util
import pathlib
import sys
import threading
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import torch


AUDIO_NODE_PATH = pathlib.Path(__file__).parents[1] / "nodes" / "audio"
sys.path.insert(0, str(pathlib.Path(__file__).parents[3]))
PACKAGE_NAME = "fl_audio_transcription_tests"
package = types.ModuleType(PACKAGE_NAME)
package.__path__ = [str(AUDIO_NODE_PATH)]
sys.modules[PACKAGE_NAME] = package
MODULE_PATH = AUDIO_NODE_PATH / "audio_transcription.py"
SPEC = importlib.util.spec_from_file_location(f"{PACKAGE_NAME}.audio_transcription", MODULE_PATH)
transcription = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = transcription
SPEC.loader.exec_module(transcription)


class AudioTranscriptionTests(unittest.TestCase):
    def test_cache_keys_cover_source_model_and_language(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "song.wav"
            path.write_bytes(b"audio")
            mix = transcription.transcription_cache_key(path, "mix", "small", "auto")
            vocals = transcription.transcription_cache_key(path, "vocals", "small", "auto")
            english = transcription.transcription_cache_key(path, "mix", "small", "en")
            turbo = transcription.transcription_cache_key(path, "mix", "large-v3-turbo", "auto")
            self.assertEqual(len({mix, vocals, english, turbo}), 4)

    def test_auto_source_prefers_cached_vocals(self):
        with patch.object(transcription, "separation_manifest", return_value=None):
            self.assertEqual(transcription.resolve_transcription_source("song.wav", "auto"), "mix")
        with patch.object(transcription, "separation_manifest", return_value={"stems": []}):
            self.assertEqual(transcription.resolve_transcription_source("song.wav", "auto"), "vocals")

    def test_explicit_vocals_require_separation(self):
        with patch.object(transcription, "separation_manifest", return_value=None):
            with self.assertRaisesRegex(ValueError, "Separate stems first"):
                transcription.resolve_transcription_source("song.wav", "vocals")

    def test_word_grouping_uses_gaps_punctuation_and_limits(self):
        segments = transcription._group_words([
            {"start": 0.0, "end": 0.4, "text": "Hello"},
            {"start": 0.5, "end": 0.9, "text": "world."},
            {"start": 2.0, "end": 2.4, "text": "New"},
            {"start": 2.5, "end": 2.9, "text": "line"},
        ])
        self.assertEqual([segment["text"] for segment in segments], ["Hello world.", "New line"])
        self.assertEqual(segments[1]["start"], 2.0)
        self.assertEqual(segments[0]["origin"], "asr")

    def test_chunk_overlap_discards_duplicate_words(self):
        result = {
            "chunks": [
                {"text": "old", "timestamp": (0.1, 0.4)},
                {"text": "new", "timestamp": (1.2, 1.5)},
            ]
        }
        words = transcription._chunk_words(result, 10, 15, 11)
        self.assertEqual([word["text"] for word in words], ["new"])
        self.assertAlmostEqual(words[0]["start"], 11.2)

    def test_word_deduplication_removes_overlap_repeats(self):
        words = transcription._deduplicate_words([
            {"start": 27.1, "end": 27.5, "text": "fire"},
            {"start": 27.2, "end": 27.6, "text": "Fire"},
            {"start": 27.7, "end": 28.0, "text": "again"},
        ])
        self.assertEqual([word["text"] for word in words], ["fire", "again"])

    def test_direct_whisper_inference_bypasses_torchcodec_pipeline(self):
        class Processor:
            feature_extractor = types.SimpleNamespace(chunk_length=30)

            class Tokenizer:
                def _decode_asr(self, outputs, return_timestamps, return_language, time_precision):
                    self.outputs = outputs
                    self.return_timestamps = return_timestamps
                    self.return_language = return_language
                    self.time_precision = time_precision
                    return "Open your eyes", {
                        "chunks": [{
                            "text": "Open",
                            "timestamp": (0.0, 0.4),
                            "language": "english",
                        }],
                    }

            tokenizer = Tokenizer()

            def __call__(self, waveform, **kwargs):
                self.waveform = waveform
                self.kwargs = kwargs
                return {
                    "input_features": torch.ones(1, 80, 10),
                    "attention_mask": torch.ones(1, 10, dtype=torch.long),
                }

        class Model:
            config = types.SimpleNamespace(max_source_positions=1500)
            generation_config = types.SimpleNamespace(lang_to_id={"<|en|>": 50259})

            def detect_language(self, **kwargs):
                self.detect_kwargs = kwargs
                return torch.tensor([50259])

            def generate(self, **kwargs):
                self.kwargs = kwargs
                return {
                    "sequences": torch.tensor([[1, 2, 3]]),
                    "token_timestamps": torch.tensor([[0.0, 0.2, 0.4]]),
                }

        processor = Processor()
        model = Model()
        result = transcription._transcribe_chunk(
            model,
            processor,
            torch.ones(16000).numpy(),
            torch.device("cpu"),
            torch.float32,
            "en",
        )

        self.assertEqual(result["text"], "Open your eyes")
        self.assertEqual(result["chunks"][0]["language"], "english")
        self.assertEqual(model.kwargs["language"], "en")
        self.assertTrue(model.kwargs["return_token_timestamps"])
        self.assertEqual(processor.tokenizer.return_timestamps, "word")
        self.assertEqual(processor.tokenizer.time_precision, 0.02)

        result = transcription._transcribe_chunk(
            model,
            processor,
            torch.ones(16000).numpy(),
            torch.device("cpu"),
            torch.float32,
            "auto",
        )
        self.assertEqual(result["language"], "en")
        self.assertEqual(model.kwargs["language"], "en")
        self.assertIn("input_features", model.detect_kwargs)

    def test_transcription_module_does_not_use_transformers_pipeline(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertNotIn("pipeline(", source)
        self.assertNotIn("import pipeline", source)

    def test_cached_transcript_validation(self):
        with TemporaryDirectory() as directory, patch.object(
            transcription.folder_paths,
            "get_user_directory",
            return_value=directory,
        ):
            key = "a" * 64
            path = transcription._cache_path(key)
            path.write_text(json.dumps({"version": 1, "segments": []}), encoding="utf-8")
            self.assertEqual(transcription.load_cached_transcript(key)["segments"], [])
            path.write_text("bad", encoding="utf-8")
            self.assertIsNone(transcription.load_cached_transcript(key))
            with self.assertRaisesRegex(ValueError, "invalid"):
                transcription.load_cached_transcript("../bad")

    def test_cancelled_request_stops_before_model_loading(self):
        cancelled = threading.Event()
        cancelled.set()
        with patch.object(transcription, "resolve_audio_path", return_value=Path(__file__)), \
             patch.object(transcription, "resolve_transcription_source", return_value="mix"), \
             patch.object(transcription, "transcription_cache_key", return_value="b" * 64), \
             patch.object(transcription, "load_cached_transcript", return_value=None), \
             patch.object(transcription, "_ensure_model") as ensure:
            with self.assertRaises(transcription.TranscriptionCancelled):
                transcription.transcribe_audio_file("song.wav", cancel_event=cancelled)
            ensure.assert_not_called()

    def test_mono_resampling_accepts_comfy_audio(self):
        audio = {"waveform": torch.ones(1, 2, 8000), "sample_rate": 8000}
        result = transcription._mono_resampled(audio)
        self.assertEqual(result.ndim, 1)
        self.assertEqual(len(result), 16000)


if __name__ == "__main__":
    unittest.main()
