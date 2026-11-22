from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InterimTranscriptionFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
)

from max_worker.server import Settings, create_app
from max_worker.turn_start import MaxBargeInStartStrategy


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def strategy():
    clock = Clock()
    s = MaxBargeInStartStrategy(clock=clock)
    calls: list[str] = []

    async def started(*a, **k):
        calls.append("start")

    async def reset(*a, **k):
        calls.append("reset")

    s.report_user_turn_started = started  # type: ignore[method-assign]
    s.trigger_reset_aggregation = reset  # type: ignore[method-assign]
    return s, clock, calls


def tx(text: str) -> TranscriptionFrame:
    return TranscriptionFrame(text=text, user_id="u", timestamp="t")


@pytest.mark.asyncio
async def test_max_silent_any_speech_starts_the_turn():
    s, _, calls = strategy()
    await s.process_frame(VADUserStartedSpeakingFrame())
    await s.process_frame(tx("yeah"))
    assert calls == ["start", "start"]


@pytest.mark.asyncio
async def test_max_talking_backchannel_and_noise_do_not_cut_him_off():
    s, clock, calls = strategy()
    await s.process_frame(BotStartedSpeakingFrame())
    clock.t = 3.0
    await s.process_frame(VADUserStartedSpeakingFrame())  # VAD alone never interrupts Max
    await s.process_frame(tx("yeah"))
    await s.process_frame(InterimTranscriptionFrame(text="brother", user_id="u", timestamp="t"))
    assert calls == ["reset", "reset"]


@pytest.mark.asyncio
async def test_max_talking_grace_period_then_real_speech():
    s, clock, calls = strategy()
    await s.process_frame(BotStartedSpeakingFrame())
    clock.t = 0.5
    await s.process_frame(tx("tell me more about it"))  # in the 1.5 s grace: no
    await s.process_frame(tx("wait"))  # stop word in grace: yes
    clock.t = 2.0
    await s.process_frame(tx("tell me more about it"))  # after grace, 4+ words: yes
    assert calls == ["reset", "start", "start"]


@pytest.mark.asyncio
async def test_grace_restarts_with_each_line():
    s, clock, calls = strategy()
    await s.process_frame(BotStartedSpeakingFrame())
    clock.t = 5.0
    await s.process_frame(BotStoppedSpeakingFrame())
    await s.process_frame(BotStartedSpeakingFrame())
    clock.t = 5.5
    await s.process_frame(tx("tell me more about it"))
    assert calls == ["reset"]


# ---- worker HTTP API ------------------------------------------------------------------------------


def settings(**kw) -> Settings:
    base = dict(
        worker_token="w-token",
        production=False,
        max_calls=1,
        daily_api_key="d",
        brain_url="http://brain",
        brain_token=None,
        deepgram_api_key="k",
        heygen_api_key=None,
        avatar_id=None,
        avatar_sandbox=False,
        tts_voice="aura-2-arcas-en",
    )
    base.update(kw)
    return Settings(**base)


class FakeRooms:
    async def create(self):
        return "https://x.daily.co/room", "bot-token", "customer-token"


def app_with(runner, **kw):
    return TestClient(create_app(settings(**kw), rooms=FakeRooms(), runner=runner))


def test_start_call_returns_room_and_customer_token_only():
    started = []

    async def runner(cfg):
        started.append(cfg)
        await asyncio.sleep(0)

    with app_with(runner) as client:
        r = client.post("/calls", json={"dealership_id": "demo-mazda", "deal": {"vehicle_model": "CX fifty", "ssn": "nope"}}, headers={"Authorization": "Bearer w-token"})
        assert r.status_code == 200
        body = r.json()
        assert body["room_url"] == "https://x.daily.co/room" and body["customer_token"] == "customer-token"
        assert "bot-token" not in r.text
    cfg = started[0]
    assert cfg.bot_token == "bot-token" and cfg.deal == {"vehicle_model": "CX fifty"}


def test_auth_and_capacity():
    gate = asyncio.Event()

    async def runner(cfg):
        await gate.wait()

    with app_with(runner) as client:
        assert client.post("/calls", json={"dealership_id": "demo-mazda"}).status_code == 401
        ok = {"Authorization": "Bearer w-token"}
        assert client.post("/calls", json={"dealership_id": "Bad Id"}, headers=ok).status_code == 400
        assert client.post("/calls", json={"dealership_id": "demo-mazda"}, headers=ok).status_code == 200
        assert client.post("/calls", json={"dealership_id": "demo-mazda"}, headers=ok).status_code == 503
        assert client.get("/health").json()["active_calls"] == 1


def test_production_without_token_fails_closed():
    with app_with(lambda cfg: asyncio.sleep(0), worker_token=None, production=True) as client:
        assert client.post("/calls", json={"dealership_id": "demo-mazda"}).status_code == 503


def test_start_call_passes_a_deal_id_and_rejects_a_malformed_one():
    started = []

    async def runner(cfg):
        started.append(cfg)

    with app_with(runner) as client:
        ok = {"Authorization": "Bearer w-token"}
        deal = "0b9f3c1e-2a4d-4c8e-9f00-1234567890ab"
        assert client.post("/calls", json={"dealership_id": "demo-mazda", "deal_id": deal}, headers=ok).status_code == 200
        assert client.post("/calls", json={"dealership_id": "demo-mazda", "deal_id": "../../etc"}, headers=ok).status_code == 400
    assert started[0].deal_id == deal
