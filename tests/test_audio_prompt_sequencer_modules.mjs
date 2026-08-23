import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const AUDIO_NODE_URL = new URL("../web/nodes/audio/", import.meta.url);

async function importModuleBody(filename, startMarker) {
  const source = await readFile(new URL(filename, AUDIO_NODE_URL), "utf8");
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1);
  const encoded = Buffer.from(source.slice(start)).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

test("sequencer editor remains a valid ESM module after extraction", async () => {
  const source = await readFile(new URL("audio_prompt_sequencer_editor.js", AUDIO_NODE_URL), "utf8");
  const module = await importModuleBody("audio_prompt_sequencer_editor.js", "const EPSILON");
  assert.equal(typeof module.BeatPromptSequencer, "function");
  assert.doesNotMatch(source, /decodeAudioData|arrayBuffer\(\)/);
  assert.match(source, /audioElement\.preload = "metadata"/);
});

test("playhead draws reuse the static timeline layer", async () => {
  const module = await importModuleBody("audio_prompt_sequencer_editor.js", "const EPSILON");
  const context = {
    setTransform() {},
    clearRect() {},
    fillRect() {},
    drawImage() {},
  };
  const editor = Object.create(module.BeatPromptSequencer.prototype);
  editor.canvas = {
    clientWidth: 800,
    clientHeight: 400,
    width: 0,
    height: 0,
    getContext: () => context,
  };
  editor.staticCanvas = {
    width: 0,
    height: 0,
    getContext: () => context,
  };
  editor.staticDirty = true;
  editor.timelineLayout = () => ({});
  let staticDraws = 0;
  let playheadDraws = 0;
  editor.drawStatic = () => staticDraws++;
  editor.drawGuidesAndPlayhead = () => playheadDraws++;
  const previousWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    editor.draw();
    editor.draw();
  } finally {
    globalThis.window = previousWindow;
  }

  assert.equal(staticDraws, 1);
  assert.equal(playheadDraws, 2);
});

test("Writer activity animates one active box and clears completed boxes independently", async () => {
  const module = await importModuleBody("audio_prompt_sequencer_editor.js", "const EPSILON");
  const editor = Object.create(module.BeatPromptSequencer.prototype);
  editor.clips = [{}, {}, {}];
  editor.writerActivity = null;
  editor.writerActivityFrame = null;
  editor.writerActivityTimer = null;
  editor.writerReducedMotion = true;
  editor.scheduleDraw = () => {};
  editor.setWriterActivity({
    phase: "editing",
    label: "Writing 1 of 2",
    scopeIndices: [0, 1, 99],
    targetIndices: [0, 1],
    completedIndices: [],
    activeIndex: 1,
    progressCompleted: 0,
    progressTotal: 2,
  });
  assert.deepEqual([...editor.writerActivity.scopeIndices], [0, 1]);
  assert.deepEqual([...editor.writerActivity.targetIndices], [0, 1]);

  editor.clipRects = [
    { index: 0, x: 10, y: 20, width: 90, height: 70 },
    { index: 1, x: 105, y: 20, width: 90, height: 70 },
    { index: 2, x: 200, y: 20, width: 90, height: 70 },
  ];
  const strokes = [];
  const context = {
    save() {},
    restore() {},
    beginPath() {},
    roundRect() {},
    stroke() { strokes.push(this.strokeStyle); },
    fill() {},
    fillText() {},
    measureText(value) { return { width: String(value).length * 5 }; },
  };
  editor.drawWriterActivity(context);
  assert.deepEqual(strokes, ["#3f6475", "#22d3ee"]);

  strokes.length = 0;
  editor.writerActivity.completedIndices = new Set([1]);
  editor.writerActivity.activeIndex = 0;
  editor.writerActivity.progressCompleted = 1;
  editor.writerCompletionFades.set(1, performance.now() + 700);
  editor.drawWriterActivity(context);
  assert.deepEqual(strokes, ["#22d3ee", "#34d399"]);

  strokes.length = 0;
  editor.writerActivity.activeIndex = null;
  editor.writerActivity.completedIndices = new Set([0, 1]);
  editor.writerCompletionFades.clear();
  editor.drawWriterActivity(context);
  assert.deepEqual(strokes, []);
  editor.clearWriterActivity();
  assert.equal(editor.writerActivity, null);
});

