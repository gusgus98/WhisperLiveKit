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

function loadScript(overrides = {}) {
  const store = new Map();
  const context = {
    document: overrides.document || anything(),
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

/** A DOM node with just enough tree behaviour to exercise reconcileLineNodes. */
class El {
  constructor(tag) {
    this.tagName = tag;
    this.className = "";
    this.children = [];
    this.parentNode = null;
    this._html = "";
    this.htmlWrites = 0;
  }

  set innerHTML(value) {
    this._html = value;
    this.htmlWrites += 1;
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }

  get innerHTML() {
    return this._html;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return this.parentNode.children[i + 1] || null;
  }

  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(node);
    else this.children.splice(i, 0, node);
    node.parentNode = this;
    return node;
  }

  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parentNode = null;
    return node;
  }
}

/**
 * Load the script with a real transcript container, so the incremental render
 * path can be observed. Everything the script touches other than the transcript
 * container still falls through to the permissive stub.
 */
function loadScriptWithDom() {
  const root = new El("div");
  const container = {
    scrollHeight: 1000,
    clientHeight: 300,
    scrollTop: 700, // pinned to the bottom by default
    scrolledTo: null,
    scrollTo(opts) {
      this.scrolledTo = opts;
    },
  };
  const fallback = anything();
  const document = new Proxy(
    {
      createElement: (tag) => new El(tag),
      getElementById: (id) => (id === "linesTranscript" ? root : fallback),
      querySelector: (sel) => (sel === ".transcript-container" ? container : fallback),
    },
    {
      get(target, prop) {
        return prop in target ? target[prop] : fallback[prop];
      },
    },
  );
  const ctx = loadScript({ document });
  ctx.resetSessionLines();
  return { ctx, root, container };
}

const line = (speaker, start, end, text) => ({
  speaker,
  start,
  end,
  text,
});

/** Push a payload through the merge + render path exactly as onmessage does. */
function deliver(ctx, lines, buffers = {}) {
  ctx.mergeSessionLines(lines);
  ctx.renderLinesWithBuffer(
    ctx.getSessionLinesArray(),
    buffers.diarization || "",
    buffers.transcription || "",
    buffers.translation || "",
    0,
    0,
    false,
  );
}

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

// --- server-side head pruning -------------------------------------------
//
// _prune() in tokens_alignment.py drops tokens older than 300s, and
// get_lines_diarization() rebuilds every line from the surviving tokens. A line
// straddling the cutoff is therefore re-sent with a LATER start and only its
// tail of text. Those re-sends must never displace the whole copy we already
// hold -- that is what ground a 44-minute transcript down to a column of ".".

test("a head-pruned line keeps the full text we already hold", () => {
  ctx.mergeSessionLines([line(1, "0:01:00.00", "0:01:08.00", "So let's look at the deck.")]);
  ctx.mergeSessionLines([line(1, "0:01:04.00", "0:01:08.00", "the deck.")]);

  const rendered = ctx.getSessionLinesArray();
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].text, "So let's look at the deck.");
});

test("progressive head-pruning never grinds a line down to punctuation", () => {
  ctx.mergeSessionLines([line(1, "0:01:00.00", "0:01:08.00", "So let's look at the deck.")]);
  // The cutoff advances a token at a time, ~20 payloads a second.
  for (const [start, text] of [
    ["0:01:04.00", "look at the deck."],
    ["0:01:06.00", "the deck."],
    ["0:01:07.50", "deck."],
    ["0:01:07.90", "."],
  ]) {
    ctx.mergeSessionLines([line(1, start, "0:01:08.00", text)]);
  }
  // ...and finally the line falls out of the server's window entirely.
  ctx.mergeSessionLines([line(2, "0:01:09.00", "0:01:12.00", "Next up.")]);

  assert.deepEqual(Array.from(ctx.getSessionLinesArray(), (l) => l.text), [
    "So let's look at the deck.",
    "Next up.",
  ]);
});

