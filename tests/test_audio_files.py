import importlib.util
import pathlib
import tempfile
import unittest
from unittest import mock

import soundfile
import torch


MODULE_PATH = pathlib.Path(__file__).parents[1] / "nodes" / "audio" / "audio_files.py"
SPEC = importlib.util.spec_from_file_location("fl_audio_files_tests", MODULE_PATH)
audio_files = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audio_files)


class AudioFilesTests(unittest.TestCase):
    def tearDown(self):
        audio_files._audio_file_hash.cache_clear()

    def test_audio_library_recursively_lists_supported_media(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            nested = root / "album" / "stems"
            nested.mkdir(parents=True)
            (root / "song.wav").write_bytes(b"wave")
            (nested / "drums.mp3").write_bytes(b"mp3")
            (nested / "notes.txt").write_text("ignore", encoding="utf-8")

            with mock.patch.object(
                audio_files.folder_paths,
                "get_input_directory",
                return_value=directory,
            ):
                files = audio_files.available_audio_files()
                entries = audio_files.audio_library_entries()

        self.assertEqual(files, ["album/stems/drums.mp3", "song.wav"])
        self.assertEqual(
            [(entry["path"], entry["folder"]) for entry in entries],
            [("album/stems/drums.mp3", "album/stems"), ("song.wav", "")],
        )
        self.assertTrue(all(entry["size"] > 0 for entry in entries))

    def test_audio_hash_reuses_unchanged_file_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "song.wav"
            path.write_bytes(b"first version")
            with mock.patch("builtins.open", wraps=open) as open_file:
                first = audio_files.audio_file_hash(path)
                second = audio_files.audio_file_hash(path)

            self.assertEqual(first, second)
            self.assertEqual(open_file.call_count, 1)

            path.write_bytes(b"second version with a different size")
            third = audio_files.audio_file_hash(path)

        self.assertNotEqual(first, third)

    def test_audio_range_matches_full_decode(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "song.wav"
            waveform = torch.linspace(-1.0, 1.0, 96000).reshape(48000, 2).numpy()
            soundfile.write(path, waveform, 48000, subtype="FLOAT")
            with mock.patch.object(
                audio_files,
                "resolve_audio_path",
                return_value=path,
            ):
                _, full = audio_files.load_audio_file("song.wav")
                _, cropped = audio_files.load_audio_file_range(
                    "song.wav",
                    12000,
                    24000,
                )

        self.assertTrue(
            torch.equal(
                cropped["waveform"],
                full["waveform"][..., 12000:36000],
            )
        )


if __name__ == "__main__":
    unittest.main()
