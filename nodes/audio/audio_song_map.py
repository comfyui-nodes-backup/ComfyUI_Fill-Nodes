import hashlib
import json
import math
from pathlib import Path

import librosa
import numpy as np

import folder_paths

from .audio_files import audio_file_hash, load_audio_file, resolve_audio_path
from .audio_timeline import DETECTOR_VERSION, mono_numpy


SONG_MAP_VERSION = 2
_ENERGY_RATE = 10
_MAX_ENERGY_VALUES = 8192
_MIN_SECTION_BARS = 2
_MAX_SECTION_BARS = 16
_STRUCTURAL_ROLES = {
    "intro",
    "verse",
    "pre_chorus",
    "chorus",
    "bridge",
    "instrumental",
    "breakdown",
    "outro",
    "unknown",
}


def _clamp(value, minimum=0.0, maximum=1.0):
    return min(max(float(value), minimum), maximum)


def _ordered_times(values, duration):
    return sorted({float(value) for value in values if 0.0 <= float(value) < duration})


def _energy_curve(waveform, sample_rate):
    hop_length = max(1, round(sample_rate / 20))
    frame_length = max(2048, 2 ** math.ceil(math.log2(max(2, hop_length * 2))))
    rms = librosa.feature.rms(
        y=waveform,
        frame_length=frame_length,
        hop_length=hop_length,
    )[0]
    times = librosa.frames_to_time(
        np.arange(len(rms)),
        sr=sample_rate,
        hop_length=hop_length,
    )
    if not len(rms):
        return np.zeros(1, dtype=np.float32), np.zeros(1, dtype=np.float32)
    low, high = np.percentile(rms, [10, 95])
    if high - low <= 1e-8:
        normalized = np.zeros_like(rms, dtype=np.float32)
    else:
        normalized = np.clip((rms - low) / (high - low), 0.0, 1.0).astype(np.float32)
    return times.astype(np.float32, copy=False), normalized


def _energy_preview(times, energy, duration):
    count = min(_MAX_ENERGY_VALUES, max(2, math.ceil(duration * _ENERGY_RATE)))
    preview_times = np.linspace(0.0, duration, count, endpoint=False, dtype=np.float32)
    values = np.interp(preview_times, times, energy, left=energy[0], right=energy[-1])
    return {
        "version": 1,
        "duration": float(duration),
        "rate": float(count / duration),
        "values": np.round(values, 4).tolist(),
    }


def _meter(beat_times, downbeat_times, source_analysis):
    if len(downbeat_times) < 2 or len(beat_times) < 2:
        return {"beats_per_bar": 0, "confidence": 0.0}
    counts = []
    beats = np.asarray(beat_times)
    for start, end in zip(downbeat_times[:-1], downbeat_times[1:]):
        count = int(np.count_nonzero((beats >= start - 1e-4) & (beats < end - 1e-4)))
        if 2 <= count <= 12:
            counts.append(count)
    if not counts:
        return {"beats_per_bar": 0, "confidence": 0.0}
    beats_per_bar = int(round(float(np.median(counts))))
    agreement = sum(count == beats_per_bar for count in counts) / len(counts)
    confidences = source_analysis.get("detected_downbeat_confidences", [])
    detector_confidence = float(np.mean(confidences)) if confidences else 1.0
    return {
        "beats_per_bar": beats_per_bar,
        "confidence": round(_clamp(agreement * detector_confidence), 3),
    }


def _bar_boundaries(beat_times, downbeat_times, duration, beats_per_bar):
    boundaries = _ordered_times(downbeat_times, duration)
    if len(boundaries) < 2 and beat_times:
        stride = beats_per_bar if beats_per_bar >= 2 else 4
        boundaries = _ordered_times(beat_times[::stride], duration)
    if not boundaries or boundaries[0] > 0.05:
        boundaries.insert(0, 0.0)
    if duration - boundaries[-1] > 0.05:
        boundaries.append(float(duration))
    else:
        boundaries[-1] = float(duration)
    if len(boundaries) < 2:
        boundaries = [0.0, float(duration)]
    return boundaries


