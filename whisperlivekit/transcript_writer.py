"""Transcript file writer for live sessions.

Writes JSON transcripts to disk during and after live transcription sessions.
Produces two files per session:
- ``<session_id>.partial.json`` -- overwritten periodically during the session
- ``<session_id>.json`` -- clean final transcript written on session end
"""

import json
import logging
import time
import uuid
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
        self.session_id = session_id or (
            datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S") + "-" + uuid.uuid4().hex[:8]
        )
        self.start_time = datetime.now(timezone.utc).isoformat()
        self._last_front_data: Optional[FrontData] = None
        self._last_write_time: float = 0.0

    def _segments_from_front_data(self, front_data: FrontData) -> list:
        """Extract speech segments (skip silence) from FrontData lines."""
        segments = []
        for line in front_data.lines:
            if line.speaker == -2 or not line.text or not line.text.strip():
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
