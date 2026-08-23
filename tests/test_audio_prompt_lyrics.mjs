import assert from "node:assert/strict";
import test from "node:test";

import {
  createLyricsWriterContext,
  isLyricsTimelineCurrent,
  lyricsTimelineForStorage,
  lyricsTimelineRevision,
  nextLyricsSegmentId,
  normalizeLyricsTimeline,
  parseLrcLyrics,
  parseSrtLyrics,
  validateLyricsSegments,
} from "../web/nodes/audio/audio_prompt_lyrics.js";

function timeline() {
  return {
    version: 1,
    audio_file: "song.wav",
    audio_sha256: "abc",
    cache_key: "cache",
    model_id: "openai/whisper-small",
    model_revision: "revision",
    requested_language: "auto",
    detected_language: "en",
    audio_source: "vocals",
    segments: [
      { id: "line-1", start: 1, end: 3, text: "First lyric", origin: "asr" },
      { id: "line-2", start: 4, end: 6, text: "Second lyric", origin: "corrected" },
    ],
  };
}

test("lyrics normalize backend fields and serialize workflow fields", () => {
  const normalized = normalizeLyricsTimeline(timeline());
  assert.equal(normalized.audioFile, "song.wav");
  assert.equal(normalized.segments[1].origin, "corrected");
  assert.equal(lyricsTimelineForStorage(normalized).audio_source, "vocals");
  assert.equal(isLyricsTimelineCurrent(normalized, "song.wav"), true);
  assert.equal(isLyricsTimelineCurrent(normalized, "other.wav"), false);
});

test("lyrics reject overlaps and malformed saved data", () => {
  assert.throws(() => validateLyricsSegments([
    { id: "a", start: 0, end: 2, text: "One" },
    { id: "b", start: 1, end: 3, text: "Two" },
  ]), /without overlaps/);
  const value = timeline();
  value.segments[1].start = 2;
  assert.equal(normalizeLyricsTimeline(value), null);
});

test("LRC parsing applies offsets, repeated timestamps, and inferred ends", () => {
  const segments = parseLrcLyrics(`
[offset:500]
[00:01.00][00:03.00]First line
[00:05.50]Last line
  `, { duration: 8 });
  assert.deepEqual(segments.map(segment => segment.start), [1.5, 3.5, 6]);
  assert.deepEqual(segments.map(segment => segment.end), [3.5, 6, 8]);
  assert.equal(segments[2].origin, "lrc");
});

test("SRT parsing retains cue timing and joins display lines", () => {
  const segments = parseSrtLyrics(`1
00:00:01,250 --> 00:00:03,000
First <i>lyric</i>

2
00:00:04,000 --> 00:00:05,500
Second lyric`);
  assert.deepEqual(segments.map(segment => [segment.start, segment.end]), [[1.25, 3], [4, 5.5]]);
  assert.equal(segments[0].text, "First lyric");
  assert.equal(segments[0].origin, "srt");
});

test("lyrics revisions include projection and writer inclusion state", () => {
  const value = timeline();
  const base = lyricsTimelineRevision(value, { fps: 24, cropStart: 0, totalFrames: 240 });
  assert.notEqual(base, lyricsTimelineRevision(value, { fps: 30, cropStart: 0, totalFrames: 240 }));
  assert.notEqual(base, lyricsTimelineRevision(value, {
    fps: 24,
    cropStart: 0,
    totalFrames: 240,
    includeInWriter: false,
  }));
  assert.equal(nextLyricsSegmentId(value), "manual-lyric-1");
});

test("writer context projects global, overlapping, and adjacent lyrics", () => {
  const result = createLyricsWriterContext(timeline(), [
    { start: 0, end: 72, prompt: "First" },
    { start: 72, end: 144, prompt: "Second" },
  ], {
    fps: 24,
    cropStart: 0,
    totalFrames: 168,
    audioFile: "song.wav",
  });
  assert.equal(result.lyricsContext.language, "en");
  assert.equal(result.lyricsContext.lines[0].start_frame, 24);
  assert.equal(result.boxContexts.get(0).active_lines[0].text, "First lyric");
  assert.equal(result.boxContexts.get(0).next_line.text, "Second lyric");
  assert.equal(result.boxContexts.get(1).active_lines[0].origin, "corrected");
  assert.equal(result.boxContexts.get(1).previous_line.text, "First lyric");
});

test("stale or disabled lyrics are excluded from Writer context", () => {
  const value = timeline();
  const stale = createLyricsWriterContext(value, [], { audioFile: "other.wav" });
  const disabled = createLyricsWriterContext(value, [], {
    audioFile: "song.wav",
    includeInWriter: false,
  });
  assert.equal(stale.lyricsContext, null);
  assert.equal(disabled.lyricsContext, null);
});
