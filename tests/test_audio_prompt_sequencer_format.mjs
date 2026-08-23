import assert from "node:assert/strict";
import test from "node:test";

import {
  FORMAT_VERSION,
  isCompatibleFormatVersion,
  migrateRemovedBpmMethod,
  restoreCachedAudioWidgets,
} from "../web/nodes/audio/audio_prompt_sequencer_format.js";

test("saved sequencer versions 6 through the current format remain compatible", () => {
  assert.equal(FORMAT_VERSION, 17);
  for (let version = 6; version <= FORMAT_VERSION; version++) {
    assert.equal(isCompatibleFormatVersion(version), true);
  }
  assert.equal(isCompatibleFormatVersion(5), false);
  assert.equal(isCompatibleFormatVersion(18), false);
  assert.equal(isCompatibleFormatVersion("invalid"), false);
});

test("cached audio metadata fills only empty hidden widgets", () => {
  const widgets = {
    audioFile: { value: "" },
    analysisCacheKey: { value: "current-cache" },
  };
  restoreCachedAudioWidgets(widgets, {
    sourceAnalysis: { audioFile: "song.wav", cacheKey: "saved-cache" },
  });

  assert.equal(widgets.audioFile.value, "song.wav");
  assert.equal(widgets.analysisCacheKey.value, "current-cache");
});

test("legacy BPM inputs and links are removed without disturbing other nodes", () => {
  const graph = {
    nodes: [
      {
        id: 10,
        type: "FL_Audio_Beat_Prompt_Schedule",
        widgets_values: [0, 1, 2, 3, 4, 5, 6, 7, "beat_intervals", "keep"],
        inputs: [
          { name: "audio", link: 100 },
          { name: "bpm_method", link: 101 },
          { name: "fps", link: 102 },
        ],
        properties: { flBeatPromptSequencer: { beatData: { cached: true }, viewStart: 4 } },
      },
      { id: 20, type: "Unrelated", inputs: [{ name: "value", link: 103 }] },
    ],
    links: [
      [100, 1, 0, 10, 0, "AUDIO"],
      [101, 2, 0, 10, 1, "STRING"],
      [102, 3, 0, 10, 2, "FLOAT"],
      [103, 4, 0, 20, 0, "VALUE"],
    ],
  };

  migrateRemovedBpmMethod(graph);

  assert.deepEqual(graph.nodes[0].widgets_values.slice(8), ["keep"]);
  assert.deepEqual(graph.nodes[0].inputs.map((input) => input.name), ["audio", "fps"]);
  assert.deepEqual(graph.links.map((link) => [link[0], link[3], link[4]]), [
    [100, 10, 0],
    [102, 10, 1],
    [103, 20, 0],
  ]);
  assert.equal(graph.nodes[0].properties.flBeatPromptSequencer.beatData, null);
  assert.equal(graph.nodes[0].properties.flBeatPromptSequencer.sourceAnalysis, null);
  assert.equal(graph.nodes[0].properties.flBeatPromptSequencer.viewStart, 4);
  assert.equal(graph.nodes[0].properties.flBeatPromptSequencer.formatVersion, FORMAT_VERSION);
});

test("current workflows pass through migration unchanged", () => {
  const graph = {
    nodes: [{ id: 1, type: "FL_Audio_Beat_Prompt_Schedule", inputs: [{ name: "fps" }] }],
    links: [[7, 2, 0, 1, 0, "FLOAT"]],
  };
  const expected = structuredClone(graph);

  migrateRemovedBpmMethod(graph);

  assert.deepEqual(graph, expected);
});
