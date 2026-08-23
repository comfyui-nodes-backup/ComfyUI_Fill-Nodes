const HEADER_RE = /^\s*\[\s*([0-9]+(?:\.[0-9]+)?)\s*-\s*([0-9]+(?:\.[0-9]+)?)(?:\s*\|\s*(.*?))?\s*\]\s*$/;
const HEADER_START_RE = /^\s*\[\s*[0-9]+(?:\.[0-9]+)?\s*-/;
const EPSILON = 1e-6;

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptions(raw, defaultFadeIn, defaultFadeOut, lineNumber) {
  const values = {
    fadeIn: finiteNumber(defaultFadeIn),
    fadeOut: finiteNumber(defaultFadeOut),
    crossfade: 0,
  };
  if (!raw) return values;
  for (const part of raw.split("|")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      throw new Error(
        `Line ${lineNumber}: options must use fade_in=value, fade_out=value, or crossfade=value.`,
      );
    }
    const name = part.slice(0, separator).trim();
    const value = Number(part.slice(separator + 1).trim());
    if (name !== "fade_in" && name !== "fade_out" && name !== "crossfade") {
      throw new Error(`Line ${lineNumber}: unknown option '${name}'.`);
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Line ${lineNumber}: ${name} must be zero or greater.`);
    }
    if (name === "fade_in") values.fadeIn = value;
    else if (name === "fade_out") values.fadeOut = value;
    else values.crossfade = value;
  }
  return values;
}

function validateCrossfades(clips) {
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const previous = clips[index - 1];
    if (!(clip.crossfade > EPSILON)) continue;
    if (!previous) throw new Error(`Line ${clip.line}: the first section cannot crossfade.`);
    if (Math.abs(previous.end - clip.start) > EPSILON) {
      throw new Error(`Line ${clip.line}: crossfade requires a touching previous section.`);
    }
    const maximum = Math.min(previous.end - previous.start, clip.end - clip.start);
    if (clip.crossfade > maximum + EPSILON) {
      throw new Error(`Line ${clip.line}: crossfade exceeds the shorter adjacent section.`);
    }
    previous.fadeOut = 0;
    clip.fadeIn = 0;
  }
  return clips;
}

export function normalizeCrossfades(clips) {
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    clip.crossfade = Math.max(0, Math.round(finiteNumber(clip.crossfade)));
    const previous = clips[index - 1];
    if (!previous || previous.end !== clip.start) {
      clip.crossfade = 0;
      continue;
    }
    clip.crossfade = Math.min(
      clip.crossfade,
      previous.end - previous.start,
      clip.end - clip.start,
    );
    if (clip.crossfade > 0) {
      previous.fadeOut = 0;
      clip.fadeIn = 0;
    }
  }
  return clips;
}

export function parseTimeline(text, defaultFadeIn, defaultFadeOut) {
  const clips = [];
  let current = null;
  let promptLines = [];

  const finish = () => {
    if (!current) return;
    const prompt = promptLines.join("\n").trim();
    if (!prompt) throw new Error(`Line ${current.line}: section prompt is empty.`);
    clips.push({ ...current, prompt });
  };

  const lines = String(text || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = line.match(HEADER_RE);
    if (match) {
      finish();
      promptLines = [];
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (!(end > start)) throw new Error(`Line ${index + 1}: section end must be after its start.`);
      const options = parseOptions(match[3], defaultFadeIn, defaultFadeOut, index + 1);
      if (options.fadeIn + options.fadeOut > end - start + EPSILON) {
        throw new Error(`Line ${index + 1}: fades exceed the section duration.`);
      }
      current = {
        line: index + 1,
        start,
        end,
        fadeIn: options.fadeIn,
        fadeOut: options.fadeOut,
        crossfade: options.crossfade,
      };
      continue;
    }
    if (HEADER_START_RE.test(line)) {
      throw new Error(`Line ${index + 1}: invalid schedule header.`);
    }
    if (!current) {
      if (line.trim()) throw new Error(`Line ${index + 1}: prompt text needs a schedule header.`);
      continue;
    }
    promptLines.push(line);
  }
  finish();
  if (!clips.length) throw new Error("The prompt schedule has no sections.");
  for (let index = 1; index < clips.length; index++) {
    if (clips[index].start < clips[index - 1].end - EPSILON) {
      throw new Error(`Line ${clips[index].line}: section overlaps the previous section.`);
    }
  }
  return validateCrossfades(clips);
}

export function validateFrameClips(clips) {
  for (const clip of clips) {
    for (const [name, value] of Object.entries({
      start: clip.start,
      end: clip.end,
      fade_in: clip.fadeIn,
      fade_out: clip.fadeOut,
      crossfade: clip.crossfade,
    })) {
      if (Math.abs(value - Math.round(value)) > EPSILON) {
        throw new Error(`Line ${clip.line}: ${name} must be a whole frame.`);
      }
    }
    clip.start = Math.round(clip.start);
    clip.end = Math.round(clip.end);
    clip.fadeIn = Math.round(clip.fadeIn);
    clip.fadeOut = Math.round(clip.fadeOut);
    clip.crossfade = Math.round(clip.crossfade);
  }
  return validateCrossfades(clips);
}

export function serializeTimeline(clips) {
  return clips.map((clip) => (
    `[${Math.round(clip.start)} - ${Math.round(clip.end)} | ` +
    `fade_in=${Math.round(clip.fadeIn)} | fade_out=${Math.round(clip.fadeOut)} | ` +
    `crossfade=${Math.round(clip.crossfade)}]\n` +
    clip.prompt.trim()
  )).join("\n\n");
}

export function loadRenderGroups(clips, value) {
  for (const clip of clips) clip.renderGroup = null;
  if (!value) return clips;
  let payload;
  try {
    payload = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new Error("Saved render groups are not valid JSON.");
  }
  if (!payload || payload.version !== 1 || !Array.isArray(payload.section_groups)) {
    throw new Error("Saved render groups must use the version 1 format.");
  }
  if (payload.section_groups.length !== clips.length) {
    throw new Error("Saved render groups no longer match the prompt schedule.");
  }
  payload.section_groups.forEach((group, index) => {
    if (group !== null && (!Number.isInteger(group) || group < 1)) {
      throw new Error(`Saved render group for prompt ${index + 1} is invalid.`);
    }
    clips[index].renderGroup = group;
  });
  return clips;
}

export function normalizeRenderGroups(clips) {
  let nextGroup = 1;
  let index = 0;
  while (index < clips.length) {
    const group = clips[index].renderGroup;
    if (!Number.isInteger(group) || group < 1) {
      clips[index].renderGroup = null;
      index++;
      continue;
    }

    let end = index + 1;
    while (
      end < clips.length &&
      clips[end].renderGroup === group &&
      clips[end - 1].end === clips[end].start
    ) {
      end++;
    }
    if (end - index < 2) {
      clips[index].renderGroup = null;
    } else {
      for (let member = index; member < end; member++) {
        clips[member].renderGroup = nextGroup;
      }
      nextGroup++;
    }
    index = end;
  }
  return clips;
}

export function serializeRenderGroups(clips) {
  if (!clips.some((clip) => clip.renderGroup != null)) return "";
  return JSON.stringify({
    version: 1,
    section_groups: clips.map((clip) => clip.renderGroup ?? null),
  });
}
