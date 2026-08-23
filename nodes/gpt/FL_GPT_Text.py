import asyncio
import os

import aiohttp

from ._responses import OPENAI_LANGUAGE_MODELS, create_response, text_input


class FL_GPT_Text:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "api_key": ("STRING", {"default": "", "multiline": False, "placeholder": "OpenAI API key or OPENAI_API_KEY"}),
                "model": (OPENAI_LANGUAGE_MODELS, {"default": "gpt-5.6-luna"}),
                "system_prompt": ("STRING", {"default": "You are a helpful assistant that provides accurate and concise information.", "multiline": True}),
                "user_prompt": ("STRING", {"default": "Hello, can you help me with something?", "multiline": True}),
                "max_tokens": ("INT", {"default": 500, "min": 1, "max": 65536}),
                "temperature": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.1}),
                "top_p": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "frequency_penalty": ("FLOAT", {"default": 0.0, "min": -2.0, "max": 2.0, "step": 0.1}),
                "presence_penalty": ("FLOAT", {"default": 0.0, "min": -2.0, "max": 2.0, "step": 0.1}),
            },
            "optional": {
                "save_to_file": ("BOOLEAN", {"default": False}),
                "output_directory": ("STRING", {"default": ""}),
                "filename": ("STRING", {"default": "gpt_response.txt"}),
                "custom_model": ("STRING", {"default": "", "placeholder": "Optional OpenAI model ID override"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("response",)
    FUNCTION = "generate_text"
    CATEGORY = "🏵️Fill Nodes/GPT"

    def generate_text(self, api_key, model, system_prompt, user_prompt, max_tokens, temperature, top_p,
                      frequency_penalty, presence_penalty, save_to_file=False, output_directory="", filename="gpt_response.txt", custom_model=""):
        api_key = api_key or os.getenv("OPENAI_API_KEY")
        if not api_key:
            return ("Error: OpenAI API key is required.",)
        model = custom_model.strip() or model

        async def request():
            headers = {"Authorization": f"Bearer {api_key}"}
            async with aiohttp.ClientSession(headers=headers) as session:
                return await create_response(session, model, text_input(system_prompt, user_prompt), max_tokens, temperature)

        try:
            response = asyncio.run(request())
            if save_to_file and output_directory:
                os.makedirs(output_directory, exist_ok=True)
                with open(os.path.join(output_directory, filename), "w", encoding="utf-8") as output:
                    output.write(response)
            return (response,)
        except Exception as error:
            return (f"Error: {error}",)
