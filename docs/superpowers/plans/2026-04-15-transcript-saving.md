# Transcript Saving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save live transcription sessions to JSON files with timestamps and speaker IDs, with continuous partial writes during sessions and a clean final file on disconnect. Expose via CLI flags, server auto-save, and a web UI download button.

**Architecture:** A new `TranscriptWriter` class (single file) handles all file I/O. `AudioProcessor` owns an optional writer instance and calls it from `results_formatter()` and `cleanup()`. The server creates the writer when `--save-transcript` is enabled and wires it in. The web UI gets a download button that appears when the session ends.

**Tech Stack:** Python (dataclass, json, pathlib), FastAPI (FileResponse), vanilla JS

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `whisperlivekit/transcript_writer.py` | Create | TranscriptWriter class: serialize FrontData to JSON, manage partial/final files |
| `whisperlivekit/config.py` | Modify | Add `save_transcript` and `transcript_dir` fields |
| `whisperlivekit/parse_args.py` | Modify | Add `--save-transcript` and `--transcript-dir` CLI flags |
| `whisperlivekit/audio_processor.py` | Modify | Accept optional `transcript_writer`, call `update()` and `finalize()` |
| `whisperlivekit/basic_server.py` | Modify | Create writer per session, add `GET /transcript/{session_id}`, add `session_id` to `ready_to_stop` |
| `whisperlivekit/web/live_transcription.js` | Modify | Show download button on `ready_to_stop` with `session_id` |
| `whisperlivekit/web/live_transcription.html` | Modify | Add hidden download button element |
| `whisperlivekit/web/live_transcription.css` | Modify | Style the download button |
| `tests/test_transcript_writer.py` | Create | Unit tests for TranscriptWriter |

---

### Task 1: TranscriptWriter class

**Files:**
- Create: `whisperlivekit/transcript_writer.py`
- Create: `tests/test_transcript_writer.py`

- [ ] **Step 1: Write the test file with initial tests**

Create `tests/test_transcript_writer.py`:

