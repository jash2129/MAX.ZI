"""Call recordings (PRD: "Audio in object storage, encrypted"; recorded only with consent).

    during the call:  AudioBufferProcessor (after transport.output()) -> stereo PCM, customer left and
                      Max right, 16 kHz, appended to a temporary file on this machine (never uploaded raw)
    after the call:   the brain's /end says whether the customer consented (got past the Beat 1
                      recording disclosure).
                      No consent  -> the temporary file is deleted. Nothing leaves the machine.
                      Consent     -> FLAC, encrypted (below), uploaded to S3-compatible storage under
                                     <dealership>/<yyyy>/<mm>/<call id>.flac.enc, then the brain records
                                     it (the database checks the consent time again).

Encryption: a fresh AES-256-GCM key per recording (associated data: the storage key, so an object can't
be moved to another call or dealership), wrapped with the platform's RSA PUBLIC key (RSA-OAEP-SHA256).
This worker can encrypt but never decrypt; only the portal holds the private key. The format is
mirrored in services/control-plane/src/recording-crypto.ts (decryptRecording).

Environment: RECORDING_PUBLIC_KEY (base64 DER, from `npm run recording-keys` in control-plane), S3_ENDPOINT,
S3_BUCKET, S3_REGION (default "auto"), S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY. Without all of them,
calls are not recorded (logged once per call).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import os
import tempfile
import time
from dataclasses import dataclass
from typing import Any, Protocol

from loguru import logger

RECORDING_SAMPLE_RATE = 16000
CHANNELS = 2  # customer left, Max right
_CHUNK_SECONDS = 10


class ObjectStore(Protocol):
    async def put(self, key: str, body: bytes, content_type: str) -> None: ...


@dataclass
class RecordingSettings:
    public_key_b64: str
    store: ObjectStore

    @property
    def key_id(self) -> str:
        return key_id_of(self.public_key_b64)


def key_id_of(public_key_b64: str) -> str:
    """First 16 hex of SHA-256 over the public key's DER (same as keyIdOf in recording-crypto.ts)."""
    return hashlib.sha256(base64.b64decode(public_key_b64)).hexdigest()[:16]


class S3Store:
    """Any S3-compatible storage, path-style (R2, B2, MinIO, AWS)."""

    def __init__(self, endpoint: str, bucket: str, region: str, access_key_id: str, secret_access_key: str) -> None:
        import boto3
        from botocore.config import Config

        self.bucket = bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 4, "mode": "standard"}, connect_timeout=5, read_timeout=60),
        )

    async def put(self, key: str, body: bytes, content_type: str) -> None:
        await asyncio.to_thread(self._client.put_object, Bucket=self.bucket, Key=key, Body=body, ContentType=content_type)


def recording_settings_from_env(env: dict[str, str] | None = None) -> RecordingSettings | None:
    env = dict(os.environ) if env is None else env
    need = ["RECORDING_PUBLIC_KEY", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]
    if not all(env.get(k) for k in need):
        return None
    pub = env["RECORDING_PUBLIC_KEY"].strip()
    load_public_key(pub)  # fail at start-up on a bad key, not after a call
    store = S3Store(env["S3_ENDPOINT"].rstrip("/"), env["S3_BUCKET"], env.get("S3_REGION") or "auto", env["S3_ACCESS_KEY_ID"], env["S3_SECRET_ACCESS_KEY"])
    return RecordingSettings(public_key_b64=pub, store=store)


def load_public_key(public_key_b64: str):
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import load_der_public_key

    key = load_der_public_key(base64.b64decode(public_key_b64))
    if not isinstance(key, rsa.RSAPublicKey) or key.key_size < 2048:
        raise ValueError("RECORDING_PUBLIC_KEY must be an RSA public key of 2048 bits or more")
    return key


@dataclass
class Encrypted:
    object: bytes
    key_wrapped: str
    nonce: str
    sha256: str


def encrypt_recording(audio: bytes, storage_key: str, public_key_b64: str) -> Encrypted:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    data_key = AESGCM.generate_key(bit_length=256)
    nonce = os.urandom(12)
    obj = AESGCM(data_key).encrypt(nonce, audio, storage_key.encode("utf-8"))  # ciphertext || 16-byte tag
    wrapped = load_public_key(public_key_b64).encrypt(
        data_key, padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None)
    )
    return Encrypted(object=obj, key_wrapped=base64.b64encode(wrapped).decode(), nonce=base64.b64encode(nonce).decode(), sha256=hashlib.sha256(obj).hexdigest())


