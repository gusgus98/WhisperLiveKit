"""Tests for TranscriptWriter -- transcript saving to JSON files."""

import json
import os

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

        # Reset throttle so second write goes through
        writer._last_write_time = 0.0

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