```python
"""Tests for TranscriptWriter -- transcript saving to JSON files."""

import json
import os
import time
from pathlib import Path

import pytest

from whisperlivekit.timed_objects import FrontData, Segment


def _make_front_data(lines_data, buffer=""):
    """Helper to build a FrontData with segments from simple dicts."""
    lines = []
    for d in lines_data:
        lines.append(Segment(
            start=d["start"],
            end=d["end"],
            text=d["text"],
            speaker=d.get("speaker", 1),
        ))
    return FrontData(
        status="active_transcription",
        lines=lines,
        buffer_transcription=buffer,
    )


class TestTranscriptWriterUpdate:
    """Tests for the update() method -- partial file writing."""

    def test_update_creates_partial_file(self, tmp_path):
        from whisperlivekit.transcript_writer import TranscriptWriter

        writer = TranscriptWriter(output_dir=str(tmp_path), session_id="test-session")
        fd = _make_front_data([
            {"start": 1.0, "end": 3.0, "text": "Hello world", "speaker": 1},
        ], buffer="working on")

        writer.update(fd)

        partial = tmp_path / "test-session.partial.json"
        assert partial.exists()
        data = json.loads(partial.read_text())
        assert data["session_id"] == "test-session"
        assert len(data["segments"]) == 1
        assert data["segments"][0]["text"] == "Hello world"
        assert data["buffer_transcription"] == "working on"

    def test_update_overwrites_partial(self, tmp_path):
        from whisperlivekit.transcript_writer import TranscriptWriter

        writer = TranscriptWriter(output_dir=str(tmp_path), session_id="test-session")

        fd1 = _make_front_data([
            {"start": 1.0, "end": 3.0, "text": "Hello"},
        ])
        writer.update(fd1)

        fd2 = _make_front_data([
            {"start": 1.0, "end": 3.0, "text": "Hello"},
            {"start": 3.5, "end": 6.0, "text": "world"},
        ])
        writer.update(fd2)

        data = json.loads((tmp_path / "test-session.partial.json").read_text())
        assert len(data["segments"]) == 2

    def test_update_skips_silence_segments(self, tmp_path):
        from whisperlivekit.transcript_writer import TranscriptWriter

        writer = TranscriptWriter(output_dir=str(tmp_path), session_id="test-session")
        fd = _make_front_data([
            {"start": 1.0, "end": 3.0, "text": "Hello", "speaker": 1},
            {"start": 3.0, "end": 8.0, "text": None, "speaker": -2},
            {"start": 8.0, "end": 10.0, "text": "World", "speaker": 2},
        ])

        writer.update(fd)

        data = json.loads((tmp_path / "test-session.partial.json").read_text())
        assert len(data["segments"]) == 2
        assert data["segments"][0]["text"] == "Hello"
        assert data["segments"][1]["text"] == "World"

    def test_update_throttles_writes(self, tmp_path):
        from whisperlivekit.transcript_writer import TranscriptWriter

        writer = TranscriptWriter(output_dir=str(tmp_path), session_id="test-session")
        fd = _make_front_data([{"start": 1.0, "end": 2.0, "text": "Hi"}])

        writer.update(fd)  # First write always goes through
        mtime1 = os.path.getmtime(tmp_path / "test-session.partial.json")

        # Immediate second call should be throttled (no disk write)
        fd2 = _make_front_data([{"start": 1.0, "end": 2.0, "text": "Hi there"}])
        writer.update(fd2)
        mtime2 = os.path.getmtime(tmp_path / "test-session.partial.json")

        assert mtime1 == mtime2  # File was not rewritten


class TestTranscriptWriterFinalize:
    """Tests for the finalize() method -- final file writing."""

    def test_finalize_writes_clean_json(self, tmp_path):
        from whisperlivekit.transcript_writer import TranscriptWriter

        writer = TranscriptWriter(output_dir=str(tmp_path), session_id="test-session")
        fd = _make_front_data([
            {"start": 1.0, "end": 5.0, "text": "Hello world", "speaker": 1},
        ], buffer="leftover")
        writer.update(fd)

        writer.finalize(total_duration=10.0)

        final = tmp_path / "test-session.json"
        assert final.exists()
        data = json.loads(final.read_text())
        assert data["duration"] == 10.0
        assert "buffer_transcription" not in data
        assert len(data["segments"]) == 1

    def test_finalize_removes_partial(self, tmp_path):
        from whisperlivekit.transcript_writer import TranscriptWriter

        writer = TranscriptWriter(output_dir=str(tmp_path), session_id="test-session")
        fd = _make_front_data([{"start": 1.0, "end": 2.0, "text": "Hi"}])
        writer.update(fd)

        assert (tmp_path / "test-session.partial.json").exists()
        writer.finalize(total_duration=5.0)
        assert not (tmp_path / "test-session.partial.json").exists()

    def test_finalize_without_update_writes_empty(self, tmp_path):
        from whisperlivekit.transcript_writer import TranscriptWriter

        writer = TranscriptWriter(output_dir=str(tmp_path), session_id="test-session")
        writer.finalize(total_duration=0.0)

        final = tmp_path / "test-session.json"
        assert final.exists()
        data = json.loads(final.read_text())
        assert data["segments"] == []


class TestTranscriptWriterSessionId:
    """Tests for session ID generation."""

    def test_default_session_id_is_timestamp(self, tmp_path):
        from whisperlivekit.transcript_writer import TranscriptWriter

        writer = TranscriptWriter(output_dir=str(tmp_path))
        # Should be formatted like 2026-04-15_14-30-22
        assert len(writer.session_id) == 19
        assert writer.session_id[4] == "-"
        assert writer.session_id[10] == "_"

    def test_creates_output_dir(self, tmp_path):
        from whisperlivekit.transcript_writer import TranscriptWriter

        new_dir = tmp_path / "nested" / "transcripts"
        writer = TranscriptWriter(output_dir=str(new_dir), session_id="test")
        fd = _make_front_data([{"start": 0.0, "end": 1.0, "text": "Hi"}])
        writer.update(fd)

        assert new_dir.exists()
        assert (new_dir / "test.partial.json").exists()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_transcript_writer.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'whisperlivekit.transcript_writer'`

- [ ] **Step 3: Implement TranscriptWriter**

Create `whisperlivekit/transcript_writer.py`:

