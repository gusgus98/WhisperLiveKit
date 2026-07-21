// Tests for the session transcript reconciliation in live_transcription.js.
//
// Run with: node --test tests/session_lines.test.mjs
//
// The script is a plain browser script, so it is evaluated in a vm context with
// a permissive DOM stub. Only the DOM-free session-line helpers are exercised;
// everything else just needs to not throw while loading.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "whisperlivekit",
  "web",
  "live_transcription.js",
);

/** An object that tolerates any property access or call, standing in for a DOM node. */
function anything() {
  const target = function () {
    return anything();
  };
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "length") return 0;
      if (prop === Symbol.iterator) return [][Symbol.iterator].bind([]);
      if (prop === "value") return "auto";
      if (prop === "checked") return false;
      if (prop === "then") return undefined;
      return anything();
    },
    set() {
      return true;
    },
    apply() {
      return anything();
    },
  });
}

function loadScript() {
  const store = new Map();
  const context = {
    document: anything(),
    window: {
      devicePixelRatio: 1,
      location: { protocol: "http:", host: "localhost:8000", hostname: "localhost" },
    },
    navigator: { userAgent: "node", mediaDevices: undefined },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    console,
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    URL,
    Blob: class {},
    WebSocket: class {},
    location: { protocol: "http:", host: "localhost:8000" },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(SCRIPT_PATH, "utf8"), context, {
    filename: "live_transcription.js",
  });
  return context;
}

const line = (speaker, start, end, text) => ({
  speaker,
  start,
  end,
  text,
});

let ctx;
beforeEach(() => {
  ctx = loadScript();
  ctx.resetSessionLines();
});

test("a payload supersedes retained lines covering the same span", () => {
  // Diarization initially publishes a one-word fragment...
  ctx.mergeSessionLines([line(1, "0:05:25.48", "0:05:25.58", "If")]);
  // ...then re-attributes it and folds it into the surrounding speaker's block.
  ctx.mergeSessionLines([
    line(3, "0:05:22.04", "0:06:00.27", "He shall... If you could."),
  ]);

  const rendered = ctx.getSessionLinesArray();
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].speaker, 3);
  assert.equal(rendered[0].text, "He shall... If you could.");
});

test("rendered lines never overlap in time", () => {
  ctx.mergeSessionLines([
    line(1, "0:00:05.00", "0:00:05.10", "If"),
    line(1, "0:00:08.00", "0:00:08.10", "And"),
  ]);
  ctx.mergeSessionLines([line(3, "0:00:02.00", "0:00:10.00", "If and.")]);

  const rendered = ctx.getSessionLinesArray();
  for (let i = 1; i < rendered.length; i++) {
    const prevEnd = ctx.parseEndSeconds(rendered[i - 1]);
    const currStart = ctx.parseStartSeconds(rendered[i]);
    assert.ok(prevEnd <= currStart, `line ${i} overlaps the previous one`);
  }
});

test("lines pruned by the server are retained", () => {
  // The server drops lines older than ~5 min; those must survive locally.
  ctx.mergeSessionLines([line(1, "0:00:10.00", "0:00:20.00", "Early talk.")]);
  ctx.mergeSessionLines([line(2, "0:06:00.00", "0:06:10.00", "Later talk.")]);

  const rendered = ctx.getSessionLinesArray();
  assert.deepEqual(Array.from(rendered, (l) => l.text), [
    "Early talk.",
    "Later talk.",
  ]);
});

test("a growing line updates in place rather than duplicating", () => {
  ctx.mergeSessionLines([line(2, "0:01:00.00", "0:01:05.00", "Hello")]);
  ctx.mergeSessionLines([line(2, "0:01:00.00", "0:01:09.00", "Hello there.")]);

  const rendered = ctx.getSessionLinesArray();
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].text, "Hello there.");
});

test("re-attributing a speaker in place does not fork the line", () => {
  ctx.mergeSessionLines([line(1, "0:01:00.00", "0:01:05.00", "Hello there.")]);
  ctx.mergeSessionLines([line(4, "0:01:00.00", "0:01:05.00", "Hello there.")]);

  const rendered = ctx.getSessionLinesArray();
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].speaker, 4);
});

test("silence markers never enter the session transcript", () => {
  ctx.mergeSessionLines([
    line(-2, "0:00:00.00", "0:00:07.00", ""),
    line(1, "0:00:07.00", "0:00:09.00", "Back."),
  ]);

  assert.deepEqual(Array.from(ctx.getSessionLinesArray(), (l) => l.speaker), [1]);
});

test("a payload with only silence leaves the transcript untouched", () => {
  ctx.mergeSessionLines([line(1, "0:00:07.00", "0:00:09.00", "Back.")]);
  ctx.mergeSessionLines([line(-2, "0:00:09.00", "0:00:20.00", "")]);

  assert.equal(ctx.getSessionLinesArray().length, 1);
});