test("sequencer keeps one Song Map strip without a secondary cue lane", async () => {
  const source = await readFile(new URL("audio_prompt_sequencer_editor.js", AUDIO_NODE_URL), "utf8");
  const module = await importModuleBody("audio_prompt_sequencer_editor.js", "const EPSILON");
  const editor = Object.create(module.BeatPromptSequencer.prototype);
  editor.canvas = { clientHeight: 400 };
  editor.sourceWaveformPreview = null;
  editor.songMap = () => ({ cues: [] });

  const layout = editor.timelineLayout();

  assert.ok(layout.songMapBottom < layout.waveformTop);
  assert.equal("cueTop" in layout, false);
  assert.doesNotMatch(source, /drawCueLane|data-lane="cue"|data-cue-field/);
  assert.doesNotMatch(source, /data-song-field="(?:family|custom-label)"/);
  assert.doesNotMatch(source, /flbps-context-custom/);
  assert.match(source, /data-role="song-label-editor"/);
  assert.doesNotMatch(source, /cue\.type === "(?:build|release|drop|breakdown)"/);
  assert.doesNotMatch(source, /const confidence = section\.role\.source/);
});

test("Song Map exposes cropped outer edges for resizing", async () => {
  const module = await importModuleBody("audio_prompt_sequencer_editor.js", "const EPSILON");
  const editor = Object.create(module.BeatPromptSequencer.prototype);
  editor.canvas = { clientWidth: 200 };
  editor.hover = null;
  editor.drag = null;
  editor.selectedSongSectionIds = new Set();
  editor.viewStart = 0;
  editor.viewEnd = 100;
  editor.cropStartSeconds = () => 10;
  editor.fps = () => 10;
  editor.sequenceFrameCount = () => 100;
  editor.songMap = () => ({
    sections: [{
      id: "wide",
      start: 5,
      end: 25,
      family: "A",
      role: { value: "chorus", customLabel: "", source: "analysis", confidence: 1 },
    }],
    cues: [],
  });
  const context = {
    save() {},
    restore() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    rect() {},
    clip() {},
    fillText() {},
    measureText(value) { return { width: String(value).length * 5 }; },
  };

  const previousColor = globalThis.songSectionColor;
  const previousLabel = globalThis.songSectionLabel;
  globalThis.songSectionColor = () => "#ffffff";
  globalThis.songSectionLabel = section => section.role.value;
  try {
    editor.drawSongMapLane(context, 200, 20, 50);
  } finally {
    if (previousColor === undefined) delete globalThis.songSectionColor;
    else globalThis.songSectionColor = previousColor;
    if (previousLabel === undefined) delete globalThis.songSectionLabel;
    else globalThis.songSectionLabel = previousLabel;
  }

  const rect = editor.songMapRects[0];
  assert.equal(rect.startEdgeFrame, 0);
  assert.equal(rect.endEdgeFrame, 100);
  assert.equal(editor.songMapHitTest(rect.startX, 30).type, "start");
  assert.equal(editor.songMapHitTest(rect.endX, 30).type, "end");
  assert.equal(
    editor.songMapLabelHitTest(rect.labelRect.x + 1, rect.labelRect.y + 1).section.id,
    "wide",
  );
});

