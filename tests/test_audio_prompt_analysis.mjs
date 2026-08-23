import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const coordinatesSource = await readFile(
  new URL("../web/nodes/audio/audio_timeline_coordinates.js", import.meta.url),
  "utf8",
);
const coordinatesURL = `data:text/javascript;base64,${Buffer.from(coordinatesSource).toString("base64")}`;
const songMapSource = await readFile(
  new URL("../web/nodes/audio/audio_prompt_song_map.js", import.meta.url),
  "utf8",
);
const songMapURL = `data:text/javascript;base64,${Buffer.from(songMapSource).toString("base64")}`;
const analysisSource = await readFile(
  new URL("../web/nodes/audio/audio_prompt_analysis.js", import.meta.url),
  "utf8",
);
const analysis = await import(
  `data:text/javascript;base64,${Buffer.from(
    analysisSource
      .replace("./audio_timeline_coordinates.js", coordinatesURL)
      .replace("./audio_prompt_song_map.js", songMapURL),
  ).toString("base64")}`
);

test("waveform previews are validated and cropped without changing scale", () => {
  assert.equal(analysis.normalizeWaveformPreview(null), null);
  assert.equal(analysis.normalizeWaveformPreview({ version: 1, duration: 2, scale: 1, peaks: [0] }), null);

  const preview = analysis.normalizeWaveformPreview({
    version: 1,
    duration: 4,
    scale: 32767,
    peaks: [-4, 4, -3, 3, -2, 2, -1, 1],
  });
  assert.deepEqual(analysis.cropWaveformPreview(preview, 1, 2), {
    version: 1,
    duration: 2,
    scale: 32767,
    peaks: [-3, 3, -2, 2],
  });
});

test("source analysis accepts snake and camel case without leaking input shape", () => {
  const value = analysis.sourceAnalysisValue({
    type: "fl_audio_source_analysis",
    version: 1,
    sourceDuration: 12,
    analysisVersion: 3,
    beatTimes: [1, "2"],
    detectedBeatConfidences: [0.9],
    audioFile: "song.wav",
    cacheKey: "cache",
    songMap: {
      type: "fl_audio_song_map",
      version: 1,
      sourceDuration: 12,
      sections: [],
    },
  });

  assert.equal(value.duration, 12);
  assert.equal(value.analysisVersion, 3);
  assert.deepEqual(value.beatTimes, [1, 2]);
  assert.deepEqual(value.detectedBeatConfidences, [0.9]);
  assert.equal(value.audioFile, "song.wav");
  assert.equal(value.songMap.duration, 12);
  assert.equal(value.supportsHalfTime, true);
  assert.equal(analysis.sourceAnalysisValue({ type: "fl_audio_source_analysis", version: 2 }), null);
});

test("legacy crop payloads are promoted into full-source coordinates", () => {
  const value = analysis.sourceAnalysisFromCropPayload({
    source_start: 5,
    source_duration: 12,
    audio_duration: 3,
    beat_offset_ms: 100,
    beat_times: [0.35, 1.35],
    detected_beat_times: [0.2],
    onset_times: [0.5],
    drum_times: { kick_times: [0.75] },
  });

  assert.deepEqual(value.beatTimes, [5.25, 6.25]);
  assert.deepEqual(value.detectedBeatTimes, [5.2]);
  assert.deepEqual(value.onsetTimes, [5.5]);
  assert.deepEqual(value.drumTimes.kick_times, [5.75]);
  assert.equal(value.duration, 12);
  assert.equal(value.waveformPreviewStart, 5);
});

test("median interval ignores repeated or decreasing markers", () => {
  assert.equal(analysis.medianInterval([]), 0);
  assert.equal(analysis.medianInterval([1, 1, 2, 4]), 1.5);
  assert.equal(analysis.medianInterval([0, 0.5, 1]), 0.5);
});