test("head-pruning does not fork a line into overlapping entries", () => {
  ctx.mergeSessionLines([line(1, "0:01:00.00", "0:01:08.00", "So let's look at the deck.")]);
  ctx.mergeSessionLines([
    line(1, "0:01:02.00", "0:01:08.00", "let's look at the deck."),
    line(2, "0:01:10.00", "0:01:14.00", "Sure."),
  ]);
  ctx.mergeSessionLines([
    line(1, "0:01:05.00", "0:01:08.00", "at the deck."),
    line(2, "0:01:10.00", "0:01:14.00", "Sure."),
  ]);

  const rendered = ctx.getSessionLinesArray();
  assert.equal(rendered.length, 2);
  for (let i = 1; i < rendered.length; i++) {
    assert.ok(
      ctx.parseEndSeconds(rendered[i - 1]) <= ctx.parseStartSeconds(rendered[i]),
      `line ${i} overlaps the previous one`,
    );
  }
});

test("repeated remnants of a line we hold whole never accumulate", () => {
  // The real shape of head-pruning: the line is finished, so its end stays put
  // while its start creeps forward. _MAX_LINE_SECONDS guarantees this -- a line
  // is always published whole before its head can be cut. At 20 payloads a
  // second an accumulating seam would balloon the transcript.
  ctx.mergeSessionLines([
    line(1, "0:01:00.00", "0:01:08.00", "Line A, said in full."),
    line(2, "0:01:10.00", "0:01:14.00", "Line B."),
  ]);
  for (const [start, text] of [
    ["0:01:03.00", "said in full."],
    ["0:01:05.00", "in full."],
    ["0:01:07.00", "full."],
    ["0:01:07.90", "."],
  ]) {
    ctx.mergeSessionLines([
      line(1, start, "0:01:08.00", text),
      line(2, "0:01:10.00", "0:01:14.00", "Line B."),
    ]);
  }

  const rendered = ctx.getSessionLinesArray();
  assert.equal(rendered.length, 2, "remnants accumulated instead of being dropped");
  assert.equal(rendered[0].text, "Line A, said in full.");
});

test("a first line reaching past our copy is kept, not mistaken for a remnant", () => {
  // Boundary jitter, not head-pruning: as diarization settles the server
  // re-splits a span and the new line can start slightly before ours ended.
  // Treating any overlap as a remnant discarded real speech on a real meeting.
  ctx.mergeSessionLines([
    line(1, "0:02:45.00", "0:02:51.50", "Earlier sentence."),
    line(1, "0:02:51.96", "0:03:02.22", "For the current destination."),
  ]);
  // The server re-derives the span from 2:51.18 -- 0.32s before our line ended.
  ctx.mergeSessionLines([
    line(1, "0:02:51.18", "0:03:02.22", "... For the current destination. So right now."),
  ]);

  const texts = Array.from(ctx.getSessionLinesArray(), (l) => l.text);
  assert.ok(
    texts.some((t) => t.includes("So right now")),
    "the re-split line was discarded as a remnant",
  );
  assert.ok(texts.includes("Earlier sentence."), "the untouched earlier line was lost");
});

test("two lines sharing a start keep both texts", () => {
  // A zero-duration segment can leave two lines on the same start. sessionLines
  // is keyed by start alone (deliberately, so re-attribution updates in place),
  // so the pair has to be reconciled rather than silently overwritten.
  ctx.mergeSessionLines([
    line(1, "0:00:10.00", "0:00:10.00", "Zero width."),
    line(2, "0:00:10.00", "0:00:14.00", "Real line."),
  ]);

  const text = Array.from(ctx.getSessionLinesArray(), (l) => l.text).join(" ");
  assert.ok(text.includes("Zero width."), "zero-duration line was dropped");
  assert.ok(text.includes("Real line."), "following line was dropped");
});

// --- incremental rendering ----------------------------------------------

test("settled lines are not re-rendered when a new line arrives", () => {
  const { ctx, root } = loadScriptWithDom();
  const first = line(1, "0:00:00.00", "0:00:04.00", "One.");
  const second = line(1, "0:00:04.00", "0:00:08.00", "Two.");

  deliver(ctx, [first, second]);
  const firstNode = root.children[0];
  const writesBefore = firstNode.htmlWrites;

  // The payload re-sends the earlier lines verbatim, as the server always does.
  deliver(ctx, [
    { ...first },
    { ...second },
    line(2, "0:00:08.00", "0:00:12.00", "Three."),
  ]);

  assert.equal(root.children.length, 3);
  assert.equal(root.children[0], firstNode, "settled line was replaced");
  assert.equal(firstNode.htmlWrites, writesBefore, "settled line was re-rendered");
});