test("Song Map resizes cropped sections from their visible outer edges", async () => {
  const module = await importModuleBody("audio_prompt_sequencer_editor.js", "const EPSILON");
  const editor = Object.create(module.BeatPromptSequencer.prototype);
  const section = {
    id: "wide",
    start: 5,
    end: 25,
    family: "A",
    role: { value: "chorus", customLabel: "", source: "analysis", confidence: 1 },
  };
  editor.panDuringDrag = () => {};
  editor.songSectionLocalRange = value => ({
    start: Math.round((value.start - 10) * 10),
    end: Math.round((value.end - 10) * 10),
  });
  editor.snapFrame = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  editor.sourceTimeAtLocalFrame = frame => 10 + frame / 10;
  editor.sequenceFrameCount = () => 100;
  editor.sourceAnalysis = { songMap: {} };
  editor.songMapOverrides = {};
  editor.syncSongInspector = () => {};
  editor.scheduleDraw = () => {};
  const previousReplace = globalThis.replaceSongMapSections;
  globalThis.replaceSongMapSections = (_overrides, _songMap, sections) => ({ sections });
  try {
    editor.drag = {
      type: "song-start",
      originalSections: [section],
      originalIndex: 0,
      originalEdgeFrame: 0,
      pointerStartRaw: 0,
    };
    editor.frameAtX = () => 20;
    editor.updateSongDrag(0);
    assert.equal(editor.songMapOverrides.sections[0].start, 12);

    editor.drag = {
      type: "song-end",
      originalSections: [section],
      originalIndex: 0,
      originalEdgeFrame: 100,
      pointerStartRaw: 100,
    };
    editor.frameAtX = () => 80;
    editor.updateSongDrag(0);
    assert.equal(editor.songMapOverrides.sections[0].end, 18);
  } finally {
    if (previousReplace === undefined) delete globalThis.replaceSongMapSections;
    else globalThis.replaceSongMapSections = previousReplace;
  }
});

test("Song Map double-clicking a label starts inline naming", async () => {
  const module = await importModuleBody("audio_prompt_sequencer_editor.js", "const EPSILON");
  const editor = Object.create(module.BeatPromptSequencer.prototype);
  const section = { id: "chorus" };
  editor.eventPosition = () => ({ x: 80, y: 30 });
  editor.timelineLayout = () => ({ songMapTop: 20, songMapBottom: 50 });
  editor.songMapLabelHitTest = () => ({ section });
  editor.songMapHitTest = () => ({ section, type: "move" });
  editor.frameAtX = () => 42;
  editor.snapFrame = value => value;
  editor.sequenceFrameCount = () => 100;
  editor.updateTransportTime = () => {};
  let editing = null;
  editor.beginSongLabelEdit = value => editing = value.id;

  editor.onDoubleClick({ preventDefault() {} });

  assert.equal(editing, "chorus");
});

test("inline Song Map naming commits a custom label", async () => {
  const module = await importModuleBody("audio_prompt_sequencer_editor.js", "const EPSILON");
  const editor = Object.create(module.BeatPromptSequencer.prototype);
  const section = {
    id: "chorus",
    family: "A",
    role: { value: "chorus", customLabel: "", source: "analysis", confidence: 1 },
  };
  editor.editingSongSectionId = section.id;
  editor.songLabelEditor = {
    value: "Final Chorus",
    hidden: false,
    dataset: { originalValue: "Chorus" },
  };
  editor.songMap = () => ({ sections: [section] });
  let update = null;
  editor.setSongMapRole = (_section, role, customLabel) => update = { role, customLabel };
  editor.scheduleDraw = () => {};
  const previousLabel = globalThis.songSectionLabel;
  globalThis.songSectionLabel = value => value.role.customLabel || "Chorus";
  try {
    editor.finishSongLabelEdit(true);
  } finally {
    if (previousLabel === undefined) delete globalThis.songSectionLabel;
    else globalThis.songSectionLabel = previousLabel;
  }

  assert.deepEqual(update, { role: "chorus", customLabel: "Final Chorus" });
  assert.equal(editor.songLabelEditor.hidden, true);
  assert.equal(editor.editingSongSectionId, null);
});

test("Song Map double-click creates a section without a beat grid", async () => {
  const module = await importModuleBody("audio_prompt_sequencer_editor.js", "const EPSILON");
  const editor = Object.create(module.BeatPromptSequencer.prototype);
  editor.eventPosition = () => ({ x: 80, y: 30 });
  editor.timelineLayout = () => ({ songMapTop: 20, songMapBottom: 50 });
  editor.songMapLabelHitTest = () => null;
  editor.songMapHitTest = () => null;
  editor.frameAtX = () => 42;
  editor.snapFrame = value => value;
  editor.sequenceFrameCount = () => 100;
  editor.gridClipRangeAt = () => undefined;
  editor.updateTransportTime = () => {};
  let createdAt = null;
  editor.addSongSection = start => createdAt = start;
  let prevented = false;

  editor.onDoubleClick({ preventDefault: () => prevented = true });

  assert.equal(createdAt, 42);
  assert.equal(prevented, true);
});

