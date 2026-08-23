import { PromptWriterClient } from "./audio_prompt_writer_client.js";
import { renderWriterMarkdown } from "./audio_prompt_writer_markdown.js";

const NODE_DEFAULTS = {
  guideMode: "video_prompt_guide",
  scope: "all",
  context: "",
};

const STARTERS = [
  ["Rewrite with the guide", "Rewrite every prompt box using the complete packaged prompt-writing guide while preserving the story and timing."],
  ["Strengthen continuity", "Strengthen visual and narrative continuity across these prompt boxes. Keep each beat distinct and actionable."],
  ["Make action explicit", "Make the physical action, camera behavior, and scene construction more explicit in every prompt that needs it."],
  ["Review first", "Review the current prompt sequence for continuity, clarity, and guide compliance. Do not edit anything yet."],
];

const MAX_CHAT_ATTACHMENTS = 8;
const MAX_CHAT_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const CHAT_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function createId() {
  return globalThis.crypto?.randomUUID?.() || `writer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nodeSettings(node) {
  const saved = node.properties?.flBeatPromptSequencer?.writer;
  return {
    ...NODE_DEFAULTS,
    ...(saved && typeof saved === "object" ? {
      guideMode: saved.guideMode,
      scope: saved.scope,
      context: saved.context,
      schedulerId: saved.schedulerId,
    } : {}),
    schedulerId: saved?.schedulerId || createId(),
  };
}

function option(value, label) {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

function relativeTime(value) {
  const time = new Date(value || Date.now());
  const seconds = Math.max(0, Math.floor((Date.now() - time.getTime()) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return time.toLocaleDateString([], { month: "short", day: "numeric" });
}

function iconButton(action, icon, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "flbps-writer-icon-button";
  button.dataset.writerAction = action;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.textContent = icon;
  return button;
}

export class BeatPromptWriter {
  constructor({ node, editor, container, onActivityChange = null }) {
    this.node = node;
    this.editor = editor;
    this.container = container;
    this.onActivityChange = onActivityChange;
    this.client = new PromptWriterClient();
    this.nodeSettings = nodeSettings(node);
    this.settings = null;
    this.status = null;
    this.conversations = [];
    this.archivedConversations = [];
    this.conversationId = null;
    this.messages = [];
    this.running = false;
    this.currentDocument = null;
    this.currentAssistant = null;
    this.currentAssistantText = "";
    this.pendingAssistantText = "";
    this.assistantRenderFrame = null;
    this.activeTools = new Map();
    this.followOutput = true;
    this.historyArchived = false;
    this.renamingConversationId = null;
    this.retryRequest = null;
    this.pendingAttachments = [];
    this.uploadingAttachments = false;
    this.composerDragDepth = 0;
    this.confirmResolver = null;
    this.applicationAck = null;
    this.runUpdatesAcknowledged = false;
    this.writerActivity = { phase: "idle", label: "", scopeIndices: [], targetIndices: [], appliedIndices: [] };
    this.runProgress = {
      version: -1,
      phase: "idle",
      targetIndices: [],
      completedIndices: [],
      activeIndex: null,
      failedIndex: null,
    };
    this.destroyed = false;
    this.build();
    this.saveNodeSettings();
    this.initialize();
  }

  build() {
    this.root = document.createElement("div");
    this.root.className = "flbps-writer flbps-writer-chat";
    this.root.innerHTML = `
      <header class="flbps-writer-topbar">
        <button class="flbps-writer-provider" data-writer-action="settings" title="Open model settings">
          <span class="flbps-writer-provider-mark" data-writer-role="provider-mark">AI</span>
          <span class="flbps-writer-provider-copy">
            <span class="flbps-writer-brand"><i class="flbps-writer-connection-dot"></i>Beat Writer</span>
            <small><strong data-writer-role="provider-name">Model</strong><span> / </span><span data-writer-role="provider-model">Checking...</span></small>
          </span>
        </button>
        <span class="flbps-spacer"></span>
        <button class="flbps-writer-icon-button" data-writer-action="new" title="New conversation" aria-label="New conversation">+</button>
        <div class="flbps-writer-menu-wrap">
          <button class="flbps-writer-icon-button" data-writer-action="toggle-menu" title="More" aria-label="More">...</button>
          <div class="flbps-writer-menu" data-writer-role="menu" hidden>
            <button data-writer-action="history">Conversation history</button>
            <button data-writer-action="settings">Model and writing settings</button>
            <button data-writer-action="new">Start a new chat</button>
          </div>
        </div>
      </header>
      <div class="flbps-writer-conversation-bar">
        <span class="flbps-writer-conversation-title" data-writer-role="conversation-title">New chat</span>
        <button class="flbps-writer-quiet-action" data-writer-action="undo" title="Undo the latest applied Writer edit">Undo edit</button>
      </div>
      <section class="flbps-writer-view active" data-writer-view="chat">
        <div class="flbps-writer-banner" data-writer-role="status" aria-live="polite"><i></i><span>Connecting...</span></div>
        <div class="flbps-writer-messages" data-writer-role="messages">
          <section class="flbps-writer-welcome" data-writer-role="welcome">
            <div class="flbps-writer-welcome-mark">W</div>
            <h3>Write the whole sequence together.</h3>
            <p>Chat about the story, review the timeline, or ask Beat Writer to revise prompt boxes with the complete guide.</p>
            <div class="flbps-writer-starters" data-writer-role="starters"></div>
          </section>
          <div class="flbps-writer-thread" data-writer-role="thread"></div>
        </div>
        <button class="flbps-writer-jump" data-writer-action="jump-latest" hidden>Jump to latest <span>down</span></button>
        <div class="flbps-writer-error" data-writer-role="error" hidden>
          <span data-writer-role="error-text"></span>
          <button data-writer-action="retry">Retry</button>
          <button data-writer-action="dismiss-error" aria-label="Dismiss">x</button>
        </div>
        <div class="flbps-writer-run-status" data-writer-role="run-status" hidden>
          <span class="flbps-writer-spinner"></span><span data-writer-role="run-label">Writing response...</span>
          <button data-writer-action="stop">Stop</button>
        </div>
        <div class="flbps-writer-composer-card">
          <div class="flbps-writer-composer-options">
            <label><span>Scope</span><select data-writer-node-setting="scope" title="Prompt boxes available to the Writer">
              <option value="all">All boxes</option>
              <option value="selected">Selected</option>
              <option value="selected_onward">Selected onward</option>
            </select></label>
            <label><span>Think</span><select data-writer-role="composer-reasoning" title="Reasoning for the next response"></select></label>
          </div>
          <div class="flbps-writer-attachments" data-writer-role="attachments" hidden></div>
          <textarea class="flbps-writer-composer" data-writer-role="composer" placeholder="Message Beat Writer..." rows="3"></textarea>
          <div class="flbps-writer-composer-footer">
            <button class="flbps-writer-attach" data-writer-action="attach-images" type="button" title="Attach images to this message" aria-label="Attach images to this message">clip</button>
            <input data-writer-role="attachment-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
            <span>Enter to send / Shift+Enter for a new line</span>
            <button class="flbps-writer-send" data-writer-action="send" title="Send message" aria-label="Send message">up</button>
          </div>
        </div>
      </section>
      <section class="flbps-writer-view flbps-writer-sheet" data-writer-view="settings">
        <div class="flbps-writer-sheet-header"><button class="flbps-writer-icon-button" data-writer-action="chat" aria-label="Back">back</button><div><strong>Settings</strong><small>Connection and writing behavior</small></div></div>
        <div class="flbps-writer-sheet-body">
          <details class="flbps-writer-settings-card" open><summary><span>Connection</span><em data-writer-role="connection-pill">Checking</em></summary><div>
            <label>Provider<select data-writer-setting="provider"></select></label>
            <label data-writer-role="base-url-row">Base URL<input data-writer-setting="base-url" type="url" spellcheck="false"></label>
            <label>Model<div class="flbps-writer-inline"><input data-writer-setting="model" type="text" list="flbps-writer-models" spellcheck="false"><button data-writer-action="models">Refresh</button></div></label>
            <datalist id="flbps-writer-models"></datalist>
            <label>Default reasoning<select data-writer-setting="reasoning"></select></label>
            <div class="flbps-writer-setting-row"><label>Temperature<input data-writer-setting="temperature" type="number" min="0" max="2" step="0.1"></label><label>Max tokens<input data-writer-setting="max-tokens" type="number" min="256" max="32768" step="256"></label></div>
            <label data-writer-role="credential-row">API key<div class="flbps-writer-inline"><input data-writer-setting="credential" type="password" autocomplete="off" placeholder="Stored in your OS keychain"><button data-writer-action="clear-credential">Clear</button></div></label>
            <div class="flbps-writer-subscription" data-writer-role="subscription-row" hidden><p data-writer-role="subscription-status"></p><button data-writer-action="subscription-login">Sign in</button><button data-writer-action="subscription-refresh">Refresh</button></div>
            <button class="flbps-writer-settings-save" data-writer-action="save-settings">Save and test connection</button>
          </div></details>
          <details class="flbps-writer-settings-card" open><summary><span>Writing</span><em>Prompt-only</em></summary><div>
            <label>Prompt guide<select data-writer-node-setting="guide-mode"><option value="video_prompt_guide">Complete packaged guide</option><option value="preserve">Preserve current format</option><option value="freeform">Freeform with guide reference</option></select></label>
            <label>Story bible / persistent context<textarea data-writer-node-setting="context" placeholder="Characters, style rules, continuity, and story intent"></textarea></label>
            <p class="flbps-writer-scope-note">Beat Writer can inspect attached reference images and replace prompt text in the selected scope. Images stay read-only; it cannot change timing, nodes, files, or workflow structure.</p>
          </div></details>
        </div>
      </section>
      <section class="flbps-writer-view flbps-writer-sheet" data-writer-view="history">
        <div class="flbps-writer-sheet-header"><button class="flbps-writer-icon-button" data-writer-action="chat" aria-label="Back">back</button><div><strong>History</strong><small>Conversations for this scheduler</small></div><span class="flbps-spacer"></span><button class="flbps-writer-icon-button" data-writer-action="new" aria-label="New conversation">+</button></div>
        <div class="flbps-writer-history-tools">
          <div class="flbps-writer-history-tabs"><button data-writer-action="history-mode" data-history-mode="active" class="active">Active</button><button data-writer-action="history-mode" data-history-mode="archived">Archived</button></div>
          <input type="search" data-writer-role="history-search" placeholder="Search conversations">
        </div>
        <div class="flbps-writer-history" data-writer-role="history-list"></div>
      </section>
      <div class="flbps-writer-toast" data-writer-role="toast" role="status" hidden></div>
      <div class="flbps-writer-confirm" data-writer-role="confirm" hidden>
        <div><strong data-writer-role="confirm-title">Are you sure?</strong><p data-writer-role="confirm-message"></p><footer><button data-writer-action="confirm-no">Cancel</button><button class="danger" data-writer-action="confirm-yes">Delete</button></footer></div>
      </div>
      <div class="flbps-writer-image-preview" data-writer-role="image-preview" hidden>
        <div>
          <button data-writer-action="close-image-preview" type="button" aria-label="Close image preview">x</button>
          <img data-writer-role="image-preview-image" alt="">
          <span data-writer-role="image-preview-label"></span>
        </div>
      </div>
    `;
    this.container.appendChild(this.root);
    this.messagesElement = this.root.querySelector('[data-writer-role="messages"]');
    this.threadElement = this.root.querySelector('[data-writer-role="thread"]');
    this.welcomeElement = this.root.querySelector('[data-writer-role="welcome"]');
    this.statusElement = this.root.querySelector('[data-writer-role="status"]');
    this.statusText = this.statusElement.querySelector("span");
    this.composer = this.root.querySelector('[data-writer-role="composer"]');
    this.composerCard = this.root.querySelector(".flbps-writer-composer-card");
    this.attachmentTray = this.root.querySelector('[data-writer-role="attachments"]');
    this.attachmentInput = this.root.querySelector('[data-writer-role="attachment-input"]');
    this.imagePreview = this.root.querySelector('[data-writer-role="image-preview"]');
    this.sendButton = this.root.querySelector('[data-writer-action="send"]');
    this.runStatus = this.root.querySelector('[data-writer-role="run-status"]');
    this.runLabel = this.root.querySelector('[data-writer-role="run-label"]');
    this.jumpButton = this.root.querySelector('[data-writer-action="jump-latest"]');
    this.errorElement = this.root.querySelector('[data-writer-role="error"]');
    this.reasoningComposer = this.root.querySelector('[data-writer-role="composer-reasoning"]');
    this.providerSelect = this.root.querySelector('[data-writer-setting="provider"]');
    this.baseUrlInput = this.root.querySelector('[data-writer-setting="base-url"]');
    this.modelInput = this.root.querySelector('[data-writer-setting="model"]');
    this.modelOptions = this.root.querySelector("#flbps-writer-models");
    this.reasoningSelect = this.root.querySelector('[data-writer-setting="reasoning"]');
    this.temperatureInput = this.root.querySelector('[data-writer-setting="temperature"]');
    this.maxTokensInput = this.root.querySelector('[data-writer-setting="max-tokens"]');
    this.credentialInput = this.root.querySelector('[data-writer-setting="credential"]');
    this.historySearch = this.root.querySelector('[data-writer-role="history-search"]');
    this.historyList = this.root.querySelector('[data-writer-role="history-list"]');
    this.nodeControls = {
      scope: this.root.querySelector('[data-writer-node-setting="scope"]'),
      guideMode: this.root.querySelector('[data-writer-node-setting="guide-mode"]'),
      context: this.root.querySelector('[data-writer-node-setting="context"]'),
    };
    this.nodeControls.scope.value = this.nodeSettings.scope;
    this.nodeControls.guideMode.value = this.nodeSettings.guideMode;
    this.nodeControls.context.value = this.nodeSettings.context;
    const starters = this.root.querySelector('[data-writer-role="starters"]');
    for (const [label, prompt] of STARTERS) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.writerAction = "starter";
      button.dataset.prompt = prompt;
      button.textContent = label;
      starters.appendChild(button);
    }

    this.root.addEventListener("click", (event) => {
      this.handleAction(event).catch((error) => this.showError(error.message));
    });
    this.providerSelect.addEventListener("change", () => this.applyProviderPreset());
    for (const [name, control] of Object.entries(this.nodeControls)) {
      control.addEventListener(name === "context" ? "input" : "change", () => {
        this.nodeSettings[name] = control.value;
        this.saveNodeSettings();
      });
    }
    this.composer.addEventListener("input", () => this.updateComposer());
    this.composer.addEventListener("paste", (event) => this.handleImagePaste(event));
    this.composer.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.send();
      }
    });
    this.attachmentInput.addEventListener("change", () => {
      this.addImageFiles(this.attachmentInput.files);
      this.attachmentInput.value = "";
    });
    this.imagePreview.addEventListener("click", (event) => {
      if (event.target === this.imagePreview) this.closeImagePreview();
    });
    this.composerCard.addEventListener("dragenter", (event) => {
      if (!this.dragHasFiles(event)) return;
      event.preventDefault();
      this.composerDragDepth += 1;
      this.composerCard.classList.add("drag-active");
    });
    this.composerCard.addEventListener("dragover", (event) => {
      if (!this.dragHasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    this.composerCard.addEventListener("dragleave", () => {
      this.composerDragDepth = Math.max(0, this.composerDragDepth - 1);
      if (!this.composerDragDepth) this.composerCard.classList.remove("drag-active");
    });
    this.composerCard.addEventListener("drop", (event) => {
      if (!this.dragHasFiles(event)) return;
      event.preventDefault();
      this.composerDragDepth = 0;
      this.composerCard.classList.remove("drag-active");
      this.addImageFiles(event.dataTransfer.files);
    });
    this.historySearch.addEventListener("input", () => this.renderHistory());
    this.messagesElement.addEventListener("scroll", () => this.handleScroll());
    this.resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => this.scrollToBottom())
      : null;
    this.resizeObserver?.observe(this.threadElement);
  }

  async initialize() {
    try {
      [this.settings, this.status] = await Promise.all([this.client.settings(), this.client.status()]);
      if (this.destroyed) return;
      this.populateSettings();
      this.updateProviderBadge();
      await this.refreshConversations();
      const resumed = await this.resumeActiveRun();
      if (!resumed && this.errorElement.hidden) {
        this.setStatus(this.status.configured ? "Connected and ready" : "Choose and test a model connection.", this.status.configured ? "ready" : "error");
      }
    } catch (error) {
      this.showError(error.message);
    }
  }

  updateWriterActivity(phase, label = "", details = {}) {
    if (this.destroyed) return;
    const previous = this.writerActivity || {};
    const scopeIndices = details.scopeIndices ?? this.currentDocument?.allowed_indices ?? previous.scopeIndices ?? [];
    const targetIndices = details.targetIndices ?? previous.targetIndices ?? [];
    const appliedIndices = details.appliedIndices ?? [];
    this.writerActivity = {
      phase,
      label,
      scopeIndices: [...scopeIndices],
      targetIndices: [...targetIndices],
      appliedIndices: [...appliedIndices],
      completedIndices: [...(details.completedIndices ?? previous.completedIndices ?? [])],
      newlyCompletedIndices: [...(details.newlyCompletedIndices ?? [])],
      activeIndex: details.activeIndex ?? null,
      failedIndex: details.failedIndex ?? null,
      progressCompleted: details.progressCompleted ?? previous.progressCompleted ?? 0,
      progressTotal: details.progressTotal ?? previous.progressTotal ?? 0,
      restoring: Boolean(details.restoring),
    };
    if (phase === "idle") this.editor.clearWriterActivity?.();
    else this.editor.setWriterActivity?.(this.writerActivity);
    this.onActivityChange?.(this.writerActivity);
  }

  resetRunProgress() {
    this.runProgress = {
      version: -1,
      phase: "idle",
      targetIndices: [],
      completedIndices: [],
      activeIndex: null,
      failedIndex: null,
    };
  }

  promptProgressLabel(index) {
    const box = this.currentDocument?.boxes?.find((item) => item.index === index);
    if (!box) return Number.isInteger(index) ? `Prompt ${index + 1}` : "Preparing next prompt";
    const parts = [`Prompt ${box.index + 1}`];
    if (box.start_beat && box.end_beat) parts.push(`${box.start_beat}–${box.end_beat}`);
    const section = box.music_context?.sections?.[0]?.label || box.music_context?.section?.label;
    if (section) parts.push(section);
    return parts.join(" · ");
  }

  ensureProgressCard() {
    const assistant = this.ensureAssistantMessage();
    let card = assistant.querySelector(".flbps-writer-progress");
    if (card) return card;
    card = document.createElement("section");
    card.className = "flbps-writer-progress";
    card.innerHTML = `
      <div class="flbps-writer-progress-head"><strong></strong><span></span></div>
      <div class="flbps-writer-progress-track" role="progressbar"><i></i></div>
      <small></small>
    `;
    assistant.insertBefore(card, assistant.querySelector(".flbps-writer-message-body"));
    return card;
  }

  renderPromptProgress() {
    const progress = this.runProgress;
    if (!this.running && progress.phase === "idle") return;
    const card = this.ensureProgressCard();
    const completed = progress.completedIndices.length;
    const total = progress.targetIndices.length;
    const current = progress.activeIndex;
    const headline = card.querySelector("strong");
    const count = card.querySelector(".flbps-writer-progress-head span");
    const track = card.querySelector(".flbps-writer-progress-track");
    const fill = track.querySelector("i");
    const detail = card.querySelector("small");
    card.dataset.state = progress.phase;
    if (progress.phase === "planning") headline.textContent = "Planning prompt edits";
    else if (progress.phase === "applying") headline.textContent = `Applying ${total} prompt${total === 1 ? "" : "s"}`;
    else if (progress.phase === "complete") headline.textContent = total ? `${total} prompt${total === 1 ? "" : "s"} complete` : "Review complete";
    else if (progress.phase === "error") headline.textContent = "Prompt writing needs attention";
    else if (progress.phase === "stopped") headline.textContent = "Prompt writing stopped";
    else if (current != null) headline.textContent = `Writing prompt ${Math.min(total, completed + 1)} of ${total}`;
    else headline.textContent = `${completed} of ${total} prompts drafted`;
    count.textContent = total ? `${completed} / ${total}` : "";
    track.classList.toggle("indeterminate", !total && progress.phase === "planning");
    track.setAttribute("aria-valuemin", "0");
    if (total) {
      track.setAttribute("aria-valuenow", String(completed));
      track.setAttribute("aria-valuemax", String(total));
    } else {
      track.removeAttribute("aria-valuenow");
      track.removeAttribute("aria-valuemax");
    }
    track.setAttribute("aria-valuetext", total ? `${completed} of ${total} prompts drafted` : "Planning prompt edits");
    fill.style.width = total ? `${Math.min(100, completed / total * 100)}%` : progress.phase === "planning" ? "32%" : "0%";
    if (progress.phase === "stopped") detail.textContent = `${completed} draft${completed === 1 ? "" : "s"} completed · no changes applied`;
    else if (progress.phase === "error" && progress.failedIndex != null) detail.textContent = `Problem at ${this.promptProgressLabel(progress.failedIndex)} · no changes applied`;
    else if (current != null) detail.textContent = this.promptProgressLabel(current);
    else if (total && completed === total) detail.textContent = progress.phase === "complete" ? "All edits applied together" : "All drafts validated";
    else detail.textContent = "Reviewing the permitted prompt sequence";
  }

  applyPromptProgress(event, { restoring = false } = {}) {
    const version = Number(event?.version);
    if (!Number.isInteger(version) || version <= this.runProgress.version) return false;
    const previousCompleted = new Set(this.runProgress.completedIndices);
    const targetIndices = Array.isArray(event.targetIndices) ? event.targetIndices.filter(Number.isInteger) : [];
    const completedIndices = Array.isArray(event.completedIndices) ? event.completedIndices.filter(Number.isInteger) : [];
    const newlyCompletedIndices = restoring ? [] : completedIndices.filter((index) => !previousCompleted.has(index));
    this.runProgress = {
      version,
      phase: String(event.phase || "planning"),
      targetIndices,
      completedIndices,
      activeIndex: Number.isInteger(event.activeIndex) ? event.activeIndex : null,
      failedIndex: Number.isInteger(event.failedIndex) ? event.failedIndex : null,
    };
    const completed = completedIndices.length;
    const total = targetIndices.length;
    const labels = {
      planning: "Planning prompt edits",
      applying: `Applying ${total} prompt${total === 1 ? "" : "s"}`,
      complete: total ? `${total} prompt${total === 1 ? "" : "s"} complete` : "Review complete",
      error: "Prompt writing needs attention",
      stopped: "Prompt writing stopped",
    };
    const label = labels[this.runProgress.phase] || (this.runProgress.activeIndex != null
      ? `Writing ${completed + 1} of ${total}`
      : `${completed} of ${total} drafted`);
    const activityPhase = this.runProgress.phase === "planning"
      ? "preparing"
      : this.runProgress.phase === "writing" || this.runProgress.phase === "drafted"
      ? "editing"
      : this.runProgress.phase;
    this.updateWriterActivity(activityPhase, label, {
      targetIndices,
      completedIndices,
      newlyCompletedIndices,
      activeIndex: this.runProgress.activeIndex,
      failedIndex: this.runProgress.failedIndex,
      progressCompleted: completed,
      progressTotal: total,
      restoring,
    });
    this.runLabel.textContent = label;
    this.renderPromptProgress();
    return true;
  }

  saveNodeSettings() {
    this.node.properties = this.node.properties || {};
    this.node.properties.flBeatPromptSequencer = {
      ...(this.node.properties.flBeatPromptSequencer || {}),
      writer: { ...this.nodeSettings },
    };
    this.node.graph?.change?.();
  }

  showView(name) {
    this.root.querySelectorAll("[data-writer-view]").forEach((view) => view.classList.toggle("active", view.dataset.writerView === name));
    this.root.querySelector('[data-writer-role="menu"]').hidden = true;
    if (name === "history") this.renderHistory();
    if (name === "chat") this.scrollToBottom(true);
  }

  async handleAction(event) {
    const button = event.target.closest("[data-writer-action]");
    if (!button) {
      this.root.querySelector('[data-writer-role="menu"]').hidden = true;
      return;
    }
    const action = button.dataset.writerAction;
    if (action === "settings" || action === "history" || action === "chat") this.showView(action);
    else if (action === "toggle-menu") {
      const menu = this.root.querySelector('[data-writer-role="menu"]');
      menu.hidden = !menu.hidden;
    } else if (action === "starter") {
      this.composer.value = button.dataset.prompt || "";
      this.updateComposer();
      this.composer.focus();
    } else if (action === "send") await this.send();
    else if (action === "attach-images") this.attachmentInput.click();
    else if (action === "remove-attachment") this.removePendingAttachment(Number(button.dataset.attachmentIndex));
    else if (action === "close-image-preview") this.closeImagePreview();
    else if (action === "stop") await this.stop();
    else if (action === "retry") await this.retry();
    else if (action === "dismiss-error") {
      this.hideError();
      if (!this.running) this.updateWriterActivity("idle");
    }
    else if (action === "jump-latest") this.scrollToBottom(true);
    else if (action === "undo") this.undo();
    else if (action === "new") await this.newConversation();
    else if (action === "models") await this.discoverModels();
    else if (action === "save-settings") await this.saveSettings();
    else if (action === "clear-credential") await this.clearCredential();
    else if (action === "subscription-login") await this.subscriptionAction("login");
    else if (action === "subscription-refresh") await this.subscriptionAction("refresh");
    else if (action === "history-mode") {
      this.historyArchived = button.dataset.historyMode === "archived";
      this.root.querySelectorAll("[data-history-mode]").forEach((item) => item.classList.toggle("active", item === button));
      this.renderHistory();
    } else if (action === "select-conversation") await this.loadConversation(button.dataset.conversationId);
    else if (action === "rename-conversation") this.startRename(button.dataset.conversationId);
    else if (action === "save-conversation-name") await this.saveRename(button.dataset.conversationId, button.closest(".flbps-writer-history-row"));
    else if (action === "cancel-conversation-name") {
      this.renamingConversationId = null;
      this.renderHistory();
    } else if (action === "archive-conversation") await this.archiveConversation(button.dataset.conversationId, true);
    else if (action === "restore-conversation") await this.archiveConversation(button.dataset.conversationId, false);
    else if (action === "delete-conversation") await this.deleteConversation(button.dataset.conversationId);
    else if (action === "edit-message") this.startMessageEdit(button.dataset.messageId);
    else if (action === "save-message-edit") await this.saveMessageEdit(button.dataset.messageId, button.closest(".flbps-writer-message"));
    else if (action === "cancel-message-edit") this.renderMessages(this.messages);
    else if (action === "resend-message") await this.resendMessage(button.dataset.messageId);
    else if (action === "copy-message") await this.copyMessage(button.closest(".flbps-writer-message"));
    else if (action === "message-version") await this.changeVersion(button.dataset.messageId, button.dataset.direction);
    else if (action === "confirm-yes") this.resolveConfirm(true);
    else if (action === "confirm-no") this.resolveConfirm(false);
  }

  populateSettings() {
    this.providerSelect.replaceChildren();
    for (const [id, preset] of Object.entries(this.settings.presets || {})) this.providerSelect.appendChild(option(id, preset.label));
    this.providerSelect.value = this.settings.provider;
    this.baseUrlInput.value = this.settings.base_url || "";
    this.modelInput.value = this.settings.model || "";
    this.temperatureInput.value = String(this.settings.temperature ?? 0.4);
    this.maxTokensInput.value = String(this.settings.max_tokens ?? 16384);
    this.populateReasoning(this.settings.reasoning_effort || "default");
    this.updateProviderControls();
  }

  populateReasoning(selected) {
    const preset = this.settings?.presets?.[this.providerSelect.value] || {};
    const efforts = ["default", ...(preset.reasoning_efforts || [])];
    for (const select of [this.reasoningSelect, this.reasoningComposer]) {
      select.replaceChildren(...efforts.map((effort) => option(effort, effort === "default" ? "Default" : effort[0].toUpperCase() + effort.slice(1))));
      select.value = efforts.includes(selected) ? selected : "default";
    }
  }

  applyProviderPreset() {
    const preset = this.settings.presets[this.providerSelect.value];
    this.baseUrlInput.value = preset.base_url || "";
    this.modelInput.value = preset.default_model || "";
    this.populateReasoning("default");
    this.updateProviderControls();
  }

  updateProviderControls() {
    const preset = this.settings.presets[this.providerSelect.value];
    const subscription = ["codex_cli", "claude_cli"].includes(preset.type);
    this.root.querySelector('[data-writer-role="base-url-row"]').hidden = preset.type !== "openai_compatible";
    this.root.querySelector('[data-writer-role="credential-row"]').hidden = subscription || (!preset.requires_key && this.providerSelect.value !== "custom");
    this.root.querySelector('[data-writer-role="subscription-row"]').hidden = !subscription;
    if (subscription) this.root.querySelector('[data-writer-role="subscription-status"]').textContent = this.settings.credential?.message || "Refresh subscription status.";
    this.credentialInput.value = "";
  }

  async saveSettings() {
    const provider = this.providerSelect.value;
    if (this.credentialInput.value.trim()) await this.client.setCredential(provider, this.credentialInput.value.trim());
    this.settings = await this.client.updateSettings({
      provider,
      base_url: this.baseUrlInput.value.trim(),
      model: this.modelInput.value.trim(),
      reasoning_effort: this.reasoningSelect.value,
      temperature: Number(this.temperatureInput.value),
      max_tokens: Number(this.maxTokensInput.value),
    });
    this.credentialInput.value = "";
    this.status = await this.client.status();
    this.populateSettings();
    this.updateProviderBadge();
    this.setStatus(this.status.configured ? "Connection ready" : "Connection needs attention", this.status.configured ? "ready" : "error");
    if (this.status.configured) await this.discoverModels(false);
    this.toast(this.status.configured ? "Connection saved" : "Connection needs attention", this.status.configured ? "success" : "error");
  }

  async clearCredential() {
    await this.client.clearCredential(this.providerSelect.value);
    this.credentialInput.value = "";
    if (this.providerSelect.value === this.settings.provider) this.status = await this.client.status();
    this.setStatus("Stored credential cleared", "ready");
    this.toast("Stored credential cleared");
  }

  async discoverModels(showStatus = true) {
    const result = await this.client.models(true);
    this.modelOptions.replaceChildren(...(result.models || []).map((model) => option(model.id, model.label || model.id)));
    if (!this.modelInput.value && result.models?.length) this.modelInput.value = result.models[0].id;
    if (showStatus) this.toast(`${result.models?.length || 0} models found`, "success");
  }

  async subscriptionAction(action) {
    const provider = this.providerSelect.value === "codex_subscription" ? "codex" : "claude";
    const result = await this.client.subscription(provider, action);
    this.root.querySelector('[data-writer-role="subscription-status"]').textContent = result.message || "Status refreshed.";
    if (action === "refresh") this.settings.credential = result;
    this.toast(result.message || "Subscription status refreshed");
  }

  updateProviderBadge() {
    const preset = this.settings?.presets?.[this.settings.provider] || {};
    const marks = { codex_subscription: "CX", claude_subscription: "CL", openrouter: "OR", anthropic: "AN", openai: "OA", ollama: "OL", lmstudio: "LM", custom: "AI" };
    const provider = this.settings?.provider || "custom";
    this.root.dataset.provider = provider;
    this.root.querySelector('[data-writer-role="provider-mark"]').textContent = marks[provider] || "AI";
    this.root.querySelector('[data-writer-role="provider-name"]').textContent = preset.label || "Model";
    this.root.querySelector('[data-writer-role="provider-model"]').textContent = this.settings?.model || "Choose model";
    this.root.classList.toggle("connected", Boolean(this.status?.configured));
    const pill = this.root.querySelector('[data-writer-role="connection-pill"]');
    pill.textContent = this.status?.configured ? "Connected" : "Needs setup";
    pill.dataset.state = this.status?.configured ? "ready" : "error";
  }

  async refreshConversations(preferredId = this.conversationId) {
    const [active, archived] = await Promise.all([
      this.client.listConversations(this.nodeSettings.schedulerId),
      this.client.listConversations(this.nodeSettings.schedulerId, true),
    ]);
    if (this.destroyed) return;
    this.conversations = active.conversations || [];
    this.archivedConversations = archived.conversations || [];
    this.renderHistory();
    const target = preferredId && this.conversations.some((item) => item.id === preferredId) ? preferredId : this.conversations[0]?.id;
    if (target) await this.loadConversation(target, false);
    else {
      this.conversationId = null;
      this.root.querySelector('[data-writer-role="conversation-title"]').textContent = "New chat";
      this.renderMessages([]);
    }
  }

  async newConversation() {
    if (this.running) return;
    const result = await this.client.createConversation(this.nodeSettings.schedulerId);
    this.conversationId = result.conversation.id;
    this.messages = [];
    this.pendingAttachments = [];
    this.renderPendingAttachments();
    this.renderMessages([]);
    this.root.querySelector('[data-writer-role="conversation-title"]').textContent = "New chat";
    this.showView("chat");
    await this.refreshConversations(this.conversationId);
    this.composer.focus();
  }

  async loadConversation(conversationId, showChat = true) {
    if (!conversationId || this.running) return;
    const result = await this.client.loadConversation(conversationId);
    if (this.destroyed) return;
    this.conversationId = conversationId;
    this.pendingAttachments = [];
    this.renderPendingAttachments();
    this.messages = result.messages || [];
    this.root.querySelector('[data-writer-role="conversation-title"]').textContent = result.conversation.title;
    this.renderMessages(this.messages);
    await this.applyPendingApplications();
    const failed = this.messages.at(-1);
    if (failed?.status === "error") {
      const user = [...this.messages].reverse().find((message) => message.role === "user");
      if (user) this.retryRequest = {
        text: user.content,
        editMessageId: user.id,
        attachments: user.metadata?.attachments || [],
      };
      this.updateWriterActivity("error", "Response failed", {
        scopeIndices: [],
        targetIndices: [],
      });
      this.showError(failed.metadata?.runError || failed.content);
    }
    if (showChat) this.showView("chat");
  }

  async applyPendingApplications() {
    for (const message of this.messages) {
      if (this.destroyed) return;
      const application = message.metadata?.promptApplication;
      const updates = message.metadata?.updates;
      if (message.role !== "assistant" || application?.status !== "pending" || !updates?.length) continue;
      const document = {
        revision: application.revision,
        music_context_revision: application.musicContextRevision || "",
        lyrics_context_revision: application.lyricsContextRevision || "",
        allowed_indices: application.allowedIndices || updates.map((update) => update.index),
      };
      try {
        const targetIndices = updates.map((update) => update.index);
        this.updateWriterActivity("applying", `Applying ${updates.length} background edit${updates.length === 1 ? "" : "s"}`, {
          scopeIndices: document.allowed_indices,
          targetIndices,
        });
        const applied = this.editor.applyWriterUpdates(document, updates);
        await this.client.acknowledgeMessageApplied(this.conversationId, message.id);
        application.status = "applied";
        this.updateWriterActivity(applied ? "applied" : "complete", applied
          ? `${applied} prompt${applied === 1 ? "" : "s"} updated`
          : "Background edits already present", {
          scopeIndices: document.allowed_indices,
          targetIndices,
          appliedIndices: targetIndices,
        });
        this.setStatus(applied ? `Applied ${applied} completed background edit${applied === 1 ? "" : "s"}` : "Background edits were already present", applied ? "applied" : "ready");
        this.toast("Background Writer response restored", "success");
      } catch (error) {
        const position = this.messages.indexOf(message);
        const user = this.messages.slice(0, position).reverse().find((item) => item.role === "user");
        if (user) this.retryRequest = {
          text: user.content,
          editMessageId: user.id,
          attachments: user.metadata?.attachments || [],
        };
        this.updateWriterActivity("error", "Background edits need attention", {
          scopeIndices: document.allowed_indices,
          targetIndices: updates.map((update) => update.index),
        });
        this.showError(`Beat Writer finished in the background, but its prompt edits could not be applied safely: ${error.message}`);
        return;
      }
    }
  }

  async resumeActiveRun() {
    const result = await this.client.activeRun(this.nodeSettings.schedulerId);
    if (this.destroyed) return false;
    const active = result.run;
    if (!active) {
      await this.refreshConversations(this.conversationId);
      return false;
    }
    if (active.conversationId !== this.conversationId) await this.loadConversation(active.conversationId, false);
    this.currentDocument = active.document;
    this.running = true;
    this.resetRunProgress();
    this.runUpdatesAcknowledged = Boolean(active.updatesApplied);
    this.applicationAck = null;
    this.currentAssistant = null;
    this.currentAssistantText = "";
    this.pendingAssistantText = "";
    this.activeTools.clear();
    this.sendButton.disabled = true;
    this.runStatus.hidden = false;
    this.runLabel.textContent = "Reconnected to background response";
    this.setStatus("Background response in progress", "working");
    if (active.progress) this.applyPromptProgress(active.progress, { restoring: true });
    else this.updateWriterActivity("connecting", "Reconnecting", {
      scopeIndices: active.document.allowed_indices,
      targetIndices: [],
    });
    try {
      await this.client.resumeRun(active.runId, (event) => this.handleRunEvent(event));
    } catch (error) {
      if (error.name !== "AbortError") {
        this.updateWriterActivity("error", "Reconnect failed");
        this.showError(error.message);
      }
    } finally {
      if (this.applicationAck) await this.applicationAck;
      this.running = false;
      this.runStatus.hidden = true;
      this.updateComposer();
      await this.refreshConversations(this.conversationId);
    }
    return true;
  }

  renderHistory() {
    if (!this.historyList) return;
    const query = this.historySearch.value.trim().toLowerCase();
    const source = this.historyArchived ? this.archivedConversations : this.conversations;
    this.historyList.replaceChildren();
    for (const conversation of source.filter((item) => `${item.title} ${item.model || ""}`.toLowerCase().includes(query))) {
      const row = document.createElement("article");
      row.className = "flbps-writer-history-row";
      if (conversation.id === this.conversationId) row.classList.add("active");
      if (this.renamingConversationId === conversation.id) {
        const input = document.createElement("input");
        input.className = "flbps-writer-history-rename";
        input.value = conversation.title;
        input.maxLength = 120;
        const save = iconButton("save-conversation-name", "ok", "Save name");
        save.dataset.conversationId = conversation.id;
        const cancel = iconButton("cancel-conversation-name", "x", "Cancel");
        row.append(input, save, cancel);
        this.historyList.appendChild(row);
        queueMicrotask(() => input.select());
        continue;
      }
      const select = document.createElement("button");
      select.className = "flbps-writer-history-select";
      select.dataset.writerAction = "select-conversation";
      select.dataset.conversationId = conversation.id;
      const title = document.createElement("strong");
      title.textContent = conversation.title;
      const meta = document.createElement("small");
      meta.textContent = `${conversation.model || "Model"} / ${relativeTime(conversation.updatedAt)}`;
      select.append(title, meta);
      const actions = document.createElement("div");
      actions.className = "flbps-writer-history-actions";
      const rename = iconButton("rename-conversation", "edit", "Rename");
      rename.dataset.conversationId = conversation.id;
      const state = iconButton(this.historyArchived ? "restore-conversation" : "archive-conversation", this.historyArchived ? "up" : "box", this.historyArchived ? "Restore" : "Archive");
      state.dataset.conversationId = conversation.id;
      actions.append(rename, state);
      if (this.historyArchived) {
        const remove = iconButton("delete-conversation", "del", "Delete permanently");
        remove.dataset.conversationId = conversation.id;
        actions.appendChild(remove);
      }
      row.append(select, actions);
      this.historyList.appendChild(row);
    }
    if (!this.historyList.childElementCount) {
      const empty = document.createElement("div");
      empty.className = "flbps-writer-history-empty";
      empty.textContent = this.historyArchived ? "No archived conversations." : "No conversations match your search.";
      this.historyList.appendChild(empty);
    }
  }

  startRename(id) {
    this.renamingConversationId = id;
    this.renderHistory();
  }

  async saveRename(id, row) {
    const title = row.querySelector("input")?.value.trim();
    if (!title) return;
    await this.client.updateConversation(id, { title });
    this.renamingConversationId = null;
    await this.refreshConversations(this.conversationId);
    this.toast("Conversation renamed", "success");
  }

  async archiveConversation(id, archived) {
    await this.client.updateConversation(id, { archived });
    if (archived && id === this.conversationId) this.conversationId = null;
    await this.refreshConversations(this.conversationId);
    this.toast(archived ? "Conversation archived" : "Conversation restored", "success");
  }

  async deleteConversation(id) {
    if (!await this.confirm("Permanently delete this archived conversation?", "Delete conversation")) return;
    await this.client.deleteConversation(id);
    await this.refreshConversations(this.conversationId);
    this.toast("Conversation deleted");
  }

  renderMessages(messages) {
    this.flushAssistantText();
    this.threadElement.replaceChildren();
    this.currentAssistant = null;
    this.activeTools.clear();
    this.welcomeElement.hidden = messages.length > 0;
    for (const message of messages) this.appendPersistedMessage(message);
    this.scrollToBottom(true);
  }

  appendPersistedMessage(message) {
    const article = this.createMessage(message.role, message.content, message);
    article.dataset.messageId = message.id;
    if (message.status === "interrupted") article.classList.add("interrupted");
    if (message.status === "error") article.classList.add("error");
    if (message.metadata?.toolSteps?.length) this.appendActivityRail(article, message.metadata.toolSteps);
    else if (message.metadata?.updates?.length) this.appendActivityRail(article, [{
      label: `Updated ${message.metadata.updates.length} prompt box${message.metadata.updates.length === 1 ? "" : "es"}`,
      name: "set_prompt_boxes",
      status: "complete",
    }]);
    this.appendMessageActions(article, message);
    return article;
  }

  createMessage(role, content = "", message = {}) {
    this.welcomeElement.hidden = true;
    const article = document.createElement("article");
    article.className = `flbps-writer-message ${role}`;
    const meta = document.createElement("header");
    meta.className = "flbps-writer-message-meta";
    const roleName = document.createElement("strong");
    roleName.textContent = role === "user" ? "You" : "Beat Writer";
    const timestamp = document.createElement("time");
    timestamp.dateTime = message.createdAt || new Date().toISOString();
    timestamp.title = new Date(timestamp.dateTime).toLocaleString();
    timestamp.textContent = relativeTime(timestamp.dateTime);
    meta.append(roleName, timestamp);
    if (role === "assistant" && (message.model || this.settings?.model)) {
      const model = document.createElement("span");
      model.textContent = message.model || this.settings.model;
      meta.appendChild(model);
    }
    const body = document.createElement("div");
    body.className = "flbps-writer-message-body";
    if (role === "assistant") body.appendChild(renderWriterMarkdown(content));
    else if (content) body.appendChild(document.createTextNode(content));
    const attachments = role === "user" ? (message.metadata?.attachments || []) : [];
    if (attachments.length) body.appendChild(this.createAttachmentGrid(attachments));
    article.messageAttachments = attachments.map((attachment) => ({ ...attachment }));
    article.dataset.rawText = content;
    article.append(meta, body);
    this.threadElement.appendChild(article);
    return article;
  }

  createAttachmentGrid(attachments, pending = false) {
    const grid = document.createElement("section");
    grid.className = "flbps-writer-image-grid";
    grid.dataset.count = String(attachments.length);
    for (const [index, attachment] of attachments.entries()) {
      const figure = document.createElement("figure");
      figure.className = "flbps-writer-image-card";
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "flbps-writer-image-open";
      preview.title = "Preview reference image";
      preview.addEventListener("click", () => this.openImagePreview(attachment));
      const image = document.createElement("img");
      image.src = this.client.imageUrl(attachment);
      image.alt = attachment.originalName || `Reference image ${index + 1}`;
      image.loading = "lazy";
      image.decoding = "async";
      preview.appendChild(image);
      const caption = document.createElement("figcaption");
      const name = document.createElement("span");
      name.textContent = attachment.originalName || attachment.filename;
      name.title = name.textContent;
      caption.appendChild(name);
      if (pending) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.dataset.writerAction = "remove-attachment";
        remove.dataset.attachmentIndex = String(index);
        remove.title = "Remove reference image";
        remove.setAttribute("aria-label", "Remove reference image");
        remove.textContent = "x";
        caption.appendChild(remove);
      }
      figure.append(preview, caption);
      grid.appendChild(figure);
    }
    return grid;
  }

  openImagePreview(attachment) {
    const image = this.imagePreview.querySelector('[data-writer-role="image-preview-image"]');
    image.src = this.client.imageUrl(attachment, false);
    image.alt = attachment.originalName || attachment.filename;
    const dimensions = attachment.width && attachment.height ? ` / ${attachment.width} x ${attachment.height}` : "";
    this.imagePreview.querySelector('[data-writer-role="image-preview-label"]').textContent = `${attachment.originalName || attachment.filename}${dimensions}`;
    this.imagePreview.hidden = false;
  }

  closeImagePreview() {
    this.imagePreview.hidden = true;
    this.imagePreview.querySelector('[data-writer-role="image-preview-image"]').removeAttribute("src");
  }

  appendMessageActions(article, message = {}) {
    if (article.querySelector(".flbps-writer-message-actions")) return;
    const actions = document.createElement("div");
    actions.className = "flbps-writer-message-actions";
    if (article.classList.contains("user") && message.id) {
      for (const [action, label] of [["edit-message", "Edit"], ["resend-message", "Resend"]]) {
        const button = document.createElement("button");
        button.dataset.writerAction = action;
        button.dataset.messageId = message.id;
        button.textContent = label;
        actions.appendChild(button);
      }
      if ((message.revision?.count || 1) > 1) {
        for (const [direction, label] of [["previous", "prev"], ["next", "next"]]) {
          const button = document.createElement("button");
          button.dataset.writerAction = "message-version";
          button.dataset.messageId = message.id;
          button.dataset.direction = direction;
          button.textContent = label;
          actions.appendChild(button);
        }
        const count = document.createElement("span");
        count.textContent = `${message.revision.position}/${message.revision.count}`;
        actions.appendChild(count);
      }
    } else if (article.classList.contains("assistant") && article.dataset.rawText) {
      const copy = document.createElement("button");
      copy.dataset.writerAction = "copy-message";
      copy.textContent = "Copy";
      actions.appendChild(copy);
    }
    if (actions.childElementCount) article.appendChild(actions);
  }

  appendActivityRail(article, steps = []) {
    let rail = article.querySelector(".flbps-writer-activity");
    if (!rail) {
      rail = document.createElement("details");
      rail.className = "flbps-writer-activity";
      const summary = document.createElement("summary");
      const mark = document.createElement("i");
      const label = document.createElement("span");
      label.className = "flbps-writer-activity-label";
      label.textContent = "Prompt activity";
      const count = document.createElement("small");
      count.className = "flbps-writer-activity-count";
      summary.append(mark, label, count);
      const list = document.createElement("div");
      list.className = "flbps-writer-activity-list";
      rail.append(summary, list);
      article.appendChild(rail);
    }
    const list = rail.querySelector(".flbps-writer-activity-list");
    for (const step of steps) {
      const row = document.createElement("div");
      row.className = `flbps-writer-activity-step ${step.status || "complete"}`;
      if (step.id) row.dataset.toolId = step.id;
      const icon = document.createElement("i");
      const copy = document.createElement("span");
      copy.textContent = step.label || step.name || "Prompt action";
      row.append(icon, copy);
      list.appendChild(row);
    }
    this.updateActivityRail(rail);
    return rail;
  }

  updateActivityRail(rail) {
    const steps = [...rail.querySelectorAll(".flbps-writer-activity-step")];
    const running = steps.filter((step) => step.classList.contains("running")).length;
    rail.classList.toggle("running", running > 0);
    rail.querySelector(".flbps-writer-activity-label").textContent = running ? "Working with prompts" : "Prompt activity";
    rail.querySelector(".flbps-writer-activity-count").textContent = `${steps.length} action${steps.length === 1 ? "" : "s"}`;
  }

  startMessageEdit(messageId) {
    const message = this.messages.find((item) => item.id === messageId);
    const article = this.threadElement.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!message || !article) return;
    const body = article.querySelector(".flbps-writer-message-body");
    const form = document.createElement("div");
    form.className = "flbps-writer-message-edit";
    const input = document.createElement("textarea");
    input.value = message.content;
    const footer = document.createElement("div");
    const cancel = document.createElement("button");
    cancel.dataset.writerAction = "cancel-message-edit";
    cancel.textContent = "Cancel";
    const save = document.createElement("button");
    save.dataset.writerAction = "save-message-edit";
    save.dataset.messageId = messageId;
    save.textContent = "Save and send";
    footer.append(cancel, save);
    form.append(input, footer);
    body.replaceChildren(form);
    article.querySelector(".flbps-writer-message-actions")?.remove();
    input.focus();
  }

  async saveMessageEdit(messageId, article) {
    const content = article.querySelector("textarea")?.value.trim();
    const message = this.messages.find((item) => item.id === messageId);
    const attachments = message?.metadata?.attachments || [];
    if (content || attachments.length) await this.sendMessage(content || "", messageId, attachments);
  }

  async resendMessage(messageId) {
    const message = this.messages.find((item) => item.id === messageId);
    if (message) await this.sendMessage(
      message.content,
      messageId,
      message.metadata?.attachments || [],
    );
  }

  async copyMessage(article) {
    const text = article?.dataset.rawText || "";
    if (!text) return;
    await navigator.clipboard.writeText(text);
    this.toast("Response copied", "success");
  }

  async changeVersion(messageId, direction) {
    const result = await this.client.selectVersion(this.conversationId, messageId, direction);
    this.messages = result.messages || [];
    this.renderMessages(this.messages);
  }

  dragHasFiles(event) {
    return Array.from(event.dataTransfer?.types || []).includes("Files");
  }

  handleImagePaste(event) {
    const files = Array.from(event.clipboardData?.files || []).filter((file) => (
      String(file.type || "").startsWith("image/")
    ));
    if (!files.length) return;
    event.preventDefault();
    this.addImageFiles(files);
  }

  async imageDimensions(file) {
    try {
      const bitmap = await createImageBitmap(file);
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return dimensions;
    } catch (_) {
      return { width: 0, height: 0 };
    }
  }

  async addImageFiles(fileList) {
    if (this.uploadingAttachments) return;
    const available = MAX_CHAT_ATTACHMENTS - this.pendingAttachments.length;
    const files = Array.from(fileList || []).slice(0, Math.max(0, available));
    if (!files.length) {
      this.showError(`Attach at most ${MAX_CHAT_ATTACHMENTS} images per message.`);
      return;
    }
    const invalid = files.find((file) => (
      !CHAT_IMAGE_TYPES.has(String(file.type || "").toLowerCase())
      || file.size > MAX_CHAT_ATTACHMENT_BYTES
    ));
    if (invalid) {
      this.showError(`${invalid.name}: use PNG, JPEG, WebP, or GIF up to 32 MB.`);
      return;
    }
    const scheduler = String(this.nodeSettings.schedulerId || "scheduler")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "scheduler";
    this.hideError();
    this.uploadingAttachments = true;
    this.composerCard.classList.add("uploading");
    this.updateComposer();
    try {
      for (const file of files) {
        const [uploaded, dimensions] = await Promise.all([
          this.client.uploadImage(file, `fl-beat-writer/${scheduler}`),
          this.imageDimensions(file),
        ]);
        this.pendingAttachments.push({
          ...uploaded,
          originalName: file.name || uploaded.filename,
          mimeType: file.type,
          sizeBytes: file.size,
          ...dimensions,
        });
        this.renderPendingAttachments();
      }
      this.toast(`${files.length} reference image${files.length === 1 ? "" : "s"} attached`, "success");
    } catch (error) {
      this.showError(`Image could not be attached: ${error.message}`);
    } finally {
      this.uploadingAttachments = false;
      this.composerCard.classList.remove("uploading");
      this.updateComposer();
    }
  }

  renderPendingAttachments() {
    this.attachmentTray.replaceChildren();
    this.attachmentTray.hidden = this.pendingAttachments.length === 0;
    if (this.pendingAttachments.length) {
      this.attachmentTray.appendChild(this.createAttachmentGrid(this.pendingAttachments, true));
    }
    this.updateComposer();
  }

  removePendingAttachment(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.pendingAttachments.length) return;
    this.pendingAttachments.splice(index, 1);
    this.renderPendingAttachments();
  }

  updateComposer() {
    this.sendButton.disabled = this.running || this.uploadingAttachments || (
      !this.composer.value.trim() && !this.pendingAttachments.length
    );
  }

  async send() {
    const text = this.composer.value.trim();
    const attachments = this.pendingAttachments.map((attachment) => ({ ...attachment }));
    if ((!text && !attachments.length) || this.running || this.uploadingAttachments) return;
    await this.sendMessage(text, null, attachments);
  }

  async sendMessage(text, editMessageId = null, attachments = null) {
    if (this.running) return;
    if (attachments === null) {
      attachments = editMessageId
        ? (this.messages.find((message) => message.id === editMessageId)?.metadata?.attachments || [])
        : this.pendingAttachments;
    }
    attachments = attachments.map((attachment) => ({ ...attachment }));
    if (!text && !attachments.length) return;
    if (!this.status?.configured) {
      this.showView("settings");
      this.showError("Choose and test a model connection first.");
      return;
    }
    if (!this.conversationId) {
      const result = await this.client.createConversation(this.nodeSettings.schedulerId);
      this.conversationId = result.conversation.id;
    }
    let document;
    try {
      document = this.editor.createWriterDocument(this.nodeSettings.scope);
    } catch (error) {
      this.showError(error.message);
      return;
    }
    this.currentDocument = document;
    if (!editMessageId) {
      this.composer.value = "";
      this.pendingAttachments = [];
      this.renderPendingAttachments();
    }
    this.resetRunProgress();
    this.updateWriterActivity("connecting", "Connecting", {
      scopeIndices: document.allowed_indices,
      targetIndices: [],
    });
    this.running = true;
    this.runUpdatesAcknowledged = false;
    this.applicationAck = null;
    this.retryRequest = { text, editMessageId, attachments };
    this.followOutput = true;
    this.hideError();
    this.sendButton.disabled = true;
    this.runStatus.hidden = false;
    this.runLabel.textContent = "Beat Writer is reading the prompt sequence";
    this.setStatus("Response in progress", "working");
    if (!editMessageId) this.createMessage("user", text, { metadata: { attachments } });
    else this.renderMessages(this.messages);
    this.currentAssistant = null;
    this.currentAssistantText = "";
    this.pendingAssistantText = "";
    this.activeTools.clear();
    this.scrollToBottom(true);
    try {
      await this.client.startRun({
        scheduler_id: this.nodeSettings.schedulerId,
        conversation_id: this.conversationId,
        edit_message_id: editMessageId,
        message: text,
        attachments,
        reasoning_effort: this.reasoningComposer.value,
        guide_mode: this.nodeSettings.guideMode,
        writer_context: this.nodeSettings.context,
        ...document,
      }, (event) => this.handleRunEvent(event));
    } catch (error) {
      if (error.name !== "AbortError") {
        this.updateWriterActivity("error", "Response failed");
        this.showError(error.message);
      }
    } finally {
      this.flushAssistantText();
      this.finishAssistantMessage();
      if (this.applicationAck) await this.applicationAck;
      this.running = false;
      this.runStatus.hidden = true;
      this.updateComposer();
      await this.refreshConversations(this.conversationId);
    }
  }

  ensureAssistantMessage() {
    if (!this.currentAssistant) {
      this.currentAssistant = this.createMessage("assistant", "");
      this.currentAssistant.classList.add("streaming");
      this.currentAssistantText = "";
      this.pendingAssistantText = "";
    }
    return this.currentAssistant;
  }

  queueAssistantDelta(delta) {
    if (!delta) return;
    this.ensureAssistantMessage();
    this.pendingAssistantText += delta;
    if (this.assistantRenderFrame === null) {
      this.assistantRenderFrame = requestAnimationFrame(() => {
        this.assistantRenderFrame = null;
        this.flushAssistantText();
      });
    }
  }

  flushAssistantText() {
    if (!this.currentAssistant || !this.pendingAssistantText) return;
    this.currentAssistantText += this.pendingAssistantText;
    this.pendingAssistantText = "";
    this.currentAssistant.dataset.rawText = this.currentAssistantText;
    const body = this.currentAssistant.querySelector(".flbps-writer-message-body");
    body.replaceChildren(renderWriterMarkdown(this.currentAssistantText));
    this.scrollToBottom();
  }

  finishAssistantMessage() {
    if (!this.currentAssistant) return;
    if (this.assistantRenderFrame !== null) {
      cancelAnimationFrame(this.assistantRenderFrame);
      this.assistantRenderFrame = null;
    }
    this.flushAssistantText();
    this.currentAssistant.classList.remove("streaming");
    this.appendMessageActions(this.currentAssistant);
  }

  handleRunEvent(event) {
    if (!this.runProgress) this.resetRunProgress();
    if (event.type === "run_started") {
      this.conversationId = event.conversationId;
      const count = this.currentDocument?.allowed_indices?.length || this.currentDocument?.boxes?.length || 0;
      if (this.runProgress.version < 0) {
        this.updateWriterActivity("reading", `Reading ${count} prompt${count === 1 ? "" : "s"}`, {
          targetIndices: [],
        });
      }
    } else if (event.type === "prompt_progress") {
      this.applyPromptProgress(event);
    } else if (event.type === "text_delta") {
      this.runLabel.textContent = "Streaming response";
      if (["connecting", "reading"].includes(this.writerActivity.phase) ||
          (this.writerActivity.phase === "drafting" && this.writerActivity.label !== "Drafting response")) {
        this.updateWriterActivity("drafting", "Drafting response", { targetIndices: [] });
      }
      this.queueAssistantDelta(event.delta || "");
    } else if (event.type === "tool_start") {
      const assistant = this.ensureAssistantMessage();
      if (this.runProgress.version < 0) this.runLabel.textContent = event.label || "Working with prompt boxes";
      if (event.name === "get_prompt_boxes") {
        const count = this.currentDocument?.allowed_indices?.length || this.currentDocument?.boxes?.length || 0;
        if (this.runProgress.version < 0) this.updateWriterActivity("reading", `Reading ${count} prompt${count === 1 ? "" : "s"}`, { targetIndices: [] });
      } else if (event.name === "inspect_reference_images") {
        this.runLabel.textContent = event.label || "Inspecting reference images";
        this.updateWriterActivity("reading", event.label || "Inspecting reference images", { targetIndices: [] });
      } else if (event.name === "plan_prompt_boxes") {
        if (this.runProgress.version < 0) this.updateWriterActivity("preparing", "Planning prompt edits", { targetIndices: [] });
      } else if (event.name === "set_prompt_boxes" && this.runProgress.version < 0) {
        this.updateWriterActivity("preparing", "Preparing prompt edits", { targetIndices: [] });
      }
      const rail = this.appendActivityRail(assistant, [{
        id: event.toolCallId,
        name: event.name,
        label: event.label || event.name,
        status: "running",
      }]);
      const row = rail.querySelector(`[data-tool-id="${CSS.escape(event.toolCallId || "")}"]`);
      if (row) this.activeTools.set(event.toolCallId, row);
    } else if (event.type === "tool_result") {
      const row = this.activeTools.get(event.toolCallId);
      if (row) {
        row.querySelector("span").textContent = event.label || event.name;
        row.classList.remove("running");
        row.classList.add("complete");
        this.updateActivityRail(row.closest(".flbps-writer-activity"));
      }
      if (event.name === "get_prompt_boxes") {
        if (this.runProgress.version < 0) {
          this.runLabel.textContent = "Reviewing story and continuity";
          this.updateWriterActivity("drafting", "Reviewing story and continuity", { targetIndices: [] });
        }
      } else if (event.name === "set_prompt_boxes" && this.runProgress.version < 0) {
        const indices = event.indices || [];
        this.runLabel.textContent = `Editing ${indices.length} prompt${indices.length === 1 ? "" : "s"}`;
        this.updateWriterActivity("editing", `Editing ${indices.length} prompt${indices.length === 1 ? "" : "s"}`, {
          targetIndices: indices,
        });
      }
    } else if (event.type === "prompt_updates") {
      if (event.revision !== this.currentDocument.revision) throw new Error("Beat Writer returned a different timeline revision.");
      const updates = event.updates || [];
      const targetIndices = updates.map((update) => update.index);
      if (updates.length) {
        this.updateWriterActivity("applying", `Applying ${updates.length} edit${updates.length === 1 ? "" : "s"}`, {
          targetIndices,
        });
      }
      const alreadyApplied = this.runUpdatesAcknowledged;
      const applied = updates.length && !alreadyApplied
        ? this.editor.applyWriterUpdates(this.currentDocument, updates)
        : 0;
      if (updates.length && !alreadyApplied) {
        this.runUpdatesAcknowledged = true;
        const runId = this.client.runId;
        this.applicationAck = this.client.acknowledgeRunApplied(runId).catch((error) => {
          this.showError(`Prompt edits were applied, but Beat Writer could not record the acknowledgment: ${error.message}`);
        });
      }
      const message = applied
        ? `Applied ${applied} prompt box${applied === 1 ? "" : "es"} / Undo available`
        : (updates.length ? "Prompt edits were already applied" : "Response complete / no prompt changes");
      this.setStatus(message, applied ? "applied" : "ready");
      if (updates.length) {
        this.updateWriterActivity(applied ? "applied" : "complete", applied
          ? `${applied} prompt${applied === 1 ? "" : "s"} updated`
          : "Edits already present", {
          targetIndices,
          appliedIndices: targetIndices,
        });
      } else {
        this.updateWriterActivity("no_changes", "Review complete", {
          targetIndices: [],
        });
      }
      if (applied) this.toast(`${applied} prompt box${applied === 1 ? "" : "es"} updated`, "success");
    } else if (event.type === "run_error") {
      if (this.runProgress.phase !== "error") this.updateWriterActivity("error", "Writer needs attention");
      this.showError(event.message || "Beat Writer failed.");
    } else if (event.type === "run_stopped") {
      if (this.runProgress.phase !== "stopped") this.updateWriterActivity("stopped", "Response stopped", {
        scopeIndices: [],
        targetIndices: [],
      });
      this.setStatus("Stopped / no prompt changes were applied", "ready");
    } else if (event.type === "run_finished") {
      this.finishAssistantMessage();
      if (!["applied", "complete", "no_changes", "error", "stopped"].includes(this.writerActivity.phase)) {
        this.updateWriterActivity("complete", "Response complete", { targetIndices: [] });
      }
      if (this.statusElement.dataset.state !== "applied") this.setStatus("Connected and ready", "ready");
    }
    this.scrollToBottom();
  }

  async stop() {
    if (!this.running) return;
    this.runLabel.textContent = "Stopping response";
    this.updateWriterActivity("stopping", "Stopping response");
    this.setStatus("Stopping...", "working");
    await this.client.cancel();
  }

  async retry() {
    if (!this.retryRequest || this.running) return;
    const { text, editMessageId, attachments } = this.retryRequest;
    this.hideError();
    await this.sendMessage(text, editMessageId, attachments || []);
  }

  undo() {
    if (this.running) return;
    try {
      const count = this.editor.undoWriterUpdates();
      this.updateWriterActivity("no_changes", `${count} prompt${count === 1 ? "" : "s"} restored`, {
        scopeIndices: [],
        targetIndices: [],
      });
      this.setStatus(`Restored ${count} prompt box${count === 1 ? "" : "es"}`, "applied");
      this.toast("Latest Writer edit restored", "success");
    } catch (error) {
      this.showError(error.message);
    }
  }

  setStatus(message, state = "") {
    this.statusText.textContent = message;
    this.statusElement.dataset.state = state;
    this.root.classList.toggle("connected", state !== "error" && Boolean(this.status?.configured));
  }

  showError(message) {
    this.errorElement.hidden = false;
    this.errorElement.querySelector('[data-writer-role="error-text"]').textContent = message;
    this.setStatus("Writer needs attention", "error");
  }

  hideError() {
    this.errorElement.hidden = true;
  }

  toast(message, state = "") {
    const element = this.root.querySelector('[data-writer-role="toast"]');
    clearTimeout(this.toastTimer);
    element.hidden = false;
    element.dataset.state = state;
    element.textContent = message;
    this.toastTimer = setTimeout(() => { element.hidden = true; }, 2800);
  }

  confirm(message, title) {
    const element = this.root.querySelector('[data-writer-role="confirm"]');
    element.querySelector('[data-writer-role="confirm-title"]').textContent = title;
    element.querySelector('[data-writer-role="confirm-message"]').textContent = message;
    element.hidden = false;
    return new Promise((resolve) => { this.confirmResolver = resolve; });
  }

  resolveConfirm(value) {
    this.root.querySelector('[data-writer-role="confirm"]').hidden = true;
    this.confirmResolver?.(value);
    this.confirmResolver = null;
  }

  handleScroll() {
    const distance = this.messagesElement.scrollHeight - this.messagesElement.scrollTop - this.messagesElement.clientHeight;
    this.followOutput = distance < 72;
    this.jumpButton.hidden = this.followOutput;
  }

  scrollToBottom(force = false) {
    if (!force && !this.followOutput) return;
    this.followOutput = true;
    this.messagesElement.scrollTop = this.messagesElement.scrollHeight;
    this.jumpButton.hidden = true;
  }

  destroy() {
    this.destroyed = true;
    this.client.detach();
    this.editor.clearWriterActivity?.();
    this.resizeObserver?.disconnect();
    if (this.assistantRenderFrame !== null) cancelAnimationFrame(this.assistantRenderFrame);
    clearTimeout(this.toastTimer);
    this.root.remove();
  }
}
