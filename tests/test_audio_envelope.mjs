import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleSource = await readFile(
  new URL("../web/nodes/audio/audio_envelope.js", import.meta.url),
  "utf8",
);
const envelope = await import(
  `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`
);

test("envelope settings preserve three fixed slots", () => {
  const slots = [envelope.defaultEnvelopeLayer(), null, {
    ...envelope.defaultEnvelopeLayer(),
    source: "snare",
    prompt: "Flash on snares.",
  }];
  const restored = envelope.parseEnvelopeLayers(envelope.serializeEnvelopeLayers(slots));

  assert.equal(restored.length, 3);
  assert.equal(restored[0].source, "beat_grid");
  assert.equal(restored[1], null);
  assert.equal(restored[2].source, "snare");
  assert.equal(restored[2].prompt, "Flash on snares.");
});

test("frame envelope peaks on the event and releases afterward", () => {
  const layer = {
    ...envelope.defaultEnvelopeLayer(),
    attack_frames: 1,
    hold_frames: 1,
    release_frames: 2,
    curve: "linear",
  };
  const values = envelope.generateEnvelopeValues([1], 48, 24, layer);

  assert.equal(values[23], 0.5);
  assert.equal(values[24], 1);
  assert.equal(values[25], 0.75);
  assert.equal(values[26], 0.25);
  assert.equal(values[27], 0);
});

test("stride and phase select stable event subsets", () => {
  const layer = {
    ...envelope.defaultEnvelopeLayer(),
    stride: 2,
    phase: 1,
    hold_frames: 1,
    release_frames: 0,
  };
  const values = envelope.generateEnvelopeValues([0.5, 1, 1.5, 2], 60, 24, layer);

  assert.equal(values[12], 0);
  assert.equal(values[24], 1);
  assert.equal(values[36], 0);
  assert.equal(values[48], 1);
});

test("events outside the crop can contribute boundary tails", () => {
  const layer = {
    ...envelope.defaultEnvelopeLayer(),
    hold_frames: 0,
    release_frames: 6,
    curve: "linear",
  };
  const values = envelope.generateEnvelopeValues([-0.1], 12, 24, layer);

  assert.ok(values[0] > 0);
  assert.equal(values[4], 0);
});