test("Lyrics lane refuses to create an overlapping segment at the playhead", async () => {
  const module = await importModuleBody("audio_prompt_sequencer_editor.js", "const EPSILON");
  const editor = Object.create(module.BeatPromptSequencer.prototype);
  editor.widgets = { audioFile: { value: "song.wav" } };
  editor.lyricsTimeline = {
    segments: [{ id: "line-1", start: 1, end: 3, text: "Existing lyric", origin: "asr" }],
  };
  editor.playheadFrame = 48;
  editor.cropStartSeconds = () => 0;
  editor.fps = () => 24;
  editor.sequenceFrameCount = () => 240;
  let message = "";
  editor.showError = value => message = value;
  editor.persistLyrics = () => assert.fail("overlapping lyrics must not be persisted");

  editor.addLyricsSegment();

  assert.match(message, /already inside a lyric segment/);
});

test("sequencer history restores all editable lanes and supports redo", async () => {
  const module = await importModuleBody("audio_prompt_sequencer_editor.js", "const EPSILON");
  const editor = Object.create(module.BeatPromptSequencer.prototype);
  editor.historySuspended = false;
  editor.historyTransaction = null;
  editor.undoStack = [];
  editor.redoStack = [];
  editor.clips = [{ start: 0, end: 24, fadeIn: 0, fadeOut: 0, crossfade: 0, prompt: "First" }];
  editor.songMapOverrides = { version: 3, cacheKey: "song", roles: {}, sections: null, nextId: 1 };
  editor.lyricsTimeline = { version: 1, segments: [{ id: "line", start: 0, end: 1, text: "One" }] };
  editor.envelopeSlots = [null, null, null];
  editor.lyricsSettings = { includeInWriter: true };
  editor.widgets = Object.fromEntries([
    ["timeUnit", "frames"], ["fps", 24], ["sequenceDuration", 96], ["trimStartFrame", 0],
    ["halfTime", false], ["beatOffset", 0], ["beatGridDensity", "every_beat"],
    ["defaultFadeIn", 0], ["defaultFadeOut", 0], ["curve", "cosine"],
    ["timeline", ""], ["renderGroups", ""], ["envelopeLayers", ""],
  ].map(([name, value]) => [name, { value }]));
  editor.selectedIndex = 0;
  editor.selectedIndices = new Set([0]);
  editor.selectionAnchor = 0;
  editor.selectedSongSectionId = null;
  editor.selectedSongSectionIds = new Set();
  editor.songSelectionAnchorId = null;
  editor.selectedLyricsSegmentId = "line";
  editor.activeLane = "prompt";
  editor.inspectorTab = "prompt";
  editor.viewStart = 0;
  editor.viewEnd = 96;
  editor.playheadFrame = 0;
  editor.songLabelEditor = { hidden: true };
  editor.rawText = { value: "" };
  editor.controls = { beatGridDensity: { value: "" } };
  editor.node = { graph: { change() {} } };
  editor.closeContextMenu = () => {};
  editor.toggleRaw = () => {};
  editor.applyBeatOffset = () => {};
  editor.refreshBrowserCrop = () => {};
  editor.renderEnvelopeEditor = () => {};
  editor.saveViewState = () => {};
  editor.setEditorEnabled = () => {};
  editor.clearError = () => {};
  editor.activateLane = lane => editor.activeLane = lane;
  editor.setInspectorTab = tab => editor.inspectorTab = tab;
  editor.syncBeatOffsetControls = () => {};
  editor.beatGridDensity = () => editor.widgets.beatGridDensity.value;
  editor.sequenceFrameCount = () => editor.widgets.sequenceDuration.value;
  editor.syncInspector = () => {};
  editor.scheduleDraw = () => {};

  const names = [
    "lyricsTimelineForStorage", "normalizeCrossfades", "normalizeSongMapOverrides",
    "normalizeLyricsTimeline", "serializeTimeline", "serializeRenderGroups", "serializeEnvelopeLayers",
  ];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  Object.assign(globalThis, {
    lyricsTimelineForStorage: value => value,
    normalizeCrossfades: value => value,
    normalizeSongMapOverrides: value => value,
    normalizeLyricsTimeline: value => value,
    serializeTimeline: value => JSON.stringify(value),
    serializeRenderGroups: () => "groups",
    serializeEnvelopeLayers: value => JSON.stringify(value),
  });
  try {
    editor.historyBaseline = editor.captureHistoryState();
    editor.runEdit("Edit every lane", () => {
      editor.clips[0].prompt = "Changed";
      editor.songMapOverrides.roles = { verse: { value: "verse" } };
      editor.lyricsTimeline.segments[0].text = "Two";
      editor.envelopeSlots[0] = { enabled: true, prompt: "Pulse" };
      editor.widgets.fps.value = 30;
      editor.lyricsSettings.includeInWriter = false;
    });

    assert.equal(editor.nextUndoLabel(), "Edit every lane");
    assert.equal(editor.undo(), true);
    assert.equal(editor.clips[0].prompt, "First");
    assert.deepEqual(editor.songMapOverrides.roles, {});
    assert.equal(editor.lyricsTimeline.segments[0].text, "One");
    assert.equal(editor.envelopeSlots[0], null);
    assert.equal(editor.widgets.fps.value, 24);
    assert.equal(editor.lyricsSettings.includeInWriter, true);
    assert.equal(editor.canRedo(), true);

    assert.equal(editor.redo(), true);
    assert.equal(editor.clips[0].prompt, "Changed");
    assert.equal(editor.widgets.fps.value, 30);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete globalThis[name];
      else globalThis[name] = previous[name];
    }
  }
});

