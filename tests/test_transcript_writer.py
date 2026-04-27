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

    def test_update_preserves_window_segments_through_silence_only_update(self, tmp_path):
        """Segments must not be lost when a silence-only update empties current_segments.

        Scenario: speech → long break (silence marker only) → speech resumes.
        All three speech segments must appear in the final transcript.
        """
        from whisperlivekit.transcript_writer import TranscriptWriter

        writer = TranscriptWriter(output_dir=str(tmp_path), session_id="test-session")

        # Step 1: initial speech
        fd1 = _make_front_data([
            {"start": 0.0, "end": 2.0, "text": "Hello everyone", "speaker": 1},
            {"start": 2.0, "end": 4.0, "text": "Welcome to the meeting", "speaker": 1},
        ])
        writer.update(fd1)
        writer._last_write_time = 0.0

        # Step 2: silence-only live view (long break) — _extract_segments returns []
        fd2 = _make_front_data([
            {"start": 4.0, "end": 50.0, "text": None, "speaker": -2},
        ])
        writer.update(fd2)
        writer._last_write_time = 0.0

        # Step 3: speech resumes after the break
        fd3 = _make_front_data([
            {"start": 50.0, "end": 52.0, "text": "Back from break", "speaker": 1},
        ])
        writer.update(fd3)

        writer.finalize(total_duration=60.0)

        import json
        data = json.loads((tmp_path / "test-session.json").read_text())
        texts = [s["text"] for s in data["segments"]]
        assert "Hello everyone" in texts, f"Expected 'Hello everyone' in {texts}"
        assert "Welcome to the meeting" in texts, f"Expected 'Welcome to the meeting' in {texts}"
        assert "Back from break" in texts, f"Expected 'Back from break' in {texts}"
        assert len(data["segments"]) == 3

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

    def test_default_session_id_is_timestamp_with_suffix(self, tmp_path):
        from whisperlivekit.transcript_writer import TranscriptWriter

        writer = TranscriptWriter(output_dir=str(tmp_path))
        # Should be formatted like 2026-04-15_14-30-22-abcd1234 (28 chars)
        assert len(writer.session_id) == 28
        assert writer.session_id[4] == "-"
        assert writer.session_id[10] == "_"
        assert writer.session_id[19] == "-"

    def test_concurrent_sessions_get_unique_ids(self, tmp_path):
        from whisperlivekit.transcript_writer import TranscriptWriter

        w1 = TranscriptWriter(output_dir=str(tmp_path))
        w2 = TranscriptWriter(output_dir=str(tmp_path))
        assert w1.session_id != w2.session_id

    def test_creates_output_dir(self, tmp_path):
        from whisperlivekit.transcript_writer import TranscriptWriter

        new_dir = tmp_path / "nested" / "transcripts"
        writer = TranscriptWriter(output_dir=str(new_dir), session_id="test")
        fd = _make_front_data([{"start": 0.0, "end": 1.0, "text": "Hi"}])
        writer.update(fd)

        assert new_dir.exists()
        assert (new_dir / "test.partial.json").exists()


