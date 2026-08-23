import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const source = await readFile(
  new URL("../web/nodes/audio/audio_prompt_song_map.js", import.meta.url),
  "utf8",
);
const songMap = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

function value() {
  return {
    type: "fl_audio_song_map",
    version: 1,
    source_duration: 10,
    cache_key: "song-cache",
    meter: { beats_per_bar: 4, confidence: 0.9 },
    energy_preview: {
      version: 1,
      duration: 10,
      rate: 10,
      values: Array.from({ length: 100 }, (_entry, index) => index / 99),
    },
    sections: [
      {
        id: "section-0",
        start: 0,
        end: 5,
        bar_start: 0,
        bar_end: 4,
        family: "A",
        role: { value: "intro", source: "heuristic", confidence: 0.7 },
        energy: { mean: 0.25, peak: 0.5, change: 0.3, trend: "rising" },
        rhythm: { onset_density: 0.2 },
      },
      {
        id: "section-1",
        start: 5,
        end: 10,
        bar_start: 4,
        bar_end: 8,
        family: "B",
        role: { value: "chorus", source: "heuristic", confidence: 0.75 },
        energy: { mean: 0.8, peak: 1, change: 0, trend: "steady" },
        rhythm: { onset_density: 1.2 },
      },
    ],
    phrases: [
      { section_id: "section-0", start: 0, end: 5, index: 0, bar_count: 4 },
      { section_id: "section-1", start: 5, end: 10, index: 0, bar_count: 4 },
    ],
    moments: [{ type: "drop", start: 5, end: 5, anchor: 5, strength: 0.9 }],
  };
}

test("song maps normalize source-time structure and energy", () => {
  const result = songMap.normalizeSongMap(value());

  assert.equal(result.duration, 10);
  assert.equal(result.meter.beatsPerBar, 4);
  assert.equal(result.sections[1].role.value, "chorus");
  assert.equal(result.energyPreview.values.length, 100);
  assert.equal(result.cues[0].type, "drop");
  assert.match(result.cues[0].id, /^auto-drop-/);
  assert.equal(result.cues[0].source, "analysis");
  assert.equal(songMap.normalizeSongMap({ version: 2 }), null);
});

test("manual role overrides are cache scoped and authoritative", () => {
  const normalized = songMap.normalizeSongMap(value());
  const overrides = songMap.updateSongMapOverride(
    null,
    normalized,
    "section-0",
    "verse",
  );
  const applied = songMap.applySongMapOverrides(normalized, overrides);

  assert.equal(applied.sections[0].role.value, "verse");
  assert.equal(applied.sections[0].role.source, "manual");
  assert.equal(applied.sections[0].role.confidence, 1);
  assert.equal(
    songMap.applySongMapOverrides(normalized, { ...overrides, cacheKey: "other" })
      .sections[0].role.value,
    "intro",
  );
});

test("version one role overrides migrate without creating manual structure", () => {
  const migrated = songMap.normalizeSongMapOverrides({
    version: 1,
    cacheKey: "song-cache",
    roles: { "section-0": { value: "verse", customLabel: "Opening" } },
  });

  assert.equal(migrated.version, 2);
  assert.equal(migrated.sections, null);
  assert.equal(migrated.roles["section-0"].customLabel, "Opening");
});

test("version three structural overrides retain section edits and discard cue rail state", () => {
  const migrated = songMap.normalizeSongMapOverrides({
    version: 3,
    cacheKey: "song-cache",
    roles: {},
    sections: [],
    nextId: 4,
    cues: [{ id: "manual-cue-1", type: "custom", start: 1, end: 2 }],
  });

  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.sections, []);
  assert.equal("cues" in migrated, false);
});

test("manual structures remain cache scoped and rebuild derived section data", () => {
  const normalized = songMap.normalizeSongMap(value());
  const sections = [
    { ...normalized.sections[0], end: 4 },
    { ...normalized.sections[1], start: 6 },
  ];
  const overrides = songMap.replaceSongMapSections(null, normalized, sections);
  const applied = songMap.applySongMapOverrides(normalized, overrides, {
    detectedDownbeatTimes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    onsetTimes: [0.5, 1.5, 2.5, 6.5, 7, 8],
  });

  assert.deepEqual(applied.sections.map(section => [section.start, section.end]), [[0, 4], [6, 10]]);
  assert.equal(applied.sections[0].barEnd, 4);
  assert.equal(applied.sections[0].rhythm.onsetDensity, 0.75);
  assert.equal(applied.sections[1].energy.trend, "rising");
  assert.ok(applied.phrases.every(phrase => ["section-0", "section-1"].includes(phrase.sectionId)));
  assert.equal(
    songMap.applySongMapOverrides(normalized, { ...overrides, cacheKey: "different" }).sections[0].end,
    5,
  );
});

