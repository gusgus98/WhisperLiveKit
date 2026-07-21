"""Unit tests for TokensAlignment line construction.

These exercise the pure segment-building logic with hand-built tokens and
diarization segments -- no models, no mocks. The pipeline-level behaviour is
covered separately by tests/test_pipeline.py.
"""

import pytest

from whisperlivekit.timed_objects import ASRToken, SpeakerSegment
from whisperlivekit.tokens_alignment import TokensAlignment


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


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
