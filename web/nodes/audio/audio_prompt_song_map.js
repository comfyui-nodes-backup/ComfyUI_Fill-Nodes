const SONG_MAP_VERSIONS = new Set([1, 2]);
const OVERRIDE_VERSION = 2;
const MAX_SECTIONS = 256;
const MAX_CUES = 512;
const EPSILON = 1e-6;
const ROLES = new Set([
  "intro",
  "verse",
  "pre_chorus",
  "chorus",
  "bridge",
  "instrumental",
  "breakdown",
  "outro",
  "unknown",
]);
const CUE_TYPES = new Set([
  "build",
  "drop",
  "peak",
  "breakdown",
  "release",
  "turnaround",
  "transition",
  "fill",
  "custom",
]);
const CUE_SOURCES = new Set(["analysis", "manual"]);
const PALETTE = [
  "#0ea5e9",
  "#8b5cf6",
  "#ec4899",
  "#f59e0b",
  "#10b981",
  "#f97316",
  "#14b8a6",
  "#6366f1",
];

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, finiteNumber(value)));
}

function boundedString(value, maximum = 64) {
  return String(value || "").trim().slice(0, maximum);
}

function stringHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeRole(value) {
  const role = value && typeof value === "object" ? value : {};
  const name = ROLES.has(role.value) ? role.value : "unknown";
  return {
    value: name,
    source: boundedString(role.source || "heuristic", 24) || "heuristic",
    confidence: clamp(role.confidence),
    customLabel: boundedString(role.custom_label ?? role.customLabel, 48),
  };
}

function normalizeStoredRole(value) {
  const role = normalizeRole(value);
  return {
    value: role.value,
    source: role.source,
    confidence: role.confidence,
    customLabel: role.customLabel,
  };
}

function normalizeStructureSection(value, index, duration = Infinity) {
  if (!value || typeof value !== "object") return null;
  const start = Math.max(0, finiteNumber(value.start));
  const end = Math.min(duration, finiteNumber(value.end));
  if (!(end > start)) return null;
  return {
    id: boundedString(value.id || `manual-${index + 1}`, 80) || `manual-${index + 1}`,
    start,
    end,
    family: boundedString(value.family || `M${index + 1}`, 16) || `M${index + 1}`,
    role: normalizeStoredRole(value.role),
  };
}

function normalizedStructure(value, duration = Infinity) {
  if (!Array.isArray(value)) return null;
  const sections = value
    .slice(0, MAX_SECTIONS)
    .map((section, index) => normalizeStructureSection(section, index, duration));
  if (sections.some(section => !section)) return null;
  sections.sort((left, right) => left.start - right.start || left.end - right.end);
  const ids = new Set();
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index];
    if (ids.has(section.id) || (index && section.start < sections[index - 1].end - EPSILON)) {
      return null;
    }
    ids.add(section.id);
  }
  return sections;
}

export function normalizeEnergyPreview(value) {
  if (!value || finiteNumber(value.version) !== 1 || !Array.isArray(value.values) ||
      value.values.length < 2) {
    return null;
  }
  const duration = finiteNumber(value.duration);
  const rate = finiteNumber(value.rate, value.values.length / duration);
  if (!(duration > 0) || !(rate > 0)) return null;
  return {
    version: 1,
    duration,
    rate,
    values: value.values.map(entry => clamp(entry)),
  };
}

function normalizeSection(value, index, duration) {
  if (!value || typeof value !== "object") return null;
  const start = clamp(value.start, 0, duration);
  const end = clamp(value.end, 0, duration);
  if (!(end > start)) return null;
  const energy = value.energy && typeof value.energy === "object" ? value.energy : {};
  const rhythm = value.rhythm && typeof value.rhythm === "object" ? value.rhythm : {};
  const trend = ["rising", "falling", "steady"].includes(energy.trend)
    ? energy.trend
    : "steady";
  return {
    id: boundedString(value.id || `section-${index}`, 80) || `section-${index}`,
    start,
    end,
    barStart: Math.max(0, Math.round(finiteNumber(value.bar_start ?? value.barStart))),
    barEnd: Math.max(0, Math.round(finiteNumber(value.bar_end ?? value.barEnd))),
    family: boundedString(value.family || String.fromCharCode(65 + index % 26), 16),
    role: normalizeRole(value.role),
    energy: {
      mean: clamp(energy.mean),
      peak: clamp(energy.peak),
      change: clamp(energy.change, -1, 1),
      trend,
    },
    rhythm: {
      onsetDensity: Math.max(0, finiteNumber(rhythm.onset_density ?? rhythm.onsetDensity)),
    },
  };
}