def _interval_values(times, values, start, end):
    mask = (times >= start) & (times < end)
    if np.any(mask):
        return values[mask]
    midpoint = (start + end) / 2.0
    return values[[int(np.argmin(np.abs(times - midpoint)))]]


def _bar_profiles(boundaries, energy_times, energy, onset_times):
    profiles = []
    onsets = np.asarray(onset_times, dtype=np.float32)
    for start, end in zip(boundaries[:-1], boundaries[1:]):
        values = _interval_values(energy_times, energy, start, end)
        duration = max(1e-6, end - start)
        onset_count = int(np.count_nonzero((onsets >= start) & (onsets < end)))
        profiles.append({
            "start": float(start),
            "end": float(end),
            "energy_mean": float(np.mean(values)),
            "energy_peak": float(np.max(values)),
            "onset_density": onset_count / duration,
        })
    return profiles


def _rising_region(values, start):
    end = start + 1
    while end + 1 < len(values) and values[end + 1] >= values[end] - 0.035:
        end += 1
    return end


def _falling_region(values, start):
    end = start + 1
    while end + 1 < len(values) and values[end + 1] <= values[end] + 0.035:
        end += 1
    return end


def _sustained_regions(mask, minimum):
    regions = []
    start = None
    for index, active in enumerate([*mask, False]):
        if active and start is None:
            start = index
        elif not active and start is not None:
            if index - start >= minimum:
                regions.append((start, index - 1))
            start = None
    return regions


def detect_moments(bar_profiles):
    if len(bar_profiles) < 2:
        return []
    energy = np.asarray([bar["energy_mean"] for bar in bar_profiles], dtype=np.float32)
    onset = np.asarray([bar["onset_density"] for bar in bar_profiles], dtype=np.float32)
    dynamic_range = float(np.percentile(energy, 90) - np.percentile(energy, 10))
    if dynamic_range < 0.12:
        return []

    moments = []
    index = 0
    while index + 1 < len(energy):
        if energy[index + 1] - energy[index] < 0.035:
            index += 1
            continue
        end = _rising_region(energy, index)
        rise = float(energy[end] - energy[index])
        bars = end - index
        if bars >= 2 and rise >= 0.18 and rise / bars >= 0.05:
            moments.append({
                "type": "build",
                "start": bar_profiles[index]["start"],
                "end": bar_profiles[end]["end"],
                "anchor": bar_profiles[end]["end"],
                "strength": round(_clamp(rise / 0.5), 3),
            })
        index = max(index + 1, end)

    index = 0
    while index + 1 < len(energy):
        if energy[index] - energy[index + 1] < 0.035:
            index += 1
            continue
        end = _falling_region(energy, index)
        fall = float(energy[index] - energy[end])
        bars = end - index
        if bars >= 2 and fall >= 0.18 and fall / bars >= 0.05:
            moments.append({
                "type": "release",
                "start": bar_profiles[index]["start"],
                "end": bar_profiles[end]["end"],
                "anchor": bar_profiles[end]["end"],
                "strength": round(_clamp(fall / 0.5), 3),
            })
        index = max(index + 1, end)

    high = float(np.percentile(energy, 80))
    last_drop = -10
    for position in range(1, len(energy)):
        jump = float(energy[position] - energy[position - 1])
        if jump < 0.25 or energy[position] < high or position - last_drop < 2:
            continue
        moment = bar_profiles[position]["start"]
        moments.append({
            "type": "drop",
            "start": moment,
            "end": moment,
            "anchor": moment,
            "strength": round(_clamp(jump / 0.5), 3),
        })
        last_drop = position

    peak_threshold = float(np.percentile(energy, 85))
    for start, end in _sustained_regions(energy >= peak_threshold, 2):
        moments.append({
            "type": "peak",
            "start": bar_profiles[start]["start"],
            "end": bar_profiles[end]["end"],
            "anchor": bar_profiles[start]["start"],
            "strength": round(_clamp(float(np.mean(energy[start:end + 1]))), 3),
        })

    low_threshold = min(1.0, float(np.percentile(energy, 25)) + 0.03)
    onset_threshold = float(np.median(onset) * 0.75)
    breakdown_mask = (energy <= low_threshold) & (onset <= onset_threshold)
    for start, end in _sustained_regions(breakdown_mask, 2):
        prior = energy[max(0, start - 2):start]
        if not len(prior) or float(np.mean(prior)) - float(np.mean(energy[start:end + 1])) < 0.15:
            continue
        moments.append({
            "type": "breakdown",
            "start": bar_profiles[start]["start"],
            "end": bar_profiles[end]["end"],
            "anchor": bar_profiles[start]["start"],
            "strength": round(_clamp(
                (float(np.mean(prior)) - float(np.mean(energy[start:end + 1]))) / 0.5
            ), 3),
        })

    return sorted(moments, key=_moment_sort_key)


