import { api } from "../../../../scripts/api.js";
import {
  cropTimes,
  cropTimesWithValues,
  sourceTimeToLocalFrame,
  waveformBinRange,
} from "./audio_timeline_coordinates.js";
import {
  defaultEnvelopeLayer,
  ENVELOPE_SOURCES,
  generateEnvelopeValues,
  normalizeEnvelopeLayer,
  parseEnvelopeLayers,
  serializeEnvelopeLayers,
} from "./audio_envelope.js";
import {
  cropWaveformPreview,
  medianInterval,
  normalizeWaveformPreview,
  sourceAnalysisFromCropPayload,
  sourceAnalysisValue,
} from "./audio_prompt_analysis.js";
import {
  loadRenderGroups,
  normalizeCrossfades,
  normalizeRenderGroups,
  parseTimeline,
  serializeRenderGroups,
  serializeTimeline,
  validateFrameClips,
} from "./audio_prompt_timeline.js";
import {
  FORMAT_VERSION,
  isCompatibleFormatVersion,
  restoreCachedAudioWidgets,
} from "./audio_prompt_sequencer_format.js";
import {
  applyPromptWriterUpdates,
  createPromptWriterDocument,
} from "./audio_prompt_writer_document.js";
import {
  applySongMapOverrides,
  createSongWriterContext,
  nextSongMapSectionId,
  normalizeSongMapOverrides,
  replaceSongMapSections,
  resetSongMapStructure,
  songCueColor,
  songSectionColor,
  songSectionLabel,
  updateSongMapOverride,
  validateSongMapSections,
} from "./audio_prompt_song_map.js";
import {
  createLyricsWriterContext,
  isLyricsTimelineCurrent,
  lyricsTimelineForStorage,
  nextLyricsSegmentId,
  normalizeLyricsTimeline,
  parseLrcLyrics,
  parseSrtLyrics,
  validateLyricsSegments,
} from "./audio_prompt_lyrics.js";
import { injectBeatPromptSequencerStyles } from "./audio_prompt_sequencer_styles.js";

