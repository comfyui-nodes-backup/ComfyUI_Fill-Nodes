import asyncio
import base64
import io
import os

import aiohttp
from PIL import Image

from ._responses import OPENAI_LANGUAGE_MODELS, create_response, text_input


class FL_GPT_Vision:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": (OPENAI_LANGUAGE_MODELS, {"default": "gpt-5.6-luna"}),
                "system_prompt": ("STRING", {"default": "You are a helpful assistant that describes images accurately and concisely.", "multiline": True}),
                "request_prompt": ("STRING", {"default": "Describe this image in detail.", "multiline": True}),
                "output_directory": ("STRING", {"default": ""}),
                "overwrite": ("BOOLEAN", {"default": False}),
                "max_tokens": ("INT", {"default": 300, "min": 1, "max": 65536}),
                "temperature": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.1}),
                "detail": (["auto", "low", "high"],),
                "batch_size": ("INT", {"default": 5, "min": 1, "max": 20}),
            },
            "optional": {
                "images": ("IMAGE",),
                "input_directory": ("STRING", {"default": ""}),
                "custom_model": ("STRING", {"default": "", "placeholder": "Optional OpenAI model ID override"}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("message", "output_directory")
    FUNCTION = "generate_captions"
    CATEGORY = "🏵️Fill Nodes/GPT"

    @staticmethod
    def _image_url(image):
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()

    async def _caption(self, session, image, model, system_prompt, request_prompt, max_tokens, temperature, detail):
        return await create_response(session, model, text_input(system_prompt, request_prompt, self._image_url(image), detail), max_tokens, temperature)

    def generate_captions(self, model, system_prompt, request_prompt, output_directory, overwrite, max_tokens,
                          temperature, detail, batch_size, images=None, input_directory=None, custom_model=""):
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            return ("Error: OPENAI_API_KEY is not set.", "")
        if images is None and not input_directory:
            return ("Error: provide images or input_directory.", "")
        model = custom_model.strip() or model
        os.makedirs(output_directory, exist_ok=True)
        image_list = []
        if images is not None:
            for index, image in enumerate(images):
                image_list.append((Image.fromarray((image.cpu().numpy() * 255).astype("uint8")), f"image_{index}.png"))
        if input_directory:
            for filename in sorted(os.listdir(input_directory)):
                if filename.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                    image_list.append((Image.open(os.path.join(input_directory, filename)).convert("RGB"), filename))

        async def process():
            headers = {"Authorization": f"Bearer {api_key}"}
            async with aiohttp.ClientSession(headers=headers) as session:
                results = []
                for start in range(0, len(image_list), batch_size):
                    batch = image_list[start:start + batch_size]
                    captions = await asyncio.gather(*[self._caption(session, image, model, system_prompt, request_prompt, max_tokens, temperature, detail) for image, _ in batch])
                    for (image, filename), caption in zip(batch, captions):
                        path = os.path.join(output_directory, filename)
                        caption_path = os.path.splitext(path)[0] + ".txt"
                        if overwrite or not os.path.exists(caption_path):
                            image.save(path)
                            with open(caption_path, "w", encoding="utf-8") as output:
                                output.write(caption)
                        results.append(caption)
                return results

        try:
            captions = asyncio.run(process())
            return (f"Generated {len(captions)} captions in {output_directory}", output_directory)
        except Exception as error:
            return (f"Error: {error}", "")
