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
    """Serialize FrontData snapshots to JSON files on disk.

    The live display prunes segments older than 5 minutes
    (``TokensAlignment._prune``).  This writer accumulates segments across
    the sliding window so that older segments are preserved in the saved
    transcript even after they leave the live view.
    """

    def __init__(self, output_dir: str, session_id: Optional[str] = None) -> None:
        self.output_dir = Path(output_dir)
        self.session_id = session_id or (
            datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S") + "-" + uuid.uuid4().hex[:8]
        )
        self.start_time = datetime.now(timezone.utc).isoformat()
        self._last_write_time: float = 0.0
        self._archived_segments: list = []
        self._window_segments: list = []

    def _extract_segments(self, front_data: FrontData) -> list:
        """Extract speech segments with raw numeric times for window tracking."""
        segments = []
        for line in front_data.lines:
            if line.speaker == -2 or not line.text or not line.text.strip():
                continue
            segments.append({
                "start": format_time(line.start),
                "end": format_time(line.end),
                "text": line.text,
                "speaker": int(line.speaker) if line.speaker != -1 else 1,
                "_start_s": line.start,
                "_end_s": line.end,
            })
        return segments

    @staticmethod
    def _clean(seg: dict) -> dict:
        """Remove internal tracking keys from a segment dict."""
        return {k: v for k, v in seg.items() if not k.startswith("_")}

    def _all_segments(self) -> list:
        """Combine archived segments with current window segments."""
        return self._archived_segments + [self._clean(s) for s in self._window_segments]

    def _write_json(self, path: Path, data: dict) -> None:
        """Atomically write JSON to a file."""
        self.output_dir.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
        tmp.replace(path)

    def update(self, front_data: FrontData) -> None:
        """Write or update the partial transcript file.

        Accumulates segments across the sliding live window so that older
        segments are preserved even after ``TokensAlignment._prune()`` drops
        them from the live view.  Disk writes are still throttled to at most
        once every ``_THROTTLE_SECONDS``.
        """
        current_segments = self._extract_segments(front_data)

        # Archive segments from the previous window that fell out of the
        # current live view (their end time is before the current window start).
        # When current_segments is empty (e.g. silence-only live view after a
        # meeting break), all previous window segments must be archived
        # unconditionally — otherwise they are silently lost at line 98.
        if self._window_segments and not current_segments:
            for seg in self._window_segments:
                self._archived_segments.append(self._clean(seg))
        elif self._window_segments and current_segments:
            window_start = current_segments[0].get("_start_s")
            if window_start is not None:
                for seg in self._window_segments:
                    end_s = seg.get("_end_s")
                    if end_s is not None and end_s <= window_start:
                        self._archived_segments.append(self._clean(seg))

        self._window_segments = current_segments

        now = time.monotonic()
        if self._last_write_time > 0 and (now - self._last_write_time) < _THROTTLE_SECONDS:
            return

        self._last_write_time = now

        data = {
            "session_id": self.session_id,
            "start_time": self.start_time,
            "segments": self._all_segments(),
            "buffer_transcription": front_data.buffer_transcription or "",
            "status": front_data.status,
        }
        path = self.output_dir / f"{self.session_id}.partial.json"
        self._write_json(path, data)
        logger.debug("Wrote partial transcript: %s", path)

    def finalize(self, total_duration: float) -> None:
        """Write the clean final transcript and remove the partial file."""
        # Merge remaining window segments into the archive
        for seg in self._window_segments:
            self._archived_segments.append(self._clean(seg))
        self._window_segments = []

        data = {
            "session_id": self.session_id,
            "start_time": self.start_time,
            "duration": round(total_duration, 2),
            "segments": self._archived_segments,
        }
        final_path = self.output_dir / f"{self.session_id}.json"
        self._write_json(final_path, data)
        logger.info("Wrote final transcript: %s (%d segments)", final_path, len(data["segments"]))

        partial_path = self.output_dir / f"{self.session_id}.partial.json"
        if partial_path.exists():
            partial_path.unlink()
