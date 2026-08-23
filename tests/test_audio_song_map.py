import importlib.util
import pathlib
import sys
import tempfile
import types
import unittest
from unittest import mock

import numpy as np


AUDIO_NODE_PATH = pathlib.Path(__file__).parents[1] / "nodes" / "audio"
PACKAGE_NAME = "fl_audio_song_map_tests"
package = types.ModuleType(PACKAGE_NAME)
package.__path__ = [str(AUDIO_NODE_PATH)]
sys.modules[PACKAGE_NAME] = package
MODULE_PATH = AUDIO_NODE_PATH / "audio_song_map.py"
SPEC = importlib.util.spec_from_file_location(f"{PACKAGE_NAME}.audio_song_map", MODULE_PATH)
song_map = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = song_map
SPEC.loader.exec_module(song_map)


def bars(energy, onset=None):
    onset = onset or [1.0] * len(energy)
    return [
        {
            "start": float(index),
            "end": float(index + 1),
            "energy_mean": float(value),
            "energy_peak": float(value),
            "onset_density": float(onset[index]),
        }
        for index, value in enumerate(energy)
    ]


class AudioSongMapTests(unittest.TestCase):
    def test_detects_bar_aligned_build_drop_and_breakdown(self):
        profiles = bars(
            [0.05, 0.12, 0.25, 0.58, 0.62, 0.13, 0.11, 0.12],
            [0.2, 0.4, 0.8, 1.5, 1.6, 0.05, 0.04, 0.05],
        )

        moments = song_map.detect_moments(profiles)

        self.assertIn("build", {moment["type"] for moment in moments})
        self.assertIn("drop", {moment["type"] for moment in moments})
        self.assertIn("breakdown", {moment["type"] for moment in moments})
        drop = next(moment for moment in moments if moment["type"] == "drop")
        self.assertEqual(drop["anchor"], 3.0)

    def test_flat_energy_does_not_invent_dynamic_moments(self):
        self.assertEqual(song_map.detect_moments(bars([0.4] * 12)), [])

    def test_detects_conservative_same_family_turnaround(self):
        profiles = bars(
            [0.5, 0.5, 0.64, 0.64, 0.51, 0.5, 0.5, 0.5],
            [1.0, 1.0, 1.8, 1.8, 1.0, 1.0, 1.0, 1.0],
        )
        sections = [
            {"id": "section-0", "family": "A"},
            {"id": "section-1", "family": "A"},
        ]
        phrases = [
            {"section_id": "section-0", "start": 0.0, "end": 4.0},
            {"section_id": "section-1", "start": 4.0, "end": 8.0},
        ]

        turnarounds = song_map.detect_turnarounds(profiles, sections, phrases, [])

        self.assertEqual(len(turnarounds), 1)
        self.assertEqual(turnarounds[0]["type"], "turnaround")
        self.assertEqual((turnarounds[0]["start"], turnarounds[0]["end"]), (2.0, 4.0))
        self.assertEqual(turnarounds[0]["source"], "analysis")

    def test_turnaround_rejects_new_family_energy_changes_and_stronger_moments(self):
        profiles = bars(
            [0.5, 0.5, 0.64, 0.64, 0.51, 0.5, 0.5, 0.5],
            [1.0, 1.0, 1.8, 1.8, 1.0, 1.0, 1.0, 1.0],
        )
        phrases = [
            {"section_id": "section-0", "start": 0.0, "end": 4.0},
            {"section_id": "section-1", "start": 4.0, "end": 8.0},
        ]
        different = [
            {"id": "section-0", "family": "A"},
            {"id": "section-1", "family": "B"},
        ]
        same = [
            {"id": "section-0", "family": "A"},
            {"id": "section-1", "family": "A"},
        ]
        drop = [{"type": "drop", "start": 3.0, "end": 3.0}]

        self.assertEqual(song_map.detect_turnarounds(profiles, different, phrases, []), [])
        self.assertEqual(song_map.detect_turnarounds(profiles, same, phrases, drop), [])
        changed = bars(
            [0.5, 0.5, 0.64, 0.64, 0.8, 0.8, 0.8, 0.8],
            [1.0, 1.0, 1.8, 1.8, 1.0, 1.0, 1.0, 1.0],
        )
        self.assertEqual(song_map.detect_turnarounds(changed, same, phrases, []), [])

    def test_short_sections_are_merged_at_bar_boundaries(self):
        features = np.asarray([
            [0, 0, 1, 1, 2, 2, 3, 3],
            [0, 0, 1, 1, 2, 2, 3, 3],
        ], dtype=np.float32)

        boundaries = song_map._section_boundaries(features, duration=150, bar_count=8)

        self.assertEqual(boundaries[0], 0)
        self.assertEqual(boundaries[-1], 8)
        self.assertTrue(all(
            end - start >= song_map._MIN_SECTION_BARS
            for start, end in zip(boundaries[:-1], boundaries[1:])
        ))

    def test_repeated_high_energy_family_gets_conservative_song_roles(self):
        def section(family, energy, trend="steady", start=0, end=4):
            return {
                "family": family,
                "start": float(start),
                "end": float(end),
                "bar_start": start,
                "bar_end": end,
                "energy": {"mean": energy, "trend": trend},
            }

        sections = [
            section("A", 0.1, start=0, end=4),
            section("B", 0.45, "rising", 4, 8),
            section("C", 0.8, start=8, end=16),
            section("D", 0.5, start=16, end=24),
            section("C", 0.78, start=24, end=32),
            section("E", 0.15, "falling", 32, 36),
        ]

        song_map._assign_roles(sections, [])

        self.assertEqual(sections[0]["role"]["value"], "intro")
        self.assertEqual(sections[1]["role"]["value"], "pre_chorus")
        self.assertEqual(sections[2]["role"]["value"], "chorus")
        self.assertEqual(sections[4]["role"]["value"], "chorus")
        self.assertEqual(sections[-1]["role"]["value"], "outro")

    def test_song_map_schema_covers_the_full_source(self):
        sample_rate = 8000
        duration = 8
        time = np.arange(sample_rate * duration, dtype=np.float32) / sample_rate
        waveform = 0.15 * np.sin(2 * np.pi * 220 * time)
        waveform *= np.linspace(0.2, 1.0, len(waveform), dtype=np.float32)
        analysis = {
            "beat_times": [value / 2 for value in range(16)],
            "downbeat_times": [0.0, 2.0, 4.0, 6.0],
            "detected_downbeat_confidences": [0.9] * 4,
        }

        result = song_map.analyze_song_map(waveform, sample_rate, analysis)

        self.assertEqual(result["type"], "fl_audio_song_map")
        self.assertEqual(result["version"], 2)
        self.assertEqual(result["meter"]["beats_per_bar"], 4)
        self.assertGreaterEqual(len(result["sections"]), 1)
        self.assertEqual(result["sections"][0]["start"], 0.0)
        self.assertAlmostEqual(result["sections"][-1]["end"], duration)
        self.assertGreaterEqual(len(result["energy_preview"]["values"]), duration * 10)

    def test_file_analysis_reuses_the_versioned_song_map_cache(self):
        cached_value = {
            "type": "fl_audio_song_map",
            "version": 2,
            "source_duration": 1.0,
            "sections": [],
            "phrases": [],
            "moments": [],
        }
        with tempfile.TemporaryDirectory() as directory:
            cache_path = pathlib.Path(directory) / "song-map.json"
            with (
                mock.patch.object(song_map, "resolve_audio_path", return_value=pathlib.Path("song.wav")),
                mock.patch.object(song_map, "song_map_cache_key", return_value="a" * 64),
                mock.patch.object(song_map, "_cache_path", return_value=cache_path),
                mock.patch.object(
                    song_map,
                    "load_audio_file",
                    return_value=(pathlib.Path("song.wav"), {"sample_rate": 100}),
                ) as load,
                mock.patch.object(song_map, "mono_numpy", return_value=np.zeros(100)),
                mock.patch.object(song_map, "analyze_song_map", return_value=cached_value) as analyze,
            ):
                first = song_map.analyze_song_map_file("song.wav", {})
                second = song_map.analyze_song_map_file("song.wav", {})

        self.assertFalse(first["analysis_cache_hit"])
        self.assertTrue(second["analysis_cache_hit"])
        self.assertEqual(first["cache_key"], "a" * 64)
        load.assert_called_once()
        analyze.assert_called_once()


if __name__ == "__main__":
    unittest.main()
