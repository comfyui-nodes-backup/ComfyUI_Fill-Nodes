export const LYRICS_TIMELINE_VERSION = 1;

const LYRIC_ORIGINS = new Set(["asr", "corrected", "manual", "lrc", "srt"]);
const MAX_SEGMENTS = 4096;
const MAX_LINE_CHARS = 1000;
const MAX_VISIBLE_LINES = 512;
const MAX_BOX_LINES = 32;
const EPSILON = 1e-6;

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedText(value, maximum = MAX_LINE_CHARS) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function mixHash(hash, value) {
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeWord(value, segmentStart, segmentEnd) {
  if (!value || typeof value !== "object") return null;
  const start = finiteNumber(value.start, -1);
  const end = finiteNumber(value.end, -1);
  const text = boundedText(value.text, 160);
  if (!text || start < segmentStart - EPSILON || end > segmentEnd + EPSILON || end <= start) {
    return null;
  }
  return { start, end, text };
}

function normalizeSegment(value, index) {
  if (!value || typeof value !== "object") return null;
  const start = finiteNumber(value.start, -1);
  const end = finiteNumber(value.end, -1);
  const text = boundedText(value.text);
  if (!text || start < 0 || end <= start) return null;
  const origin = LYRIC_ORIGINS.has(value.origin) ? value.origin : "asr";
  const words = Array.isArray(value.words)
    ? value.words
      .map(word => normalizeWord(word, start, end))
      .filter(Boolean)
      .sort((left, right) => left.start - right.start)
    : [];
  return {
    id: boundedText(value.id || `lyric-${String(index + 1).padStart(4, "0")}`, 96),
    start,
    end,
    text,
    origin,
    ...(words.length ? { words } : {}),
  };
}

export function validateLyricsSegments(segments) {
  if (!Array.isArray(segments) || segments.length > MAX_SEGMENTS) {
    throw new Error(`Lyrics must contain at most ${MAX_SEGMENTS} segments.`);
  }
  const ids = new Set();
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!segment || !segment.id || !segment.text || segment.start < 0 || segment.end <= segment.start) {
      throw new Error(`Lyric segment ${index + 1} is invalid.`);
    }
    if (ids.has(segment.id)) throw new Error(`Lyric segment ID ${segment.id} is duplicated.`);
    ids.add(segment.id);
    if (index && segment.start < segments[index - 1].end - EPSILON) {
      throw new Error("Lyric segments must be ordered without overlaps.");
    }
  }
  return segments;
}

export function normalizeLyricsTimeline(value) {
  if (!value || typeof value !== "object" || finiteNumber(value.version) !== LYRICS_TIMELINE_VERSION) {
    return null;
  }
  const rawSegments = value.segments;
  if (!Array.isArray(rawSegments) || rawSegments.length > MAX_SEGMENTS) return null;
  const segments = rawSegments
    .map((segment, index) => normalizeSegment(segment, index))
    .filter(Boolean)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (segments.length !== rawSegments.length) return null;
  try {
    validateLyricsSegments(segments);
  } catch {
    return null;
  }
  return {
    version: LYRICS_TIMELINE_VERSION,
    audioFile: String(value.audio_file ?? value.audioFile ?? ""),
    audioSha256: String(value.audio_sha256 ?? value.audioSha256 ?? "").slice(0, 128),
    cacheKey: String(value.cache_key ?? value.cacheKey ?? "").slice(0, 128),
    modelId: String(value.model_id ?? value.modelId ?? "").slice(0, 200),
    modelRevision: String(value.model_revision ?? value.modelRevision ?? "").slice(0, 128),
    requestedLanguage: String(value.requested_language ?? value.requestedLanguage ?? "auto").slice(0, 32),
    detectedLanguage: String(value.detected_language ?? value.detectedLanguage ?? "").slice(0, 32),
    audioSource: String(value.audio_source ?? value.audioSource ?? "mix").slice(0, 24),
    segments,
  };
}

export function lyricsTimelineForStorage(timeline) {
  const normalized = normalizeLyricsTimeline(timeline);
  if (!normalized) return null;
  return {
    version: LYRICS_TIMELINE_VERSION,
    audio_file: normalized.audioFile,
    audio_sha256: normalized.audioSha256,
    cache_key: normalized.cacheKey,
    model_id: normalized.modelId,
    model_revision: normalized.modelRevision,
    requested_language: normalized.requestedLanguage,
    detected_language: normalized.detectedLanguage,
    audio_source: normalized.audioSource,
    segments: normalized.segments.map(segment => ({
      id: segment.id,
      start: segment.start,
      end: segment.end,
      text: segment.text,
      origin: segment.origin,
      ...(segment.words?.length ? { words: segment.words } : {}),
    })),
  };
}

export function lyricsTimelineRevision(timeline, options = {}) {
  const normalized = normalizeLyricsTimeline(timeline);
  if (!normalized) return "";
  const projection = [
    finiteNumber(options.fps, 24),
    finiteNumber(options.cropStart),
    finiteNumber(options.totalFrames),
    options.includeInWriter === false ? 0 : 1,
    String(options.audioFile || ""),
  ].join("\u001f");
  let left = mixHash(2166136261, projection);
  let right = mixHash(2246822507, projection.split("").reverse().join(""));
  for (const segment of normalized.segments) {
    const value = `${segment.id}\u001f${segment.start}\u001f${segment.end}\u001f${segment.origin}\u001f${segment.text}\u001e`;
    left = mixHash(left, value);
    right = mixHash(right, value.split("").reverse().join(""));
  }
  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
}

export function isLyricsTimelineCurrent(timeline, audioFile) {
  const normalized = normalizeLyricsTimeline(timeline);
  return Boolean(normalized && normalized.audioFile && normalized.audioFile === String(audioFile || ""));
}