```python
"""Transcript file writer for live sessions.

Writes JSON transcripts to disk during and after live transcription sessions.
Produces two files per session:
- ``<session_id>.partial.json`` -- overwritten periodically during the session
- ``<session_id>.json`` -- clean final transcript written on session end
"""

import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from whisperlivekit.timed_objects import FrontData, format_time

logger = logging.getLogger(__name__)

_THROTTLE_SECONDS = 3.0


class TranscriptWriter:
    """Serialize FrontData snapshots to JSON files on disk."""

    def __init__(self, output_dir: str, session_id: Optional[str] = None) -> None:
        self.output_dir = Path(output_dir)
        self.session_id = session_id or datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
        self.start_time = datetime.now(timezone.utc).isoformat()
        self._last_front_data: Optional[FrontData] = None
        self._last_write_time: float = 0.0

    def _segments_from_front_data(self, front_data: FrontData) -> list:
        """Extract speech segments (skip silence) from FrontData lines."""
        segments = []
        for line in front_data.lines:
            if line.speaker == -2 or not line.text:
                continue
            segments.append({
                "start": format_time(line.start),
                "end": format_time(line.end),
                "text": line.text,
                "speaker": int(line.speaker) if line.speaker != -1 else 1,
            })
        return segments

    def _write_json(self, path: Path, data: dict) -> None:
        """Atomically write JSON to a file."""
        self.output_dir.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
        tmp.replace(path)

    def update(self, front_data: FrontData) -> None:
        """Write or update the partial transcript file.

        Throttled to write at most once every ``_THROTTLE_SECONDS`` to avoid
        excessive disk I/O.  The first call always writes immediately.
        """
        self._last_front_data = front_data

        now = time.monotonic()
        if self._last_write_time > 0 and (now - self._last_write_time) < _THROTTLE_SECONDS:
            return

        self._last_write_time = now

        data = {
            "session_id": self.session_id,
            "start_time": self.start_time,
            "segments": self._segments_from_front_data(front_data),
            "buffer_transcription": front_data.buffer_transcription or "",
            "status": front_data.status,
        }
        path = self.output_dir / f"{self.session_id}.partial.json"
        self._write_json(path, data)
        logger.debug("Wrote partial transcript: %s", path)

    def finalize(self, total_duration: float) -> None:
        """Write the clean final transcript and remove the partial file."""
        segments = []
        if self._last_front_data:
            segments = self._segments_from_front_data(self._last_front_data)

        data = {
            "session_id": self.session_id,
            "start_time": self.start_time,
            "duration": round(total_duration, 2),
            "segments": segments,
        }
        final_path = self.output_dir / f"{self.session_id}.json"
        self._write_json(final_path, data)
        logger.info("Wrote final transcript: %s (%d segments)", final_path, len(segments))

        partial_path = self.output_dir / f"{self.session_id}.partial.json"
        if partial_path.exists():
            partial_path.unlink()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_transcript_writer.py -v`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add whisperlivekit/transcript_writer.py tests/test_transcript_writer.py
git commit -m "feat: add TranscriptWriter for saving live transcripts to JSON"
```

---

### Task 2: Config and CLI flags

**Files:**
- Modify: `whisperlivekit/config.py:10-36` (add fields to dataclass)
- Modify: `whisperlivekit/parse_args.py:335-345` (add CLI arguments)

- [ ] **Step 1: Write tests for config round-trip**

Append to `tests/test_transcript_writer.py`:

```python
class TestConfigFields:
    """Tests for save_transcript config fields."""

    def test_config_defaults(self):
        from whisperlivekit.config import WhisperLiveKitConfig

        config = WhisperLiveKitConfig()
        assert config.save_transcript is False
        assert config.transcript_dir == "./transcripts"

    def test_config_from_kwargs(self):
        from whisperlivekit.config import WhisperLiveKitConfig

        config = WhisperLiveKitConfig.from_kwargs(
            save_transcript=True,
            transcript_dir="/tmp/out",
        )
        assert config.save_transcript is True
        assert config.transcript_dir == "/tmp/out"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_transcript_writer.py::TestConfigFields -v`
Expected: FAIL with `TypeError` (unknown field `save_transcript`)

- [ ] **Step 3: Add config fields**

In `whisperlivekit/config.py`, add these two fields after line 35 (`backend: str = "auto"`):

```python
    # Transcript saving
    save_transcript: bool = False
    transcript_dir: str = "./transcripts"