function normalizeCue(value, index, duration, defaultSource = "analysis") {
  if (!value || typeof value !== "object" || !CUE_TYPES.has(value.type)) return null;
  const start = clamp(value.start, 0, duration);
  const end = clamp(value.end, start, duration);
  const anchor = clamp(value.anchor ?? (end > start ? end : start), start, end);
  const source = CUE_SOURCES.has(value.source) ? value.source : defaultSource;
  const generatedId = `auto-${value.type}-${stringHash(
    `${value.type}:${start.toFixed(3)}:${end.toFixed(3)}:${anchor.toFixed(3)}`,
  )}`;
  return {
    id: boundedString(value.id || generatedId || `cue-${index + 1}`, 80),
    type: value.type,
    start,
    end,
    anchor,
    strength: value.strength == null ? null : clamp(value.strength),
    confidence: value.confidence == null ? null : clamp(value.confidence),
    source,
    note: boundedString(value.note, 160),
  };
}

function normalizePhrase(value, duration) {
  if (!value || typeof value !== "object") return null;
  const start = clamp(value.start, 0, duration);
  const end = clamp(value.end, start, duration);
  if (!(end > start)) return null;
  return {
    sectionId: boundedString(value.section_id ?? value.sectionId, 80),
    start,
    end,
    index: Math.max(0, Math.round(finiteNumber(value.index))),
    barCount: Math.max(1, Math.round(finiteNumber(value.bar_count ?? value.barCount, 1))),
  };
}

export function normalizeSongMap(value) {
  if (!value || value.type !== "fl_audio_song_map" ||
      !SONG_MAP_VERSIONS.has(finiteNumber(value.version))) {
    return null;
  }
  const duration = finiteNumber(value.source_duration ?? value.sourceDuration);
  if (!(duration > 0)) return null;
  const sections = (Array.isArray(value.sections) ? value.sections : [])
    .map((section, index) => normalizeSection(section, index, duration))
    .filter(Boolean)
    .sort((left, right) => left.start - right.start);
  const phrases = (Array.isArray(value.phrases) ? value.phrases : [])
    .map(phrase => normalizePhrase(phrase, duration))
    .filter(Boolean)
    .sort((left, right) => left.start - right.start);
  const cues = (Array.isArray(value.cues) ? value.cues : Array.isArray(value.moments) ? value.moments : [])
    .slice(0, MAX_CUES)
    .map((cue, index) => normalizeCue(cue, index, duration))
    .filter(Boolean)
    .sort((left, right) => left.start - right.start);
  const meter = value.meter && typeof value.meter === "object" ? value.meter : {};
  return {
    type: "fl_audio_song_map",
    version: finiteNumber(value.version),
    duration,
    analysisSource: boundedString(value.analysis_source ?? value.analysisSource ?? "mix", 24),
    cacheKey: boundedString(value.cache_key ?? value.cacheKey, 128),
    analysisCacheHit: Boolean(value.analysis_cache_hit ?? value.analysisCacheHit),
    meter: {
      beatsPerBar: Math.max(0, Math.round(finiteNumber(
        meter.beats_per_bar ?? meter.beatsPerBar,
      ))),
      confidence: clamp(meter.confidence),
    },
    energyPreview: normalizeEnergyPreview(value.energy_preview ?? value.energyPreview),
    sections,
    phrases,
    cues,
    moments: cues,
  };
}

