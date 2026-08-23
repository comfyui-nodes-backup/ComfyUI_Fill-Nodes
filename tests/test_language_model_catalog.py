import importlib.util
import pathlib
import unittest


ROOT = pathlib.Path(__file__).parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


catalog = load_module("language_model_catalog", ROOT / "nodes" / "ai" / "_language_models.py")
responses = load_module("openai_responses", ROOT / "nodes" / "gpt" / "_responses.py")


class GeminiCatalogTests(unittest.TestCase):
    def test_current_default_is_first_choice(self):
        self.assertEqual(catalog.model_choices(catalog.GEMINI_LANGUAGE_MODELS)[0], "gemini-3.7-flash")

    def test_known_model_restricts_inputs(self):
        with self.assertRaisesRegex(ValueError, "does not accept"):
            catalog.validate_gemini_model("gemini-3.7-flash", required_input="document")

    def test_custom_model_is_preserved(self):
        model, capability = catalog.validate_gemini_model("gemini-3.7-flash", "gemini-future", "text")
        self.assertEqual(model, "gemini-future")
        self.assertEqual(capability.max_output_tokens, 65536)


class OpenAIResponseTests(unittest.TestCase):
    def test_extracts_convenience_text(self):
        self.assertEqual(responses.response_text({"output_text": "caption"}), "caption")

    def test_extracts_content_blocks(self):
        body = {"output": [{"content": [{"type": "output_text", "text": "one"}, {"type": "refusal", "refusal": "no"}, {"type": "output_text", "text": " two"}]}]}
        self.assertEqual(responses.response_text(body), "one two")

    def test_image_input_is_data_url(self):
        request = responses.text_input("system", "describe", "data:image/png;base64,abc", "high")
        self.assertEqual(request[1]["content"][1], {"type": "input_image", "image_url": "data:image/png;base64,abc", "detail": "high"})


if __name__ == "__main__":
    unittest.main()
