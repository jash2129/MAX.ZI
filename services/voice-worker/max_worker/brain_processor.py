"""The pipeline's "LLM": hands each finished customer turn to the brain service and speaks its reply.

Sits where an LLM service would (after the user aggregator, before TTS). It never decides what Max says;
the brain does. Its jobs:

- one brain /turn per finished customer turn (speculative contexts are ignored: they must never move
  the script);
- speak the brain's `early` sentences at once, the rest when `final` arrives (PRD pipeline rule 1-2);
- send panels, captions and call state to the browser over the room's data channel;
- report what was heard: /commit after every reply, with the fraction played when Max was cut off
  (rule 3); the next turn always waits for that commit;
- never silence: a brain failure speaks BRAIN_DOWN_LINE (brain rule 8);
- re-prompt after long silences, and end the call after the closing line;
- log one timing line per turn (rule 5).
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from typing import Any

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InterruptionFrame,
    LLMContextFrame,
    OutputTransportMessageUrgentFrame,
    TTSAudioRawFrame,
    TTSSpeakFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from .brain_client import BRAIN_DOWN_LINE, BrainClient, BrainError
from .delivery import ReplyDelivery
from .policy import MAX_SILENCE_PROMPTS

# After the bot stops speaking, wait this long for more audio before calling the reply finished
# (the gap between the early sentences and the rest of a reply).
FINISH_GRACE_S = 0.6


def new_user_text(messages: list[Any], already_seen: int) -> tuple[str, int]:
    """The customer's turn: user messages added to the context since the last turn, joined.

    The pipeline has no assistant aggregator (the brain keeps the conversation), so the context only
    grows with user messages; `already_seen` is how many were handed to the brain before.
    """
    parts: list[str] = []
    for msg in messages[already_seen:]:
        role = msg.get("role") if isinstance(msg, dict) else getattr(msg, "role", None)
        if role != "user":
            continue
        content = msg.get("content") if isinstance(msg, dict) else getattr(msg, "content", "")
        if isinstance(content, list):
            content = " ".join(str(c.get("text", "")) for c in content if isinstance(c, dict))
        text = str(content or "").strip()
        if text:
            parts.append(text)
    return " ".join(parts).strip(), len(messages)


class BrainProcessor(FrameProcessor):
    def __init__(
        self,
        brain: BrainClient,
        *,
        on_call_end: Callable[[str], Awaitable[None]] | None = None,
        clock: Callable[[], float] = time.monotonic,
        finish_grace_s: float = FINISH_GRACE_S,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._brain = brain
        self._on_call_end = on_call_end
        self._clock = clock
        self._finish_grace_s = finish_grace_s
        self._turn_id = 0
        self._delivery: ReplyDelivery | None = None
        self._final_received = False
        self._turn_task: asyncio.Task | None = None
        self._commit_task: asyncio.Task | None = None
        self._finish_task: asyncio.Task | None = None
        self._bot_speaking = False
        self._end_reason: str | None = None
        self._ended_reason: str | None = None
        self._silence_prompts = 0
        self._timing: dict[str, float | None] = {}
        self._last_turn_text = ""
        self._seen_messages = 0

    # ---- public hooks (bot.py) -------------------------------------------------------------------

    @property
    def ended_reason(self) -> str | None:
        """Why the script ended the call (script_complete / stopped), if it did"""
        return self._ended_reason

    async def say_opening(self, text: str, beat: int) -> None:
        """Speak the line returned by POST /calls. It is not a brain turn, so it is never committed."""
        await self._send_event({"event": "call.state", "beat": beat, "phase": "opening"})
        await self._speak(text, final=True)

    async def on_user_idle(self) -> None:
        """The customer has been silent for a while (user aggregator idle event)."""
        if self._bot_speaking or self._turn_task_running() or self._end_reason:
            return
        if self._silence_prompts >= MAX_SILENCE_PROMPTS:
            return
        kind = "still_with_me" if self._silence_prompts == 0 else "clarify"
        self._silence_prompts += 1
        try:
            text = await self._brain.reprompt(kind)
        except BrainError as e:
            logger.warning(f"reprompt failed: {e}")
            return
        if text:
            await self._speak(text, final=True)

    # ---- frames ----------------------------------------------------------------------------------

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMContextFrame):
            # Consumed here: no LLM downstream
            if frame.speculation:
                return
            text, self._seen_messages = new_user_text(frame.context.get_messages(), self._seen_messages)
            if text:
                self._start_turn(text)
            return

        if isinstance(frame, InterruptionFrame):
            await self._on_interruption()
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
            if self._finish_task:
                self._finish_task.cancel()
                self._finish_task = None
            if self._delivery:
                self._delivery.bot_started(self._clock())
                if self._timing.get("first_audio") is None:
                    self._timing["first_audio"] = self._clock()
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
            if self._delivery:
                self._delivery.bot_stopped(self._clock())
            self._schedule_finish_check()

        await self.push_frame(frame, direction)

    def on_tts_audio(self, frame: TTSAudioRawFrame) -> None:
        """Called by DeliveryTap (after TTS) for every chunk of Max's audio."""
        if self._delivery and not self._delivery.committed:
            self._delivery.add_audio(len(frame.audio), frame.sample_rate, frame.num_channels)

    # ---- turns -----------------------------------------------------------------------------------

    def _turn_task_running(self) -> bool:
        return self._turn_task is not None and not self._turn_task.done()

    def _start_turn(self, text: str) -> None:
        self._silence_prompts = 0
        self._last_turn_text = text
        self._turn_id += 1
        turn_id = self._turn_id
        previous = self._turn_task
        self._turn_task = self.create_task(self._run_turn(turn_id, text, previous), name=f"brain_turn_{turn_id}")

    async def _run_turn(self, turn_id: int, text: str, previous: asyncio.Task | None) -> None:
        if previous and not previous.done():
            previous.cancel()
        # The brain must hear how the last reply ended before it answers this turn
        await self._settle_previous_reply()
        self._delivery = ReplyDelivery(turn_id)
        self._final_received = False
        self._timing = {"turn_end": self._clock(), "early": None, "final": None, "first_audio": None}
        early_text = ""
        try:
            async for msg in self._brain.turn(turn_id, text):
                kind = msg.get("type")
                if kind == "early" and not early_text and msg.get("text"):
                    early_text = str(msg["text"])
                    self._timing["early"] = self._clock()
                    await self._speak(early_text, final=False)
                elif kind == "final":
                    self._timing["final"] = self._clock()
                    await self._on_final(msg, early_text)
        except asyncio.CancelledError:
            raise
        except BrainError as e:
            logger.error(json.dumps({"event": "brain_turn_failed", "turn_id": turn_id, "error": str(e)}))
            if not early_text:
                await self._speak(BRAIN_DOWN_LINE, final=True)
            self._final_received = True
            if self._delivery:
                # Nothing for the brain to commit if it never answered; harmless if it did
                self._delivery.committed = early_text == ""
            self._schedule_finish_check()

    async def _on_final(self, msg: dict[str, Any], early_text: str) -> None:
        full = str(msg.get("text", ""))
        rest = full[len(early_text):].strip() if early_text and full.startswith(early_text) else ("" if early_text else full)
        if early_text and not full.startswith(early_text):
            # The brain's contract is that final starts with early; if not, say the final reply's tail
            logger.warning("final reply does not start with the early part")
            rest = full
        for event in msg.get("panels") or []:
            await self._send_event(event)
        await self._send_event({"event": "call.state", "beat": msg.get("beat"), "phase": msg.get("beat_type")})
        if rest:
            await self._speak(rest, final=True)
        else:
            await self._send_event({"event": "caption", "text": full, "final": True})
        if msg.get("is_complete") or msg.get("beat_type") == "stop":
            self._end_reason = "script_complete" if msg.get("is_complete") else "stopped"
        if self._delivery:
            self._delivery.add_text(full)
        self._final_received = True
        self._schedule_finish_check()

    async def _speak(self, text: str, *, final: bool) -> None:
        await self._send_event({"event": "caption", "text": text, "final": final})
        await self.push_frame(TTSSpeakFrame(text, append_to_context=False))

    async def _send_event(self, event: dict[str, Any]) -> None:
        await self.push_frame(OutputTransportMessageUrgentFrame(message=event))

    # ---- delivery and commits --------------------------------------------------------------------

    def _schedule_finish_check(self) -> None:
        if self._finish_task:
            self._finish_task.cancel()
        self._finish_task = self.create_task(self._finish_after_grace(), name="reply_finish_check")

    async def _finish_after_grace(self) -> None:
        await asyncio.sleep(self._finish_grace_s)
        d = self._delivery
        if self._bot_speaking or not self._final_received:
            return
        if d and not d.committed:
            # Finished means played and stopped: a final reply whose audio has not started yet (TTS and
            # avatar still warming up) is not "heard". If it never plays, the next turn reports it unheard.
            if d.played_seconds <= 0:
                return
            d.finished = True
            self._commit(d, interrupted=False)
        if self._end_reason:
            reason, self._end_reason = self._end_reason, None
            self._ended_reason = reason
            await self._send_event({"event": "call.ended", "reason": reason})
            if self._on_call_end:
                await self._on_call_end(reason)

    async def _on_interruption(self) -> None:
        if self._finish_task:
            self._finish_task.cancel()
            self._finish_task = None
        d = self._delivery
        if d and not d.committed:
            if d.started_at is not None:
                d.bot_stopped(self._clock())
            self._commit(d, interrupted=True)
        if self._turn_task_running():
            # Stop reading this reply; the brain finishes the turn server-side and the commit above
            # (queued behind it by the brain's per-call lock) rolls it back if it was not heard
            self._turn_task.cancel()
        self._bot_speaking = False

    def _commit(self, d: ReplyDelivery, *, interrupted: bool) -> None:
        heard, fraction = d.outcome(self._clock(), interrupted)
        d.committed = True
        timings = self._log_timing(d.turn_id, heard, fraction, interrupted)
        self._commit_task = self.create_task(self._send_commit(d.turn_id, heard, fraction, timings), name=f"commit_{d.turn_id}")

    async def _send_commit(self, turn_id: int, heard: bool, fraction: float, timings: dict[str, int | None] | None = None) -> None:
        try:
            await self._brain.commit(turn_id, heard, fraction, timings)
        except BrainError as e:
            logger.warning(f"commit {turn_id} failed: {e}")

    async def _settle_previous_reply(self) -> None:
        d = self._delivery
        if d and not d.committed:
            # A new turn before the reply was settled. Played and stopped: heard. Still playing: cut off.
            # Never played (TTS failed, or the customer spoke first): not heard.
            if self._bot_speaking:
                d.bot_stopped(self._clock())
                self._commit(d, interrupted=True)
            else:
                d.finished = d.played_seconds > 0
                self._commit(d, interrupted=not d.finished)
        if self._commit_task and not self._commit_task.done():
            try:
                await asyncio.wait_for(asyncio.shield(self._commit_task), timeout=2.0)
            except (TimeoutError, asyncio.TimeoutError):
                logger.warning("commit still pending; sending the next turn anyway")

    def _log_timing(self, turn_id: int, heard: bool, fraction: float, interrupted: bool) -> dict[str, int | None]:
        """Logs one turn_timing line and returns the stage timings for the brain's call record."""
        t = self._timing
        start = t.get("turn_end")

        def ms(key: str) -> int | None:
            v = t.get(key)
            return None if v is None or start is None else round((v - start) * 1000)

        logger.info(
            json.dumps(
                {
                    "event": "turn_timing",
                    "call_id": self._brain.call_id,
                    "dealership_id": self._brain.dealership_id,
                    "turn_id": turn_id,
                    "brain_early_ms": ms("early"),
                    "brain_final_ms": ms("final"),
                    "first_audio_ms": ms("first_audio"),
                    "heard": heard,
                    "fraction_heard": round(fraction, 3),
                    "interrupted": interrupted,
                }
            )
        )
        return {"worker_brain_early_ms": ms("early"), "worker_brain_final_ms": ms("final"), "first_audio_ms": ms("first_audio"), "interrupted": int(interrupted)}


class DeliveryTap(FrameProcessor):
    """Placed right after TTS: counts Max's audio for the current reply, passes everything on."""

    def __init__(self, brain_processor: BrainProcessor, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._bp = brain_processor

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSAudioRawFrame) and direction == FrameDirection.DOWNSTREAM:
            self._bp.on_tts_audio(frame)
        await self.push_frame(frame, direction)