export function normalizeSongMapOverrides(value) {
  const version = finiteNumber(value?.version);
  if (!value || ![1, 2, 3].includes(version) ||
      typeof value.roles !== "object" || Array.isArray(value.roles)) {
    return { version: OVERRIDE_VERSION, cacheKey: "", roles: {}, sections: null, nextId: 1 };
  }
  const roles = {};
  for (const [id, role] of Object.entries(value.roles)) {
    const sectionId = boundedString(id, 80);
    if (!sectionId || !role || typeof role !== "object") continue;
    const name = ROLES.has(role.value) ? role.value : "unknown";
    const customLabel = boundedString(role.custom_label ?? role.customLabel, 48);
    if (name === "unknown" && !customLabel) continue;
    roles[sectionId] = { value: name, customLabel };
  }
  return {
    version: OVERRIDE_VERSION,
    cacheKey: boundedString(value.cache_key ?? value.cacheKey, 128),
    roles,
    sections: version >= 2 ? normalizedStructure(value.sections) : null,
    nextId: Math.max(1, Math.round(finiteNumber(value.next_id ?? value.nextId, 1))),
  };
}

function lowerBound(values, target) {
  let start = 0;
  let end = values.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (values[middle] < target) start = middle + 1;
    else end = middle;
  }
  return start;
}

function derivedEnergy(songMap, start, end) {
  const preview = songMap.energyPreview;
  if (!preview) return { mean: 0, peak: 0, change: 0, trend: "steady" };
  const first = Math.max(0, Math.floor(start * preview.rate));
  const last = Math.min(preview.values.length, Math.max(first + 1, Math.ceil(end * preview.rate)));
  const values = preview.values.slice(first, last);
  if (!values.length) return { mean: 0, peak: 0, change: 0, trend: "steady" };
  const mean = values.reduce((sum, entry) => sum + entry, 0) / values.length;
  const peak = Math.max(...values);
  const span = Math.max(1, Math.floor(values.length / 3));
  const head = values.slice(0, span);
  const tail = values.slice(-span);
  const headMean = head.reduce((sum, entry) => sum + entry, 0) / head.length;
  const tailMean = tail.reduce((sum, entry) => sum + entry, 0) / tail.length;
  const change = tailMean - headMean;
  return {
    mean: clamp(mean),
    peak: clamp(peak),
    change: clamp(change, -1, 1),
    trend: change >= 0.08 ? "rising" : change <= -0.08 ? "falling" : "steady",
  };
}

function derivedSection(section, songMap, analysis) {
  const downbeats = analysis?.detectedDownbeatTimes?.length
    ? analysis.detectedDownbeatTimes
    : analysis?.downbeatTimes || [];
  const onsets = analysis?.onsetTimes || [];
  const startOnset = lowerBound(onsets, section.start);
  const endOnset = lowerBound(onsets, section.end);
  return {
    ...section,
    barStart: lowerBound(downbeats, section.start),
    barEnd: Math.max(lowerBound(downbeats, section.end), lowerBound(downbeats, section.start) + 1),
    energy: derivedEnergy(songMap, section.start, section.end),
    rhythm: {
      onsetDensity: (endOnset - startOnset) / Math.max(EPSILON, section.end - section.start),
    },
  };
}

function derivedPhrases(sections, analysis) {
  const downbeats = analysis?.detectedDownbeatTimes?.length
    ? analysis.detectedDownbeatTimes
    : analysis?.downbeatTimes || [];
  const phrases = [];
  for (const section of sections) {
    const boundaries = [
      section.start,
      ...downbeats.filter(time => time > section.start + EPSILON && time < section.end - EPSILON),
      section.end,
    ];
    if (boundaries.length < 2) continue;
    let phraseIndex = 0;
    for (let index = 0; index < boundaries.length - 1; index += 4) {
      const next = Math.min(index + 4, boundaries.length - 1);
      phrases.push({
        sectionId: section.id,
        start: boundaries[index],
        end: boundaries[next],
        index: phraseIndex++,
        barCount: Math.max(1, next - index),
      });
    }
  }
  return phrases;
}

function applyRoleOverrides(sections, roles) {
  return sections.map(section => {
    const override = roles[section.id];
    if (!override) return section;
    return {
      ...section,
      role: {
        value: override.value,
        customLabel: override.customLabel,
        source: "manual",
        confidence: 1,
      },
    };
  });
}