test("manual structures reject overlaps, create stable IDs, and reset cleanly", () => {
  const normalized = songMap.normalizeSongMap(value());
  assert.throws(() => songMap.validateSongMapSections([
    { ...normalized.sections[0], end: 6 },
    { ...normalized.sections[1], start: 5 },
  ], normalized.duration), /no overlaps/);

  let overrides = songMap.replaceSongMapSections(null, normalized, normalized.sections);
  assert.equal(songMap.nextSongMapSectionId(overrides, normalized), "manual-1");
  overrides = songMap.replaceSongMapSections(overrides, normalized, [
    ...normalized.sections,
    {
      id: "manual-1",
      start: 4,
      end: 5,
      family: "M1",
      role: { value: "unknown", source: "manual", confidence: 1 },
    },
  ].filter(section => section.id !== "section-0" && section.id !== "section-1" || section.start >= 5));
  assert.equal(songMap.nextSongMapSectionId(overrides, normalized), "manual-2");
  assert.equal(songMap.resetSongMapStructure(overrides, normalized).sections, null);
});

test("auto labels restore analyzed roles after structural editing", () => {
  const normalized = songMap.normalizeSongMap(value());
  let overrides = songMap.updateSongMapOverride(null, normalized, "section-0", "verse");
  const effective = songMap.applySongMapOverrides(normalized, overrides);
  overrides = songMap.replaceSongMapSections(overrides, normalized, effective.sections);
  overrides = songMap.updateSongMapOverride(overrides, normalized, "section-0", "auto");

  const restored = songMap.applySongMapOverrides(normalized, overrides, {});
  assert.equal(restored.sections[0].role.value, "intro");
  assert.equal(restored.sections[0].role.source, "heuristic");
});

test("writer context projects sections, phrases, energy, and transitions into boxes", () => {
  const normalized = songMap.normalizeSongMap(value());
  const clips = [
    { start: 0, end: 120, prompt: "Intro" },
    { start: 120, end: 240, prompt: "Chorus" },
  ];

  const result = songMap.createSongWriterContext(normalized, clips, {
    fps: 24,
    cropStart: 0,
    totalFrames: 240,
    bpm: 120,
  });

  assert.equal(result.songContext.sections.length, 2);
  assert.equal(result.songContext.version, 2);
  assert.equal(result.songContext.cues[0].anchor_frame, 120);
  assert.equal(result.songContext.cues[0].destination, "new_section");
  assert.equal(result.boxContexts.get(0).sections[0].label, "Intro");
  assert.equal(result.boxContexts.get(0).sections[0].phrase.position, "1/1");
  assert.equal(result.boxContexts.get(0).next_section.role, "chorus");
  assert.equal(result.boxContexts.get(1).previous_section.role, "intro");
  assert.equal(result.boxContexts.get(1).cues[0].type, "drop");
  assert.equal(result.boxContexts.get(1).cues[0].kind, "point");
  assert.equal(result.boxContexts.get(1).energy.trend, "rising");
});

test("writer context preserves cue ranges, notes, and same-section destinations", () => {
  const input = value();
  input.moments = [{
    id: "manual-cue-1",
    type: "turnaround",
    start: 7,
    end: 9,
    anchor: 9,
    source: "manual",
    note: "Two-bar drum turnaround",
  }];
  const normalized = songMap.normalizeSongMap(input);
  const result = songMap.createSongWriterContext(normalized, [
    { start: 120, end: 240, prompt: "Chorus" },
  ], { fps: 24, cropStart: 0, totalFrames: 240, bpm: 120 });
  const cue = result.boxContexts.get(0).cues[0];

  assert.equal(cue.kind, "range");
  assert.equal(cue.start_frame, 168);
  assert.equal(cue.end_frame, 216);
  assert.equal(cue.destination, "same_section");
  assert.equal(cue.note, "Two-bar drum turnaround");
});
