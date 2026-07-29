"""Unit tests for TokensAlignment line construction.

These exercise the pure segment-building logic with hand-built tokens and
diarization segments -- no models, no mocks. The pipeline-level behaviour is
covered separately by tests/test_pipeline.py.
"""

import pytest

from whisperlivekit.timed_objects import ASRToken, SpeakerSegment
from whisperlivekit.tokens_alignment import (
    _DEFAULT_RETENTION_SECONDS,
    _MAX_LINE_SECONDS,
    TokensAlignment,
)


class _State:
    """Minimal stand-in for the AudioProcessor shared state object."""

    def __init__(self):
        self.new_tokens = []
        self.new_diarization = []
        self.new_translation = []
        self.new_tokens_buffer = []
        self.new_translation_buffer = ""


def _alignment(tokens, diarization_segments=()):
    alignment = TokensAlignment(_State(), None, sep=" ")
    alignment.all_tokens = list(tokens)
    alignment.all_diarization_segments = list(diarization_segments)
    return alignment


def _token(start, end, text):
    return ASRToken(start=start, end=end, text=text)


def test_unattributed_trailing_text_goes_to_buffer_not_lines():
    """Text past the diarization frontier must not be published as a line.

    Diarization lags ASR. Emitting the newest sentence with a guessed speaker
    means publishing an attribution that gets revised moments later, which is
    what leaves stale duplicate lines in the client transcript.
    """
    alignment = _alignment(
        tokens=[_token(0.0, 1.0, "Hello there."), _token(5.0, 5.1, "If.")],
        diarization_segments=[SpeakerSegment(start=0.0, end=2.0, speaker=2)],
    )

    segments, buffer = alignment.get_lines_diarization()

    assert [s.text for s in segments] == ["Hello there."]
    assert segments[0].speaker == 3
    assert "If." in buffer


def test_no_diarization_yet_emits_no_lines():
    """With no diarization at all, everything is unattributed."""
    alignment = _alignment(tokens=[_token(0.0, 1.0, "Hello there.")])

    segments, buffer = alignment.get_lines_diarization()

    assert segments == []
    assert buffer == "Hello there."


def test_gap_in_diarization_inherits_previous_speaker():
    """A mid-stream span with no diarization overlap keeps speaker continuity.

    Such a segment cannot be deferred to the buffer without reordering the
    transcript, so it inherits the preceding speaker rather than defaulting to
    speaker 1 and producing a spurious one-word line.
    """
    alignment = _alignment(
        tokens=[
            _token(0.0, 1.0, "First sentence."),
            _token(2.5, 2.5, "Um."),  # zero-length: overlaps nothing
            _token(3.0, 4.0, "Third sentence."),
        ],
        diarization_segments=[SpeakerSegment(start=0.0, end=5.0, speaker=2)],
    )

    segments, _ = alignment.get_lines_diarization()

    assert [s.speaker for s in segments] == [3]
    assert segments[0].text == "First sentence.Um.Third sentence."


def test_attribution_is_stable_once_diarization_catches_up():
    """The same span keeps one identity across successive updates."""
    tokens = [_token(0.0, 1.0, "Hello there."), _token(5.0, 6.0, "Second one.")]
    alignment = _alignment(
        tokens=tokens,
        diarization_segments=[SpeakerSegment(start=0.0, end=2.0, speaker=2)],
    )
    first, _ = alignment.get_lines_diarization()
    assert [(s.speaker, s.start) for s in first] == [(3, 0.0)]

    alignment.all_diarization_segments.append(
        SpeakerSegment(start=2.0, end=7.0, speaker=2)
    )
    second, buffer = alignment.get_lines_diarization()

    # Same speaker throughout, so the two sentences merge into one line that
    # still starts where the first line started -- no new competing line.
    assert [(s.speaker, s.start) for s in second] == [(3, 0.0)]
    assert second[0].text == "Hello there.Second one."
    assert buffer == ""


def test_speaker_change_splits_lines_without_overlap():
    alignment = _alignment(
        tokens=[_token(0.0, 1.0, "Hello there."), _token(3.0, 4.0, "Second one.")],
        diarization_segments=[
            SpeakerSegment(start=0.0, end=2.0, speaker=0),
            SpeakerSegment(start=2.0, end=5.0, speaker=1),
        ],
    )

    segments, _ = alignment.get_lines_diarization()

    assert [(s.speaker, s.text) for s in segments] == [
        (1, "Hello there."),
        (2, "Second one."),
    ]
    # Emitted ranges never overlap: a client can render them in start order.
    for earlier, later in zip(segments, segments[1:]):
        assert earlier.end <= later.start


