import { sourceTimes } from "./audio_timeline_coordinates.js";
import { normalizeSongMap } from "./audio_prompt_song_map.js";

const SOURCE_ANALYSIS_VERSION = 1;
const EPSILON = 1e-6;

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function normalizeWaveformPreview(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.peaks) || value.peaks.length < 2 ||
      value.peaks.length % 2 !== 0) {
    return null;
  }
  const duration = finiteNumber(value.duration);
  const scale = finiteNumber(value.scale);
  if (!(duration > 0) || !(scale > 0)) return null;
  const peaks = value.peaks.map((peak) => finiteNumber(peak));
  return { version: 1, duration, scale, peaks };
}

export function cropWaveformPreview(preview, startSeconds, duration) {
  if (!preview || !(duration > 0)) return null;
  const bucketCount = preview.peaks.length / 2;
  const startBucket = clamp(Math.floor(startSeconds / preview.duration * bucketCount), 0, bucketCount - 1);
  const endBucket = clamp(
    Math.ceil((startSeconds + duration) / preview.duration * bucketCount),
    startBucket + 1,
    bucketCount,
  );
  return {
    version: 1,
    duration,
    scale: preview.scale,
    peaks: preview.peaks.slice(startBucket * 2, endBucket * 2),
  };
}

function analysisArray(value, snake, camel = snake) {
  const values = value?.[snake] ?? value?.[camel];
  return Array.isArray(values) ? values.map((entry) => finiteNumber(entry)) : [];
}

export function sourceAnalysisValue(value) {
  if (!value || value.type !== "fl_audio_source_analysis" ||
      finiteNumber(value.version) !== SOURCE_ANALYSIS_VERSION) {
    return null;
  }
  const duration = finiteNumber(
    value.source_duration ?? value.sourceDuration ?? value.audio_duration ?? value.audioDuration,
  );
  if (!(duration > 0)) return null;
  return {
    type: "fl_audio_source_analysis",
    version: SOURCE_ANALYSIS_VERSION,
    analysisVersion: finiteNumber(value.analysis_version ?? value.analysisVersion),
    bpm: finiteNumber(value.bpm),
    baseGridIntervalSeconds: finiteNumber(
      value.base_grid_interval_seconds ?? value.baseGridIntervalSeconds,
    ),
    beatTimes: analysisArray(value, "beat_times", "beatTimes"),
    downbeatTimes: analysisArray(value, "downbeat_times", "downbeatTimes"),
    detectedBeatTimes: analysisArray(value, "detected_beat_times", "detectedBeatTimes"),
    detectedDownbeatTimes: analysisArray(value, "detected_downbeat_times", "detectedDownbeatTimes"),
    detectedBeatConfidences: analysisArray(value, "detected_beat_confidences", "detectedBeatConfidences"),
    detectedDownbeatConfidences: analysisArray(
      value,
      "detected_downbeat_confidences",
      "detectedDownbeatConfidences",
    ),
    onsetTimes: analysisArray(value, "onset_times", "onsetTimes"),
    drumTimes: value.drum_times || value.drumTimes || {},
    duration,
    supportsHalfTime: value.supports_half_time == null && value.supportsHalfTime == null
      ? true
      : Boolean(value.supports_half_time ?? value.supportsHalfTime),
    waveformPreview: normalizeWaveformPreview(value.waveform_preview || value.waveformPreview),
    waveformPreviewStart: finiteNumber(
      value.waveform_preview_start ?? value.waveformPreviewStart,
    ),
    cacheKey: String(value.cache_key || value.cacheKey || ""),
    audioFile: String(value.audio_file || value.audioFile || ""),
    detector: value.detector || null,
    detectorVersion: String(value.detector_version || value.detectorVersion || ""),
    bpmSource: String(value.bpm_source || value.bpmSource || ""),
    analysisSource: String(value.analysis_source || value.analysisSource || "mix"),
    beatAnalysisSource: String(value.beat_analysis_source || value.beatAnalysisSource || "mix"),
    analysisCacheHit: Boolean(value.analysis_cache_hit ?? value.analysisCacheHit),
    songMap: normalizeSongMap(value.song_map ?? value.songMap),
  };
}

