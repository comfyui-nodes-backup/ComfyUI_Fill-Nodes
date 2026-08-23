import math

from comfy_api.latest import io

from .FL_Audio_Beat_Prompt_Schedule import _beat_to_seconds, _load_beats
from .audio_envelope import FLAudioEnvelope, load_audio_envelope, make_audio_envelope


FLPromptEnvelope = io.Custom("FL_PROMPT_ENVELOPE")
_EPS = 1e-6


def _curve(value, curve):
    value = min(max(value, 0.0), 1.0)
    if curve == "cosine":
        return 0.5 - 0.5 * math.cos(math.pi * value)
    return value


def _pulse_value(seconds, start, peak, hold_end, end, curve):
    if seconds < start or seconds >= end:
        return 0.0
    if seconds < peak and peak > start + _EPS:
        return _curve((seconds - start) / (peak - start), curve)
    if seconds < hold_end:
        return 1.0
    if end <= hold_end + _EPS:
        return 0.0
    return 1.0 - _curve((seconds - hold_end) / (end - hold_end), curve)


def _beat_envelope(
    beat_times,
    duration,
    fps,
    beat_stride,
    beat_phase,
    attack_beats,
    hold_beats,
    release_beats,
    curve,
):
    maximum = len(beat_times)
    selected = [
        index
        for index in range(beat_phase, maximum, beat_stride)
    ]
    events = []
    for index in selected:
        start_beat = max(0.0, index - attack_beats)
        peak_beat = float(index)
        hold_end_beat = min(maximum, peak_beat + hold_beats)
        end_beat = min(maximum, hold_end_beat + release_beats)
        start = _beat_to_seconds(start_beat, beat_times, duration, 0)
        peak = _beat_to_seconds(peak_beat, beat_times, duration, 0)
        hold_end = _beat_to_seconds(hold_end_beat, beat_times, duration, 0)
        end = _beat_to_seconds(end_beat, beat_times, duration, 0)
        if end > start + _EPS:
            events.append((start, peak, hold_end, end))

    total_frames = math.ceil(duration * fps)
    values = []
    for frame in range(total_frames):
        seconds = (frame + 0.5) / fps
        amount = max(
            (
                _pulse_value(seconds, start, peak, hold_end, end, curve)
                for start, peak, hold_end, end in events
            ),
            default=0.0,
        )
        values.append(amount)
    return values, [event[1] for event in events]


def _load_envelope(envelope):
    data = load_audio_envelope(envelope)
    return data["values"], data["fps"], data["duration"]


def _map_envelope(
    values,
    threshold,
    response_gamma,
    floor_strength,
    peak_strength,
    invert,
):
    mapped = []
    scale = 1.0 - threshold
    for value in values:
        amount = min(max((value - threshold) / scale, 0.0), 1.0)
        if invert:
            amount = 1.0 - amount
        amount = amount ** response_gamma
        mapped.append(floor_strength + amount * (peak_strength - floor_strength))
    return mapped


def _envelope_object(prompt, values, fps, duration):
    return {
        "type": "fl_prompt_envelope",
        "version": 1,
        "duration": duration,
        "fps": fps,
        "prompt": prompt.strip(),
        "weights": values,
    }


def _preview(values, fps, duration, hit_times=None):
    active = sum(value > _EPS for value in values)
    peak = max(values, default=0.0)
    lines = [
        f"{len(values)} samples at {fps:g} fps over {duration:.3f}s",
        f"{active} active samples, peak strength {peak:.3f}",
    ]
    if hit_times is not None:
        lines.append(
            f"{len(hit_times)} selected hits: "
            + ", ".join(f"{seconds:.3f}s" for seconds in hit_times[:24])
            + (" ..." if len(hit_times) > 24 else "")
        )
    return "\n".join(lines)


