# FL_Audio_Reactive_Brightness: Control brightness/luminance based on audio envelope
import torch
import numpy as np
from PIL import Image
from typing import Tuple

from .audio_envelope import load_audio_envelope


class FL_Audio_Reactive_Brightness:
    """
    A ComfyUI node for applying audio-reactive brightness/luminance changes to frames.
    Adjusts brightness based on envelope values from drum detection.
    """

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("frames",)
    FUNCTION = "apply_brightness"
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
                "base_brightness": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 3.0,
                    "step": 0.01,
                    "description": "Base brightness multiplier (1.0 = normal)"
                }),
                "brightness_intensity": ("FLOAT", {
                    "default": 0.15,
                    "min": -1.0,
                    "max": 1.0,
                    "step": 0.01,
                    "description": "Brightness intensity (positive = brighter on hits, negative = darker)"
                }),
                "invert": ("BOOLEAN", {
                    "default": False,
                    "description": "Invert envelope (darken on hits instead of brighten)"
                }),
                "clamp_output": ("BOOLEAN", {
                    "default": True,
                    "description": "Clamp output to valid range [0,1] to prevent overexposure"
                }),
            }
        }

    def apply_brightness(
        self,
        frames: torch.Tensor,
        envelope,
        mask=None,
        base_brightness: float = 1.0,
        brightness_intensity: float = 0.15,
        invert: bool = False,
        clamp_output: bool = True
    ) -> Tuple[torch.Tensor]:
        """
        Apply audio-reactive brightness effect to frames

        Args:
            frames: Input frames tensor (batch, height, width, channels)
            envelope: Frame-aligned FL audio envelope
            base_brightness: Base brightness multiplier (1.0 = normal)
            brightness_intensity: How much envelope affects brightness
            invert: Darken on hits instead of brighten
            clamp_output: Clamp to [0,1] range

        Returns:
            Tuple containing brightness-adjusted frames
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
        brightness = base_brightness + direction * values * brightness_intensity
        output = frames * brightness
        if clamp_output:
            output = output.clamp(0.0, 1.0)

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
