"""Voice worker HTTP API. Each worker runs several calls at once (PRD: at least 4) as asyncio tasks.

    POST /calls  {dealership_id, deal?}  (Authorization: Bearer WORKER_TOKEN)
      -> {call_id, room_url, customer_token}
    GET  /health

Who calls it: the server behind the customer's call link / QR code / kiosk (never the browser itself:
WORKER_TOKEN is a server secret). The browser then joins room_url with customer_token.
"""

from __future__ import annotations

import asyncio
import hmac
import os
import re
import secrets
import time
from dataclasses import dataclass

import aiohttp
from fastapi import FastAPI, Header, HTTPException
from loguru import logger
from pydantic import BaseModel, Field

ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
ROOM_TTL_S = 60 * 60


class StartCall(BaseModel):
    dealership_id: str
    # a deal from the dealership's system (control-plane intake API): the brain loads its vehicle
    deal_id: str | None = None
    deal: dict[str, str] = Field(default_factory=dict)


class StartedCall(BaseModel):
    call_id: str
    room_url: str
    customer_token: str


@dataclass
class Settings:
    worker_token: str | None
    production: bool
    max_calls: int
    daily_api_key: str
    brain_url: str
    brain_token: str | None
    deepgram_api_key: str
    heygen_api_key: str | None
    avatar_id: str | None
    avatar_sandbox: bool
    tts_voice: str

    @classmethod
    def from_env(cls) -> "Settings":
        def need(name: str) -> str:
            v = os.getenv(name, "").strip()
            if not v:
                raise RuntimeError(f"{name} is required")
            return v

        return cls(
            worker_token=os.getenv("WORKER_TOKEN", "").strip() or None,
            production=os.getenv("ENV", "").lower() == "production",
            max_calls=int(os.getenv("MAX_CALLS_PER_WORKER", "4")),
            daily_api_key=need("DAILY_API_KEY"),
            brain_url=brain_url_from_env(),
            brain_token=os.getenv("BRAIN_TOKEN", "").strip() or None,
            deepgram_api_key=need("DEEPGRAM_API_KEY"),
            heygen_api_key=os.getenv("HEYGEN_API_KEY", "").strip() or None,
            avatar_id=os.getenv("HEYGEN_AVATAR_ID", "").strip() or None,
            avatar_sandbox=os.getenv("HEYGEN_SANDBOX", "").lower() in ("1", "true", "yes"),
            tts_voice=os.getenv("TTS_VOICE", "aura-2-arcas-en"),
        )


def brain_url_from_env() -> str:
    """BRAIN_URL, or BRAIN_HOSTPORT (Render passes a private service's internal host:port) over http."""
    url = os.getenv("BRAIN_URL", "").strip()
    if url:
        return url.rstrip("/")
    hostport = os.getenv("BRAIN_HOSTPORT", "").strip()
    if hostport:
        if not re.fullmatch(r"[A-Za-z0-9.\-]+:\d{2,5}", hostport):
            raise RuntimeError(f"BRAIN_HOSTPORT must be host:port, got {hostport!r}")
        return f"http://{hostport}"
    raise RuntimeError("BRAIN_URL (or BRAIN_HOSTPORT) is required")


class RoomProvider:
    """Daily rooms: private, expire after an hour, two tokens (bot owner, customer guest)."""

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    async def create(self) -> tuple[str, str, str]:
        from pipecat.transports.daily.utils import (
            DailyMeetingTokenParams,
            DailyMeetingTokenProperties,
            DailyRESTHelper,
            DailyRoomParams,
            DailyRoomProperties,
        )

        async with aiohttp.ClientSession() as http:
            daily = DailyRESTHelper(daily_api_key=self._api_key, aiohttp_session=http)
            exp = time.time() + ROOM_TTL_S
            room = await daily.create_room(
                DailyRoomParams(privacy="private", properties=DailyRoomProperties(exp=exp, eject_at_room_exp=True, enable_prejoin_ui=False, max_participants=2))
            )
            bot_token = await daily.get_token(room.url, expiry_time=ROOM_TTL_S, owner=True)
            customer_token = await daily.get_token(
                room.url,
                expiry_time=ROOM_TTL_S,
                owner=False,
                params=DailyMeetingTokenParams(properties=DailyMeetingTokenProperties(user_name="Customer")),
            )
            return room.url, bot_token, customer_token


def create_app(settings: Settings, rooms: RoomProvider | None = None, runner=None) -> FastAPI:
    from .bot import CallConfig, run_call

    rooms = rooms or RoomProvider(settings.daily_api_key)
    run = runner or run_call
    app = FastAPI(title="Max voice worker")
    active: dict[str, asyncio.Task] = {}

    def authorize(authorization: str | None) -> None:
        if not settings.worker_token:
            if settings.production:
                raise HTTPException(503, "WORKER_TOKEN is not set")
            return
        given = authorization[7:] if authorization and authorization.startswith("Bearer ") else ""
        if not hmac.compare_digest(given.encode(), settings.worker_token.encode()):
            raise HTTPException(401, "unauthorized")

    @app.get("/health")
    async def health():
        return {"ok": True, "active_calls": len(active), "capacity": settings.max_calls, "avatar": bool(settings.heygen_api_key)}

    @app.post("/calls", response_model=StartedCall)
    async def start_call(body: StartCall, authorization: str | None = Header(default=None)):
        authorize(authorization)
        if not ID_PATTERN.match(body.dealership_id):
            raise HTTPException(400, "bad dealership_id")
        if body.deal_id is not None and not UUID_PATTERN.match(body.deal_id):
            raise HTTPException(400, "bad deal_id")
        if len(active) >= settings.max_calls:
            # The load balancer / caller tries another worker
            raise HTTPException(503, "worker at capacity")
        call_id = f"c_{secrets.token_hex(8)}"
        room_url, bot_token, customer_token = await rooms.create()
        cfg = CallConfig(
            call_id=call_id,
            dealership_id=body.dealership_id,
            room_url=room_url,
            bot_token=bot_token,
            brain_url=settings.brain_url,
            brain_token=settings.brain_token,
            deepgram_api_key=settings.deepgram_api_key,
            heygen_api_key=settings.heygen_api_key,
            avatar_id=settings.avatar_id,
            avatar_sandbox=settings.avatar_sandbox,
            tts_voice=settings.tts_voice,
            deal={k: str(v)[:60] for k, v in body.deal.items() if k in ("vehicle_year", "vehicle_make", "vehicle_model")},
            deal_id=body.deal_id,
        )

        async def guarded():
            try:
                await run(cfg)
            except Exception as e:  # noqa: BLE001 - one call failing never takes the worker down
                logger.exception(f"call {call_id} failed: {e}")
            finally:
                active.pop(call_id, None)

        active[call_id] = asyncio.create_task(guarded(), name=f"call_{call_id}")
        logger.info(f"call {call_id} started for {body.dealership_id}")
        return StartedCall(call_id=call_id, room_url=room_url, customer_token=customer_token)

    return app


def load_dotenv(path: str = ".env") -> None:
    """Local development only: KEY=VALUE lines from .env, never overriding the real environment."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.split(" #", 1)[0].strip().strip('"').strip("'")
            if value:
                os.environ.setdefault(key.strip(), value)


def main() -> None:
    import uvicorn

    load_dotenv()
    settings = Settings.from_env()
    uvicorn.run(create_app(settings), host="0.0.0.0", port=int(os.getenv("PORT", "7860")), log_level="info")


if __name__ == "__main__":
    main()
