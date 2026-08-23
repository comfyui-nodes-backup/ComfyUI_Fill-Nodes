import time
import traceback

from google import genai

from ._language_models import GEMINI_LANGUAGE_MODELS, model_choices, validate_gemini_model


class FL_GeminiTextAPI:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"multiline": True}),
                "api_key": ("STRING", {"default": "", "multiline": False}),
                "model": (model_choices(GEMINI_LANGUAGE_MODELS), {"default": "gemini-3.7-flash"}),
                "temperature": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 1.0, "step": 0.05}),
                "max_output_tokens": ("INT", {"default": 8192, "min": 64, "max": 65536, "step": 64}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffff}),
            },
            "optional": {
                "system_instructions": ("STRING", {"multiline": True, "default": ""}),
                "top_p": ("FLOAT", {"default": 0.95, "min": 0.0, "max": 1.0, "step": 0.01}),
                "top_k": ("INT", {"default": 64, "min": 1, "max": 100, "step": 1}),
                "thinking_level": (["default", "low", "medium", "high"], {"default": "default"}),
                "custom_model": ("STRING", {"default": "", "placeholder": "Optional Gemini model ID override"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("response",)
    FUNCTION = "generate_text"
    CATEGORY = "🏵️Fill Nodes/AI"

    def __init__(self):
        self.log_messages = []

    def _log(self, message):
        print(f"[FL_GeminiTextAPI] {time.strftime('%Y-%m-%d %H:%M:%S')}: {message}")
        self.log_messages.append(message)

    def generate_text(self, prompt, api_key, model, temperature, max_output_tokens, seed,
                      system_instructions="", top_p=0.95, top_k=64, thinking_level="default", custom_model=""):
        self.log_messages = []
        if not api_key:
            return ("Error: No Google API key provided.",)

        try:
            model, capability = validate_gemini_model(model, custom_model)
            config = {
                "temperature": temperature,
                "max_output_tokens": min(max_output_tokens, capability.max_output_tokens),
                "top_p": top_p,
                "top_k": top_k,
                "seed": seed or None,
            }
            if system_instructions.strip():
                config["system_instruction"] = system_instructions
            if thinking_level != "default" and thinking_level in capability.thinking_levels:
                config["thinking_config"] = {"thinking_level": thinking_level.upper()}

            self._log(f"Sending request to {model}.")
            client = genai.Client(api_key=api_key)
            interaction = client.interactions.create(
                model=model,
                input=prompt,
                generation_config={key: value for key, value in config.items() if value is not None},
            )
            text = getattr(interaction, "output_text", "")
            if not text:
                raise ValueError("Gemini returned no text output.")
            return (text.strip(),)
        except Exception as error:
            self._log(f"Error: {error}")
            traceback.print_exc()
            return (f"Error: {error}",)
