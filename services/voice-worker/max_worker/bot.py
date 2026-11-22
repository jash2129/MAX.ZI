"""One live call: the server-side Pipecat pipeline (PRD "Real-time voice pipeline").

    customer mic (Daily room)
      -> noise filter -> Silero VAD
      -> Deepgram nova-3 streaming STT (dealership keyterms)
      -> user turn: MaxBargeInStartStrategy (start / barge-in) + Smart Turn v3 (end of turn)
      -> BrainProcessor (brain service /turn, /commit)
      -> Deepgram Aura-2 TTS (24 kHz)
      -> DeliveryTap (counts audio played, for "how much was heard")
      -> LiveAvatar LITE (lip-synced video + audio; voice-only fallback)
      -> Daily room (avatar video, Max's audio, data channel: panels / captions / call state)

The browser makes no turn-taking decisions; it joins the room, plays it, and renders the panels.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass, field

import aiohttp
from loguru import logger
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import EndFrame, OutputTransportMessageUrgentFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMUserAggregator, LLMUserAggregatorParams
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.heygen.api_liveavatar import LiveAvatarNewSessionRequest
from pipecat.services.heygen.client import ServiceType
from pipecat.transports.daily.transport import DailyParams, DailyTransport
from pipecat.turns.user_stop.turn_analyzer_user_turn_stop_strategy import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from .avatar import FallbackHeyGenVideoService
from .brain_client import BrainClient
from .brain_processor import BrainProcessor, DeliveryTap
from .policy import SILENCE_PROMPT_MS
from .turn_start import MaxBargeInStartStrategy

SAMPLE_RATE = 24000  # Aura-2 and LiveAvatar both work at 24 kHz: no resampling on the way out
# The avatar the Max demo runs on ("Dexter Lawyer", tavus-avatar/src/lib/liveavatar-api.ts). Per-dealership
# avatars come from dealership config later; HEYGEN_AVATAR_ID overrides it for every call now.
DEFAULT_AVATAR_ID = "0930fd59-c8ad-434d-ad53-b391a1768720"


@dataclass
class CallConfig:
    call_id: str
    dealership_id: str
    room_url: str
    bot_token: str
    brain_url: str
    brain_token: str | None
    deepgram_api_key: str
    heygen_api_key: str | None
    avatar_id: str | None = None
    avatar_sandbox: bool = False
    tts_voice: str = "aura-2-arcas-en"
    deal: dict[str, str] = field(default_factory=dict)


def noise_filter():
    """Krisp when its SDK is installed and licensed (KRISP_MODEL_PATH), else RNNoise, else none."""
    if os.getenv("KRISP_MODEL_PATH"):
        try:
            from pipecat.audio.filters.krisp_viva_filter import KrispVivaFilter

            return KrispVivaFilter()
        except Exception as e:  # noqa: BLE001
            logger.warning(f"Krisp unavailable ({e}); trying RNNoise")
    try:
        from pipecat.audio.filters.rnnoise_filter import RNNoiseFilter

        return RNNoiseFilter()
    except Exception as e:  # noqa: BLE001
        logger.warning(f"no noise filter ({e}); install pipecat-ai[rnnoise] or Krisp")
        return None


async def run_call(cfg: CallConfig) -> None:
    log = logger.bind(call_id=cfg.call_id, dealership_id=cfg.dealership_id)
    brain = BrainClient(cfg.brain_url, cfg.dealership_id, cfg.call_id, token=cfg.brain_token)
    opening = await brain.start(cfg.deal)  # raises BrainError: the call is not started at all

    async with aiohttp.ClientSession() as http:
        transport = DailyTransport(
            cfg.room_url,
            cfg.bot_token,
            opening.get("max_display_name") or "Max",
            DailyParams(
                audio_in_enabled=True,
                audio_in_filter=noise_filter(),
                audio_out_enabled=True,
                audio_out_sample_rate=SAMPLE_RATE,
                video_out_enabled=bool(cfg.heygen_api_key),
                video_out_is_live=True,
                video_out_width=1280,
                video_out_height=720,
            ),
        )

        stt = DeepgramSTTService(
            api_key=cfg.deepgram_api_key,
            settings=DeepgramSTTService.Settings(
                model="nova-3",
                language="en-US",
                keyterm=list(opening.get("speech_keyterms") or []),
                interim_results=True,
                smart_format=True,
                punctuate=True,
            ),
        )
        tts = DeepgramTTSService(api_key=cfg.deepgram_api_key, voice=cfg.tts_voice, sample_rate=SAMPLE_RATE)

        context = LLMContext()
        user_turns = LLMUserAggregator(
            context,
            params=LLMUserAggregatorParams(
                vad_analyzer=SileroVADAnalyzer(),
                user_turn_strategies=UserTurnStrategies(
                    start=[MaxBargeInStartStrategy()],
                    stop=[TurnAnalyzerUserTurnStopStrategy(turn_analyzer=LocalSmartTurnAnalyzerV3())],
                ),
                user_idle_timeout=SILENCE_PROMPT_MS / 1000,
            ),
        )

        task: PipelineTask | None = None

        async def end_call(reason: str) -> None:
            log.info(f"call ending: {reason}")
            # Let the last words reach the customer before the room closes
            await asyncio.sleep(1.5)
            if task:
                await task.queue_frame(EndFrame())

        async def avatar_failed(reason: str) -> None:
            if task:
                await task.queue_frame(OutputTransportMessageUrgentFrame(message={"event": "avatar.state", "state": "unavailable", "reason": reason}))

        brain_proc = BrainProcessor(brain, on_call_end=end_call)
        stages = [transport.input(), stt, user_turns, brain_proc, tts, DeliveryTap(brain_proc)]
        if cfg.heygen_api_key:
            stages.append(
                FallbackHeyGenVideoService(
                    api_key=cfg.heygen_api_key,
                    session=http,
                    service_type=ServiceType.LIVE_AVATAR,
                    session_request=LiveAvatarNewSessionRequest(
                        mode="LITE",
                        avatar_id=cfg.avatar_id or DEFAULT_AVATAR_ID,
                        is_sandbox=cfg.avatar_sandbox,
                    ),
                    on_avatar_failed=avatar_failed,
                )
            )
        else:
            log.warning("HEYGEN_API_KEY not set: voice-only call")
        stages.append(transport.output())

        task = PipelineTask(
            Pipeline(stages),
            params=PipelineParams(
                audio_in_sample_rate=16000,
                audio_out_sample_rate=SAMPLE_RATE,
                enable_metrics=True,
                enable_usage_metrics=True,
            ),
        )

        @user_turns.event_handler("on_user_turn_idle")
        async def _on_idle(*_args):
            await brain_proc.on_user_idle()

        @transport.event_handler("on_first_participant_joined")
        async def _on_joined(_transport, _participant):
            await brain_proc.say_opening(str(opening.get("text", "")), int(opening.get("beat", 0)))

        @transport.event_handler("on_participant_left")
        async def _on_left(_transport, _participant, reason):
            log.info(f"customer left ({reason})")
            await task.cancel()

        try:
            await PipelineRunner(handle_sigint=False).run(task)
        finally:
            await brain.end()
            await brain.aclose()