export function applySongMapOverrides(songMap, value, analysis = null) {
  if (!songMap) return null;
  const overrides = normalizeSongMapOverrides(value);
  if (!overrides.cacheKey || overrides.cacheKey !== songMap.cacheKey) return songMap;
  if (overrides.sections) {
    const sections = applyRoleOverrides(
      overrides.sections.map(section => derivedSection(section, songMap, analysis)),
      overrides.roles,
    );
    return {
      ...songMap,
      sections,
      phrases: derivedPhrases(sections, analysis),
    };
  }
  return {
    ...songMap,
    sections: applyRoleOverrides(songMap.sections, overrides.roles),
  };
}

export function updateSongMapOverride(value, songMap, sectionId, role, customLabel = "") {
  const current = normalizeSongMapOverrides(value);
  const roles = current.cacheKey === songMap?.cacheKey ? { ...current.roles } : {};
  let sections = current.cacheKey === songMap?.cacheKey ? current.sections : null;
  const name = ROLES.has(role) ? role : "unknown";
  const label = boundedString(customLabel, 48);
  if (role === "auto") {
    delete roles[sectionId];
    if (sections) {
      const automatic = songMap?.sections.find(section => section.id === sectionId)?.role;
      sections = sections.map(section => section.id === sectionId
        ? { ...section, role: normalizeStoredRole(automatic) }
        : section);
    }
  }
  else if (name !== "unknown" || label) roles[sectionId] = { value: name, customLabel: label };
  return {
    version: OVERRIDE_VERSION,
    cacheKey: songMap?.cacheKey || "",
    roles,
    sections,
    nextId: current.cacheKey === songMap?.cacheKey ? current.nextId : 1,
  };
}

export function validateSongMapSections(value, duration = Infinity) {
  const sections = normalizedStructure(value, duration);
  if (!sections || sections.length !== value?.length) {
    throw new Error("Song Map sections need unique IDs, valid ranges, and no overlaps.");
  }
  return sections;
}

export function replaceSongMapSections(value, songMap, sections) {
  if (!songMap) return normalizeSongMapOverrides(null);
  const current = normalizeSongMapOverrides(value);
  const cacheMatches = current.cacheKey === songMap.cacheKey;
  const normalized = validateSongMapSections(sections, songMap.duration);
  let nextId = cacheMatches ? current.nextId : 1;
  const ids = new Set(normalized.map(section => section.id));
  while (ids.has(`manual-${nextId}`)) nextId++;
  return {
    version: OVERRIDE_VERSION,
    cacheKey: songMap.cacheKey,
    roles: cacheMatches ? current.roles : {},
    sections: normalized,
    nextId,
  };
}

export function nextSongMapSectionId(value, songMap) {
  const current = normalizeSongMapOverrides(value);
  const sections = current.cacheKey === songMap?.cacheKey && current.sections
    ? current.sections
    : songMap?.sections || [];
  const ids = new Set(sections.map(section => section.id));
  let next = current.cacheKey === songMap?.cacheKey ? current.nextId : 1;
  while (ids.has(`manual-${next}`)) next++;
  return `manual-${next}`;
}

export function resetSongMapStructure(value, songMap) {
  const current = normalizeSongMapOverrides(value);
  const sectionIds = new Set((songMap?.sections || []).map(section => section.id));
  const roles = current.cacheKey === songMap?.cacheKey
    ? Object.fromEntries(Object.entries(current.roles).filter(([id]) => sectionIds.has(id)))
    : {};
  return {
    version: OVERRIDE_VERSION,
    cacheKey: songMap?.cacheKey || "",
    roles,
    sections: null,
    nextId: 1,
  };
}

export function songSectionLabel(section) {
  if (!section) return "Unknown";
  if (section.role.customLabel) return section.role.customLabel;
  if (section.role.value === "unknown") return `Section ${section.family}`;
  return section.role.value.split("_").map(part => (
    part ? part[0].toUpperCase() + part.slice(1) : ""
  )).join("-");
}