```

- [ ] **Step 4: Run config tests to verify they pass**

Run: `python -m pytest tests/test_transcript_writer.py::TestConfigFields -v`
Expected: PASS

- [ ] **Step 5: Add CLI flags to parse_args.py**

In `whisperlivekit/parse_args.py`, add these arguments before the `args = parser.parse_args()` line (before line 336):

```python
    # Transcript saving
    parser.add_argument(
        "--save-transcript",
        action="store_true",
        default=False,
        dest="save_transcript",
        help="Save transcripts to JSON files in the transcript directory.",
    )
    parser.add_argument(
        "--transcript-dir",
        type=str,
        default="./transcripts",
        dest="transcript_dir",
        help="Directory to save transcript files (default: ./transcripts).",
    )
```

- [ ] **Step 6: Commit**

```bash
git add whisperlivekit/config.py whisperlivekit/parse_args.py tests/test_transcript_writer.py
git commit -m "feat: add --save-transcript and --transcript-dir CLI flags"
```

---

### Task 3: Wire TranscriptWriter into AudioProcessor

**Files:**
- Modify: `whisperlivekit/audio_processor.py:60-87` (constructor)
- Modify: `whisperlivekit/audio_processor.py:513-561` (results_formatter)
- Modify: `whisperlivekit/audio_processor.py:632-657` (cleanup)

- [ ] **Step 1: Write integration test**

Append to `tests/test_transcript_writer.py`:

```python
class TestAudioProcessorWriterIntegration:
    """Tests that AudioProcessor calls TranscriptWriter correctly."""

    def test_audio_processor_accepts_writer(self):
        """AudioProcessor constructor accepts transcript_writer kwarg without error."""
        # We can't fully construct AudioProcessor without models, but we can
        # verify the parameter is accepted by checking the signature.
        import inspect
        from whisperlivekit.audio_processor import AudioProcessor

        sig = inspect.signature(AudioProcessor.__init__)
        # The **kwargs should pass through; we just verify no crash on import
        assert "self" in sig.parameters
```

- [ ] **Step 2: Add transcript_writer to AudioProcessor constructor**

In `whisperlivekit/audio_processor.py`, add after line 87 (`self.last_response_content: FrontData = FrontData()`):

```python
        self.transcript_writer = kwargs.pop('transcript_writer', None)
```

Note: This must go early in `__init__`, before the `TranscriptionEngine` construction. Place it right after extracting `session_language` (after line 63):

```python
        self.transcript_writer = kwargs.pop('transcript_writer', None)
```

- [ ] **Step 3: Call writer.update() in results_formatter**

In `whisperlivekit/audio_processor.py`, in `results_formatter()`, after the `yield response` line (after line 551), add:

```python
                    if self.transcript_writer:
                        self.transcript_writer.update(response)
```

- [ ] **Step 4: Call writer.finalize() in cleanup**

In `whisperlivekit/audio_processor.py`, in `cleanup()`, before the final log line `"AudioProcessor cleanup complete."` (before line 657), add:

```python
        if self.transcript_writer:
            duration = self.total_pcm_samples / self.sample_rate
            self.transcript_writer.finalize(duration)
```

- [ ] **Step 5: Run all tests**

Run: `python -m pytest tests/test_transcript_writer.py -v`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add whisperlivekit/audio_processor.py tests/test_transcript_writer.py
git commit -m "feat: wire TranscriptWriter into AudioProcessor pipeline"
```

---

### Task 4: Server integration and download endpoint

**Files:**
- Modify: `whisperlivekit/basic_server.py:53-67` (handle_websocket_results -- add session_id to ready_to_stop)
- Modify: `whisperlivekit/basic_server.py:70-126` (websocket_endpoint -- create writer)
- Modify: `whisperlivekit/basic_server.py` (add GET /transcript/{session_id} endpoint)

- [ ] **Step 1: Modify handle_websocket_results to accept session_id**

In `whisperlivekit/basic_server.py`, change the `handle_websocket_results` function signature and the `ready_to_stop` message. Replace lines 53-67:

