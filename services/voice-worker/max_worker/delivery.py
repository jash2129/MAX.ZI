"""How much of Max's reply the customer actually heard (PRD pipeline rule 3).

The brain needs `heard` and `fraction_heard` for every turn (POST /commit). We know two things exactly:
how many seconds of audio the TTS produced for the reply, and how long the bot has been audibly speaking
(BotStartedSpeaking -> now). While TTS is still generating, the produced audio is shorter than the
reply, so the denominator also uses an estimate from the reply's word count and takes the larger.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .policy import DELIVERED_FRACTION

# turn-taking.ts expectedSpeechMs: 2.8 words a second
WORDS_PER_SECOND = 2.8


def expected_speech_seconds(text: str) -> float:
    words = len(text.split())
    return max(1.2, words / WORDS_PER_SECOND) if words else 0.0


@dataclass
class ReplyDelivery:
    turn_id: int
    text: str = ""
    audio_seconds: float = 0.0
    started_at: float | None = None
    played_seconds: float = 0.0
    finished: bool = False
    committed: bool = False
    _segments: list[float] = field(default_factory=list)

    def add_text(self, text: str) -> None:
        self.text = f"{self.text} {text}".strip() if self.text else text.strip()

    def add_audio(self, num_bytes: int, sample_rate: int, num_channels: int = 1) -> None:
        if sample_rate > 0:
            self.audio_seconds += num_bytes / (2 * sample_rate * max(1, num_channels))

    def bot_started(self, now: float) -> None:
        if self.started_at is None:
            self.started_at = now

    def bot_stopped(self, now: float) -> None:
        """A pause in playback (between sentences, or the end)."""
        if self.started_at is not None:
            self.played_seconds += max(0.0, now - self.started_at)
            self.started_at = None

    def fraction_heard(self, now: float) -> float:
        played = self.played_seconds + (max(0.0, now - self.started_at) if self.started_at is not None else 0.0)
        total = max(self.audio_seconds, expected_speech_seconds(self.text))
        if total <= 0:
            return 0.0
        return min(1.0, played / total)

    def outcome(self, now: float, interrupted: bool) -> tuple[bool, float]:
        """(heard, fraction_heard) for POST /commit."""
        if self.finished and not interrupted:
            return True, 1.0
        fraction = self.fraction_heard(now)
        return fraction >= DELIVERED_FRACTION, fraction
