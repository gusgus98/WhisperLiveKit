from dataclasses import replace
from time import time
from typing import Any, List, Optional, Tuple, Union

from whisperlivekit.timed_objects import (
    ASRToken,
    PuncSegment,
    Segment,
    Silence,
    SilentSegment,
    SpeakerSegment,
    TimedText,
)

_DEFAULT_RETENTION_SECONDS: float = 300.0

# A line arrives at the client as a single blob of text with no internal
# timestamps, so once ``_prune`` starts eating its head the client cannot tell
# which words are new. Capping line length below the retention window means every
# line is published whole at least once before that can happen, and the client
# never has to reconcile a partial line.
#
# Required: _MAX_LINE_SECONDS + longest sentence + diarization lag < _DEFAULT_RETENTION_SECONDS.
_MAX_LINE_SECONDS: float = 120.0


class TokensAlignment:

    def __init__(self, state: Any, args: Any, sep: Optional[str]) -> None:
        self.state = state

        self.all_tokens: List[ASRToken] = []
        self.all_diarization_segments: List[SpeakerSegment] = []
        self.all_translation_segments: List[Any] = []

        self.new_tokens: List[ASRToken] = []
        self.new_diarization: List[SpeakerSegment] = []
        self.new_translation: List[Any] = []
        self.new_translation_buffer: Union[TimedText, str] = TimedText()
        self.new_tokens_buffer: List[Any] = []
        self.sep: str = sep if sep is not None else ' '
        self.beg_loop: Optional[float] = None

        self.validated_segments: List[Segment] = []
        self.current_line_tokens: List[ASRToken] = []
        self.diarization_buffer: List[ASRToken] = []

        self.last_punctuation = None
        self.last_uncompleted_punc_segment: PuncSegment = None
        self.unvalidated_tokens: PuncSegment = []

        self._retention_seconds: float = _DEFAULT_RETENTION_SECONDS

    def update(self) -> None:
        """Drain state buffers into the running alignment context."""
        self.new_tokens, self.state.new_tokens = self.state.new_tokens, []
        self.new_diarization, self.state.new_diarization = self.state.new_diarization, []
        self.new_translation, self.state.new_translation = self.state.new_translation, []
        self.new_tokens_buffer, self.state.new_tokens_buffer = self.state.new_tokens_buffer, []

        self.all_tokens.extend(self.new_tokens)
        self.all_diarization_segments.extend(self.new_diarization)
        self.all_translation_segments.extend(self.new_translation)
        self.new_translation_buffer = self.state.new_translation_buffer

    def _prune(self) -> None:
        """Drop tokens/segments older than ``_retention_seconds`` from the latest token."""
        if not self.all_tokens:
            return

        latest = self.all_tokens[-1].end
        cutoff = latest - self._retention_seconds
        if cutoff <= 0:
            return

        def _find_cutoff(items: list) -> int:
            """Return the index of the first item whose end >= cutoff."""
            for i, item in enumerate(items):
                if item.end >= cutoff:
                    return i
            return len(items)

        idx = _find_cutoff(self.all_tokens)
        if idx:
            self.all_tokens = self.all_tokens[idx:]

        idx = _find_cutoff(self.all_diarization_segments)
        if idx:
            self.all_diarization_segments = self.all_diarization_segments[idx:]

        idx = _find_cutoff(self.all_translation_segments)
        if idx:
            self.all_translation_segments = self.all_translation_segments[idx:]

        idx = _find_cutoff(self.validated_segments)
        if idx:
            self.validated_segments = self.validated_segments[idx:]

    def add_translation(self, segment: Segment) -> None:
        """Append translated text segments that overlap with a segment."""
        if segment.translation is None:
            segment.translation = ''
        for ts in self.all_translation_segments:
            if ts.is_within(segment):
                if ts.text:
                    segment.translation += ts.text + self.sep
            elif segment.translation:
                break


    def compute_punctuations_segments(self, tokens: Optional[List[ASRToken]] = None) -> List[PuncSegment]:
        """Group tokens into segments split by punctuation and explicit silence."""
        segments = []
        segment_start_idx = 0
        for i, token in enumerate(self.all_tokens):
            if token.is_silence():
                previous_segment = PuncSegment.from_tokens(
                        tokens=self.all_tokens[segment_start_idx: i],
                    )
                if previous_segment:
                    segments.append(previous_segment)
                segment = PuncSegment.from_tokens(
                    tokens=[token],
                    is_silence=True
                )
                segments.append(segment)
                segment_start_idx = i+1
            else:
                if token.has_punctuation():
                    segment = PuncSegment.from_tokens(
                        tokens=self.all_tokens[segment_start_idx: i+1],
                    )
                    segments.append(segment)
                    segment_start_idx = i+1

        final_segment = PuncSegment.from_tokens(
            tokens=self.all_tokens[segment_start_idx:],
        )
        if final_segment:
            segments.append(final_segment)
        return segments

    def compute_new_punctuations_segments(self) -> List[PuncSegment]:
        new_punc_segments = []
        segment_start_idx = 0
        self.unvalidated_tokens += self.new_tokens
        for i, token in enumerate(self.unvalidated_tokens):
            if token.is_silence():
                previous_segment = PuncSegment.from_tokens(
                        tokens=self.unvalidated_tokens[segment_start_idx: i],
                    )
                if previous_segment:
                    new_punc_segments.append(previous_segment)
                segment = PuncSegment.from_tokens(
                    tokens=[token],
                    is_silence=True
                )
                new_punc_segments.append(segment)
                segment_start_idx = i+1
            else:
                if token.has_punctuation():
                    segment = PuncSegment.from_tokens(
                        tokens=self.unvalidated_tokens[segment_start_idx: i+1],
                    )
                    new_punc_segments.append(segment)
                    segment_start_idx = i+1

        self.unvalidated_tokens = self.unvalidated_tokens[segment_start_idx:]
        return new_punc_segments


    def concatenate_diar_segments(self) -> List[SpeakerSegment]:
        """Merge consecutive diarization slices that share the same speaker."""
        if not self.all_diarization_segments:
            return []
        # Copy before merging: extending ``end`` in place would permanently
        # stretch the stored segment and let it win overlap comparisons for
        # spans it never covered.
        merged = [replace(self.all_diarization_segments[0])]
        for segment in self.all_diarization_segments[1:]:
            if segment.speaker == merged[-1].speaker:
                merged[-1].end = segment.end
            else:
                merged.append(replace(segment))
        return merged


    @staticmethod
    def intersection_duration(seg1: TimedText, seg2: TimedText) -> float:
        """Return the overlap duration between two timed segments."""
        start = max(seg1.start, seg2.start)
        end = min(seg1.end, seg2.end)

        return max(0, end - start)

    def get_lines_diarization(self, finalize: bool = False) -> Tuple[List[Segment], str]:
        """Build segments when diarization is enabled and track overflow buffer.

        Args:
            finalize: True on the last response of a session. No further update
                will arrive to attribute deferred text, so it is emitted rather
                than held in the buffer.
        """
        diarization_buffer = ''
        punctuation_segments = self.compute_punctuations_segments()
        diarization_segments = self.concatenate_diar_segments()
        diarization_frontier = diarization_segments[-1].end if diarization_segments else None

        attributed_segments = []
        last_speaker = None
        for punctuation_segment in punctuation_segments:
            if punctuation_segment.is_silence():
                attributed_segments.append(punctuation_segment)
                continue

            # Diarization trails transcription. Text beyond the frontier has no
            # attribution yet, so it stays in the buffer instead of being
            # published under a guessed speaker that a later update revises --
            # revised lines are what leave stale duplicates on the client.
            beyond_frontier = (
                diarization_frontier is None or punctuation_segment.start >= diarization_frontier
            )
            if beyond_frontier and not finalize:
                diarization_buffer += punctuation_segment.text
                continue

            max_overlap = 0.0
            max_overlap_speaker = None
            for diarization_segment in diarization_segments:
                intersec = self.intersection_duration(punctuation_segment, diarization_segment)
                if intersec > max_overlap:
                    max_overlap = intersec
                    max_overlap_speaker = diarization_segment.speaker + 1

            # A span inside the diarized range that still overlaps nothing (a
            # gap, or a zero-length token) cannot be deferred without
            # reordering the transcript, so carry the previous speaker forward.
            if max_overlap_speaker is None:
                max_overlap_speaker = last_speaker if last_speaker is not None else 1
            punctuation_segment.speaker = max_overlap_speaker
            last_speaker = max_overlap_speaker
            attributed_segments.append(punctuation_segment)

        segments = []
        if attributed_segments:
            segments = [attributed_segments[0]]
            for segment in attributed_segments[1:]:
                if segment.speaker == segments[-1].speaker and self._same_block(segment, segments[-1]):
                    if segments[-1].text:
                        segments[-1].text += segment.text
                    segments[-1].end = segment.end
                else:
                    segments.append(segment)

        return segments, diarization_buffer

    @staticmethod
    def _same_block(segment: TimedText, line: TimedText) -> bool:
        """Whether ``segment`` may extend ``line``, or starts a new one.

        Blocks are cut on a grid of absolute audio time so that a boundary lands
        in the same place no matter which tokens ``_prune`` has already dropped.
        Do NOT rewrite this as ``segment.end - line.start > _MAX_LINE_SECONDS``:
        measuring from the line's own start re-anchors every boundary as the head
        is eaten, which re-cuts whole lines under the client and reintroduces the
        very ambiguity the cap exists to remove.

        The cut falls between two punctuation segments, so a sentence is never
        split mid-way -- though the segment it follows is not always punctuated
        (``compute_punctuations_segments`` also emits silence and leftover-tail
        segments).
        """
        return int(segment.start // _MAX_LINE_SECONDS) == int(line.start // _MAX_LINE_SECONDS)


    def get_lines(
            self,
            diarization: bool = False,
            translation: bool = False,
            current_silence: Optional[Silence] = None,
            audio_time: Optional[float] = None,
            finalize: bool = False,
        ) -> Tuple[List[Segment], str, Union[str, TimedText]]:
        """Return the formatted segments plus buffers, optionally with diarization/translation.

        Args:
            audio_time: Current audio stream position in seconds. Used as fallback
                for ongoing silence end time instead of wall-clock (which breaks
                when audio is fed faster or slower than real-time).
            finalize: True when building the last response of a session, so that
                text still awaiting diarization is emitted instead of buffered.
        """
        # Fallback for ongoing silence: prefer audio stream time over wall-clock
        _silence_now = audio_time if audio_time is not None else (time() - self.beg_loop)

        if diarization:
            segments, diarization_buffer = self.get_lines_diarization(finalize=finalize)
        else:
            diarization_buffer = ''
            for token in self.new_tokens:
                if isinstance(token, Silence):
                    if self.current_line_tokens:
                        self.validated_segments.append(Segment.from_tokens(self.current_line_tokens))
                        self.current_line_tokens = []

                    end_silence = token.end if token.has_ended else _silence_now
                    if self.validated_segments and self.validated_segments[-1].is_silence():
                        self.validated_segments[-1].end = end_silence
                    else:
                        self.validated_segments.append(SilentSegment(
                            start=token.start,
                            end=end_silence
                        ))
                else:
                    self.current_line_tokens.append(token)
                    if token.has_punctuation():
                        self.validated_segments.append(Segment.from_tokens(self.current_line_tokens))
                        self.current_line_tokens = []

            segments = list(self.validated_segments)
            if self.current_line_tokens:
                segments.append(Segment.from_tokens(self.current_line_tokens))

        if current_silence:
            end_silence = current_silence.end if current_silence.has_ended else _silence_now
            if segments and segments[-1].is_silence():
                segments[-1] = SilentSegment(start=segments[-1].start, end=end_silence)
            else:
                segments.append(SilentSegment(
                    start=current_silence.start,
                    end=end_silence
                ))
        if translation:
            [self.add_translation(segment) for segment in segments if not segment.is_silence()]

        self._prune()

        return segments, diarization_buffer, self.new_translation_buffer.text