class TestSlidingWindowArchival:
    """Tests for the sliding window accumulation that survives _prune()."""

    def test_segments_archived_when_window_slides(self, tmp_path):
        """Segments that fall out of the live window must appear in the final transcript."""
        from whisperlivekit.transcript_writer import TranscriptWriter

        writer = TranscriptWriter(output_dir=str(tmp_path), session_id="test-session")

        # Window 1: segments at 0-5s and 5-10s
        fd1 = _make_front_data([
            {"start": 0.0, "end": 5.0, "text": "First segment"},
            {"start": 5.0, "end": 10.0, "text": "Second segment"},
        ])
        writer.update(fd1)
        writer._last_write_time = 0.0

        # Window 2: window slides forward, only 10-15s visible
        fd2 = _make_front_data([
            {"start": 10.0, "end": 15.0, "text": "Third segment"},
        ])
        writer.update(fd2)

        writer.finalize(total_duration=15.0)

        data = json.loads((tmp_path / "test-session.json").read_text())
        texts = [s["text"] for s in data["segments"]]
        assert texts == ["First segment", "Second segment", "Third segment"]

    def test_abutting_boundary_segments_not_dropped(self, tmp_path):
        """Segments where B.end == C.start must be archived, not silently lost."""
        from whisperlivekit.transcript_writer import TranscriptWriter

        writer = TranscriptWriter(output_dir=str(tmp_path), session_id="test-session")

        # Three abutting segments: Alpha(0-5), Beta(5-10), Gamma(10-15)
        fd1 = _make_front_data([
            {"start": 0.0, "end": 5.0, "text": "Alpha"},
            {"start": 5.0, "end": 10.0, "text": "Beta"},
            {"start": 10.0, "end": 15.0, "text": "Gamma"},
        ])
        writer.update(fd1)
        writer._last_write_time = 0.0

        # Window slides: only Gamma visible (start=10, matching Beta's end)
        fd2 = _make_front_data([
            {"start": 10.0, "end": 15.0, "text": "Gamma"},
        ])
        writer.update(fd2)
        writer._last_write_time = 0.0

        # Window slides again: only Delta visible (start=15, matching Gamma's end)
        fd3 = _make_front_data([
            {"start": 15.0, "end": 20.0, "text": "Delta"},
        ])
        writer.update(fd3)

        writer.finalize(total_duration=20.0)

        data = json.loads((tmp_path / "test-session.json").read_text())
        texts = [s["text"] for s in data["segments"]]
        assert texts == ["Alpha", "Beta", "Gamma", "Delta"], f"Got: {texts}"

    def test_no_double_archiving(self, tmp_path):
        """A segment in the current window must not also appear in the archive."""
        from whisperlivekit.transcript_writer import TranscriptWriter

        writer = TranscriptWriter(output_dir=str(tmp_path), session_id="test-session")

        fd1 = _make_front_data([
            {"start": 0.0, "end": 5.0, "text": "First"},
            {"start": 5.0, "end": 10.0, "text": "Second"},
        ])
        writer.update(fd1)
        writer._last_write_time = 0.0

        # Window slides partially: Second is still visible
        fd2 = _make_front_data([
            {"start": 5.0, "end": 10.0, "text": "Second"},
            {"start": 10.0, "end": 15.0, "text": "Third"},
        ])
        writer.update(fd2)

        writer.finalize(total_duration=15.0)

        data = json.loads((tmp_path / "test-session.json").read_text())
        texts = [s["text"] for s in data["segments"]]
        assert texts == ["First", "Second", "Third"], f"Got: {texts}"

    def test_inverted_timestamps_do_not_self_archive(self, tmp_path):
        """A segment with end < start (Whisper hallucination loop) must not
        be re-archived on every update.

        Regression for the bug that produced ~3,000 duplicates of the same
        inverted-timestamp segment in a real session JSON file.
        """
        from whisperlivekit.transcript_writer import TranscriptWriter

        writer = TranscriptWriter(output_dir=str(tmp_path), session_id="test-session")

        # Inverted timestamps from a Whisper hallucination loop: end < start.
        bad_seg = {"start": 3.48, "end": 1.14, "text": " new new new new", "speaker": 1}
        fd = _make_front_data([bad_seg])

        # results_formatter polls every ~50ms with no new tokens; pruning is
        # disabled when transcript saving is on, so the same segment stays as
        # the only line for many iterations.
        for _ in range(200):
            writer.update(fd)

        writer.finalize(total_duration=10.0)
        data = json.loads((tmp_path / "test-session.json").read_text())
        assert len(data["segments"]) == 1, (
            f"Expected 1 segment, got {len(data['segments'])} duplicates"
        )

    def test_diarization_merge_does_not_duplicate_text(self, tmp_path):
        """When upstream merges two segments into one (e.g. diarization labels
        both as the same speaker in get_lines_diarization()), the merged-away
        fragment must not be archived as a dropped segment.

        Without this guard, the second old segment's start disappears from the
        new window's start set, so the start-membership check alone would
        archive it -- and on finalize its text would appear both in the
        archive and in the merged current segment.
        """
        from whisperlivekit.transcript_writer import TranscriptWriter

        writer = TranscriptWriter(output_dir=str(tmp_path), session_id="test-session")

        # Tick 1: two separate punctuation segments (speakers tentative)
        fd1 = _make_front_data([
            {"start": 5.0, "end": 8.0, "text": "Hello,", "speaker": 1},
            {"start": 8.0, "end": 10.0, "text": " world.", "speaker": 2},
        ])
        writer.update(fd1)
        writer._last_write_time = 0.0

        # Tick 2: diarization merges them upstream -> one segment, same span
        fd2 = _make_front_data([
            {"start": 5.0, "end": 10.0, "text": "Hello, world.", "speaker": 1},
        ])
        writer.update(fd2)

        writer.finalize(total_duration=15.0)
        data = json.loads((tmp_path / "test-session.json").read_text())
        texts = [s["text"] for s in data["segments"]]
        # The merged text must appear exactly once -- no orphaned fragment.
        assert texts == ["Hello, world."], f"Got {texts}"

    def test_repeated_update_does_not_duplicate_unchanged_segments(self, tmp_path):
        """Many update() calls with identical lines must produce one copy each.

        The results_formatter loop polls every ~50ms; segments that haven't
        changed must not accumulate.
        """
        from whisperlivekit.transcript_writer import TranscriptWriter

        writer = TranscriptWriter(output_dir=str(tmp_path), session_id="test-session")

        fd = _make_front_data([
            {"start": 0.0, "end": 5.0, "text": "First"},
            {"start": 5.0, "end": 10.0, "text": "Second"},
        ])

        for _ in range(50):
            writer.update(fd)

        writer.finalize(total_duration=10.0)
        data = json.loads((tmp_path / "test-session.json").read_text())
        texts = [s["text"] for s in data["segments"]]
        assert texts == ["First", "Second"], (
            f"Got {len(data['segments'])} segments: {texts}"
        )


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
