import base64
import os
import re
from io import BytesIO

import numpy as np
from ollama import Client
from PIL import Image


class FL_OllamaCaptioner:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {}),
                "folder_name": ("STRING", {"default": "output_folder"}),
                "use_llm": ("BOOLEAN", {"default": True}),
                "url": ("STRING", {"default": "http://127.0.0.1:11434"}),
                "model": ("STRING", {"default": "", "placeholder": "Installed Ollama vision model"}),
                "overwrite": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "save_images_with_captions"
    CATEGORY = "🏵️Fill Nodes/Captioning"
    OUTPUT_NODE = True

    @staticmethod
    def _image(image_tensor):
        image = Image.fromarray((image_tensor.cpu().numpy() * 255).clip(0, 255).astype(np.uint8))
        buffer = BytesIO()
        image.save(buffer, format="PNG")
        return image, base64.b64encode(buffer.getvalue()).decode("utf-8")

    def save_images_with_captions(self, images, folder_name, use_llm, url, model, overwrite):
        if use_llm and not model.strip():
            raise ValueError("Choose an installed Ollama vision model.")
        os.makedirs(folder_name, exist_ok=True)
        client = Client(host=url)
        for index, tensor in enumerate(images):
            image, encoded = self._image(tensor)
            stem = os.path.join(folder_name, f"image_{index}")
            image_path, caption_path = stem + ".png", stem + ".txt"
            if not overwrite:
                suffix = 1
                while os.path.exists(image_path) or os.path.exists(caption_path):
                    image_path, caption_path = f"{stem}_{suffix}.png", f"{stem}_{suffix}.txt"
                    suffix += 1
            caption = client.generate(model=model, prompt="describe the image", images=[encoded])["response"] if use_llm else "Default Caption"
            image.save(image_path)
            with open(caption_path, "w", encoding="utf-8") as output:
                output.write(re.sub(r"[^a-zA-Z0-9\s.,!?-]", "", caption))
        return (f"Saved {len(images)} images and generated captions in '{folder_name}'",)
