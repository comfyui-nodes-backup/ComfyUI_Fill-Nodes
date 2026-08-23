

OPENAI_LANGUAGE_MODELS = ("gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol")


def response_text(body):
    if isinstance(body.get("output_text"), str):
        return body["output_text"]
    return "".join(
        item.get("text", "")
        for output in body.get("output", [])
        for item in output.get("content", [])
        if item.get("type") == "output_text"
    )


def text_input(system_prompt, user_prompt, image_url=None, detail="auto"):
    content = [{"type": "input_text", "text": user_prompt}]
    if image_url is not None:
        content.append({"type": "input_image", "image_url": image_url, "detail": detail})
    return [
        {"role": "system", "content": [{"type": "input_text", "text": system_prompt}]},
        {"role": "user", "content": content},
    ]


async def create_response(session, model, input_data, max_output_tokens, temperature):
    payload = {
        "model": model,
        "input": input_data,
        "max_output_tokens": max_output_tokens,
        "temperature": temperature,
    }
    async with session.post("https://api.openai.com/v1/responses", json=payload) as response:
        response.raise_for_status()
        text = response_text(await response.json())
        if not text:
            raise ValueError("OpenAI returned no text output.")
        return text
