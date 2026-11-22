"""When does the customer's turn start (and, while Max is talking, when does it cut him off)?

Replaces Pipecat's default start strategies (VAD + transcription), which would cut Max off on any noise
or "yeah". The rules are the demo's tuned ones (policy.barge_in_decision):

- Max silent: the first sign of speech (VAD or any transcript) starts the turn at once (lowest latency).
- Max talking: only a transcript that passes barge_in_decision starts the turn, and the user aggregator
  then interrupts Max (InterruptionFrame). Anything else is dropped from the aggregation, so a
  backchannel said over Max is not answered later as if it were a reply.
"""

from __future__ import annotations

import time

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InterimTranscriptionFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
)
from pipecat.turns.user_start.base_user_turn_start_strategy import BaseUserTurnStartStrategy

from .policy import barge_in_decision


class MaxBargeInStartStrategy(BaseUserTurnStartStrategy):
    def __init__(self, *, clock=time.monotonic, **kwargs):
        super().__init__(**kwargs)
        self._clock = clock
        self._bot_speaking = False
        self._line_started_at: float | None = None

    @property
    def bot_speaking(self) -> bool:
        return self._bot_speaking

    async def handle_user_turn_started(self):
        # A started user turn interrupts Max; playback stops and BotStoppedSpeaking follows
        pass

    async def process_frame(self, frame: Frame):
        if isinstance(frame, BotStartedSpeakingFrame):
            if not self._bot_speaking:
                self._line_started_at = self._clock()
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
            self._line_started_at = None
        elif isinstance(frame, VADUserStartedSpeakingFrame):
            if not self._bot_speaking:
                await self.report_user_turn_started()
        elif isinstance(frame, (TranscriptionFrame, InterimTranscriptionFrame)):
            await self._on_transcript(frame.text)

    async def _on_transcript(self, text: str):
        if not self._bot_speaking:
            if text.strip():
                await self.report_user_turn_started()
            return
        now = self._clock()
        started = now if self._line_started_at is None else self._line_started_at
        ms_into_line = (now - started) * 1000
        decision = barge_in_decision(text, ms_into_line)
        logger.debug(f"barge-in {decision.reason} interrupt={decision.interrupt} ms={ms_into_line:.0f}")
        if decision.interrupt:
            await self.report_user_turn_started()
        else:
            await self.trigger_reset_aggregation()