export function nextLyricsSegmentId(timeline) {
  const used = new Set((normalizeLyricsTimeline(timeline)?.segments || []).map(segment => segment.id));
  let number = 1;
  while (used.has(`manual-lyric-${number}`)) number++;
  return `manual-lyric-${number}`;
}

function timestampSeconds(hours, minutes, seconds, fraction) {
  const scale = fraction.length === 2 ? 100 : fraction.length === 1 ? 10 : 1000;
  return Number(hours || 0) * 3600 + Number(minutes || 0) * 60 + Number(seconds) + Number(fraction) / scale;
}

export function parseLrcLyrics(text, options = {}) {
  const entries = [];
  let offset = 0;
  for (const sourceLine of String(text || "").split(/\r?\n/)) {
    const offsetMatch = sourceLine.match(/^\s*\[offset:([+-]?\d+)\]\s*$/i);
    if (offsetMatch) {
      offset = Number(offsetMatch[1]) / 1000;
      continue;
    }
    const stamps = [...sourceLine.matchAll(/\[(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))\]/g)];
    if (!stamps.length) continue;
    const lyric = boundedText(sourceLine.replace(/\[[^\]]+\]/g, ""));
    if (!lyric) continue;
    for (const stamp of stamps) {
      entries.push({
        start: Math.max(0, timestampSeconds(stamp[1], stamp[2], stamp[3], stamp[4] || "0") + offset),
        text: lyric,
      });
    }
  }
  entries.sort((left, right) => left.start - right.start);
  const duration = Math.max(0, finiteNumber(options.duration));
  const segments = entries.map((entry, index) => {
    const next = entries[index + 1]?.start;
    const end = next != null && next > entry.start
      ? next
      : duration > entry.start
        ? duration
        : entry.start + 4;
    return {
      id: `lrc-lyric-${index + 1}`,
      start: entry.start,
      end,
      text: entry.text,
      origin: "lrc",
    };
  });
  validateLyricsSegments(segments);
  return segments;
}

function srtTime(value) {
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  return match ? timestampSeconds(match[1], match[2], match[3], match[4]) : null;
}

export function parseSrtLyrics(text) {
  const segments = [];
  for (const block of String(text || "").trim().split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map(line => line.trim());
    if (/^\d+$/.test(lines[0] || "")) lines.shift();
    const timing = lines.shift()?.match(/^(.+?)\s*-->\s*(.+?)(?:\s+.*)?$/);
    if (!timing) continue;
    const start = srtTime(timing[1]);
    const end = srtTime(timing[2]);
    const lyric = boundedText(lines.join(" ").replace(/<[^>]*>/g, ""));
    if (start == null || end == null || end <= start || !lyric) continue;
    segments.push({
      id: `srt-lyric-${segments.length + 1}`,
      start,
      end,
      text: lyric,
      origin: "srt",
    });
  }
  validateLyricsSegments(segments);
  return segments;
}

function intervalOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function lineContext(segment, sourceFrame, cropFrames) {
  return {
    start_frame: Math.max(0, sourceFrame(segment.start)),
    end_frame: Math.min(cropFrames, sourceFrame(segment.end)),
    text: segment.text,
    origin: segment.origin,
  };
}

export function createLyricsWriterContext(timeline, clips, options = {}) {
  const normalized = normalizeLyricsTimeline(timeline);
  const boxContexts = new Map();
  const revision = lyricsTimelineRevision(normalized, options);
  if (!normalized || options.includeInWriter === false ||
      (options.audioFile && !isLyricsTimelineCurrent(normalized, options.audioFile))) {
    return { lyricsContext: null, boxContexts, revision };
  }
  const fps = Math.max(1, finiteNumber(options.fps, 24));
  const cropStart = Math.max(0, finiteNumber(options.cropStart));
  const totalFrames = Math.max(0, Math.round(finiteNumber(options.totalFrames)));
  const cropEnd = cropStart + totalFrames / fps;
  const sourceFrame = seconds => Math.round((seconds - cropStart) * fps);
  const visible = normalized.segments.filter(
    segment => intervalOverlap(segment.start, segment.end, cropStart, cropEnd) > 0,
  ).slice(0, MAX_VISIBLE_LINES);
  const lyricsContext = {
    version: 1,
    language: normalized.detectedLanguage || normalized.requestedLanguage || "unknown",
    audio_source: normalized.audioSource,
    lines: visible.map(segment => lineContext(segment, sourceFrame, totalFrames)),
  };
  clips.forEach((clip, index) => {
    const start = cropStart + clip.start / fps;
    const end = cropStart + clip.end / fps;
    const duration = Math.max(1 / fps, end - start);
    const active = normalized.segments.filter(
      segment => intervalOverlap(segment.start, segment.end, start, end) > 0,
    ).slice(0, MAX_BOX_LINES);
    const previous = [...normalized.segments].reverse().find(segment => segment.end <= start + EPSILON);
    const next = normalized.segments.find(segment => segment.start >= end - EPSILON);
    boxContexts.set(index, {
      active_lines: active.map(segment => ({
        ...lineContext(segment, sourceFrame, totalFrames),
        overlap: Number((intervalOverlap(segment.start, segment.end, start, end) / duration).toFixed(3)),
      })),
      ...(previous ? {
        previous_line: {
          text: previous.text,
          origin: previous.origin,
          frames_since: Math.max(0, clip.start - sourceFrame(previous.end)),
        },
      } : {}),
      ...(next ? {
        next_line: {
          text: next.text,
          origin: next.origin,
          frames_until: Math.max(0, sourceFrame(next.start) - clip.end),
        },
      } : {}),
    });
  });
  return { lyricsContext, boxContexts, revision };
}
