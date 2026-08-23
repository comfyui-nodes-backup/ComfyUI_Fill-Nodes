import hashlib
import json
import math
import threading
from pathlib import Path

import numpy as np
import torch
import torchaudio
from huggingface_hub import snapshot_download
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor

import comfy.model_management
import folder_paths

from .audio_files import audio_file_hash, load_audio_file, resolve_audio_path
from .audio_separation import SEPARATION_MODEL, load_cached_stem, separation_manifest


TRANSCRIPTION_VERSION = 1
GROUPING_VERSION = 2
WHISPER_SAMPLE_RATE = 16000
CHUNK_SECONDS = 28.0
OVERLAP_SECONDS = 2.0
MODEL_ARTIFACT_PATTERNS = (
    "*.json", "*.txt", "*.model", "*.safetensors", "*.bin",
)
TRANSCRIPTION_MODELS = {
    "small": {
        "name": "Whisper Small",
        "repo_id": "openai/whisper-small",
        "revision": "973afd24965f72e36ca33b3055d56a652f456b4d",
        "memory_required": 2 * 1024**3,
    },
    "large-v3-turbo": {
        "name": "Whisper Large v3 Turbo",
        "repo_id": "openai/whisper-large-v3-turbo",
        "revision": "41f01f3fe87f28c78e2fbf8b568835947dd65ed9",
        "memory_required": 8 * 1024**3,
    },
}
TRANSCRIPTION_LANGUAGES = {
    "auto", "en", "es", "fr", "de", "it", "pt", "ru", "ja", "ko", "zh",
    "ar", "hi", "tr", "pl", "nl", "sv", "no", "da", "fi", "uk", "cs",
}
TRANSCRIPTION_SOURCES = {"auto", "vocals", "mix"}


class AudioTranscriptionError(RuntimeError):
    pass


class TranscriptionCancelled(Exception):
    pass


_inference_lock = threading.Lock()


def _model(model):
    if model not in TRANSCRIPTION_MODELS:
        raise ValueError(f"Unknown transcription model: {model}")
    return TRANSCRIPTION_MODELS[model]


def _language(language):
    language = str(language or "auto").lower()
    if language not in TRANSCRIPTION_LANGUAGES:
        raise ValueError(f"Unsupported transcription language: {language}")
    return language


def model_directory(model):
    _model(model)
    return Path(folder_paths.models_dir) / "whisper" / model


def _model_ready(path):
    return (
        (path / "config.json").is_file()
        and (path / "preprocessor_config.json").is_file()
        and any(path.glob("model*.safetensors"))
    )


def transcription_model_status(model):
    values = _model(model)
    ready = _model_ready(model_directory(model))
    return {
        "version": 1,
        "model": model,
        "name": values["name"],
        "repo_id": values["repo_id"],
        "revision": values["revision"],
        "ready": ready,
        "message": f"{values['name']} ready" if ready else f"{values['name']} requires download",
    }


def _ensure_model(model, allow_download, progress=None):
    values = _model(model)
    path = model_directory(model)
    if _model_ready(path):
        return path
    if not allow_download:
        raise AudioTranscriptionError(
            f"{values['name']} is not installed. Use Download model & transcribe first."
        )
    if progress:
        progress(0.01, f"Downloading {values['name']}")
    path.mkdir(parents=True, exist_ok=True)
    try:
        snapshot_download(
            repo_id=values["repo_id"],
            revision=values["revision"],
            local_dir=path,
            allow_patterns=list(MODEL_ARTIFACT_PATTERNS),
        )
    except Exception as error:
        raise AudioTranscriptionError(f"Could not download {values['name']}: {error}") from error
    if not _model_ready(path):
        raise AudioTranscriptionError(f"{values['name']} download is incomplete.")
    return path


def resolve_transcription_source(filename, source):
    source = str(source or "auto").lower()
    if source not in TRANSCRIPTION_SOURCES:
        raise ValueError(f"Unknown transcription source: {source}")
    if source == "auto":
        return "vocals" if separation_manifest(filename) is not None else "mix"
    if source == "vocals" and separation_manifest(filename) is None:
        raise ValueError("The vocals stem is not available. Separate stems first or choose Full mix.")
    return source