def pcm_to_flac(pcm: bytes, sample_rate: int = RECORDING_SAMPLE_RATE, channels: int = CHANNELS) -> bytes:
    import numpy as np
    import soundfile as sf

    frames = np.frombuffer(pcm[: len(pcm) - len(pcm) % (2 * channels)], dtype="<i2").reshape(-1, channels)
    out = io.BytesIO()
    sf.write(out, frames, sample_rate, format="FLAC", subtype="PCM_16")
    return out.getvalue()


def storage_key_for(dealership_id: str, call_id: str, when: float | None = None) -> str:
    t = time.gmtime(when if when is not None else time.time())
    safe_call = "".join(c if c.isalnum() or c in "-_" else "_" for c in call_id)
    return f"{dealership_id}/{t.tm_year:04d}/{t.tm_mon:02d}/{safe_call}.flac.enc"


class CallRecording:
    """One call's recording. Add `processor` after transport.output(); call `finish(consent)` at the end."""

    def __init__(self, dealership_id: str, call_id: str, settings: RecordingSettings, tmp_dir: str | None = None) -> None:
        from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor

        self.dealership_id = dealership_id
        self.call_id = call_id
        self.settings = settings
        self._log = logger.bind(call_id=call_id, dealership_id=dealership_id)
        fd, self._path = tempfile.mkstemp(prefix="max-rec-", suffix=".pcm", dir=tmp_dir)
        self._file = os.fdopen(fd, "wb")
        self._bytes = 0
        self.processor = AudioBufferProcessor(
            sample_rate=RECORDING_SAMPLE_RATE,
            num_channels=CHANNELS,
            buffer_size=RECORDING_SAMPLE_RATE * 2 * _CHUNK_SECONDS,
        )
        # A plain (not async) handler: each chunk is written whole and in order
        self.processor.add_event_handler("on_audio_data", self._on_audio)

    def _on_audio(self, _processor: Any, audio: bytes, sample_rate: int, num_channels: int) -> None:
        if self._file.closed or num_channels != CHANNELS or sample_rate != RECORDING_SAMPLE_RATE:
            return
        self._file.write(audio)
        self._bytes += len(audio)

    async def start(self) -> None:
        await self.processor.start_recording()

    @property
    def duration_s(self) -> float:
        return self._bytes / (RECORDING_SAMPLE_RATE * 2 * CHANNELS)

    def discard(self) -> None:
        if not self._file.closed:
            self._file.close()
        try:
            os.remove(self._path)
        except FileNotFoundError:
            pass

    async def finish(self, consent: bool, brain: Any) -> bool:
        """After the call and the brain's /end. Returns True when a recording was stored."""
        try:
            await self.processor.stop_recording()  # no-op if the pipeline's end already stopped it
            await asyncio.sleep(0)  # let the last chunk's handler run
            self._file.close()
            if not consent:
                self._log.info("no consent to recording: audio deleted, nothing uploaded")
                return False
            if self._bytes == 0:
                return False
            with open(self._path, "rb") as f:
                pcm = f.read()
            key = storage_key_for(self.dealership_id, self.call_id)
            flac = await asyncio.to_thread(pcm_to_flac, pcm)
            del pcm
            enc = await asyncio.to_thread(encrypt_recording, flac, key, self.settings.public_key_b64)
            del flac
            await self.settings.store.put(key, enc.object, "application/octet-stream")
            stored = await brain.recording(
                {
                    "storage_key": key,
                    "duration_s": round(self.duration_s, 1),
                    "bytes": len(enc.object),
                    "format": "flac",
                    "sha256": enc.sha256,
                    "key_id": self.settings.key_id,
                    "key_wrapped": enc.key_wrapped,
                    "nonce": enc.nonce,
                }
            )
            self._log.info(f"recording {'stored' if stored else 'refused (queued for deletion)'}: {round(self.duration_s)} s")
            return bool(stored)
        except Exception as e:  # noqa: BLE001 - a recording failure never fails the call's other records
            self._log.error(f"recording failed: {e!r}")
            return False
        finally:
            self.discard()