export function sourceAnalysisFromCropPayload(value) {
  if (!value) return null;
  const sourceStart = Math.max(0, finiteNumber(value.source_start ?? value.sourceStart));
  const cropDuration = Math.max(0, finiteNumber(value.audio_duration ?? value.audioDuration));
  const sourceDuration = Math.max(
    sourceStart + cropDuration,
    finiteNumber(value.source_duration ?? value.sourceDuration),
  );
  if (!(cropDuration > 0) || !(sourceDuration > 0)) return null;

  const offset = finiteNumber(value.beat_offset_ms ?? value.beatOffsetMs) / 1000;
  const payloadBeats = analysisArray(value, "beat_times", "beatTimes");
  const payloadDownbeats = analysisArray(value, "downbeat_times", "downbeatTimes");
  const baseBeats = analysisArray(value, "base_beat_times", "baseBeatTimes");
  const baseDownbeats = analysisArray(value, "base_downbeat_times", "baseDownbeatTimes");
  const baseDetectedBeats = analysisArray(
    value,
    "base_detected_beat_times",
    "baseDetectedBeatTimes",
  );
  const baseDetectedDownbeats = analysisArray(
    value,
    "base_detected_downbeat_times",
    "baseDetectedDownbeatTimes",
  );
  const baseBeatConfidences = analysisArray(
    value,
    "base_detected_beat_confidences",
    "baseDetectedBeatConfidences",
  );
  const baseDownbeatConfidences = analysisArray(
    value,
    "base_detected_downbeat_confidences",
    "baseDetectedDownbeatConfidences",
  );
  const drums = { ...(value.drum_times || value.drumTimes || {}) };
  for (const [snake, camel] of [
    ["kick_times", "kickTimes"],
    ["snare_times", "snareTimes"],
    ["hihat_times", "hihatTimes"],
  ]) {
    drums[snake] = sourceTimes(analysisArray(drums, snake, camel), sourceStart);
  }

  return sourceAnalysisValue({
    type: "fl_audio_source_analysis",
    version: SOURCE_ANALYSIS_VERSION,
    analysis_version: value.analysis_version ?? value.analysisVersion,
    bpm: value.bpm,
    base_grid_interval_seconds: value.base_grid_interval_seconds ?? value.baseGridIntervalSeconds,
    beat_times: sourceTimes(
      baseBeats.length ? baseBeats : payloadBeats.map((entry) => entry - offset),
      sourceStart,
    ),
    downbeat_times: sourceTimes(
      baseDownbeats.length ? baseDownbeats : payloadDownbeats.map((entry) => entry - offset),
      sourceStart,
    ),
    detected_beat_times: sourceTimes(
      baseDetectedBeats.length
        ? baseDetectedBeats
        : analysisArray(value, "detected_beat_times", "detectedBeatTimes"),
      sourceStart,
    ),
    detected_downbeat_times: sourceTimes(
      baseDetectedDownbeats.length
        ? baseDetectedDownbeats
        : analysisArray(value, "detected_downbeat_times", "detectedDownbeatTimes"),
      sourceStart,
    ),
    detected_beat_confidences: baseBeatConfidences.length
      ? baseBeatConfidences
      : analysisArray(value, "detected_beat_confidences", "detectedBeatConfidences"),
    detected_downbeat_confidences: baseDownbeatConfidences.length
      ? baseDownbeatConfidences
      : analysisArray(value, "detected_downbeat_confidences", "detectedDownbeatConfidences"),
    onset_times: sourceTimes(analysisArray(value, "onset_times", "onsetTimes"), sourceStart),
    drum_times: drums,
    source_duration: sourceDuration,
    supports_half_time: false,
    waveform_preview: value.waveform_preview || value.waveformPreview,
    waveform_preview_start: sourceStart,
    cache_key: value.cache_key || value.cacheKey,
    audio_file: value.audio_file || value.audioFile,
    detector: value.detector,
    detector_version: value.detector_version || value.detectorVersion,
    bpm_source: value.bpm_source || value.bpmSource,
    analysis_source: value.analysis_source || value.analysisSource,
    beat_analysis_source: value.beat_analysis_source || value.beatAnalysisSource,
    analysis_cache_hit: value.analysis_cache_hit ?? value.analysisCacheHit,
    song_map: value.song_map || value.songMap,
  });
}

export function medianInterval(values) {
  const intervals = values
    .slice(1)
    .map((value, index) => value - values[index])
    .filter((value) => value > EPSILON)
    .sort((left, right) => left - right);
  if (!intervals.length) return 0;
  const middle = Math.floor(intervals.length / 2);
  return intervals.length % 2
    ? intervals[middle]
    : (intervals[middle - 1] + intervals[middle]) / 2;
}
