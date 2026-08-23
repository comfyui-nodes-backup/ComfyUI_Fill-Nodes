# FL_Audio_Reactive_Edge_Glow: Edge detection with glow based on audio envelope
import torch
import torch.nn.functional as F
from typing import Tuple

from .audio_envelope import load_audio_envelope


def _apply_glow(frames, edges, glow_color, blend_mode):
    if glow_color == "original":
        glow = frames * edges.unsqueeze(-1)
    else:
        colors = {
            "white": (1.0, 1.0, 1.0),
            "cyan": (0.3, 1.0, 1.0),
            "magenta": (1.0, 0.3, 1.0),
            "yellow": (1.0, 1.0, 0.3),
        }
        color = torch.tensor(
            colors.get(glow_color, colors["white"]),
            device=frames.device,
            dtype=frames.dtype,
        )
        glow = edges.unsqueeze(-1) * color

    if blend_mode == "screen":
        output = 1.0 - (1.0 - frames) * (1.0 - glow)
    elif blend_mode == "overlay":
        output = frames * (1.0 + glow)
    else:
        output = frames + glow
    return output.clamp(0.0, 1.0)


class FL_Audio_Reactive_Edge_Glow:
    """
    A ComfyUI node for applying audio-reactive edge detection and glow effect.
    Detects edges and adds glowing outline that pulses with the audio.
    """

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("frames",)
    FUNCTION = "apply_edge_glow"
    CATEGORY = "🏵️Fill Nodes/Audio"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "frames": ("IMAGE", {"description": "Input frames"}),
                "envelope": ("FL_AUDIO_ENVELOPE", {"description": "Frame-aligned FL audio envelope"}),
            },
            "optional": {
                "edge_frames": ("IMAGE", {"description": "Pre-computed edge frames (grayscale/mask). If not provided, edges will be auto-detected."}),
                "edge_threshold": ("FLOAT", {
                    "default": 0.1,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "description": "Edge detection sensitivity (only used if edge_frames not provided)"
                }),
                "glow_intensity": ("FLOAT", {
                    "default": 0.5,
                    "min": 0.0,
                    "max": 2.0,
                    "step": 0.01,
                    "description": "Base glow intensity multiplier"
                }),
                "envelope_intensity": ("FLOAT", {
                    "default": 0.3,
                    "min": 0.0,
                    "max": 2.0,
                    "step": 0.01,
                    "description": "How much envelope affects glow (0 = static, higher = more reactive)"
                }),
                "glow_color": (["white", "original", "cyan", "magenta", "yellow"], {
                    "default": "cyan",
                    "description": "Color of the glow effect"
                }),
                "blend_mode": (["add", "screen", "overlay"], {
                    "default": "add",
                    "description": "How to blend glow with original"
                }),
            }
        }

    def apply_edge_glow(
        self,
        frames: torch.Tensor,
        envelope,
        edge_frames: torch.Tensor = None,
        edge_threshold: float = 0.1,
        glow_intensity: float = 0.5,
        envelope_intensity: float = 0.3,
        glow_color: str = "cyan",
        blend_mode: str = "add"
    ) -> Tuple[torch.Tensor]:
        """
        Apply audio-reactive edge glow effect to frames

        Args:
            frames: Input frames tensor (batch, height, width, channels)
            envelope: Frame-aligned FL audio envelope
            edge_threshold: Edge detection sensitivity
            glow_intensity: Base glow brightness
            envelope_intensity: How much envelope affects glow
            glow_color: Color of glow effect
            blend_mode: Blend mode for compositing

        Returns:
            Tuple containing edge-glowed frames
        """
        envelope_values = load_audio_envelope(envelope)["values"]
        frame_count = min(frames.shape[0], len(envelope_values))
        if edge_frames is not None:
            frame_count = min(frame_count, edge_frames.shape[0])
        frames = frames[:frame_count]
        strengths = (
            glow_intensity
            + torch.tensor(
                envelope_values[:frame_count],
                device=frames.device,
                dtype=frames.dtype,
            ) * envelope_intensity
        ).view(-1, 1, 1)

        if edge_frames is not None:
            edge_frames = edge_frames[:frame_count].to(device=frames.device, dtype=frames.dtype)
            if edge_frames.shape[-1] == 3:
                edges = (
                    edge_frames[..., 0] * 0.2126
                    + edge_frames[..., 1] * 0.7152
                    + edge_frames[..., 2] * 0.0722
                )
            else:
                edges = edge_frames[..., 0] if edge_frames.ndim == 4 else edge_frames
            output = _apply_glow(
                frames,
                edges * strengths,
                glow_color,
                blend_mode,
            )
        else:
            sobel_x = torch.tensor(
                [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]],
                device=frames.device,
                dtype=frames.dtype,
            ).view(1, 1, 3, 3)
            sobel_y = torch.tensor(
                [[-1, -2, -1], [0, 0, 0], [1, 2, 1]],
                device=frames.device,
                dtype=frames.dtype,
            ).view(1, 1, 3, 3)
            chunk_size = 4 if frames.device.type == "cpu" else frame_count
            output = []
            for start in range(0, frame_count, chunk_size):
                chunk = frames[start:start + chunk_size]
                gray = (
                    chunk[..., 0] * 0.2126
                    + chunk[..., 1] * 0.7152
                    + chunk[..., 2] * 0.0722
                ).unsqueeze(1)
                edges_x = F.conv2d(gray, sobel_x, padding=1)
                edges_y = F.conv2d(gray, sobel_y, padding=1)
                edges = torch.sqrt(edges_x.square() + edges_y.square()).squeeze(1)
                edges = edges / (edges.amax(dim=(1, 2), keepdim=True) + 1e-8)
                edges = ((edges - edge_threshold) / (1.0 - edge_threshold)).clamp(0.0, 1.0)
                output.append(
                    _apply_glow(
                        chunk,
                        edges * strengths[start:start + chunk_size],
                        glow_color,
                        blend_mode,
                    )
                )
            output = torch.cat(output)
        return (output,)