class FL_Audio_Beat_Prompt_Envelope(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="FL_Audio_Beat_Prompt_Envelope",
            display_name="FL Audio Beat Prompt Envelope",
            category="🏵️Fill Nodes/Audio",
            description=(
                "Turns exact detected beat positions into a reusable prompt-strength envelope "
                "for diffusion video conditioning."
            ),
            inputs=[
                io.String.Input(
                    "beat_positions",
                    force_input=True,
                    tooltip="Connect beat_positions from FL Audio BPM Analyzer.",
                ),
                io.String.Input(
                    "reactive_prompt",
                    multiline=True,
                    dynamic_prompts=True,
                    default="A violent outward deformation and rapid camera punch on every beat.",
                    tooltip="Action or visual change that becomes active around the selected beats.",
                ),
                io.Int.Input(
                    "beat_stride",
                    default=1,
                    min=1,
                    max=64,
                    step=1,
                    tooltip="Trigger every Nth detected beat. Use 1 for every beat, 2 for alternating beats, or 4 for downbeat-like accents.",
                ),
                io.Int.Input(
                    "beat_phase",
                    default=0,
                    min=0,
                    max=63,
                    step=1,
                    tooltip="Zero-based beat offset within beat_stride. For stride 4, phases 0-3 select different beats in each group.",
                ),
                io.Float.Input(
                    "attack_beats",
                    default=0.0,
                    min=0.0,
                    max=8.0,
                    step=0.125,
                    tooltip="How many beats before each hit the reactive prompt begins fading in.",
                ),
                io.Float.Input(
                    "hold_beats",
                    default=0.25,
                    min=0.0,
                    max=8.0,
                    step=0.125,
                    tooltip="How long the prompt remains at peak strength after each hit.",
                ),
                io.Float.Input(
                    "release_beats",
                    default=0.5,
                    min=0.0,
                    max=8.0,
                    step=0.125,
                    tooltip="How many beats the reactive prompt takes to fade out after its hold.",
                ),
                io.Float.Input(
                    "floor_strength",
                    default=0.0,
                    min=0.0,
                    max=8.0,
                    step=0.05,
                    tooltip="Prompt mask weight between hits. Leave at zero for a purely reactive prompt.",
                ),
                io.Float.Input(
                    "peak_strength",
                    default=3.0,
                    min=0.0,
                    max=8.0,
                    step=0.05,
                    tooltip="Prompt mask weight on hits. Values above 1 make the reactive prompt dominate other active prompts without scaling embeddings.",
                ),
                io.Combo.Input(
                    "curve",
                    options=["linear", "cosine"],
                    default="cosine",
                    tooltip="Shape of the attack and release around each selected beat.",
                ),
                io.Float.Input(
                    "fps",
                    default=24.0,
                    min=1.0,
                    max=120.0,
                    step=1.0,
                    tooltip="Envelope sampling rate. Use 24 fps for MiniMax H3.",
                ),
            ],
            outputs=[
                FLPromptEnvelope.Output(
                    display_name="prompt_envelope",
                    tooltip="Reactive prompt and temporal mask weights for compatible FL diffusion nodes.",
                ),
                FLAudioEnvelope.Output(
                    display_name="envelope",
                    tooltip="Normalized FL audio envelope compatible with reactive preview and post-effect nodes.",
                ),
                io.String.Output(
                    display_name="preview",
                    tooltip="Readable summary of selected hits and generated strengths.",
                ),
            ],
        )

    @classmethod
    def execute(
        cls,
        beat_positions,
        reactive_prompt,
        beat_stride,
        beat_phase,
        attack_beats,
        hold_beats,
        release_beats,
        floor_strength,
        peak_strength,
        curve,
        fps,
    ):
        if not reactive_prompt.strip():
            raise ValueError("Reactive prompt cannot be empty.")
        if beat_phase >= beat_stride:
            raise ValueError("Beat phase must be smaller than beat stride.")
        if peak_strength < floor_strength:
            raise ValueError("Peak strength must be greater than or equal to floor strength.")
        if attack_beats + hold_beats + release_beats <= 0:
            raise ValueError("Beat prompt envelope needs a non-zero attack, hold, or release.")

        beat_times, duration = _load_beats(beat_positions)
        values, hit_times = _beat_envelope(
            beat_times,
            duration,
            fps,
            beat_stride,
            beat_phase,
            attack_beats,
            hold_beats,
            release_beats,
            curve,
        )
        mapped = [
            floor_strength + value * (peak_strength - floor_strength)
            for value in values
        ]
        return io.NodeOutput(
            _envelope_object(reactive_prompt, mapped, fps, duration),
            make_audio_envelope(values, fps, duration, "beat_grid"),
            _preview(mapped, fps, duration, hit_times),
        )


class FL_Audio_Envelope_Prompt(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="FL_Audio_Envelope_Prompt",
            display_name="FL Audio Envelope Prompt",
            category="🏵️Fill Nodes/Audio",
            description=(
                "Maps an FL audio envelope, such as a kick or snare ADSR envelope, "
                "to diffusion prompt mask strength."
            ),
            inputs=[
                FLAudioEnvelope.Input(
                    "envelope",
                    tooltip="Connect an FL audio envelope from the sequencer or another compatible FL node.",
                ),
                io.String.Input(
                    "reactive_prompt",
                    multiline=True,
                    dynamic_prompts=True,
                    default="A sharp burst of light and rapid geometric deformation.",
                    tooltip="Action or visual change controlled by the incoming envelope.",
                ),
                io.Float.Input(
                    "threshold",
                    default=0.0,
                    min=0.0,
                    max=0.99,
                    step=0.01,
                    tooltip="Ignore low envelope values below this level, then remap the remaining range to 0-1.",
                ),
                io.Float.Input(
                    "response_gamma",
                    default=1.0,
                    min=0.1,
                    max=4.0,
                    step=0.05,
                    tooltip="Shapes the response. Values below 1 broaden hits; values above 1 make them sharper.",
                ),
                io.Float.Input(
                    "floor_strength",
                    default=0.0,
                    min=0.0,
                    max=8.0,
                    step=0.05,
                    tooltip="Prompt mask weight when the source envelope is quiet.",
                ),
                io.Float.Input(
                    "peak_strength",
                    default=3.0,
                    min=0.0,
                    max=8.0,
                    step=0.05,
                    tooltip="Prompt mask weight at the envelope peak. Values above 1 make the reactive prompt dominate overlapping prompts.",
                ),
                io.Boolean.Input(
                    "invert",
                    default=False,
                    tooltip="Invert the normalized envelope so the prompt becomes strongest during quiet portions.",
                ),
            ],
            outputs=[
                FLPromptEnvelope.Output(
                    display_name="prompt_envelope",
                    tooltip="Reactive prompt and temporal mask weights for compatible FL diffusion nodes.",
                ),
                io.String.Output(
                    display_name="preview",
                    tooltip="Readable summary of the mapped envelope.",
                ),
            ],
        )

    @classmethod
    def execute(
        cls,
        envelope,
        reactive_prompt,
        threshold,
        response_gamma,
        floor_strength,
        peak_strength,
        invert,
    ):
        if not reactive_prompt.strip():
            raise ValueError("Reactive prompt cannot be empty.")
        if peak_strength < floor_strength:
            raise ValueError("Peak strength must be greater than or equal to floor strength.")

        values, fps, duration = _load_envelope(envelope)
        mapped = _map_envelope(
            values,
            threshold,
            response_gamma,
            floor_strength,
            peak_strength,
            invert,
        )
        return io.NodeOutput(
            _envelope_object(reactive_prompt, mapped, fps, duration),
            _preview(mapped, fps, duration),
        )