export function songSectionColor(section) {
  const value = String(section?.family || section?.id || "A");
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return PALETTE[(hash >>> 0) % PALETTE.length];
}

export function songCueColor(cue) {
  return {
    build: "#fbbf24",
    drop: "#f0abfc",
    peak: "#fef08a",
    breakdown: "#7dd3fc",
    release: "#93c5fd",
    turnaround: "#34d399",
    transition: "#a78bfa",
    fill: "#fb7185",
    custom: "#cbd5e1",
  }[cue?.type] || "#cbd5e1";
}

function intervalOverlap(start, end, left, right) {
  return Math.max(0, Math.min(end, right) - Math.max(start, left));
}

function limited(values, maximum) {
  return values.length <= maximum
    ? values
    : [...values.slice(0, maximum - 1), values[values.length - 1]];
}

function energyForInterval(songMap, start, end) {
  const preview = songMap.energyPreview;
  if (!preview) return null;
  const first = Math.max(0, Math.floor(start * preview.rate));
  const last = Math.min(preview.values.length, Math.max(first + 1, Math.ceil(end * preview.rate)));
  const values = preview.values.slice(first, last);
  if (!values.length) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const peak = Math.max(...values);
  const split = Math.max(1, Math.floor(values.length / 3));
  const firstMean = values.slice(0, split).reduce((sum, value) => sum + value, 0) / split;
  const tail = values.slice(-split);
  const lastMean = tail.reduce((sum, value) => sum + value, 0) / tail.length;
  const change = lastMean - firstMean;
  return {
    level: Number(mean.toFixed(2)),
    peak: Number(peak.toFixed(2)),
    trend: change >= 0.08 ? "rising" : change <= -0.08 ? "falling" : "steady",
  };
}

function sectionContext(section, coverage, songMap, midpoint) {
  const sectionPhrases = songMap.phrases.filter(phrase => phrase.sectionId === section.id);
  const phrase = sectionPhrases.find(value => value.start <= midpoint && midpoint < value.end);
  return {
    label: songSectionLabel(section),
    role: section.role.value,
    family: section.family,
    source: section.role.source,
    confidence: Number(section.role.confidence.toFixed(2)),
    coverage: Number(coverage.toFixed(2)),
    phrase: phrase ? {
      position: `${phrase.index + 1}/${sectionPhrases.length}`,
      bars: phrase.barCount,
    } : undefined,
  };
}

function sectionAt(songMap, time) {
  return songMap.sections.find(section => section.start <= time && time < section.end) ||
    songMap.sections.find(section => Math.abs(section.end - time) <= EPSILON) || null;
}

function cueTouches(cue, start, end) {
  if (cue.start === cue.end) return cue.start >= start && cue.start <= end;
  return cue.end > start && cue.start < end;
}

function cueRelationship(songMap, cue, window) {
  const beforeTime = Math.max(0, cue.start - Math.max(EPSILON, 1 / 1000));
  const afterTime = Math.min(songMap.duration, cue.end + Math.max(EPSILON, 1 / 1000));
  const before = sectionAt(songMap, beforeTime);
  const after = sectionAt(songMap, afterTime);
  const destination = before && after
    ? before.family === after.family ? "same_section" : "new_section"
    : "unknown";
  const adjacent = section => section ? {
    label: songSectionLabel(section),
    role: section.role.value,
    family: section.family,
  } : undefined;
  return {
    destination,
    section_before: adjacent(before),
    section_after: adjacent(after),
    energy_before: cue.start > 0
      ? energyForInterval(songMap, Math.max(0, cue.start - window), cue.start)
      : null,
    energy_after: cue.end < songMap.duration
      ? energyForInterval(songMap, cue.end, Math.min(songMap.duration, cue.end + window))
      : null,
  };
}

function cueContext(cue, songMap, sourceFrame, window) {
  return {
    id: cue.id,
    type: cue.type,
    kind: cue.start === cue.end ? "point" : "range",
    start_frame: sourceFrame(cue.start),
    end_frame: sourceFrame(cue.end),
    anchor_frame: sourceFrame(cue.anchor),
    source: cue.source,
    ...(cue.strength == null ? {} : { strength: Number(cue.strength.toFixed(2)) }),
    ...(cue.confidence == null ? {} : { confidence: Number(cue.confidence.toFixed(2)) }),
    ...(cue.note ? { note: cue.note } : {}),
    ...cueRelationship(songMap, cue, window),
  };
}