def transcription_cache_key(path, source, model, language):
    values = _model(model)
    payload = {
        "version": TRANSCRIPTION_VERSION,
        "grouping_version": GROUPING_VERSION,
        "audio_sha256": audio_file_hash(path),
        "audio_source": source,
        "stem_model": SEPARATION_MODEL if source == "vocals" else None,
        "model_id": values["repo_id"],
        "model_revision": values["revision"],
        "language": _language(language),
        "chunk_seconds": CHUNK_SECONDS,
        "overlap_seconds": OVERLAP_SECONDS,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _cache_path(cache_key):
    if (
        not isinstance(cache_key, str)
        or len(cache_key) != 64
        or any(character not in "0123456789abcdef" for character in cache_key.lower())
    ):
        raise ValueError("Transcript cache key is invalid.")
    directory = Path(folder_paths.get_user_directory()) / "fl_audio_prompt_timeline" / "transcripts"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{cache_key}.json"


def load_cached_transcript(cache_key):
    path = _cache_path(cache_key)
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or value.get("version") != TRANSCRIPTION_VERSION:
        return None
    return value


def cached_transcript(filename, source, model, language):
    path = resolve_audio_path(filename)
    actual_source = resolve_transcription_source(filename, source)
    cache_key = transcription_cache_key(path, actual_source, model, language)
    return load_cached_transcript(cache_key)


def _mono_resampled(audio):
    waveform = audio["waveform"]
    if not isinstance(waveform, torch.Tensor) or waveform.ndim != 3 or waveform.shape[0] != 1:
        raise ValueError("Transcription expects one audio batch with channel-first samples.")
    waveform = waveform[0].float().mean(dim=0)
    sample_rate = int(audio["sample_rate"])
    if sample_rate != WHISPER_SAMPLE_RATE:
        waveform = torchaudio.functional.resample(waveform, sample_rate, WHISPER_SAMPLE_RATE)
    return waveform.cpu().numpy().astype(np.float32, copy=False)


def _timestamp(value, fallback_start, fallback_end):
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return fallback_start, fallback_end
    start = fallback_start if value[0] is None else float(value[0])
    end = fallback_end if value[1] is None else float(value[1])
    return start, end


def _chunk_words(result, chunk_start, chunk_end, keep_after):
    words = []
    chunks = result.get("chunks", []) if isinstance(result, dict) else []
    for value in chunks:
        text = str(value.get("text") or "").strip()
        if not text:
            continue
        start, end = _timestamp(value.get("timestamp"), 0.0, chunk_end - chunk_start)
        start = max(chunk_start, min(chunk_end, chunk_start + start))
        end = max(start + 0.001, min(chunk_end, chunk_start + end))
        if (start + end) / 2 < keep_after:
            continue
        words.append({"start": start, "end": end, "text": text})
    if words:
        return words
    text = str(result.get("text") or "").strip() if isinstance(result, dict) else ""
    if text and (chunk_start + chunk_end) / 2 >= keep_after:
        return [{"start": chunk_start, "end": chunk_end, "text": text}]
    return []


def _deduplicate_words(words):
    result = []
    for word in sorted(words, key=lambda value: (value["start"], value["end"])):
        text = word["text"].strip().casefold()
        duplicate = any(
            text == previous["text"].strip().casefold()
            and word["start"] < previous["end"]
            and previous["start"] < word["end"]
            for previous in result[-4:]
        )
        if not duplicate:
            result.append(word)
    return result


def _group_words(words):
    segments = []
    current = []
    for word in words:
        if current:
            gap = word["start"] - current[-1]["end"]
            text_length = sum(len(value["text"]) + 1 for value in current) + len(word["text"])
            if gap > 0.75 or len(current) >= 12 or text_length > 80:
                segments.append(current)
                current = []
        current.append(word)
        if word["text"].rstrip().endswith((".", "!", "?", "…")):
            segments.append(current)
            current = []
    if current:
        segments.append(current)
    result = []
    previous_end = 0.0
    for index, values in enumerate(segments):
        start = max(previous_end, float(values[0]["start"]))
        end = max(start + 0.001, float(values[-1]["end"]))
        previous_end = end
        result.append({
            "id": f"lyric-{index + 1:04d}",
            "start": start,
            "end": end,
            "text": " ".join(value["text"].strip() for value in values).strip(),
            "origin": "asr",
            "words": values,
        })
    return result


def _detected_language(result):
    if not isinstance(result, dict):
        return ""
    language = result.get("language")
    if isinstance(language, str):
        return language.strip().lower()[:32]
    chunks = result.get("chunks")
    if isinstance(chunks, list):
        for chunk in chunks:
            language = chunk.get("language") if isinstance(chunk, dict) else None
            if isinstance(language, str) and language.strip():
                return language.strip().lower()[:32]
    return ""


def _transcribe_chunk(whisper_model, processor, waveform, device, dtype, language):
    processed = processor(
        waveform,
        sampling_rate=WHISPER_SAMPLE_RATE,
        return_tensors="pt",
        return_attention_mask=True,
    )
    input_features = processed["input_features"].to(device=device, dtype=dtype)
    attention_mask = processed["attention_mask"].to(device=device)
    generate_kwargs = {
        "input_features": input_features,
        "attention_mask": attention_mask,
        "task": "transcribe",
        "return_timestamps": True,
        "return_token_timestamps": True,
    }
    actual_language = language
    if actual_language == "auto":
        language_id = int(whisper_model.detect_language(input_features=input_features)[0])
        for token, token_id in whisper_model.generation_config.lang_to_id.items():
            if token_id == language_id:
                actual_language = token.removeprefix("<|").removesuffix("|>")
                break
    if actual_language != "auto":
        generate_kwargs["language"] = actual_language
    generated = whisper_model.generate(**generate_kwargs)
    model_outputs = [{
        "tokens": generated["sequences"].cpu(),
        "token_timestamps": generated["token_timestamps"].cpu(),
    }]
    time_precision = processor.feature_extractor.chunk_length / whisper_model.config.max_source_positions
    text, optional = processor.tokenizer._decode_asr(
        model_outputs,
        return_timestamps="word",
        return_language=True,
        time_precision=time_precision,
    )
    result = {"text": text, **optional}
    if actual_language != "auto":
        result["language"] = actual_language
    return result


def transcribe_audio_file(
    filename,
    source="auto",
    model="large-v3-turbo",
    language="auto",
    allow_download=False,
    progress=None,
    cancel_event=None,
):
    path = resolve_audio_path(filename)
    language = _language(language)
    values = _model(model)
    actual_source = resolve_transcription_source(filename, source)
    cache_key = transcription_cache_key(path, actual_source, model, language)
    cached = load_cached_transcript(cache_key)
    if cached is not None:
        if progress:
            progress(1.0, "Using cached lyrics")
        return cached
    if cancel_event is not None and cancel_event.is_set():
        raise TranscriptionCancelled("Lyrics transcription cancelled.")

    model_path = _ensure_model(model, allow_download, progress)
    if actual_source == "vocals":
        audio = load_cached_stem(filename, "vocals")
    else:
        _, audio = load_audio_file(filename)
    waveform = _mono_resampled(audio)
    duration = len(waveform) / WHISPER_SAMPLE_RATE
    if duration <= 0:
        raise ValueError("Lyrics transcription requires non-empty audio.")

    if not _inference_lock.acquire(blocking=False):
        if progress:
            progress(0.02, "Waiting for another lyrics transcription")
        _inference_lock.acquire()

    whisper_model = None
    processor = None
    words = []
    detected_language = ""
    device = comfy.model_management.get_torch_device()
    dtype = (
        torch.float16
        if comfy.model_management.should_use_fp16(device=device, prioritize_performance=False)
        else torch.float32
    )
    try:
        if progress:
            progress(0.03, f"Loading {values['name']}")
        comfy.model_management.free_memory(values["memory_required"], device)
        whisper_model = AutoModelForSpeechSeq2Seq.from_pretrained(
            model_path,
            local_files_only=True,
            low_cpu_mem_usage=True,
            use_safetensors=True,
            torch_dtype=dtype,
        ).eval().to(device)
        processor = AutoProcessor.from_pretrained(model_path, local_files_only=True)

        chunk_length = max(1, round(CHUNK_SECONDS * WHISPER_SAMPLE_RATE))
        overlap = max(0, round(OVERLAP_SECONDS * WHISPER_SAMPLE_RATE))
        step = max(1, chunk_length - overlap)
        chunk_count = max(1, math.ceil(max(0, len(waveform) - overlap) / step))
        inference_language = language
        for index, start_sample in enumerate(range(0, len(waveform), step)):
            if cancel_event is not None and cancel_event.is_set():
                raise TranscriptionCancelled("Lyrics transcription cancelled.")
            end_sample = min(len(waveform), start_sample + chunk_length)
            chunk_start = start_sample / WHISPER_SAMPLE_RATE
            chunk_end = end_sample / WHISPER_SAMPLE_RATE
            result = _transcribe_chunk(
                whisper_model,
                processor,
                waveform[start_sample:end_sample],
                device,
                dtype,
                inference_language,
            )
            if not detected_language:
                detected_language = _detected_language(result)
                if language == "auto" and detected_language:
                    inference_language = detected_language
            keep_after = chunk_start if index == 0 else chunk_start + OVERLAP_SECONDS / 2
            words.extend(_chunk_words(result, chunk_start, chunk_end, keep_after))
            if progress:
                progress(
                    0.08 + 0.87 * (index + 1) / chunk_count,
                    f"Transcribing lyrics chunk {index + 1}/{chunk_count}",
                )
            if end_sample == len(waveform):
                break
    except TranscriptionCancelled:
        raise
    except Exception as error:
        raise AudioTranscriptionError(f"Lyrics transcription failed: {error}") from error
    finally:
        if whisper_model is not None:
            whisper_model.to("cpu")
        del processor, whisper_model
        comfy.model_management.soft_empty_cache()
        _inference_lock.release()

    transcript = {
        "version": TRANSCRIPTION_VERSION,
        "audio_file": filename,
        "audio_sha256": audio_file_hash(path),
        "cache_key": cache_key,
        "model_id": values["repo_id"],
        "model_revision": values["revision"],
        "requested_language": language,
        "detected_language": detected_language or (language if language != "auto" else ""),
        "audio_source": actual_source,
        "source_duration": duration,
        "segments": _group_words(_deduplicate_words(words)),
    }
    cache_path = _cache_path(cache_key)
    temporary_path = cache_path.with_suffix(".tmp")
    temporary_path.write_text(
        json.dumps(transcript, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    temporary_path.replace(cache_path)
    if progress:
        progress(1.0, "Lyrics transcription complete")
    return transcript
