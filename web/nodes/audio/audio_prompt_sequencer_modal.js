import { app } from "../../../../scripts/app.js";
import { api } from "../../../../scripts/api.js";
import { parseEnvelopeLayers } from "./audio_envelope.js";
import { parseTimeline } from "./audio_prompt_timeline.js";
import { BeatPromptSequencer } from "./audio_prompt_sequencer_editor.js";
import { FORMAT_VERSION } from "./audio_prompt_sequencer_format.js";
import { BeatPromptWriter } from "./audio_prompt_writer.js";

const INSTANCES = new Map();
const MEDIA_FILE_RE = /\.(?:aac|aiff?|flac|m4a|mka|mkv|mov|mp3|mp4|oga|ogg|opus|wav|webm|wma)$/i;
let activeModal = null;

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function filenameFromPath(value) {
  const parts = String(value || "").replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "";
}

function isSupportedMediaFile(file) {
  return Boolean(
    file &&
    ((file.type || "").startsWith("audio/") ||
      (file.type || "").startsWith("video/") ||
      MEDIA_FILE_RE.test(file.name || "")),
  );
}

function setWidgetValue(widget, value) {
  if (!widget) return;
  widget.value = value;
  widget.callback?.call(widget, value);
}

function compactStatusText(node, widgets, editor = null, payload = null) {
  const audio = filenameFromPath(widgets.audioFile?.value) || "No audio selected";
  const frames = Math.max(0, Math.round(finiteNumber(widgets.sequenceDuration?.value)));
  const envelopeCount = (editor?.envelopeSlots || parseEnvelopeLayers(widgets.envelopeLayers?.value))
    .filter((layer) => layer?.enabled).length;
  const lyricCount = editor?.lyricsTimeline?.segments?.length ??
    node.properties?.flBeatPromptSequencer?.lyricsTimeline?.segments?.length ?? 0;
  let promptCount = editor?.clips?.length;
  if (!Number.isFinite(promptCount)) {
    try {
      promptCount = parseTimeline(
        widgets.timeline?.value || "",
        finiteNumber(widgets.defaultFadeIn?.value),
        finiteNumber(widgets.defaultFadeOut?.value),
      ).length;
    } catch {
      promptCount = 0;
    }
  }
  const bpm = finiteNumber(
    editor?.beatData?.gridBpm,
    finiteNumber(payload?.grid_bpm, payload?.bpm),
  );
  return `${audio} · ${promptCount} prompt${promptCount === 1 ? "" : "s"} · ` +
    `${envelopeCount} envelope${envelopeCount === 1 ? "" : "s"} · ` +
    `${lyricCount} lyric${lyricCount === 1 ? "" : "s"} · ` +
    `${frames || "auto"} frames${bpm > 0 ? ` · ${bpm.toFixed(2)} BPM` : ""}`;
}

function updateCompactStatus(node, widgets, statusWidget, editor = null, payload = null) {
  statusWidget.value = compactStatusText(node, widgets, editor, payload);
  app.graph?.setDirtyCanvas?.(true, false);
}

class BeatPromptSequencerModal {
  constructor(node, widgets, statusWidget) {
    this.node = node;
    this.widgets = widgets;
    this.statusWidget = statusWidget;
    this.editor = null;
    this.writer = null;
    this.libraryEntries = [];
    this.localEntries = [];
    this.libraryMode = "library";
    this.libraryCollapsed = Boolean(node.properties?.flBeatPromptSequencer?.libraryCollapsed);
    this.writerOpen = Boolean(node.properties?.flBeatPromptSequencer?.writerOpen);
    this.writerActivity = { phase: "idle", label: "" };
    this.writerActivityTimer = null;
    this.widgetRestorers = [];
    this.previousBodyOverflow = "";
    this.closed = false;
    this.build();
  }

