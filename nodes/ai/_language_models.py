from dataclasses import dataclass


@dataclass(frozen=True)
class LanguageModel:
    model_id: str
    label: str
    max_output_tokens: int
    thinking_levels: tuple[str, ...] = ()
    inputs: tuple[str, ...] = ("text",)
    legacy: bool = False
    replacement: str | None = None


GEMINI_LANGUAGE_MODELS = (
    LanguageModel("gemini-3.7-flash", "Gemini 3.7 Flash", 65536, ("low", "medium", "high"), ("text", "image", "video", "audio", "pdf")),
    LanguageModel("gemini-3.1-pro-preview", "Gemini 3.1 Pro (Preview)", 65536, ("low", "medium", "high"), ("text", "image", "video", "audio", "pdf")),
    LanguageModel("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", 65536, ("low", "medium", "high"), ("text", "image", "video", "audio", "pdf")),
    LanguageModel("gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite", 65536, ("low", "medium", "high"), ("text", "image", "video", "audio", "pdf")),
    LanguageModel("gemini-2.5-flash", "Gemini 2.5 Flash (Legacy)", 65536, ("low",), ("text", "image", "video", "audio", "pdf"), True),
    LanguageModel("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite (Legacy)", 65536, ("low",), ("text", "image", "video", "audio", "pdf"), True),
)

OPENAI_LANGUAGE_MODELS = (
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
)

OPENROUTER_VISION_MODELS = (
    "google/gemini-3.7-flash",
    "anthropic/claude-haiku-4.5",
    "openai/gpt-5.6-luna",
)


def model_choices(models):
    return [model.model_id for model in models]


def get_gemini_model(model_id):
    return next((model for model in GEMINI_LANGUAGE_MODELS if model.model_id == model_id), None)


def resolve_gemini_model(model_id, custom_model=""):
    selected = custom_model.strip() or model_id
    model = get_gemini_model(selected)
    if model is not None:
        return selected, model
    return selected, LanguageModel(selected, selected, 65536, ("low", "medium", "high"), ("text", "image", "video", "audio", "pdf"))


def validate_gemini_model(model_id, custom_model="", required_input="text"):
    selected, model = resolve_gemini_model(model_id, custom_model)
    if required_input not in model.inputs:
        raise ValueError(f"{selected} does not accept {required_input} input.")
    if model.legacy and model.replacement:
        raise ValueError(f"{selected} is retired. Use {model.replacement} instead.")
    return selected, model
