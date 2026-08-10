import { app } from "../../../../scripts/app.js";
import { parseEnvelopeLayers } from "./audio_envelope.js";
import {
  closeBeatPromptSequencerForNode,
  getBeatPromptSequencerEditor,
  openBeatPromptSequencer,
  updateBeatPromptSequencerStatus,
} from "./audio_prompt_sequencer_modal.js";
import {
  FORMAT_VERSION,
  isCompatibleFormatVersion,
  migrateRemovedBpmMethod,
  restoreCachedAudioWidgets,
} from "./audio_prompt_sequencer_format.js";

const COMPACT_NODE_WIDTH = 380;

function findWidget(node, name) {
  return (node.widgets || []).find((widget) => widget.name === name) || null;
}

function hideWidget(widget) {
  if (!widget) return;
  if (!widget.origType) widget.origType = widget.type;
  if (!widget.origComputeSize) widget.origComputeSize = widget.computeSize;
  widget.hidden = true;
  widget.computeSize = () => [0, -4];
  widget.computedHeight = 0;
  widget.type = "converted-widget";
  if (widget.element) widget.element.style.display = "none";
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function executionPayload(message) {
  const values = message?.fl_prompt_sequencer ?? message?.ui?.fl_prompt_sequencer;
  return Array.isArray(values) ? values[0] : values;
}

function compactNode(node, force) {
  node.min_size = [320, 120];
  requestAnimationFrame(() => {
    const computed = node.computeSize();
    const width = force
      ? COMPACT_NODE_WIDTH
      : Math.max(320, Math.min(node.size[0], 520));
    const height = Math.max(120, computed[1]);
    if (force || node.size[1] > height + 40 || node.size[0] > 520) {
      node.setSize([width, height]);
    }
  });
}

app.registerExtension({
  name: "ComfyUI.FL_Audio_Beat_Prompt_Schedule",

  beforeConfigureGraph(graphData) {
    migrateRemovedBpmMethod(graphData);
  },

  nodeCreated(node) {
    const comfyClass = node.constructor?.comfyClass || "";
    if (comfyClass !== "FL_Audio_Beat_Prompt_Schedule") return;

    const widgets = {
      timeline: findWidget(node, "timeline"),
      defaultFadeIn: findWidget(node, "default_fade_in"),
      defaultFadeOut: findWidget(node, "default_fade_out"),
      curve: findWidget(node, "curve"),
      timeUnit: findWidget(node, "time_unit"),
      fps: findWidget(node, "fps"),
      sequenceDuration: findWidget(node, "sequence_duration"),
      audioFile: findWidget(node, "audio_file"),
      trimStartFrame: findWidget(node, "trim_start_frame"),
      halfTime: findWidget(node, "half_time"),
      beatOffset: findWidget(node, "beat_offset_ms"),
      analysisSource: findWidget(node, "analysis_source"),
      beatGridDensity: findWidget(node, "beat_grid_density"),
      renderGroups: findWidget(node, "render_groups"),
      analysisCacheKey: findWidget(node, "analysis_cache_key"),
      envelopeLayers: findWidget(node, "envelope_layers"),
    };
    const hiddenWidgets = Object.values(widgets).filter(Boolean);
    for (const widget of hiddenWidgets) hideWidget(widget);

    const previousFormat = finiteNumber(node.properties?.flBeatPromptSequencer?.formatVersion);
    node.properties = node.properties || {};
    const savedSequencer = {
      ...(node.properties.flBeatPromptSequencer || {}),
      formatVersion: FORMAT_VERSION,
    };
    delete savedSequencer.magnetMode;
    delete savedSequencer.snapMode;
    if (!isCompatibleFormatVersion(previousFormat)) {
      savedSequencer.beatData = null;
      savedSequencer.sourceAnalysis = null;
      savedSequencer.viewStart = 0;
      savedSequencer.viewEnd = 0;
    }
    node.properties.flBeatPromptSequencer = savedSequencer;
    restoreCachedAudioWidgets(widgets, savedSequencer);
    const openWidget = node.addWidget("button", "Open Audio Prompt Sequencer", null, () => {
      openBeatPromptSequencer(node, widgets, statusWidget);
    }, { serialize: false });
    openWidget.serialize = false;
    const statusWidget = node.addWidget("text", "Timeline status", "", null, { serialize: false });
    statusWidget.disabled = true;
    statusWidget.serialize = false;
    updateBeatPromptSequencerStatus(node, widgets, statusWidget);
    compactNode(node, previousFormat !== FORMAT_VERSION);

    const originalOnExecuted = node.onExecuted;
    node.onExecuted = function (message) {
      originalOnExecuted?.apply(this, arguments);
      const editor = getBeatPromptSequencerEditor(node.id);
      if (editor) editor.updateFromExecution(message);
      else this._flSequencerExecutionMessage = message;
      updateBeatPromptSequencerStatus(this, widgets, statusWidget, editor, executionPayload(message));
    };

    const originalOnConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
      const result = originalOnConfigure?.apply(this, args);
      restoreCachedAudioWidgets(widgets, this.properties?.flBeatPromptSequencer);
      for (const widget of hiddenWidgets) hideWidget(widget);
      compactNode(this, false);
      const editor = getBeatPromptSequencerEditor(node.id);
      if (editor) {
        editor.envelopeSlots = parseEnvelopeLayers(widgets.envelopeLayers?.value);
        editor.renderEnvelopeEditor();
        editor.applyBeatOffset();
        editor.loadTimeline();
        editor.resnapClipsToGrid();
        editor.refreshBeatStatus();
        editor.scheduleDraw();
      }
      return result;
    };

    const originalOnConnectionsChange = node.onConnectionsChange;
    node.onConnectionsChange = function (type, slot) {
      const result = originalOnConnectionsChange?.apply(this, arguments);
      if (type === 1 && this.inputs?.[slot]?.name === "beat_positions") {
        getBeatPromptSequencerEditor(node.id)?.markBeatDataCached();
      }
      return result;
    };

    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function () {
      closeBeatPromptSequencerForNode(this);
      return originalOnRemoved?.apply(this, arguments);
    };
  },
});
