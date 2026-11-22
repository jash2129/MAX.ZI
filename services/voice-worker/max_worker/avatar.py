"""HeyGen LiveAvatar (LITE) with a voice-only fallback (PRD: "the avatar failing mid-call leaves a working
voice call").

Pipecat's HeyGenVideoService sends Max's TTS audio to LiveAvatar and puts the lip-synced audio and video
it returns into our room. If the avatar never starts, or stops returning media mid-call, that service
would keep swallowing Max's audio and the customer would hear nothing. This subclass then switches to
voice-only: TTS audio goes straight to the room, and `on_avatar_failed` tells the browser to show the
still image and the "video unavailable" notice.

A reply cut short by the switch is reported to the brain as not heard (its audio never played), so the
brain rolls it back and Max resumes it.
"""

from __future__ import annotations

import asyncio
import time
from array import array
from collections.abc import Awaitable, Callable
from typing import Any

from loguru import logger
from pipecat.frames.frames import (
    AudioRawFrame,
    Frame,
    ImageRawFrame,
    TTSAudioRawFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessorSetup
from pipecat.services.ai_service import AIService
from pipecat.services.heygen.video import HeyGenVideoService

# No media at all from the avatar for this long: it is gone
MEDIA_STALL_S = 3.0
# Speech sent, but no audible avatar audio back within this long: it is not speaking
SPEECH_STALL_S = 4.0
# Peak 16-bit sample level that counts as audible (silence from WebRTC is ~0)
AUDIBLE_PEAK = 500


def is_audible(pcm16: bytes, threshold: int = AUDIBLE_PEAK) -> bool:
    if len(pcm16) < 2:
        return False
    samples = array("h")
    samples.frombytes(pcm16[: len(pcm16) - (len(pcm16) % 2)])
    # Every 8th sample is plenty to see speech
    return any(abs(s) >= threshold for s in samples[::8])


class AvatarHealth:
    """Pure bookkeeping, separate from Pipecat so it can be tested on its own."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self.started = False
        self.failed_reason: str | None = None
        self._last_media: float | None = None
        self._speech_sent_at: float | None = None

    @property
    def voice_only(self) -> bool:
        return self.failed_reason is not None

    def mark_started(self) -> None:
        self.started = True
        self._last_media = self._clock()

    def media_received(self, audible: bool) -> None:
        self._last_media = self._clock()
        if audible:
            self._speech_sent_at = None

    def speech_sent(self) -> None:
        if self._speech_sent_at is None:
            self._speech_sent_at = self._clock()

    def speech_done(self) -> None:
        self._speech_sent_at = None

    def check(self) -> str | None:
        """Returns a failure reason the first time the avatar is judged dead, else None."""
        if self.failed_reason:
            return None
        now = self._clock()
        if not self.started:
            return None
        if self._last_media is not None and now - self._last_media > MEDIA_STALL_S:
            self.failed_reason = "avatar_media_stalled"
        elif self._speech_sent_at is not None and now - self._speech_sent_at > SPEECH_STALL_S:
            self.failed_reason = "avatar_not_speaking"
        return self.failed_reason

    def fail(self, reason: str) -> str | None:
        if self.failed_reason:
            return None
        self.failed_reason = reason
        return reason


class FallbackHeyGenVideoService(HeyGenVideoService):
    def __init__(self, *, on_avatar_failed: Callable[[str], Awaitable[None]] | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._health = AvatarHealth()
        self._on_avatar_failed = on_avatar_failed
        self._watchdog: asyncio.Task | None = None

    @property
    def voice_only(self) -> bool:
        return self._health.voice_only

    async def setup(self, setup: FrameProcessorSetup):
        try:
            await super().setup(setup)
        except Exception as e:  # noqa: BLE001 - any start failure means voice-only, never a dropped call
            logger.error(f"avatar setup raised: {e}")
        client = getattr(self, "_client", None)
        # HeyGenClient.setup() logs and tears down on failure instead of raising; its session is then None
        if client is None or getattr(client, "_heyGen_session", None) is None:
            await self._failed("avatar_start_failed")
        else:
            self._health.mark_started()
        self._watchdog = asyncio.get_running_loop().create_task(self._watch())

    async def cleanup(self):
        if self._watchdog:
            self._watchdog.cancel()
            self._watchdog = None
        await super().cleanup()

    async def _watch(self) -> None:
        try:
            while not self._health.voice_only:
                await asyncio.sleep(0.5)
                reason = self._health.check()
                if reason:
                    await self._announce(reason)
        except asyncio.CancelledError:
            pass

    async def _failed(self, reason: str) -> None:
        if self._health.fail(reason):
            await self._announce(reason)

    async def _announce(self, reason: str) -> None:
        logger.error(f"avatar unavailable ({reason}): continuing voice-only")
        if self._on_avatar_failed:
            try:
                await self._on_avatar_failed(reason)
            except Exception as e:  # noqa: BLE001
                logger.warning(f"on_avatar_failed handler raised: {e}")

    async def _on_participant_audio_data(self, audio_frame: AudioRawFrame):
        self._health.media_received(is_audible(audio_frame.audio))
        if not self._health.voice_only:
            await super()._on_participant_audio_data(audio_frame)

    async def _on_participant_video_frame(self, video_frame: ImageRawFrame):
        self._health.media_received(False)
        if not self._health.voice_only:
            await super()._on_participant_video_frame(video_frame)

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        if self._health.voice_only and isinstance(frame, (TTSAudioRawFrame, UserStartedSpeakingFrame, UserStoppedSpeakingFrame)):
            # Bypass the avatar: TTS audio goes to the room as-is, and the dead avatar gets no
            # listening/interrupt commands. AIService.process_frame still does Pipecat's bookkeeping.
            await AIService.process_frame(self, frame, direction)
            await self.push_frame(frame, direction)
            return
        if self._health.voice_only:
            # Lifecycle and everything else: the parent forwards it (its avatar calls are None-safe)
            await super().process_frame(frame, direction)
            return
        if isinstance(frame, TTSAudioRawFrame):
            self._health.speech_sent()
        await super().process_frame(frame, direction)