test("history coalesces repeated nudges and clears redo after a new edit", async () => {
  const module = await importModuleBody("audio_prompt_sequencer_editor.js", "const EPSILON");
  const editor = Object.create(module.BeatPromptSequencer.prototype);
  editor.historySuspended = false;
  editor.undoStack = [];
  editor.redoStack = [];
  editor.clips = [{ start: 0, end: 24, prompt: "First" }];
  editor.songMapOverrides = null;
  editor.lyricsTimeline = null;
  editor.envelopeSlots = [null, null, null];
  editor.lyricsSettings = { includeInWriter: true };
  editor.widgets = {};
  editor.selectedIndices = new Set();
  editor.selectedSongSectionIds = new Set();
  const names = [
    "lyricsTimelineForStorage", "normalizeCrossfades", "normalizeSongMapOverrides",
    "normalizeLyricsTimeline",
  ];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  Object.assign(globalThis, {
    lyricsTimelineForStorage: value => value,
    normalizeCrossfades: value => value,
    normalizeSongMapOverrides: value => value,
    normalizeLyricsTimeline: value => value,
  });
  try {
    editor.historyBaseline = editor.captureHistoryState();
    editor.runEdit("No-op", () => {});
    assert.equal(editor.undoStack.length, 0);
    editor.runEdit("Nudge prompt", () => editor.clips[0].start++, { mergeKey: "nudge" });
    editor.runEdit("Nudge prompt", () => editor.clips[0].start++, { mergeKey: "nudge" });
    assert.equal(editor.undoStack.length, 1);

    const entry = editor.undoStack.pop();
    editor.redoStack.push(entry);
    editor.historyBaseline = entry.before;
    editor.runEdit("New edit", () => editor.clips[0].prompt = "Second");
    assert.equal(editor.redoStack.length, 0);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete globalThis[name];
      else globalThis[name] = previous[name];
    }
  }
});

