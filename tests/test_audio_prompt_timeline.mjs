import assert from "node:assert/strict";
import test from "node:test";

import {
  loadRenderGroups,
  normalizeCrossfades,
  normalizeRenderGroups,
  parseTimeline,
  serializeRenderGroups,
  serializeTimeline,
  validateFrameClips,
} from "../web/nodes/audio/audio_prompt_timeline.js";

test("timeline parsing preserves prompts, defaults, and explicit options", () => {
  const clips = parseTimeline(
    "[0 - 24]\nFirst prompt.\n\n[24 - 48 | fade_in=2 | fade_out=3 | crossfade=8]\nSecond prompt.",
    4,
    5,
  );

  assert.deepEqual(clips, [
    { line: 1, start: 0, end: 24, fadeIn: 4, fadeOut: 0, crossfade: 0, prompt: "First prompt." },
    { line: 4, start: 24, end: 48, fadeIn: 0, fadeOut: 3, crossfade: 8, prompt: "Second prompt." },
  ]);
});

test("timeline parsing rejects malformed and overlapping sections", () => {
  assert.throws(() => parseTimeline("", 0, 0), /no sections/);
  assert.throws(() => parseTimeline("Prompt without a header", 0, 0), /needs a schedule header/);
  assert.throws(() => parseTimeline("[0 - nope]\nPrompt", 0, 0), /invalid schedule header/);
  assert.throws(
    () => parseTimeline("[0 - 24]\nFirst\n[20 - 48]\nSecond", 0, 0),
    /overlaps the previous section/,
  );
});

test("frame validation rejects fractional values", () => {
  assert.throws(
    () => validateFrameClips([{
      line: 1,
      start: 0,
      end: 24,
      fadeIn: 0,
      fadeOut: 0,
      crossfade: 2.5,
      prompt: "Prompt",
    }]),
    /crossfade must be a whole frame/,
  );
});

test("crossfade normalization follows touching clip boundaries", () => {
  const clips = [
    { start: 0, end: 12, fadeIn: 0, fadeOut: 4, crossfade: 0 },
    { start: 12, end: 20, fadeIn: 3, fadeOut: 0, crossfade: 20 },
    { start: 24, end: 30, fadeIn: 1, fadeOut: 0, crossfade: 4 },
  ];

  normalizeCrossfades(clips);

  assert.equal(clips[0].fadeOut, 0);
  assert.equal(clips[1].fadeIn, 0);
  assert.equal(clips[1].crossfade, 8);
  assert.equal(clips[2].crossfade, 0);
});

test("timeline serialization round trips frame clips", () => {
  const source = "[0 - 24 | fade_in=2 | fade_out=3 | crossfade=0]\nFirst\n\n" +
    "[24 - 48 | fade_in=0 | fade_out=4 | crossfade=6]\nSecond";
  const parsed = validateFrameClips(parseTimeline(source, 0, 0));
  const roundTrip = validateFrameClips(parseTimeline(serializeTimeline(parsed), 0, 0));

  assert.deepEqual(roundTrip, parsed);
});

test("render groups load, normalize, and serialize consecutive groups", () => {
  const clips = [
    { start: 0, end: 12 },
    { start: 12, end: 24 },
    { start: 30, end: 42 },
  ];
  loadRenderGroups(clips, JSON.stringify({ version: 1, section_groups: [7, 7, 9] }));
  normalizeRenderGroups(clips);

  assert.deepEqual(clips.map((clip) => clip.renderGroup), [1, 1, null]);
  assert.equal(serializeRenderGroups(clips), '{"version":1,"section_groups":[1,1,null]}');
});

test("render groups reject stale or invalid saved state", () => {
  const clips = [{ start: 0, end: 12 }];
  assert.throws(() => loadRenderGroups(clips, "{"), /not valid JSON/);
  assert.throws(
    () => loadRenderGroups(clips, { version: 1, section_groups: [1, 1] }),
    /no longer match/,
  );
});
