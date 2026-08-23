import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const AUDIO_NODE_URL = new URL("../web/nodes/audio/", import.meta.url);

async function loadClientModule(fetchApi) {
  const source = await readFile(new URL("audio_prompt_writer_client.js", AUDIO_NODE_URL), "utf8");
  const start = source.indexOf("const ROOT");
  const key = `__flPromptWriterFetch${Date.now()}${Math.random().toString(16).slice(2)}`;
  globalThis[key] = fetchApi;
  const injected = `const api = { fetchApi: (...args) => globalThis[${JSON.stringify(key)}](...args), apiURL: (path) => path };\n${source.slice(start)}`;
  const module = await import(`data:text/javascript;base64,${Buffer.from(injected).toString("base64")}`);
  return { module, release: () => delete globalThis[key] };
}

test("standalone writer panel remains a valid ESM module", async () => {
  const source = await readFile(new URL("audio_prompt_writer.js", AUDIO_NODE_URL), "utf8");
  const start = source.indexOf("const NODE_DEFAULTS");
  assert.notEqual(start, -1);
  const encoded = Buffer.from(source.slice(start)).toString("base64");
  const module = await import(`data:text/javascript;base64,${encoded}`);
  assert.equal(typeof module.BeatPromptWriter, "function");
  assert.doesNotMatch(source, /FL_MCP|\/api\/chat|MCPServer/);
  assert.match(source, /client\.startRun/);
  assert.match(source, /event\.revision !== this\.currentDocument\.revision/);
  assert.match(source, /codex_subscription/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /flbps-writer-activity/);
  assert.match(source, /Jump to latest/);
  assert.match(source, /data-writer-role="confirm"/);
  assert.match(source, /resumeActiveRun/);
  assert.match(source, /applyPendingApplications/);
  assert.match(source, /updateWriterActivity/);
  assert.match(source, /prompt_progress/);
  assert.match(source, /flbps-writer-progress-track/);
  assert.match(source, /event\.name === "set_prompt_boxes"/);
  assert.match(source, /handleImagePaste/);
  assert.match(source, /dragHasFiles/);
  assert.match(source, /createAttachmentGrid/);
  assert.match(source, /attachments,/);
  assert.match(source, /openImagePreview/);
  assert.match(source, /data-writer-role="image-preview"/);
  assert.doesNotMatch(source, /data-writer-role="reference-shelf"|referenceImages|reference_images:/);
  assert.doesNotMatch(source, /target = "_blank"/);
  assert.doesNotMatch(source, /window\.(?:prompt|confirm)/);
});

test("chat attachment previews open and close inside the Writer", async () => {
  const source = await readFile(new URL("audio_prompt_writer.js", AUDIO_NODE_URL), "utf8");
  const start = source.indexOf("const NODE_DEFAULTS");
  const module = await import(`data:text/javascript;base64,${Buffer.from(source.slice(start)).toString("base64")}`);
  const writer = Object.create(module.BeatPromptWriter.prototype);
  const image = {
    src: "",
    alt: "",
    removeAttribute(name) { if (name === "src") this.src = ""; },
  };
  const label = { textContent: "" };
  writer.imagePreview = {
    hidden: true,
    querySelector(selector) {
      return selector.includes("image-preview-image") ? image : label;
    },
  };
  writer.client = {
    imageUrl(attachment, preview) {
      assert.equal(preview, false);
      return `/view?filename=${attachment.filename}`;
    },
  };

  writer.openImagePreview({
    filename: "stored.png",
    originalName: "Character.png",
    width: 1280,
    height: 720,
  });
  assert.equal(writer.imagePreview.hidden, false);
  assert.equal(image.src, "/view?filename=stored.png");
  assert.equal(image.alt, "Character.png");
  assert.equal(label.textContent, "Character.png / 1280 x 720");

  writer.closeImagePreview();
  assert.equal(writer.imagePreview.hidden, true);
  assert.equal(image.src, "");
});