export function createSongWriterContext(songMap, clips, options = {}) {
  if (!songMap) return { songContext: null, boxContexts: new Map() };
  const fps = Math.max(1, finiteNumber(options.fps, 24));
  const cropStart = Math.max(0, finiteNumber(options.cropStart));
  const cropEnd = cropStart + Math.max(0, finiteNumber(options.totalFrames)) / fps;
  const bpm = Math.max(0, finiteNumber(options.bpm));
  const beatsPerBar = songMap.meter.beatsPerBar || 4;
  const lookahead = bpm > 0 ? 60 / bpm * beatsPerBar : 2;
  const sourceFrame = seconds => Math.round((seconds - cropStart) * fps);
  const visibleSections = limited(songMap.sections.filter(
    section => intervalOverlap(section.start, section.end, cropStart, cropEnd) > 0,
  ), 128);
  const visibleCues = limited(songMap.cues.filter(
    cue => cueTouches(cue, cropStart, cropEnd),
  ), 256);
  const songContext = {
    version: 2,
    tempo_bpm: Number(bpm.toFixed(2)),
    meter: songMap.meter.beatsPerBar > 0 ? {
      beats_per_bar: songMap.meter.beatsPerBar,
      confidence: Number(songMap.meter.confidence.toFixed(2)),
    } : undefined,
    sections: visibleSections.map(section => ({
      label: songSectionLabel(section),
      role: section.role.value,
      family: section.family,
      source: section.role.source,
      confidence: Number(section.role.confidence.toFixed(2)),
      start_frame: Math.max(0, sourceFrame(Math.max(section.start, cropStart))),
      end_frame: Math.min(Math.round((cropEnd - cropStart) * fps), sourceFrame(Math.min(section.end, cropEnd))),
    })),
    cues: visibleCues.map(cue => cueContext(cue, songMap, sourceFrame, lookahead)),
  };
  const boxContexts = new Map();
  clips.forEach((clip, index) => {
    const start = cropStart + clip.start / fps;
    const end = cropStart + clip.end / fps;
    const duration = Math.max(1 / fps, end - start);
    const midpoint = (start + end) / 2;
    const sections = limited(songMap.sections
      .map(section => ({
        section,
        overlap: intervalOverlap(section.start, section.end, start, end),
      }))
      .filter(entry => entry.overlap > 0)
      .map(entry => sectionContext(entry.section, entry.overlap / duration, songMap, midpoint)), 8);
    const cues = limited(songMap.cues
      .filter(cue => cueTouches(cue, start, end) || (
        cue.start > end && cue.start <= end + lookahead
      ))
      .map(cue => {
        const context = cueContext(cue, songMap, sourceFrame, lookahead);
        const frame = context.anchor_frame;
        const upcoming = cue.start > end;
        const inside = !upcoming && cue.start >= start && cue.end <= end;
        return {
          ...context,
          position: upcoming ? "upcoming" : inside ? "inside" : "overlapping",
          frame_offset: frame - clip.start,
          ...(!upcoming
            ? { frames_until_end: clip.end - frame }
            : { frames_after_end: frame - clip.end }),
        };
      }), 16);
    const previous = [...songMap.sections].reverse().find(
      section => section.end <= start && section.end >= start - lookahead,
    );
    const next = songMap.sections.find(section => section.start >= end && section.start <= end + lookahead);
    boxContexts.set(index, {
      sections,
      energy: energyForInterval(songMap, start, end),
      cues,
      previous_section: previous ? {
        label: songSectionLabel(previous),
        role: previous.role.value,
        frames_since: clip.start - sourceFrame(previous.end),
      } : undefined,
      next_section: next ? {
        label: songSectionLabel(next),
        role: next.role.value,
        frames_until: sourceFrame(next.start) - clip.end,
      } : undefined,
    });
  });
  return { songContext, boxContexts };
}
