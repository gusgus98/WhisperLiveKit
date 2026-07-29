"""End-to-end check that a long meeting's transcript survives intact.

Neither half of the system can catch the failure alone. The server prunes tokens
older than ``_DEFAULT_RETENTION_SECONDS`` and rebuilds its line list from what is
left; the browser accumulates those payloads into the full session transcript.
Text loss only appears when the two run against each other, so this drives the
real ``TokensAlignment`` to produce the payload sequence a websocket would send,
then replays it through the real ``live_transcription.js`` merge logic in node.

Regression guard for: a 44-minute meeting downloading as a column of "." because
every line older than 5 minutes had been ground down to its final token.
"""

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from whisperlivekit.timed_objects import ASRToken, SpeakerSegment, TimedText
from whisperlivekit.tokens_alignment import TokensAlignment

CLIENT_JS = Path(__file__).resolve().parents[1] / "whisperlivekit" / "web" / "live_transcription.js"

MEETING_SECONDS = 20 * 60
# Every word is unique so a missing or duplicated one can be located exactly.
# A repeating vocabulary makes the diff align arbitrarily and tells you nothing.
DIAR_CHUNK = 2.0
DIAR_LAG = 3.0
# One speaker holds the floor across this span, so the line there would grow
# without bound if _MAX_LINE_SECONDS did not cut it.
MONOLOGUE = (300.0, 700.0)


class _State:
    def __init__(self):
        self.new_tokens = []
        self.new_diarization = []
        self.new_translation = []
        self.new_tokens_buffer = []
        self.new_translation_buffer = TimedText()


def _build_meeting():
    """Sentences of ~4s, speaker turns every ~40s, one long monologue in the middle."""
    tokens = []
    turns = []
    t = 0.0
    sentence_idx = 0
    speaker = 0
    speaker_started = 0.0
    while t < MEETING_SECONDS:
        in_monologue = MONOLOGUE[0] <= t < MONOLOGUE[1]
        for w in range(6):
            text = f"w{len(tokens)}"
            if w == 5:
                text += "."
            tokens.append(ASRToken(start=t, end=t + 0.6, text=text + " "))
            t += 0.65
        sentence_idx += 1
        t += 0.4
        if not in_monologue and t - speaker_started > 40.0:
            turns.append((speaker_started, t, speaker))
            speaker = (speaker + 1) % 3
            speaker_started = t
    turns.append((speaker_started, t + 5.0, speaker))

    # Diarization arrives as a steady stream of short segments regardless of who
    # is talking -- Sortformer emits every chunk, it does not wait for a turn.
    diarization = []
    for start, end, spk in turns:
        cursor = start
        while cursor < end:
            diarization.append(
                SpeakerSegment(start=cursor, end=min(cursor + DIAR_CHUNK, end), speaker=spk)
            )
            cursor += DIAR_CHUNK
    return tokens, diarization


def _capture_payloads():
    """Return (payload sequence, ground truth text) for the simulated meeting."""
    tokens, diarization = _build_meeting()
    state = _State()
    alignment = TokensAlignment(state, None, sep="")

    events = [(tok.end, "token", tok) for tok in tokens]
    events += [(seg.end + DIAR_LAG, "diar", seg) for seg in diarization]
    events.sort(key=lambda e: e[0])

    payloads = []
    for when, kind, item in events:
        if kind == "token":
            state.new_tokens.append(item)
        else:
            state.new_diarization.append(item)
        alignment.update()
        lines, _buffer, _translation = alignment.get_lines(diarization=True, audio_time=when)
        payloads.append([segment.to_dict() for segment in lines])

    return payloads, "".join(tok.text for tok in tokens)


_REPLAY_JS = r"""
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

function anything() {
  const target = function () { return anything(); };
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "length") return 0;
      if (prop === Symbol.iterator) return [][Symbol.iterator].bind([]);
      if (prop === "value") return "auto";
      if (prop === "checked") return false;
      if (prop === "then") return undefined;
      return anything();
    },
    set: () => true,
    apply: () => anything(),
  });
}

const store = new Map();
const context = {
  document: anything(),
  window: { devicePixelRatio: 1, location: { protocol: "http:", host: "x", hostname: "x" } },
  navigator: { userAgent: "node", mediaDevices: undefined },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  },
  console,
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, URL, Blob: class {}, WebSocket: class {},
  location: { protocol: "http:", host: "x" },
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(readFileSync(process.argv[2], "utf8"), context, { filename: "live_transcription.js" });
context.resetSessionLines();

for (const payload of JSON.parse(readFileSync(process.argv[3], "utf8"))) {
  context.mergeSessionLines(payload);
}

const lines = context.getSessionLinesArray();
process.stdout.write(JSON.stringify({
  lineCount: lines.length,
  firstStart: lines.length ? lines[0].start : null,
  text: lines.map((l) => (l.text || "").trim()).join(" "),
}));
"""


def _replay_in_browser_logic(payloads):
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required to exercise the browser-side merge logic")

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        replay = tmp / "replay.cjs"
        replay.write_text(_REPLAY_JS, encoding="utf-8")
        payload_file = tmp / "payloads.json"
        payload_file.write_text(json.dumps(payloads), encoding="utf-8")

        result = subprocess.run(
            [node, str(replay), str(CLIENT_JS), str(payload_file)],
            capture_output=True,
            text=True,
            timeout=120,
        )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_long_meeting_transcript_survives_server_pruning():
    payloads, ground_truth = _capture_payloads()
    assert len(payloads) > 1000, "simulation should produce a realistic payload stream"

    rendered = _replay_in_browser_logic(payloads)

    spoken = ground_truth.split()
    kept = rendered["text"].split()

    # Losing text is the failure this whole change exists to prevent, so it is
    # asserted absolutely: every spoken word, in order.
    missing = []
    cursor = 0
    for word in spoken:
        try:
            cursor = kept.index(word, cursor) + 1
        except ValueError:
            missing.append(word)
    assert not missing, (
        f"{len(missing)} of {len(spoken)} words lost (first: {missing[:5]}); "
        f"transcript starts at {rendered['firstStart']}"
    )
    assert rendered["firstStart"] == "0:00:00.00", "the start of the meeting was dropped"

    # Duplication at a re-segmentation seam is tolerated but must stay marginal.
    # The client cannot split a line's text by time, so when the server re-derives
    # a span slightly differently the choice is a few repeated words or a hole --
    # and a hole is the worse outcome for anything reading the transcript.
    extra = len(kept) - len(spoken)
    assert extra <= len(spoken) * 0.02, f"{extra} duplicated words of {len(spoken)}"


def test_no_line_outlives_the_retention_window():
    """The guarantee the browser-side fix relies on: lines are always sent whole."""
    from whisperlivekit.tokens_alignment import _DEFAULT_RETENTION_SECONDS

    payloads, _ = _capture_payloads()

    def seconds(value):
        hours, minutes, secs = value.split(":")
        return int(hours) * 3600 + int(minutes) * 60 + float(secs)

    longest = max(
        seconds(line["end"]) - seconds(line["start"])
        for payload in payloads
        for line in payload
    )
    # Slack between the longest line and the prune cutoff is the diarization lag
    # budget -- a line must be complete before its head starts being eaten.
    assert longest < _DEFAULT_RETENTION_SECONDS / 2, f"longest line was {longest:.0f}s"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