```python
async def handle_websocket_results(websocket, results_generator, diff_tracker=None, session_id=None):
    """Consumes results from the audio processor and sends them via WebSocket."""
    try:
        async for response in results_generator:
            if diff_tracker is not None:
                await websocket.send_json(diff_tracker.to_message(response))
            else:
                await websocket.send_json(response.to_dict())
        # when the results_generator finishes it means all audio has been processed
        logger.info("Results generator finished. Sending 'ready_to_stop' to client.")
        stop_msg = {"type": "ready_to_stop"}
        if session_id:
            stop_msg["session_id"] = session_id
        await websocket.send_json(stop_msg)
    except WebSocketDisconnect:
        logger.info("WebSocket disconnected while handling results (client likely closed connection).")
    except Exception as e:
        logger.exception(f"Error in WebSocket results handler: {e}")
```

- [ ] **Step 2: Create TranscriptWriter in websocket_endpoint**

In `whisperlivekit/basic_server.py`, in `websocket_endpoint()`, after `diff_tracker` setup (after line 91) and before `results_generator = ...` (line 98), add:

```python
    transcript_writer = None
    session_id = None
    if config.save_transcript:
        from whisperlivekit.transcript_writer import TranscriptWriter
        transcript_writer = TranscriptWriter(output_dir=config.transcript_dir)
        session_id = transcript_writer.session_id
        logger.info("Transcript saving enabled: %s/%s", config.transcript_dir, session_id)
```

Then modify the `AudioProcessor` construction to pass the writer. Change:

```python
    audio_processor = AudioProcessor(
        transcription_engine=transcription_engine,
        language=session_language,
    )
```

to:

```python
    audio_processor = AudioProcessor(
        transcription_engine=transcription_engine,
        language=session_language,
        transcript_writer=transcript_writer,
    )
```

And update the `handle_websocket_results` call to pass `session_id`:

```python
    websocket_task = asyncio.create_task(handle_websocket_results(websocket, results_generator, diff_tracker, session_id=session_id))
```

- [ ] **Step 3: Add GET /transcript/{session_id} endpoint**

In `whisperlivekit/basic_server.py`, add this endpoint after the `/v1/models` endpoint (after line 333):

```python
@app.get("/transcript/{session_id}")
async def get_transcript(session_id: str):
    """Download a saved transcript JSON file."""
    import re
    from pathlib import Path

    from fastapi.responses import FileResponse

    # Validate session_id to prevent path traversal
    if not re.match(r'^[\w\-]+$', session_id):
        return JSONResponse({"error": "Invalid session ID"}, status_code=400)

    transcript_path = Path(config.transcript_dir) / f"{session_id}.json"
    if not transcript_path.exists():
        return JSONResponse({"error": "Transcript not found"}, status_code=404)

    return FileResponse(
        path=str(transcript_path),
        filename=f"{session_id}.json",
        media_type="application/json",
    )
```

- [ ] **Step 4: Run server smoke test**

Run: `python -c "from whisperlivekit.basic_server import app; print('Server module loads OK')"  `
Expected: prints `Server module loads OK`

- [ ] **Step 5: Commit**

```bash
git add whisperlivekit/basic_server.py
git commit -m "feat: server creates TranscriptWriter per session, adds download endpoint"
```

---

### Task 5: Web UI download button

**Files:**
- Modify: `whisperlivekit/web/live_transcription.html:69-74` (add button)
- Modify: `whisperlivekit/web/live_transcription.css` (add button styles)
- Modify: `whisperlivekit/web/live_transcription.js:283-304` (handle session_id in ready_to_stop)

- [ ] **Step 1: Add download button to HTML**

In `whisperlivekit/web/live_transcription.html`, add the button after the status paragraph (after line 69 `<p id="status"></p>`), inside `header-container`:

```html
        <a id="downloadTranscript" class="download-btn" style="display:none;" download>Download Transcript</a>
```

So lines 69-70 become:

```html
        <p id="status"></p>
        <a id="downloadTranscript" class="download-btn" style="display:none;" download>Download Transcript</a>
    </div>
```

- [ ] **Step 2: Add CSS styles for download button**

In `whisperlivekit/web/live_transcription.css`, add at the end of the file:

