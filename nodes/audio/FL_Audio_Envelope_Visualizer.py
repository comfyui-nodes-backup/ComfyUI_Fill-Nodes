# FL_Audio_Envelope_Visualizer: Visualize envelopes as fading white frames
import torch
from typing import Tuple

from .audio_envelope import load_audio_envelope


class FL_Audio_Envelope_Visualizer:
    """
    A ComfyUI node for visualizing audio envelopes as frames.
    Creates white frames that fade to black based on envelope values.
    """

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("frames",)
    FUNCTION = "visualize_envelope"
    CATEGORY = "🏵️Fill Nodes/Audio"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "envelope": ("FL_AUDIO_ENVELOPE", {
                    "description": "Frame-aligned FL audio envelope"
                }),
            },
            "optional": {
                "width": ("INT", {
                    "default": 512,
                    "min": 64,
                    "max": 4096,
                    "step": 8,
                    "description": "Frame width"
                }),
                "height": ("INT", {
                    "default": 512,
                    "min": 64,
                    "max": 4096,
                    "step": 8,
                    "description": "Frame height"
                }),
                "intensity": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.1,
                    "max": 5.0,
                    "step": 0.1,
                    "description": "Brightness multiplier"
                }),
                "invert": ("BOOLEAN", {
                    "default": False,
                    "description": "Invert colors (black flashes on white)"
                }),
            }
        }

    def visualize_envelope(
        self,
        envelope,
        width: int = 512,
        height: int = 512,
        intensity: float = 1.0,
        invert: bool = False
    ) -> Tuple[torch.Tensor]:
        """
        Visualize envelope as fading frames

        Args:
            envelope: Frame-aligned FL audio envelope
            width: Frame width in pixels
            height: Frame height in pixels
            intensity: Brightness multiplier
            invert: Invert colors (black on white instead of white on black)

        Returns:
            Tuple containing tensor of frames (batch, height, width, channels)
        """
        values = torch.tensor(
            load_audio_envelope(envelope)["values"],
            dtype=torch.float32,
        ).mul(intensity).clamp_(0.0, 1.0)
        if invert:
            values = 1.0 - values
        frames = torch.ones(
            (len(values), height, width, 3),
            dtype=torch.float32,
        ).mul_(values.view(-1, 1, 1, 1))
        return (frames,)