test("rendered nodes stay in transcript order as lines are re-split", () => {
  const { ctx, root } = loadScriptWithDom();

  deliver(ctx, [line(1, "0:00:00.00", "0:00:10.00", "One two.")]);
  // Diarization catches up and splits that span across two speakers.
  deliver(ctx, [
    line(1, "0:00:00.00", "0:00:05.00", "One."),
    line(2, "0:00:05.00", "0:00:10.00", "Two."),
  ]);
  deliver(ctx, [
    line(1, "0:00:00.00", "0:00:05.00", "One."),
    line(2, "0:00:05.00", "0:00:10.00", "Two."),
    line(1, "0:00:10.00", "0:00:14.00", "Three."),
  ]);

  assert.equal(root.children.length, 3);
  const texts = root.children.map((el) => el.innerHTML);
  assert.ok(texts[0].includes("One."), "first node out of order");
  assert.ok(texts[1].includes("Two."), "second node out of order");
  assert.ok(texts[2].includes("Three."), "third node out of order");
});

test("a line dropped from the transcript loses its rendered node", () => {
  const { ctx, root } = loadScriptWithDom();

  deliver(ctx, [
    line(1, "0:00:00.00", "0:00:05.00", "One."),
    line(2, "0:00:05.00", "0:00:10.00", "Two."),
  ]);
  assert.equal(root.children.length, 2);

  // A re-split folds both into a single line under one speaker.
  deliver(ctx, [line(3, "0:00:00.00", "0:00:10.00", "One two.")]);

  assert.equal(root.children.length, 1);
  assert.ok(root.children[0].innerHTML.includes("One two."));
});

test("scrolling up is not undone by incoming payloads", () => {
  const { ctx, container } = loadScriptWithDom();

  deliver(ctx, [line(1, "0:00:00.00", "0:00:04.00", "One.")]);
  assert.ok(container.scrolledTo, "should follow the transcript when pinned to the bottom");

  // The reader scrolls up to re-read something.
  container.scrolledTo = null;
  container.scrollTop = 0;
  deliver(ctx, [
    line(1, "0:00:00.00", "0:00:04.00", "One."),
    line(1, "0:00:04.00", "0:00:08.00", "Two."),
  ]);

  assert.equal(container.scrolledTo, null, "reader was yanked back to the bottom");
});

test("a same-start pair inside a head-cut line does not disturb it", () => {
  // The fold runs before the head-cut check, so a folded pair landing inside a
  // line we already hold whole is dropped like any other remnant -- its text is
  // by definition already in the copy we kept.
  ctx.mergeSessionLines([line(1, "0:01:00.00", "0:01:08.00", "So let's look at the deck.")]);
  ctx.mergeSessionLines([
    line(1, "0:01:04.00", "0:01:04.00", ""),
    line(1, "0:01:04.00", "0:01:08.00", "the deck."),
    line(2, "0:01:10.00", "0:01:14.00", "Sure."),
  ]);

  assert.deepEqual(Array.from(ctx.getSessionLinesArray(), (l) => l.text), [
    "So let's look at the deck.",
    "Sure.",
  ]);
});

test("whole-line pruning still reconciles without diarization", () => {
  // Without diarization, validated_segments are pruned whole -- lines drop out
  // of the payload entirely rather than being head-cut. That path must keep
  // working under the new predicate.
  ctx.mergeSessionLines([
    line(1, "0:00:10.00", "0:00:14.00", "First sentence."),
    line(1, "0:00:14.00", "0:00:18.00", "Second sentence."),
  ]);
  ctx.mergeSessionLines([
    line(1, "0:00:14.00", "0:00:18.00", "Second sentence."),
    line(1, "0:05:20.00", "0:05:24.00", "Much later."),
  ]);

  assert.deepEqual(Array.from(ctx.getSessionLinesArray(), (l) => l.text), [
    "First sentence.",
    "Second sentence.",
    "Much later.",
  ]);
});
