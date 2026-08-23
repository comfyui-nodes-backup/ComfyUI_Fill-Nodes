import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPromptWriterUpdates,
  createPromptWriterDocument,
  promptDocumentRevision,
  promptWriterScopeIndices,
} from "../web/nodes/audio/audio_prompt_writer_document.js";

function clips() {
  return [
    { start: 0, end: 24, fadeIn: 2, fadeOut: 0, crossfade: 0, prompt: "First" },
    { start: 24, end: 48, fadeIn: 0, fadeOut: 0, crossfade: 4, prompt: "Second" },
    { start: 48, end: 72, fadeIn: 0, fadeOut: 3, crossfade: 0, prompt: "Third" },
  ];
}

test("writer scopes include all, selected, or selected-onward prompt boxes", () => {
  const value = clips();
  assert.deepEqual(promptWriterScopeIndices(value, [], -1, "all"), [0, 1, 2]);
  assert.deepEqual(promptWriterScopeIndices(value, [2, 0], 2, "selected"), [0, 2]);
  assert.deepEqual(promptWriterScopeIndices(value, [1], 1, "selected_onward"), [1, 2]);
  assert.throws(() => promptWriterScopeIndices(value, [], -1, "selected"), /Select at least one/);
});

test("writer documents contain only the requested scope and exact revision", () => {
  const value = clips();
  const document = createPromptWriterDocument(value, {
    scope: "selected",
    selectedIndices: [1],
    selectedIndex: 1,
    fps: 24,
    totalFrames: 72,
    bpm: 120,
    beatLabel: frame => `F${frame}`,
  });

  assert.equal(document.revision, promptDocumentRevision(value));
  assert.deepEqual(document.allowed_indices, [1]);
  assert.deepEqual(document.boxes, [{
    index: 1,
    start_frame: 24,
    end_frame: 48,
    start_beat: "F24",
    end_beat: "F48",
    prompt: "Second",
  }]);
});

test("writer documents attach read-only song and per-box musical context", () => {
  const value = clips();
  const document = createPromptWriterDocument(value, {
    fps: 24,
    totalFrames: 72,
    bpm: 120,
    songContext: { version: 1, sections: [{ role: "chorus" }] },
    musicContextRevision: "song-1",
    musicContext: index => ({ sections: [{ role: index === 0 ? "intro" : "chorus" }] }),
  });

  assert.equal(document.music_context_revision, "song-1");
  assert.equal(document.song_context.sections[0].role, "chorus");
  assert.equal(document.boxes[0].music_context.sections[0].role, "intro");
  assert.equal(document.boxes[1].music_context.sections[0].role, "chorus");
});

test("writer documents attach read-only global and per-box lyric context", () => {
  const value = clips();
  const document = createPromptWriterDocument(value, {
    fps: 24,
    totalFrames: 72,
    lyricsContext: {
      version: 1,
      language: "en",
      audio_source: "vocals",
      lines: [{ start_frame: 0, end_frame: 24, text: "Open your eyes", origin: "corrected" }],
    },
    lyricsContextRevision: "lyrics-1",
    lyricContext: index => ({
      active_lines: index === 0
        ? [{ start_frame: 0, end_frame: 24, text: "Open your eyes", origin: "corrected", overlap: 1 }]
        : [],
    }),
  });

  assert.equal(document.lyrics_context_revision, "lyrics-1");
  assert.equal(document.lyrics_context.lines[0].text, "Open your eyes");
  assert.equal(document.boxes[0].lyric_context.active_lines[0].origin, "corrected");
  assert.deepEqual(document.boxes[1].lyric_context.active_lines, []);
});

test("writer updates change prompt text without changing timeline structure", () => {
  const value = clips();
  const timing = value.map(clip => ({ ...clip, prompt: undefined }));
  const revision = promptDocumentRevision(value);
  const result = applyPromptWriterUpdates(value, revision, [{
    index: 1,
    start_frame: 24,
    end_frame: 48,
    prompt: "Rewritten second prompt",
  }], [1]);

  assert.equal(result.applied, 1);
  assert.equal(value[1].prompt, "Rewritten second prompt");
  assert.deepEqual(value.map(clip => ({ ...clip, prompt: undefined })), timing);
  assert.equal(result.previous[0].prompt, "Second");
});

test("writer updates reject stale, out-of-scope, and malformed changes atomically", () => {
  const value = clips();
  const revision = promptDocumentRevision(value);
  const original = structuredClone(value);

  assert.throws(
    () => applyPromptWriterUpdates(value, "stale", [], [0]),
    /timeline changed/,
  );
  assert.throws(
    () => applyPromptWriterUpdates(value, revision, [{
      index: 2,
      start_frame: 48,
      end_frame: 72,
      prompt: "Outside",
    }], [0, 1]),
    /outside the selected scope/,
  );
  assert.throws(
    () => applyPromptWriterUpdates(value, revision, [
      { index: 0, start_frame: 0, end_frame: 24, prompt: "Valid" },
      { index: 1, start_frame: 25, end_frame: 48, prompt: "Bad timing" },
    ]),
    /timing changed/,
  );
  assert.deepEqual(value, original);
});
