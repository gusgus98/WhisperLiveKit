# Transcript Saving Design

## Problem

Live transcription sessions (`wlk serve`) produce real-time results over WebSocket, but nothing is persisted. When the session ends, the transcript is gone. Users need transcripts saved for later processing, especially with diarization data (speaker IDs + timestamps).

## Solution

A `TranscriptWriter` class owned by `AudioProcessor` that writes JSON transcripts to disk -- continuously during a session (partial file) and a clean final file on session end. Exposed via CLI flags, auto-created by the server, and downloadable from the web UI.

## Output Format

JSON with timestamps and speaker IDs:

```json
{
  "session_id": "2026-04-15_14-30-22",
  "start_time": "2026-04-15T14:30:22Z",
  "duration": 342.5,
  "segments": [
    {
      "start": "0:00:01.20",
      "end": "0:00:05.80",
      "text": "Hello everyone",
      "speaker": 1
    }
  ]
}
```

During a session, the partial file also includes:

```json
{
  "...same fields...",
  "buffer_transcription": "unconfirmed text still being processed",
  "status": "active_transcription"
}
```

## Components

### 1. TranscriptWriter (`whisperlivekit/transcript_writer.py`)

New class, single responsibility: serialize FrontData to JSON files.

- **Constructor**: `TranscriptWriter(output_dir: str, session_id: str | None = None)`
  - `output_dir`: directory to write files (created if missing)
  - `session_id`: defaults to UTC timestamp `YYYY-MM-DD_HH-MM-SS`
- **`update(front_data: FrontData)`**: Overwrites `<session_id>.partial.json` with current state. Extracts segments from `front_data.lines`, includes `buffer_transcription`. Throttled to write at most once every 3 seconds to avoid excessive disk I/O (the results_formatter fires every ~50ms).
- **`finalize(total_duration: float)`**: Writes `<session_id>.json` with clean segments (no buffer), deletes the partial file.

File naming:
- During session: `transcripts/2026-04-15_14-30-22.partial.json`
- After session: `transcripts/2026-04-15_14-30-22.json`

### 2. Config Changes (`whisperlivekit/config.py`)

Two new fields on `WhisperLiveKitConfig`:

```python
save_transcript: bool = False
transcript_dir: str = "./transcripts"
```

### 3. CLI Changes (`whisperlivekit/parse_args.py`)

Two new flags:

```
--save-transcript          Enable transcript saving (default: off)
--transcript-dir PATH      Output directory (default: ./transcripts)
```

### 4. AudioProcessor Integration (`whisperlivekit/audio_processor.py`)

- Constructor accepts optional `transcript_writer: TranscriptWriter | None`.
- `results_formatter()`: After producing each `FrontData`, calls `writer.update(front_data)` if writer is present.
- `cleanup()`: Calls `writer.finalize(duration)` where duration comes from `total_pcm_samples / sample_rate`.

### 5. Server Integration (`whisperlivekit/basic_server.py`)

- In `websocket_endpoint()`: When `config.save_transcript` is true, create a `TranscriptWriter` and pass it to `AudioProcessor`.
- The `ready_to_stop` message gains a `session_id` field when saving is enabled.
- New endpoint: `GET /transcript/{session_id}` serves the final JSON file using `FileResponse`.

### 6. Web UI (`whisperlivekit/web/live_transcription.js` + `.html`)

- On receiving `ready_to_stop` with a `session_id`, show a "Download Transcript" button.
- Button triggers `window.location = /transcript/{session_id}`.
- If no `session_id` in the message (saving disabled), no button appears.

## What This Does NOT Do

- No format picker in the UI (JSON only; other formats can be added later).
- No authentication on the download endpoint.
- No automatic cleanup of old transcript files.
- No real-time streaming of transcript to a file (partial is overwritten atomically, not appended).
