# FL_Audio_Reactive_Speed: Time remapping based on audio envelope
import torch
import numpy as np
from PIL import Image
from typing import Tuple

from .audio_envelope import load_audio_envelope


class FL_Audio_Reactive_Speed:
    """
    A ComfyUI node for applying audio-reactive speed/time remapping to frames.
    Speeds up or slows down playback based on envelope values from drum detection.
    """

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("frames",)
    FUNCTION = "apply_speed"
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
                "base_speed": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 3.0,
                    "step": 0.01,
                    "description": "Base playback speed (1.0 = normal, 0.0 = freeze)"
                }),
                "speed_intensity": ("FLOAT", {
                    "default": 0.5,
                    "min": -3.0,
                    "max": 3.0,
                    "step": 0.01,
                    "description": "Speed intensity (positive = faster on hits, negative = slower)"
                }),
                "interpolation": (["bilinear", "bicubic", "nearest"], {
                    "default": "bilinear",
                    "description": "Frame interpolation mode"
                }),
                "invert": ("BOOLEAN", {
                    "default": False,
                    "description": "Invert envelope (slow down on hits instead of speed up)"
                }),
            }
        }

    def apply_speed(
        self,
        frames: torch.Tensor,
        envelope,
        mask=None,
        base_speed: float = 1.0,
        speed_intensity: float = 0.5,
        interpolation: str = "bilinear",
        invert: bool = False
    ) -> Tuple[torch.Tensor]:
        """
        Apply audio-reactive speed/time remapping to frames

        Args:
            frames: Input frames tensor (batch, height, width, channels)
            envelope: Frame-aligned FL audio envelope
            mask: Optional mask to control where effect is applied
            base_speed: Base playback speed (1.0 = normal)
            speed_intensity: How much envelope affects speed
            interpolation: Frame interpolation mode
            invert: Slow down on hits instead of speed up

        Returns:
            Tuple containing time-remapped frames
        """
        envelope_values = load_audio_envelope(envelope)["values"]
        batch_size, height, width, channels = frames.shape
        direction = -1.0 if invert else 1.0
        speed_multipliers = [
            max(0.0, min(base_speed + direction * value * speed_intensity, 3.0))
            for value in envelope_values
        ]
        source_positions = []
        current_source_pos = 0.0
        for speed in speed_multipliers:
            source_positions.append(min(current_source_pos, batch_size - 1.0))
            current_source_pos += speed

        positions = torch.tensor(source_positions, device=frames.device, dtype=frames.dtype)
        low = positions.floor().long().clamp_(0, batch_size - 1)
        high = positions.ceil().long().clamp_(0, batch_size - 1)
        blend = (positions - low).view(-1, 1, 1, 1)
        if interpolation == "nearest":
            indices = torch.where(blend.flatten() < 0.5, low, high)
            output = frames[indices]
        else:
            output = torch.lerp(frames[low], frames[high], blend)

        if mask is not None:
            mask_images = self.prepare_mask_batch(mask, len(envelope_values))
            mask_values = torch.stack([
                torch.from_numpy(
                    np.array(
                        self.process_mask(mask_image, (width, height)),
                        dtype=np.float32,
                    )
                )
                for mask_image in mask_images
            ]).div_(255.0).unsqueeze(-1).to(device=frames.device, dtype=frames.dtype)
            original_indices = torch.arange(
                len(envelope_values), device=frames.device
            ).clamp_max_(batch_size - 1)
            original = frames[original_indices]
            output = original * (1.0 - mask_values) + output * mask_values

        return (output,)
