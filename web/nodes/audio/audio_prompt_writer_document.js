const MAX_PROMPT_CHARS = 64000;

function mixHash(hash, value) {
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function promptDocumentRevision(clips) {
  let left = 2166136261;
  let right = 2246822507;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const value = `${index}\u001f${clip.start}\u001f${clip.end}\u001f${clip.prompt}\u001e`;
    left = mixHash(left, value);
    right = mixHash(right, value.split("").reverse().join(""));
  }
  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
}

export function promptWriterScopeIndices(clips, selectedIndices, selectedIndex, scope) {
  if (scope === "all") return clips.map((_clip, index) => index);
  const selected = [...new Set(selectedIndices || [])]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < clips.length)
    .sort((left, right) => left - right);
  if (scope === "selected") {
    if (!selected.length) throw new Error("Select at least one prompt box first.");
    return selected;
  }
  if (scope === "selected_onward") {
    const start = Number.isInteger(selectedIndex) && selectedIndex >= 0
      ? selectedIndex
      : selected[0];
    if (!Number.isInteger(start)) throw new Error("Select a prompt box to choose where writing begins.");
    return Array.from({ length: clips.length - start }, (_value, offset) => start + offset);
  }
  throw new Error("Prompt writer scope is invalid.");
}

export function createPromptWriterDocument(clips, options = {}) {
  const indices = promptWriterScopeIndices(
    clips,
    options.selectedIndices,
    options.selectedIndex,
    options.scope || "all",
  );
  const beatLabel = typeof options.beatLabel === "function"
    ? options.beatLabel
    : () => "unavailable";
  const musicContext = typeof options.musicContext === "function"
    ? options.musicContext
    : () => null;
  const lyricContext = typeof options.lyricContext === "function"
    ? options.lyricContext
    : () => null;
  const document = {
    revision: promptDocumentRevision(clips),
    fps: Number(options.fps) || 24,
    total_frames: Math.max(0, Math.round(Number(options.totalFrames) || 0)),
    bpm: Math.max(0, Number(options.bpm) || 0),
    allowed_indices: indices,
    boxes: indices.map((index) => {
      const box = {
        index,
        start_frame: clips[index].start,
        end_frame: clips[index].end,
        start_beat: beatLabel(clips[index].start),
        end_beat: beatLabel(clips[index].end),
        prompt: clips[index].prompt,
      };
      const context = musicContext(index, clips[index]);
      if (context) box.music_context = context;
      const lyrics = lyricContext(index, clips[index]);
      if (lyrics) box.lyric_context = lyrics;
      return box;
    }),
  };
  if (options.songContext) document.song_context = options.songContext;
  if (options.lyricsContext) document.lyrics_context = options.lyricsContext;
  if (options.musicContextRevision != null) {
    document.music_context_revision = String(options.musicContextRevision);
  }
  if (options.lyricsContextRevision != null) {
    document.lyrics_context_revision = String(options.lyricsContextRevision);
  }
  return document;
}

export function applyPromptWriterUpdates(clips, expectedRevision, updates, allowedIndices = null) {
  if (promptDocumentRevision(clips) !== expectedRevision) {
    throw new Error("The timeline changed while Beat Writer was working. Send the request again.");
  }
  if (!Array.isArray(updates)) throw new Error("Beat Writer returned an invalid update list.");
  const allowed = allowedIndices == null ? null : new Set(allowedIndices);
  const seen = new Set();
  const normalized = [];
  for (const update of updates) {
    const index = update?.index;
    if (!Number.isInteger(index) || index < 0 || index >= clips.length) {
      throw new Error(`Beat Writer returned invalid prompt box ${String(index)}.`);
    }
    if (allowed && !allowed.has(index)) {
      throw new Error(`Beat Writer tried to change prompt box ${index + 1} outside the selected scope.`);
    }
    if (seen.has(index)) throw new Error(`Beat Writer returned prompt box ${index + 1} more than once.`);
    seen.add(index);
    const clip = clips[index];
    if (update.start_frame !== clip.start || update.end_frame !== clip.end) {
      throw new Error(`Prompt box ${index + 1} timing changed while Beat Writer was working.`);
    }
    if (typeof update.prompt !== "string" || !update.prompt.trim()) {
      throw new Error(`Beat Writer returned an empty prompt for box ${index + 1}.`);
    }
    const prompt = update.prompt.trim();
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`Beat Writer prompt box ${index + 1} is too long.`);
    }
    normalized.push({ index, clip, prompt });
  }

  const previous = [];
  for (const { index, clip, prompt } of normalized) {
    if (clip.prompt === prompt) continue;
    previous.push({
      index,
      start_frame: clip.start,
      end_frame: clip.end,
      prompt: clip.prompt,
    });
    clip.prompt = prompt;
  }
  return { applied: previous.length, previous };
}
