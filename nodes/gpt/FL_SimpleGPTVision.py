import asyncio
import base64
import io
import os

import aiohttp
from PIL import Image

from ._responses import OPENAI_LANGUAGE_MODELS, create_response, text_input


class FL_SimpleGPTVision:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "model": (OPENAI_LANGUAGE_MODELS, {"default": "gpt-5.6-luna"}),
                "system_prompt": ("STRING", {"default": "You are a helpful assistant that describes images accurately and concisely.", "multiline": True}),
                "request_prompt": ("STRING", {"default": "Describe this image in detail.", "multiline": True}),
                "max_tokens": ("INT", {"default": 300, "min": 1, "max": 65536}),
                "temperature": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.1}),
                "detail": (["auto", "low", "high"],),
            },
            "optional": {"custom_model": ("STRING", {"default": "", "placeholder": "Optional OpenAI model ID override"})},
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "generate_caption"
    CATEGORY = "🏵️Fill Nodes/GPT"

    def generate_caption(self, image, model, system_prompt, request_prompt, max_tokens, temperature, detail, custom_model=""):
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            return ("Error: OPENAI_API_KEY is not set.",)
        buffer = io.BytesIO()
        Image.fromarray((image[0].cpu().numpy() * 255).astype("uint8")).save(buffer, format="PNG")
        image_url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()
        model = custom_model.strip() or model

        async def request():
            async with aiohttp.ClientSession(headers={"Authorization": f"Bearer {api_key}"}) as session:
                return await create_response(session, model, text_input(system_prompt, request_prompt, image_url, detail), max_tokens, temperature)

        try:
            return (asyncio.run(request()),)
        except Exception as error:
            return (f"Error: {error}",)