def _moment_sort_key(moment):
    order = {
        "build": 0,
        "turnaround": 1,
        "transition": 2,
        "fill": 3,
        "drop": 4,
        "peak": 5,
        "breakdown": 6,
        "release": 7,
        "custom": 8,
    }
    return moment["start"], order.get(moment["type"], 99)


def detect_turnarounds(bar_profiles, sections, phrases, moments):
    if len(bar_profiles) < 4 or len(phrases) < 2:
        return []
    section_by_id = {section["id"]: section for section in sections}
    result = []
    for phrase, following in zip(phrases[:-1], phrases[1:]):
        section = section_by_id.get(phrase["section_id"])
        next_section = section_by_id.get(following["section_id"])
        if not section or not next_section or section["family"] != next_section["family"]:
            continue
        if abs(float(phrase["end"]) - float(following["start"])) > 1e-3:
            continue
        phrase_bars = [
            index for index, bar in enumerate(bar_profiles)
            if bar["start"] >= phrase["start"] - 1e-3 and bar["end"] <= phrase["end"] + 1e-3
        ]
        following_bars = [
            index for index, bar in enumerate(bar_profiles)
            if bar["start"] >= following["start"] - 1e-3 and bar["end"] <= following["end"] + 1e-3
        ]
        if len(phrase_bars) < 2 or not following_bars:
            continue
        candidate_count = min(2, max(1, len(phrase_bars) // 2))
        candidate_bars = phrase_bars[-candidate_count:]
        baseline_bars = phrase_bars[:-candidate_count]
        if not baseline_bars:
            baseline_bars = list(range(max(0, candidate_bars[0] - 2), candidate_bars[0]))
        if not baseline_bars:
            continue
        following_bars = following_bars[:2]

        energy_before = float(np.mean([bar_profiles[index]["energy_mean"] for index in baseline_bars]))
        energy_candidate = float(np.mean([bar_profiles[index]["energy_mean"] for index in candidate_bars]))
        energy_after = float(np.mean([bar_profiles[index]["energy_mean"] for index in following_bars]))
        if abs(energy_before - energy_after) > 0.12:
            continue
        onset_before = float(np.mean([bar_profiles[index]["onset_density"] for index in baseline_bars]))
        onset_candidate = float(np.mean([bar_profiles[index]["onset_density"] for index in candidate_bars]))
        energy_shift = abs(energy_candidate - energy_before)
        onset_shift = abs(onset_candidate - onset_before) / max(0.1, onset_before)
        if energy_shift < 0.08 and onset_shift < 0.4:
            continue

        start = bar_profiles[candidate_bars[0]]["start"]
        end = bar_profiles[candidate_bars[-1]]["end"]
        if any(
            moment["type"] in {"build", "drop", "breakdown"}
            and (
                start <= moment["start"] <= end
                or min(end, moment["end"]) > max(start, moment["start"])
            )
            for moment in moments
        ):
            continue
        evidence = max(energy_shift / 0.2, onset_shift)
        result.append({
            "type": "turnaround",
            "start": float(start),
            "end": float(end),
            "anchor": float(end),
            "strength": round(_clamp(max(energy_shift / 0.25, onset_shift / 1.25)), 3),
            "confidence": round(_clamp(0.5 + min(0.35, evidence * 0.2)), 3),
            "source": "analysis",
        })
    return result


def _bar_chroma(waveform, sample_rate, boundaries):
    hop_length = 2048
    chroma = librosa.feature.chroma_stft(
        y=waveform,
        sr=sample_rate,
        n_fft=4096,
        hop_length=hop_length,
    )
    times = librosa.frames_to_time(
        np.arange(chroma.shape[1]),
        sr=sample_rate,
        hop_length=hop_length,
    )
    values = []
    for start, end in zip(boundaries[:-1], boundaries[1:]):
        mask = (times >= start) & (times < end)
        if np.any(mask):
            values.append(np.mean(chroma[:, mask], axis=1))
        else:
            midpoint = (start + end) / 2.0
            values.append(chroma[:, int(np.argmin(np.abs(times - midpoint)))])
    return np.asarray(values, dtype=np.float32)


def _feature_matrix(bar_chroma, bar_profiles):
    energy_mean = np.asarray([bar["energy_mean"] for bar in bar_profiles], dtype=np.float32)
    energy_peak = np.asarray([bar["energy_peak"] for bar in bar_profiles], dtype=np.float32)
    onset = np.asarray([bar["onset_density"] for bar in bar_profiles], dtype=np.float32)
    if np.max(onset) > 0:
        onset = onset / np.max(onset)
    raw = np.column_stack((bar_chroma, energy_mean, energy_peak, onset))
    mean = np.mean(raw, axis=0, keepdims=True)
    scale = np.std(raw, axis=0, keepdims=True)
    normalized = (raw - mean) / np.where(scale > 1e-6, scale, 1.0)
    return raw.astype(np.float32), normalized.T.astype(np.float32)


def _section_boundaries(features, duration, bar_count):
    if bar_count < _MIN_SECTION_BARS * 2:
        return [0, bar_count]
    desired = max(1, min(10, round(duration / 30.0), bar_count // _MIN_SECTION_BARS))
    if desired <= 1:
        return [0, bar_count]
    boundaries = sorted({int(value) for value in librosa.segment.agglomerative(features, desired)})
    boundaries = [value for value in boundaries if 0 <= value < bar_count]
    if not boundaries or boundaries[0] != 0:
        boundaries.insert(0, 0)
    result = [0]
    for boundary in boundaries[1:]:
        if boundary - result[-1] >= _MIN_SECTION_BARS:
            result.append(boundary)
    if bar_count - result[-1] < _MIN_SECTION_BARS and len(result) > 1:
        result.pop()
    result.append(bar_count)
    expanded = [result[0]]
    for boundary in result[1:]:
        length = boundary - expanded[-1]
        parts = math.ceil(length / _MAX_SECTION_BARS)
        base, remainder = divmod(length, parts)
        for part in range(parts - 1):
            expanded.append(expanded[-1] + base + (1 if part < remainder else 0))
        expanded.append(boundary)
    return expanded


def _cosine(left, right):
    denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
    if denominator <= 1e-8:
        return 0.0
    return float(np.dot(left, right) / denominator)


def _family_name(index):
    value = ""
    while True:
        value = chr(ord("A") + index % 26) + value
        index = index // 26 - 1
        if index < 0:
            return value


def _section_families(vectors, threshold=0.8):
    representatives = []
    members = []
    result = []
    for vector in vectors:
        similarities = [_cosine(vector, representative) for representative in representatives]
        if result:
            similarities[result[-1]] = -1.0
        best = int(np.argmax(similarities)) if similarities else -1
        if best >= 0 and similarities[best] >= threshold:
            members[best].append(vector)
            representatives[best] = np.mean(members[best], axis=0)
            result.append(best)
        else:
            representatives.append(vector.copy())
            members.append([vector])
            result.append(len(representatives) - 1)
    return [_family_name(index) for index in result]


def _section_overlap(section, moment):
    if moment["start"] == moment["end"]:
        return section["start"] <= moment["start"] < section["end"]
    return min(section["end"], moment["end"]) > max(section["start"], moment["start"])


def _assign_roles(sections, moments):
    if not sections:
        return
    family_counts = {}
    for section in sections:
        family_counts[section["family"]] = family_counts.get(section["family"], 0) + 1
    song_median = float(np.median([section["energy"]["mean"] for section in sections]))
    family_energy = {}
    for family in family_counts:
        family_energy[family] = float(np.mean([
            section["energy"]["mean"] for section in sections if section["family"] == family
        ]))
    repeated = [family for family, count in family_counts.items() if count >= 2]
    chorus_family = max(repeated, key=family_energy.get) if repeated else None
    if chorus_family is not None and family_energy[chorus_family] < song_median + 0.02:
        chorus_family = None

    for section in sections:
        role = "unknown"
        confidence = 0.0
        breakdown = any(
            moment["type"] == "breakdown" and _section_overlap(section, moment)
            for moment in moments
        )
        if breakdown:
            role, confidence = "breakdown", 0.72
        elif section["family"] == chorus_family:
            role = "chorus"
            confidence = 0.6 + min(0.2, max(0.0, section["energy"]["mean"] - song_median))
        elif family_counts[section["family"]] >= 2:
            role, confidence = "verse", 0.58
        section["role"] = {
            "value": role if role in _STRUCTURAL_ROLES else "unknown",
            "source": "heuristic",
            "confidence": round(confidence, 3),
        }

    first = sections[0]
    if len(sections) > 1 and (
        family_counts[first["family"]] == 1 or first["energy"]["mean"] <= song_median
    ):
        first["role"] = {"value": "intro", "source": "heuristic", "confidence": 0.7}
    last = sections[-1]
    if len(sections) > 1 and (
        family_counts[last["family"]] == 1 or last["energy"]["trend"] == "falling"
    ):
        last["role"] = {"value": "outro", "source": "heuristic", "confidence": 0.68}

    for index, section in enumerate(sections[:-1]):
        following = sections[index + 1]
        if following["role"]["value"] != "chorus":
            continue
        bars = section["bar_end"] - section["bar_start"]
        if bars <= 8 and section["energy"]["trend"] == "rising":
            section["role"] = {
                "value": "pre_chorus",
                "source": "heuristic",
                "confidence": 0.66,
            }


def _sections(boundaries, bar_boundaries, bar_profiles, family_features, moments):
    vectors = [np.mean(family_features[start:end], axis=0) for start, end in zip(boundaries[:-1], boundaries[1:])]
    families = _section_families(vectors)
    sections = []
    for index, (start_bar, end_bar) in enumerate(zip(boundaries[:-1], boundaries[1:])):
        profiles = bar_profiles[start_bar:end_bar]
        means = np.asarray([bar["energy_mean"] for bar in profiles], dtype=np.float32)
        peaks = np.asarray([bar["energy_peak"] for bar in profiles], dtype=np.float32)
        change = float(means[-1] - means[0])
        trend = "rising" if change >= 0.08 else "falling" if change <= -0.08 else "steady"
        sections.append({
            "id": f"section-{index}",
            "start": float(bar_boundaries[start_bar]),
            "end": float(bar_boundaries[end_bar]),
            "bar_start": int(start_bar),
            "bar_end": int(end_bar),
            "family": families[index],
            "role": {"value": "unknown", "source": "heuristic", "confidence": 0.0},
            "energy": {
                "mean": round(float(np.mean(means)), 3),
                "peak": round(float(np.max(peaks)), 3),
                "change": round(change, 3),
                "trend": trend,
            },
            "rhythm": {
                "onset_density": round(float(np.mean([
                    bar["onset_density"] for bar in profiles
                ])), 3),
            },
        })
    _assign_roles(sections, moments)
    return sections


def _phrases(sections, bar_boundaries):
    phrases = []
    for section in sections:
        section_bars = section["bar_end"] - section["bar_start"]
        phrase_bars = 8 if section_bars >= 16 else 4
        position = section["bar_start"]
        index = 0
        while position < section["bar_end"]:
            end = min(section["bar_end"], position + phrase_bars)
            phrases.append({
                "section_id": section["id"],
                "start": float(bar_boundaries[position]),
                "end": float(bar_boundaries[end]),
                "index": index,
                "bar_count": end - position,
            })
            position = end
            index += 1
    return phrases


def analyze_song_map(waveform, sample_rate, source_analysis):
    waveform = np.asarray(waveform, dtype=np.float32)
    if waveform.ndim != 1 or not len(waveform):
        raise ValueError("Song map analysis expects a non-empty mono waveform.")
    duration = len(waveform) / sample_rate
    beat_times = _ordered_times(source_analysis.get("beat_times", []), duration)
    downbeat_times = _ordered_times(source_analysis.get("downbeat_times", []), duration)
    meter = _meter(beat_times, downbeat_times, source_analysis)
    energy_times, energy = _energy_curve(waveform, sample_rate)
    onset_env = librosa.onset.onset_strength(y=waveform, sr=sample_rate)
    onset_frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sample_rate)
    onset_times = librosa.frames_to_time(onset_frames, sr=sample_rate)
    bar_boundaries = _bar_boundaries(
        beat_times,
        downbeat_times,
        duration,
        meter["beats_per_bar"],
    )
    bar_profiles = _bar_profiles(bar_boundaries, energy_times, energy, onset_times)
    moments = detect_moments(bar_profiles)
    chroma = _bar_chroma(waveform, sample_rate, bar_boundaries)
    _, normalized_features = _feature_matrix(chroma, bar_profiles)
    boundaries = _section_boundaries(normalized_features, duration, len(bar_profiles))
    sections = _sections(
        boundaries,
        bar_boundaries,
        bar_profiles,
        normalized_features.T,
        moments,
    )
    phrases = _phrases(sections, bar_boundaries)
    moments.extend(detect_turnarounds(bar_profiles, sections, phrases, moments))
    moments.sort(key=_moment_sort_key)
    return {
        "type": "fl_audio_song_map",
        "version": SONG_MAP_VERSION,
        "source_duration": float(duration),
        "analysis_source": "mix",
        "meter": meter,
        "energy_preview": _energy_preview(energy_times, energy, duration),
        "sections": sections,
        "phrases": phrases,
        "moments": moments,
    }


def song_map_cache_key(path):
    values = {
        "song_map_version": SONG_MAP_VERSION,
        "audio_sha256": audio_file_hash(path),
        "detector_version": DETECTOR_VERSION,
    }
    encoded = json.dumps(values, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _cache_path(cache_key):
    directory = Path(folder_paths.get_user_directory()) / "fl_audio_prompt_timeline" / "song_maps"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{cache_key}.json"


def analyze_song_map_file(filename, source_analysis):
    path = resolve_audio_path(filename)
    cache_key = song_map_cache_key(path)
    cache_path = _cache_path(cache_key)
    cache_hit = False
    song_map = None
    if cache_path.is_file():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            cached = None
        if (
            isinstance(cached, dict)
            and cached.get("type") == "fl_audio_song_map"
            and cached.get("version") == SONG_MAP_VERSION
        ):
            song_map = cached
            cache_hit = True
    if song_map is None:
        _, audio = load_audio_file(filename)
        song_map = analyze_song_map(
            mono_numpy(audio),
            int(audio["sample_rate"]),
            source_analysis,
        )
        temporary_path = cache_path.with_suffix(".tmp")
        temporary_path.write_text(
            json.dumps(song_map, separators=(",", ":")),
            encoding="utf-8",
        )
        temporary_path.replace(cache_path)
    return {
        **song_map,
        "cache_key": cache_key,
        "analysis_cache_hit": cache_hit,
    }