  build() {
    this.overlay = document.createElement("div");
    this.overlay.className = "flbps-modal-overlay";
    this.overlay.setAttribute("role", "dialog");
    this.overlay.setAttribute("aria-modal", "true");
    this.overlay.innerHTML = `
      <div class="flbps-modal-shell">
        <div class="flbps-modal-header">
          <div class="flbps-modal-heading">
            <div class="flbps-modal-title">FL Audio Beat Prompt Sequencer</div>
            <div class="flbps-modal-subtitle" data-role="modal-subtitle"></div>
          </div>
          <span class="flbps-spacer"></span>
          <div class="flbps-history-controls" role="group" aria-label="Edit history">
            <button class="flbps-button" data-action="undo" disabled>Undo</button>
            <button class="flbps-button" data-action="redo" disabled>Redo</button>
          </div>
          <button class="flbps-button flbps-writer-toggle" data-action="toggle-writer" data-writer-state="idle" aria-expanded="false">
            <i class="flbps-writer-toggle-indicator" aria-hidden="true"></i>
            <span data-role="writer-toggle-label">Writer</span>
            <small data-role="writer-toggle-detail" aria-live="polite" hidden></small>
          </button>
          <button class="flbps-button primary flbps-modal-close" data-action="modal-close">Done</button>
        </div>
        <div class="flbps-modal-main">
          <aside class="flbps-library">
            <div class="flbps-library-section">
              <div class="flbps-library-label">Audio source</div>
              <div class="flbps-drop-zone" data-role="drop-zone">
                Drop an audio or video file here<br>or click to choose one
              </div>
              <div class="flbps-library-actions">
                <button class="flbps-button" data-action="choose-file" title="Upload one audio or video file into ComfyUI input">Choose file</button>
                <button class="flbps-button" data-action="choose-folder" title="Search a local folder; only the file you select is uploaded">Choose folder</button>
              </div>
              <div class="flbps-library-message" data-role="library-message"></div>
            </div>
            <div class="flbps-library-section">
              <div class="flbps-library-tabs">
                <button class="flbps-button active" data-source="library">Comfy input</button>
                <button class="flbps-button" data-source="local">Local folder</button>
              </div>
              <input class="flbps-library-search" data-role="library-search" type="search" placeholder="Search audio files or folders">
              <select class="flbps-library-folder" data-role="library-folder" aria-label="Filter audio folder"></select>
            </div>
            <div class="flbps-library-results" data-role="library-results"></div>
            <div class="flbps-library-section">
              <div class="flbps-library-actions">
                <button class="flbps-button" data-action="refresh-library">Refresh input</button>
              </div>
            </div>
            <div class="flbps-library-section">
              <div class="flbps-library-label">Sequence settings</div>
              <div class="flbps-settings">
                <div class="flbps-setting" title="Frames per second used by the timeline and rendered video"><label>FPS</label><input data-setting="fps" type="number" min="1" max="240" step="0.001"></div>
                <div class="flbps-setting" title="Maximum sequence length in frames; zero uses the remaining audio"><label>Length frames</label><input data-setting="length" type="number" min="0" max="864000" step="1"></div>
                <div class="flbps-setting" title="Default number of frames used to fade a prompt in"><label>Default fade in</label><input data-setting="fade-in" type="number" min="0" max="864000" step="1"></div>
                <div class="flbps-setting" title="Default number of frames used to fade a prompt out"><label>Default fade out</label><input data-setting="fade-out" type="number" min="0" max="864000" step="1"></div>
                <div class="flbps-setting" title="Shape used for prompt fade-ins and fade-outs"><label>Curve</label><select data-setting="curve"><option value="linear">Linear</option><option value="cosine">Cosine</option></select></div>
                <div class="flbps-setting" title="Analyze the full mix or a previously separated stem"><label>Analysis source</label><select data-setting="analysis-source"><option value="mix">Mix</option><option value="drums">Drums</option><option value="vocals">Vocals</option><option value="bass">Bass</option><option value="other">Other</option></select></div>
                <div class="flbps-setting checkbox" title="Use every other detected beat and report half the detected BPM"><input data-setting="half-time" type="checkbox"><label>Half-time</label></div>
              </div>
            </div>
            <button class="flbps-sidebar-toggle" data-action="toggle-library" type="button" aria-expanded="true" aria-label="Hide audio library and sequence settings" title="Hide audio library and sequence settings">&lsaquo;</button>
          </aside>
          <main class="flbps-editor-host" data-role="editor-host"></main>
          <aside class="flbps-writer-host" data-role="writer-host"></aside>
        </div>
      </div>
    `;
    this.shell = this.overlay.querySelector(".flbps-modal-shell");
    this.subtitle = this.overlay.querySelector('[data-role="modal-subtitle"]');
    this.library = this.overlay.querySelector(".flbps-library");
    this.results = this.overlay.querySelector('[data-role="library-results"]');
    this.searchInput = this.overlay.querySelector('[data-role="library-search"]');
    this.folderSelect = this.overlay.querySelector('[data-role="library-folder"]');
    this.libraryMessage = this.overlay.querySelector('[data-role="library-message"]');
    this.dropZone = this.overlay.querySelector('[data-role="drop-zone"]');
    this.editorHost = this.overlay.querySelector('[data-role="editor-host"]');
    this.writerHost = this.overlay.querySelector('[data-role="writer-host"]');
    this.writerButton = this.overlay.querySelector('[data-action="toggle-writer"]');
    this.undoButton = this.overlay.querySelector('[data-action="undo"]');
    this.redoButton = this.overlay.querySelector('[data-action="redo"]');
    this.writerButtonLabel = this.writerButton.querySelector('[data-role="writer-toggle-label"]');
    this.writerButtonDetail = this.writerButton.querySelector('[data-role="writer-toggle-detail"]');
    this.writerButtonIndicator = this.writerButton.querySelector(".flbps-writer-toggle-indicator");
    this.libraryToggle = this.overlay.querySelector('[data-action="toggle-library"]');
    this.syncLibraryVisibility();
    this.syncWriterVisibility();

    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = "audio/*,video/*,.aac,.aiff,.flac,.m4a,.mka,.mkv,.mov,.mp3,.mp4,.oga,.ogg,.opus,.wav,.webm,.wma";
    this.fileInput.hidden = true;
    this.folderInput = document.createElement("input");
    this.folderInput.type = "file";
    this.folderInput.multiple = true;
    this.folderInput.webkitdirectory = true;
    this.folderInput.hidden = true;
    this.library.append(this.fileInput, this.folderInput);

    this.overlay.querySelector('[data-action="modal-close"]').addEventListener("click", () => this.close());
    this.undoButton.addEventListener("click", () => {
      this.editor?.commitFocusedEdit();
      this.editor?.undo();
    });
    this.redoButton.addEventListener("click", () => {
      this.editor?.commitFocusedEdit();
      this.editor?.redo();
    });
    this.writerButton.addEventListener("click", () => this.toggleWriter());
    this.libraryToggle.addEventListener("click", () => this.toggleLibrary());
    this.overlay.addEventListener("pointerdown", (event) => {
      if (event.target === this.overlay) this.close();
    });
    for (const type of ["pointerdown", "pointermove", "pointerup", "wheel"]) {
      this.shell.addEventListener(type, (event) => event.stopPropagation(), { passive: type === "wheel" });
    }
    this.keyHandler = (event) => {
      const editingText = event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        event.target?.isContentEditable;
      const command = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (command && !event.altKey && !editingText &&
          (key === "z" || (key === "y" && !event.shiftKey))) {
        event.preventDefault();
        event.stopPropagation();
        if (key === "y" || event.shiftKey) this.editor?.redo();
        else this.editor?.undo();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      } else if ((event.code === "Space" || event.key === " ") &&
          !(event.target instanceof HTMLInputElement) &&
          !(event.target instanceof HTMLTextAreaElement) &&
          !(event.target instanceof HTMLSelectElement) &&
          !(event.target instanceof HTMLButtonElement) &&
          !event.target?.isContentEditable) {
        event.preventDefault();
        if (!event.repeat) this.editor?.togglePlayback();
      }
    };
    this.overlay.addEventListener("keydown", this.keyHandler);

    this.dropZone.addEventListener("click", () => this.chooseFile());
    this.overlay.querySelector('[data-action="choose-file"]').addEventListener("click", () => this.chooseFile());
    this.overlay.querySelector('[data-action="choose-folder"]').addEventListener("click", () => this.chooseFolder());
    this.overlay.querySelector('[data-action="refresh-library"]').addEventListener("click", () => this.refreshLibrary());
    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files?.[0];
      if (file) this.uploadFile(file);
    });
    this.folderInput.addEventListener("change", () => this.loadLocalFolder());
    this.searchInput.addEventListener("input", () => this.renderFiles());
    this.folderSelect.addEventListener("change", () => this.renderFiles(false));
    for (const button of this.overlay.querySelectorAll("[data-source]")) {
      button.addEventListener("click", () => this.setLibraryMode(button.dataset.source));
    }
    this.library.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      this.dropZone.classList.add("dragging");
    });
    this.library.addEventListener("dragleave", (event) => {
      if (!this.library.contains(event.relatedTarget)) this.dropZone.classList.remove("dragging");
    });
    this.library.addEventListener("drop", (event) => {
      event.preventDefault();
      this.dropZone.classList.remove("dragging");
      const file = [...(event.dataTransfer?.files || [])].find(isSupportedMediaFile);
      if (file) this.uploadFile(file);
      else this.setLibraryMessage("Drop a supported audio file or a video containing audio.", true);
    });
  }

  show() {
    if (activeModal && activeModal !== this) activeModal.close();
    activeModal = this;
    this.previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.body.appendChild(this.overlay);
    this.editor = new BeatPromptSequencer({
      node: this.node,
      container: this.editorHost,
      widgets: this.widgets,
      onStateChange: () => this.handleEditorState(),
      onHistoryChange: () => this.syncHistoryControls(),
    });
    this.writer = new BeatPromptWriter({
      node: this.node,
      editor: this.editor,
      container: this.writerHost,
      onActivityChange: (activity) => this.updateWriterActivity(activity),
    });
    INSTANCES.set(this.node.id, this.editor);
    this.syncHistoryControls();
    this.bindSettings();
    this.syncSettings();
    const pending = this.node._flSequencerExecutionMessage;
    if (pending) {
      this.editor.updateFromExecution(pending);
      this.node._flSequencerExecutionMessage = null;
    }
    this.refreshLibrary();
    requestAnimationFrame(() => {
      this.shell.tabIndex = -1;
      this.shell.focus({ preventScroll: true });
      this.editor.scheduleDraw();
    });
  }

  bindSettings() {
    const labels = {
      fps: "Change FPS",
      length: "Change sequence length",
      "fade-in": "Change default fade in",
      "fade-out": "Change default fade out",
      curve: "Change fade curve",
      "analysis-source": "Change analysis source",
      "half-time": "Toggle half-time",
    };
    this.settingSpecs = {
      fps: { widget: this.widgets.fps, parse: (value) => clamp(finiteNumber(value, 24), 1, 240) },
      length: { widget: this.widgets.sequenceDuration, parse: (value) => clamp(Math.round(finiteNumber(value)), 0, 864000) },
      "fade-in": { widget: this.widgets.defaultFadeIn, parse: (value) => clamp(Math.round(finiteNumber(value)), 0, 864000) },
      "fade-out": { widget: this.widgets.defaultFadeOut, parse: (value) => clamp(Math.round(finiteNumber(value)), 0, 864000) },
      curve: { widget: this.widgets.curve, parse: String },
      "analysis-source": { widget: this.widgets.analysisSource, parse: String },
      "half-time": { widget: this.widgets.halfTime, parse: Boolean },
    };
    for (const [name, spec] of Object.entries(this.settingSpecs)) {
      const control = this.overlay.querySelector(`[data-setting="${name}"]`);
      control.addEventListener("change", () => {
        const raw = control.type === "checkbox" ? control.checked : control.value;
        this.editor.runEdit(labels[name], () => setWidgetValue(spec.widget, spec.parse(raw)));
      });
    }
    const syncedWidgets = [
      ...Object.values(this.settingSpecs).map((spec) => spec.widget),
      this.widgets.audioFile,
    ].filter(Boolean);
    for (const widget of syncedWidgets) {
      const original = widget.callback;
      const wrapped = (value) => {
        const result = original?.call(widget, value);
        this.syncSettings();
        if (widget === this.widgets.audioFile) this.renderFiles();
        return result;
      };
      widget.callback = wrapped;
      this.widgetRestorers.push(() => {
        if (widget.callback === wrapped) widget.callback = original;
      });
    }
  }

  syncSettings() {
    for (const [name, spec] of Object.entries(this.settingSpecs || {})) {
      const control = this.overlay.querySelector(`[data-setting="${name}"]`);
      if (!control) continue;
      if (control.type === "checkbox") control.checked = Boolean(spec.widget?.value);
      else control.value = String(spec.widget?.value ?? "");
    }
    const audio = String(this.widgets.audioFile?.value || "");
    this.subtitle.textContent = audio
      ? `${audio} · edits save directly to the node`
      : "Choose audio from Comfy input, drag a file, or browse a local folder";
    updateCompactStatus(this.node, this.widgets, this.statusWidget, this.editor);
  }

  handleEditorState() {
    this.syncSettings();
    this.syncHistoryControls();
  }

  syncHistoryControls() {
    if (!this.undoButton || !this.redoButton) return;
    const undoLabel = this.editor?.nextUndoLabel() || "";
    const redoLabel = this.editor?.nextRedoLabel() || "";
    this.undoButton.disabled = !this.editor?.canUndo();
    this.redoButton.disabled = !this.editor?.canRedo();
    this.undoButton.title = undoLabel ? `Undo ${undoLabel} (Ctrl/Cmd+Z)` : "Nothing to undo";
    this.redoButton.title = redoLabel ? `Redo ${redoLabel} (Ctrl/Cmd+Shift+Z or Ctrl+Y)` : "Nothing to redo";
  }

  syncLibraryVisibility() {
    this.shell.classList.toggle("library-collapsed", this.libraryCollapsed);
    const expanded = !this.libraryCollapsed;
    const action = expanded ? "Hide" : "Show";
    this.libraryToggle.textContent = expanded ? "\u2039" : "\u203a";
    this.libraryToggle.setAttribute("aria-expanded", String(expanded));
    this.libraryToggle.setAttribute("aria-label", `${action} audio library and sequence settings`);
    this.libraryToggle.title = `${action} audio library and sequence settings`;
  }

  toggleLibrary() {
    this.libraryCollapsed = !this.libraryCollapsed;
    this.node.properties = this.node.properties || {};
    this.node.properties.flBeatPromptSequencer = {
      ...(this.node.properties.flBeatPromptSequencer || {}),
      formatVersion: FORMAT_VERSION,
      libraryCollapsed: this.libraryCollapsed,
    };
    this.syncLibraryVisibility();
    this.node.graph?.change?.();
    setTimeout(() => this.editor?.scheduleDraw(), 180);
  }

  syncWriterVisibility() {
    this.shell.classList.toggle("writer-open", this.writerOpen);
    this.writerButton?.classList.toggle("active", this.writerOpen);
    if (this.writerButton) {
      this.writerButton.setAttribute("aria-expanded", String(this.writerOpen));
      this.renderWriterActivity();
    }
  }

  updateWriterActivity(activity) {
    if (this.closed) return;
    clearTimeout(this.writerActivityTimer);
    this.writerActivityTimer = null;
    this.writerActivity = activity || { phase: "idle", label: "" };
    this.renderWriterActivity();
    if (["applied", "complete", "no_changes", "stopped"].includes(this.writerActivity.phase)) {
      this.writerActivityTimer = setTimeout(() => {
        this.writerActivity = { phase: "idle", label: "" };
        this.renderWriterActivity();
      }, this.writerActivity.phase === "applied" ? 5000 : 3500);
    }
  }

  renderWriterActivity() {
    if (!this.writerButton) return;
    const activity = this.writerActivity || { phase: "idle", label: "" };
    const active = ["connecting", "reading", "drafting", "preparing", "editing", "applying", "stopping"].includes(activity.phase);
    const action = this.writerOpen ? "Hide Writer" : "Writer";
    const progress = activity.progressTotal
      ? `${activity.progressCompleted || 0}/${activity.progressTotal}`
      : activity.label;
    this.writerButton.dataset.writerState = activity.phase;
    this.writerButton.classList.toggle("writer-running", active);
    this.writerButtonLabel.textContent = action;
    this.writerButtonDetail.textContent = progress ? `\u00b7 ${progress}` : "";
    this.writerButtonDetail.hidden = !progress || activity.phase === "idle";
    this.writerButtonIndicator.textContent = ["applied", "complete", "no_changes"].includes(activity.phase)
      ? "\u2713"
      : activity.phase === "error"
      ? "!"
      : "";
    this.writerButton.setAttribute(
      "aria-label",
      `${this.writerOpen ? "Hide" : "Show"} Beat Writer${activity.label ? `. ${activity.label}` : ""}`,
    );
  }

  toggleWriter() {
    this.writerOpen = !this.writerOpen;
    this.node.properties = this.node.properties || {};
    this.node.properties.flBeatPromptSequencer = {
      ...(this.node.properties.flBeatPromptSequencer || {}),
      formatVersion: FORMAT_VERSION,
      writerOpen: this.writerOpen,
    };
    this.syncWriterVisibility();
    this.node.graph?.change?.();
    setTimeout(() => this.editor?.scheduleDraw(), 180);
  }

  chooseFile() {
    this.fileInput.value = "";
    this.fileInput.click();
  }

  chooseFolder() {
    this.folderInput.value = "";
    this.folderInput.click();
  }

  loadLocalFolder() {
    this.localEntries = [...(this.folderInput.files || [])]
      .filter(isSupportedMediaFile)
      .map((file) => {
        const path = (file.webkitRelativePath || file.name).replace(/\\/g, "/");
        const slash = path.lastIndexOf("/");
        return {
          path,
          folder: slash >= 0 ? path.slice(0, slash) : "",
          size: file.size,
          file,
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: "base" }));
    this.setLibraryMode("local");
    this.setLibraryMessage(
      this.localEntries.length
        ? `${this.localEntries.length} supported files found. Only the file you select will upload.`
        : "No supported audio or video files were found in that folder.",
      !this.localEntries.length,
    );
  }

  setLibraryMode(mode) {
    this.libraryMode = mode === "local" ? "local" : "library";
    for (const button of this.overlay.querySelectorAll("[data-source]")) {
      button.classList.toggle("active", button.dataset.source === this.libraryMode);
    }
    this.renderFiles(true);
  }

  setLibraryMessage(message, error = false) {
    this.libraryMessage.textContent = message;
    this.libraryMessage.style.color = error ? "#fca5a5" : "#8b8b95";
  }

  async refreshLibrary() {
    this.setLibraryMessage("Refreshing ComfyUI input audio…");
    try {
      const response = await api.fetchApi("/fl/audio-prompt-timeline/files");
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Audio library refresh failed (${response.status}).`);
      this.libraryEntries = Array.isArray(payload.files) ? payload.files : [];
      const values = this.widgets.audioFile?.options?.values;
      if (Array.isArray(values)) {
        for (const entry of this.libraryEntries) {
          if (!values.includes(entry.path)) values.push(entry.path);
        }
      }
      this.setLibraryMessage(`${this.libraryEntries.length} files available in ComfyUI input.`);
      this.renderFiles(true);
    } catch (error) {
      this.setLibraryMessage(error.message, true);
    }
  }

  renderFiles(resetFolder = false) {
    const entries = this.libraryMode === "local" ? this.localEntries : this.libraryEntries;
    const folders = [...new Set(entries.map((entry) => entry.folder || ""))]
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
    const previousFolder = resetFolder ? "" : this.folderSelect.value;
    this.folderSelect.replaceChildren();
    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "All folders";
    this.folderSelect.appendChild(allOption);
    for (const folder of folders) {
      const option = document.createElement("option");
      option.value = folder;
      option.textContent = folder || "Input root";
      this.folderSelect.appendChild(option);
    }
    if (folders.includes(previousFolder)) this.folderSelect.value = previousFolder;

    const search = this.searchInput.value.trim().toLocaleLowerCase();
    const folder = this.folderSelect.value;
    const filtered = entries.filter((entry) => {
      if (folder && entry.folder !== folder) return false;
      return !search || entry.path.toLocaleLowerCase().includes(search);
    });
    this.results.replaceChildren();
    const selected = String(this.widgets.audioFile?.value || "").replace(/\\/g, "/");
    for (const entry of filtered.slice(0, 500)) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "flbps-file-row";
      if (this.libraryMode === "library" && entry.path === selected) row.classList.add("selected");
      const name = document.createElement("span");
      name.className = "flbps-file-name";
      name.textContent = filenameFromPath(entry.path);
      const folderLabel = document.createElement("span");
      folderLabel.className = "flbps-file-folder";
      folderLabel.textContent = entry.folder || (this.libraryMode === "library" ? "ComfyUI/input" : "Selected folder");
      row.append(name, folderLabel);
      row.addEventListener("click", () => {
        if (this.libraryMode === "local") this.uploadFile(entry.file);
        else this.selectAudioPath(entry.path);
      });
      this.results.appendChild(row);
    }
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "flbps-library-message";
      empty.style.padding = "10px";
      empty.textContent = this.libraryMode === "local"
        ? "Choose a folder, then search its audio files here."
        : "No ComfyUI input files match this search.";
      this.results.appendChild(empty);
    } else if (filtered.length > 500) {
      const more = document.createElement("div");
      more.className = "flbps-library-message";
      more.style.padding = "8px";
      more.textContent = `Showing the first 500 of ${filtered.length} matches. Refine the search to narrow the list.`;
      this.results.appendChild(more);
    }
  }

  selectAudioPath(path) {
    const values = this.widgets.audioFile?.options?.values;
    if (Array.isArray(values) && !values.includes(path)) values.push(path);
    setWidgetValue(this.widgets.audioFile, path);
    this.node.graph?.change?.();
    this.setLibraryMessage(`Loaded ${filenameFromPath(path)}.`);
    this.renderFiles();
  }

  async uploadFile(file) {
    if (!isSupportedMediaFile(file)) {
      this.setLibraryMessage("Choose a supported audio file or video containing audio.", true);
      return;
    }
    this.setLibraryMessage(`Uploading ${file.name}…`);
    try {
      const body = new FormData();
      body.append("image", file);
      body.append("type", "input");
      const response = await api.fetchApi("/upload/image", { method: "POST", body });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Upload failed (${response.status}).`);
      const path = [payload.subfolder, payload.name].filter(Boolean).join("/").replace(/\\/g, "/");
      this.selectAudioPath(path);
      await this.refreshLibrary();
    } catch (error) {
      this.setLibraryMessage(error.message, true);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.writerActivityTimer);
    for (const restore of this.widgetRestorers.reverse()) restore();
    this.widgetRestorers = [];
    this.writer?.destroy();
    this.writer = null;
    if (this.editor) {
      this.editor.saveViewState();
      this.editor.dispose();
      INSTANCES.delete(this.node.id);
      this.editor = null;
    }
    this.overlay.removeEventListener("keydown", this.keyHandler);
    this.overlay.remove();
    document.body.style.overflow = this.previousBodyOverflow;
    if (activeModal === this) activeModal = null;
    updateCompactStatus(this.node, this.widgets, this.statusWidget);
  }
}

export function openBeatPromptSequencer(node, widgets, statusWidget) {
  const modal = new BeatPromptSequencerModal(node, widgets, statusWidget);
  modal.show();
  return modal;
}

export function getBeatPromptSequencerEditor(nodeId) {
  return INSTANCES.get(nodeId);
}

export function closeBeatPromptSequencerForNode(node) {
  if (activeModal?.node === node) activeModal.close();
}

export { updateCompactStatus as updateBeatPromptSequencerStatus };
