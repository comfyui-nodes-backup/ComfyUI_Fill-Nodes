import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const AUDIO_NODE_URL = new URL("../web/nodes/audio/", import.meta.url);

async function importModuleBody(filename, startMarker) {
  const source = await readFile(new URL(filename, AUDIO_NODE_URL), "utf8");
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1);
  const encoded = Buffer.from(source.slice(start)).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

test("sequencer editor remains a valid ESM module after extraction", async () => {
  const module = await importModuleBody("audio_prompt_sequencer_editor.js", "const EPSILON");
  assert.equal(typeof module.BeatPromptSequencer, "function");
});

test("sequencer modal remains a valid ESM module after extraction", async () => {
  const module = await importModuleBody("audio_prompt_sequencer_modal.js", "const INSTANCES");
  assert.equal(typeof module.openBeatPromptSequencer, "function");
  assert.equal(typeof module.closeBeatPromptSequencerForNode, "function");
});
