import base64
import mimetypes
import os
import time

import cv2
import numpy as np
import torch
from google import genai

from ._language_models import GEMINI_LANGUAGE_MODELS, model_choices, validate_gemini_model


class FL_GeminiVideoCaptioner:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "api_key": ("STRING", {"default": "", "multiline": False}),
                "model": (model_choices(GEMINI_LANGUAGE_MODELS), {"default": "gemini-3.7-flash"}),
                "frames_per_second": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 10.0, "step": 0.1}),
                "max_duration_minutes": ("FLOAT", {"default": 2.0, "min": 0.1, "max": 45.0, "step": 0.1}),
                "prompt": ("STRING", {"default": "Describe this video scene in detail. Include important actions, subjects, settings, and atmosphere.", "multiline": True}),
                "process_audio": (["false", "true"], {"default": "false"}),
                "temperature": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 1.0, "step": 0.1}),
                "max_output_tokens": ("INT", {"default": 8192, "min": 50, "max": 65536, "step": 64}),
                "top_p": ("FLOAT", {"default": 0.95, "min": 0.0, "max": 1.0, "step": 0.01}),
                "top_k": ("INT", {"default": 64, "min": 1, "max": 100, "step": 1}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffff}),
                "thinking_level": (["default", "low", "medium", "high"], {"default": "default"}),
            },
            "optional": {
                "video_path": ("STRING", {"default": ""}),
                "image": ("IMAGE", {}),
                "custom_model": ("STRING", {"default": "", "placeholder": "Optional Gemini model ID override"}),
            },
        }

    RETURN_TYPES = ("STRING", "IMAGE")
    RETURN_NAMES = ("caption", "sampled_frame")
    FUNCTION = "generate_video_caption"
    CATEGORY = "🏵️Fill Nodes/AI"

    @staticmethod
    def _image_input(frame):
        success, encoded = cv2.imencode(".png", cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
        if not success:
            raise ValueError("Could not encode video frame.")
        return {"type": "image", "data": base64.b64encode(encoded.tobytes()).decode(), "mime_type": "image/png"}

    @staticmethod
    def _sample_frame(video_path):
        capture = cv2.VideoCapture(video_path)
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        capture.set(cv2.CAP_PROP_POS_FRAMES, max(0, frame_count // 2))
        success, frame = capture.read()
        capture.release()
        if not success:
            raise ValueError("Could not read a frame from video.")
        frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        return frame, torch.from_numpy(frame.astype(np.float32) / 255.0).unsqueeze(0)

    def generate_video_caption(self, api_key, model, frames_per_second, max_duration_minutes, prompt,
                               process_audio, temperature, max_output_tokens, top_p, top_k, seed,
                               thinking_level, video_path=None, image=None, custom_model=""):
        if not api_key:
            raise ValueError("Gemini API key is required")
        model, capability = validate_gemini_model(model, custom_model, "video" if video_path else "image")
        client = genai.Client(api_key=api_key)
        uploaded = None
        try:
            config = {"temperature": temperature, "max_output_tokens": min(max_output_tokens, capability.max_output_tokens), "top_p": top_p, "top_k": top_k, "seed": seed or None}
            if thinking_level != "default" and thinking_level in capability.thinking_levels:
                config["thinking_config"] = {"thinking_level": thinking_level.upper()}
            if video_path:
                if not os.path.isfile(video_path):
                    raise ValueError("video_path does not exist")
                frame, sample = self._sample_frame(video_path)
                mime_type = mimetypes.guess_type(video_path)[0] or "video/mp4"
                uploaded = client.files.upload(file=video_path, config={"mime_type": mime_type})
                while getattr(uploaded, "state", None) and getattr(uploaded.state, "name", uploaded.state) == "PROCESSING":
                    time.sleep(2)
                    uploaded = client.files.get(name=uploaded.name)
                if getattr(getattr(uploaded, "state", None), "name", getattr(uploaded, "state", None)) == "FAILED":
                    raise ValueError("Gemini could not process the video file.")
                inputs = [{"type": "video", "uri": uploaded.uri, "mime_type": uploaded.mime_type}, {"type": "text", "text": prompt}]
            elif image is not None:
                frames = [(frame.cpu().numpy().clip(0, 1) * 255).astype(np.uint8) for frame in image]
                if not frames:
                    raise ValueError("image input is empty")
                sample = image[len(image) // 2].unsqueeze(0)
                stride = max(1, round(24 / frames_per_second))
                inputs = [{"type": "text", "text": prompt}] + [self._image_input(frame) for frame in frames[::stride]]
            else:
                raise ValueError("Provide video_path or image input.")
            interaction = client.interactions.create(model=model, input=inputs, generation_config={key: value for key, value in config.items() if value is not None})
            caption = getattr(interaction, "output_text", "")
            if not caption:
                raise ValueError("Gemini returned no caption.")
            return (caption.strip(), sample)
        finally:
            if uploaded is not None:
                try:
                    client.files.delete(name=uploaded.name)
                except Exception:
                    pass
