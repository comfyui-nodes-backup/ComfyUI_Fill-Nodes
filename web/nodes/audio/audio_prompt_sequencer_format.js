export const FORMAT_VERSION = 17;

const COMPATIBLE_FORMAT_VERSIONS = new Set([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, FORMAT_VERSION]);
const LEGACY_BPM_METHODS = new Set(["beat_intervals", "onset_strength"]);

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isCompatibleFormatVersion(value) {
  return COMPATIBLE_FORMAT_VERSIONS.has(finiteNumber(value));
}

export function restoreCachedAudioWidgets(widgets, saved) {
  const beatData = saved?.sourceAnalysis || saved?.beatData;
  if (!beatData) return;
  const audioFile = String(beatData.audioFile || "");
  const cacheKey = String(beatData.cacheKey || "");
  if (widgets.audioFile && !widgets.audioFile.value && audioFile) {
    widgets.audioFile.value = audioFile;
  }
  if (widgets.analysisCacheKey && !widgets.analysisCacheKey.value && cacheKey) {
    widgets.analysisCacheKey.value = cacheKey;
  }
}

export function migrateRemovedBpmMethod(graphData) {
  if (!Array.isArray(graphData?.nodes)) return;
  const removedInputs = new Map();
  const removedLinkIds = new Set();

  for (const node of graphData.nodes) {
    const isScheduler = node.type === "FL_Audio_Beat_Prompt_Schedule";
    const isAnalyzer = node.type === "FL_Audio_BPM_Analyzer";
    if (!isScheduler && !isAnalyzer) continue;

    let migrated = false;
    const widgetIndex = isScheduler ? 8 : 0;
    if (Array.isArray(node.widgets_values) && LEGACY_BPM_METHODS.has(node.widgets_values[widgetIndex])) {
      node.widgets_values.splice(widgetIndex, 1);
      migrated = true;
    }

    const inputIndex = Array.isArray(node.inputs)
      ? node.inputs.findIndex((input) => input?.name === "bpm_method")
      : -1;
    if (inputIndex >= 0) {
      const linkId = node.inputs[inputIndex]?.link;
      if (linkId != null) removedLinkIds.add(linkId);
      node.inputs.splice(inputIndex, 1);
      removedInputs.set(node.id, inputIndex);
      migrated = true;
    }

    if (isScheduler && migrated) {
      node.properties = node.properties || {};
      node.properties.flBeatPromptSequencer = {
        ...(node.properties.flBeatPromptSequencer || {}),
        beatData: null,
        sourceAnalysis: null,
        formatVersion: FORMAT_VERSION,
      };
    }
  }

  if (!Array.isArray(graphData.links) || !removedInputs.size) return;
  graphData.links = graphData.links.filter((link) => {
    if (!Array.isArray(link)) return true;
    const [linkId, , , targetId, targetSlot] = link;
    if (removedLinkIds.has(linkId)) return false;
    const removedSlot = removedInputs.get(targetId);
    if (removedSlot == null) return true;
    if (targetSlot === removedSlot) return false;
    if (targetSlot > removedSlot) link[4] = targetSlot - 1;
    return true;
  });
}