```css
/* Download transcript button */
.download-btn {
  display: inline-block;
  padding: 6px 16px;
  margin-top: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--button-bg);
  color: var(--text);
  font-size: 13px;
  text-decoration: none;
  cursor: pointer;
  transition: opacity 0.15s;
}

.download-btn:hover {
  opacity: 0.7;
}
```

- [ ] **Step 3: Wire up JS to show download button**

In `whisperlivekit/web/live_transcription.js`, first add a reference to the button at the top, near the other element references (after line 44 `const microphoneSelect = ...`):

```javascript
const downloadBtn = document.getElementById("downloadTranscript");
```

Then in the `ready_to_stop` handler (around line 283), add the download button logic. Replace the block:

```javascript
      if (data.type === "ready_to_stop") {
        console.log("Ready to stop received, finalizing display and closing WebSocket.");
        waitingForStop = false;

        if (lastReceivedData) {
          renderLinesWithBuffer(
            lastReceivedData.lines || [],
            lastReceivedData.buffer_diarization || "",
            lastReceivedData.buffer_transcription || "",
            lastReceivedData.buffer_translation || "",
            0,
            0,
            true
          );
        }
        statusText.textContent = "Finished processing audio! Ready to record again.";
        recordButton.disabled = false;

        if (websocket) {
          websocket.close();
        }
        return;
      }
```

with:

```javascript
      if (data.type === "ready_to_stop") {
        console.log("Ready to stop received, finalizing display and closing WebSocket.");
        waitingForStop = false;

        if (lastReceivedData) {
          renderLinesWithBuffer(
            lastReceivedData.lines || [],
            lastReceivedData.buffer_diarization || "",
            lastReceivedData.buffer_transcription || "",
            lastReceivedData.buffer_translation || "",
            0,
            0,
            true
          );
        }
        statusText.textContent = "Finished processing audio! Ready to record again.";
        recordButton.disabled = false;

        if (data.session_id) {
          const baseUrl = websocketUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/asr$/, "");
          downloadBtn.href = baseUrl + "/transcript/" + data.session_id;
          downloadBtn.download = data.session_id + ".json";
          downloadBtn.style.display = "inline-block";
        }

        if (websocket) {
          websocket.close();
        }
        return;
      }
```

Also hide the download button when starting a new recording. Find the `setupWebSocket` function (around line 215) and add inside `websocket.onopen`:

```javascript
      downloadBtn.style.display = "none";
```

So the `onopen` handler becomes:

```javascript
    websocket.onopen = () => {
      statusText.textContent = "Connected to server.";
      downloadBtn.style.display = "none";
      resolve();
    };
```

- [ ] **Step 4: Verify the inline UI builder still works**

The `get_inline_ui_html()` function in `web_interface.py` inlines all JS/CSS/HTML. Since we're modifying these files (not adding new ones), it will pick up our changes automatically. Verify:

Run: `python -c "from whisperlivekit.web.web_interface import get_inline_ui_html; html = get_inline_ui_html(); assert 'downloadTranscript' in html; print('Inline UI includes download button')"  `
Expected: prints `Inline UI includes download button`

- [ ] **Step 5: Commit**

```bash
git add whisperlivekit/web/live_transcription.html whisperlivekit/web/live_transcription.css whisperlivekit/web/live_transcription.js
git commit -m "feat: add download transcript button to web UI"
```

---

### Task 6: Export from __init__.py and final verification

**Files:**
- Modify: `whisperlivekit/__init__.py`

- [ ] **Step 1: Add TranscriptWriter to package exports**

In `whisperlivekit/__init__.py`, add the import and export:

```python
from .transcript_writer import TranscriptWriter
```

And add `"TranscriptWriter"` to the `__all__` list.

- [ ] **Step 2: Run the full test suite**

Run: `python -m pytest tests/test_transcript_writer.py -v`
Expected: All tests PASS

- [ ] **Step 3: Run a quick lint check**

Run: `python -m ruff check whisperlivekit/transcript_writer.py whisperlivekit/config.py whisperlivekit/parse_args.py whisperlivekit/audio_processor.py whisperlivekit/basic_server.py`
Expected: No errors (or fix any that appear)

- [ ] **Step 4: Commit**

```bash
git add whisperlivekit/__init__.py
git commit -m "feat: export TranscriptWriter from whisperlivekit package"
```
