"""BrainProcessor in a real Pipecat pipeline, talking to the real brain service over HTTP.

Playback is simulated with BotStarted/BotStoppedSpeaking frames (the output transport sends these in a
live call); everything between the user aggregator and TTS is real.
"""

from __future__ import annotations

import uuid

import pytest
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InterruptionFrame,
    LLMContextFrame,
    OutputTransportMessageUrgentFrame,
    TTSSpeakFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.tests.utils import SleepFrame, run_test

from max_worker.brain_client import BRAIN_DOWN_LINE, BrainClient
from max_worker.brain_processor import BrainProcessor, new_user_text

from .conftest import BRAIN_TOKEN

GRACE = 0.1


class RecordingBrain(BrainClient):
    """The real client, also recording what it sent."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.commits: list[tuple[int, bool, float]] = []
        self.turns: list[tuple[int, str]] = []

    async def turn(self, turn_id, transcript):
        self.turns.append((turn_id, transcript))
        async for m in super().turn(turn_id, transcript):
            yield m

    async def commit(self, turn_id, heard, fraction_heard):
        self.commits.append((turn_id, heard, round(fraction_heard, 2)))
        return await super().commit(turn_id, heard, fraction_heard)


async def new_call(brain_url: str, dealership: str = "demo-mazda") -> RecordingBrain:
    brain = RecordingBrain(brain_url, dealership, f"t-{uuid.uuid4().hex[:10]}", token=BRAIN_TOKEN)
    await brain.start({})
    return brain


def said(frames) -> list[str]:
    return [f.text for f in frames if isinstance(f, TTSSpeakFrame)]


def events(frames) -> list[dict]:
    return [f.message for f in frames if isinstance(f, OutputTransportMessageUrgentFrame)]


def user_turn(context: LLMContext, text: str) -> LLMContextFrame:
    """The context as the user aggregator would hand it over at that turn. Frames are built before the
    test pipeline runs, so each gets its own snapshot (live, one context grows between turns)."""
    context.add_message({"role": "user", "content": text})
    return LLMContextFrame(context=LLMContext(list(context.get_messages())))


def test_new_user_text_only_takes_unseen_messages():
    msgs = [{"role": "user", "content": "yes"}, {"role": "user", "content": "it was fine"}]
    assert new_user_text(msgs, 0) == ("yes it was fine", 2)
    assert new_user_text(msgs, 2) == ("", 2)
    msgs.append({"role": "user", "content": [{"type": "text", "text": "go on"}]})
    assert new_user_text(msgs, 2) == ("go on", 3)


@pytest.mark.asyncio
async def test_a_turn_is_spoken_captioned_and_committed_as_heard(brain_url):
    brain = await new_call(brain_url)
    proc = BrainProcessor(brain, finish_grace_s=GRACE)
    ctx = LLMContext()
    down, _ = await run_test(
        proc,
        frames_to_send=[
            user_turn(ctx, "Yes, I can hear and see you."),
            SleepFrame(sleep=0.8),
            BotStartedSpeakingFrame(),
            SleepFrame(sleep=0.3),
            BotStoppedSpeakingFrame(),
            SleepFrame(sleep=0.5),
        ],
    )
    spoken = " ".join(said(down))
    assert "How has your experience been" in spoken
    kinds = [e["event"] for e in events(down)]
    assert "caption" in kinds and "call.state" in kinds
    assert brain.commits == [(1, True, 1.0)]


@pytest.mark.asyncio
async def test_interrupted_reply_is_rolled_back_and_resumed_on_go_on(brain_url):
    brain = await new_call(brain_url)
    proc = BrainProcessor(brain, finish_grace_s=GRACE)
    ctx = LLMContext()
    down, _ = await run_test(
        proc,
        frames_to_send=[
            user_turn(ctx, "Yes, I can hear and see you."),
            SleepFrame(sleep=0.8),
            BotStartedSpeakingFrame(),
            SleepFrame(sleep=0.3),
            InterruptionFrame(),  # the customer cut in 0.3 s into a ~5 s line
            SleepFrame(sleep=0.3),
            user_turn(ctx, "yeah"),
            SleepFrame(sleep=0.8),
        ],
    )
    first, second = said(down)[0], said(down)[-1]
    assert len(brain.commits) == 1
    turn_id, heard, fraction = brain.commits[0]
    assert turn_id == 1 and heard is False and fraction < 0.3
    # "yeah" after an unheard line resumes it, never answers it
    assert brain.turns[-1] == (2, "yeah")
    assert second in first or first.startswith(second.split("...")[0])


@pytest.mark.asyncio
async def test_speculative_contexts_never_reach_the_brain(brain_url):
    brain = await new_call(brain_url)
    proc = BrainProcessor(brain, finish_grace_s=GRACE)
    ctx = LLMContext([{"role": "user", "content": "yes I can"}])
    down, _ = await run_test(proc, frames_to_send=[LLMContextFrame(context=ctx, speculation=True), SleepFrame(sleep=0.4)])
    assert brain.turns == [] and said(down) == []


@pytest.mark.asyncio
async def test_brain_down_is_never_silence():
    brain = RecordingBrain("http://127.0.0.1:9", "demo-mazda", "t-down", token="x", turn_timeout_s=1.0)
    proc = BrainProcessor(brain, finish_grace_s=GRACE)
    down, _ = await run_test(proc, frames_to_send=[user_turn(LLMContext(), "hello?"), SleepFrame(sleep=1.5)])
    assert said(down) == [BRAIN_DOWN_LINE]
    assert brain.commits == []
