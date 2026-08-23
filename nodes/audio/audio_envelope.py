import math

from comfy_api.latest import io


FLAudioEnvelope = io.Custom("FL_AUDIO_ENVELOPE")
FLPromptEnvelopeSet = io.Custom("FL_PROMPT_ENVELOPE_SET")


def _positive_number(value, name):
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"Audio envelope {name} must be a number.") from error
    if not math.isfinite(number) or number <= 0:
        raise ValueError(f"Audio envelope {name} must be greater than zero.")
    return number


def _values(values, name="values", maximum=1.0):
    if not isinstance(values, list) or not values:
        raise ValueError(f"Audio envelope must contain a non-empty {name} list.")
    resolved = []
    for index, value in enumerate(values):
        try:
            number = float(value)
        except (TypeError, ValueError) as error:
            raise ValueError(f"Audio envelope {name}[{index}] must be a number.") from error
        if not math.isfinite(number) or number < 0 or number > maximum:
            raise ValueError(
                f"Audio envelope {name}[{index}] must be between 0 and {maximum:g}."
            )
        resolved.append(number)
    return resolved


def make_audio_envelope(values, fps, duration, source="", slot=None):
    values = _values(values)
    fps = _positive_number(fps, "fps")
    duration = _positive_number(duration, "duration")
    envelope = {
        "type": "fl_audio_envelope",
        "version": 1,
        "fps": fps,
        "duration": duration,
        "total_frames": len(values),
        "source": str(source),
        "values": values,
    }
    if slot is not None:
        envelope["slot"] = int(slot)
    return envelope


def load_audio_envelope(envelope, optional=False):
    if envelope is None and optional:
        return None
    if not isinstance(envelope, dict) or envelope.get("type") != "fl_audio_envelope":
        raise TypeError("Expected an FL_AUDIO_ENVELOPE input.")
    if envelope.get("version") != 1:
        raise ValueError("FL audio envelope version 1 is required.")
    values = _values(envelope.get("values"))
    fps = _positive_number(envelope.get("fps"), "fps")
    duration = _positive_number(envelope.get("duration"), "duration")
    if envelope.get("total_frames") != len(values):
        raise ValueError("Audio envelope total_frames does not match its values.")
    return {
        **envelope,
        "values": values,
        "fps": fps,
        "duration": duration,
        "total_frames": len(values),
    }


def make_prompt_envelope_set(envelopes, fps, duration):
    fps = _positive_number(fps, "fps")
    duration = _positive_number(duration, "duration")
    return {
        "type": "fl_prompt_envelope_set",
        "version": 1,
        "fps": fps,
        "duration": duration,
        "envelopes": envelopes,
    }
