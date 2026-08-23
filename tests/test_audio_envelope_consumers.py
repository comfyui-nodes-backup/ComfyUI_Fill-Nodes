import importlib
import inspect
import pathlib
import sys
import types
import unittest

import torch
import torch.nn.functional as F


NODES_PATH = pathlib.Path(__file__).parents[1] / "nodes"
PACKAGE_NAME = "fl_audio_envelope_consumer_tests"
PACKAGE = types.ModuleType(PACKAGE_NAME)
PACKAGE.__path__ = [str(NODES_PATH)]
sys.modules.setdefault(PACKAGE_NAME, PACKAGE)
for child in ("audio", "vfx"):
    module = types.ModuleType(f"{PACKAGE_NAME}.{child}")
    module.__path__ = [str(NODES_PATH / child)]
    sys.modules.setdefault(module.__name__, module)


CONSUMERS = (
    ("audio.FL_Audio_Envelope_Visualizer", "FL_Audio_Envelope_Visualizer"),
    ("audio.FL_Audio_Reactive_Brightness", "FL_Audio_Reactive_Brightness"),
    ("audio.FL_Audio_Reactive_Edge_Glow", "FL_Audio_Reactive_Edge_Glow"),
    ("audio.FL_Audio_Reactive_Saturation", "FL_Audio_Reactive_Saturation"),
    ("audio.FL_Audio_Reactive_Scale", "FL_Audio_Reactive_Scale"),
    ("audio.FL_Audio_Reactive_Speed", "FL_Audio_Reactive_Speed"),
    ("vfx.FL_Ascii", "FL_Ascii"),
    ("vfx.FL_Glitch", "FL_Glitch"),
    ("vfx.FL_Image_Pixelator", "FL_ImagePixelator"),
    ("vfx.FL_PaperDrawn", "FL_PaperDrawn"),
    ("vfx.FL_PixelArt", "FL_PixelArtShader"),
    ("vfx.FL_Ripple", "FL_Ripple"),
    ("vfx.FL_InfiniteZoom", "FL_InfiniteZoom"),
)


def load(module_name, class_name):
    module = importlib.import_module(f"{PACKAGE_NAME}.{module_name}")
    return getattr(module, class_name)


def envelope(values):
    return {
        "type": "fl_audio_envelope",
        "version": 1,
        "fps": 24.0,
        "duration": len(values) / 24,
        "total_frames": len(values),
        "source": "beat_grid",
        "values": values,
    }