const EPSILON = 1e-6;
const TIMELINE_LEFT = 16;
const TIMELINE_RIGHT = 12;
const LYRICS_LANGUAGES = new Set([
  "auto", "en", "es", "fr", "de", "it", "pt", "ru", "ja", "ko", "zh",
  "ar", "hi", "tr", "pl", "nl", "sv", "no", "da", "fi", "uk", "cs",
]);
const DEFAULT_CLIP_GRID_INTERVALS = 4;
const RENDER_GROUP_COLORS = ["#22d3ee", "#f59e0b", "#34d399", "#f472b6", "#60a5fa"];
const ENVELOPE_ACCENTS = ["#22d3ee", "#f59e0b", "#a78bfa"];
const GRID_DENSITY_LABELS = {
  every_2_beats: "Every 2 beats",
  every_beat: "Every beat",
  half_beat: "Half-beat",
};
const HISTORY_LIMIT = 50;
const HISTORY_WIDGETS = [
  "timeUnit",
  "fps",
  "sequenceDuration",
  "trimStartFrame",
  "halfTime",
  "beatOffset",
  "beatGridDensity",
  "defaultFadeIn",
  "defaultFadeOut",
  "curve",
  "analysisSource",
];

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function cloneHistoryValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function textHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function formatClock(seconds) {
  const value = Math.max(0, finiteNumber(seconds));
  const minutes = Math.floor(value / 60);
  const remainder = value - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(3).padStart(6, "0")}`;
}

function formatRulerTime(seconds) {
  const value = Math.max(0, finiteNumber(seconds));
  if (value < 60) return `${value.toFixed(value < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60);
  return `${minutes}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
}

function canvasTextLines(ctx, text, maxWidth, maximumLines = 2) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let line = "";
  while (words.length && lines.length < maximumLines) {
    const word = words.shift();
    const candidate = line ? `${line} ${word}` : word;
    if (!line || ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line && lines.length < maximumLines) lines.push(line);
  if (words.length && lines.length) {
    let last = `${lines.pop()}…`;
    while (last.length > 1 && ctx.measureText(last).width > maxWidth) {
      last = `${last.slice(0, -2)}…`;
    }
    lines.push(last);
  }
  return lines;
}

function executionPayload(message) {
  const values = message?.fl_prompt_sequencer ?? message?.ui?.fl_prompt_sequencer;
  return Array.isArray(values) ? values[0] : values;
}
function niceFrameStep(range, width, fps) {
  const target = Math.max(1, range / Math.max(2, width / 80));
  const candidates = new Set([1]);
  for (let power = 1; power <= Math.max(target * 10, 100); power *= 10) {
    candidates.add(power);
    candidates.add(2 * power);
    candidates.add(5 * power);
  }
  for (const multiple of [0.25, 0.5, 1, 2, 5, 10, 30, 60]) {
    candidates.add(Math.max(1, Math.round(fps * multiple)));
  }
  const ordered = [...candidates].sort((a, b) => a - b);
  return ordered.find((value) => value >= target) || ordered[ordered.length - 1];
}

function audioViewURL(value) {
  const match = String(value || "").match(/^(.*?)(?:\s+\[(input|output|temp)\])?$/);
  const relative = (match?.[1] || "").replace(/\\/g, "/");
  const slash = relative.lastIndexOf("/");
  const filename = slash >= 0 ? relative.slice(slash + 1) : relative;
  const subfolder = slash >= 0 ? relative.slice(0, slash) : "";
  const params = new URLSearchParams({
    filename,
    subfolder,
    type: match?.[2] || "input",
  });
  return api.apiURL(`/view?${params.toString()}`);
}

export class BeatPromptSequencer {
  constructor({ node, container, widgets, onStateChange = null, onHistoryChange = null }) {
    this.node = node;
    this.container = container;
    this.widgets = widgets;
    this.onStateChange = onStateChange;
    this.onHistoryChange = onHistoryChange;
    this.undoStack = [];
    this.redoStack = [];
    this.historyTransaction = null;
    this.historyBaseline = null;
    this.historySuspended = true;
    this.restoringHistory = false;
    this.audioHistoryResetPending = false;
    this.clips = [];
    this.selectedIndex = -1;
    this.selectedIndices = new Set();
    this.selectionAnchor = -1;
    this.playheadFrame = null;
    this.clipboardClip = null;
    this.clipboardSongSection = null;
    this.snapGuideFrame = null;
    this.drag = null;
    this.resnapPending = false;
    this.clipRects = [];
    this.crossfadeRects = [];
    this.songMapRects = [];
    this.songMapBoundaryRects = [];
    this.lyricsRects = [];
    this.songMapCache = null;
    this.selectedSongSectionId = null;
    this.selectedSongSectionIds = new Set();
    this.songSelectionAnchorId = null;
    this.editingSongSectionId = null;
    this.selectedLyricsSegmentId = null;
    this.activeLane = "prompt";
    this.rawLane = "prompt";
    this.pendingFrame = null;
    this.resizeObserver = null;
    this.callbackRestorers = [];
    this.rawInvalid = false;
    this.migrationPending = false;
    this.hover = null;
    this.envelopeSlots = parseEnvelopeLayers(this.widgets.envelopeLayers?.value);
    this.envelopePreviewValues = [null, null, null];
    this.envelopeDataVersion = 1;
    this.envelopeComputedVersion = 0;
    this.envelopeViewKey = "";
    this.inspectorTab = "prompt";
    this.sourceWaveformPreview = null;
    this.sourceAudioDuration = 0;
    this.sourceAnalysis = null;
    this.audioElement = null;
    this.staticCanvas = document.createElement("canvas");
    this.staticDirty = true;
    this.audioURL = "";
    this.playbackFrameRequest = null;
    this.analysisTimer = null;
    this.modelStatusTimer = null;
    this.modelStatusRequest = null;
    this.analysisRequest = 0;
    this.loadingAudio = false;
    this.separationJobId = node._flAudioSeparationJobId || null;
    this.separationTimer = null;
    this.transcriptionJobId = node._flAudioTranscriptionJobId || null;
    this.transcriptionTimer = null;
    this.contextMenu = null;
    this.writerActivity = null;
    this.writerActivityFrame = null;
    this.writerActivityTimer = null;
    this.writerActivityStartedAt = 0;
    this.writerCompletionFades = new Map();
    this.writerReducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || false;
    this.documentPointerHandler = (event) => {
      if (this.contextMenu && !this.contextMenu.contains(event.target)) {
        this.closeContextMenu();
      }
    };

    const saved = node.properties?.flBeatPromptSequencer || {};
    const savedCompatible = isCompatibleFormatVersion(saved.formatVersion);
    this.songMapOverrides = normalizeSongMapOverrides(
      savedCompatible ? saved.songMapOverrides : null,
    );
    this.lyricsTimeline = normalizeLyricsTimeline(savedCompatible ? saved.lyricsTimeline : null);
    const savedLyricsSettings = savedCompatible ? saved.lyricsSettings || {} : {};
    this.lyricsSettings = {
      source: ["auto", "vocals", "mix"].includes(savedLyricsSettings.source)
        ? savedLyricsSettings.source
        : "auto",
      model: ["small", "large-v3-turbo"].includes(savedLyricsSettings.model)
        ? savedLyricsSettings.model
        : "large-v3-turbo",
      language: LYRICS_LANGUAGES.has(String(savedLyricsSettings.language || "auto"))
        ? String(savedLyricsSettings.language || "auto")
        : "auto",
      includeInWriter: savedLyricsSettings.includeInWriter !== false,
      laneExpanded: savedLyricsSettings.laneExpanded !== false,
    };
    this.sourceAnalysis = savedCompatible ? sourceAnalysisValue(saved.sourceAnalysis) : null;
    this.beatData = savedCompatible && !this.sourceAnalysis ? saved.beatData || null : null;
    if (this.beatData) {
      this.beatData.waveformPreview = normalizeWaveformPreview(this.beatData.waveformPreview);
      this.sourceAnalysis = sourceAnalysisFromCropPayload(this.beatData);
      if (this.sourceAnalysis) this.beatData = null;
    }
    restoreCachedAudioWidgets(this.widgets, saved);
    this.dataFresh = false;
    this.viewStart = savedCompatible ? finiteNumber(saved.viewStart, 0) : 0;
    this.viewEnd = savedCompatible ? finiteNumber(saved.viewEnd, 0) : 0;
    this.autoAnalyze = saved.autoAnalyze !== false;
    this.playbackVolume = clamp(
      saved.playbackVolume == null ? 1 : finiteNumber(saved.playbackVolume, 1),
      0,
      1,
    );

    injectBeatPromptSequencerStyles();
    this.build();
    this.refreshTranscriptionModelStatus();
    this.activateLane("prompt");
    this.bindWidgetCallbacks();
    if (this.separationJobId) {
      this.root.querySelector('[data-action="separate"]').textContent = "Cancel separation";
      this.pollSeparation();
    }
    if (this.transcriptionJobId) {
      this.root.querySelector('[data-action="transcribe"]').textContent = "Cancel transcription";
      this.pollTranscription();
    }
    this.applyBeatOffset();
    this.loadTimeline();
    this.resnapClipsToGrid();
    this.refreshBeatStatus();
    if (!(this.viewEnd > this.viewStart)) this.zoomToFit(false);
    if (this.widgets.audioFile?.value) this.loadAudioSource();
    this.scheduleDraw();
    this.historySuspended = false;
    this.historyBaseline = this.captureHistoryState();
    this.notifyHistoryChange();
  }

  fps() {
    return Math.max(1, finiteNumber(this.widgets.fps?.value, 24));
  }

  beatOffsetMs() {
    return clamp(Math.round(finiteNumber(this.widgets.beatOffset?.value, 0)), -1000, 1000);
  }

  beatGridDensity() {
    const value = this.widgets.beatGridDensity?.value;
    return value in GRID_DENSITY_LABELS ? value : "every_beat";
  }

  configuredFrameCount() {
    return Math.max(0, Math.round(finiteNumber(this.widgets.sequenceDuration?.value, 0)));
  }

  defaultFadeIn() {
    return Math.max(0, finiteNumber(this.widgets.defaultFadeIn?.value, 0));
  }

  defaultFadeOut() {
    return Math.max(0, finiteNumber(this.widgets.defaultFadeOut?.value, 0));
  }

  build() {
    this.root = document.createElement("div");
    this.root.className = "flbps-root";
    this.root.tabIndex = 0;
    this.root.innerHTML = `
      <div class="flbps-transport">
        <button class="flbps-button" data-action="play" title="Play or pause the selected audio crop; playback loops continuously">Play</button>
        <button class="flbps-button" data-action="stop" title="Stop and return to the crop start">Stop</button>
        <label class="flbps-volume" title="Preview volume only; this does not change the node's audio output">
          <span class="flbps-volume-icon" data-role="playback-volume-icon" aria-hidden="true">&#128266;</span>
          <input data-role="playback-volume" type="range" min="0" max="100" step="1" aria-label="Preview playback volume">
          <span class="flbps-volume-value" data-role="playback-volume-value">100%</span>
        </label>
        <span class="flbps-transport-time" data-role="transport-time">00:00.000 / 00:00.000</span>
        <span class="flbps-source-label" data-role="source-label">No audio selected</span>
        <span class="flbps-spacer"></span>
        <span class="flbps-status" data-role="status">Choose audio to load the timeline</span>
        <label class="flbps-auto" title="Refresh beat, onset, and drum markers after the audio or transient source changes">
          <input data-role="auto-analyze" type="checkbox"> Auto analyze
        </label>
        <button class="flbps-button" data-action="analyze" title="Analyze beats, onsets, and drums without queueing the workflow">Analyze</button>
        <button class="flbps-button" data-action="separate" title="Explicitly separate and cache stems for analysis">Separate stems</button>
        <button class="flbps-button" data-action="transcribe" title="Transcribe a timed local lyrics track; the selected model downloads only from this action">Transcribe lyrics</button>
      </div>
      <div class="flbps-toolbar">
        <div class="flbps-control-group">
          <label class="flbps-control" title="Choose the spacing of the cyan grid used for display, snapping, and prompt timing.">
            Grid
            <select data-role="beat-grid-density">
              <option value="every_2_beats">Every 2 beats</option>
              <option value="every_beat">Every beat</option>
              <option value="half_beat">Half-beat</option>
            </select>
          </label>
        </div>
        <span class="flbps-toolbar-divider"></span>
        <span class="flbps-marker-legend" title="Grid lines move with Beat offset; raw model and transient ticks remain fixed">
          <span><b class="flbps-marker-beat">●</b> beat grid</span>
          <span><b class="flbps-marker-downbeat">◆</b> downbeat / bar start</span>
          <span><b class="flbps-marker-model">│</b> raw model beat</span>
          <span><b class="flbps-marker-onset">│</b> transient onset</span>
        </span>
        <span class="flbps-toolbar-divider"></span>
        <div class="flbps-control-group">
          <label class="flbps-control" title="Shift the cyan beat grid over the stationary waveform and detected reference ticks.">
            Beat offset
            <input data-role="beat-offset" type="range" min="-1000" max="1000" step="1">
            <input data-role="beat-offset-number" type="number" min="-1000" max="1000" step="1" aria-label="Beat offset in milliseconds">
            <span class="flbps-offset-frames" data-role="beat-offset-frames"></span>
          </label>
          <button class="flbps-button" data-action="reset-offset" title="Reset the beat offset to zero">Zero</button>
        </div>
        <span class="flbps-spacer"></span>
        <span class="flbps-control">Frames</span>
      </div>
      <div class="flbps-error" data-role="error"></div>
      <div class="flbps-canvas-wrap">
        <canvas class="flbps-canvas"></canvas>
        <input class="flbps-song-label-editor" data-role="song-label-editor" type="text" maxlength="48" aria-label="Song Map section name" hidden>
        <div class="flbps-empty" data-role="empty"></div>
      </div>
      <div class="flbps-actions">
        <span class="flbps-lane-badge" data-role="active-lane">Prompt track</span>
        <button class="flbps-button primary" data-action="add">+ Prompt</button>
        <button class="flbps-button" data-action="split">Split</button>
        <button class="flbps-button" data-action="duplicate">Duplicate</button>
        <button class="flbps-button danger" data-action="delete">Delete</button>
        <span class="flbps-spacer"></span>
        <button class="flbps-button" data-action="raw">Raw frames</button>
      </div>
      <div class="flbps-inspector-tabs" data-role="inspector-tabs">
        <button class="flbps-button active" data-inspector-tab="prompt">Timeline prompt</button>
        <button class="flbps-button" data-inspector-tab="envelopes">Reactive envelopes</button>
      </div>
      <div class="flbps-inspector" data-role="inspector" data-tab="prompt" data-lane="prompt">
        <section class="flbps-clip-inspector disabled" data-role="clip-inspector">
          <div class="flbps-inspector-grid">
            <div class="flbps-field"><label>Start frame</label><input data-field="start" type="number" min="0" step="1"></div>
            <div class="flbps-field"><label>End frame</label><input data-field="end" type="number" min="1" step="1"></div>
            <div class="flbps-field"><label>Duration</label><input data-field="clip-duration" type="text" readonly></div>
            <div class="flbps-field"><label>Fade in frames</label><input data-field="fade-in" type="number" min="0" step="1"></div>
            <div class="flbps-field"><label>Fade out frames</label><input data-field="fade-out" type="number" min="0" step="1"></div>
            <div class="flbps-field"><label>Crossfade frames</label><input data-field="crossfade" type="number" min="0" step="1" title="Blend from the touching previous prompt into this prompt"></div>
          </div>
          <div class="flbps-prompt-label">
            <span>Timeline prompt</span><span class="flbps-prompt-meta" data-role="prompt-meta"></span>
          </div>
          <textarea data-field="prompt" placeholder="Describe what should happen during this frame range."></textarea>
        </section>
        <section class="flbps-song-inspector disabled" data-role="song-inspector">
          <div class="flbps-inspector-grid">
            <div class="flbps-field"><label>Start frame</label><input data-song-field="start" type="number" min="0" step="1"></div>
            <div class="flbps-field"><label>End frame</label><input data-song-field="end" type="number" min="1" step="1"></div>
            <div class="flbps-field"><label>Duration</label><input data-song-field="duration" type="text" readonly></div>
            <div class="flbps-field"><label>Role</label><select data-song-field="role"><option value="unknown">Unknown</option><option value="intro">Intro</option><option value="verse">Verse</option><option value="pre_chorus">Pre-Chorus</option><option value="chorus">Chorus</option><option value="bridge">Bridge</option><option value="instrumental">Instrumental</option><option value="breakdown">Breakdown</option><option value="outro">Outro</option></select></div>
          </div>
          <div class="flbps-prompt-label"><span>Song Map section</span><span class="flbps-prompt-meta" data-role="song-meta"></span></div>
          <div class="flbps-song-summary" data-role="song-summary"></div>
          <div class="flbps-song-reset-actions">
            <button class="flbps-button" data-action="reset-song-labels">Reset labels</button>
            <button class="flbps-button" data-action="reset-song-structure">Reset structure</button>
            <button class="flbps-button danger" data-action="reset-song-map">Reset all</button>
          </div>
        </section>
        <section class="flbps-lyrics-inspector disabled" data-role="lyrics-inspector">
          <div class="flbps-inspector-grid">
            <div class="flbps-field"><label>Start frame</label><input data-lyrics-field="start" type="number" min="0" step="1"></div>
            <div class="flbps-field"><label>End frame</label><input data-lyrics-field="end" type="number" min="1" step="1"></div>
            <div class="flbps-field"><label>Duration</label><input data-lyrics-field="duration" type="text" readonly></div>
            <div class="flbps-field"><label>Source</label><select data-lyrics-setting="source"><option value="auto">Auto: vocals if available</option><option value="vocals">Vocals stem</option><option value="mix">Full mix</option></select></div>
            <div class="flbps-field"><label>Model</label><select data-lyrics-setting="model"><option value="large-v3-turbo">Whisper Large v3 Turbo</option><option value="small">Whisper Small</option></select></div>
            <div class="flbps-field"><label>Language</label><select data-lyrics-setting="language"><option value="auto">Auto detect</option><option value="en">English</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="it">Italian</option><option value="pt">Portuguese</option><option value="ru">Russian</option><option value="ja">Japanese</option><option value="ko">Korean</option><option value="zh">Chinese</option><option value="ar">Arabic</option><option value="hi">Hindi</option><option value="tr">Turkish</option><option value="pl">Polish</option><option value="nl">Dutch</option><option value="sv">Swedish</option><option value="no">Norwegian</option><option value="da">Danish</option><option value="fi">Finnish</option><option value="uk">Ukrainian</option><option value="cs">Czech</option></select></div>
          </div>
          <div class="flbps-prompt-label"><span>Timed lyrics</span><span class="flbps-prompt-meta" data-role="lyrics-meta"></span></div>
          <textarea data-lyrics-field="text" maxlength="1000" placeholder="Select a lyric segment, transcribe the song, or import timed lyrics."></textarea>
          <div class="flbps-lyrics-controls">
            <label class="flbps-auto" title="Timed lyric text is sent with prompt boxes; audio is never sent"><input data-lyrics-setting="include-writer" type="checkbox"> Include timed lyrics in Beat Writer</label>
            <span class="flbps-spacer"></span>
            <button class="flbps-button" data-action="import-lyrics">Import LRC/SRT</button>
            <button class="flbps-button" data-action="reset-lyrics">Reset from transcription</button>
            <button class="flbps-button danger" data-action="discard-lyrics">Discard lyrics</button>
          </div>
          <div class="flbps-lyrics-status" data-role="lyrics-status">No timed lyrics yet.</div>
        </section>
        <section class="flbps-envelope-panel" data-role="envelope-panel">
          <div class="flbps-envelope-header">
            <span class="flbps-envelope-title">Reactive prompt envelopes</span>
            <span class="flbps-envelope-limit">3 max</span>
            <span class="flbps-spacer"></span>
            <button class="flbps-button" data-action="add-envelope">+ Envelope</button>
          </div>
          <div class="flbps-envelope-cards" data-role="envelope-cards"></div>
        </section>
      </div>
      <div class="flbps-raw" data-role="raw-panel">
        <div class="flbps-raw-label" data-role="raw-label">Advanced frame schedule. All positions, fades, and crossfades must be integer frames.</div>
        <textarea data-role="raw-text"></textarea>
        <div class="flbps-raw-actions">
          <button class="flbps-button" data-action="raw-cancel">Close</button>
          <button class="flbps-button primary" data-action="raw-apply">Apply frames</button>
        </div>
      </div>
      <div class="flbps-footer">
        <span>Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z redo · Ctrl/Cmd+C copy · Ctrl/Cmd+V paste at playhead · Ctrl/Cmd+D duplicate · Shift/Ctrl select prompts · Space play/pause</span>
      </div>
    `;
    this.container.appendChild(this.root);

    this.statusEl = this.root.querySelector('[data-role="status"]');
    this.errorEl = this.root.querySelector('[data-role="error"]');
    this.emptyEl = this.root.querySelector('[data-role="empty"]');
    this.canvas = this.root.querySelector(".flbps-canvas");
    this.songLabelEditor = this.root.querySelector('[data-role="song-label-editor"]');
    this.inspector = this.root.querySelector('[data-role="inspector"]');
    this.clipInspector = this.root.querySelector('[data-role="clip-inspector"]');
    this.songInspector = this.root.querySelector('[data-role="song-inspector"]');
    this.lyricsInspector = this.root.querySelector('[data-role="lyrics-inspector"]');
    this.activeLaneEl = this.root.querySelector('[data-role="active-lane"]');
    this.envelopePanel = this.root.querySelector('[data-role="envelope-panel"]');
    this.envelopeCards = this.root.querySelector('[data-role="envelope-cards"]');
    this.addEnvelopeButton = this.root.querySelector('[data-action="add-envelope"]');
    this.rawPanel = this.root.querySelector('[data-role="raw-panel"]');
    this.rawText = this.root.querySelector('[data-role="raw-text"]');
    this.rawLabel = this.root.querySelector('[data-role="raw-label"]');
    this.promptMetaEl = this.root.querySelector('[data-role="prompt-meta"]');
    this.songMetaEl = this.root.querySelector('[data-role="song-meta"]');
    this.songSummaryEl = this.root.querySelector('[data-role="song-summary"]');
    this.lyricsMetaEl = this.root.querySelector('[data-role="lyrics-meta"]');
    this.lyricsStatusEl = this.root.querySelector('[data-role="lyrics-status"]');
    this.transportTimeEl = this.root.querySelector('[data-role="transport-time"]');
    this.sourceLabelEl = this.root.querySelector('[data-role="source-label"]');
    this.controls = {
      beatGridDensity: this.root.querySelector('[data-role="beat-grid-density"]'),
      autoAnalyze: this.root.querySelector('[data-role="auto-analyze"]'),
      beatOffset: this.root.querySelector('[data-role="beat-offset"]'),
      beatOffsetNumber: this.root.querySelector('[data-role="beat-offset-number"]'),
      beatOffsetFrames: this.root.querySelector('[data-role="beat-offset-frames"]'),
      playbackVolume: this.root.querySelector('[data-role="playback-volume"]'),
      playbackVolumeIcon: this.root.querySelector('[data-role="playback-volume-icon"]'),
      playbackVolumeValue: this.root.querySelector('[data-role="playback-volume-value"]'),
    };
    this.fields = {
      start: this.root.querySelector('[data-field="start"]'),
      end: this.root.querySelector('[data-field="end"]'),
      duration: this.root.querySelector('[data-field="clip-duration"]'),
      fadeIn: this.root.querySelector('[data-field="fade-in"]'),
      fadeOut: this.root.querySelector('[data-field="fade-out"]'),
      crossfade: this.root.querySelector('[data-field="crossfade"]'),
      prompt: this.root.querySelector('[data-field="prompt"]'),
    };
    this.songFields = {
      start: this.root.querySelector('[data-song-field="start"]'),
      end: this.root.querySelector('[data-song-field="end"]'),
      duration: this.root.querySelector('[data-song-field="duration"]'),
      role: this.root.querySelector('[data-song-field="role"]'),
    };
    this.lyricsFields = {
      start: this.root.querySelector('[data-lyrics-field="start"]'),
      end: this.root.querySelector('[data-lyrics-field="end"]'),
      duration: this.root.querySelector('[data-lyrics-field="duration"]'),
      text: this.root.querySelector('[data-lyrics-field="text"]'),
      source: this.root.querySelector('[data-lyrics-setting="source"]'),
      model: this.root.querySelector('[data-lyrics-setting="model"]'),
      language: this.root.querySelector('[data-lyrics-setting="language"]'),
      includeInWriter: this.root.querySelector('[data-lyrics-setting="include-writer"]'),
    };
    this.lyricsImportInput = document.createElement("input");
    this.lyricsImportInput.type = "file";
    this.lyricsImportInput.accept = ".lrc,.srt,application/x-subrip,text/plain";
    this.lyricsImportInput.hidden = true;
    this.root.appendChild(this.lyricsImportInput);
    this.editButtons = [
      ...this.root.querySelectorAll('[data-action="add"], [data-action="split"], [data-action="duplicate"], [data-action="delete"]'),
    ];

    for (const button of this.root.querySelectorAll("[data-inspector-tab]")) {
      button.addEventListener("click", () => this.setInspectorTab(button.dataset.inspectorTab));
    }
    this.addEnvelopeButton.addEventListener("click", () => this.runEdit("Add envelope", () => this.addEnvelope()));
    this.renderEnvelopeEditor();

    this.controls.beatGridDensity.value = this.beatGridDensity();
    this.controls.autoAnalyze.checked = this.autoAnalyze;
    this.syncBeatOffsetControls();
    this.syncPlaybackVolumeControl();
    this.controls.beatGridDensity.addEventListener("change", () => {
      this.runEdit("Change beat grid density", () => {
        this.setBeatGridDensity(this.controls.beatGridDensity.value);
      });
    });
    this.controls.autoAnalyze.addEventListener("change", () => {
      this.autoAnalyze = this.controls.autoAnalyze.checked;
      this.saveViewState(false);
      if (this.autoAnalyze) this.requestAnalysis();
    });
    const beginBeatOffsetEdit = () => {
      if (!this.historyTransaction) this.beginEdit("Change beat offset");
    };
    this.controls.beatOffset.addEventListener("pointerdown", beginBeatOffsetEdit);
    this.controls.beatOffset.addEventListener("focus", beginBeatOffsetEdit);
    this.controls.beatOffset.addEventListener("input", () => {
      beginBeatOffsetEdit();
      this.setBeatOffset(this.controls.beatOffset.value);
    });
    this.controls.beatOffset.addEventListener("change", () => {
      this.setBeatOffset(this.controls.beatOffset.value, true, true);
    });
    const finishBeatOffsetEdit = () => {
      this.setBeatOffset(this.controls.beatOffset.value, true, true);
      this.commitEdit();
    };
    this.controls.beatOffset.addEventListener("pointerup", finishBeatOffsetEdit);
    this.controls.beatOffset.addEventListener("pointercancel", finishBeatOffsetEdit);
    this.controls.beatOffset.addEventListener("blur", () => this.commitEdit());
    this.controls.beatOffsetNumber.addEventListener("focus", beginBeatOffsetEdit);
    this.controls.beatOffsetNumber.addEventListener("input", () => {
      if (this.controls.beatOffsetNumber.value !== "") {
        beginBeatOffsetEdit();
        this.setBeatOffset(this.controls.beatOffsetNumber.value);
      }
    });
    this.controls.beatOffsetNumber.addEventListener("change", () => {
      this.setBeatOffset(this.controls.beatOffsetNumber.value, true, true);
      this.commitEdit();
    });
    this.controls.beatOffsetNumber.addEventListener("blur", () => this.commitEdit());
    this.root.querySelector('[data-action="reset-offset"]').addEventListener("click", () => {
      this.runEdit("Reset beat offset", () => this.setBeatOffset(0, true, true));
    });
    this.root.querySelector('[data-action="play"]').addEventListener("click", () => this.togglePlayback());
    this.root.querySelector('[data-action="stop"]').addEventListener("click", () => this.stopPlayback());
    this.controls.playbackVolume.addEventListener("input", () => {
      this.setPlaybackVolume(this.controls.playbackVolume.value / 100);
    });
    this.controls.playbackVolume.addEventListener("change", () => {
      this.setPlaybackVolume(this.controls.playbackVolume.value / 100, true);
    });
    this.root.querySelector('[data-action="analyze"]').addEventListener("click", () => this.requestAnalysis(true));
    this.root.querySelector('[data-action="separate"]').addEventListener("click", () => this.startSeparation());
    this.root.querySelector('[data-action="transcribe"]').addEventListener("click", () => this.startTranscription());
    this.root.querySelector('[data-action="add"]').addEventListener("click", () => this.runEdit(
      this.activeLane === "song-map" ? "Add Song Map section" :
        this.activeLane === "lyrics" ? "Add lyric" : "Add prompt",
      () => this.activeLane === "song-map" ? this.addSongSection() :
        this.activeLane === "lyrics" ? this.addLyricsSegment() : this.addClip(),
    ));
    this.root.querySelector('[data-action="split"]').addEventListener("click", () => this.runEdit(
      this.activeLane === "song-map" ? "Split Song Map section" :
        this.activeLane === "lyrics" ? "Split lyric" : "Split prompt",
      () => this.activeLane === "song-map" ? this.splitSongSection() :
        this.activeLane === "lyrics" ? this.splitLyricsSegment() : this.splitClip(),
    ));
    this.root.querySelector('[data-action="duplicate"]').addEventListener("click", () => this.runEdit(
      this.activeLane === "song-map" ? "Duplicate Song Map section" :
        this.activeLane === "lyrics" ? "Merge lyrics" : "Duplicate prompt",
      () => this.activeLane === "song-map" ? this.duplicateSongSection() :
        this.activeLane === "lyrics" ? this.mergeLyricsSegment() : this.duplicateClip(),
    ));
    this.root.querySelector('[data-action="delete"]').addEventListener("click", () => this.runEdit(
      this.activeLane === "song-map" ? "Delete Song Map section" :
        this.activeLane === "lyrics" ? "Delete lyric" : "Delete prompt",
      () => this.activeLane === "song-map" ? this.deleteSongSection() :
        this.activeLane === "lyrics" ? this.deleteLyricsSegment() : this.deleteClip(),
    ));
    this.root.querySelector('[data-action="raw"]').addEventListener("click", () => this.toggleRaw());
    this.root.querySelector('[data-action="raw-cancel"]').addEventListener("click", () => this.toggleRaw(false));
    this.root.querySelector('[data-action="raw-apply"]').addEventListener("click", () => this.runEdit(
      this.rawLane === "song-map" ? "Apply raw Song Map" : "Apply raw prompt schedule",
      () => this.applyRaw(),
    ));

    for (const name of ["start", "end", "fadeIn", "fadeOut", "crossfade"]) {
      this.fields[name].addEventListener("change", () => this.runEdit("Edit prompt timing", () => this.applyInspectorTiming()));
    }
    for (const name of ["start", "end", "role"]) {
      this.songFields[name].addEventListener("change", () => this.runEdit("Edit Song Map section", () => this.applySongInspector()));
    }
    for (const name of ["start", "end"]) {
      this.lyricsFields[name].addEventListener("change", () => this.runEdit("Edit lyric timing", () => this.applyLyricsInspector()));
    }
    this.lyricsFields.text.addEventListener("change", () => this.runEdit("Edit lyric text", () => this.applyLyricsText()));
    for (const name of ["source", "model", "language"]) {
      this.lyricsFields[name].addEventListener("change", () => {
        this.lyricsSettings[name] = this.lyricsFields[name].value;
        this.saveViewState(false);
        this.refreshTranscriptionModelStatus();
      });
    }
    this.lyricsFields.includeInWriter.addEventListener("change", () => {
      this.runEdit("Change Writer lyrics context", () => {
        this.lyricsSettings.includeInWriter = this.lyricsFields.includeInWriter.checked;
        this.saveViewState();
        this.syncLyricsInspector();
      });
    });
    this.root.querySelector('[data-action="import-lyrics"]').addEventListener("click", () => this.lyricsImportInput.click());
    this.lyricsImportInput.addEventListener("change", () => this.importLyricsFile());
    this.root.querySelector('[data-action="reset-lyrics"]').addEventListener("click", () => this.resetLyricsFromCache());
    this.root.querySelector('[data-action="discard-lyrics"]').addEventListener("click", () => this.discardLyrics());
    this.songLabelEditor.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.finishSongLabelEdit(true);
        event.preventDefault();
        event.stopPropagation();
      } else if (event.key === "Escape") {
        this.finishSongLabelEdit(false);
        event.preventDefault();
        event.stopPropagation();
      }
    });
    this.songLabelEditor.addEventListener("blur", () => this.finishSongLabelEdit(true));
    this.root.querySelector('[data-action="reset-song-labels"]').addEventListener("click", () => this.runEdit("Reset Song Map labels", () => this.resetSongLabels()));
    this.root.querySelector('[data-action="reset-song-structure"]').addEventListener("click", () => this.runEdit("Reset Song Map structure", () => this.resetSongStructure()));
    this.root.querySelector('[data-action="reset-song-map"]').addEventListener("click", () => this.runEdit("Reset Song Map", () => this.resetEntireSongMap()));
    this.fields.prompt.addEventListener("focus", () => this.beginEdit("Edit prompt text"));
    this.fields.prompt.addEventListener("blur", () => this.commitEdit());
    this.fields.prompt.addEventListener("input", () => {
      if (!this.historyTransaction) this.beginEdit("Edit prompt text");
      const clip = this.selectedClip();
      if (!clip) return;
      clip.prompt = this.fields.prompt.value;
      this.serialize();
      this.scheduleDraw();
    });

    this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    this.canvas.addEventListener("pointerleave", () => {
      if (!this.drag) {
        this.hover = null;
        this.canvas.style.cursor = "default";
        this.scheduleDraw();
      }
    });
    this.canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
    this.canvas.addEventListener("pointercancel", (event) => this.onPointerUp(event));
    this.canvas.addEventListener("dblclick", (event) => this.onDoubleClick(event));
    this.canvas.addEventListener("contextmenu", (event) => this.onContextMenu(event));
    this.canvas.addEventListener("auxclick", (event) => {
      if (event.button === 1) event.preventDefault();
    });
    this.canvas.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
    this.root.addEventListener("keydown", (event) => this.onKeyDown(event));
    document.addEventListener("pointerdown", this.documentPointerHandler, true);

    this.resizeObserver = new ResizeObserver(() => this.scheduleDraw());
    this.resizeObserver.observe(this.canvas.parentElement);
  }

  bindWidgetCallbacks() {
    const bind = (widget, callback) => {
      if (!widget) return;
      const original = widget.callback;
      widget.callback = (value) => {
        original?.call(widget, value);
        callback(value);
      };
      this.callbackRestorers.push(() => {
        widget.callback = original;
      });
    };

    bind(this.widgets.timeUnit, () => {
      this.loadTimeline();
      this.resnapClipsToGrid();
    });
    bind(this.widgets.fps, () => {
      this.syncInspector();
      this.syncBeatOffsetControls();
      this.refreshBrowserCrop();
      this.resnapClipsToGrid();
      this.zoomToFit();
      this.markDirty();
    });
    bind(this.widgets.sequenceDuration, () => {
      this.refreshBrowserCrop();
      this.resnapClipsToGrid();
      this.zoomToFit();
      this.markDirty();
    });
    bind(this.widgets.audioFile, () => {
      this.audioHistoryResetPending = true;
      this.clearHistory();
      if (this.widgets.analysisCacheKey) this.widgets.analysisCacheKey.value = "";
      this.loadAudioSource();
      this.syncLyricsInspector();
      this.scheduleDraw();
    });
    bind(this.widgets.trimStartFrame, () => {
      this.refreshBrowserCrop();
      this.syncLyricsInspector();
    });
    bind(this.widgets.halfTime, () => {
      this.refreshBrowserCrop();
      this.resnapClipsToGrid();
      this.resnapSongMapToGrid();
      this.markDirty();
    });
    bind(this.widgets.beatOffset, (value) => this.setBeatOffset(value, false, true));
    bind(this.widgets.analysisSource, () => {
      this.invalidateAnalysis();
      this.scheduleAnalysis();
    });
    bind(this.widgets.beatGridDensity, (value) => this.setBeatGridDensity(value, false));
    bind(this.widgets.defaultFadeIn, () => this.markDirty());
    bind(this.widgets.defaultFadeOut, () => this.markDirty());
    bind(this.widgets.curve, () => this.markDirty());
  }

  captureHistorySelection() {
    return {
      activeLane: this.activeLane,
      inspectorTab: this.inspectorTab,
      selectedIndex: this.selectedIndex,
      selectedIndices: [...(this.selectedIndices || [])],
      selectionAnchor: this.selectionAnchor,
      selectedSongSectionId: this.selectedSongSectionId,
      selectedSongSectionIds: [...(this.selectedSongSectionIds || [])],
      songSelectionAnchorId: this.songSelectionAnchorId,
      selectedLyricsSegmentId: this.selectedLyricsSegmentId,
    };
  }

  captureHistoryState() {
    const widgetValues = {};
    for (const name of HISTORY_WIDGETS) widgetValues[name] = cloneHistoryValue(this.widgets?.[name]?.value);
    return {
      clips: cloneHistoryValue(this.clips || []),
      songMapOverrides: cloneHistoryValue(this.songMapOverrides),
      lyricsTimeline: cloneHistoryValue(lyricsTimelineForStorage(this.lyricsTimeline)),
      envelopeSlots: cloneHistoryValue(this.envelopeSlots || [null, null, null]),
      lyricsIncludeInWriter: this.lyricsSettings?.includeInWriter !== false,
      widgetValues,
      selection: this.captureHistorySelection(),
    };
  }

  historyStateKey(state) {
    if (!state) return "";
    return JSON.stringify({
      clips: state.clips,
      songMapOverrides: state.songMapOverrides,
      lyricsTimeline: state.lyricsTimeline,
      envelopeSlots: state.envelopeSlots,
      lyricsIncludeInWriter: state.lyricsIncludeInWriter,
      widgetValues: state.widgetValues,
    });
  }

  notifyHistoryChange() {
    this.onHistoryChange?.({
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      undoLabel: this.nextUndoLabel(),
      redoLabel: this.nextRedoLabel(),
    });
  }

  beginEdit(label, options = {}) {
    if (this.historySuspended !== false || this.restoringHistory) return;
    if (this.audioHistoryResetPending) {
      this.audioHistoryResetPending = false;
      this.clearHistory();
    }
    if (this.historyTransaction) {
      this.historyTransaction.depth++;
      return;
    }
    this.historyTransaction = {
      label: String(label || "Edit sequencer"),
      before: this.captureHistoryState(),
      depth: 1,
      kind: options.kind || "edit",
      count: finiteNumber(options.count, 0),
      mergeKey: options.mergeKey || "",
    };
  }

  commitEdit(metadata = null) {
    const transaction = this.historyTransaction;
    if (!transaction) return false;
    if (--transaction.depth > 0) return false;
    this.historyTransaction = null;
    if (metadata) Object.assign(transaction, metadata);
    const after = this.captureHistoryState();
    if (this.historyStateKey(transaction.before) === this.historyStateKey(after)) {
      this.historyBaseline = after;
      return false;
    }
    this.pushHistoryEntry({ ...transaction, after });
    return true;
  }

  cancelEdit() {
    const transaction = this.historyTransaction;
    if (!transaction) return;
    this.historyTransaction = null;
    if (this.historyStateKey(transaction.before) !== this.historyStateKey(this.captureHistoryState())) {
      this.restoreHistoryState(transaction.before);
    } else {
      this.historyBaseline = this.captureHistoryState();
    }
  }

  runEdit(label, callback, options = {}) {
    if (this.historySuspended !== false || this.restoringHistory) return callback();
    if (options.isolated) {
      while (this.historyTransaction) this.commitEdit();
    }
    this.beginEdit(label, options);
    try {
      return callback();
    } finally {
      this.commitEdit();
    }
  }

  pushHistoryEntry(entry) {
    this.undoStack ||= [];
    this.redoStack ||= [];
    const now = performance.now();
    const previous = this.undoStack.at(-1);
    if (entry.mergeKey && previous?.mergeKey === entry.mergeKey && now - previous.timestamp < 700) {
      previous.after = entry.after;
      previous.label = entry.label;
      previous.kind = entry.kind;
      previous.count = entry.count;
      previous.timestamp = now;
    } else {
      this.undoStack.push({ ...entry, timestamp: now });
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    }
    this.redoStack = [];
    this.historyBaseline = entry.after;
    this.notifyHistoryChange();
  }

  recordHistoryMutation(label = "Edit sequencer") {
    if (this.historySuspended !== false || this.restoringHistory || this.historyTransaction) return;
    const after = this.captureHistoryState();
    if (this.audioHistoryResetPending) {
      this.historyBaseline = after;
      return;
    }
    const before = this.historyBaseline || after;
    if (this.historyStateKey(before) === this.historyStateKey(after)) {
      this.historyBaseline = after;
      return;
    }
    this.pushHistoryEntry({ label, before, after, kind: "edit", count: 0, mergeKey: "" });
  }

  clearHistory() {
    this.historyTransaction = null;
    this.undoStack = [];
    this.redoStack = [];
    this.historyBaseline = this.captureHistoryState();
    this.notifyHistoryChange();
  }

  canUndo() {
    return Boolean(this.undoStack?.length);
  }

  canRedo() {
    return Boolean(this.redoStack?.length);
  }

  nextUndoLabel() {
    return this.undoStack?.at(-1)?.label || "";
  }

  nextRedoLabel() {
    return this.redoStack?.at(-1)?.label || "";
  }

  restoreHistoryState(state) {
    if (!state) return;
    const previousAnalysisSource = this.widgets.analysisSource?.value;
    this.restoringHistory = true;
    try {
      this.closeContextMenu();
      this.editingSongSectionId = null;
      this.songLabelEditor.hidden = true;
      this.toggleRaw(false);
      for (const [name, value] of Object.entries(state.widgetValues || {})) {
        if (this.widgets[name]) this.widgets[name].value = cloneHistoryValue(value);
      }
      this.clips = normalizeCrossfades(cloneHistoryValue(state.clips || []));
      this.songMapOverrides = normalizeSongMapOverrides(cloneHistoryValue(state.songMapOverrides));
      this.lyricsTimeline = normalizeLyricsTimeline(cloneHistoryValue(state.lyricsTimeline));
      this.envelopeSlots = cloneHistoryValue(state.envelopeSlots || [null, null, null]);
      this.lyricsSettings.includeInWriter = state.lyricsIncludeInWriter !== false;

      const selection = state.selection || {};
      this.selectedIndex = Number.isInteger(selection.selectedIndex) ? selection.selectedIndex : -1;
      this.selectedIndices = new Set(selection.selectedIndices || []);
      this.selectionAnchor = Number.isInteger(selection.selectionAnchor) ? selection.selectionAnchor : this.selectedIndex;
      this.selectedSongSectionId = selection.selectedSongSectionId || null;
      this.selectedSongSectionIds = new Set(selection.selectedSongSectionIds || []);
      this.songSelectionAnchorId = selection.songSelectionAnchorId || null;
      this.selectedLyricsSegmentId = selection.selectedLyricsSegmentId || null;
      this.rawInvalid = false;
      this.migrationPending = false;

      const duration = this.sequenceFrameCount();
      if (!(this.viewEnd > this.viewStart) || this.viewStart >= duration || this.viewEnd > duration) {
        this.viewStart = 0;
        this.viewEnd = duration;
      }
      if (this.playheadFrame != null) this.playheadFrame = clamp(this.playheadFrame, 0, duration);

      if (this.widgets.timeline) this.widgets.timeline.value = serializeTimeline(this.clips);
      if (this.widgets.renderGroups) this.widgets.renderGroups.value = serializeRenderGroups(this.clips);
      if (this.widgets.envelopeLayers) this.widgets.envelopeLayers.value = serializeEnvelopeLayers(this.envelopeSlots);
      this.rawText.value = this.widgets.timeline?.value || "";
      if (this.widgets.analysisSource?.value !== previousAnalysisSource) {
        this.invalidateAnalysis();
        this.scheduleAnalysis();
      }
      this.applyBeatOffset();
      this.refreshBrowserCrop();
      this.renderEnvelopeEditor();
      this.saveViewState();
      this.setEditorEnabled(true);
      this.clearError();
      this.activateLane(selection.activeLane || "prompt");
      this.setInspectorTab(selection.inspectorTab || "prompt");
      this.syncBeatOffsetControls();
      if (this.controls?.beatGridDensity) this.controls.beatGridDensity.value = this.beatGridDensity();
      this.syncInspector();
      this.scheduleDraw();
    } finally {
      this.restoringHistory = false;
    }
    this.historyBaseline = this.captureHistoryState();
    this.node.graph?.change?.();
    this.onStateChange?.();
  }

  undo() {
    while (this.historyTransaction) this.commitEdit();
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.redoStack.push(entry);
    this.restoreHistoryState(entry.before);
    this.notifyHistoryChange();
    return true;
  }

  redo() {
    while (this.historyTransaction) this.commitEdit();
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.undoStack.push(entry);
    this.restoreHistoryState(entry.after);
    this.notifyHistoryChange();
    return true;
  }

  commitFocusedEdit() {
    const active = document.activeElement;
    if (active && this.root.contains(active) &&
        (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.isContentEditable)) {
      active.blur();
    }
    while (this.historyTransaction) this.commitEdit();
  }

  markDirty(recordHistory = true) {
    if (this.restoringHistory) return;
    if (recordHistory) this.recordHistoryMutation();
    this.node.graph?.change?.();
    this.onStateChange?.();
  }

  syncBeatOffsetControls() {
    if (!this.controls?.beatOffset) return;
    const offset = this.beatOffsetMs();
    const sign = offset > 0 ? "+" : "";
    const frames = offset / 1000 * this.fps();
    const frameSign = frames > 0 ? "+" : "";
    this.controls.beatOffset.value = String(offset);
    this.controls.beatOffsetNumber.value = String(offset);
    this.controls.beatOffsetFrames.textContent =
      `${sign}${offset} ms · ${frameSign}${frames.toFixed(2)} fr`;
  }

  cropBounds() {
    const sourceDuration = this.sourceDurationSeconds();
    const start = clamp(this.cropStartSeconds(), 0, sourceDuration);
    const duration = Math.min(this.cropDurationSeconds(), Math.max(0, sourceDuration - start));
    return { start, end: start + duration, duration, sourceDuration };
  }

  sourceBeatValues() {
    const source = this.sourceAnalysis;
    if (!source?.beatTimes?.length) return null;
    if (!source.supportsHalfTime || !this.widgets.halfTime?.value) {
      const interval = source.baseGridIntervalSeconds ||
        medianInterval(source.beatTimes) ||
        (source.bpm > 0 ? 60 / source.bpm : 0);
      return {
        beats: source.beatTimes,
        downbeats: source.downbeatTimes,
        detectedBeats: source.detectedBeatTimes,
        detectedDownbeats: source.detectedDownbeatTimes,
        beatConfidences: source.detectedBeatConfidences,
        downbeatConfidences: source.detectedDownbeatConfidences,
        interval,
        bpm: interval > 0 ? 60 / interval : source.bpm,
      };
    }

    const retained = source.beatTimes.map((_, index) => index).filter((index) => index % 2 === 0);
    const retainedSet = new Set(retained);
    const beats = retained.map((index) => source.beatTimes[index]);
    const beatConfidences = retained
      .filter((index) => index < source.detectedBeatConfidences.length)
      .map((index) => source.detectedBeatConfidences[index]);
    const downbeats = [];
    const downbeatConfidences = [];
    for (let index = 0; index < source.downbeatTimes.length; index++) {
      const downbeat = source.downbeatTimes[index];
      let nearest = 0;
      for (let position = 1; position < source.beatTimes.length; position++) {
        if (Math.abs(source.beatTimes[position] - downbeat) <
            Math.abs(source.beatTimes[nearest] - downbeat)) {
          nearest = position;
        }
      }
      if (!retainedSet.has(nearest)) continue;
      downbeats.push(downbeat);
      if (index < source.detectedDownbeatConfidences.length) {
        downbeatConfidences.push(source.detectedDownbeatConfidences[index]);
      }
    }
    const interval = medianInterval(beats);
    return {
      beats,
      downbeats,
      detectedBeats: beats,
      detectedDownbeats: downbeats,
      beatConfidences,
      downbeatConfidences,
      interval,
      bpm: interval > 0 ? 60 / interval : source.bpm,
    };
  }

  baseGridIntervalSeconds() {
    const sourceValues = this.sourceBeatValues();
    if (sourceValues) return sourceValues.interval;
    const values = this.beatData?.baseBeatTimes || [];
    const configured = finiteNumber(this.beatData?.baseGridIntervalSeconds);
    if (configured > 0) return configured;
    const interval = medianInterval(values);
    if (interval > 0) return interval;
    const bpm = finiteNumber(this.beatData?.bpm);
    return bpm > 0 ? 60 / bpm : 0;
  }

  gridIntervalSeconds() {
    const interval = this.baseGridIntervalSeconds();
    if (this.beatGridDensity() === "every_2_beats") return interval * 2;
    if (this.beatGridDensity() === "half_beat") return interval / 2;
    return interval;
  }

  baseGridTimes() {
    const values = this.sourceBeatValues()?.beats || this.beatData?.baseBeatTimes || [];
    if (this.beatGridDensity() === "every_2_beats") {
      return values.filter((_, index) => index % 2 === 0);
    }
    if (this.beatGridDensity() !== "half_beat") return values;
    const result = [];
    for (let index = 0; index < values.length; index++) {
      result.push(values[index]);
      if (index + 1 < values.length) result.push((values[index] + values[index + 1]) / 2);
    }
    return result;
  }

  gridBeatTimes(offsetMs = this.beatOffsetMs(), cropToView = true) {
    const values = this.baseGridTimes();
    const sourceMode = Boolean(this.sourceAnalysis);
    const duration = sourceMode
      ? this.sourceDurationSeconds()
      : Math.max(0, finiteNumber(this.beatData?.audioDuration));
    const interval = this.gridIntervalSeconds();
    if (!values.length || !(duration > 0) || !(interval > 0)) return [];
    const offset = finiteNumber(offsetMs) / 1000;
    const shifted = values.map((value) => finiteNumber(value) + offset);
    const result = shifted.filter((value) => value >= 0 && value < duration);
    if (offset > 0) {
      for (let beatTime = shifted[0] - interval; beatTime >= 0; beatTime -= interval) {
        if (beatTime < duration) result.unshift(beatTime);
      }
    } else if (offset < 0) {
      for (let beatTime = shifted[shifted.length - 1] + interval;
        beatTime < duration;
        beatTime += interval) {
        if (beatTime >= 0) result.push(beatTime);
      }
    }
    if (!sourceMode || !cropToView) return result;
    const crop = this.cropBounds();
    return cropTimes(result, crop.start, crop.end);
  }

  gridDownbeatTimes(offsetMs = this.beatOffsetMs(), cropToView = true) {
    const sourceValues = this.sourceBeatValues();
    const beats = sourceValues?.beats || this.beatData?.baseBeatTimes || [];
    const downbeats = sourceValues?.downbeats || this.beatData?.baseDownbeatTimes || [];
    const sourceMode = Boolean(this.sourceAnalysis);
    const duration = sourceMode
      ? this.sourceDurationSeconds()
      : Math.max(0, finiteNumber(this.beatData?.audioDuration));
    const offset = finiteNumber(offsetMs) / 1000;
    if (!beats.length || !downbeats.length || !(duration > 0)) return [];
    const density = this.beatGridDensity();
    const result = [];
    for (const downbeat of downbeats) {
      let nearest = 0;
      for (let index = 1; index < beats.length; index++) {
        if (Math.abs(beats[index] - downbeat) < Math.abs(beats[nearest] - downbeat)) nearest = index;
      }
      if (Math.abs(beats[nearest] - downbeat) > 0.021) continue;
      if (density === "every_2_beats" && nearest % 2 !== 0) continue;
      const shifted = finiteNumber(beats[nearest]) + offset;
      if (shifted >= 0 && shifted < duration) result.push(shifted);
    }
    if (!sourceMode || !cropToView) return result;
    const crop = this.cropBounds();
    return cropTimes(result, crop.start, crop.end);
  }

  projectSourceAnalysis() {
    const source = this.sourceAnalysis;
    const sourceValues = this.sourceBeatValues();
    if (!source || !sourceValues) return false;
    const crop = this.cropBounds();
    const [detectedBeatTimes, detectedBeatConfidences] = cropTimesWithValues(
      sourceValues.detectedBeats,
      sourceValues.beatConfidences,
      crop.start,
      crop.end,
    );
    const [detectedDownbeatTimes, detectedDownbeatConfidences] = cropTimesWithValues(
      sourceValues.detectedDownbeats,
      sourceValues.downbeatConfidences,
      crop.start,
      crop.end,
    );
    const drums = { ...(source.drumTimes || {}) };
    for (const key of ["kick_times", "snare_times", "hihat_times"]) {
      drums[key] = cropTimes(drums[key] || [], crop.start, crop.end);
    }
    drums.duration = crop.duration;
    drums.total_kicks = drums.kick_times.length;
    drums.total_snares = drums.snare_times.length;
    drums.total_hihats = drums.hihat_times.length;

    const interval = this.gridIntervalSeconds();
    this.beatData = {
      bpm: sourceValues.bpm,
      gridBpm: interval > 0 ? 60 / interval : sourceValues.bpm,
      baseGridIntervalSeconds: sourceValues.interval,
      gridIntervalSeconds: interval,
      beatGridDensity: this.beatGridDensity(),
      baseBeatTimes: cropTimes(sourceValues.beats, crop.start, crop.end),
      baseDetectedBeatTimes: detectedBeatTimes,
      baseDownbeatTimes: cropTimes(sourceValues.downbeats, crop.start, crop.end),
      baseDetectedDownbeatTimes: detectedDownbeatTimes,
      baseDetectedBeatConfidences: detectedBeatConfidences,
      baseDetectedDownbeatConfidences: detectedDownbeatConfidences,
      beatTimes: this.gridBeatTimes(),
      downbeatTimes: this.gridDownbeatTimes(),
      detectedBeatTimes,
      detectedDownbeatTimes,
      detectedBeatConfidences,
      detectedDownbeatConfidences,
      onsetTimes: cropTimes(source.onsetTimes, crop.start, crop.end),
      drumTimes: drums,
      audioDuration: crop.duration,
      sourceDuration: crop.sourceDuration,
      sourceStart: crop.start,
      fps: this.fps(),
      waveformPreview: cropWaveformPreview(
        source.waveformPreview,
        crop.start - source.waveformPreviewStart,
        crop.duration,
      ) ||
        cropWaveformPreview(this.sourceWaveformPreview, crop.start, crop.duration),
      cacheKey: source.cacheKey,
      audioFile: source.audioFile,
      detector: source.detector,
      detectorVersion: source.detectorVersion,
      bpmSource: source.bpmSource,
      analysisSource: source.analysisSource,
      beatAnalysisSource: source.beatAnalysisSource,
      analysisCacheHit: source.analysisCacheHit,
      beatOffsetMs: this.beatOffsetMs(),
    };
    this.updateTransportTime();
    this.refreshBeatStatus();
    this.invalidateEnvelopePreviews();
    return true;
  }

  applyBeatOffset() {
    this.syncBeatOffsetControls();
    const density = this.beatGridDensity();
    if (this.widgets.beatGridDensity?.value !== density) {
      this.widgets.beatGridDensity.value = density;
    }
    if (this.controls?.beatGridDensity) {
      this.controls.beatGridDensity.value = density;
    }
    if (this.projectSourceAnalysis()) return;
    if (!this.beatData) {
      this.invalidateEnvelopePreviews();
      return;
    }
    const interval = this.gridIntervalSeconds();
    this.beatData.beatTimes = this.gridBeatTimes();
    this.beatData.downbeatTimes = this.gridDownbeatTimes();
    this.beatData.detectedBeatTimes = [...(this.beatData.baseDetectedBeatTimes || [])];
    this.beatData.detectedDownbeatTimes = [...(this.beatData.baseDetectedDownbeatTimes || [])];
    this.beatData.detectedBeatConfidences = [...(this.beatData.baseDetectedBeatConfidences || [])];
    this.beatData.detectedDownbeatConfidences = [...(this.beatData.baseDetectedDownbeatConfidences || [])];
    this.beatData.beatOffsetMs = this.beatOffsetMs();
    this.beatData.beatGridDensity = density;
    this.beatData.baseGridIntervalSeconds = this.baseGridIntervalSeconds();
    this.beatData.gridIntervalSeconds = interval;
    this.beatData.gridBpm = interval > 0 ? 60 / interval : 0;
    this.refreshBeatStatus();
    this.invalidateEnvelopePreviews();
  }

  setBeatOffset(value, updateWidget = true, resnap = false) {
    const offset = clamp(Math.round(finiteNumber(value, 0)), -1000, 1000);
    if (this.widgets.beatOffset && (updateWidget || this.widgets.beatOffset.value !== offset)) {
      this.widgets.beatOffset.value = offset;
    }
    this.applyBeatOffset();
    if (resnap) {
      this.resnapClipsToGrid();
      this.resnapSongMapToGrid();
    }
    this.markDirty();
  }

  setBeatGridDensity(value, updateWidget = true) {
    const density = value in GRID_DENSITY_LABELS ? value : "every_beat";
    if (this.widgets.beatGridDensity &&
        (updateWidget || this.widgets.beatGridDensity.value !== density)) {
      this.widgets.beatGridDensity.value = density;
    }
    this.applyBeatOffset();
    this.resnapClipsToGrid();
    this.resnapSongMapToGrid();
    this.markDirty();
  }

  saveViewState(recordHistory = true) {
    this.node.properties = this.node.properties || {};
    const savedBeatData = this.beatData ? { ...this.beatData, waveformPreview: null } : null;
    const savedSongMap = this.sourceAnalysis?.songMap
      ? { ...this.sourceAnalysis.songMap, energyPreview: null }
      : null;
    const savedSourceAnalysis = this.sourceAnalysis
      ? { ...this.sourceAnalysis, waveformPreview: null, songMap: savedSongMap }
      : null;
    const previous = { ...(this.node.properties.flBeatPromptSequencer || {}) };
    delete previous.magnetMode;
    delete previous.snapMode;
    delete previous.waveformVisible;
    this.node.properties.flBeatPromptSequencer = {
      ...previous,
      formatVersion: FORMAT_VERSION,
      beatData: this.sourceAnalysis ? null : savedBeatData,
      sourceAnalysis: savedSourceAnalysis,
      viewStart: this.viewStart,
      viewEnd: this.viewEnd,
      autoAnalyze: this.autoAnalyze,
      playbackVolume: this.playbackVolume,
      songMapOverrides: this.songMapOverrides,
      lyricsTimeline: lyricsTimelineForStorage(this.lyricsTimeline),
      lyricsSettings: { ...this.lyricsSettings },
    };
    this.markDirty(recordHistory);
  }

  songMap() {
    const source = this.sourceAnalysis;
    if (this.songMapCache?.source === source &&
        this.songMapCache.overrides === this.songMapOverrides) {
      return this.songMapCache.value;
    }
    const value = applySongMapOverrides(
      this.sourceAnalysis?.songMap,
      this.songMapOverrides,
      this.sourceAnalysis,
    );
    this.songMapCache = { source, overrides: this.songMapOverrides, value };
    return value;
  }

  songMapRevision() {
    const songMap = this.songMap();
    return songMap
      ? `${songMap.cacheKey}:${textHash(JSON.stringify(this.songMapOverrides))}`
      : "";
  }

  lyricsWriterContext() {
    return createLyricsWriterContext(this.lyricsTimeline, this.clips, {
      fps: this.fps(),
      cropStart: this.cropStartSeconds(),
      totalFrames: this.sequenceFrameCount(),
      audioFile: String(this.widgets?.audioFile?.value || ""),
      includeInWriter: this.lyricsSettings.includeInWriter,
    });
  }

  activateLane(lane) {
    this.activeLane = ["song-map", "lyrics"].includes(lane) ? lane : "prompt";
    this.root.dataset.activeLane = this.activeLane;
    this.inspector.dataset.lane = this.activeLane;
    const labels = {
      prompt: ["Prompt track", "Timeline prompt", "+ Prompt", "Duplicate"],
      "song-map": ["Song Map", "Song Map section", "+ Section", "Duplicate"],
      lyrics: ["Lyrics", "Lyrics segment", "+ Lyric", "Merge next"],
    }[this.activeLane];
    this.activeLaneEl.textContent = labels[0];
    this.root.querySelector('[data-inspector-tab="prompt"]').textContent = labels[1];
    this.root.querySelector('[data-action="add"]').textContent = labels[2];
    this.root.querySelector('[data-action="duplicate"]').textContent = labels[3];
    this.root.querySelector('[data-action="raw"]').disabled = this.activeLane === "lyrics";
    this.syncInspector();
  }

  lyricsCurrent() {
    return isLyricsTimelineCurrent(this.lyricsTimeline, this.widgets.audioFile?.value);
  }

  selectedLyricsSegment() {
    return this.lyricsTimeline?.segments.find(segment => segment.id === this.selectedLyricsSegmentId) || null;
  }

  lyricsSegmentLocalRange(segment) {
    const cropStart = this.cropStartSeconds();
    return {
      start: Math.round((segment.start - cropStart) * this.fps()),
      end: Math.round((segment.end - cropStart) * this.fps()),
    };
  }

  selectLyricsSegment(id) {
    this.selectedLyricsSegmentId = this.lyricsTimeline?.segments.some(segment => segment.id === id)
      ? id
      : null;
    this.activateLane("lyrics");
    this.scheduleDraw();
  }

  persistLyrics(segments, selectedId = this.selectedLyricsSegmentId) {
    const ordered = segments.map(segment => ({ ...segment })).sort((left, right) => left.start - right.start);
    validateLyricsSegments(ordered);
    const base = this.lyricsTimeline || {
      version: 1,
      audioFile: String(this.widgets.audioFile?.value || ""),
      audioSha256: "",
      cacheKey: "",
      modelId: "",
      modelRevision: "",
      requestedLanguage: this.lyricsSettings.language,
      detectedLanguage: "",
      audioSource: "manual",
    };
    this.lyricsTimeline = normalizeLyricsTimeline({
      ...(lyricsTimelineForStorage(base) || {
        version: 1,
        model_id: base.modelId,
        model_revision: base.modelRevision,
        requested_language: base.requestedLanguage,
        detected_language: base.detectedLanguage,
        audio_source: base.audioSource,
      }),
      audio_file: String(this.widgets.audioFile?.value || base.audioFile || ""),
      segments: ordered,
    });
    this.selectedLyricsSegmentId = this.lyricsTimeline?.segments.some(segment => segment.id === selectedId)
      ? selectedId
      : null;
    this.saveViewState();
    this.syncLyricsInspector();
    this.scheduleDraw();
  }

  trimStartFrame() {
    return Math.max(0, Math.round(finiteNumber(this.widgets.trimStartFrame?.value, 0)));
  }

  cropStartSeconds() {
    return this.trimStartFrame() / this.fps();
  }

  sourceDurationSeconds() {
    return Math.max(
      0,
      finiteNumber(
        this.sourceAudioDuration || this.sourceAnalysis?.duration || this.beatData?.sourceDuration,
      ),
    );
  }

  cropDurationSeconds() {
    const configured = this.configuredFrameCount();
    if (configured > 0) return configured / this.fps();
    return Math.max(0, this.sourceDurationSeconds() - this.cropStartSeconds());
  }

  waveformSource() {
    if (this.sourceAnalysis?.waveformPreview) {
      const analysisWaveform = {
        preview: this.sourceAnalysis.waveformPreview,
        start: this.sourceAnalysis.waveformPreviewStart,
      };
      const crop = this.cropBounds();
      if (analysisWaveform.start <= crop.start + EPSILON &&
          analysisWaveform.start + analysisWaveform.preview.duration >= crop.end - EPSILON) {
        return analysisWaveform;
      }
      if (!this.sourceWaveformPreview) return analysisWaveform;
    }
    if (this.sourceWaveformPreview) {
      return { preview: this.sourceWaveformPreview, start: 0 };
    }
    if (this.beatData?.waveformPreview) {
      return {
        preview: this.beatData.waveformPreview,
        start: finiteNumber(this.beatData.sourceStart),
      };
    }
    return null;
  }

  setStatus(text, state = "", progress = null) {
    this.statusEl.className = `flbps-status${state ? ` ${state}` : ""}`;
    this.statusEl.textContent = text;
    this.statusEl.title = text;
    this.statusEl.style.removeProperty("--flbps-progress");
    if (progress != null) {
      this.statusEl.style.setProperty("--flbps-progress", `${clamp(progress, 0, 1) * 100}%`);
    }
  }

  async pollBeatModelStatus(request) {
    clearTimeout(this.modelStatusTimer);
    try {
      const response = await api.fetchApi("/fl/audio-prompt-timeline/beat-model/status");
      if (!response.ok || request !== this.analysisRequest || request !== this.modelStatusRequest) return;
      const status = await response.json();
      if (request !== this.analysisRequest || request !== this.modelStatusRequest) return;
      const progress = clamp(finiteNumber(status.progress), 0, 1);
      if (status.state === "downloading") {
        const downloaded = finiteNumber(status.downloaded_bytes) / (1024 * 1024);
        const total = finiteNumber(status.total_bytes) / (1024 * 1024);
        this.setStatus(
          `First use: downloading Beat This ${Math.round(progress * 100)}% · ${downloaded.toFixed(1)}/${total.toFixed(1)} MB`,
          "loading",
          progress,
        );
      } else if (["verifying", "loading", "analyzing", "waiting"].includes(status.state)) {
        this.setStatus(status.message || "Loading Beat This…", "loading", status.state === "verifying" ? 1 : null);
      } else if (status.state === "error" || status.state === "unavailable") {
        this.setStatus(status.message || "Beat This is unavailable", "error");
      } else if (status.state === "ready") {
        this.setStatus("Beat This model loaded · analyzing timeline…", "loading", 1);
      }
    } catch {
      // The analysis request reports actionable model and network errors.
    }
    if (request === this.analysisRequest && request === this.modelStatusRequest) {
      this.modelStatusTimer = setTimeout(() => this.pollBeatModelStatus(request), 350);
    }
  }

  invalidateAnalysis() {
    this.sourceAnalysis = null;
    if (!this.beatData) {
      this.dataFresh = false;
      this.setStatus("Audio changed · analysis pending", "cached");
      this.invalidateEnvelopePreviews();
      return;
    }
    this.beatData.baseBeatTimes = [];
    this.beatData.baseDetectedBeatTimes = [];
    this.beatData.baseDownbeatTimes = [];
    this.beatData.baseDetectedDownbeatTimes = [];
    this.beatData.baseDetectedBeatConfidences = [];
    this.beatData.baseDetectedDownbeatConfidences = [];
    this.beatData.beatTimes = [];
    this.beatData.downbeatTimes = [];
    this.beatData.detectedBeatTimes = [];
    this.beatData.detectedDownbeatTimes = [];
    this.beatData.detectedBeatConfidences = [];
    this.beatData.detectedDownbeatConfidences = [];
    this.beatData.onsetTimes = [];
    this.beatData.drumTimes = {};
    this.dataFresh = false;
    this.setStatus("Audio changed · analysis pending", "cached");
    this.invalidateEnvelopePreviews();
  }

  refreshBrowserCrop() {
    if (!this.sourceAnalysis && this.beatData?.beatTimes?.length) {
      this.sourceAnalysis = sourceAnalysisFromCropPayload(this.beatData);
    }
    if (this.projectSourceAnalysis()) return;
    if (!this.sourceWaveformPreview || !(this.sourceAudioDuration > 0)) {
      this.updateTransportTime();
      this.invalidateEnvelopePreviews();
      return;
    }
    const start = this.cropStartSeconds();
    const duration = Math.min(this.cropDurationSeconds(), Math.max(0, this.sourceAudioDuration - start));
    const cropPreview = cropWaveformPreview(this.sourceWaveformPreview, start, duration);
    this.beatData = {
      ...(this.beatData || {}),
      bpm: finiteNumber(this.beatData?.bpm),
      beatTimes: this.beatData?.beatTimes || [],
      detectedBeatTimes: this.beatData?.detectedBeatTimes || [],
      onsetTimes: this.beatData?.onsetTimes || [],
      drumTimes: this.beatData?.drumTimes || {},
      audioDuration: duration,
      sourceDuration: this.sourceAudioDuration,
      sourceStart: start,
      waveformPreview: cropPreview,
    };
    this.updateTransportTime();
    this.invalidateEnvelopePreviews();
  }

  applySourceDuration(duration) {
    if (!(duration > 0)) return;
    this.sourceAudioDuration = duration;
    const sourceFrames = Math.floor(duration * this.fps());
    const availableFrames = Math.max(1, sourceFrames - this.trimStartFrame());
    let settingsChanged = false;
    if (this.trimStartFrame() >= sourceFrames) {
      this.widgets.trimStartFrame.value = 0;
      settingsChanged = true;
    }
    if (!this.configuredFrameCount() || this.configuredFrameCount() > availableFrames) {
      this.widgets.sequenceDuration.value = Math.max(
        1,
        Math.floor((duration - this.cropStartSeconds()) * this.fps()),
      );
      settingsChanged = true;
    }
    if (settingsChanged) {
      this.node.graph?.change?.();
      this.onStateChange?.();
      this.clearHistory();
    }
  }

  async loadAudioSource() {
    const filename = String(this.widgets.audioFile?.value || "");
    const request = ++this.analysisRequest;
    this.stopPlayback();
    this.sourceWaveformPreview = null;
    this.sourceAudioDuration = 0;
    if (!filename) {
      this.sourceAnalysis = null;
      this.beatData = null;
      if (this.widgets.analysisCacheKey) this.widgets.analysisCacheKey.value = "";
      this.audioElement = null;
      this.sourceLabelEl.textContent = "No audio selected";
      this.setStatus("Choose audio or connect beat positions");
      this.invalidateEnvelopePreviews();
      return;
    }

    this.loadingAudio = true;
    this.sourceLabelEl.textContent = filename;
    this.setStatus("Loading audio…");
    const url = audioViewURL(filename);
    try {
      this.audioURL = url;
      const audioElement = new Audio();
      this.audioElement = audioElement;
      audioElement.preload = "metadata";
      audioElement.volume = this.playbackVolume;
      audioElement.addEventListener("loadedmetadata", () => {
        if (this.audioElement !== audioElement) return;
        this.applySourceDuration(audioElement.duration);
        this.refreshBrowserCrop();
        this.zoomToFit(false);
      });
      audioElement.addEventListener("error", () => {
        if (this.audioElement !== audioElement) return;
        this.showError("Audio preview could not be loaded. Server analysis will still be used.");
      });
      audioElement.addEventListener("timeupdate", () => this.updatePlaybackPosition());
      audioElement.addEventListener("pause", () => {
        this.stopPlaybackLoop();
        if (!audioElement.ended) this.updatePlaybackPosition();
        this.updatePlayButton();
      });
      audioElement.addEventListener("play", () => {
        this.updatePlayButton();
        this.startPlaybackLoop();
      });
      audioElement.addEventListener("ended", () => this.loopPlayback(true));
      audioElement.src = url;
      audioElement.load();
      if (this.sourceAnalysis?.audioFile !== filename ||
          this.sourceAnalysis?.analysisSource !== (this.widgets.analysisSource?.value || "mix")) {
        this.invalidateAnalysis();
      }
      this.refreshBrowserCrop();
      this.zoomToFit(false);
      this.scheduleAnalysis(0);
    } catch (error) {
      if (request !== this.analysisRequest) return;
      this.showError(`${error.message} Server analysis will still be used.`);
      this.scheduleAnalysis(0);
    } finally {
      if (request === this.analysisRequest) this.loadingAudio = false;
    }
  }

  scheduleAnalysis(delay = 250) {
    if (!this.autoAnalyze || !this.widgets.audioFile?.value) return;
    clearTimeout(this.analysisTimer);
    this.analysisTimer = setTimeout(() => this.requestAnalysis(), delay);
  }

  async requestAnalysis(force = false) {
    if (!force && !this.autoAnalyze) return;
    const audioFile = String(this.widgets.audioFile?.value || "");
    if (!audioFile) {
      this.showError("Choose an audio file before analyzing.");
      return;
    }
    clearTimeout(this.analysisTimer);
    const request = ++this.analysisRequest;
    let analysisCompleted = false;
    this.modelStatusRequest = request;
    this.setStatus("Preparing Beat This analysis…", "loading");
    this.pollBeatModelStatus(request);
    try {
      const response = await api.fetchApi("/fl/audio-prompt-timeline/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio_file: audioFile,
          fps: this.fps(),
          trim_start_frame: this.trimStartFrame(),
          length_frames: this.configuredFrameCount(),
          half_time: Boolean(this.widgets.halfTime?.value),
          beat_offset_ms: 0,
          analysis_source: this.widgets.analysisSource?.value || "mix",
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Analysis failed (${response.status}).`);
      if (request !== this.analysisRequest) return;
      const completeSource = this.applyAnalysis(payload, true);
      if (this.migrationPending) this.loadTimeline();
      this.resnapClipsToGrid();
      this.resnapSongMapToGrid();
      if (completeSource) {
        this.clearError();
      } else {
        this.showError("Restart ComfyUI and refresh the browser to load full-source beat analysis.");
      }
      this.saveViewState();
      analysisCompleted = true;
    } catch (error) {
      if (request !== this.analysisRequest) return;
      this.showError(error.message);
    } finally {
      if (request === this.analysisRequest) {
        this.modelStatusRequest = null;
        clearTimeout(this.modelStatusTimer);
        if (analysisCompleted) this.refreshBeatStatus();
      }
    }
  }

  applyAnalysis(payload, fresh) {
    const sourceAnalysis = sourceAnalysisValue(payload.source_analysis);
    if (sourceAnalysis) {
      this.sourceAnalysis = sourceAnalysis;
      this.sourceWaveformPreview = sourceAnalysis.waveformPreview;
      this.applySourceDuration(sourceAnalysis.duration);
      const audioFile = String(
        sourceAnalysis.audioFile || payload.audio_file || this.widgets.audioFile?.value || "",
      );
      if (this.widgets.audioFile && !this.widgets.audioFile.value && audioFile) {
        this.widgets.audioFile.value = audioFile;
      }
      if (this.widgets.analysisCacheKey) {
        this.widgets.analysisCacheKey.value = sourceAnalysis.cacheKey;
      }
      this.dataFresh = fresh && !sourceAnalysis.analysisCacheHit;
      this.applyBeatOffset();
      return true;
    }

    const partialSource = sourceAnalysisFromCropPayload(payload);
    if (partialSource) {
      this.sourceAnalysis = partialSource;
      const audioFile = String(
        partialSource.audioFile || payload.audio_file || this.widgets.audioFile?.value || "",
      );
      if (this.widgets.audioFile && !this.widgets.audioFile.value && audioFile) {
        this.widgets.audioFile.value = audioFile;
      }
      if (this.widgets.analysisCacheKey) {
        this.widgets.analysisCacheKey.value = partialSource.cacheKey;
      }
      this.dataFresh = fresh && !partialSource.analysisCacheHit;
      this.applyBeatOffset();
      return false;
    }

    this.sourceAnalysis = null;
    const payloadOffset = finiteNumber(payload.beat_offset_ms, 0) / 1000;
    const payloadBeatTimes = (payload.beat_times || []).map((value) => finiteNumber(value));
    const payloadDetectedBeatTimes = (payload.detected_beat_times || []).map(
      (value) => finiteNumber(value),
    );
    const payloadDownbeatTimes = (payload.downbeat_times || []).map(
      (value) => finiteNumber(value),
    );
    const payloadDetectedDownbeatTimes = (payload.detected_downbeat_times || []).map(
      (value) => finiteNumber(value),
    );
    const audioFile = String(
      payload.audio_file || this.widgets.audioFile?.value || this.beatData?.audioFile || "",
    );
    this.beatData = {
      bpm: finiteNumber(payload.bpm),
      gridBpm: finiteNumber(payload.grid_bpm, payload.bpm),
      baseGridIntervalSeconds: finiteNumber(payload.base_grid_interval_seconds),
      gridIntervalSeconds: finiteNumber(payload.grid_interval_seconds),
      beatGridDensity: payload.beat_grid_density || this.beatGridDensity(),
      baseBeatTimes: (payload.base_beat_times || payloadBeatTimes.map(
        (value) => value - payloadOffset,
      )).map((value) => finiteNumber(value)),
      baseDetectedBeatTimes: (
        payload.base_detected_beat_times ||
        payloadDetectedBeatTimes
      ).map((value) => finiteNumber(value)),
      baseDownbeatTimes: (
        payload.base_downbeat_times ||
        payloadDownbeatTimes.map((value) => value - payloadOffset)
      ).map((value) => finiteNumber(value)),
      baseDetectedDownbeatTimes: (
        payload.base_detected_downbeat_times ||
        payloadDetectedDownbeatTimes
      ).map((value) => finiteNumber(value)),
      baseDetectedBeatConfidences: (payload.base_detected_beat_confidences ||
        payload.detected_beat_confidences || []).map((value) => finiteNumber(value)),
      baseDetectedDownbeatConfidences: (payload.base_detected_downbeat_confidences ||
        payload.detected_downbeat_confidences || []).map((value) => finiteNumber(value)),
      beatTimes: [],
      downbeatTimes: [],
      detectedBeatTimes: [],
      detectedDownbeatTimes: [],
      detectedBeatConfidences: [],
      detectedDownbeatConfidences: [],
      onsetTimes: (payload.onset_times || []).map((value) => finiteNumber(value)),
      drumTimes: payload.drum_times || {},
      audioDuration: finiteNumber(payload.audio_duration),
      sourceDuration: finiteNumber(payload.source_duration, this.sourceAudioDuration),
      sourceStart: finiteNumber(payload.source_start, this.cropStartSeconds()),
      fps: finiteNumber(payload.fps, this.fps()),
      waveformPreview: normalizeWaveformPreview(payload.waveform_preview) ||
        cropWaveformPreview(this.sourceWaveformPreview, this.cropStartSeconds(), this.cropDurationSeconds()),
      cacheKey: payload.cache_key || "",
      audioFile,
      detector: payload.detector || null,
      detectorVersion: payload.detector_version || "",
      bpmSource: payload.bpm_source || "",
      analysisSource: payload.analysis_source || this.widgets.analysisSource?.value || "mix",
      beatAnalysisSource: payload.beat_analysis_source || "",
      analysisCacheHit: Boolean(payload.analysis_cache_hit),
    };
    if (this.widgets.audioFile && !this.widgets.audioFile.value && audioFile) {
      this.widgets.audioFile.value = audioFile;
    }
    if (this.widgets.analysisCacheKey) {
      this.widgets.analysisCacheKey.value = this.beatData.cacheKey;
    }
    this.dataFresh = fresh && !this.beatData.analysisCacheHit;
    this.applyBeatOffset();
    return false;
  }

  updatePlayButton() {
    const button = this.root.querySelector('[data-action="play"]');
    button.textContent = this.audioElement && !this.audioElement.paused ? "Pause" : "Play";
  }

  syncPlaybackVolumeControl() {
    if (!this.controls?.playbackVolume) return;
    const percent = Math.round(this.playbackVolume * 100);
    this.controls.playbackVolume.value = String(percent);
    this.controls.playbackVolume.style.setProperty("--flbps-volume-position", `${percent}%`);
    this.controls.playbackVolume.setAttribute("aria-valuetext", `${percent} percent`);
    this.controls.playbackVolumeValue.textContent = `${percent}%`;
    this.controls.playbackVolumeIcon.textContent = percent === 0 ? "🔇" : percent < 50 ? "🔉" : "🔊";
  }

  setPlaybackVolume(value, persist = false) {
    this.playbackVolume = clamp(finiteNumber(value, 1), 0, 1);
    if (this.audioElement) this.audioElement.volume = this.playbackVolume;
    this.syncPlaybackVolumeControl();
    if (!persist) return;
    this.node.properties = this.node.properties || {};
    this.node.properties.flBeatPromptSequencer = {
      ...(this.node.properties.flBeatPromptSequencer || {}),
      formatVersion: FORMAT_VERSION,
      playbackVolume: this.playbackVolume,
    };
    this.node.graph?.change?.();
  }

  updateTransportTime() {
    const current = this.playheadFrame == null ? 0 : this.playheadFrame / this.fps();
    this.transportTimeEl.textContent =
      `${formatClock(current)} / ${formatClock(this.cropDurationSeconds())}`;
  }

  updatePlaybackPosition() {
    if (!this.audioElement) return;
    const relative = this.audioElement.currentTime - this.cropStartSeconds();
    const duration = this.cropDurationSeconds();
    if (relative >= duration - 0.005) {
      this.loopPlayback();
      return;
    }
    this.playheadFrame = clamp(relative * this.fps(), 0, this.sequenceFrameCount());
    this.updateTransportTime();
    this.scheduleDraw(false);
  }

  async loopPlayback(resume = false) {
    if (!this.audioElement) return;
    this.audioElement.currentTime = this.cropStartSeconds();
    this.playheadFrame = 0;
    this.updateTransportTime();
    this.scheduleDraw(false);
    if (!resume || !this.audioElement.paused) return;
    try {
      await this.audioElement.play();
    } catch (error) {
      this.showError(`Audio playback failed: ${error.message}`);
    }
  }

  startPlaybackLoop() {
    this.stopPlaybackLoop();
    const tick = () => {
      this.playbackFrameRequest = null;
      if (!this.audioElement || this.audioElement.paused) return;
      this.updatePlaybackPosition();
      this.playbackFrameRequest = requestAnimationFrame(tick);
    };
    this.playbackFrameRequest = requestAnimationFrame(tick);
  }

  stopPlaybackLoop() {
    if (this.playbackFrameRequest != null) {
      cancelAnimationFrame(this.playbackFrameRequest);
      this.playbackFrameRequest = null;
    }
  }

  async togglePlayback() {
    if (!this.audioElement) {
      this.showError("Choose an audio file before playing.");
      return;
    }
    if (!this.audioElement.paused) {
      this.audioElement.pause();
      return;
    }
    const frame = clamp(this.playheadFrame || 0, 0, this.sequenceFrameCount() - 1);
    this.audioElement.currentTime = this.cropStartSeconds() + frame / this.fps();
    try {
      await this.audioElement.play();
    } catch (error) {
      this.showError(`Audio playback failed: ${error.message}`);
    }
  }

  stopPlayback() {
    this.stopPlaybackLoop();
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.currentTime = this.cropStartSeconds();
    }
    this.playheadFrame = 0;
    this.updatePlayButton();
    if (this.transportTimeEl) this.updateTransportTime();
    this.scheduleDraw(false);
  }

  async startSeparation() {
    if (this.separationJobId) {
      const response = await api.fetchApi(
        `/fl/audio-prompt-timeline/separate/${encodeURIComponent(this.separationJobId)}/cancel`,
        { method: "POST" },
      );
      const payload = await response.json();
      if (!response.ok) this.showError(payload.error || "Could not cancel stem separation.");
      else this.setStatus(payload.message || "Cancelling stem separation…");
      return;
    }
    const audioFile = String(this.widgets.audioFile?.value || "");
    if (!audioFile) {
      this.showError("Choose an audio file before separating stems.");
      return;
    }
    this.setStatus("Starting explicit stem separation…");
    try {
      const response = await api.fetchApi("/fl/audio-prompt-timeline/separate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio_file: audioFile }),
      });
      const payload = await response.json();
      if (payload.status === "completed") {
        this.finishSeparation(payload);
        return;
      }
      const job = payload.job || payload;
      if (!response.ok && !job.job_id) {
        throw new Error(payload.error || `Stem separation failed (${response.status}).`);
      }
      this.separationJobId = job.job_id;
      this.node._flAudioSeparationJobId = this.separationJobId;
      this.root.querySelector('[data-action="separate"]').textContent = "Cancel separation";
      this.setStatus(job.message || "Stem separation running…");
      this.pollSeparation();
    } catch (error) {
      this.showError(error.message);
    }
  }

  async pollSeparation() {
    if (!this.separationJobId) return;
    try {
      const response = await api.fetchApi(
        `/fl/audio-prompt-timeline/separate/${encodeURIComponent(this.separationJobId)}`,
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not read stem separation status.");
      const percent = Math.round(finiteNumber(payload.progress) * 100);
      this.setStatus(`${payload.message || payload.status} · ${percent}%`);
      if (payload.status === "completed") {
        this.finishSeparation(payload);
        return;
      }
      if (payload.status === "error" || payload.status === "cancelled") {
        this.separationJobId = null;
        this.node._flAudioSeparationJobId = null;
        this.root.querySelector('[data-action="separate"]').textContent = "Separate stems";
        if (payload.status === "error") this.showError(payload.message || "Stem separation failed.");
        else this.setStatus("Stem separation cancelled", "cached");
        return;
      }
      this.separationTimer = setTimeout(() => this.pollSeparation(), 750);
    } catch (error) {
      this.separationJobId = null;
      this.node._flAudioSeparationJobId = null;
      this.root.querySelector('[data-action="separate"]').textContent = "Separate stems";
      this.showError(error.message);
    }
  }

  finishSeparation(payload) {
    clearTimeout(this.separationTimer);
    this.separationJobId = null;
    this.node._flAudioSeparationJobId = null;
    this.root.querySelector('[data-action="separate"]').textContent = "Separate stems";
    this.setStatus(payload.message || "Stem separation complete", "fresh");
    if (this.widgets.analysisSource) this.widgets.analysisSource.value = "drums";
    this.requestAnalysis(true);
  }

  setAudioJobControls(transcribing) {
    this.root.querySelector('[data-action="analyze"]').disabled = transcribing;
    this.root.querySelector('[data-action="separate"]').disabled = transcribing;
  }

  async refreshTranscriptionModelStatus() {
    if (!this.root || this.transcriptionJobId) return;
    const button = this.root.querySelector('[data-action="transcribe"]');
    try {
      const response = await api.fetchApi(
        `/fl/audio-prompt-timeline/transcription-model/status?model=${encodeURIComponent(this.lyricsSettings.model)}`,
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not read transcription model status.");
      button.textContent = payload.ready ? "Transcribe lyrics" : "Download model & transcribe";
      button.title = payload.ready
        ? `${payload.name} is installed. Transcription and audio remain local.`
        : `${payload.name} will download only when you click this button.`;
    } catch (error) {
      button.textContent = "Transcribe lyrics";
      button.title = error.message;
    }
  }

  async startTranscription() {
    if (this.transcriptionJobId) {
      const response = await api.fetchApi(
        `/fl/audio-prompt-timeline/transcribe/${encodeURIComponent(this.transcriptionJobId)}/cancel`,
        { method: "POST" },
      );
      const payload = await response.json();
      if (!response.ok) this.showError(payload.error || "Could not cancel lyrics transcription.");
      else this.setStatus(payload.message || "Cancelling lyrics transcription…");
      return;
    }
    const audioFile = String(this.widgets.audioFile?.value || "");
    if (!audioFile) {
      this.showError("Choose an audio file before transcribing lyrics.");
      return;
    }
    if (this.lyricsCurrent() && this.lyricsTimeline?.segments.length &&
        !globalThis.confirm("Replace the current timed lyrics? Existing corrections will be lost.")) {
      return;
    }
    this.activateLane("lyrics");
    this.setStatus("Starting local lyrics transcription…");
    this.setAudioJobControls(true);
    try {
      const response = await api.fetchApi("/fl/audio-prompt-timeline/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio_file: audioFile,
          source: this.lyricsSettings.source,
          model: this.lyricsSettings.model,
          language: this.lyricsSettings.language,
          allow_download: true,
        }),
      });
      const payload = await response.json();
      if (payload.status === "completed") {
        this.finishTranscription(payload);
        return;
      }
      if (!response.ok) {
        throw new Error(payload.error || `Lyrics transcription failed (${response.status}).`);
      }
      const job = payload;
      this.transcriptionJobId = job.job_id;
      this.node._flAudioTranscriptionJobId = this.transcriptionJobId;
      this.root.querySelector('[data-action="transcribe"]').textContent = "Cancel transcription";
      this.setStatus(job.message || "Lyrics transcription running…", "loading");
      this.pollTranscription();
    } catch (error) {
      this.setAudioJobControls(false);
      this.showError(error.message);
      this.refreshTranscriptionModelStatus();
    }
  }

  async pollTranscription() {
    if (!this.transcriptionJobId) return;
    try {
      const response = await api.fetchApi(
        `/fl/audio-prompt-timeline/transcribe/${encodeURIComponent(this.transcriptionJobId)}`,
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not read lyrics transcription status.");
      const percent = Math.round(finiteNumber(payload.progress) * 100);
      this.setStatus(`${payload.message || payload.status} · ${percent}%`, "loading", percent / 100);
      if (payload.status === "completed") {
        this.finishTranscription(payload);
        return;
      }
      if (["error", "cancelled"].includes(payload.status)) {
        this.transcriptionJobId = null;
        this.node._flAudioTranscriptionJobId = null;
        this.setAudioJobControls(false);
        if (payload.status === "error") this.showError(payload.message || "Lyrics transcription failed.");
        else this.setStatus("Lyrics transcription cancelled", "cached");
        this.refreshTranscriptionModelStatus();
        return;
      }
      this.transcriptionTimer = setTimeout(() => this.pollTranscription(), 750);
    } catch (error) {
      this.transcriptionJobId = null;
      this.node._flAudioTranscriptionJobId = null;
      this.setAudioJobControls(false);
      this.showError(error.message);
      this.refreshTranscriptionModelStatus();
    }
  }

  finishTranscription(payload) {
    clearTimeout(this.transcriptionTimer);
    this.transcriptionJobId = null;
    this.node._flAudioTranscriptionJobId = null;
    this.setAudioJobControls(false);
    const timeline = normalizeLyricsTimeline(payload.transcript);
    if (!timeline) {
      this.showError("The transcription service returned an invalid lyrics timeline.");
      this.refreshTranscriptionModelStatus();
      return;
    }
    this.runEdit("Replace lyrics with transcription", () => {
      this.lyricsTimeline = timeline;
      this.selectedLyricsSegmentId = timeline.segments[0]?.id || null;
      this.clearError();
      this.setStatus(
        timeline.segments.length
          ? `${timeline.segments.length} timed lyric line${timeline.segments.length === 1 ? "" : "s"} ready`
          : "No sung lyrics were detected",
        "fresh",
      );
      this.saveViewState();
      this.activateLane("lyrics");
    }, { isolated: true });
    this.refreshTranscriptionModelStatus();
  }

  async importLyricsFile() {
    const file = this.lyricsImportInput.files?.[0];
    this.lyricsImportInput.value = "";
    if (!file) return;
    const extension = file.name.toLowerCase().split(".").pop();
    if (!["lrc", "srt"].includes(extension)) {
      this.showError("Import a timed .lrc or .srt file. Untimed text cannot be aligned automatically.");
      return;
    }
    if (this.lyricsTimeline && !globalThis.confirm("Replace the current lyrics timeline?")) return;
    try {
      const text = await file.text();
      const segments = extension === "lrc"
        ? parseLrcLyrics(text, { duration: this.sourceDurationSeconds() })
        : parseSrtLyrics(text);
      if (!segments.length) throw new Error(`The ${extension.toUpperCase()} file has no timed lyric cues.`);
      this.runEdit("Import timed lyrics", () => {
        this.lyricsTimeline = normalizeLyricsTimeline({
          version: 1,
          audio_file: String(this.widgets.audioFile?.value || ""),
          requested_language: this.lyricsSettings.language,
          detected_language: this.lyricsSettings.language === "auto" ? "" : this.lyricsSettings.language,
          audio_source: "manual",
          segments,
        });
        this.selectedLyricsSegmentId = segments[0].id;
        this.clearError();
        this.saveViewState();
        this.activateLane("lyrics");
        this.setStatus(`Imported ${segments.length} timed lyric lines`, "fresh");
      });
    } catch (error) {
      this.showError(`Lyrics import failed: ${error.message}`);
    }
  }

  async resetLyricsFromCache() {
    const cacheKey = this.lyricsTimeline?.cacheKey;
    if (!cacheKey) return;
    if (!globalThis.confirm("Replace all lyric corrections with the original transcription?")) return;
    try {
      const response = await api.fetchApi(
        `/fl/audio-prompt-timeline/transcripts/${encodeURIComponent(cacheKey)}`,
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Original transcription was not found.");
      const timeline = normalizeLyricsTimeline(payload.transcript);
      if (!timeline) throw new Error("The cached transcription is invalid.");
      this.runEdit("Reset lyrics from transcription", () => {
        this.lyricsTimeline = timeline;
        this.selectedLyricsSegmentId = timeline.segments[0]?.id || null;
        this.clearError();
        this.saveViewState();
        this.syncLyricsInspector();
        this.scheduleDraw();
      });
    } catch (error) {
      this.showError(error.message);
    }
  }

  discardLyrics() {
    if (!this.lyricsTimeline || !globalThis.confirm("Discard the lyrics timeline from this workflow?")) return;
    this.runEdit("Discard lyrics", () => {
      this.lyricsTimeline = null;
      this.selectedLyricsSegmentId = null;
      this.saveViewState();
      this.syncLyricsInspector();
      this.scheduleDraw();
    });
  }

  addLyricsSegment(startOverride = null) {
    const audioFile = String(this.widgets.audioFile?.value || "");
    if (!audioFile) {
      this.showError("Choose an audio file before adding timed lyrics.");
      return;
    }
    const segments = this.lyricsTimeline?.segments.map(segment => ({ ...segment })) || [];
    const startFrame = clamp(
      startOverride ?? this.playheadFrame ?? 0,
      0,
      Math.max(0, this.sequenceFrameCount() - 1),
    );
    const start = this.cropStartSeconds() + startFrame / this.fps();
    if (segments.some(segment => start >= segment.start - EPSILON && start < segment.end - EPSILON)) {
      this.showError("The playhead is already inside a lyric segment.");
      return;
    }
    const next = segments.find(segment => segment.start >= start - EPSILON);
    const previous = [...segments].reverse().find(segment => segment.end <= start + EPSILON);
    const minimum = previous?.end || 0;
    const maximum = next?.start || this.cropStartSeconds() + this.sequenceFrameCount() / this.fps();
    const resolvedStart = Math.max(minimum, start);
    const end = Math.min(maximum, resolvedStart + 2);
    if (end <= resolvedStart + EPSILON) {
      this.showError("There is no open time at the playhead for another lyric segment.");
      return;
    }
    const id = nextLyricsSegmentId(this.lyricsTimeline);
    segments.push({ id, start: resolvedStart, end, text: "New lyric", origin: "manual" });
    this.persistLyrics(segments, id);
    this.selectLyricsSegment(id);
    this.lyricsFields.text.focus();
    this.lyricsFields.text.select();
  }

  splitLyricsSegment() {
    const segment = this.selectedLyricsSegment();
    if (!segment) return;
    const frame = this.playheadFrame;
    if (frame == null) {
      this.showError("Place the playhead inside the selected lyric before splitting.");
      return;
    }
    const split = this.cropStartSeconds() + frame / this.fps();
    if (split <= segment.start + 1 / this.fps() || split >= segment.end - 1 / this.fps()) {
      this.showError("Place the playhead away from the lyric segment edges.");
      return;
    }
    let caret = this.lyricsFields.text.selectionStart;
    if (!(caret > 0 && caret < segment.text.length) && segment.words?.length) {
      const word = segment.words.findIndex(value => value.start >= split);
      if (word > 0) caret = segment.words.slice(0, word).reduce((total, value) => total + value.text.length + 1, 0) - 1;
    }
    if (!(caret > 0 && caret < segment.text.length)) {
      const midpoint = Math.floor(segment.text.length / 2);
      caret = segment.text.lastIndexOf(" ", midpoint);
      if (caret <= 0) caret = segment.text.indexOf(" ", midpoint);
    }
    const leftText = segment.text.slice(0, caret).trim();
    const rightText = segment.text.slice(caret).trim();
    if (!leftText || !rightText) {
      this.showError("Place the text caret between words before splitting this lyric.");
      return;
    }
    const segments = this.lyricsTimeline.segments.map(value => ({ ...value }));
    const index = segments.findIndex(value => value.id === segment.id);
    const nextId = nextLyricsSegmentId({ ...this.lyricsTimeline, segments });
    segments.splice(index, 1,
      { ...segment, end: split, text: leftText, origin: "corrected", words: undefined },
      { id: nextId, start: split, end: segment.end, text: rightText, origin: "corrected" },
    );
    this.persistLyrics(segments, nextId);
  }

  mergeLyricsSegment() {
    const segment = this.selectedLyricsSegment();
    if (!segment) return;
    const segments = this.lyricsTimeline.segments.map(value => ({ ...value }));
    const index = segments.findIndex(value => value.id === segment.id);
    const next = segments[index + 1];
    if (!next) {
      this.showError("There is no following lyric segment to merge.");
      return;
    }
    segments.splice(index, 2, {
      ...segment,
      end: next.end,
      text: `${segment.text} ${next.text}`.replace(/\s+/g, " ").trim().slice(0, 1000),
      origin: "corrected",
      words: undefined,
    });
    this.persistLyrics(segments, segment.id);
  }

  deleteLyricsSegment() {
    const segment = this.selectedLyricsSegment();
    if (!segment) return;
    const segments = this.lyricsTimeline.segments.filter(value => value.id !== segment.id);
    const index = this.lyricsTimeline.segments.findIndex(value => value.id === segment.id);
    const selected = segments[Math.min(index, segments.length - 1)]?.id || null;
    this.persistLyrics(segments, selected);
  }

  sourceUnit() {
    return this.widgets.timeUnit?.value || "frames";
  }

  sourceToSeconds(value, unit) {
    if (unit === "seconds") return value;
    if (unit === "frames") return value / this.fps();
    const beats = this.beatData?.beatTimes;
    const duration = this.beatData?.audioDuration;
    if (!beats?.length || !(duration > 0)) return null;
    if (value > beats.length + EPSILON) return null;
    if (value >= beats.length - EPSILON) return duration;
    const index = Math.max(0, Math.floor(value));
    const amount = value - index;
    const start = beats[index];
    const end = index + 1 < beats.length ? beats[index + 1] : duration;
    return start + (end - start) * amount;
  }

  migrateLegacyClips(clips, unit) {
    if (unit === "beats" && !this.beatData?.beatTimes?.length) return null;
    const fps = this.fps();
    return clips.map((clip) => {
      const startSeconds = this.sourceToSeconds(clip.start, unit);
      const endSeconds = this.sourceToSeconds(clip.end, unit);
      const fadeInSeconds = this.sourceToSeconds(clip.start + clip.fadeIn, unit);
      const fadeOutSeconds = this.sourceToSeconds(clip.end - clip.fadeOut, unit);
      const crossfadeStartSeconds = clip.crossfade > 0
        ? this.sourceToSeconds(clip.start - clip.crossfade * 0.5, unit)
        : startSeconds;
      const crossfadeEndSeconds = clip.crossfade > 0
        ? this.sourceToSeconds(clip.start + clip.crossfade * 0.5, unit)
        : startSeconds;
      if ([
        startSeconds,
        endSeconds,
        fadeInSeconds,
        fadeOutSeconds,
        crossfadeStartSeconds,
        crossfadeEndSeconds,
      ].some((value) => value == null)) {
        return null;
      }
      const start = Math.max(0, Math.round(startSeconds * fps));
      const end = Math.max(start + 1, Math.round(endSeconds * fps));
      const fadeInEnd = clamp(Math.round(fadeInSeconds * fps), start, end);
      const fadeOutStart = clamp(Math.round(fadeOutSeconds * fps), start, end);
      return {
        ...clip,
        start,
        end,
        fadeIn: fadeInEnd - start,
        fadeOut: end - fadeOutStart,
        crossfade: Math.max(0, Math.round((crossfadeEndSeconds - crossfadeStartSeconds) * fps)),
      };
    });
  }

  finishMigration(clips) {
    if (clips.some((clip) => !clip)) {
      throw new Error("The legacy schedule could not be converted to frames.");
    }
    validateFrameClips(normalizeCrossfades(clips));
    for (let index = 1; index < clips.length; index++) {
      if (clips[index].start < clips[index - 1].end) {
        throw new Error(`Line ${clips[index].line}: frame conversion makes this section overlap the previous section.`);
      }
    }
    this.clips = clips;
    const renderGroupError = this.restoreRenderGroups();
    this.widgets.timeUnit.value = "frames";
    this.widgets.defaultFadeIn.value = 0;
    this.widgets.defaultFadeOut.value = 0;
    this.migrationPending = false;
    this.rawInvalid = false;
    this.clearError();
    this.serialize();
    if (renderGroupError) this.showError(`${renderGroupError} Render groups were reset.`);
    this.saveViewState();
  }

  restoreRenderGroups() {
    try {
      normalizeRenderGroups(loadRenderGroups(
        this.clips,
        this.widgets.renderGroups?.value || "",
      ));
      if (this.widgets.renderGroups) {
        this.widgets.renderGroups.value = serializeRenderGroups(this.clips);
      }
      return null;
    } catch (error) {
      for (const clip of this.clips) clip.renderGroup = null;
      if (this.widgets.renderGroups) this.widgets.renderGroups.value = "";
      return error.message;
    }
  }

  loadTimeline() {
    const raw = this.widgets.timeline?.value || "";
    const unit = this.sourceUnit();
    let renderGroupError = null;
    try {
      const clips = parseTimeline(raw, this.defaultFadeIn(), this.defaultFadeOut());
      if (unit === "frames") {
        this.clips = validateFrameClips(clips);
        renderGroupError = this.restoreRenderGroups();
        this.migrationPending = false;
        this.rawInvalid = false;
        this.clearError();
        this.saveViewState();
      } else {
        const migrated = this.migrateLegacyClips(clips, unit);
        if (!migrated) {
          this.clips = [];
          this.selectedIndex = -1;
          this.selectedIndices.clear();
          this.migrationPending = true;
          this.rawInvalid = false;
          this.showMigration();
        } else {
          this.finishMigration(migrated);
        }
      }
      if (this.selectedIndex >= this.clips.length) {
        this.selectedIndex = -1;
        this.selectedIndices.clear();
      } else if (this.selectedIndex >= 0) {
        this.selectedIndices = new Set([this.selectedIndex]);
      }
      this.selectionAnchor = this.selectedIndex;
      if (renderGroupError) this.showError(`${renderGroupError} Render groups were reset.`);
    } catch (error) {
      this.clips = [];
      this.selectedIndex = -1;
      this.selectedIndices.clear();
      this.migrationPending = false;
      this.rawInvalid = true;
      this.showError(error.message);
      this.rawText.value = raw;
      this.toggleRaw(true);
    }
    this.setEditorEnabled(!this.migrationPending && !this.rawInvalid);
    this.syncInspector();
    this.scheduleDraw();
  }

  frameClipsFromPayload(sections) {
    return sections.map((section) => ({
      line: finiteNumber(section.line, 0),
      start: Math.round(finiteNumber(section.start_frame)),
      end: Math.round(finiteNumber(section.end_frame)),
      fadeIn: Math.round(finiteNumber(section.fade_in_frames)),
      fadeOut: Math.round(finiteNumber(section.fade_out_frames)),
      crossfade: Math.round(finiteNumber(section.crossfade_frames)),
      prompt: String(section.prompt || ""),
      renderGroup: section.render_group ?? null,
    }));
  }

  updateFromExecution(message) {
    const payload = executionPayload(message);
    if (!payload || !Array.isArray(payload.beat_times)) return;
    this.applyAnalysis(payload, true);

    const sourceUnit = payload.source_unit || payload.time_unit || this.sourceUnit();
    if (sourceUnit !== "frames" && Array.isArray(payload.frame_sections)) {
      try {
        this.finishMigration(this.frameClipsFromPayload(payload.frame_sections));
      } catch (error) {
        this.showError(error.message);
      }
    } else {
      this.loadTimeline();
    }
    this.resnapClipsToGrid();
    this.resnapSongMapToGrid();
    this.saveViewState();
    this.zoomToFit();
    this.refreshBeatStatus();
  }

  markBeatDataCached() {
    if (!this.beatData) return;
    this.dataFresh = false;
    this.refreshBeatStatus();
  }

  setEditorEnabled(enabled) {
    for (const button of this.editButtons) button.disabled = !enabled;
    this.clipInspector.classList.toggle("disabled", !enabled || !this.selectedClip());
  }

  showMigration() {
    this.errorEl.textContent = "Run this node once to convert the legacy beat schedule to integer frames. The resolved timing is preserved.";
    this.errorEl.classList.add("open");
    this.statusEl.className = "flbps-status error";
    this.statusEl.textContent = "Legacy beat schedule needs one run";
  }

  refreshBeatStatus() {
    if (this.migrationPending) {
      this.showMigration();
      return;
    }
    if (!this.beatData) {
      this.setStatus("Choose audio or connect beat positions");
      return;
    }
    const count = this.beatData.beatTimes?.length || 0;
    const detected = this.beatData.detectedBeatTimes?.length || 0;
    const downbeats = this.beatData.detectedDownbeatTimes?.length || 0;
    const onsets = this.beatData.onsetTimes?.length || 0;
    const confidences = this.beatData.detectedBeatConfidences || [];
    const averageConfidence = confidences.length
      ? confidences.reduce((total, value) => total + finiteNumber(value), 0) / confidences.length
      : 0;
    const offset = this.beatOffsetMs();
    const offsetText = offset ? ` · offset ${offset > 0 ? "+" : ""}${offset} ms` : "";
    const beatSource = this.beatData.beatAnalysisSource || "mix";
    const referenceSource = this.beatData.analysisSource || "mix";
    const songMap = this.songMap();
    const songMapText = songMap
      ? ` · ${songMap.sections.length} song sections · ${songMap.moments.length} moments`
      : "";
    const sourceText = this.beatData.detector?.name === "beat_this"
      ? ` · Beat This: ${beatSource}${referenceSource !== beatSource ? ` · transients: ${referenceSource}` : ""}`
      : "";
    const density = GRID_DENSITY_LABELS[this.beatGridDensity()];
    const text = `${finiteNumber(this.beatData.gridBpm, this.beatData.bpm).toFixed(2)} grid BPM · ${density} · ${count} grid · ` +
      `${detected} beats · ${downbeats} downbeats · ${onsets} onsets` +
      (averageConfidence > 0 ? ` · ${(averageConfidence * 100).toFixed(0)}% avg confidence` : "") +
      sourceText +
      songMapText +
      offsetText;
    if (this.dataFresh) {
      this.setStatus(text, "fresh");
    } else {
      this.setStatus(`${text} · cached`, "cached");
    }
    this.statusEl.title = `${text} · ${finiteNumber(this.beatData.audioDuration).toFixed(2)} sec`;
  }

  showError(message) {
    this.errorEl.textContent = message;
    this.errorEl.classList.add("open");
    this.statusEl.className = "flbps-status error";
    this.statusEl.textContent = "Schedule source needs attention";
  }

  clearError() {
    this.errorEl.textContent = "";
    this.errorEl.classList.remove("open");
    this.refreshBeatStatus();
  }

  selectedClip() {
    return this.selectedIndex >= 0 ? this.clips[this.selectedIndex] : null;
  }

  select(index) {
    if (this.activeLane !== "prompt") this.activateLane("prompt");
    this.selectedIndex = index >= 0 && index < this.clips.length ? index : -1;
    this.selectedIndices = this.selectedIndex >= 0
      ? new Set([this.selectedIndex])
      : new Set();
    this.selectionAnchor = this.selectedIndex;
    this.syncInspector();
    this.scheduleDraw();
  }

  toggleSelection(index) {
    if (this.activeLane !== "prompt") this.activateLane("prompt");
    if (index < 0 || index >= this.clips.length) return;
    if (this.selectedIndices.has(index)) {
      this.selectedIndices.delete(index);
      if (this.selectedIndex === index) {
        this.selectedIndex = [...this.selectedIndices].at(-1) ?? -1;
      }
    } else {
      this.selectedIndices.add(index);
      this.selectedIndex = index;
    }
    this.selectionAnchor = index;
    this.syncInspector();
    this.scheduleDraw();
  }

  selectRange(index) {
    if (this.activeLane !== "prompt") this.activateLane("prompt");
    if (index < 0 || index >= this.clips.length) return;
    const anchor = this.selectionAnchor >= 0 ? this.selectionAnchor : this.selectedIndex;
    const start = Math.min(anchor >= 0 ? anchor : index, index);
    const end = Math.max(anchor >= 0 ? anchor : index, index);
    this.selectedIndices = new Set(
      Array.from({ length: end - start + 1 }, (_, offset) => start + offset),
    );
    this.selectedIndex = index;
    this.syncInspector();
    this.scheduleDraw();
  }

  selectedClipIndices() {
    return [...this.selectedIndices].sort((left, right) => left - right);
  }

  selectedSongSection() {
    return this.songMap()?.sections.find(section => section.id === this.selectedSongSectionId) || null;
  }

  songSectionIndex(id) {
    return this.songMap()?.sections.findIndex(section => section.id === id) ?? -1;
  }

  songSectionLocalRange(section) {
    const cropStart = this.cropStartSeconds();
    return {
      start: Math.round((section.start - cropStart) * this.fps()),
      end: Math.round((section.end - cropStart) * this.fps()),
    };
  }

  sourceTimeAtLocalFrame(frame) {
    return clamp(
      this.cropStartSeconds() + frame / this.fps(),
      0,
      this.sourceAnalysis?.songMap?.duration ?? Infinity,
    );
  }

  editableSongSections() {
    return (this.songMap()?.sections || []).map(section => ({
      id: section.id,
      start: section.start,
      end: section.end,
      family: section.family,
      role: { ...section.role },
    }));
  }

  persistSongSections(sections, save = true) {
    this.songMapOverrides = replaceSongMapSections(
      this.songMapOverrides,
      this.sourceAnalysis?.songMap,
      sections,
    );
    if (save) this.saveViewState();
    this.syncInspector();
    this.scheduleDraw();
  }

  selectSongSection(id) {
    const sections = this.songMap()?.sections || [];
    this.selectedSongSectionId = sections.some(section => section.id === id) ? id : null;
    this.selectedSongSectionIds = this.selectedSongSectionId
      ? new Set([this.selectedSongSectionId])
      : new Set();
    this.songSelectionAnchorId = this.selectedSongSectionId;
    this.activateLane("song-map");
    this.scheduleDraw();
  }

  positionSongLabelEditor() {
    if (!this.editingSongSectionId || this.songLabelEditor.hidden) return;
    const rect = this.songMapRects.find(entry => entry.section.id === this.editingSongSectionId);
    if (!rect) return;
    const right = Math.max(TIMELINE_LEFT + 1, this.canvas.clientWidth - TIMELINE_RIGHT);
    const width = Math.min(Math.max(44, rect.width - 8), right - TIMELINE_LEFT);
    const left = clamp(rect.x + 4, TIMELINE_LEFT, right - width);
    const height = clamp(rect.height - 8, 20, 28);
    this.songLabelEditor.style.left = `${left}px`;
    this.songLabelEditor.style.top = `${rect.y + (rect.height - height) / 2}px`;
    this.songLabelEditor.style.width = `${width}px`;
    this.songLabelEditor.style.height = `${height}px`;
  }

  beginSongLabelEdit(section) {
    if (!section) return;
    if (this.editingSongSectionId && this.editingSongSectionId !== section.id) {
      this.finishSongLabelEdit(true);
    }
    this.selectSongSection(section.id);
    this.beginEdit("Rename Song Map section");
    const label = songSectionLabel(section);
    this.editingSongSectionId = section.id;
    this.songLabelEditor.value = label;
    this.songLabelEditor.dataset.originalValue = label;
    this.songLabelEditor.hidden = false;
    this.positionSongLabelEditor();
    this.songLabelEditor.focus();
    this.songLabelEditor.select();
  }

  finishSongLabelEdit(commit) {
    const sectionId = this.editingSongSectionId;
    if (!sectionId) return;
    const value = this.songLabelEditor.value.trim().slice(0, 48);
    const originalValue = this.songLabelEditor.dataset.originalValue || "";
    this.editingSongSectionId = null;
    this.songLabelEditor.hidden = true;
    delete this.songLabelEditor.dataset.originalValue;
    if (!commit || value === originalValue) {
      this.cancelEdit();
      this.scheduleDraw();
      return;
    }
    const section = this.songMap()?.sections.find(entry => entry.id === sectionId);
    if (!section) {
      this.cancelEdit();
      return;
    }
    const defaultLabel = songSectionLabel({
      ...section,
      role: { ...section.role, customLabel: "" },
    });
    const customLabel = value === defaultLabel ? "" : value;
    if (customLabel === (section.role.customLabel || "")) {
      this.cancelEdit();
      return;
    }
    if (!this.historyTransaction) this.beginEdit("Rename Song Map section");
    this.setSongMapRole(
      section,
      !customLabel && section.role.value === "unknown" ? "auto" : section.role.value,
      customLabel,
    );
    this.commitEdit();
  }

  toggleSongSelection(id) {
    if (this.songSectionIndex(id) < 0) return;
    if (this.selectedSongSectionIds.has(id)) {
      this.selectedSongSectionIds.delete(id);
      if (this.selectedSongSectionId === id) {
        this.selectedSongSectionId = [...this.selectedSongSectionIds].at(-1) || null;
      }
    } else {
      this.selectedSongSectionIds.add(id);
      this.selectedSongSectionId = id;
    }
    this.songSelectionAnchorId = id;
    this.activateLane("song-map");
    this.scheduleDraw();
  }

  selectSongRange(id) {
    const sections = this.songMap()?.sections || [];
    const index = sections.findIndex(section => section.id === id);
    const anchor = sections.findIndex(section => section.id === this.songSelectionAnchorId);
    if (index < 0) return;
    const start = Math.min(anchor >= 0 ? anchor : index, index);
    const end = Math.max(anchor >= 0 ? anchor : index, index);
    this.selectedSongSectionIds = new Set(sections.slice(start, end + 1).map(section => section.id));
    this.selectedSongSectionId = id;
    this.activateLane("song-map");
    this.scheduleDraw();
  }

  createWriterDocument(scope) {
    const bpm = finiteNumber(this.beatData?.gridBpm, this.beatData?.bpm);
    const music = createSongWriterContext(this.songMap(), this.clips, {
      fps: this.fps(),
      cropStart: this.cropStartSeconds(),
      totalFrames: this.sequenceFrameCount(),
      bpm,
    });
    const lyrics = this.lyricsWriterContext();
    return createPromptWriterDocument(this.clips, {
      scope,
      selectedIndices: this.selectedClipIndices(),
      selectedIndex: this.selectedIndex,
      fps: this.fps(),
      totalFrames: this.sequenceFrameCount(),
      bpm,
      beatLabel: (frame) => this.nearestBeatLabel(frame),
      songContext: music.songContext,
      musicContext: (index) => music.boxContexts.get(index) || null,
      musicContextRevision: this.songMapRevision(),
      lyricsContext: lyrics.lyricsContext,
      lyricContext: (index) => lyrics.boxContexts.get(index) || null,
      lyricsContextRevision: lyrics.revision,
    });
  }

  setWriterActivity(activity) {
    this.writerCompletionFades ||= new Map();
    clearTimeout(this.writerActivityTimer);
    this.writerActivityTimer = null;
    const phase = String(activity?.phase || "idle");
    if (phase === "idle") {
      this.clearWriterActivity();
      return;
    }
    const indices = (value) => new Set((Array.isArray(value) ? value : [])
      .filter((index) => Number.isInteger(index) && index >= 0 && index < this.clips.length));
    if (!activity?.restoring && !this.writerReducedMotion) {
      const expires = performance.now() + 700;
      for (const index of indices(activity?.newlyCompletedIndices)) this.writerCompletionFades.set(index, expires);
    }
    this.writerActivity = {
      phase,
      label: String(activity?.label || "Beat Writer"),
      scopeIndices: indices(activity?.scopeIndices),
      targetIndices: indices(activity?.targetIndices),
      appliedIndices: indices(activity?.appliedIndices),
      completedIndices: indices(activity?.completedIndices),
      activeIndex: Number.isInteger(activity?.activeIndex) ? activity.activeIndex : null,
      failedIndex: Number.isInteger(activity?.failedIndex) ? activity.failedIndex : null,
      progressCompleted: Number(activity?.progressCompleted) || 0,
      progressTotal: Number(activity?.progressTotal) || 0,
    };
    this.writerActivityStartedAt = performance.now();
    if (["applied", "complete", "no_changes", "stopped"].includes(phase)) {
      this.writerActivityTimer = setTimeout(() => this.clearWriterActivity(), phase === "applied" ? 5000 : 3500);
    }
    this.scheduleDraw(false);
    this.scheduleWriterActivityFrame();
  }

  clearWriterActivity() {
    this.writerCompletionFades ||= new Map();
    clearTimeout(this.writerActivityTimer);
    this.writerActivityTimer = null;
    this.writerActivity = null;
    this.writerCompletionFades.clear();
    if (this.writerActivityFrame !== null) cancelAnimationFrame(this.writerActivityFrame);
    this.writerActivityFrame = null;
    this.scheduleDraw(false);
  }

  scheduleWriterActivityFrame() {
    this.writerCompletionFades ||= new Map();
    const now = performance.now();
    for (const [index, expires] of this.writerCompletionFades) {
      if (expires <= now) this.writerCompletionFades.delete(index);
    }
    const animated = !this.writerReducedMotion && (
      (this.writerActivity?.activeIndex != null && ["editing", "writing"].includes(this.writerActivity.phase)) ||
      this.writerCompletionFades.size
    );
    if (!animated || this.writerActivityFrame !== null) return;
    this.writerActivityFrame = requestAnimationFrame(() => {
      this.writerActivityFrame = null;
      this.scheduleDraw(false);
      this.scheduleWriterActivityFrame();
    });
  }

  applyWriterUpdates(document, updates) {
    return this.runEdit("Apply Beat Writer edit", () => {
      if (document.music_context_revision !== this.songMapRevision()) {
        throw new Error("The song map changed while Beat Writer was working. Send the request again.");
      }
      if (document.lyrics_context_revision !== this.lyricsWriterContext().revision) {
        throw new Error("The timed lyrics changed while Beat Writer was working. Send the request again.");
      }
      const result = applyPromptWriterUpdates(
        this.clips,
        document.revision,
        updates,
        document.allowed_indices,
      );
      if (!result.applied) return 0;
      this.serialize();
      this.syncInspector();
      this.scheduleDraw();
      if (this.historyTransaction) this.historyTransaction.count = result.applied;
      return result.applied;
    }, { kind: "writer", isolated: true });
  }

  undoWriterUpdates() {
    const entry = this.undoStack.at(-1);
    if (entry?.kind !== "writer") {
      throw new Error("The latest edit is not a Beat Writer edit. Use the sequencer Undo control instead.");
    }
    const count = entry.count;
    this.undo();
    return count;
  }

  nearestBeatLabel(frame) {
    const frames = this.beatFrames();
    if (!frames.length) return "unavailable";
    let nearest = 0;
    for (let index = 1; index < frames.length; index++) {
      if (Math.abs(frames[index] - frame) < Math.abs(frames[nearest] - frame)) nearest = index;
    }
    return `B${nearest}`;
  }

  syncInspector() {
    this.syncSongInspector();
    this.syncLyricsInspector();
    const clip = this.selectedClip();
    this.clipInspector.classList.toggle("disabled", this.migrationPending || !clip);
    if (!clip) {
      for (const field of Object.values(this.fields)) field.value = "";
      this.promptMetaEl.textContent = "";
      return;
    }
    this.fields.start.value = String(clip.start);
    this.fields.end.value = String(clip.end);
    this.fields.fadeIn.value = String(clip.fadeIn);
    this.fields.fadeOut.value = String(clip.fadeOut);
    this.fields.crossfade.value = String(clip.crossfade);
    this.fields.prompt.value = clip.prompt;
    const previous = this.clips[this.selectedIndex - 1];
    this.fields.crossfade.disabled = !previous || previous.end !== clip.start;
    const frames = clip.end - clip.start;
    this.fields.duration.value = `${frames} frames / ${(frames / this.fps()).toFixed(3)}s`;
    this.promptMetaEl.textContent =
      `frames ${clip.start}–${clip.end} · ${formatClock(clip.start / this.fps())}–${formatClock(clip.end / this.fps())} · ` +
      `beats ${this.nearestBeatLabel(clip.start)}–${this.nearestBeatLabel(clip.end)}`;
  }

  syncSongInspector() {
    const section = this.selectedSongSection();
    this.songInspector.classList.toggle("disabled", !this.songMap());
    if (!section) {
      for (const field of Object.values(this.songFields)) field.value = "";
      this.songMetaEl.textContent = "";
      this.songSummaryEl.textContent = "";
      return;
    }
    const range = this.songSectionLocalRange(section);
    const frames = range.end - range.start;
    this.songFields.start.value = String(range.start);
    this.songFields.end.value = String(range.end);
    this.songFields.start.disabled = range.start < 0;
    this.songFields.end.disabled = range.end > this.sequenceFrameCount();
    this.songFields.duration.value = `${frames} frames / ${(frames / this.fps()).toFixed(3)}s`;
    this.songFields.role.value = section.role.value;
    this.songMetaEl.textContent =
      `source ${formatClock(section.start)}–${formatClock(section.end)} · ` +
      `${this.nearestBeatLabel(range.start)}–${this.nearestBeatLabel(range.end)}`;
    this.songSummaryEl.textContent =
      `Energy ${section.energy.mean.toFixed(2)} mean / ${section.energy.peak.toFixed(2)} peak / ${section.energy.trend}. ` +
      `Rhythm ${section.rhythm.onsetDensity.toFixed(2)} onsets/sec. ` +
      `Bars ${section.barStart + 1}–${Math.max(section.barStart + 1, section.barEnd)}. ` +
      `${section.role.source === "manual" ? "Manual label." : `${Math.round(section.role.confidence * 100)}% inferred label.`}`;
  }

  syncLyricsInspector() {
    const segment = this.selectedLyricsSegment();
    const current = this.lyricsCurrent();
    this.lyricsFields.source.value = this.lyricsSettings.source;
    this.lyricsFields.model.value = this.lyricsSettings.model;
    this.lyricsFields.language.value = this.lyricsSettings.language;
    this.lyricsFields.includeInWriter.checked = this.lyricsSettings.includeInWriter;
    this.lyricsInspector.classList.remove("disabled");
    this.lyricsFields.start.disabled = !segment;
    this.lyricsFields.end.disabled = !segment;
    this.lyricsFields.text.disabled = !segment;
    this.root.querySelector('[data-action="reset-lyrics"]').disabled = !this.lyricsTimeline?.cacheKey;
    this.root.querySelector('[data-action="discard-lyrics"]').disabled = !this.lyricsTimeline;
    if (!segment) {
      this.lyricsFields.start.value = "";
      this.lyricsFields.end.value = "";
      this.lyricsFields.duration.value = "";
      this.lyricsFields.text.value = "";
      this.lyricsMetaEl.textContent = "";
    } else {
      const range = this.lyricsSegmentLocalRange(segment);
      const frames = range.end - range.start;
      this.lyricsFields.start.value = String(range.start);
      this.lyricsFields.end.value = String(range.end);
      this.lyricsFields.start.disabled = range.start < 0;
      this.lyricsFields.end.disabled = range.end > this.sequenceFrameCount();
      this.lyricsFields.duration.value = `${frames} frames / ${(frames / this.fps()).toFixed(3)}s`;
      this.lyricsFields.text.value = segment.text;
      this.lyricsMetaEl.textContent =
        `${segment.origin} · source ${formatClock(segment.start)}–${formatClock(segment.end)}`;
    }
    if (!this.lyricsTimeline) {
      this.lyricsStatusEl.textContent = "No timed lyrics yet. Transcribe locally or import an LRC/SRT file.";
      this.lyricsStatusEl.className = "flbps-lyrics-status";
    } else if (!current) {
      this.lyricsStatusEl.textContent =
        `Lyrics belong to ${this.lyricsTimeline.audioFile || "another audio file"} and are excluded from Beat Writer.`;
      this.lyricsStatusEl.className = "flbps-lyrics-status warning";
    } else {
      const language = this.lyricsTimeline.detectedLanguage || this.lyricsTimeline.requestedLanguage || "unknown";
      const writer = this.lyricsSettings.includeInWriter ? "included in Beat Writer" : "excluded from Beat Writer";
      this.lyricsStatusEl.textContent =
        `${this.lyricsTimeline.segments.length} timed line${this.lyricsTimeline.segments.length === 1 ? "" : "s"} · ` +
        `${language} · ${this.lyricsTimeline.audioSource} · ${writer}. Only text is sent; audio stays local.`;
      this.lyricsStatusEl.className = "flbps-lyrics-status ready";
    }
  }

  applyLyricsInspector() {
    const segment = this.selectedLyricsSegment();
    if (!segment) return;
    const segments = this.lyricsTimeline.segments.map(value => ({ ...value }));
    const index = segments.findIndex(value => value.id === segment.id);
    const previous = segments[index - 1];
    const next = segments[index + 1];
    const startFrame = Math.round(finiteNumber(this.lyricsFields.start.value));
    const endFrame = Math.round(finiteNumber(this.lyricsFields.end.value));
    const start = this.cropStartSeconds() + startFrame / this.fps();
    const end = this.cropStartSeconds() + endFrame / this.fps();
    if (start < (previous?.end || 0) - EPSILON || end > (next?.start || Infinity) + EPSILON || end <= start) {
      this.showError("Lyric timing must remain ordered without overlaps.");
      this.syncLyricsInspector();
      return;
    }
    segments[index] = { ...segments[index], start, end, origin: "corrected" };
    delete segments[index].words;
    this.clearError();
    this.persistLyrics(segments, segment.id);
  }

  applyLyricsText() {
    const segment = this.selectedLyricsSegment();
    if (!segment) return;
    const text = this.lyricsFields.text.value.replace(/\s+/g, " ").trim();
    if (!text) {
      this.showError("A lyric segment cannot be empty. Delete it instead.");
      this.syncLyricsInspector();
      return;
    }
    const segments = this.lyricsTimeline.segments.map(value => ({ ...value }));
    const index = segments.findIndex(value => value.id === segment.id);
    segments[index] = { ...segments[index], text: text.slice(0, 1000), origin: "corrected" };
    delete segments[index].words;
    this.clearError();
    this.persistLyrics(segments, segment.id);
  }

  setInspectorTab(tab) {
    this.inspectorTab = tab === "envelopes" ? "envelopes" : "prompt";
    this.inspector.dataset.tab = this.inspectorTab;
    for (const button of this.root.querySelectorAll("[data-inspector-tab]")) {
      button.classList.toggle("active", button.dataset.inspectorTab === this.inspectorTab);
    }
    this.scheduleDraw();
  }

  renderEnvelopeEditor() {
    const hasEmptySlot = this.envelopeSlots.includes(null);
    const sourceOptions = (selected) => Object.entries(ENVELOPE_SOURCES)
      .map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`)
      .join("");
    this.envelopeCards.innerHTML = this.envelopeSlots.map((layer, index) => {
      const accent = ENVELOPE_ACCENTS[index];
      if (!layer) {
        return `
          <div class="flbps-envelope-empty" data-slot="${index}" style="--flbps-envelope-accent:${accent}">
            <button class="flbps-button" data-action="add-envelope-slot" data-slot="${index}">+ Envelope ${index + 1}</button>
          </div>
        `;
      }
      return `
        <article class="flbps-envelope-card${layer.enabled ? "" : " disabled"}" data-slot="${index}" style="--flbps-envelope-accent:${accent}">
          <div class="flbps-envelope-card-header">
            <input class="flbps-envelope-enabled" data-envelope-field="enabled" type="checkbox"${layer.enabled ? " checked" : ""} title="Enable envelope ${index + 1}">
            <span class="flbps-envelope-card-name">Envelope ${index + 1}</span>
            <span class="flbps-spacer"></span>
            <label class="flbps-control">Source
              <select class="flbps-envelope-source" data-envelope-field="source">${sourceOptions(layer.source)}</select>
            </label>
            <button class="flbps-button flbps-envelope-icon" data-action="duplicate-envelope" title="Duplicate into the first empty slot"${hasEmptySlot ? "" : " disabled"}>&#x2398;</button>
            <button class="flbps-button flbps-envelope-icon danger" data-action="clear-envelope" title="Clear envelope ${index + 1}">&times;</button>
          </div>
          <textarea class="flbps-envelope-prompt" data-envelope-field="prompt" placeholder="Reactive prompt (optional for signal-only use)"></textarea>
          <div class="flbps-envelope-controls">
            <div class="flbps-envelope-control"><label>Every</label><input data-envelope-field="stride" type="number" min="1" max="64" step="1" value="${layer.stride}"></div>
            <div class="flbps-envelope-control"><label>Phase</label><input data-envelope-field="phase" type="number" min="0" max="${layer.stride - 1}" step="1" value="${layer.phase}"></div>
            <div class="flbps-envelope-control"><label>Attack</label><input data-envelope-field="attack_frames" type="number" min="0" max="240" step="1" value="${layer.attack_frames}"></div>
            <div class="flbps-envelope-control"><label>Hold</label><input data-envelope-field="hold_frames" type="number" min="0" max="240" step="1" value="${layer.hold_frames}"></div>
            <div class="flbps-envelope-control"><label>Release</label><input data-envelope-field="release_frames" type="number" min="0" max="240" step="1" value="${layer.release_frames}"></div>
            <div class="flbps-envelope-control"><label>Floor</label><input data-envelope-field="floor_strength" type="number" min="0" max="8" step="0.05" value="${layer.floor_strength}"></div>
            <div class="flbps-envelope-control"><label>Peak</label><input data-envelope-field="peak_strength" type="number" min="0" max="8" step="0.05" value="${layer.peak_strength}"></div>
            <div class="flbps-envelope-control"><label>Curve</label><select data-envelope-field="curve"><option value="linear"${layer.curve === "linear" ? " selected" : ""}>Linear</option><option value="cosine"${layer.curve === "cosine" ? " selected" : ""}>Cosine</option></select></div>
          </div>
          <div class="flbps-envelope-preview-row">
            <div class="flbps-envelope-strip-wrap">
              <canvas class="flbps-envelope-strip" data-envelope-strip="${index}" title="Click to move the playhead"></canvas>
              <span class="flbps-envelope-playhead" data-envelope-playhead="${index}"></span>
            </div>
            <div class="flbps-envelope-live" data-envelope-live="${index}" title="Current normalized envelope frame"></div>
            <div class="flbps-envelope-value" data-envelope-value="${index}"></div>
          </div>
        </article>
      `;
    }).join("");

    this.envelopeSlots.forEach((layer, index) => {
      if (!layer) return;
      const card = this.envelopeCards.querySelector(`.flbps-envelope-card[data-slot="${index}"]`);
      card.querySelector('[data-envelope-field="prompt"]').value = layer.prompt;
      for (const input of card.querySelectorAll("[data-envelope-field]")) {
        const eventName = input.dataset.envelopeField === "prompt" ? "input" : "change";
        if (input.dataset.envelopeField === "prompt") {
          input.addEventListener("focus", () => this.beginEdit(`Edit envelope ${index + 1} prompt`));
          input.addEventListener("blur", () => this.commitEdit());
          input.addEventListener(eventName, () => {
            if (!this.historyTransaction) this.beginEdit(`Edit envelope ${index + 1} prompt`);
            this.updateEnvelopeField(index, input);
          });
        } else {
          input.addEventListener(eventName, () => this.runEdit(
            `Edit envelope ${index + 1}`,
            () => this.updateEnvelopeField(index, input),
          ));
        }
      }
      card.querySelector('[data-action="duplicate-envelope"]').addEventListener(
        "click",
        () => this.runEdit(`Duplicate envelope ${index + 1}`, () => this.duplicateEnvelope(index)),
      );
      card.querySelector('[data-action="clear-envelope"]').addEventListener(
        "click",
        () => this.runEdit(`Clear envelope ${index + 1}`, () => this.clearEnvelope(index)),
      );
      card.querySelector("canvas").addEventListener("click", (event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const ratio = clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
        this.playheadFrame = this.viewStart + ratio * (this.viewEnd - this.viewStart);
        if (this.audioElement) {
          this.audioElement.currentTime = this.cropStartSeconds() + this.playheadFrame / this.fps();
        }
        this.updateTransportTime();
        this.scheduleDraw();
      });
    });
    for (const button of this.envelopeCards.querySelectorAll('[data-action="add-envelope-slot"]')) {
      button.addEventListener("click", () => this.runEdit(
        `Add envelope ${Number(button.dataset.slot) + 1}`,
        () => this.addEnvelope(Number(button.dataset.slot)),
      ));
    }
    this.addEnvelopeButton.disabled = !hasEmptySlot;
    this.envelopeViewKey = "";
    this.scheduleDraw();
  }

  addEnvelope(slot = this.envelopeSlots.indexOf(null)) {
    if (slot < 0 || slot >= this.envelopeSlots.length || this.envelopeSlots[slot]) return;
    this.envelopeSlots[slot] = defaultEnvelopeLayer();
    this.saveEnvelopeLayers();
    this.renderEnvelopeEditor();
  }

  duplicateEnvelope(index) {
    const target = this.envelopeSlots.indexOf(null);
    if (target < 0 || !this.envelopeSlots[index]) return;
    this.envelopeSlots[target] = { ...this.envelopeSlots[index] };
    this.saveEnvelopeLayers();
    this.renderEnvelopeEditor();
  }

  clearEnvelope(index) {
    this.envelopeSlots[index] = null;
    this.saveEnvelopeLayers();
    this.renderEnvelopeEditor();
  }

  updateEnvelopeField(index, input) {
    const layer = this.envelopeSlots[index];
    if (!layer) return;
    const name = input.dataset.envelopeField;
    let value = input.type === "checkbox" ? input.checked : input.value;
    if (!["enabled", "source", "prompt", "curve"].includes(name)) {
      value = finiteNumber(value, layer[name]);
    }
    const next = normalizeEnvelopeLayer({ ...layer, [name]: value });
    if (next.floor_strength > next.peak_strength) {
      if (name === "floor_strength") next.peak_strength = next.floor_strength;
      else next.floor_strength = next.peak_strength;
    }
    const timingAdjusted = next.attack_frames + next.hold_frames + next.release_frames <= 0;
    if (timingAdjusted) {
      next.hold_frames = 1;
    }
    this.envelopeSlots[index] = next;
    this.saveEnvelopeLayers(name !== "prompt");
    if (timingAdjusted || ["stride", "enabled", "floor_strength", "peak_strength"].includes(name)) {
      this.renderEnvelopeEditor();
    }
  }

  saveEnvelopeLayers(recompute = true) {
    if (this.widgets.envelopeLayers) {
      this.widgets.envelopeLayers.value = serializeEnvelopeLayers(this.envelopeSlots);
    }
    if (recompute) {
      this.envelopeDataVersion++;
      this.envelopeViewKey = "";
    }
    this.markDirty();
    this.scheduleDraw();
  }

  envelopeEvents(source) {
    if (!this.sourceAnalysis) {
      if (source === "beat_grid") return this.beatData?.beatTimes || [];
      if (source === "downbeat") return this.beatData?.downbeatTimes || [];
      if (source === "raw_beat") return this.beatData?.detectedBeatTimes || [];
      if (source === "onset") return this.beatData?.onsetTimes || [];
      return this.beatData?.drumTimes?.[`${source}_times`] || [];
    }

    const cropStart = this.cropStartSeconds();
    const sourceValues = this.sourceBeatValues();
    let values = [];
    if (source === "beat_grid") {
      values = this.gridBeatTimes(this.beatOffsetMs(), false);
    } else if (source === "downbeat") {
      values = this.gridDownbeatTimes(this.beatOffsetMs(), false);
    } else if (source === "raw_beat") {
      values = sourceValues?.detectedBeats || [];
    } else if (source === "onset") {
      values = this.sourceAnalysis.onsetTimes || [];
    } else {
      values = this.sourceAnalysis.drumTimes?.[`${source}_times`] || [];
    }
    return values.map((value) => finiteNumber(value) - cropStart);
  }

  computeEnvelopePreviews() {
    const totalFrames = this.sequenceFrameCount();
    const fps = this.fps();
    this.envelopePreviewValues = this.envelopeSlots.map((layer) => layer
      ? generateEnvelopeValues(this.envelopeEvents(layer.source), totalFrames, fps, layer)
      : null);
    this.envelopeComputedVersion = this.envelopeDataVersion;
  }

  drawEnvelopeStrip(canvas, values) {
    const bounds = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#050506";
    ctx.fillRect(0, 0, width, height);
    const range = Math.max(1, this.viewEnd - this.viewStart);
    for (let x = 0; x < width; x++) {
      const first = clamp(Math.floor(this.viewStart + x / width * range), 0, values.length);
      const last = clamp(
        Math.max(first + 1, Math.ceil(this.viewStart + (x + 1) / width * range)),
        0,
        values.length,
      );
      let value = 0;
      for (let frame = first; frame < last; frame++) value = Math.max(value, values[frame]);
      const shade = Math.round(clamp(value, 0, 1) * 255);
      ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
      ctx.fillRect(x, 0, 1, height);
    }
  }

  syncEnvelopePreviews() {
    if (this.envelopeComputedVersion !== this.envelopeDataVersion) {
      this.computeEnvelopePreviews();
    }
    const widths = [...this.envelopeCards.querySelectorAll("canvas")]
      .map((canvas) => Math.round(canvas.getBoundingClientRect().width))
      .join(",");
    const viewKey = `${this.viewStart}:${this.viewEnd}:${widths}:${this.envelopeComputedVersion}`;
    if (viewKey !== this.envelopeViewKey) {
      this.envelopePreviewValues.forEach((values, index) => {
        const canvas = this.envelopeCards.querySelector(`[data-envelope-strip="${index}"]`);
        if (canvas && values) this.drawEnvelopeStrip(canvas, values);
      });
      this.envelopeViewKey = viewKey;
    }
    this.updateEnvelopePlayheads();
  }

  updateEnvelopePlayheads() {
    const frame = clamp(Math.floor(this.playheadFrame ?? 0), 0, Math.max(0, this.sequenceFrameCount() - 1));
    const range = Math.max(1, this.viewEnd - this.viewStart);
    this.envelopeSlots.forEach((layer, index) => {
      if (!layer) return;
      const values = this.envelopePreviewValues[index];
      const value = values?.[frame] || 0;
      const shade = Math.round(clamp(value, 0, 1) * 255);
      const live = this.envelopeCards.querySelector(`[data-envelope-live="${index}"]`);
      if (live) live.style.background = `rgb(${shade},${shade},${shade})`;
      const mapped = layer.floor_strength + value * (layer.peak_strength - layer.floor_strength);
      const text = this.envelopeCards.querySelector(`[data-envelope-value="${index}"]`);
      if (text) text.textContent = `signal ${value.toFixed(2)}\nprompt ${mapped.toFixed(2)}`;
      const playhead = this.envelopeCards.querySelector(`[data-envelope-playhead="${index}"]`);
      if (!playhead) return;
      const visible = frame >= this.viewStart && frame <= this.viewEnd;
      playhead.style.display = visible ? "block" : "none";
      if (visible) playhead.style.left = `${(frame - this.viewStart) / range * 100}%`;
    });
  }

  invalidateEnvelopePreviews() {
    this.envelopeDataVersion++;
    this.envelopeViewKey = "";
    this.scheduleDraw();
  }

  applyInspectorTiming() {
    const clip = this.selectedClip();
    if (!clip || this.migrationPending) return;
    const start = Math.max(0, Math.round(finiteNumber(this.fields.start.value, clip.start)));
    const end = Math.round(finiteNumber(this.fields.end.value, clip.end));
    let fadeIn = Math.max(0, Math.round(finiteNumber(this.fields.fadeIn.value, clip.fadeIn)));
    let fadeOut = Math.max(0, Math.round(finiteNumber(this.fields.fadeOut.value, clip.fadeOut)));
    const crossfade = Math.max(
      0,
      Math.round(finiteNumber(this.fields.crossfade.value, clip.crossfade)),
    );
    if (!(end > start)) {
      this.showError("The selected prompt must end after it starts.");
      this.syncInspector();
      return;
    }
    if (crossfade > 0) fadeIn = 0;
    if (fadeIn + fadeOut > end - start) {
      this.showError("Fade in and fade out exceed the selected prompt duration.");
      this.syncInspector();
      return;
    }
    const previous = this.clips[this.selectedIndex - 1];
    const next = this.clips[this.selectedIndex + 1];
    const maximum = this.maximumFrame();
    if ((previous && start < previous.end) || (next && end > next.start) ||
        (Number.isFinite(maximum) && end > maximum)) {
      this.showError("Prompt clips cannot overlap or extend beyond the configured length.");
      this.syncInspector();
      return;
    }
    if (crossfade > 0) {
      if (!previous || previous.end !== start) {
        this.showError("Crossfade requires this prompt to touch the previous prompt.");
        this.syncInspector();
        return;
      }
      if (crossfade > Math.min(previous.end - previous.start, end - start)) {
        this.showError("Crossfade exceeds the shorter adjacent prompt.");
        this.syncInspector();
        return;
      }
      previous.fadeOut = 0;
      fadeIn = 0;
    }
    Object.assign(clip, { start, end, fadeIn, fadeOut, crossfade });
    normalizeCrossfades(this.clips);
    this.rawInvalid = false;
    this.clearError();
    this.serialize();
    this.syncInspector();
    this.scheduleDraw();
  }

  songSectionEntries() {
    return this.editableSongSections().map(section => ({
      section,
      ...this.songSectionLocalRange(section),
    }));
  }

  songRangeAvailable(start, end, ignoreId = null) {
    return end > start && start >= 0 && end <= this.sequenceFrameCount() &&
      this.songSectionEntries().every(entry => (
        entry.section.id === ignoreId || end <= entry.start || start >= entry.end
      ));
  }

  applySongInspector() {
    const section = this.selectedSongSection();
    if (!section) return;
    const sections = this.editableSongSections();
    const index = sections.findIndex(entry => entry.id === section.id);
    const originalRange = this.songSectionLocalRange(section);
    const start = Math.round(finiteNumber(this.songFields.start.value));
    const end = Math.round(finiteNumber(this.songFields.end.value));
    const previous = sections[index - 1];
    const next = sections[index + 1];
    const previousEnd = previous ? this.songSectionLocalRange(previous).end : -Infinity;
    const nextStart = next ? this.songSectionLocalRange(next).start : Infinity;
    const invalidCropStart = start < 0 && start !== originalRange.start;
    const invalidCropEnd = end > this.sequenceFrameCount() && end !== originalRange.end;
    if (!(end > start) || start < previousEnd || end > nextStart || invalidCropStart || invalidCropEnd) {
      this.showError("Song Map sections need valid, non-overlapping frame ranges.");
      this.syncSongInspector();
      return;
    }
    const roleValue = this.songFields.role.value;
    const customLabel = section.role.customLabel || "";
    const roleChanged = roleValue !== section.role.value;
    sections[index] = {
      ...sections[index],
      start: this.sourceTimeAtLocalFrame(start),
      end: this.sourceTimeAtLocalFrame(end),
      role: roleChanged ? {
        value: roleValue,
        customLabel,
        source: "manual",
        confidence: 1,
      } : { ...section.role },
    };
    if (roleChanged) {
      this.songMapOverrides = updateSongMapOverride(
        this.songMapOverrides,
        this.sourceAnalysis?.songMap,
        section.id,
        roleValue,
        customLabel,
      );
    }
    this.clearError();
    this.persistSongSections(sections);
  }

  resetSongLabels() {
    const base = this.sourceAnalysis?.songMap;
    if (!base) return;
    const baseRoles = new Map(base.sections.map(section => [section.id, section.role]));
    if (this.songMapOverrides.sections) {
      const sections = this.editableSongSections().map(section => ({
        ...section,
        role: { ...(baseRoles.get(section.id) || {
          value: "unknown",
          customLabel: "",
          source: "manual",
          confidence: 1,
        }) },
      }));
      this.songMapOverrides = replaceSongMapSections(
        { ...this.songMapOverrides, roles: {} },
        base,
        sections,
      );
    } else {
      this.songMapOverrides = { ...this.songMapOverrides, roles: {} };
    }
    this.saveViewState();
    this.syncInspector();
    this.scheduleDraw();
  }

  resetSongStructure() {
    const base = this.sourceAnalysis?.songMap;
    if (!base) return;
    this.songMapOverrides = resetSongMapStructure(this.songMapOverrides, base);
    if (!base.sections.some(section => section.id === this.selectedSongSectionId)) {
      this.selectedSongSectionId = base.sections[0]?.id || null;
      this.selectedSongSectionIds = this.selectedSongSectionId
        ? new Set([this.selectedSongSectionId])
        : new Set();
    }
    this.saveViewState();
    this.syncInspector();
    this.scheduleDraw();
  }

  resetEntireSongMap() {
    const base = this.sourceAnalysis?.songMap;
    if (!base) return;
    this.songMapOverrides = normalizeSongMapOverrides({
      version: 2,
      cacheKey: base.cacheKey,
      roles: {},
      sections: null,
      nextId: 1,
    });
    this.selectedSongSectionId = base.sections[0]?.id || null;
    this.selectedSongSectionIds = this.selectedSongSectionId
      ? new Set([this.selectedSongSectionId])
      : new Set();
    this.saveViewState();
    this.syncInspector();
    this.scheduleDraw();
  }

  addSongSection(startOverride = null, endOverride = null) {
    const base = this.sourceAnalysis?.songMap;
    if (!base) return;
    const frame = startOverride ?? this.playheadFrame ?? 0;
    const exact = endOverride != null;
    const range = exact ? { start: startOverride, end: endOverride } : this.gridClipRangeAt(frame);
    if (range === null) {
      this.showError("There is not enough room for a four-grid Song Map section.");
      return;
    }
    let start = Math.round(range?.start ?? this.snapFrame(frame));
    let end = Math.round(range?.end ?? Math.min(start + this.defaultClipLength(), this.sequenceFrameCount()));
    if (!this.songRangeAvailable(start, end)) {
      this.showError("Add sections in an empty Song Map range, or split the section under the playhead.");
      return;
    }
    const id = nextSongMapSectionId(this.songMapOverrides, base);
    const sections = this.editableSongSections();
    sections.push({
      id,
      start: this.sourceTimeAtLocalFrame(start),
      end: this.sourceTimeAtLocalFrame(end),
      family: `M${id.split("-").at(-1)}`,
      role: { value: "unknown", customLabel: "", source: "manual", confidence: 1 },
    });
    sections.sort((left, right) => left.start - right.start);
    this.selectedSongSectionId = id;
    this.selectedSongSectionIds = new Set([id]);
    this.songSelectionAnchorId = id;
    this.clearError();
    this.persistSongSections(sections);
  }

  splitSongSection() {
    const section = this.selectedSongSection();
    const base = this.sourceAnalysis?.songMap;
    if (!section || !base) return;
    const range = this.songSectionLocalRange(section);
    let split = this.playheadFrame == null ? Math.round((range.start + range.end) / 2) : this.playheadFrame;
    split = this.snapFrame(split, range.start + 1, range.end - 1);
    if (split <= range.start || split >= range.end) {
      this.showError("Place the playhead inside the selected Song Map section before splitting.");
      return;
    }
    const sections = this.editableSongSections();
    const index = sections.findIndex(entry => entry.id === section.id);
    const id = nextSongMapSectionId(this.songMapOverrides, base);
    const boundary = this.sourceTimeAtLocalFrame(split);
    sections.splice(index, 1,
      { ...sections[index], end: boundary },
      { ...sections[index], id, start: boundary },
    );
    this.selectedSongSectionId = id;
    this.selectedSongSectionIds = new Set([id]);
    this.songSelectionAnchorId = id;
    this.clearError();
    this.persistSongSections(sections);
  }

  deleteSongSection() {
    const section = this.selectedSongSection();
    if (!section) return;
    const sections = this.editableSongSections();
    const index = sections.findIndex(entry => entry.id === section.id);
    sections.splice(index, 1);
    const next = sections[Math.min(index, sections.length - 1)];
    this.selectedSongSectionId = next?.id || null;
    this.selectedSongSectionIds = this.selectedSongSectionId
      ? new Set([this.selectedSongSectionId])
      : new Set();
    this.clearError();
    this.persistSongSections(sections);
  }

  duplicateSongSection() {
    const section = this.selectedSongSection();
    if (!section) return;
    const range = this.songSectionLocalRange(section);
    const duration = range.end - range.start;
    let start = range.end;
    let end = start + duration;
    const markers = this.editingSnapFrames(0, this.sequenceFrameCount());
    if (markers.length) {
      const sectionStartIndex = this.nearestBeatIndex(range.start, markers);
      const sectionEndIndex = this.nearestBeatIndex(range.end, markers);
      const gridSpan = sectionStartIndex >= 0 && sectionEndIndex > sectionStartIndex
        ? sectionEndIndex - sectionStartIndex
        : DEFAULT_CLIP_GRID_INTERVALS;
      const startIndex = markers.findIndex(marker => marker >= range.end);
      if (startIndex < 0 || startIndex + gridSpan >= markers.length) {
        this.showError("There is not enough empty space after this Song Map section to duplicate it.");
        return;
      }
      start = markers[startIndex];
      end = markers[startIndex + gridSpan];
    }
    if (!this.songRangeAvailable(start, end)) {
      this.showError("There is not enough empty space after this Song Map section to duplicate it.");
      return;
    }
    const id = nextSongMapSectionId(this.songMapOverrides, this.sourceAnalysis?.songMap);
    const sections = this.editableSongSections();
    sections.push({
      ...section,
      id,
      start: this.sourceTimeAtLocalFrame(start),
      end: this.sourceTimeAtLocalFrame(end),
      role: { ...section.role, source: "manual", confidence: 1 },
    });
    sections.sort((left, right) => left.start - right.start);
    this.selectedSongSectionId = id;
    this.selectedSongSectionIds = new Set([id]);
    this.songSelectionAnchorId = id;
    this.clearError();
    this.persistSongSections(sections);
  }

  copySongSection() {
    const section = this.selectedSongSection();
    if (!section) return;
    const range = this.songSectionLocalRange(section);
    const markers = this.editingSnapFrames(0, this.sequenceFrameCount());
    const startIndex = this.nearestBeatIndex(range.start, markers);
    const endIndex = this.nearestBeatIndex(range.end, markers);
    this.clipboardSongSection = {
      section: { ...section, role: { ...section.role } },
      duration: range.end - range.start,
      gridSpan: startIndex >= 0 && endIndex > startIndex
        ? endIndex - startIndex
        : DEFAULT_CLIP_GRID_INTERVALS,
    };
    this.clearError();
  }

  pasteSongSection() {
    if (!this.clipboardSongSection) {
      this.showError("Copy a Song Map section before pasting.");
      return;
    }
    let start = this.snapFrame(this.playheadFrame ?? 0, 0, this.sequenceFrameCount());
    const markers = this.editingSnapFrames(0, this.sequenceFrameCount());
    let end = start + this.clipboardSongSection.duration;
    if (markers.length) {
      const startIndex = this.nearestBeatIndex(start, markers);
      start = markers[startIndex];
      end = markers[Math.min(markers.length - 1, startIndex + this.clipboardSongSection.gridSpan)];
    }
    if (!this.songRangeAvailable(start, end)) {
      this.showError("Place the playhead in an empty Song Map range before pasting.");
      return;
    }
    const id = nextSongMapSectionId(this.songMapOverrides, this.sourceAnalysis?.songMap);
    const source = this.clipboardSongSection.section;
    const sections = this.editableSongSections();
    sections.push({
      id,
      start: this.sourceTimeAtLocalFrame(start),
      end: this.sourceTimeAtLocalFrame(end),
      family: source.family,
      role: { ...source.role, source: "manual", confidence: 1 },
    });
    sections.sort((left, right) => left.start - right.start);
    this.selectedSongSectionId = id;
    this.selectedSongSectionIds = new Set([id]);
    this.songSelectionAnchorId = id;
    this.playheadFrame = end;
    this.clearError();
    this.persistSongSections(sections);
    this.updateTransportTime();
  }

  songMapRawText() {
    return JSON.stringify({
      version: 1,
      sections: this.editableSongSections().map(section => {
        const range = this.songSectionLocalRange(section);
        return {
          id: section.id,
          start_frame: range.start,
          end_frame: range.end,
          family: section.family,
          role: section.role.value,
          custom_label: section.role.customLabel || "",
        };
      }),
    }, null, 2);
  }

  applySongMapRaw() {
    try {
      const parsed = JSON.parse(this.rawText.value);
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sections)) {
        throw new Error("Raw Song Map data needs version 1 and a sections array.");
      }
      const sections = parsed.sections.map((section, index) => {
        const startFrame = Number(section.start_frame);
        const endFrame = Number(section.end_frame);
        if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame)) {
          throw new Error(`Song Map section ${index + 1} needs integer start_frame and end_frame values.`);
        }
        return {
          id: String(section.id || `manual-${index + 1}`).trim().slice(0, 80),
          start: this.sourceTimeAtLocalFrame(startFrame),
          end: this.sourceTimeAtLocalFrame(endFrame),
          family: String(section.family || `M${index + 1}`).trim().slice(0, 16),
          role: {
            value: section.role,
            customLabel: String(section.custom_label || "").trim().slice(0, 48),
            source: "manual",
            confidence: 1,
          },
        };
      });
      validateSongMapSections(sections, this.sourceAnalysis?.songMap?.duration);
      this.selectedSongSectionId = sections[0]?.id || null;
      this.selectedSongSectionIds = this.selectedSongSectionId
        ? new Set([this.selectedSongSectionId])
        : new Set();
      this.songMapOverrides = { ...this.songMapOverrides, roles: {} };
      this.clearError();
      this.persistSongSections(sections);
      this.toggleRaw(false);
    } catch (error) {
      this.showError(error.message);
    }
  }

  toggleRaw(force) {
    const open = typeof force === "boolean" ? force : !this.rawPanel.classList.contains("open");
    if (open) {
      this.rawLane = this.activeLane;
      if (this.rawLane === "song-map") {
        this.rawLabel.textContent = "Advanced Song Map structure in local integer frames. Sections need unique IDs and cannot overlap.";
        this.rawText.value = this.songMapRawText();
        this.root.querySelector('[data-action="raw-apply"]').textContent = "Apply sections";
      } else {
        this.rawLabel.textContent = "Advanced frame schedule. All positions, fades, and crossfades must be integer frames.";
        this.rawText.value = this.widgets.timeline?.value || "";
        this.root.querySelector('[data-action="raw-apply"]').textContent = "Apply frames";
      }
    }
    this.rawPanel.classList.toggle("open", open);
  }

  applyRaw() {
    if (this.rawLane === "song-map") {
      this.applySongMapRaw();
      return;
    }
    try {
      const clearedRenderGroups = this.clips.some((clip) => clip.renderGroup != null);
      const clips = validateFrameClips(parseTimeline(
        this.rawText.value,
        Math.round(this.defaultFadeIn()),
        Math.round(this.defaultFadeOut()),
      ));
      this.widgets.timeUnit.value = "frames";
      this.clips = clips;
      this.select(clips.length ? 0 : -1);
      this.migrationPending = false;
      this.rawInvalid = false;
      this.clearError();
      this.serialize();
      if (clearedRenderGroups) {
        this.statusEl.className = "flbps-status cached";
        this.statusEl.textContent = "Raw schedule applied · render groups cleared";
      }
      this.toggleRaw(false);
      this.setEditorEnabled(true);
      this.zoomToFit();
      this.syncInspector();
    } catch (error) {
      this.rawInvalid = true;
      this.showError(error.message);
    }
  }

  serialize() {
    if (this.rawInvalid || this.migrationPending || !this.widgets.timeline) return;
    normalizeRenderGroups(this.clips);
    this.widgets.timeline.value = serializeTimeline(this.clips);
    if (this.widgets.renderGroups) {
      this.widgets.renderGroups.value = serializeRenderGroups(this.clips);
    }
    this.rawText.value = this.widgets.timeline.value;
    this.markDirty();
  }

  beatFrames() {
    if (this.sourceAnalysis) {
      return this.gridBeatTimes().map((seconds) => Math.round(seconds * this.fps()));
    }
    return (this.beatData?.beatTimes || []).map((seconds) => Math.round(seconds * this.fps()));
  }

  downbeatFrames() {
    if (this.sourceAnalysis) {
      return this.gridDownbeatTimes().map((seconds) => Math.round(seconds * this.fps()));
    }
    return (this.beatData?.downbeatTimes || []).map((seconds) => Math.round(seconds * this.fps()));
  }

  detectedBeatFrames() {
    const sourceValues = this.sourceBeatValues();
    if (sourceValues) {
      const crop = this.cropBounds();
      return sourceValues.detectedBeats
        .filter((seconds) => seconds >= crop.start && seconds < crop.end)
        .map((seconds) => sourceTimeToLocalFrame(seconds, crop.start, this.fps()));
    }
    return (this.beatData?.detectedBeatTimes || []).map((seconds) => Math.round(seconds * this.fps()));
  }

  detectedBeatMarkers() {
    const sourceValues = this.sourceBeatValues();
    const crop = sourceValues ? this.cropBounds() : null;
    const [times, confidences] = sourceValues
      ? cropTimesWithValues(
        sourceValues.detectedBeats,
        sourceValues.beatConfidences,
        crop.start,
        crop.end,
      )
      : [
        this.beatData?.detectedBeatTimes || [],
        this.beatData?.detectedBeatConfidences || [],
      ];
    const intervals = times.slice(1).map((value, index) => value - times[index]).filter((value) => value > EPSILON);
    const sorted = [...intervals].sort((left, right) => left - right);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    return times.map((seconds, index) => {
      const interval = index > 0 ? seconds - times[index - 1] : median;
      return {
        frame: Math.round(seconds * this.fps()),
        confidence: clamp(finiteNumber(confidences[index], 1), 0, 1),
        outlier: median > 0 && Math.abs(interval - median) / median > 0.25,
      };
    });
  }

  detectedDownbeatMarkers() {
    const sourceValues = this.sourceBeatValues();
    const crop = sourceValues ? this.cropBounds() : null;
    const [times, confidences] = sourceValues
      ? cropTimesWithValues(
        sourceValues.detectedDownbeats,
        sourceValues.downbeatConfidences,
        crop.start,
        crop.end,
      )
      : [
        this.beatData?.detectedDownbeatTimes || [],
        this.beatData?.detectedDownbeatConfidences || [],
      ];
    return times.map((seconds, index) => ({
      frame: Math.round(seconds * this.fps()),
      confidence: clamp(finiteNumber(confidences[index], 1), 0, 1),
      outlier: false,
    }));
  }

  onsetFrames() {
    if (this.sourceAnalysis) {
      const crop = this.cropBounds();
      return this.sourceAnalysis.onsetTimes
        .filter((seconds) => seconds >= crop.start && seconds < crop.end)
        .map((seconds) => sourceTimeToLocalFrame(seconds, crop.start, this.fps()));
    }
    return (this.beatData?.onsetTimes || []).map((seconds) => Math.round(seconds * this.fps()));
  }

  sequenceFrameCount() {
    const configured = this.configuredFrameCount();
    if (configured > 0) return configured;
    if (this.beatData?.audioDuration > 0) return Math.max(1, Math.round(this.beatData.audioDuration * this.fps()));
    const last = this.clips[this.clips.length - 1];
    return Math.max(1, last?.end || Math.round(this.fps() * 8));
  }

  maximumFrame() {
    const configured = this.configuredFrameCount();
    if (configured > 0) return configured;
    if (this.beatData?.audioDuration > 0) return Math.max(1, Math.round(this.beatData.audioDuration * this.fps()));
    return Infinity;
  }

  nearestBeatIndex(value, markers = this.beatFrames()) {
    if (!markers.length) return -1;
    let nearest = 0;
    for (let index = 1; index < markers.length; index++) {
      if (Math.abs(markers[index] - value) < Math.abs(markers[nearest] - value)) nearest = index;
    }
    return nearest;
  }

  editingSnapFrames(minimum = 0, maximum = this.sequenceFrameCount()) {
    const markers = this.beatFrames()
      .filter((marker) => marker >= minimum && marker <= maximum);
    if (!markers.length) return [];
    markers.push(Math.round(minimum));
    if (Number.isFinite(maximum)) markers.push(Math.round(maximum));
    return [...new Set(markers)].sort((left, right) => left - right);
  }

  snapFrame(value, minimum = 0, maximum = Infinity) {
    const frame = clamp(Math.round(value), minimum, maximum);
    const markers = this.editingSnapFrames(minimum, maximum);
    if (!markers.length) return frame;
    let nearest = markers[0];
    for (let index = 1; index < markers.length; index++) {
      if (Math.abs(markers[index] - frame) < Math.abs(nearest - frame)) nearest = markers[index];
    }
    return nearest;
  }

  orderedSnapTargets(values, markers) {
    if (!values.length) return [];
    if (markers.length < values.length) return null;

    const previousMarkers = Array.from(
      { length: values.length },
      () => Array(markers.length).fill(-1),
    );
    let costs = markers.map((marker, index) => (
      index <= markers.length - values.length
        ? Math.abs(marker - values[0])
        : Infinity
    ));

    for (let valueIndex = 1; valueIndex < values.length; valueIndex++) {
      const nextCosts = Array(markers.length).fill(Infinity);
      const maximumMarker = markers.length - values.length + valueIndex;
      let bestCost = Infinity;
      let bestMarker = -1;
      for (let markerIndex = 0; markerIndex < markers.length; markerIndex++) {
        const previousIndex = markerIndex - 1;
        if (previousIndex >= 0 && costs[previousIndex] < bestCost) {
          bestCost = costs[previousIndex];
          bestMarker = previousIndex;
        }
        if (markerIndex < valueIndex || markerIndex > maximumMarker || bestMarker < 0) continue;
        nextCosts[markerIndex] = bestCost + Math.abs(markers[markerIndex] - values[valueIndex]);
        previousMarkers[valueIndex][markerIndex] = bestMarker;
      }
      costs = nextCosts;
    }

    let markerIndex = -1;
    let bestCost = Infinity;
    for (let index = values.length - 1; index < markers.length; index++) {
      if (costs[index] < bestCost) {
        bestCost = costs[index];
        markerIndex = index;
      }
    }
    if (markerIndex < 0) return null;

    const targets = Array(values.length);
    for (let valueIndex = values.length - 1; valueIndex >= 0; valueIndex--) {
      targets[valueIndex] = markers[markerIndex];
      markerIndex = previousMarkers[valueIndex][markerIndex];
    }
    return targets;
  }

  resnapClipsToGrid(markers = null) {
    if (this.drag) {
      this.resnapPending = true;
      return false;
    }
    this.resnapPending = false;
    if (this.rawInvalid || this.migrationPending || !this.clips.length) return false;

    const snapMarkers = markers || this.editingSnapFrames(0, this.sequenceFrameCount());
    if (!snapMarkers.length) return false;

    const values = [];
    const startBoundaries = [];
    const endBoundaries = [];
    for (let index = 0; index < this.clips.length; index++) {
      const clip = this.clips[index];
      const previous = this.clips[index - 1];
      if (previous && previous.end === clip.start) {
        startBoundaries.push(endBoundaries[index - 1]);
      } else {
        startBoundaries.push(values.length);
        values.push(clip.start);
      }
      endBoundaries.push(values.length);
      values.push(clip.end);
    }

    const targets = this.orderedSnapTargets(values, snapMarkers);
    if (!targets) return false;
    const before = this.clips.map((clip) => (
      [clip.start, clip.end, clip.fadeIn, clip.fadeOut, clip.crossfade]
    ));

    for (let index = 0; index < this.clips.length; index++) {
      const clip = this.clips[index];
      clip.start = targets[startBoundaries[index]];
      clip.end = targets[endBoundaries[index]];
      const duration = clip.end - clip.start;
      clip.fadeIn = clamp(Math.round(finiteNumber(clip.fadeIn)), 0, duration);
      clip.fadeOut = clamp(
        Math.round(finiteNumber(clip.fadeOut)),
        0,
        Math.max(0, duration - clip.fadeIn),
      );
    }
    normalizeCrossfades(this.clips);

    const changed = this.clips.some((clip, index) => (
      clip.start !== before[index][0] ||
      clip.end !== before[index][1] ||
      clip.fadeIn !== before[index][2] ||
      clip.fadeOut !== before[index][3] ||
      clip.crossfade !== before[index][4]
    ));
    if (!changed) return false;

    this.serialize();
    this.syncInspector();
    this.scheduleDraw();
    return true;
  }

  resnapSongMapToGrid(markers = null) {
    if (this.drag || !this.songMapOverrides.sections?.length) return false;
    const entries = this.songSectionEntries();
    const maximum = this.sequenceFrameCount();
    if (!entries.length || entries.some(entry => entry.start < 0 || entry.end > maximum)) return false;
    const snapMarkers = markers || this.editingSnapFrames(0, maximum);
    if (!snapMarkers.length) return false;

    const values = [];
    const startBoundaries = [];
    const endBoundaries = [];
    for (let index = 0; index < entries.length; index++) {
      if (index && entries[index - 1].end === entries[index].start) {
        startBoundaries.push(endBoundaries[index - 1]);
      } else {
        startBoundaries.push(values.length);
        values.push(entries[index].start);
      }
      endBoundaries.push(values.length);
      values.push(entries[index].end);
    }
    const targets = this.orderedSnapTargets(values, snapMarkers);
    if (!targets) return false;
    const sections = this.editableSongSections();
    let changed = false;
    for (let index = 0; index < sections.length; index++) {
      const start = targets[startBoundaries[index]];
      const end = targets[endBoundaries[index]];
      changed ||= start !== entries[index].start || end !== entries[index].end;
      sections[index].start = this.sourceTimeAtLocalFrame(start);
      sections[index].end = this.sourceTimeAtLocalFrame(end);
    }
    if (!changed) return false;
    this.persistSongSections(sections);
    return true;
  }

  defaultClipLength() {
    return Math.max(1, Math.round(this.fps() * 2));
  }

  crossfadeBounds(index) {
    const clip = this.clips[index];
    if (!clip) return null;
    const frames = Math.max(0, Math.round(finiteNumber(clip.crossfade)));
    const before = Math.floor(frames / 2);
    return {
      start: clip.start - before,
      end: clip.start + frames - before,
      boundary: clip.start,
      frames,
    };
  }

  maximumCrossfade(index) {
    const clip = this.clips[index];
    const previous = this.clips[index - 1];
    if (!clip || !previous || previous.end !== clip.start) return 0;
    return Math.max(
      0,
      Math.min(previous.end - previous.start, clip.end - clip.start),
    );
  }

  defaultCrossfade(index) {
    const maximum = this.maximumCrossfade(index);
    if (!maximum) return 0;
    const beatFrames = Math.round(this.baseGridIntervalSeconds() * this.fps());
    return Math.min(maximum, Math.max(1, beatFrames || Math.round(this.fps() * 0.5)));
  }

  toggleCrossfade(index) {
    const clip = this.clips[index];
    const previous = this.clips[index - 1];
    if (!clip || !previous || previous.end !== clip.start) return;
    clip.crossfade = clip.crossfade > 0 ? 0 : this.defaultCrossfade(index);
    if (clip.crossfade > 0) {
      previous.fadeOut = 0;
      clip.fadeIn = 0;
    }
    this.select(index);
    this.clearError();
    this.serialize();
    this.syncInspector();
    this.scheduleDraw();
  }

  gridClipRangeAt(frame) {
    const markers = this.editingSnapFrames(0, this.sequenceFrameCount());
    const intervalFrames = this.gridIntervalSeconds() * this.fps();
    if (!markers.length || !(intervalFrames > EPSILON)) return undefined;
    const maximum = this.maximumFrame();
    const candidates = [];
    for (let index = 0; index < markers.length; index++) {
      const start = markers[index];
      const end = index + DEFAULT_CLIP_GRID_INTERVALS < markers.length
        ? markers[index + DEFAULT_CLIP_GRID_INTERVALS]
        : Math.round(start + intervalFrames * DEFAULT_CLIP_GRID_INTERVALS);
      if (end > start && (!Number.isFinite(maximum) || end <= maximum)) {
        candidates.push({ start, end });
      }
    }
    if (!candidates.length) return null;
    let nearest = candidates[0];
    for (let index = 1; index < candidates.length; index++) {
      if (Math.abs(candidates[index].start - frame) < Math.abs(nearest.start - frame)) {
        nearest = candidates[index];
      }
    }
    return nearest;
  }

  addClip(startOverride = null, endOverride = null) {
    if (this.migrationPending) return;
    const previousEnd = this.clips.length ? this.clips[this.clips.length - 1].end : 0;
    const exactRange = endOverride != null;
    const start = startOverride == null
      ? previousEnd
      : exactRange
      ? Math.max(0, Math.round(startOverride))
      : this.snapFrame(startOverride);
    let end = exactRange ? Math.round(endOverride) : start + this.defaultClipLength();
    if (!(end > start)) {
      this.showError("The new prompt must end after it starts.");
      return;
    }
    const maximum = this.maximumFrame();
    if (Number.isFinite(maximum)) {
      if (start >= maximum) {
        this.showError("There is no room for another prompt inside the configured frame length.");
        return;
      }
      if (exactRange && end > maximum) {
        this.showError("There is not enough room for a four-grid prompt inside the configured frame length.");
        return;
      }
      if (!exactRange) end = Math.min(end, maximum);
    }
    const duration = end - start;
    const fadeIn = Math.min(Math.round(this.defaultFadeIn()), duration);
    const fadeOut = Math.min(Math.round(this.defaultFadeOut()), duration - fadeIn);
    const clip = {
      start,
      end,
      fadeIn,
      fadeOut,
      crossfade: 0,
      renderGroup: null,
      prompt: "Describe this prompt section.",
    };
    let index = this.clips.findIndex((item) => item.start > start);
    if (index < 0) index = this.clips.length;
    const previous = this.clips[index - 1];
    const next = this.clips[index];
    if ((previous && start < previous.end) || (next && end > next.start)) {
      this.showError("The new prompt would overlap an existing clip.");
      return;
    }
    this.clips.splice(index, 0, clip);
    this.rawInvalid = false;
    this.clearError();
    this.select(index);
    this.serialize();
    this.scheduleDraw();
  }

  addClipAtPointer(event) {
    if (this.migrationPending) return;
    const { y } = this.eventPosition(event);
    const layout = this.timelineLayout();
    if (y < layout.trackTop || y > layout.trackBottom) return;
    const frame = this.frameAtEvent(event);
    const range = this.gridClipRangeAt(frame);
    if (range === null) {
      this.showError("There is not enough room for a four-grid prompt inside the configured frame length.");
      return;
    }
    if (range) this.addClip(range.start, range.end);
    else this.addClip(frame);
  }

  onDoubleClick(event) {
    const { x, y } = this.eventPosition(event);
    const layout = this.timelineLayout();
    if (layout.lyricsTop != null && y >= layout.lyricsTop && y <= layout.lyricsBottom) {
      const hit = this.lyricsHitTest(x, y);
      this.playheadFrame = Math.round(clamp(this.frameAtX(x), 0, this.sequenceFrameCount()));
      if (hit) {
        this.selectLyricsSegment(hit.segment.id);
        this.lyricsFields.text.focus();
      } else {
        this.runEdit("Add lyric", () => this.addLyricsSegment(this.playheadFrame));
      }
      this.updateTransportTime();
      event.preventDefault();
      return;
    }
    if (layout.songMapTop != null && y >= layout.songMapTop && y <= layout.songMapBottom) {
      const labelHit = this.songMapLabelHitTest(x, y);
      const hit = this.songMapHitTest(x, y);
      this.playheadFrame = this.snapFrame(this.frameAtX(x), 0, this.sequenceFrameCount());
      if (labelHit) this.beginSongLabelEdit(labelHit.section);
      else if (hit) this.selectSongSection(hit.section.id);
      else {
        const range = this.gridClipRangeAt(this.playheadFrame);
        this.runEdit("Add Song Map section", () => {
          if (range) this.addSongSection(range.start, range.end);
          else this.addSongSection(this.playheadFrame);
        });
      }
      this.updateTransportTime();
      event.preventDefault();
      return;
    }
    const transition = this.crossfadeRects.find((rect) => (
      y >= rect.y &&
      y <= rect.y + rect.height &&
      Math.abs(x - rect.boundaryX) <= 10
    ));
    if (transition) {
      this.runEdit("Toggle prompt crossfade", () => this.toggleCrossfade(transition.index));
      event.preventDefault();
      return;
    }
    const hit = this.hitTest(x, y);
    if (hit?.type.startsWith("crossfade")) {
      this.runEdit("Toggle prompt crossfade", () => this.toggleCrossfade(hit.index));
      event.preventDefault();
      return;
    }
    this.runEdit("Add prompt", () => this.addClipAtPointer(event));
  }

  closeContextMenu() {
    this.contextMenu?.remove();
    this.contextMenu = null;
  }

  cropPromptRange(start, end) {
    const cropped = [];
    let selectedIndex = -1;
    const selectedIndices = new Set();
    for (let index = 0; index < this.clips.length; index++) {
      const clip = this.clips[index];
      const visibleStart = Math.max(start, clip.start);
      const visibleEnd = Math.min(end, clip.end);
      if (visibleEnd <= visibleStart) continue;
      const fadeInEnd = clamp(clip.start + clip.fadeIn, visibleStart, visibleEnd);
      const fadeOutStart = clamp(clip.end - clip.fadeOut, visibleStart, visibleEnd);
      if (index === this.selectedIndex) selectedIndex = cropped.length;
      if (this.selectedIndices.has(index)) selectedIndices.add(cropped.length);
      cropped.push({
        ...clip,
        start: visibleStart - start,
        end: visibleEnd - start,
        fadeIn: fadeInEnd - visibleStart,
        fadeOut: visibleEnd - fadeOutStart,
      });
    }
    this.clips = normalizeCrossfades(cropped);
    this.selectedIndex = selectedIndex;
    this.selectedIndices = selectedIndices;
    if (this.selectedIndex < 0 && this.selectedIndices.size) {
      this.selectedIndex = [...this.selectedIndices][0];
    }
    this.selectionAnchor = this.selectedIndex;
  }

  applyAudioCrop(start, end) {
    const duration = this.sequenceFrameCount();
    const cropStart = clamp(Math.round(start), 0, duration - 1);
    const cropEnd = clamp(Math.round(end), cropStart + 1, duration);
    if (cropStart === 0 && cropEnd === duration) return;
    const croppedMarkers = this.editingSnapFrames(cropStart, cropEnd)
      .map((marker) => marker - cropStart);

    this.stopPlayback();
    this.cropPromptRange(cropStart, cropEnd);
    this.widgets.trimStartFrame.value = this.trimStartFrame() + cropStart;
    this.widgets.sequenceDuration.value = cropEnd - cropStart;
    this.resnapClipsToGrid(croppedMarkers);
    this.playheadFrame = 0;
    this.refreshBrowserCrop();
    this.serialize();
    this.syncInspector();
    this.zoomToFit(false);
    this.markDirty();
  }

  setAudioIn(frame) {
    const duration = this.sequenceFrameCount();
    if (frame <= 0 || frame >= duration) return;
    this.applyAudioCrop(frame, duration);
  }

  setAudioOut(frame) {
    const duration = this.sequenceFrameCount();
    if (frame <= 0 || frame >= duration) return;
    this.applyAudioCrop(0, frame);
  }

  groupSelectionError() {
    const indices = this.selectedClipIndices();
    if (indices.length < 2) return "Select at least two prompt blocks.";
    for (let position = 1; position < indices.length; position++) {
      const previousIndex = indices[position - 1];
      const index = indices[position];
      if (index !== previousIndex + 1) {
        return "Select one consecutive run of prompt blocks.";
      }
      if (this.clips[previousIndex].end !== this.clips[index].start) {
        return "Grouped renders require touching prompt blocks.";
      }
    }
    return null;
  }

  groupSelected() {
    const error = this.groupSelectionError();
    if (error) {
      this.showError(error);
      return;
    }
    const nextGroup = this.clips.reduce(
      (maximum, clip) => Math.max(maximum, finiteNumber(clip.renderGroup, 0)),
      0,
    ) + 1;
    for (const index of this.selectedClipIndices()) {
      this.clips[index].renderGroup = nextGroup;
    }
    normalizeRenderGroups(this.clips);
    this.clearError();
    this.serialize();
    this.syncInspector();
    this.scheduleDraw();
  }

  ungroupSelected() {
    const groups = new Set(
      this.selectedClipIndices()
        .map((index) => this.clips[index]?.renderGroup)
        .filter((group) => group != null),
    );
    if (!groups.size) return;
    for (const clip of this.clips) {
      if (groups.has(clip.renderGroup)) clip.renderGroup = null;
    }
    normalizeRenderGroups(this.clips);
    this.clearError();
    this.serialize();
    this.syncInspector();
    this.scheduleDraw();
  }

  selectRenderGroup(index) {
    const group = this.clips[index]?.renderGroup;
    if (group == null) return;
    this.selectedIndices = new Set();
    this.clips.forEach((clip, clipIndex) => {
      if (clip.renderGroup === group) this.selectedIndices.add(clipIndex);
    });
    this.selectedIndex = index;
    this.selectionAnchor = index;
    this.syncInspector();
    this.scheduleDraw();
  }

  openContextMenu(menu, event) {
    document.body.appendChild(menu);
    this.contextMenu = menu;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${clamp(event.clientX, 6, window.innerWidth - rect.width - 6)}px`;
    menu.style.top = `${clamp(event.clientY, 6, window.innerHeight - rect.height - 6)}px`;
  }

  setSongMapRole(section, role, customLabel = "") {
    this.songMapOverrides = updateSongMapOverride(
      this.songMapOverrides,
      this.sourceAnalysis?.songMap,
      section.id,
      role,
      customLabel,
    );
    this.saveViewState();
    this.syncInspector();
    this.scheduleDraw();
  }

  openSongMapContextMenu(section, event) {
    const menu = document.createElement("div");
    menu.className = "flbps-context-menu";
    menu.addEventListener("contextmenu", (menuEvent) => menuEvent.preventDefault());
    const title = document.createElement("div");
    title.className = "flbps-context-title";
    title.textContent = songSectionLabel(section);
    menu.appendChild(title);
    for (const [label, action, historyLabel] of [
      ["Split at playhead", () => this.splitSongSection(), "Split Song Map section"],
      ["Duplicate section", () => this.duplicateSongSection(), "Duplicate Song Map section"],
      ["Copy section", () => this.copySongSection(), ""],
      ["Delete section", () => this.deleteSongSection(), "Delete Song Map section"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        this.closeContextMenu();
        if (historyLabel) this.runEdit(historyLabel, action);
        else action();
      });
      menu.appendChild(button);
    }
    const roles = [
      ["auto", "Auto label"],
      ["intro", "Intro"],
      ["verse", "Verse"],
      ["pre_chorus", "Pre-Chorus"],
      ["chorus", "Chorus"],
      ["bridge", "Bridge"],
      ["instrumental", "Instrumental"],
      ["breakdown", "Breakdown"],
      ["outro", "Outro"],
    ];
    for (const [value, label] of roles) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        this.closeContextMenu();
        this.runEdit("Change Song Map label", () => this.setSongMapRole(section, value));
      });
      menu.appendChild(button);
    }
    const resetAll = document.createElement("button");
    resetAll.type = "button";
    resetAll.textContent = "Reset all manual labels";
    resetAll.disabled = !Object.keys(this.songMapOverrides.roles).length && !this.songMapOverrides.sections;
    resetAll.addEventListener("click", () => {
      this.closeContextMenu();
      this.runEdit("Reset Song Map labels", () => this.resetSongLabels());
    });
    menu.appendChild(resetAll);
    this.openContextMenu(menu, event);
  }

  onContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    if (this.migrationPending || this.rawInvalid) return;
    const { x, y } = this.eventPosition(event);
    const layout = this.timelineLayout();
    if (y < layout.rulerTop || y > layout.trackBottom ||
        x < TIMELINE_LEFT || x > this.canvas.clientWidth - TIMELINE_RIGHT) {
      return;
    }
    this.closeContextMenu();

    const songMapHit = this.songMapHitTest(x, y);
    if (songMapHit) {
      this.playheadFrame = this.snapFrame(this.frameAtX(x), 0, this.sequenceFrameCount());
      if (!this.selectedSongSectionIds.has(songMapHit.section.id)) {
        this.selectSongSection(songMapHit.section.id);
      } else {
        this.activateLane("song-map");
      }
      this.updateTransportTime();
      this.openSongMapContextMenu(songMapHit.section, event);
      return;
    }
    if (layout.songMapTop != null && y >= layout.songMapTop && y <= layout.songMapBottom) {
      this.activateLane("song-map");
      this.playheadFrame = this.snapFrame(this.frameAtX(x), 0, this.sequenceFrameCount());
      this.updateTransportTime();
      const menu = document.createElement("div");
      menu.className = "flbps-context-menu";
      menu.innerHTML = `<div class="flbps-context-title">Empty Song Map range</div><button data-action="add-song">Add section here</button><button data-action="paste-song">Paste section here</button>`;
      menu.querySelector('[data-action="add-song"]').addEventListener("click", () => {
        this.closeContextMenu();
        this.runEdit("Add Song Map section", () => this.addSongSection());
      });
      menu.querySelector('[data-action="paste-song"]').addEventListener("click", () => {
        this.closeContextMenu();
        this.runEdit("Paste Song Map section", () => this.pasteSongSection());
      });
      this.openContextMenu(menu, event);
      return;
    }

    const hit = y >= layout.trackTop ? this.hitTest(x, y) : null;
    if (hit) {
      this.activateLane("prompt");
      if (!this.selectedIndices.has(hit.index)) this.select(hit.index);
      const indices = this.selectedClipIndices();
      const group = this.clips[hit.index]?.renderGroup;
      const hasGroupedSelection = indices.some(
        (index) => this.clips[index]?.renderGroup != null,
      );
      const menu = document.createElement("div");
      menu.className = "flbps-context-menu";
      menu.addEventListener("contextmenu", (menuEvent) => menuEvent.preventDefault());
      menu.innerHTML = `
        <div class="flbps-context-title">${indices.length} prompt${indices.length === 1 ? "" : "s"} selected</div>
        <button data-action="group-render"${indices.length < 2 ? " disabled" : ""}>Group selected as one render</button>
        <button data-action="select-render"${group == null ? " disabled" : ""}>Select entire render group</button>
        <button data-action="ungroup-render"${hasGroupedSelection ? "" : " disabled"}>Ungroup selected render${indices.length === 1 ? "" : "s"}</button>
      `;
      menu.querySelector('[data-action="group-render"]').addEventListener("click", () => {
        this.closeContextMenu();
        this.runEdit("Group prompt renders", () => this.groupSelected());
      });
      menu.querySelector('[data-action="select-render"]').addEventListener("click", () => {
        this.closeContextMenu();
        this.selectRenderGroup(hit.index);
      });
      menu.querySelector('[data-action="ungroup-render"]').addEventListener("click", () => {
        this.closeContextMenu();
        this.runEdit("Ungroup prompt renders", () => this.ungroupSelected());
      });
      this.openContextMenu(menu, event);
      return;
    }
    if (!this.widgets.audioFile?.value) return;

    const duration = this.sequenceFrameCount();
    const frame = this.snapFrame(this.frameAtX(x), 0, duration);
    this.playheadFrame = frame;
    if (this.audioElement) {
      this.audioElement.currentTime = this.cropStartSeconds() + frame / this.fps();
    }
    this.updateTransportTime();
    this.scheduleDraw();

    const menu = document.createElement("div");
    menu.className = "flbps-context-menu";
    menu.addEventListener("contextmenu", (menuEvent) => menuEvent.preventDefault());
    const sourceFrame = this.trimStartFrame() + frame;
    menu.innerHTML = `
      <div class="flbps-context-title">Beat position · F${frame} · ${formatClock(frame / this.fps())} · source F${sourceFrame}</div>
      <button data-action="set-in"${frame <= 0 || frame >= duration ? " disabled" : ""}>Set audio In here</button>
      <button data-action="set-out"${frame <= 0 || frame >= duration ? " disabled" : ""}>Set audio Out here</button>
    `;
    menu.querySelector('[data-action="set-in"]').addEventListener("click", () => {
      this.closeContextMenu();
      this.runEdit("Set audio in point", () => this.setAudioIn(frame));
    });
    menu.querySelector('[data-action="set-out"]').addEventListener("click", () => {
      this.closeContextMenu();
      this.runEdit("Set audio out point", () => this.setAudioOut(frame));
    });
    this.openContextMenu(menu, event);
  }

  deleteClip() {
    if (!this.selectedClip()) return;
    const next = this.clips[this.selectedIndex + 1];
    if (next) next.crossfade = 0;
    this.clips.splice(this.selectedIndex, 1);
    this.select(Math.min(this.selectedIndex, this.clips.length - 1));
    this.serialize();
  }

  duplicateClip() {
    const clip = this.selectedClip();
    if (!clip) return;
    const duration = clip.end - clip.start;
    let start = clip.end;
    let end = start + duration;
    const markers = this.editingSnapFrames(0, this.sequenceFrameCount());
    if (markers.length) {
      const clipStartIndex = this.nearestBeatIndex(clip.start, markers);
      const clipEndIndex = this.nearestBeatIndex(clip.end, markers);
      const gridSpan = clipStartIndex >= 0 && clipEndIndex > clipStartIndex
        ? clipEndIndex - clipStartIndex
        : DEFAULT_CLIP_GRID_INTERVALS;
      const startIndex = markers.findIndex((marker) => marker >= clip.end);
      if (startIndex < 0 || startIndex + gridSpan >= markers.length) {
        this.showError("There is not enough room after this prompt to duplicate it.");
        return;
      }
      start = markers[startIndex];
      end = markers[startIndex + gridSpan];
    }
    const next = this.clips[this.selectedIndex + 1];
    const maximum = this.maximumFrame();
    if ((next && end > next.start) || (Number.isFinite(maximum) && end > maximum)) {
      this.showError("There is not enough room after this prompt to duplicate it.");
      return;
    }
    const duplicateDuration = end - start;
    const fadeIn = Math.min(clip.fadeIn, duplicateDuration);
    const fadeOut = Math.min(clip.fadeOut, duplicateDuration - fadeIn);
    this.clips.splice(this.selectedIndex + 1, 0, {
      ...clip,
      start,
      end,
      fadeIn,
      fadeOut,
      crossfade: 0,
      renderGroup: null,
    });
    this.select(this.selectedIndex + 1);
    this.clearError();
    this.serialize();
  }

  copyClip() {
    const clip = this.selectedClip();
    if (!clip) return;
    const markers = this.editingSnapFrames(0, this.sequenceFrameCount());
    const startIndex = this.nearestBeatIndex(clip.start, markers);
    const endIndex = this.nearestBeatIndex(clip.end, markers);
    this.clipboardClip = {
      clip: { ...clip },
      duration: clip.end - clip.start,
      gridSpan: startIndex >= 0 && endIndex > startIndex
        ? endIndex - startIndex
        : DEFAULT_CLIP_GRID_INTERVALS,
    };
    this.clearError();
  }

  pasteClip() {
    if (!this.clipboardClip || this.migrationPending || this.rawInvalid) {
      if (!this.clipboardClip) this.showError("Copy a prompt before pasting.");
      return;
    }

    const maximum = this.maximumFrame();
    const frameLimit = Number.isFinite(maximum) ? maximum : Infinity;
    let start = this.snapFrame(
      this.playheadFrame ?? this.selectedClip()?.end ?? 0,
      0,
      frameLimit,
    );
    let insertionIndex = this.clips.findIndex((clip) => clip.start >= start);
    if (insertionIndex < 0) insertionIndex = this.clips.length;
    const previous = this.clips[insertionIndex - 1];
    const next = this.clips[insertionIndex];
    if ((previous && start < previous.end) || (next && start >= next.start)) {
      this.showError("Place the playhead in an empty grid space before pasting.");
      return;
    }

    const availableEnd = Math.min(next?.start ?? Infinity, frameLimit);
    const markers = this.editingSnapFrames(0, this.sequenceFrameCount());
    let end;
    if (markers.length) {
      const startIndex = this.nearestBeatIndex(start, markers);
      start = markers[startIndex];
      if ((previous && start < previous.end) || (next && start >= next.start)) {
        this.showError("Place the playhead in an empty grid space before pasting.");
        return;
      }
      let endIndex = Math.min(startIndex + this.clipboardClip.gridSpan, markers.length - 1);
      while (endIndex > startIndex && markers[endIndex] > availableEnd) endIndex--;
      if (endIndex <= startIndex) {
        this.showError("There is not enough empty grid space to paste this prompt.");
        return;
      }
      end = markers[endIndex];
    } else {
      end = Math.min(start + this.clipboardClip.duration, availableEnd);
      if (!(end > start)) {
        this.showError("There is not enough empty space to paste this prompt.");
        return;
      }
    }

    const duration = end - start;
    const source = this.clipboardClip.clip;
    const fadeIn = Math.min(source.fadeIn, duration);
    const fadeOut = Math.min(source.fadeOut, duration - fadeIn);
    this.clips.splice(insertionIndex, 0, {
      ...source,
      start,
      end,
      fadeIn,
      fadeOut,
      crossfade: 0,
      renderGroup: null,
    });
    this.playheadFrame = end;
    this.select(insertionIndex);
    this.clearError();
    this.serialize();
    this.updateTransportTime();
  }

  splitClip() {
    const clip = this.selectedClip();
    if (!clip) return;
    let split = this.playheadFrame == null ? Math.round((clip.start + clip.end) / 2) : this.playheadFrame;
    split = this.snapFrame(split);
    if (split <= clip.start || split >= clip.end) {
      this.showError("Place the playhead inside the selected prompt before splitting.");
      return;
    }
    const first = {
      ...clip,
      end: split,
      fadeIn: Math.min(clip.fadeIn, split - clip.start),
      fadeOut: 0,
    };
    const second = {
      ...clip,
      start: split,
      fadeIn: 0,
      fadeOut: Math.min(clip.fadeOut, clip.end - split),
      crossfade: 0,
    };
    this.clips.splice(this.selectedIndex, 1, first, second);
    this.select(this.selectedIndex + 1);
    this.clearError();
    this.serialize();
  }

  frameAtX(x) {
    const width = Math.max(1, this.canvas.clientWidth);
    const right = width - TIMELINE_RIGHT;
    const clampedX = clamp(x, TIMELINE_LEFT, right);
    const ratio = (clampedX - TIMELINE_LEFT) / Math.max(1, right - TIMELINE_LEFT);
    return this.viewStart + ratio * (this.viewEnd - this.viewStart);
  }

  frameAtEvent(event) {
    return this.frameAtX(this.eventPosition(event).x);
  }

  eventPosition(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (this.canvas.clientWidth / Math.max(1, rect.width)),
      y: (event.clientY - rect.top) * (this.canvas.clientHeight / Math.max(1, rect.height)),
    };
  }

  timelineLayout(height = this.canvas.clientHeight) {
    const sourceVisible = Boolean(this.sourceWaveformPreview);
    const songMapVisible = Boolean(this.songMap());
    const lyricsVisible = Boolean(this.widgets?.audioFile?.value || this.lyricsTimeline);
    const sourceTop = sourceVisible ? 4 : null;
    const sourceBottom = sourceVisible ? 38 : null;
    const rulerTop = sourceVisible ? 44 : 4;
    const rulerBottom = rulerTop + 30;
    const songMapTop = songMapVisible ? rulerBottom + 2 : null;
    const songMapBottom = songMapVisible ? songMapTop + 34 : null;
    const afterSongMap = songMapVisible ? songMapBottom + 3 : rulerBottom + 2;
    const lyricsTop = lyricsVisible ? afterSongMap : null;
    const lyricsHeight = this.lyricsTimeline?.segments.length && this.lyricsSettings?.laneExpanded !== false ? 52 : 27;
    const lyricsBottom = lyricsVisible ? lyricsTop + lyricsHeight : null;
    const waveformTop = lyricsVisible ? lyricsBottom + 3 : afterSongMap;
    const waveformBottom = waveformTop + 80;
    const trackTop = waveformBottom + 7;
    return {
      sourceTop,
      sourceBottom,
      rulerTop,
      rulerBottom,
      songMapTop,
      songMapBottom,
      lyricsTop,
      lyricsBottom,
      waveformTop,
      waveformBottom,
      trackTop,
      trackBottom: height - 8,
    };
  }

  lyricsHitTest(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (let index = this.lyricsRects.length - 1; index >= 0; index--) {
      const rect = this.lyricsRects[index];
      if (y < rect.y || y > rect.y + rect.height) continue;
      if (Number.isFinite(rect.startX) && Math.abs(x - rect.startX) <= 8) {
        return { ...rect, type: "start" };
      }
      if (Number.isFinite(rect.endX) && Math.abs(x - rect.endX) <= 8) {
        return { ...rect, type: "end" };
      }
      if (x >= rect.x && x <= rect.x + rect.width) return { ...rect, type: "move" };
    }
    return null;
  }

  sourceFrameAtX(x) {
    const right = Math.max(TIMELINE_LEFT + 1, this.canvas.clientWidth - TIMELINE_RIGHT);
    const ratio = (clamp(x, TIMELINE_LEFT, right) - TIMELINE_LEFT) / (right - TIMELINE_LEFT);
    return Math.round(ratio * this.sourceAudioDuration * this.fps());
  }

  trimHandlePositions(width = this.canvas.clientWidth) {
    const right = Math.max(TIMELINE_LEFT + 1, width - TIMELINE_RIGHT);
    const sourceFrames = Math.max(1, Math.round(this.sourceAudioDuration * this.fps()));
    const start = this.trimStartFrame();
    const end = Math.min(sourceFrames, start + this.configuredFrameCount());
    return {
      start,
      end,
      startX: TIMELINE_LEFT + start / sourceFrames * (right - TIMELINE_LEFT),
      endX: TIMELINE_LEFT + end / sourceFrames * (right - TIMELINE_LEFT),
      sourceFrames,
    };
  }

  hitTestTrim(x, y) {
    const layout = this.timelineLayout();
    if (!this.sourceWaveformPreview ||
        y < layout.sourceTop ||
        y > layout.sourceBottom) {
      return null;
    }
    const handles = this.trimHandlePositions();
    if (Math.abs(x - handles.startX) <= 10) return { type: "trim-start", handles };
    if (Math.abs(x - handles.endX) <= 10) return { type: "trim-end", handles };
    if (x > handles.startX && x < handles.endX) return { type: "trim-move", handles };
    return null;
  }

  updateTrimDrag(x) {
    const frame = this.sourceFrameAtX(x);
    const original = this.drag.original;
    if (this.drag.type === "trim-start") {
      const start = clamp(frame, 0, original.end - 1);
      this.widgets.trimStartFrame.value = start;
      this.widgets.sequenceDuration.value = original.end - start;
    } else if (this.drag.type === "trim-end") {
      const end = clamp(frame, original.start + 1, original.sourceFrames);
      this.widgets.sequenceDuration.value = end - original.start;
    } else {
      const duration = original.end - original.start;
      const delta = frame - this.drag.pointerStartFrame;
      this.widgets.trimStartFrame.value = clamp(
        original.start + delta,
        0,
        original.sourceFrames - duration,
      );
    }
    this.refreshBrowserCrop();
    this.markDirty();
  }

  onPointerDown(event) {
    this.root.focus({ preventScroll: true });
    const { x, y } = this.eventPosition(event);
    if (event.button === 1) {
      const duration = this.sequenceFrameCount();
      const range = this.viewEnd - this.viewStart;
      event.preventDefault();
      if (range >= duration - EPSILON) return;
      this.drag = {
        type: "timeline-pan",
        pointerStartX: x,
        pointerStartY: y,
        originalViewStart: this.viewStart,
        originalViewEnd: this.viewEnd,
        active: false,
      };
      this.canvas.setPointerCapture(event.pointerId);
      this.canvas.style.cursor = "grabbing";
      return;
    }
    if (event.button !== 0) return;
    const trimHit = this.hitTestTrim(x, y);
    if (trimHit) {
      this.beginEdit("Trim audio range");
      this.drag = {
        type: trimHit.type,
        pointerStartX: x,
        pointerStartY: y,
        original: {
          start: trimHit.handles.start,
          end: trimHit.handles.end,
          sourceFrames: trimHit.handles.sourceFrames,
        },
        pointerStartFrame: this.sourceFrameAtX(x),
        active: false,
      };
      this.canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    if (this.migrationPending || this.rawInvalid) return;
    const layout = this.timelineLayout();
    const lyricsHit = this.lyricsHitTest(x, y);
    if (lyricsHit) {
      this.selectLyricsSegment(lyricsHit.segment.id);
      if (lyricsHit.type === "move" && !lyricsHit.movable) {
        event.preventDefault();
        return;
      }
      this.beginEdit(lyricsHit.type === "move" ? "Move lyric" : "Resize lyric");
      this.drag = {
        type: `lyrics-${lyricsHit.type}`,
        pointerStartRaw: Math.round(this.frameAtX(x)),
        pointerStartX: x,
        pointerStartY: y,
        originalSegments: this.lyricsTimeline.segments.map(segment => ({ ...segment })),
        originalIndex: lyricsHit.index,
        active: false,
      };
      this.canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    if (layout.lyricsTop != null && y >= layout.lyricsTop && y <= layout.lyricsBottom) {
      this.activateLane("lyrics");
      this.playheadFrame = Math.round(clamp(this.frameAtX(x), 0, this.sequenceFrameCount()));
      this.updateTransportTime();
      this.scheduleDraw();
      event.preventDefault();
      return;
    }
    const songHit = this.songMapHitTest(x, y);
    if (songHit) {
      if (event.shiftKey) {
        this.selectSongRange(songHit.section.id);
        event.preventDefault();
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        this.toggleSongSelection(songHit.section.id);
        event.preventDefault();
        return;
      }
      this.selectSongSection(songHit.section.id);
      if (songHit.type === "move" && !songHit.movable) {
        event.preventDefault();
        return;
      }
      this.beginEdit(songHit.type === "move" ? "Move Song Map section" : "Resize Song Map section");
      const sections = this.editableSongSections();
      const index = sections.findIndex(section => section.id === songHit.section.id);
      const range = this.songSectionLocalRange(sections[index]);
      const markers = this.editingSnapFrames(0, this.sequenceFrameCount());
      const startIndex = this.nearestBeatIndex(range.start, markers);
      const endIndex = this.nearestBeatIndex(range.end, markers);
      this.drag = {
        type: `song-${songHit.type}`,
        pointerStartRaw: Math.round(this.frameAtX(x)),
        pointerStartX: x,
        pointerStartY: y,
        pointerX: x,
        pointerY: y,
        originalSections: sections,
        originalIndex: index,
        originalEdgeFrame: songHit.edgeFrame,
        gridSpan: startIndex >= 0 && endIndex > startIndex ? endIndex - startIndex : null,
        active: false,
      };
      this.canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    if (layout.songMapTop != null && y >= layout.songMapTop && y <= layout.songMapBottom) {
      this.activateLane("song-map");
      this.playheadFrame = this.snapFrame(this.frameAtX(x), 0, this.sequenceFrameCount());
      this.updateTransportTime();
      this.scheduleDraw();
      event.preventDefault();
      return;
    }
    const hit = this.hitTest(x, y);
    if (!hit) {
      if (y >= layout.trackTop && y <= layout.trackBottom) this.activateLane("prompt");
      this.playheadFrame = this.snapFrame(this.frameAtX(x), 0, this.sequenceFrameCount());
      if (this.audioElement) {
        this.audioElement.currentTime = this.cropStartSeconds() + this.playheadFrame / this.fps();
      }
      this.updateTransportTime();
      this.scheduleDraw();
      return;
    }

    if (event.shiftKey) {
      this.selectRange(hit.index);
      event.preventDefault();
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      this.toggleSelection(hit.index);
      event.preventDefault();
      return;
    }
    this.select(hit.index);
    this.beginEdit(hit.type === "move" ? "Move prompt" : "Edit prompt timing");
    const clip = this.selectedClip();
    const markers = this.editingSnapFrames(0, this.sequenceFrameCount());
    const startIndex = this.nearestBeatIndex(clip.start, markers);
    const endIndex = this.nearestBeatIndex(clip.end, markers);
    this.drag = {
      type: hit.type,
      pointerStartRaw: Math.max(0, Math.round(this.frameAtX(x))),
      pointerStartX: x,
      pointerStartY: y,
      pointerX: x,
      pointerY: y,
      gridSpan: startIndex >= 0 && endIndex >= 0 ? Math.max(1, endIndex - startIndex) : null,
      original: { ...clip },
      originalPrevious: hit.type === "shared-boundary"
        ? { ...this.clips[hit.index - 1] }
        : null,
      active: false,
    };
    this.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  panDuringDrag(x) {
    const width = Math.max(1, this.canvas.clientWidth);
    const range = this.viewEnd - this.viewStart;
    const margin = 28;
    let shift = 0;
    if (x < TIMELINE_LEFT + margin) shift = -Math.max(1, range * 0.025);
    if (x > width - TIMELINE_RIGHT - margin) shift = Math.max(1, range * 0.025);
    if (!shift) return;
    const duration = this.sequenceFrameCount();
    this.viewStart = clamp(this.viewStart + shift, 0, Math.max(0, duration - range));
    this.viewEnd = Math.min(duration, this.viewStart + range);
  }

  updateTimelinePan(x) {
    const right = Math.max(TIMELINE_LEFT + 1, this.canvas.clientWidth - TIMELINE_RIGHT);
    const pixels = right - TIMELINE_LEFT;
    const range = this.drag.originalViewEnd - this.drag.originalViewStart;
    const frameDelta = (x - this.drag.pointerStartX) / pixels * range;
    const duration = this.sequenceFrameCount();
    this.viewStart = clamp(
      this.drag.originalViewStart - frameDelta,
      0,
      Math.max(0, duration - range),
    );
    this.viewEnd = Math.min(duration, this.viewStart + range);
    this.viewStart = Math.max(0, this.viewEnd - range);
    this.scheduleDraw();
  }

  updateDrag(x) {
    const clip = this.selectedClip();
    if (!this.drag || !clip) return;
    this.panDuringDrag(x);
    const currentRaw = Math.max(0, Math.round(this.frameAtX(x)));
    const delta = currentRaw - this.drag.pointerStartRaw;
    const original = this.drag.original;
    const previous = this.clips[this.selectedIndex - 1];
    const next = this.clips[this.selectedIndex + 1];
    const maximum = this.maximumFrame();
    let guideFrame = null;

    if (this.drag.type === "shared-boundary") {
      const originalPrevious = this.drag.originalPrevious;
      const boundary = this.snapFrame(
        original.start + delta,
        originalPrevious.start + 1,
        original.end - 1,
      );
      previous.end = boundary;
      clip.start = boundary;

      const previousDuration = previous.end - previous.start;
      previous.fadeIn = Math.min(originalPrevious.fadeIn, previousDuration);
      previous.fadeOut = Math.min(
        originalPrevious.fadeOut,
        Math.max(0, previousDuration - previous.fadeIn),
      );
      const clipDuration = clip.end - clip.start;
      clip.fadeOut = Math.min(original.fadeOut, clipDuration);
      clip.fadeIn = Math.min(
        original.fadeIn,
        Math.max(0, clipDuration - clip.fadeOut),
      );
      clip.crossfade = Math.min(
        original.crossfade,
        previousDuration,
        clipDuration,
      );
      guideFrame = boundary;
    } else if (this.drag.type === "move") {
      const markers = this.editingSnapFrames(0, this.sequenceFrameCount());
      const span = this.drag.gridSpan;
      if (span && markers.length > span) {
        const proposedStart = original.start + delta;
        let nearest = null;
        for (let index = 0; index + span < markers.length; index++) {
          const start = markers[index];
          const end = markers[index + span];
          if ((previous && start < previous.end) ||
              (next && end > next.start) ||
              (Number.isFinite(maximum) && end > maximum)) {
            continue;
          }
          const distance = Math.abs(start - proposedStart);
          if (!nearest || distance < nearest.distance) nearest = { start, end, distance };
        }
        if (nearest) {
          clip.start = nearest.start;
          clip.end = nearest.end;
          guideFrame = nearest.start;
        }
      } else {
        const duration = original.end - original.start;
        let start = this.snapFrame(original.start + delta);
        if (previous) start = Math.max(start, previous.end);
        if (next) start = Math.min(start, next.start - duration);
        if (Number.isFinite(maximum)) start = Math.min(start, maximum - duration);
        clip.start = Math.round(start);
        clip.end = clip.start + duration;
        guideFrame = clip.start;
      }
    } else if (this.drag.type === "start") {
      const start = this.snapFrame(
        original.start + delta,
        previous?.end || 0,
        original.end - 1,
      );
      clip.start = Math.round(start);
      clip.fadeIn = Math.min(original.fadeIn, clip.end - clip.start - clip.fadeOut);
      guideFrame = clip.start;
    } else if (this.drag.type === "end") {
      const end = this.snapFrame(
        original.end + delta,
        original.start + 1,
        Math.min(next?.start ?? Infinity, maximum),
      );
      clip.end = Math.round(end);
      clip.fadeOut = Math.min(original.fadeOut, clip.end - clip.start - clip.fadeIn);
      guideFrame = clip.end;
    } else if (this.drag.type === "fade-in") {
      const current = this.snapFrame(currentRaw, clip.start, clip.end - clip.fadeOut);
      clip.fadeIn = clamp(current - clip.start, 0, clip.end - clip.start - clip.fadeOut);
      guideFrame = current;
    } else if (this.drag.type === "fade-out") {
      const current = this.snapFrame(currentRaw, clip.start + clip.fadeIn, clip.end);
      clip.fadeOut = clamp(clip.end - current, 0, clip.end - clip.start - clip.fadeIn);
      guideFrame = current;
    } else if (this.drag.type === "crossfade-start" ||
        this.drag.type === "crossfade-end" ||
        this.drag.type === "crossfade-create") {
      const boundary = original.start;
      const edge = this.snapFrame(
        currentRaw,
        previous?.start || 0,
        original.end,
      );
      const maximumCrossfade = Math.min(
        previous?.end - previous?.start || 0,
        original.end - original.start,
      );
      clip.crossfade = clamp(2 * Math.abs(edge - boundary), 0, maximumCrossfade);
      if (clip.crossfade > 0) {
        previous.fadeOut = 0;
        clip.fadeIn = 0;
      }
      const bounds = this.crossfadeBounds(this.selectedIndex);
      guideFrame = this.drag.type === "crossfade-start" ? bounds.start : bounds.end;
    }

    clip.fadeIn = Math.max(0, Math.round(clip.fadeIn));
    clip.fadeOut = Math.max(0, Math.round(clip.fadeOut));
    normalizeCrossfades(this.clips);
    this.snapGuideFrame = guideFrame;
    this.syncInspector();
    this.scheduleDraw();
  }

  updateSongDrag(x) {
    if (!this.drag?.type.startsWith("song-")) return;
    this.panDuringDrag(x);
    const sections = this.drag.originalSections.map(section => ({
      ...section,
      role: { ...section.role },
    }));
    const index = this.drag.originalIndex;
    const section = sections[index];
    const previous = sections[index - 1];
    const next = sections[index + 1];
    if (!section) return;
    const original = this.songSectionLocalRange(section);
    const previousRange = previous ? this.songSectionLocalRange(previous) : null;
    const nextRange = next ? this.songSectionLocalRange(next) : null;
    const delta = Math.round(this.frameAtX(x)) - this.drag.pointerStartRaw;
    const type = this.drag.type.slice(5);
    const originalEdge = Number.isFinite(this.drag.originalEdgeFrame)
      ? this.drag.originalEdgeFrame
      : type === "start" ? original.start : original.end;
    let guideFrame = null;

    if (type === "shared-boundary") {
      const boundary = this.snapFrame(
        original.start + delta,
        previousRange.start + 1,
        original.end - 1,
      );
      previous.end = this.sourceTimeAtLocalFrame(boundary);
      section.start = this.sourceTimeAtLocalFrame(boundary);
      guideFrame = boundary;
    } else if (type === "start") {
      const start = this.snapFrame(
        originalEdge + delta,
        Math.max(0, previousRange?.end ?? 0),
        original.end - 1,
      );
      section.start = this.sourceTimeAtLocalFrame(start);
      guideFrame = start;
    } else if (type === "end") {
      const end = this.snapFrame(
        originalEdge + delta,
        original.start + 1,
        Math.min(nextRange?.start ?? this.sequenceFrameCount(), this.sequenceFrameCount()),
      );
      section.end = this.sourceTimeAtLocalFrame(end);
      guideFrame = end;
    } else if (type === "move") {
      const duration = original.end - original.start;
      const previousTouches = previousRange?.end === original.start;
      const nextTouches = nextRange?.start === original.end;
      const minimum = previousTouches
        ? previousRange.start + 1
        : previousRange?.end ?? 0;
      const maximumEnd = nextTouches
        ? nextRange.end - 1
        : nextRange?.start ?? this.sequenceFrameCount();
      let start;
      let end;
      const markers = this.editingSnapFrames(0, this.sequenceFrameCount());
      if (this.drag.gridSpan && markers.length > this.drag.gridSpan) {
        const proposed = original.start + delta;
        let nearest = null;
        for (let marker = 0; marker + this.drag.gridSpan < markers.length; marker++) {
          const candidateStart = markers[marker];
          const candidateEnd = markers[marker + this.drag.gridSpan];
          if (candidateStart < minimum || candidateEnd > maximumEnd) continue;
          const distance = Math.abs(candidateStart - proposed);
          if (!nearest || distance < nearest.distance) {
            nearest = { start: candidateStart, end: candidateEnd, distance };
          }
        }
        if (!nearest) return;
        ({ start, end } = nearest);
      } else {
        const maximum = maximumEnd - duration;
        start = this.snapFrame(original.start + delta, minimum, Math.max(minimum, maximum));
        end = start + duration;
      }
      section.start = this.sourceTimeAtLocalFrame(start);
      section.end = this.sourceTimeAtLocalFrame(end);
      if (previousTouches) previous.end = section.start;
      if (nextTouches) next.start = section.end;
      guideFrame = start;
    }

    this.songMapOverrides = replaceSongMapSections(
      this.songMapOverrides,
      this.sourceAnalysis?.songMap,
      sections,
    );
    this.snapGuideFrame = guideFrame;
    this.syncSongInspector();
    this.scheduleDraw();
  }

  updateLyricsDrag(x) {
    if (!this.drag?.type.startsWith("lyrics-")) return;
    this.panDuringDrag(x);
    const segments = this.drag.originalSegments.map(segment => ({ ...segment }));
    const index = this.drag.originalIndex;
    const segment = segments[index];
    if (!segment) return;
    const previous = segments[index - 1];
    const next = segments[index + 1];
    const original = this.lyricsSegmentLocalRange(segment);
    const previousEnd = previous ? this.lyricsSegmentLocalRange(previous).end : 0;
    const nextStart = next ? this.lyricsSegmentLocalRange(next).start : this.sequenceFrameCount();
    const delta = Math.round(this.frameAtX(x)) - this.drag.pointerStartRaw;
    const type = this.drag.type.slice(7);
    let start = original.start;
    let end = original.end;
    if (type === "start") {
      start = clamp(original.start + delta, Math.max(0, previousEnd), original.end - 1);
    } else if (type === "end") {
      end = clamp(original.end + delta, original.start + 1, Math.min(nextStart, this.sequenceFrameCount()));
    } else if (type === "move") {
      const duration = original.end - original.start;
      start = clamp(
        original.start + delta,
        Math.max(0, previousEnd),
        Math.max(Math.max(0, previousEnd), Math.min(nextStart, this.sequenceFrameCount()) - duration),
      );
      end = start + duration;
    }
    segment.start = this.cropStartSeconds() + start / this.fps();
    segment.end = this.cropStartSeconds() + end / this.fps();
    segment.origin = "corrected";
    delete segment.words;
    this.lyricsTimeline = normalizeLyricsTimeline({
      ...lyricsTimelineForStorage(this.lyricsTimeline),
      segments,
    });
    this.snapGuideFrame = type === "end" ? end : start;
    this.syncLyricsInspector();
    this.scheduleDraw();
  }

  onPointerMove(event) {
    const { x, y } = this.eventPosition(event);
    if (this.drag?.type === "timeline-pan") {
      this.hover = null;
      if (!this.drag.active) {
        const distance = Math.hypot(x - this.drag.pointerStartX, y - this.drag.pointerStartY);
        if (distance < 2) return;
        this.drag.active = true;
      }
      this.canvas.style.cursor = "grabbing";
      this.updateTimelinePan(x);
      event.preventDefault();
      return;
    }
    this.hover = { x, y };
    if (this.drag?.type === "trim-start" ||
        this.drag?.type === "trim-end" ||
        this.drag?.type === "trim-move") {
      if (!this.drag.active) {
        const distance = Math.hypot(x - this.drag.pointerStartX, y - this.drag.pointerStartY);
        if (distance < 3) return;
        this.drag.active = true;
      }
      this.canvas.style.cursor = this.drag.type === "trim-move" ? "grabbing" : "ew-resize";
      this.updateTrimDrag(x);
      event.preventDefault();
      return;
    }
    if (this.drag?.type.startsWith("song-")) {
      this.drag.pointerX = x;
      this.drag.pointerY = y;
      if (!this.drag.active) {
        const distance = Math.hypot(x - this.drag.pointerStartX, y - this.drag.pointerStartY);
        if (distance < 3) return;
        this.drag.active = true;
      }
      const type = this.drag.type.slice(5);
      this.canvas.style.cursor = type === "move" ? "grabbing" : type === "shared-boundary" ? "col-resize" : "ew-resize";
      this.updateSongDrag(x);
      event.preventDefault();
      return;
    }
    if (this.drag?.type.startsWith("lyrics-")) {
      if (!this.drag.active) {
        const distance = Math.hypot(x - this.drag.pointerStartX, y - this.drag.pointerStartY);
        if (distance < 3) return;
        this.drag.active = true;
      }
      this.canvas.style.cursor = this.drag.type === "lyrics-move" ? "grabbing" : "ew-resize";
      this.updateLyricsDrag(x);
      event.preventDefault();
      return;
    }
    if (!this.drag || !this.selectedClip()) {
      const trimHit = this.hitTestTrim(x, y);
      const hit = this.hitTest(x, y);
      const songMapHit = this.songMapHitTest(x, y);
      const lyricsHit = this.lyricsHitTest(x, y);
      this.canvas.style.cursor = trimHit
        ? trimHit.type === "trim-move" ? "grab" : "ew-resize"
        : hit
        ? hit.type === "move"
          ? "grab"
          : hit.type === "shared-boundary"
          ? "col-resize"
          : "ew-resize"
        : lyricsHit
        ? lyricsHit.type === "move" ? lyricsHit.movable ? "grab" : "pointer" : "ew-resize"
        : songMapHit
        ? songMapHit.type === "move"
          ? songMapHit.movable ? "grab" : "pointer"
          : songMapHit.type === "shared-boundary"
          ? "col-resize"
          : "ew-resize"
        : "default";
      this.scheduleDraw();
      return;
    }

    this.drag.pointerX = x;
    this.drag.pointerY = y;
    if (!this.drag.active) {
      const distance = Math.hypot(x - this.drag.pointerStartX, y - this.drag.pointerStartY);
      if (Number.isFinite(distance) && distance < 3) return;
      this.drag.active = true;
    }
    this.canvas.style.cursor = this.drag.type === "move"
      ? "grabbing"
      : this.drag.type === "shared-boundary"
      ? "col-resize"
      : "ew-resize";
    this.updateDrag(x);
    event.preventDefault();
  }

  onPointerUp(event) {
    if (!this.drag) return;
    const songChanged = this.drag.type.startsWith("song-");
    const lyricsChanged = this.drag.type.startsWith("lyrics-");
    const trimChanged = this.drag.type === "trim-start" ||
      this.drag.type === "trim-end" ||
      this.drag.type === "trim-move";
    const viewChanged = this.drag.type === "timeline-pan";
    const changed = this.drag.active;
    this.drag = null;
    this.snapGuideFrame = null;
    this.canvas.style.cursor = "default";
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (changed) {
      if (songChanged) {
        this.clearError();
        this.saveViewState();
        this.syncInspector();
      } else if (lyricsChanged) {
        this.clearError();
        this.saveViewState();
        this.syncInspector();
      } else if (trimChanged) {
        this.resnapClipsToGrid();
        this.zoomToFit(false);
      } else if (viewChanged) {
        this.saveViewState(false);
      } else {
        normalizeCrossfades(this.clips);
        this.serialize();
        this.clearError();
        this.saveViewState();
      }
    }
    if (this.resnapPending) this.resnapClipsToGrid();
    this.commitEdit();
    this.scheduleDraw();
  }

  onWheel(event) {
    event.preventDefault();
    event.stopPropagation();
    const duration = this.sequenceFrameCount();
    const total = Math.max(1, this.viewEnd - this.viewStart);
    if (event.shiftKey) {
      const shift = total * Math.sign(event.deltaY) * 0.12;
      this.viewStart = clamp(this.viewStart + shift, 0, Math.max(0, duration - total));
      this.viewEnd = Math.min(duration, this.viewStart + total);
    } else {
      const center = this.frameAtEvent(event);
      const factor = event.deltaY > 0 ? 1.18 : 0.84;
      const minimum = Math.min(duration, Math.max(1, Math.round(this.fps() / 2)));
      const nextRange = clamp(total * factor, minimum, duration);
      const ratio = (center - this.viewStart) / total;
      this.viewStart = clamp(center - nextRange * ratio, 0, Math.max(0, duration - nextRange));
      this.viewEnd = Math.min(duration, this.viewStart + nextRange);
      this.viewStart = Math.max(0, this.viewEnd - nextRange);
    }
    this.saveViewState(false);
    this.scheduleDraw();
  }

  zoom(factor) {
    const duration = this.sequenceFrameCount();
    const total = Math.max(1, this.viewEnd - this.viewStart);
    const center = (this.viewStart + this.viewEnd) / 2;
    const minimum = Math.min(duration, Math.max(1, Math.round(this.fps() / 2)));
    const nextRange = clamp(total * factor, minimum, duration);
    this.viewStart = clamp(center - nextRange / 2, 0, Math.max(0, duration - nextRange));
    this.viewEnd = Math.min(duration, this.viewStart + nextRange);
    this.saveViewState(false);
    this.scheduleDraw();
  }

  nudgeSongSection(direction, gridSteps = 1) {
    const section = this.selectedSongSection();
    if (!section) return;
    const sections = this.editableSongSections();
    const index = sections.findIndex(entry => entry.id === section.id);
    const previous = sections[index - 1];
    const next = sections[index + 1];
    const range = this.songSectionLocalRange(sections[index]);
    const previousRange = previous ? this.songSectionLocalRange(previous) : null;
    const nextRange = next ? this.songSectionLocalRange(next) : null;
    const markers = this.editingSnapFrames(0, this.sequenceFrameCount());
    const markerIndex = this.nearestBeatIndex(range.start, markers);
    const endIndex = this.nearestBeatIndex(range.end, markers);
    const gridSpan = endIndex > markerIndex ? endIndex - markerIndex : null;
    const targetIndex = markerIndex + direction * gridSteps;
    if (markerIndex < 0 || targetIndex < 0 || targetIndex >= markers.length ||
        (gridSpan && targetIndex + gridSpan >= markers.length)) return;
    const duration = range.end - range.start;
    const previousTouches = previousRange?.end === range.start;
    const nextTouches = nextRange?.start === range.end;
    const minimum = previousTouches ? previousRange.start + 1 : previousRange?.end ?? 0;
    const maximumEnd = nextTouches ? nextRange.end - 1 : nextRange?.start ?? this.sequenceFrameCount();
    const proposedStart = markers[targetIndex];
    const proposedEnd = gridSpan ? markers[targetIndex + gridSpan] : proposedStart + duration;
    if (proposedStart < minimum || proposedEnd > maximumEnd) return;
    const start = proposedStart;
    const end = proposedEnd;
    sections[index].start = this.sourceTimeAtLocalFrame(start);
    sections[index].end = this.sourceTimeAtLocalFrame(end);
    if (previousTouches) previous.end = sections[index].start;
    if (nextTouches) next.start = sections[index].end;
    this.clearError();
    this.persistSongSections(sections);
  }

  nudgeLyricsSegment(direction, frames = 1) {
    const segment = this.selectedLyricsSegment();
    if (!segment) return;
    const segments = this.lyricsTimeline.segments.map(value => ({ ...value }));
    const index = segments.findIndex(value => value.id === segment.id);
    const range = this.lyricsSegmentLocalRange(segment);
    const duration = range.end - range.start;
    const minimum = index ? this.lyricsSegmentLocalRange(segments[index - 1]).end : 0;
    const maximumEnd = index + 1 < segments.length
      ? this.lyricsSegmentLocalRange(segments[index + 1]).start
      : this.sequenceFrameCount();
    const start = clamp(range.start + direction * frames, minimum, maximumEnd - duration);
    segments[index].start = this.cropStartSeconds() + start / this.fps();
    segments[index].end = this.cropStartSeconds() + (start + duration) / this.fps();
    segments[index].origin = "corrected";
    delete segments[index].words;
    this.persistLyrics(segments, segment.id);
  }

  onKeyDown(event) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) {
      return;
    }
    if (this.activeLane === "lyrics") {
      if ((event.key === "Delete" || event.key === "Backspace") && this.selectedLyricsSegment()) {
        this.runEdit("Delete lyric", () => this.deleteLyricsSegment());
        event.preventDefault();
        return;
      }
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && this.selectedLyricsSegment()) {
        this.runEdit(
          "Nudge lyric",
          () => this.nudgeLyricsSegment(event.key === "ArrowLeft" ? -1 : 1, event.shiftKey ? 10 : 1),
          { mergeKey: "nudge-lyric" },
        );
        event.preventDefault();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
        this.runEdit("Merge lyrics", () => this.mergeLyricsSegment());
        event.preventDefault();
        return;
      }
      return;
    }
    if (this.activeLane === "song-map") {
      if ((event.key === "Delete" || event.key === "Backspace") && this.selectedSongSection()) {
        this.runEdit("Delete Song Map section", () => this.deleteSongSection());
        event.preventDefault();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
        this.runEdit("Duplicate Song Map section", () => this.duplicateSongSection());
        event.preventDefault();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
        this.copySongSection();
        event.preventDefault();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        this.runEdit("Paste Song Map section", () => this.pasteSongSection());
        event.preventDefault();
        return;
      }
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && this.selectedSongSection()) {
        this.runEdit(
          "Nudge Song Map section",
          () => this.nudgeSongSection(
            event.key === "ArrowLeft" ? -1 : 1,
            event.shiftKey ? DEFAULT_CLIP_GRID_INTERVALS : 1,
          ),
          { mergeKey: "nudge-song-map" },
        );
        event.preventDefault();
        return;
      }
    }
    if ((event.key === "Delete" || event.key === "Backspace") && this.selectedClip()) {
      this.runEdit("Delete prompt", () => this.deleteClip());
      event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
      this.runEdit("Duplicate prompt", () => this.duplicateClip());
      event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      this.copyClip();
      event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
      this.runEdit("Paste prompt", () => this.pasteClip());
      event.preventDefault();
      return;
    }
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && this.selectedClip()) {
      const clip = this.selectedClip();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const previous = this.clips[this.selectedIndex - 1];
      const next = this.clips[this.selectedIndex + 1];
      const maximum = this.maximumFrame();
      const markers = this.editingSnapFrames(0, this.sequenceFrameCount());
      const startIndex = this.nearestBeatIndex(clip.start, markers);
      const endIndex = this.nearestBeatIndex(clip.end, markers);
      const markerStep = direction * (event.shiftKey ? DEFAULT_CLIP_GRID_INTERVALS : 1);
      const targetStart = startIndex + markerStep;
      const targetEnd = endIndex + markerStep;
      if (startIndex >= 0 &&
          endIndex > startIndex &&
          targetStart >= 0 &&
          targetEnd < markers.length &&
          (!previous || markers[targetStart] >= previous.end) &&
          (!next || markers[targetEnd] <= next.start) &&
          (!Number.isFinite(maximum) || markers[targetEnd] <= maximum)) {
        this.runEdit("Nudge prompt", () => {
          clip.start = markers[targetStart];
          clip.end = markers[targetEnd];
          this.serialize();
          this.syncInspector();
          this.scheduleDraw();
        }, { mergeKey: "nudge-prompt" });
      }
      event.preventDefault();
    }
  }

  hitTest(x, y) {
    for (let index = this.crossfadeRects.length - 1; index >= 0; index--) {
      const rect = this.crossfadeRects[index];
      if (y < rect.y || y > rect.y + Math.min(24, rect.height)) continue;
      if (rect.frames > 0) {
        if (Math.abs(x - rect.startX) <= 10) {
          return { index: rect.index, type: "crossfade-start" };
        }
        if (Math.abs(x - rect.endX) <= 10) {
          return { index: rect.index, type: "crossfade-end" };
        }
      } else if (Math.abs(x - rect.boundaryX) <= 10) {
        return { index: rect.index, type: "crossfade-create" };
      }
    }
    for (let index = this.crossfadeRects.length - 1; index >= 0; index--) {
      const rect = this.crossfadeRects[index];
      if (y >= rect.y && y <= rect.y + rect.height &&
          Math.abs(x - rect.boundaryX) <= 10) {
        return { index: rect.index, type: "shared-boundary" };
      }
    }
    for (let index = this.clipRects.length - 1; index >= 0; index--) {
      const rect = this.clipRects[index];
      if (y < rect.y || y > rect.y + rect.height) continue;
      const primary = rect.index === this.selectedIndex;
      if (primary && y <= rect.y + 20) {
        if (Math.abs(x - rect.fadeInX) <= 10) return { index: rect.index, type: "fade-in" };
        if (Math.abs(x - rect.fadeOutX) <= 10) return { index: rect.index, type: "fade-out" };
      }
      if (Math.abs(x - rect.x) <= 14) return { index: rect.index, type: "start" };
      if (Math.abs(x - (rect.x + rect.width)) <= 14) return { index: rect.index, type: "end" };
      if (x >= rect.x && x <= rect.x + rect.width) return { index: rect.index, type: "move" };
    }
    return null;
  }

  zoomToFit(save = true) {
    this.viewStart = 0;
    this.viewEnd = this.sequenceFrameCount();
    if (save) this.saveViewState(false);
    this.scheduleDraw();
  }

  frameToX(frame, width) {
    const right = width - TIMELINE_RIGHT;
    return TIMELINE_LEFT +
      ((frame - this.viewStart) / Math.max(EPSILON, this.viewEnd - this.viewStart)) *
      (right - TIMELINE_LEFT);
  }

  scheduleDraw(staticChanged = true) {
    if (staticChanged) this.staticDirty = true;
    if (this.pendingFrame) return;
    this.pendingFrame = requestAnimationFrame(() => {
      this.pendingFrame = null;
      const syncEnvelopePreviews = this.staticDirty;
      this.draw();
      if (syncEnvelopePreviews) this.syncEnvelopePreviews();
    });
  }

  drawSourceOverview(ctx, width, top, bottom) {
    const right = width - TIMELINE_RIGHT;
    const center = (top + bottom) / 2;
    const preview = this.sourceWaveformPreview;
    ctx.fillStyle = "#12151a";
    ctx.fillRect(TIMELINE_LEFT, top, right - TIMELINE_LEFT, bottom - top);
    ctx.strokeStyle = "#2d323a";
    ctx.strokeRect(TIMELINE_LEFT + 0.5, top + 0.5, right - TIMELINE_LEFT - 1, bottom - top - 1);
    ctx.fillStyle = "#656b76";
    ctx.font = "7px Inter, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("SOURCE TRIM", TIMELINE_LEFT + 6, top + 4);
    if (!preview) return;

    const bins = preview.peaks.length / 2;
    const plotHeight = Math.max(1, (bottom - top) / 2 - 3);
    ctx.strokeStyle = "#66798a";
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    for (let x = TIMELINE_LEFT; x <= right; x++) {
      const ratio = (x - TIMELINE_LEFT) / Math.max(1, right - TIMELINE_LEFT);
      const bin = clamp(Math.floor(ratio * bins), 0, bins - 1);
      const minimum = preview.peaks[bin * 2] / preview.scale;
      const maximum = preview.peaks[bin * 2 + 1] / preview.scale;
      ctx.moveTo(x + 0.5, center - maximum * plotHeight);
      ctx.lineTo(x + 0.5, center - minimum * plotHeight);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    const handles = this.trimHandlePositions(width);
    ctx.fillStyle = "rgba(34,211,238,.12)";
    ctx.fillRect(handles.startX, top + 1, Math.max(1, handles.endX - handles.startX), bottom - top - 2);
    ctx.fillStyle = "rgba(0,0,0,.52)";
    ctx.fillRect(TIMELINE_LEFT, top + 1, Math.max(0, handles.startX - TIMELINE_LEFT), bottom - top - 2);
    ctx.fillRect(handles.endX, top + 1, Math.max(0, right - handles.endX), bottom - top - 2);
    for (const x of [handles.startX, handles.endX]) {
      ctx.strokeStyle = "#22d3ee";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, top);
      ctx.lineTo(x + 0.5, bottom);
      ctx.stroke();
      ctx.fillStyle = "#67e8f9";
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x - 5, top + 7);
      ctx.lineTo(x + 5, top + 7);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawSongMapLane(ctx, width, top, bottom) {
    const right = width - TIMELINE_RIGHT;
    const songMap = this.songMap();
    const previousHover = this.songMapHitTest(this.hover?.x, this.hover?.y);
    const draggedSharedPreviousId = this.drag?.type === "song-shared-boundary"
      ? this.drag.originalSections?.[this.drag.originalIndex - 1]?.id
      : null;
    this.songMapRects = [];
    this.songMapBoundaryRects = [];
    ctx.fillStyle = "#12161c";
    ctx.fillRect(TIMELINE_LEFT, top, right - TIMELINE_LEFT, bottom - top);
    ctx.strokeStyle = "#303640";
    ctx.strokeRect(TIMELINE_LEFT + 0.5, top + 0.5, right - TIMELINE_LEFT - 1, bottom - top - 1);
    if (!songMap) return;

    const cropStart = this.cropStartSeconds();
    for (let index = 0; index < songMap.sections.length; index++) {
      const section = songMap.sections[index];
      const startFrame = (section.start - cropStart) * this.fps();
      const endFrame = (section.end - cropStart) * this.fps();
      if (endFrame <= this.viewStart || startFrame >= this.viewEnd) continue;
      const startEdgeFrame = Math.max(0, startFrame);
      const endEdgeFrame = Math.min(this.sequenceFrameCount(), endFrame);
      const x = clamp(this.frameToX(Math.max(startFrame, this.viewStart), width), TIMELINE_LEFT, right);
      const endX = clamp(this.frameToX(Math.min(endFrame, this.viewEnd), width), TIMELINE_LEFT, right);
      const sectionWidth = Math.max(1, endX - x);
      const color = songSectionColor(section);
      const selected = this.selectedSongSectionIds.has(section.id);
      const hovered = previousHover?.section.id === section.id;
      const shared = (this.drag?.type === "song-shared-boundary" && (
        this.selectedSongSectionId === section.id || draggedSharedPreviousId === section.id
      )) ||
        (previousHover?.type === "shared-boundary" && (
          previousHover.section.id === section.id || previousHover.previousId === section.id
        ));
      ctx.save();
      if (selected || shared) {
        ctx.shadowColor = shared ? "rgba(34,211,238,.45)" : "rgba(167,139,250,.38)";
        ctx.shadowBlur = 7;
      }
      ctx.fillStyle = color;
      ctx.globalAlpha = selected ? 0.55 : hovered ? 0.44 : 0.34;
      ctx.fillRect(x, top + 1, sectionWidth, bottom - top - 2);
      ctx.globalAlpha = 0.92;
      ctx.strokeStyle = shared ? "#67e8f9" : selected ? "#ddd6fe" : color;
      ctx.lineWidth = selected || shared ? 2 : 1;
      ctx.strokeRect(x + 0.5, top + 1.5, Math.max(0, sectionWidth - 1), bottom - top - 3);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, top + 1);
      ctx.lineTo(x + 0.5, bottom - 1);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.restore();

      if (selected || hovered) {
        ctx.fillStyle = shared ? "#67e8f9" : selected ? "#ddd6fe" : "rgba(255,255,255,.6)";
        if (startEdgeFrame >= this.viewStart) {
          ctx.fillRect(x, top + 7, Math.min(3, sectionWidth), Math.max(8, bottom - top - 14));
        }
        if (endEdgeFrame <= this.viewEnd) {
          ctx.fillRect(Math.max(x, endX - 3), top + 7, Math.min(3, sectionWidth), Math.max(8, bottom - top - 14));
        }
      }

      let labelRect = null;
      if (sectionWidth > 22) {
        const label = songSectionLabel(section);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 4, top + 1, Math.max(0, sectionWidth - 8), bottom - top - 2);
        ctx.clip();
        ctx.fillStyle = "#f8fafc";
        ctx.font = "600 8px Inter, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, x + 6, (top + bottom) / 2);
        labelRect = {
          x: x + 6,
          y: (top + bottom) / 2 - 6,
          width: Math.min(ctx.measureText(label).width, Math.max(0, sectionWidth - 12)),
          height: 12,
        };
        ctx.restore();
      }
      this.songMapRects.push({
        index,
        section,
        x,
        y: top,
        width: sectionWidth,
        height: bottom - top,
        startX: startEdgeFrame >= this.viewStart ? x : null,
        endX: endEdgeFrame <= this.viewEnd ? endX : null,
        startEdgeFrame,
        endEdgeFrame,
        labelRect,
        movable: startFrame >= 0 && endFrame <= this.sequenceFrameCount(),
      });
    }

    for (let index = 1; index < songMap.sections.length; index++) {
      const section = songMap.sections[index];
      const previous = songMap.sections[index - 1];
      if (Math.abs(previous.end - section.start) > 0.5 / this.fps()) continue;
      const boundaryFrame = (section.start - cropStart) * this.fps();
      if (boundaryFrame < this.viewStart || boundaryFrame > this.viewEnd) continue;
      const boundaryX = this.frameToX(boundaryFrame, width);
      this.songMapBoundaryRects.push({
        index,
        section,
        previousId: previous.id,
        boundaryX,
        y: top,
        height: bottom - top,
      });
      const highlighted = (this.drag?.type === "song-shared-boundary" && this.selectedSongSectionId === section.id) ||
        (previousHover?.type === "shared-boundary" && previousHover.section.id === section.id);
      if (highlighted) {
        ctx.strokeStyle = "#67e8f9";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(boundaryX + 0.5, top + 1);
        ctx.lineTo(boundaryX + 0.5, bottom - 1);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    for (const cue of songMap.cues) {
      const startFrame = (cue.start - cropStart) * this.fps();
      const endFrame = (cue.end - cropStart) * this.fps();
      const anchorFrame = (cue.anchor - cropStart) * this.fps();
      if (Math.max(endFrame, anchorFrame) < this.viewStart ||
          Math.min(startFrame, anchorFrame) > this.viewEnd) continue;
      const startX = clamp(this.frameToX(startFrame, width), TIMELINE_LEFT, right);
      const endX = clamp(this.frameToX(endFrame, width), TIMELINE_LEFT, right);
      const anchorX = clamp(this.frameToX(anchorFrame, width), TIMELINE_LEFT, right);
      if (cue.type === "peak") {
        ctx.strokeStyle = "rgba(254,240,138,.9)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(startX, top + 2);
        ctx.lineTo(Math.max(startX + 1, endX), top + 2);
        ctx.stroke();
        ctx.lineWidth = 1;
      } else if (cue.type === "turnaround") {
        ctx.strokeStyle = songCueColor(cue);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(anchorX + 0.5, top + 12);
        ctx.lineTo(anchorX + 0.5, bottom - 1);
        ctx.stroke();
        ctx.fillStyle = songCueColor(cue);
        ctx.font = "700 7px Inter, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.fillText("TURN", anchorX - 3, bottom - 3);
        ctx.lineWidth = 1;
      }
    }

  }

  songMapHitTest(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (let index = this.songMapBoundaryRects.length - 1; index >= 0; index--) {
      const boundary = this.songMapBoundaryRects[index];
      if (y >= boundary.y && y <= boundary.y + boundary.height &&
          Math.abs(x - boundary.boundaryX) <= 10) {
        return { ...boundary, type: "shared-boundary" };
      }
    }
    for (let index = this.songMapRects.length - 1; index >= 0; index--) {
      const rect = this.songMapRects[index];
      if (y < rect.y || y > rect.y + rect.height) continue;
      if (Number.isFinite(rect.startX) && Math.abs(x - rect.startX) <= 14) {
        return { ...rect, type: "start", edgeFrame: rect.startEdgeFrame };
      }
      if (Number.isFinite(rect.endX) && Math.abs(x - rect.endX) <= 14) {
        return { ...rect, type: "end", edgeFrame: rect.endEdgeFrame };
      }
      if (x >= rect.x && x <= rect.x + rect.width) return { ...rect, type: "move" };
    }
    return null;
  }

  songMapLabelHitTest(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (let index = this.songMapRects.length - 1; index >= 0; index--) {
      const rect = this.songMapRects[index];
      const label = rect.labelRect;
      if (label && x >= label.x && x <= label.x + label.width &&
          y >= label.y && y <= label.y + label.height) {
        return rect;
      }
    }
    return null;
  }

  drawLyricsLane(ctx, width, top, bottom) {
    const right = width - TIMELINE_RIGHT;
    const current = this.lyricsCurrent();
    const hover = this.lyricsHitTest(this.hover?.x, this.hover?.y);
    this.lyricsRects = [];
    ctx.fillStyle = current ? "#15131d" : "#1b1715";
    ctx.fillRect(TIMELINE_LEFT, top, right - TIMELINE_LEFT, bottom - top);
    ctx.strokeStyle = current ? "#3a304a" : "#4a3628";
    ctx.strokeRect(TIMELINE_LEFT + 0.5, top + 0.5, right - TIMELINE_LEFT - 1, bottom - top - 1);
    const timeline = this.lyricsTimeline;
    if (!timeline?.segments.length || !current) {
      ctx.fillStyle = current ? "#9584ad" : "#c99b70";
      ctx.font = "8px Inter, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const message = timeline && !current
        ? "LYRICS · STALE FOR SELECTED AUDIO"
        : "LYRICS · TRANSCRIBE LOCALLY OR IMPORT LRC/SRT";
      ctx.fillText(message, TIMELINE_LEFT + 7, (top + bottom) / 2);
      return;
    }
    const cropStart = this.cropStartSeconds();
    const sequenceEnd = this.sequenceFrameCount();
    for (let index = 0; index < timeline.segments.length; index++) {
      const segment = timeline.segments[index];
      const startFrame = (segment.start - cropStart) * this.fps();
      const endFrame = (segment.end - cropStart) * this.fps();
      if (endFrame <= this.viewStart || startFrame >= this.viewEnd) continue;
      const visibleStart = Math.max(startFrame, this.viewStart, 0);
      const visibleEnd = Math.min(endFrame, this.viewEnd, sequenceEnd);
      if (!(visibleEnd > visibleStart)) continue;
      const x = clamp(this.frameToX(visibleStart, width), TIMELINE_LEFT, right);
      const endX = clamp(this.frameToX(visibleEnd, width), TIMELINE_LEFT, right);
      const segmentWidth = Math.max(1, endX - x);
      const selected = segment.id === this.selectedLyricsSegmentId;
      const hovered = hover?.segment.id === segment.id;
      const active = this.playheadFrame != null && this.playheadFrame >= startFrame && this.playheadFrame < endFrame;
      const color = segment.origin === "corrected" ? "#c084fc"
        : ["lrc", "srt", "manual"].includes(segment.origin) ? "#f0abfc"
        : "#a78bfa";
      ctx.save();
      if (selected || active) {
        ctx.shadowColor = active ? "rgba(244,114,182,.5)" : "rgba(167,139,250,.45)";
        ctx.shadowBlur = 7;
      }
      ctx.fillStyle = color;
      ctx.globalAlpha = selected ? 0.45 : active ? 0.38 : hovered ? 0.3 : 0.22;
      ctx.fillRect(x, top + 1, segmentWidth, bottom - top - 2);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = active ? "#f9a8d4" : selected ? "#ddd6fe" : color;
      ctx.lineWidth = selected || active ? 2 : 1;
      ctx.strokeRect(x + 0.5, top + 1.5, Math.max(0, segmentWidth - 1), bottom - top - 3);
      ctx.restore();
      if (selected || hovered) {
        ctx.fillStyle = selected ? "#ddd6fe" : "rgba(255,255,255,.55)";
        if (startFrame >= 0) ctx.fillRect(x, top + 6, Math.min(3, segmentWidth), Math.max(8, bottom - top - 12));
        if (endFrame <= sequenceEnd) ctx.fillRect(Math.max(x, endX - 3), top + 6, Math.min(3, segmentWidth), Math.max(8, bottom - top - 12));
      }
      if (segmentWidth > 22) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 5, top + 1, Math.max(0, segmentWidth - 10), bottom - top - 2);
        ctx.clip();
        ctx.fillStyle = "#f5f3ff";
        ctx.font = active ? "600 9px Inter, sans-serif" : "8px Inter, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const lines = canvasTextLines(ctx, segment.text, Math.max(1, segmentWidth - 12), bottom - top > 35 ? 2 : 1);
        const lineHeight = 11;
        const firstY = (top + bottom) / 2 - (lines.length - 1) * lineHeight / 2;
        lines.forEach((line, lineIndex) => ctx.fillText(line, x + 6, firstY + lineIndex * lineHeight));
        ctx.restore();
      }
      this.lyricsRects.push({
        index,
        segment,
        x,
        y: top,
        width: segmentWidth,
        height: bottom - top,
        startX: startFrame >= 0 ? x : null,
        endX: endFrame <= sequenceEnd ? endX : null,
        movable: startFrame >= 0 && endFrame <= sequenceEnd,
      });
    }
  }

  drawEnergyCurve(ctx, width, top, bottom) {
    const preview = this.songMap()?.energyPreview;
    if (!preview) return;
    const right = width - TIMELINE_RIGHT;
    const plotHeight = Math.max(1, bottom - top - 10);
    ctx.strokeStyle = "rgba(251,191,36,.78)";
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    let started = false;
    for (let x = TIMELINE_LEFT; x <= right; x++) {
      const sourceSeconds = this.cropStartSeconds() + this.frameAtX(x) / this.fps();
      const index = Math.floor(sourceSeconds * preview.rate);
      if (index < 0 || index >= preview.values.length) continue;
      const y = bottom - 5 - preview.values[index] * plotHeight;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    if (started) ctx.stroke();
    ctx.lineWidth = 1;
  }

  drawWaveformLane(ctx, width, top, bottom) {
    const right = width - TIMELINE_RIGHT;
    const center = (top + bottom) / 2;
    const waveform = this.waveformSource();
    const preview = waveform?.preview;

    ctx.fillStyle = "#14191e";
    ctx.fillRect(TIMELINE_LEFT, top, right - TIMELINE_LEFT, bottom - top);
    ctx.strokeStyle = "#293039";
    ctx.strokeRect(TIMELINE_LEFT + 0.5, top + 0.5, right - TIMELINE_LEFT - 1, bottom - top - 1);

    const selected = this.activeLane === "song-map"
      ? this.selectedSongSection() && this.songSectionLocalRange(this.selectedSongSection())
      : this.activeLane === "lyrics"
        ? this.selectedLyricsSegment() && this.lyricsSegmentLocalRange(this.selectedLyricsSegment())
        : this.selectedClip();
    if (selected) {
      const selectionStart = clamp(this.frameToX(selected.start, width), TIMELINE_LEFT, right);
      const selectionEnd = clamp(this.frameToX(selected.end, width), TIMELINE_LEFT, right);
      if (selectionEnd > selectionStart) {
        ctx.fillStyle = "rgba(167,139,250,.09)";
        ctx.fillRect(selectionStart, top + 1, selectionEnd - selectionStart, bottom - top - 2);
      }
    }

    ctx.strokeStyle = "#303944";
    ctx.beginPath();
    ctx.moveTo(TIMELINE_LEFT, center + 0.5);
    ctx.lineTo(right, center + 0.5);
    ctx.stroke();

    if (!preview) {
      ctx.fillStyle = "#64748b";
      ctx.font = "9px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Choose an audio file to load its waveform", (TIMELINE_LEFT + right) / 2, center);
      return;
    }

    const binCount = preview.peaks.length / 2;
    const cropStart = this.cropStartSeconds();
    const waveformStartFrame = (waveform.start - cropStart) * this.fps();
    const waveformEndFrame = (waveform.start + preview.duration - cropStart) * this.fps();
    const visibleStart = Math.max(this.viewStart, waveformStartFrame, 0);
    const visibleEnd = Math.min(this.viewEnd, waveformEndFrame, this.sequenceFrameCount());
    if (!(visibleEnd > visibleStart)) return;

    const startX = Math.max(TIMELINE_LEFT, Math.floor(this.frameToX(visibleStart, width)));
    const endX = Math.min(right, Math.ceil(this.frameToX(visibleEnd, width)));
    const plotHeight = Math.max(1, (bottom - top) / 2 - 5);
    ctx.strokeStyle = "#6d9bad";
    ctx.globalAlpha = 0.92;
    ctx.beginPath();
    for (let x = startX; x <= endX; x++) {
      const firstFrame = this.frameAtX(x);
      const lastFrame = this.frameAtX(Math.min(endX, x + 1));
      const [firstBin, lastBin] = waveformBinRange(
        firstFrame,
        lastFrame,
        cropStart,
        this.fps(),
        waveform.start,
        preview.duration,
        binCount,
      );
      let minimum = preview.scale;
      let maximum = -preview.scale;
      for (let bin = firstBin; bin < lastBin; bin++) {
        minimum = Math.min(minimum, preview.peaks[bin * 2]);
        maximum = Math.max(maximum, preview.peaks[bin * 2 + 1]);
      }
      ctx.moveTo(x + 0.5, center - (maximum / preview.scale) * plotHeight);
      ctx.lineTo(x + 0.5, center - (minimum / preview.scale) * plotHeight);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    this.drawEnergyCurve(ctx, width, top, bottom);

    if (!this.hover || this.hover.y < top || this.hover.y > bottom ||
        this.hover.x < TIMELINE_LEFT || this.hover.x > right) {
      return;
    }
    const frame = clamp(Math.round(this.frameAtX(this.hover.x)), 0, this.sequenceFrameCount());
    const seconds = frame / this.fps();
    const x = this.frameToX(frame, width);
    ctx.strokeStyle = "rgba(251,191,36,.42)";
    ctx.beginPath();
    ctx.moveTo(x + 0.5, top);
    ctx.lineTo(x + 0.5, bottom);
    ctx.stroke();

    const text = `F${frame} · ${formatClock(seconds)} · ${this.nearestBeatLabel(frame)}`;
    ctx.font = "9px Inter, sans-serif";
    const boxWidth = ctx.measureText(text).width + 12;
    const boxX = clamp(x - boxWidth / 2, TIMELINE_LEFT, right - boxWidth);
    ctx.fillStyle = "rgba(28,25,23,.94)";
    ctx.fillRect(boxX, top + 4, boxWidth, 18);
    ctx.fillStyle = "#fef3c7";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, boxX + 6, top + 13);
  }

  drawRuler(ctx, width, top, bottom) {
    const right = width - TIMELINE_RIGHT;
    const range = Math.max(1, this.viewEnd - this.viewStart);
    const step = niceFrameStep(range, right - TIMELINE_LEFT, this.fps());
    const minor = step % 4 === 0 ? step / 4 : step % 2 === 0 ? step / 2 : step;

    ctx.fillStyle = "#17191f";
    ctx.fillRect(TIMELINE_LEFT, top, right - TIMELINE_LEFT, bottom - top);
    ctx.strokeStyle = "#343842";
    ctx.beginPath();
    ctx.moveTo(TIMELINE_LEFT, bottom - 0.5);
    ctx.lineTo(right, bottom - 0.5);
    ctx.stroke();

    const firstMinor = Math.ceil(this.viewStart / minor) * minor;
    for (let frame = firstMinor; frame <= this.viewEnd + EPSILON; frame += minor) {
      const x = this.frameToX(frame, width);
      const major = Math.abs(frame % step) < EPSILON;
      ctx.strokeStyle = major ? "#59606c" : "#3a3f48";
      ctx.globalAlpha = major ? 0.72 : 0.5;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, bottom - (major ? 8 : 4));
      ctx.lineTo(x + 0.5, bottom);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const firstTick = Math.ceil(this.viewStart / step) * step;
    const tickWidth = Math.abs(
      this.frameToX(firstTick + step, width) - this.frameToX(firstTick, width),
    );
    for (let frame = firstTick; frame <= this.viewEnd + EPSILON; frame += step) {
      const x = this.frameToX(frame, width);
      ctx.fillStyle = "#c0c4cc";
      ctx.font = "8px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(`${Math.round(frame)}f`, x, top + 3);
      if (tickWidth >= 54) {
        ctx.fillStyle = "#737984";
        ctx.font = "7px Inter, sans-serif";
        ctx.fillText(formatRulerTime(frame / this.fps()), x, top + 14);
      }
    }
  }

  drawAnalysisMarkers(ctx, width, top, bottom, tooltipTop) {
    const right = width - TIMELINE_RIGHT;
    const families = [
      {
        label: "Downbeat",
        markers: this.detectedDownbeatMarkers(),
        color: "#fbbf24",
        height: 15,
      },
      {
        label: "Beat",
        markers: this.detectedBeatMarkers(),
        color: "#e879f9",
        height: 10,
      },
      {
        label: "Onset",
        markers: this.onsetFrames().map((frame) => ({ frame, confidence: 1, outlier: false })),
        color: "#fb923c",
        height: 5,
      },
    ];
    let hovered = null;
    for (const family of families) {
      ctx.lineWidth = 1;
      for (const marker of family.markers) {
        const { frame } = marker;
        if (frame < this.viewStart || frame > this.viewEnd) continue;
        const x = this.frameToX(frame, width);
        ctx.strokeStyle = marker.outlier ? "#fb7185" : family.color;
        ctx.globalAlpha = 0.25 + marker.confidence * 0.55;
        const height = Math.max(3, family.height * (0.45 + marker.confidence * 0.55));
        ctx.beginPath();
        ctx.moveTo(x + 0.5, bottom - height);
        ctx.lineTo(x + 0.5, bottom - 1);
        ctx.stroke();
        if (this.hover?.y >= top && this.hover?.y <= bottom &&
            Math.abs(this.hover.x - x) <= 4 &&
            (!hovered || Math.abs(this.hover.x - x) < hovered.distance)) {
          hovered = {
            ...family,
            ...marker,
            x,
            distance: Math.abs(this.hover.x - x),
          };
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;

    if (hovered) {
      const confidence = hovered.label === "Onset" ? "" : ` · ${(hovered.confidence * 100).toFixed(0)}% confidence`;
      const outlier = hovered.outlier ? " · timing outlier" : "";
      const text = `${hovered.label} · F${hovered.frame} · ${formatClock(hovered.frame / this.fps())}${confidence}${outlier}`;
      ctx.font = "9px Inter, sans-serif";
      const boxWidth = ctx.measureText(text).width + 12;
      const boxX = clamp(hovered.x - boxWidth / 2, TIMELINE_LEFT, right - boxWidth);
      ctx.fillStyle = "rgba(24,24,27,.95)";
      ctx.fillRect(boxX, tooltipTop + 5, boxWidth, 18);
      ctx.fillStyle = hovered.outlier ? "#fb7185" : hovered.color;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(text, boxX + 6, tooltipTop + 14);
    }
  }

  drawBeatGrid(ctx, width, rulerBottom, contentTop, contentBottom) {
    const frames = this.beatFrames();
    const downbeatFrames = this.downbeatFrames();
    const downbeatSet = new Set(downbeatFrames);
    const visibleFrames = frames.filter((frame) => frame >= this.viewStart && frame <= this.viewEnd);
    const markerSpacing = visibleFrames.length > 1
      ? Math.abs(this.frameToX(visibleFrames[1], width) - this.frameToX(visibleFrames[0], width))
      : Infinity;

    for (let index = 0; index + 1 < downbeatFrames.length; index++) {
      if (index % 2 !== 0) continue;
      const start = Math.max(downbeatFrames[index], this.viewStart);
      const end = Math.min(downbeatFrames[index + 1], this.viewEnd);
      if (!(end > start)) continue;
      const left = this.frameToX(start, width);
      const right = this.frameToX(end, width);
      ctx.fillStyle = "rgba(251,191,36,.025)";
      ctx.fillRect(left, contentTop, right - left, contentBottom - contentTop);
    }

    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index];
      if (frame < this.viewStart || frame > this.viewEnd) continue;
      const x = this.frameToX(frame, width);
      const downbeat = downbeatSet.has(frame);
      ctx.strokeStyle = downbeat ? "#fbbf24" : "#22d3ee";
      ctx.lineWidth = downbeat ? 1.4 : 1;
      ctx.globalAlpha = downbeat ? 0.34 : 0.1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, contentTop);
      ctx.lineTo(x + 0.5, contentBottom);
      ctx.stroke();

      ctx.globalAlpha = downbeat ? 0.95 : 0.65;
      ctx.fillStyle = downbeat ? "#fbbf24" : "#67e8f9";
      ctx.beginPath();
      if (downbeat) {
        ctx.moveTo(x, rulerBottom - 8);
        ctx.lineTo(x + 4, rulerBottom - 4);
        ctx.lineTo(x, rulerBottom);
        ctx.lineTo(x - 4, rulerBottom - 4);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.arc(x, rulerBottom - 4, 2, 0, Math.PI * 2);
        ctx.fill();
      }

      if (downbeat || markerSpacing >= 52) {
        const barIndex = downbeatFrames.indexOf(frame);
        ctx.fillStyle = downbeat ? "#fde68a" : "#8ddde8";
        ctx.font = "7px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(downbeat ? `B${barIndex + 1}` : String(index + 1), x, rulerBottom - 10);
      }
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
  }

  drawPromptClips(ctx, width, top, bottom) {
    const right = width - TIMELINE_RIGHT;
    const trackHeight = Math.max(80, bottom - top);
    const cardY = top + 7;
    const cardHeight = trackHeight - 14;
    const previousHover = this.hover ? this.hitTest(this.hover.x, this.hover.y) : null;
    const sharedBoundaryIndex = this.drag?.type === "shared-boundary"
      ? this.selectedIndex
      : previousHover?.type === "shared-boundary"
      ? previousHover.index
      : -1;

    ctx.fillStyle = "#15171c";
    ctx.fillRect(TIMELINE_LEFT, top, right - TIMELINE_LEFT, trackHeight);
    ctx.strokeStyle = "#2d3038";
    ctx.strokeRect(TIMELINE_LEFT + 0.5, top + 0.5, right - TIMELINE_LEFT - 1, trackHeight - 1);

    this.clipRects = [];
    this.crossfadeRects = [];
    for (let index = 0; index < this.clips.length; index++) {
      const clip = this.clips[index];
      if (clip.end < this.viewStart || clip.start > this.viewEnd) continue;
      const startX = this.frameToX(clip.start, width);
      const endX = this.frameToX(clip.end, width);
      const fadeInX = this.frameToX(clip.start + clip.fadeIn, width);
      const fadeOutX = this.frameToX(clip.end - clip.fadeOut, width);
      const x = clamp(startX, TIMELINE_LEFT, right);
      const clippedEnd = clamp(endX, TIMELINE_LEFT, right);
      const cardWidth = Math.max(2, clippedEnd - x);
      const drawX = x + 1;
      const drawWidth = Math.max(1, cardWidth - 2);
      const primary = index === this.selectedIndex;
      const selected = this.selectedIndices.has(index);
      const shared = index === sharedBoundaryIndex || index === sharedBoundaryIndex - 1;
      const hovered = previousHover?.index === index || shared;

      ctx.save();
      if (selected || shared) {
        ctx.shadowColor = shared ? "rgba(34,211,238,.3)" : "rgba(167,139,250,.28)";
        ctx.shadowBlur = 8;
      }
      ctx.fillStyle = shared
        ? "#38505c"
        : selected
        ? "#4a4263"
        : hovered
        ? "#414654"
        : index % 2
        ? "#363b47"
        : "#333844";
      ctx.strokeStyle = shared
        ? "#67e8f9"
        : selected
        ? "#b8a5ff"
        : hovered
        ? "#7b8292"
        : "#555c6b";
      ctx.lineWidth = primary || shared ? 2 : selected ? 1.5 : 1;
      ctx.beginPath();
      ctx.roundRect(drawX, cardY, drawWidth, cardHeight, 6);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      if (fadeInX > startX) {
        const fadeStart = clamp(startX, TIMELINE_LEFT, right);
        const fadeEnd = clamp(fadeInX, TIMELINE_LEFT, right);
        const gradient = ctx.createLinearGradient(fadeStart, 0, fadeEnd, 0);
        gradient.addColorStop(0, "rgba(12,14,20,.46)");
        gradient.addColorStop(1, "rgba(12,14,20,0)");
        ctx.fillStyle = gradient;
        ctx.fillRect(fadeStart, cardY + 2, Math.max(0, fadeEnd - fadeStart), cardHeight - 4);
      }
      if (fadeOutX < endX) {
        const fadeStart = clamp(fadeOutX, TIMELINE_LEFT, right);
        const fadeEnd = clamp(endX, TIMELINE_LEFT, right);
        const gradient = ctx.createLinearGradient(fadeStart, 0, fadeEnd, 0);
        gradient.addColorStop(0, "rgba(12,14,20,0)");
        gradient.addColorStop(1, "rgba(12,14,20,.46)");
        ctx.fillStyle = gradient;
        ctx.fillRect(fadeStart, cardY + 2, Math.max(0, fadeEnd - fadeStart), cardHeight - 4);
      }

      if (selected || hovered) {
        ctx.fillStyle = shared ? "#67e8f9" : selected ? "#c4b5fd" : "#7b8190";
        ctx.fillRect(drawX, cardY + 22, Math.min(3, drawWidth), Math.max(12, cardHeight - 44));
        ctx.fillRect(Math.max(drawX, drawX + drawWidth - 3), cardY + 22, Math.min(3, drawWidth), Math.max(12, cardHeight - 44));
      }
      if (primary) {
        for (const handleX of [fadeInX, fadeOutX]) {
          if (handleX < TIMELINE_LEFT || handleX > right) continue;
          ctx.fillStyle = "#ddd6fe";
          ctx.beginPath();
          ctx.moveTo(handleX, cardY + 3);
          ctx.lineTo(handleX - 5, cardY + 9);
          ctx.lineTo(handleX, cardY + 15);
          ctx.lineTo(handleX + 5, cardY + 9);
          ctx.closePath();
          ctx.fill();
        }
      }

      if (drawWidth > 24) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(drawX + 9, cardY + 8, Math.max(0, drawWidth - 18), cardHeight - 16);
        ctx.clip();
        ctx.fillStyle = "#f4f4f5";
        ctx.font = "600 10px Inter, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        const lines = canvasTextLines(ctx, clip.prompt, Math.max(1, drawWidth - 18), 2);
        const promptY = cardY + (clip.renderGroup == null ? 10 : 23);
        lines.forEach((line, lineIndex) => ctx.fillText(line, drawX + 9, promptY + lineIndex * 14));
        ctx.fillStyle = shared ? "#a5f3fc" : selected ? "#c4b5fd" : "#9ca3af";
        ctx.font = "8px Inter, sans-serif";
        ctx.fillText(
          `${clip.start}–${clip.end}f · ${(clip.start / this.fps()).toFixed(2)}–${(clip.end / this.fps()).toFixed(2)}s`,
          drawX + 9,
          cardY + cardHeight - 19,
        );
        ctx.restore();
      }

      this.clipRects.push({
        index,
        x,
        y: cardY,
        width: cardWidth,
        height: cardHeight,
        fadeInX,
        fadeOutX,
      });
    }

    const groupRects = new Map();
    for (const rect of this.clipRects) {
      const group = this.clips[rect.index]?.renderGroup;
      if (group == null) continue;
      if (!groupRects.has(group)) groupRects.set(group, []);
      groupRects.get(group).push(rect);
    }
    for (const [group, rects] of groupRects) {
      const color = RENDER_GROUP_COLORS[(group - 1) % RENDER_GROUP_COLORS.length];
      const startX = rects[0].x + 5;
      const endRect = rects[rects.length - 1];
      const endX = endRect.x + endRect.width - 5;
      const railY = cardY + 6;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(startX, railY);
      ctx.lineTo(endX, railY);
      ctx.stroke();
      ctx.lineCap = "butt";

      const memberCount = this.clips.filter((clip) => clip.renderGroup === group).length;
      if (endX - startX > 82) {
        const label = `Render ${group} · ${memberCount} prompts`;
        ctx.font = "600 8px Inter, sans-serif";
        const labelWidth = ctx.measureText(label).width + 12;
        ctx.fillStyle = "#17191e";
        ctx.fillRect(startX + 5, cardY + 9, labelWidth, 12);
        ctx.fillStyle = color;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(label, startX + 11, cardY + 11);
      }
    }

    for (let index = 1; index < this.clips.length; index++) {
      const clip = this.clips[index];
      const previous = this.clips[index - 1];
      if (previous.end !== clip.start || clip.start < this.viewStart || clip.start > this.viewEnd) {
        continue;
      }
      const bounds = this.crossfadeBounds(index);
      const boundaryX = this.frameToX(bounds.boundary, width);
      const startX = clamp(this.frameToX(bounds.start, width), TIMELINE_LEFT, right);
      const endX = clamp(this.frameToX(bounds.end, width), TIMELINE_LEFT, right);
      const related = this.selectedIndex === index || this.selectedIndex === index - 1;
      const hovered = previousHover?.index === index &&
        previousHover?.type.startsWith("crossfade");
      const shared = sharedBoundaryIndex === index;
      this.crossfadeRects.push({
        index,
        x: startX,
        y: cardY,
        width: Math.max(1, endX - startX),
        height: cardHeight,
        startX,
        endX,
        boundaryX,
        frames: bounds.frames,
      });

      if (bounds.frames > 0) {
        const gradient = ctx.createLinearGradient(startX, 0, endX, 0);
        gradient.addColorStop(0, "rgba(167,139,250,.5)");
        gradient.addColorStop(0.5, "rgba(125,211,252,.38)");
        gradient.addColorStop(1, "rgba(34,211,238,.5)");
        ctx.fillStyle = gradient;
        ctx.fillRect(startX, cardY + 2, Math.max(1, endX - startX), cardHeight - 4);

        ctx.strokeStyle = "rgba(224,231,255,.7)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(startX, cardY + 2);
        ctx.lineTo(endX, cardY + cardHeight - 2);
        ctx.moveTo(startX, cardY + cardHeight - 2);
        ctx.lineTo(endX, cardY + 2);
        ctx.stroke();

        ctx.strokeStyle = "#e0f2fe";
        ctx.globalAlpha = 0.78;
        ctx.beginPath();
        ctx.moveTo(boundaryX + 0.5, cardY + 2);
        ctx.lineTo(boundaryX + 0.5, cardY + cardHeight - 2);
        ctx.stroke();
        ctx.globalAlpha = 1;

        if (endX - startX >= 42) {
          const label = `${bounds.frames}f`;
          ctx.font = "700 8px Inter, sans-serif";
          const labelWidth = ctx.measureText(label).width + 10;
          ctx.fillStyle = "rgba(15,23,42,.9)";
          ctx.fillRect(
            clamp(boundaryX - labelWidth / 2, startX, endX - labelWidth),
            cardY + 5,
            labelWidth,
            16,
          );
          ctx.fillStyle = "#e0f2fe";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(label, boundaryX, cardY + 13);
        }
      } else if (!related && !hovered && !shared) {
        continue;
      }

      for (const handleX of bounds.frames > 0 ? [startX, endX] : [boundaryX]) {
        ctx.fillStyle = hovered ? "#ffffff" : "#bae6fd";
        ctx.beginPath();
        ctx.moveTo(handleX, cardY + 2);
        ctx.lineTo(handleX - 5, cardY + 8);
        ctx.lineTo(handleX, cardY + 14);
        ctx.lineTo(handleX + 5, cardY + 8);
        ctx.closePath();
        ctx.fill();
      }

      if (shared) {
        ctx.fillStyle = "#67e8f9";
        ctx.fillRect(
          boundaryX - 2,
          cardY + 18,
          4,
          Math.max(8, cardHeight - 36),
        );
        const centerY = cardY + cardHeight / 2;
        ctx.beginPath();
        ctx.moveTo(boundaryX - 8, centerY);
        ctx.lineTo(boundaryX - 3, centerY - 5);
        ctx.lineTo(boundaryX - 3, centerY + 5);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(boundaryX + 8, centerY);
        ctx.lineTo(boundaryX + 3, centerY - 5);
        ctx.lineTo(boundaryX + 3, centerY + 5);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  drawWriterActivity(ctx) {
    this.writerCompletionFades ||= new Map();
    const activity = this.writerActivity;
    if (!activity) return;
    const now = performance.now();
    for (const [index, expires] of this.writerCompletionFades) {
      if (expires <= now) this.writerCompletionFades.delete(index);
    }
    const activeIndex = activity.activeIndex;
    const queued = new Set((activity.phase === "editing" && activity.progressTotal ? [...activity.targetIndices] : []).filter((index) => (
      index !== activeIndex && !activity.completedIndices.has(index)
    )));
    const visible = this.clipRects.filter((rect) => (
      queued.has(rect.index) || rect.index === activeIndex || rect.index === activity.failedIndex || this.writerCompletionFades.has(rect.index)
    ));
    if (!visible.length) return;
    const sweep = ((performance.now() - this.writerActivityStartedAt) % 1700) / 1700;

    for (const rect of visible) {
      const isActive = rect.index === activeIndex;
      const isFailed = rect.index === activity.failedIndex;
      const fadeUntil = this.writerCompletionFades.get(rect.index) || 0;
      const isCompleted = fadeUntil > now;
      const color = isFailed
        ? "#f59e0b"
        : isCompleted
        ? "#34d399"
        : isActive
        ? "#22d3ee"
        : "#3f6475";
      const drawX = rect.x + 2;
      const drawY = rect.y + 2;
      const drawWidth = Math.max(1, rect.width - 4);
      const drawHeight = Math.max(1, rect.height - 4);
      ctx.save();
      ctx.strokeStyle = color;
      const completionAlpha = isCompleted ? Math.min(1, (fadeUntil - now) / 350) : 1;
      ctx.globalAlpha = (isActive || isCompleted || isFailed ? 0.95 : 0.36) * completionAlpha;
      ctx.lineWidth = isActive || isCompleted || isFailed ? 2 : 1;
      ctx.shadowColor = color;
      ctx.shadowBlur = isActive || isCompleted ? 11 : 3;
      ctx.beginPath();
      ctx.roundRect(drawX, drawY, drawWidth, drawHeight, 5);
      ctx.stroke();
      ctx.restore();

      if (isActive && !this.writerReducedMotion) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(drawX, drawY, drawWidth, drawHeight, 5);
        ctx.clip();
        const sweepX = drawX - drawWidth * 0.35 + drawWidth * 1.7 * sweep;
        const gradient = ctx.createLinearGradient(sweepX - 22, 0, sweepX + 22, 0);
        gradient.addColorStop(0, "rgba(56,189,248,0)");
        gradient.addColorStop(0.5, "rgba(34,211,238,.2)");
        gradient.addColorStop(1, "rgba(56,189,248,0)");
        ctx.fillStyle = gradient;
        ctx.fillRect(drawX, drawY, drawWidth, drawHeight);
        ctx.restore();
      }

      let chip = "";
      if (isFailed) chip = "RETRY";
      else if (isCompleted) chip = "\u2713 DRAFTED";
      else if (isActive) chip = activity.progressTotal
        ? `WRITING ${Math.min(activity.progressTotal, activity.progressCompleted + 1)}/${activity.progressTotal}`
        : "WRITING";
      if (!chip || rect.width < 74) continue;
      ctx.save();
      ctx.font = "700 7px Inter, sans-serif";
      const chipWidth = ctx.measureText(chip).width + 12;
      const chipX = Math.max(drawX + 4, drawX + drawWidth - chipWidth - 5);
      const chipY = drawY + 5;
      ctx.fillStyle = isFailed ? "rgba(120,53,15,.94)" : isCompleted ? "rgba(6,78,59,.94)" : "rgba(8,47,73,.94)";
      ctx.beginPath();
      ctx.roundRect(chipX, chipY, chipWidth, 14, 7);
      ctx.fill();
      ctx.fillStyle = isFailed ? "#fde68a" : isCompleted ? "#a7f3d0" : "#a5f3fc";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(chip, chipX + chipWidth / 2, chipY + 7.5);
      ctx.restore();
    }
  }

  drawGuidesAndPlayhead(ctx, width, layout) {
    if (this.snapGuideFrame != null &&
        this.snapGuideFrame >= this.viewStart &&
        this.snapGuideFrame <= this.viewEnd) {
      const x = this.frameToX(this.snapGuideFrame, width);
      ctx.strokeStyle = "#c4b5fd";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, layout.rulerBottom);
      ctx.lineTo(x + 0.5, layout.trackBottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (this.playheadFrame != null &&
        this.playheadFrame >= this.viewStart &&
        this.playheadFrame <= this.viewEnd) {
      const x = this.frameToX(this.playheadFrame, width);
      ctx.strokeStyle = "#fbbf24";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, layout.rulerTop);
      ctx.lineTo(x + 0.5, layout.trackBottom);
      ctx.stroke();
      ctx.fillStyle = "#fbbf24";
      ctx.beginPath();
      ctx.moveTo(x, layout.rulerTop + 9);
      ctx.lineTo(x - 6, layout.rulerTop + 1);
      ctx.lineTo(x + 6, layout.rulerTop + 1);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 1;
    }
  }

  drawStatic(ctx, cssWidth, cssHeight, layout) {
    const {
      sourceTop,
      sourceBottom,
      rulerTop,
      rulerBottom,
      songMapTop,
      songMapBottom,
      lyricsTop,
      lyricsBottom,
      waveformTop,
      waveformBottom,
      trackTop,
      trackBottom,
    } = layout;

    if (this.sourceWaveformPreview) {
      this.drawSourceOverview(ctx, cssWidth, sourceTop, sourceBottom);
    }
    if (songMapTop != null) {
      this.drawSongMapLane(ctx, cssWidth, songMapTop, songMapBottom);
    } else {
      this.songMapRects = [];
      this.songMapBoundaryRects = [];
    }
    if (lyricsTop != null) this.drawLyricsLane(ctx, cssWidth, lyricsTop, lyricsBottom);
    else this.lyricsRects = [];
    this.drawWaveformLane(ctx, cssWidth, waveformTop, waveformBottom);
    this.drawPromptClips(ctx, cssWidth, trackTop, trackBottom);
    this.drawRuler(ctx, cssWidth, rulerTop, rulerBottom);
    const contentTop = songMapTop ?? lyricsTop ?? waveformTop;
    this.drawAnalysisMarkers(ctx, cssWidth, rulerTop, rulerBottom, contentTop);
    this.drawBeatGrid(ctx, cssWidth, rulerBottom, contentTop, trackBottom);

    if (this.migrationPending) {
      this.emptyEl.textContent = "Run once to convert this legacy beat schedule into frames.";
    } else {
      this.emptyEl.textContent = this.clips.length ? "" : "Open Raw to repair the schedule, or add a prompt clip.";
    }
  }

  draw() {
    const cssWidth = Math.max(1, this.canvas.clientWidth);
    const cssHeight = Math.max(1, this.canvas.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(cssWidth * dpr);
    const height = Math.round(cssHeight * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.staticDirty = true;
    }
    if (this.staticCanvas.width !== width || this.staticCanvas.height !== height) {
      this.staticCanvas.width = width;
      this.staticCanvas.height = height;
      this.staticDirty = true;
    }

    const layout = this.timelineLayout(cssHeight);
    if (this.staticDirty) {
      const staticContext = this.staticCanvas.getContext("2d");
      staticContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      staticContext.clearRect(0, 0, cssWidth, cssHeight);
      staticContext.fillStyle = "#101013";
      staticContext.fillRect(0, 0, cssWidth, cssHeight);
      this.drawStatic(staticContext, cssWidth, cssHeight, layout);
      this.staticDirty = false;
    }

    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.staticCanvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawWriterActivity(ctx);
    this.drawGuidesAndPlayhead(ctx, cssWidth, layout);
    this.positionSongLabelEditor();
  }

  dispose() {
    this.closeContextMenu();
    document.removeEventListener("pointerdown", this.documentPointerHandler, true);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.pendingFrame) cancelAnimationFrame(this.pendingFrame);
    if (this.writerActivityFrame !== null) cancelAnimationFrame(this.writerActivityFrame);
    clearTimeout(this.writerActivityTimer);
    this.stopPlaybackLoop();
    clearTimeout(this.analysisTimer);
    clearTimeout(this.modelStatusTimer);
    clearTimeout(this.separationTimer);
    clearTimeout(this.transcriptionTimer);
    if (this.audioElement) this.audioElement.pause();
    this.analysisRequest++;
    for (const restore of this.callbackRestorers) restore();
    this.callbackRestorers = [];
    this.root.remove();
  }
}
