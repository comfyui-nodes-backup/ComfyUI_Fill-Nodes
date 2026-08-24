import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const VIDEO_NODE_URL = new URL("../web/nodes/video/", import.meta.url);

class FakeElement {
  constructor() {
    this.listeners = new Map();
    this.events = [];
  }

  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }

  dispatchEvent(event) {
    this.events.push(event);
  }

  emit(name, event) {
    for (const handler of this.listeners.get(name) || []) handler(event);
  }
}

class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(this, init);
    this.type = type;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }
}

globalThis.PointerEvent = FakeEvent;
globalThis.WheelEvent = FakeEvent;

const source = await readFile(new URL("canvas_navigation.js", VIDEO_NODE_URL), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const { addCanvasNavigation } = await import(moduleUrl);

function pointerEvent(type, overrides = {}) {
  return new FakeEvent(type, {
    pointerId: 4,
    button: -1,
    buttons: 0,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...overrides,
  });
}

test("video panels pass wheel and canvas drag gestures to LiteGraph", () => {
  const element = new FakeElement();
  const graphCanvas = new FakeElement();
  const canvas = { canvas: graphCanvas, dragZoomEnabled: true, read_only: false };
  addCanvasNavigation(element, canvas);

  const wheel = new FakeEvent("wheel", { deltaY: -120 });
  element.emit("wheel", wheel);
  assert.deepEqual(graphCanvas.events.map((event) => event.type), ["wheel"]);
  assert.equal(wheel.defaultPrevented, true);
  assert.equal(wheel.propagationStopped, true);

  element.emit("pointerdown", pointerEvent("pointerdown", { button: 0, buttons: 1 }));
  assert.equal(graphCanvas.events.length, 1);

  element.emit("pointerdown", pointerEvent("pointerdown", { button: 1, buttons: 4 }));
  element.emit("pointermove", pointerEvent("pointermove", { buttons: 4 }));
  element.emit("pointerup", pointerEvent("pointerup", { button: 1 }));
  element.emit("pointermove", pointerEvent("pointermove", { buttons: 4 }));
  assert.deepEqual(
    graphCanvas.events.map((event) => event.type),
    ["wheel", "pointerdown", "pointermove", "pointerup"],
  );

  canvas.read_only = true;
  element.emit("pointerdown", pointerEvent("pointerdown", { button: 0, buttons: 1 }));
  element.emit("pointerup", pointerEvent("pointerup", { button: 0 }));
  assert.deepEqual(graphCanvas.events.slice(-2).map((event) => event.type), ["pointerdown", "pointerup"]);

  canvas.read_only = false;
  element.emit("pointerdown", pointerEvent("pointerdown", {
    button: 0,
    buttons: 1,
    ctrlKey: true,
    shiftKey: true,
  }));
  element.emit("pointercancel", pointerEvent("pointercancel", { button: 0 }));
  assert.deepEqual(graphCanvas.events.slice(-2).map((event) => event.type), ["pointerdown", "pointercancel"]);
});

test("both FL video DOM widgets enable canvas navigation", async () => {
  for (const filename of ["FL_VideoCombine.js", "FL_LoadVideo.js"]) {
    const nodeSource = await readFile(new URL(filename, VIDEO_NODE_URL), "utf8");
    assert.match(nodeSource, /import \{ addCanvasNavigation \} from "\.\/canvas_navigation\.js";/);
    assert.match(nodeSource, /addCanvasNavigation\(container, app\.canvas\);/);
  }
});
