import { api } from "../../../../scripts/api.js";

const ROOT = "/fl/audio-prompt-timeline/writer";

async function request(path, options = {}) {
  const response = await api.fetchApi(`${ROOT}${path}`, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Beat Writer request failed (${response.status}).`);
  return value;
}

export class PromptWriterClient {
  constructor() {
    this.runId = null;
    this.abortController = null;
  }

  status() {
    return request("/status");
  }

  settings() {
    return request("/settings");
  }

  updateSettings(changes) {
    return request("/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
  }

  models(refresh = false) {
    return request(`/models${refresh ? "?refresh=1" : ""}`);
  }

  setCredential(provider, credential) {
    return request(`/credentials/${encodeURIComponent(provider)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
  }

  clearCredential(provider) {
    return request(`/credentials/${encodeURIComponent(provider)}`, { method: "DELETE" });
  }

  subscription(provider, action) {
    return request(`/subscriptions/${provider}/${action}`, { method: "POST" });
  }

  listConversations(schedulerId, archived = false) {
    const query = new URLSearchParams({ scheduler_id: schedulerId });
    if (archived) query.set("archived", "1");
    return request(`/conversations?${query}`);
  }

  createConversation(schedulerId) {
    return request("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduler_id: schedulerId }),
    });
  }

  loadConversation(conversationId) {
    return request(`/conversations/${encodeURIComponent(conversationId)}`);
  }

  updateConversation(conversationId, changes) {
    return request(`/conversations/${encodeURIComponent(conversationId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
  }

  deleteConversation(conversationId) {
    return request(`/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" });
  }

  selectVersion(conversationId, messageId, direction) {
    return request(
      `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/version`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction }),
      },
    );
  }

  async uploadImage(file, subfolder) {
    const safeName = String(file.name || "image.png")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .slice(-160) || "image.png";
    const uploadName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`;
    const body = new FormData();
    body.append("image", file, uploadName);
    body.append("type", "input");
    body.append("subfolder", subfolder);
    body.append("overwrite", "false");
    const response = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Image upload failed (${response.status}${detail ? `: ${detail}` : ""}).`);
    }
    const value = await response.json();
    if (!value?.name) throw new Error("Image upload response did not include a filename.");
    return {
      filename: value.name,
      subfolder: value.subfolder || subfolder,
      type: value.type || "input",
    };
  }

  imageUrl(image, preview = true) {
    const query = new URLSearchParams({
      filename: image.filename,
      type: image.type || "input",
    });
    if (image.subfolder) query.set("subfolder", image.subfolder);
    if (preview) query.set("preview", "webp;80");
    return api.apiURL(`/view?${query}`);
  }

  activeRun(schedulerId) {
    const query = new URLSearchParams({ scheduler_id: schedulerId });
    return request(`/runs/active?${query}`);
  }

  acknowledgeRunApplied(runId = this.runId) {
    if (!runId) return Promise.resolve({ acknowledged: false });
    return request(`/runs/${encodeURIComponent(runId)}/applied`, { method: "POST" });
  }

  acknowledgeMessageApplied(conversationId, messageId) {
    return request(
      `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/applied`,
      { method: "POST" },
    );
  }

  async consumeRun(response, runId, onEvent) {
    const controller = this.abortController;
    this.runId = runId;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          const data = block.split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (data) onEvent(JSON.parse(data));
        }
      }
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
        this.runId = null;
      }
    }
  }

  async startRun(payload, onEvent) {
    this.abortController = new AbortController();
    let response;
    try {
      response = await api.fetchApi(`${ROOT}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: this.abortController.signal,
      });
    } catch (error) {
      this.abortController = null;
      throw error;
    }
    if (!response.ok) {
      const value = await response.json();
      this.abortController = null;
      throw new Error(value.error || `Beat Writer failed (${response.status}).`);
    }
    const runId = response.headers.get("X-Prompt-Writer-Run-Id");
    await this.consumeRun(response, runId, onEvent);
  }

  async resumeRun(runId, onEvent) {
    this.abortController = new AbortController();
    let response;
    try {
      response = await api.fetchApi(`${ROOT}/runs/${encodeURIComponent(runId)}/events`, {
        signal: this.abortController.signal,
      });
    } catch (error) {
      this.abortController = null;
      throw error;
    }
    if (!response.ok) {
      const value = await response.json();
      this.abortController = null;
      throw new Error(value.error || `Beat Writer reconnect failed (${response.status}).`);
    }
    await this.consumeRun(response, runId, onEvent);
  }

  async cancel() {
    const runId = this.runId;
    if (!runId) {
      this.abortController?.abort();
      return false;
    }
    const value = await request(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
    return value.cancelled;
  }

  detach() {
    this.abortController?.abort();
    this.abortController = null;
    this.runId = null;
  }
}