def test_finalize_flushes_unattributed_text_into_lines():
    """At end of stream there is no later update, so nothing may stay buffered."""
    alignment = _alignment(
        tokens=[_token(0.0, 1.0, "Hello there."), _token(5.0, 5.1, "If.")],
        diarization_segments=[SpeakerSegment(start=0.0, end=2.0, speaker=2)],
    )

    segments, buffer = alignment.get_lines_diarization(finalize=True)

    assert buffer == ""
    assert "".join(s.text for s in segments) == "Hello there.If."


def test_finalize_without_any_diarization_still_emits_text():
    alignment = _alignment(tokens=[_token(0.0, 1.0, "Hello there.")])

    segments, buffer = alignment.get_lines_diarization(finalize=True)

    assert buffer == ""
    assert [s.text for s in segments] == ["Hello there."]


def test_concatenate_diar_segments_does_not_mutate_stored_segments():
    """Merging for read must not extend the stored segments in place."""
    alignment = _alignment(
        tokens=[_token(0.0, 1.0, "Hi.")],
        diarization_segments=[
            SpeakerSegment(start=0.0, end=2.0, speaker=0),
            SpeakerSegment(start=2.0, end=9.0, speaker=0),
        ],
    )

    merged = alignment.concatenate_diar_segments()

    assert [(m.start, m.end) for m in merged] == [(0.0, 9.0)]
    assert alignment.all_diarization_segments[0].end == 2.0


def _long_run():
    """A single speaker talking across several _MAX_LINE_SECONDS grid cells."""
    tokens = [
        _token(10.0, 11.0, "First sentence."),
        _token(110.0, 111.0, "Second sentence."),
        _token(130.0, 131.0, "Third sentence."),
        _token(250.0, 251.0, "Fourth sentence."),
    ]
    diarization = [SpeakerSegment(start=0.0, end=400.0, speaker=0)]
    return tokens, diarization


def test_line_cap_leaves_room_inside_the_retention_window():
    """A line must be emitted whole before _prune() starts eating its head.

    Worst case a line runs to _MAX_LINE_SECONDS plus one trailing sentence, and
    it is only complete once diarization catches up to its end. The slack left
    over is the diarization lag budget.
    """
    assert _MAX_LINE_SECONDS * 2 < _DEFAULT_RETENTION_SECONDS


def test_long_single_speaker_run_splits_on_the_absolute_time_grid():
    """One speaker talking for minutes must not become one unbounded line."""
    tokens, diarization = _long_run()
    alignment = _alignment(tokens=tokens, diarization_segments=diarization)

    segments, _ = alignment.get_lines_diarization()

    # 10s and 110s share grid cell 0; 130s is cell 1; 250s is cell 2.
    assert [s.start for s in segments] == [10.0, 130.0, 250.0]
    assert [s.speaker for s in segments] == [1, 1, 1]
    # Breaks fall between punctuation segments, so no sentence is split.
    for segment in segments:
        assert segment.text.endswith(".")


def test_line_boundaries_are_stable_when_the_head_is_pruned():
    """The grid anchors boundaries to absolute time, not to the surviving head.

    This is what a duration-based cap gets wrong: measuring from the first
    retained token re-anchors every boundary each time _prune() advances, so the
    client sees whole lines re-cut and cannot tell a re-split from a head-cut.
    """
    tokens, diarization = _long_run()

    full, _ = _alignment(tokens=tokens, diarization_segments=diarization).get_lines_diarization()
    # _prune() drops the first token; everything after it must not move.
    pruned, _ = _alignment(
        tokens=tokens[1:], diarization_segments=diarization
    ).get_lines_diarization()

    assert [s.start for s in full] == [10.0, 130.0, 250.0]
    assert [s.start for s in pruned] == [110.0, 130.0, 250.0]
    # The boundaries past the pruned head are identical in both runs.
    assert [s.start for s in full if s.start > 110.0] == [
        s.start for s in pruned if s.start > 110.0
    ]


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