test("history restores analysis source and refreshes its beat analysis", async () => {
  const module = await importModuleBody("audio_prompt_sequencer_editor.js", "const EPSILON");
  const editor = Object.create(module.BeatPromptSequencer.prototype);
  editor.historySuspended = false;
  editor.historyTransaction = null;
  editor.undoStack = [];
  editor.redoStack = [];
  editor.clips = [];
  editor.songMapOverrides = null;
  editor.lyricsTimeline = null;
  editor.envelopeSlots = [null, null, null];
  editor.lyricsSettings = { includeInWriter: true };
  editor.widgets = { analysisSource: { value: "mix" } };
  editor.selectedIndices = new Set();
  editor.selectedSongSectionIds = new Set();
  editor.closeContextMenu = () => {};
  editor.songLabelEditor = { hidden: true };
  editor.toggleRaw = () => {};
  editor.rawText = { value: "" };
  editor.applyBeatOffset = () => {};
  editor.refreshBrowserCrop = () => {};
  editor.renderEnvelopeEditor = () => {};
  editor.saveViewState = () => {};
  editor.setEditorEnabled = () => {};
  editor.clearError = () => {};
  editor.activateLane = () => {};
  editor.setInspectorTab = () => {};
  editor.syncBeatOffsetControls = () => {};
  editor.syncInspector = () => {};
  editor.scheduleDraw = () => {};
  editor.sequenceFrameCount = () => 1;
  editor.node = { graph: { change() {} } };
  let invalidated = 0;
  let scheduled = 0;
  editor.invalidateAnalysis = () => invalidated++;
  editor.scheduleAnalysis = () => scheduled++;

  const names = [
    "lyricsTimelineForStorage", "normalizeCrossfades", "normalizeSongMapOverrides",
    "normalizeLyricsTimeline",
  ];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  Object.assign(globalThis, {
    lyricsTimelineForStorage: value => value,
    normalizeCrossfades: value => value,
    normalizeSongMapOverrides: value => value,
    normalizeLyricsTimeline: value => value,
  });
  try {
    editor.historyBaseline = editor.captureHistoryState();
    editor.runEdit("Change analysis source", () => editor.widgets.analysisSource.value = "drums");
    assert.equal(editor.canUndo(), true);

    editor.undo();
    assert.equal(editor.widgets.analysisSource.value, "mix");
    assert.equal(invalidated, 1);
    assert.equal(scheduled, 1);

    editor.redo();
    assert.equal(editor.widgets.analysisSource.value, "drums");
    assert.equal(invalidated, 2);
    assert.equal(scheduled, 2);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete globalThis[name];
      else globalThis[name] = previous[name];
    }
  }
});

test("Writer undo delegates only when the newest shared history entry is a Writer edit", async () => {
  const module = await importModuleBody("audio_prompt_sequencer_editor.js", "const EPSILON");
  const editor = Object.create(module.BeatPromptSequencer.prototype);
  let undone = 0;
  editor.undo = () => {
    undone++;
    return true;
  };
  editor.undoStack = [{ kind: "writer", count: 3 }];
  assert.equal(editor.undoWriterUpdates(), 3);
  assert.equal(undone, 1);

  editor.undoStack = [{ kind: "edit", count: 0 }];
  assert.throws(() => editor.undoWriterUpdates(), /latest edit is not a Beat Writer edit/);
});

test("sequencer modal remains a valid ESM module after extraction", async () => {
  const source = await readFile(new URL("audio_prompt_sequencer_modal.js", AUDIO_NODE_URL), "utf8");
  const module = await importModuleBody("audio_prompt_sequencer_modal.js", "const INSTANCES");
  assert.equal(typeof module.openBeatPromptSequencer, "function");
  assert.equal(typeof module.closeBeatPromptSequencerForNode, "function");
  assert.match(source, /flbps-writer-toggle/);
  assert.match(source, /onActivityChange/);
  assert.match(source, /updateWriterActivity/);
  assert.match(source, /lyricCount/);
  assert.match(source, /data-action="undo"/);
  assert.match(source, /data-action="redo"/);
  assert.match(source, /Ctrl\/Cmd\+Shift\+Z/);
});