test("Writer progress snapshots advance one prompt and ignore replayed versions", async () => {
  const source = await readFile(new URL("audio_prompt_writer.js", AUDIO_NODE_URL), "utf8");
  const start = source.indexOf("const NODE_DEFAULTS");
  const module = await import(`data:text/javascript;base64,${Buffer.from(source.slice(start)).toString("base64")}`);
  const writer = Object.create(module.BeatPromptWriter.prototype);
  const states = [];
  writer.currentDocument = { allowed_indices: [0, 1], boxes: [] };
  writer.writerActivity = { phase: "idle", scopeIndices: [], targetIndices: [], appliedIndices: [] };
  writer.runProgress = { version: -1, phase: "idle", targetIndices: [], completedIndices: [], activeIndex: null, failedIndex: null };
  writer.editor = { setWriterActivity: (activity) => states.push(activity), clearWriterActivity() {} };
  writer.onActivityChange = null;
  writer.runLabel = { textContent: "" };
  writer.renderPromptProgress = () => {};

  assert.equal(writer.applyPromptProgress({
    version: 2,
    phase: "writing",
    targetIndices: [0, 1],
    completedIndices: [],
    activeIndex: 0,
    failedIndex: null,
  }), true);
  assert.equal(states.at(-1).activeIndex, 0);
  assert.equal(states.at(-1).progressTotal, 2);

  assert.equal(writer.applyPromptProgress({
    version: 3,
    phase: "writing",
    targetIndices: [0, 1],
    completedIndices: [0],
    activeIndex: 1,
    failedIndex: null,
  }), true);
  assert.deepEqual(states.at(-1).newlyCompletedIndices, [0]);
  assert.equal(states.at(-1).activeIndex, 1);
  assert.equal(states.at(-1).progressCompleted, 1);

  assert.equal(writer.applyPromptProgress({
    version: 2,
    phase: "writing",
    targetIndices: [0, 1],
    completedIndices: [],
    activeIndex: 0,
  }), false);
  assert.equal(states.length, 2);
});

test("Writer lifecycle exposes only confirmed edit indices to the timeline", async () => {
  const source = await readFile(new URL("audio_prompt_writer.js", AUDIO_NODE_URL), "utf8");
  const start = source.indexOf("const NODE_DEFAULTS");
  const module = await import(`data:text/javascript;base64,${Buffer.from(source.slice(start)).toString("base64")}`);
  const writer = Object.create(module.BeatPromptWriter.prototype);
  const timelineStates = [];
  const headerStates = [];
  writer.currentDocument = { allowed_indices: [0, 1], revision: "revision-one" };
  writer.writerActivity = { phase: "idle", scopeIndices: [], targetIndices: [], appliedIndices: [] };
  writer.editor = {
    setWriterActivity: (activity) => timelineStates.push(activity),
    clearWriterActivity() {},
    applyWriterUpdates: () => 1,
  };
  writer.onActivityChange = (activity) => headerStates.push(activity);
  writer.activeTools = new Map();
  writer.runLabel = { textContent: "" };
  writer.scrollToBottom = () => {};
  writer.setStatus = () => {};
  writer.toast = () => {};
  writer.statusElement = { dataset: {} };
  writer.runUpdatesAcknowledged = false;
  writer.client = {
    runId: "run-one",
    acknowledgeRunApplied: async () => ({ acknowledged: true }),
  };

  writer.handleRunEvent({
    type: "tool_result",
    name: "get_prompt_boxes",
    toolCallId: "read-one",
    indices: [],
  });
  assert.equal(writer.writerActivity.phase, "drafting");
  assert.deepEqual(writer.writerActivity.targetIndices, []);

  writer.handleRunEvent({
    type: "tool_result",
    name: "set_prompt_boxes",
    toolCallId: "write-one",
    indices: [1],
  });
  assert.equal(writer.writerActivity.phase, "editing");
  assert.deepEqual(writer.writerActivity.scopeIndices, [0, 1]);
  assert.deepEqual(writer.writerActivity.targetIndices, [1]);
  assert.deepEqual(timelineStates.at(-1), headerStates.at(-1));

  writer.handleRunEvent({
    type: "prompt_updates",
    revision: "revision-one",
    updates: [{ index: 1, start_frame: 10, end_frame: 20, prompt: "Updated" }],
  });
  assert.equal(writer.writerActivity.phase, "applied");
  assert.deepEqual(writer.writerActivity.appliedIndices, [1]);
  assert.equal(writer.runUpdatesAcknowledged, true);
  await writer.applicationAck;
});

