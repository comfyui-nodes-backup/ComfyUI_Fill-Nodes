# FL_Audio_Reactive_Saturation: Control saturation based on audio envelope
import torch
import numpy as np
from PIL import Image
from typing import Tuple

from .audio_envelope import load_audio_envelope


class FL_Audio_Reactive_Saturation:
    """
    A ComfyUI node for applying audio-reactive saturation changes to frames.
    Adjusts color saturation based on envelope values from drum detection.
    """

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("frames",)
    FUNCTION = "apply_saturation"
    CATEGORY = "🏵️Fill Nodes/Audio"

    def t2p(self, t):
        """Tensor to PIL"""
        if t is not None:
            i = 255.0 * t.cpu().numpy().squeeze()
            return Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))
        return None

    def prepare_mask_batch(self, mask, total_images):
        """Prepare mask batch to match image batch size"""
        if mask is None:
            return None
        mask_images = [self.t2p(m) for m in mask]
        if len(mask_images) < total_images:
            mask_images = mask_images * (total_images // len(mask_images) + 1)
        return mask_images[:total_images]

    def process_mask(self, mask, target_size):
        """Resize and convert mask to grayscale"""
        mask = mask.resize(target_size, Image.LANCZOS)
        return mask.convert('L') if mask.mode != 'L' else mask

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "frames": ("IMAGE", {"description": "Input frames"}),
                "envelope": ("FL_AUDIO_ENVELOPE", {"description": "Frame-aligned FL audio envelope"}),
            },
            "optional": {
                "mask": ("IMAGE", {
                    "default": None,
                    "description": "Optional mask to control where effect is applied"
                }),
                "base_saturation": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 3.0,
                    "step": 0.01,
                    "description": "Base saturation multiplier (1.0 = normal, 0.0 = grayscale)"
                }),
                "saturation_intensity": ("FLOAT", {
                    "default": 0.2,
                    "min": -1.0,
                    "max": 1.0,
                    "step": 0.01,
                    "description": "Saturation intensity (positive = more saturated on hits, negative = desaturated)"
                }),
                "invert": ("BOOLEAN", {
                    "default": False,
                    "description": "Invert envelope (desaturate on hits instead of saturate)"
                }),
            }
        }

    def apply_saturation(
        self,
        frames: torch.Tensor,
        envelope,
        mask=None,
        base_saturation: float = 1.0,
        saturation_intensity: float = 0.2,
        invert: bool = False
    ) -> Tuple[torch.Tensor]:
        """
        Apply audio-reactive saturation effect to frames

        Args:
            frames: Input frames tensor (batch, height, width, channels)
            envelope: Frame-aligned FL audio envelope
            base_saturation: Base saturation multiplier (1.0 = normal)
            saturation_intensity: How much envelope affects saturation
            invert: Desaturate on hits instead of saturate

        Returns:
            Tuple containing saturation-adjusted frames
        """
        envelope_values = load_audio_envelope(envelope)["values"]
        frame_count = min(frames.shape[0], len(envelope_values))
        frames = frames[:frame_count]
        values = torch.tensor(
            envelope_values[:frame_count],
            device=frames.device,
            dtype=frames.dtype,
        ).view(-1, 1, 1, 1)
        direction = -1.0 if invert else 1.0
        saturation = (base_saturation + direction * values * saturation_intensity).clamp_min_(0.0)
        grayscale = (
            frames[..., 0] * 0.2126
            + frames[..., 1] * 0.7152
            + frames[..., 2] * 0.0722
        ).unsqueeze(-1)
        output = (grayscale + saturation * (frames - grayscale)).clamp(0.0, 1.0)

        if mask is not None:
            height, width = frames.shape[1:3]
            mask_images = self.prepare_mask_batch(mask, frame_count)
            mask_values = torch.stack([
                torch.from_numpy(
                    np.array(
                        self.process_mask(mask_image, (width, height)),
                        dtype=np.float32,
                    )
                )
                for mask_image in mask_images
            ]).div_(255.0).unsqueeze(-1).to(device=frames.device, dtype=frames.dtype)
            output = frames * (1.0 - mask_values) + output * mask_values

        return (output,)