class AudioEnvelopeConsumerTests(unittest.TestCase):
    def test_all_consumers_expose_the_custom_envelope_socket(self):
        for module_name, class_name in CONSUMERS:
            with self.subTest(class_name=class_name):
                node = load(module_name, class_name)
                inputs = node.INPUT_TYPES()
                sockets = {**inputs.get("required", {}), **inputs.get("optional", {})}
                self.assertIn("envelope", sockets)
                self.assertEqual(sockets["envelope"][0], "FL_AUDIO_ENVELOPE")
                function = getattr(node, node.FUNCTION)
                self.assertIn("envelope", inspect.signature(function).parameters)

    def test_visualizer_matches_uniform_grayscale_frames(self):
        node = load(
            "audio.FL_Audio_Envelope_Visualizer",
            "FL_Audio_Envelope_Visualizer",
        )()
        frames = node.visualize_envelope(
            envelope([0.0, 0.5, 1.0]),
            width=64,
            height=64,
        )[0]

        self.assertEqual(tuple(frames.shape), (3, 64, 64, 3))
        self.assertTrue(torch.all(frames[0] == 0))
        self.assertTrue(torch.all(frames[1] == 0.5))
        self.assertTrue(torch.all(frames[2] == 1))

    def test_audio_effect_reads_typed_values(self):
        node = load(
            "audio.FL_Audio_Reactive_Brightness",
            "FL_Audio_Reactive_Brightness",
        )()
        frames = torch.full((2, 4, 4, 3), 0.5)
        result = node.apply_brightness(
            frames,
            envelope([0.0, 1.0]),
            brightness_intensity=0.2,
        )[0]

        self.assertTrue(torch.allclose(result[0], torch.full_like(result[0], 0.5)))
        self.assertTrue(torch.allclose(result[1], torch.full_like(result[1], 0.6)))

    def test_vectorized_saturation_matches_per_frame_math(self):
        node = load(
            "audio.FL_Audio_Reactive_Saturation",
            "FL_Audio_Reactive_Saturation",
        )()
        frames = torch.rand((4, 8, 8, 3))
        values = [0.0, 0.25, 0.5, 1.0]
        result = node.apply_saturation(
            frames,
            envelope(values),
            base_saturation=0.8,
            saturation_intensity=0.4,
        )[0]
        expected = []
        for frame, value in zip(frames, values):
            grayscale = (
                frame[..., 0] * 0.2126
                + frame[..., 1] * 0.7152
                + frame[..., 2] * 0.0722
            ).unsqueeze(-1)
            expected.append(
                (grayscale + (0.8 + value * 0.4) * (frame - grayscale)).clamp(0.0, 1.0)
            )

        self.assertTrue(torch.allclose(result, torch.stack(expected)))

    def test_vectorized_brightness_preserves_mask_blending(self):
        node = load(
            "audio.FL_Audio_Reactive_Brightness",
            "FL_Audio_Reactive_Brightness",
        )()
        frames = torch.full((2, 4, 4, 3), 0.5)
        mask = torch.zeros((2, 4, 4, 3))
        mask[1] = 1.0
        result = node.apply_brightness(
            frames,
            envelope([1.0, 1.0]),
            mask=mask,
            brightness_intensity=0.2,
        )[0]

        self.assertTrue(torch.allclose(result[0], frames[0]))
        self.assertTrue(torch.allclose(result[1], torch.full_like(result[1], 0.6)))

    def test_vectorized_speed_matches_fractional_frame_sampling(self):
        node = load(
            "audio.FL_Audio_Reactive_Speed",
            "FL_Audio_Reactive_Speed",
        )()
        frames = torch.rand((6, 4, 4, 3))
        values = [0.0, 0.25, 0.5, 0.75, 1.0, 0.5]
        result = node.apply_speed(
            frames,
            envelope(values),
            base_speed=0.75,
            speed_intensity=0.5,
            interpolation="bilinear",
        )[0]
        positions = []
        position = 0.0
        for value in values:
            positions.append(min(position, frames.shape[0] - 1.0))
            position += min(3.0, max(0.0, 0.75 + value * 0.5))
        expected = []
        for position in positions:
            low = int(position // 1)
            high = min(frames.shape[0] - 1, low + (position != low))
            blend = position - low
            expected.append(frames[low] * (1.0 - blend) + frames[high] * blend)

        self.assertTrue(torch.allclose(result, torch.stack(expected)))

    def test_vectorized_edge_glow_matches_per_frame_sobel(self):
        node = load(
            "audio.FL_Audio_Reactive_Edge_Glow",
            "FL_Audio_Reactive_Edge_Glow",
        )()
        frames = torch.rand((3, 8, 8, 3))
        values = [0.0, 0.5, 1.0]
        result = node.apply_edge_glow(
            frames,
            envelope(values),
            edge_threshold=0.1,
            glow_intensity=0.5,
            envelope_intensity=1.0,
            glow_color="cyan",
            blend_mode="add",
        )[0]
        sobel_x = torch.tensor([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=frames.dtype).view(1, 1, 3, 3)
        sobel_y = torch.tensor([[-1, -2, -1], [0, 0, 0], [1, 2, 1]], dtype=frames.dtype).view(1, 1, 3, 3)
        expected = []
        for frame, value in zip(frames, values):
            gray = (
                frame[..., 0] * 0.2126
                + frame[..., 1] * 0.7152
                + frame[..., 2] * 0.0722
            ).view(1, 1, 8, 8)
            edges_x = F.conv2d(gray, sobel_x, padding=1)
            edges_y = F.conv2d(gray, sobel_y, padding=1)
            edges = torch.sqrt(edges_x.square() + edges_y.square()).view(8, 8)
            edges = edges / (edges.max() + 1e-8)
            edges = ((edges - 0.1) / 0.9).clamp(0.0, 1.0) * (0.5 + value)
            glow = torch.stack((edges * 0.3, edges, edges), dim=-1)
            expected.append((frame + glow).clamp(0.0, 1.0))

        self.assertTrue(torch.allclose(result, torch.stack(expected)))


if __name__ == "__main__":
    unittest.main()