test("writer client uses standalone streaming routes", async () => {
  const source = await readFile(new URL("audio_prompt_writer_client.js", AUDIO_NODE_URL), "utf8");
  const start = source.indexOf("const ROOT");
  const module = await import(`data:text/javascript;base64,${Buffer.from(source.slice(start)).toString("base64")}`);
  assert.equal(typeof module.PromptWriterClient, "function");
  assert.match(source, /\/fl\/audio-prompt-timeline\/writer/);
  assert.match(source, /response\.body\.getReader/);
  assert.match(source, /activeRun/);
  assert.match(source, /resumeRun/);
  assert.match(source, /acknowledgeRunApplied/);
  assert.doesNotMatch(source, /FL_MCP|\/api\/chat/);
});

test("writer client discovers and reconnects to a detached run", async () => {
  const calls = [];
  const encoder = new TextEncoder();
  const events = [
    { type: "run_started", runId: "run/one" },
    { type: "text_delta", delta: "Still working" },
    { type: "run_finished", runId: "run/one" },
  ];
  const stream = new ReadableStream({
    start(controller) {
      const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      controller.enqueue(encoder.encode(body.slice(0, 31)));
      controller.enqueue(encoder.encode(body.slice(31)));
      controller.close();
    },
  });
  const fetchApi = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.includes("/runs/active?")) {
      return Response.json({ run: { runId: "run/one", conversationId: "chat-one" } });
    }
    if (path.endsWith("/runs/run%2Fone/events")) return new Response(stream);
    if (path.endsWith("/runs/run%2Fone/applied")) return Response.json({ acknowledged: true });
    throw new Error(`Unexpected request: ${path}`);
  };
  const { module, release } = await loadClientModule(fetchApi);
  try {
    const client = new module.PromptWriterClient();
    const active = await client.activeRun("scheduler one");
    assert.equal(active.run.runId, "run/one");
    const received = [];
    await client.resumeRun("run/one", (event) => received.push(event));
    assert.deepEqual(received, events);
    assert.equal(client.runId, null);
    assert.equal((await client.acknowledgeRunApplied("run/one")).acknowledged, true);
    assert.match(calls[0].path, /scheduler_id=scheduler\+one/);
    assert.equal(calls[1].path.endsWith("/runs/run%2Fone/events"), true);
    assert.equal(calls[2].options.method, "POST");
  } finally {
    release();
  }
});

test("writer client uploads images into a scoped ComfyUI input folder", async () => {
  const calls = [];
  const fetchApi = async (path, options = {}) => {
    calls.push({ path, options });
    return Response.json({ name: "stored.png", subfolder: "fl-beat-writer/scheduler", type: "input" });
  };
  const { module, release } = await loadClientModule(fetchApi);
  try {
    const client = new module.PromptWriterClient();
    const file = new File([new Uint8Array([1, 2, 3])], "reference.png", { type: "image/png" });
    const image = await client.uploadImage(file, "fl-beat-writer/scheduler");
    assert.deepEqual(image, {
      filename: "stored.png",
      subfolder: "fl-beat-writer/scheduler",
      type: "input",
    });
    assert.equal(calls[0].path, "/upload/image");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.body.get("subfolder"), "fl-beat-writer/scheduler");
    const previewUrl = new URL(client.imageUrl(image), "http://localhost");
    assert.equal(previewUrl.pathname, "/view");
    assert.equal(previewUrl.searchParams.get("preview"), "webp;80");
    const fullUrl = new URL(client.imageUrl(image, false), "http://localhost");
    assert.equal(fullUrl.searchParams.has("preview"), false);
  } finally {
    release();
  }
});

test("writer markdown renderer remains DOM-safe", async () => {
  const source = await readFile(new URL("audio_prompt_writer_markdown.js", AUDIO_NODE_URL), "utf8");
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  assert.equal(typeof module.renderWriterMarkdown, "function");
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML/);
});
