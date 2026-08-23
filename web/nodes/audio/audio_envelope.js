export const ENVELOPE_SOURCES = {
  beat_grid: "Beat grid",
  downbeat: "Downbeat",
  raw_beat: "Raw beat",
  onset: "Transient",
  kick: "Kick",
  snare: "Snare",
  hihat: "Hi-hat",
};

const SOURCE_NAMES = new Set(Object.keys(ENVELOPE_SOURCES));
const CURVES = new Set(["linear", "cosine"]);

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function integer(value, fallback, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Math.round(finiteNumber(value, fallback))));
}

export function defaultEnvelopeLayer() {
  return {
    enabled: true,
    source: "beat_grid",
    prompt: "",
    stride: 1,
    phase: 0,
    attack_frames: 0,
    hold_frames: 3,
    release_frames: 6,
    curve: "cosine",
    floor_strength: 0,
    peak_strength: 3,
  };
}

export function normalizeEnvelopeLayer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const defaults = defaultEnvelopeLayer();
  const stride = integer(value.stride, defaults.stride, 1, 64);
  return {
    enabled: value.enabled !== false,
    source: SOURCE_NAMES.has(value.source) ? value.source : defaults.source,
    prompt: String(value.prompt || ""),
    stride,
    phase: integer(value.phase, defaults.phase, 0, stride - 1),
    attack_frames: integer(value.attack_frames, defaults.attack_frames, 0, 240),
    hold_frames: integer(value.hold_frames, defaults.hold_frames, 0, 240),
    release_frames: integer(value.release_frames, defaults.release_frames, 0, 240),
    curve: CURVES.has(value.curve) ? value.curve : defaults.curve,
    floor_strength: Math.min(8, Math.max(0, finiteNumber(value.floor_strength))),
    peak_strength: Math.min(8, Math.max(0, finiteNumber(value.peak_strength, 3))),
  };
}

export function parseEnvelopeLayers(value) {
  if (typeof value === "string") {
    try {
      value = value ? JSON.parse(value) : null;
    } catch {
      value = null;
    }
  }
  const slots = value?.version === 1 && Array.isArray(value.slots) ? value.slots : [];
  return Array.from({ length: 3 }, (_, index) => normalizeEnvelopeLayer(slots[index]));
}

export function serializeEnvelopeLayers(slots) {
  return JSON.stringify({
    version: 1,
    slots: Array.from({ length: 3 }, (_, index) => normalizeEnvelopeLayer(slots[index])),
  });
}

function curveValue(value, curve) {
  value = Math.min(1, Math.max(0, value));
  return curve === "cosine" ? 0.5 - 0.5 * Math.cos(Math.PI * value) : value;
}

function pulseValue(seconds, event, attack, hold, release, curve) {
  const start = event - attack;
  const holdEnd = event + hold;
  const end = holdEnd + release;
  if (seconds < start || seconds >= end) return 0;
  if (seconds < event && attack > 1e-6) {
    return curveValue((seconds - start) / attack, curve);
  }
  if (seconds < holdEnd) return 1;
  if (release <= 1e-6) return 0;
  return 1 - curveValue((seconds - holdEnd) / release, curve);
}

export function generateEnvelopeValues(events, totalFrames, fps, layer) {
  const values = new Float32Array(Math.max(0, totalFrames));
  if (!layer?.enabled || !(fps > 0)) return values;
  const attack = layer.attack_frames / fps;
  const hold = layer.hold_frames / fps;
  const release = layer.release_frames / fps;
  for (let index = layer.phase; index < events.length; index += layer.stride) {
    const event = finiteNumber(events[index]);
    const first = Math.max(0, Math.ceil((event - attack) * fps - 0.5 - 1e-6));
    const last = Math.min(
      values.length,
      Math.ceil((event + hold + release) * fps - 0.5 - 1e-6),
    );
    for (let frame = first; frame < last; frame++) {
      values[frame] = Math.max(
        values[frame],
        pulseValue((frame + 0.5) / fps, event, attack, hold, release, layer.curve),
      );
    }
  }
  return values;
}
