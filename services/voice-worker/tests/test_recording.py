"""Call recordings: kept only with consent, encrypted so only the portal's private key reads them back,
and readable by the portal's Node code (services/control-plane/src/recording-crypto.ts)."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import shutil
import subprocess
import uuid
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pipecat.frames.frames import InputAudioRawFrame, OutputAudioRawFrame
from pipecat.tests.utils import run_test

from max_worker.brain_client import BrainClient
from max_worker.recording import (
    RECORDING_SAMPLE_RATE,
    CallRecording,
    RecordingSettings,
    encrypt_recording,
    key_id_of,
    pcm_to_flac,
    recording_settings_from_env,
    storage_key_for,
)

from .conftest import BRAIN_TOKEN

CONTROL_PLANE = Path(__file__).resolve().parents[2] / "control-plane"


def keypair() -> tuple[str, rsa.RSAPrivateKey]:
    priv = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    pub = priv.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return base64.b64encode(pub).decode(), priv


PUB, PRIV = keypair()


def decrypt(obj: bytes, key: str, wrapped: str, nonce: str, priv: rsa.RSAPrivateKey = PRIV) -> bytes:
    data_key = priv.decrypt(base64.b64decode(wrapped), padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    return AESGCM(data_key).decrypt(base64.b64decode(nonce), obj, key.encode())


def stereo_pcm(seconds: float = 2.0) -> bytes:
    n = int(RECORDING_SAMPLE_RATE * seconds)
    t = np.arange(n) / RECORDING_SAMPLE_RATE
    left = (np.sin(2 * np.pi * 220 * t) * 8000).astype("<i2")
    right = (np.sin(2 * np.pi * 440 * t) * 8000).astype("<i2")
    return np.stack([left, right], axis=1).tobytes()


class FakeStore:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    async def put(self, key: str, body: bytes, content_type: str) -> None:
        self.objects[key] = body


class FakeBrain:
    def __init__(self, stored: bool = True) -> None:
        self.sent: list[dict] = []
        self.stored = stored

    async def recording(self, meta: dict) -> bool:
        self.sent.append(meta)
        return self.stored


def test_storage_key_is_under_the_dealership_by_month():
    assert storage_key_for("demo-mazda", "c-1", when=1795000000) == "demo-mazda/2026/11/c-1.flac.enc"
    assert storage_key_for("demo-mazda", "a/../b", when=1795000000) == "demo-mazda/2026/11/a____b.flac.enc"


def test_not_configured_means_not_recorded_and_a_bad_key_fails_at_start():
    assert recording_settings_from_env({}) is None
    env = {"RECORDING_PUBLIC_KEY": PUB, "S3_ENDPOINT": "https://s3.example.com", "S3_BUCKET": "b", "S3_ACCESS_KEY_ID": "a", "S3_SECRET_ACCESS_KEY": "s"}
    assert recording_settings_from_env({**env, "S3_BUCKET": ""}) is None
    assert recording_settings_from_env(env).key_id == key_id_of(PUB)
    with pytest.raises(Exception):
        recording_settings_from_env({**env, "RECORDING_PUBLIC_KEY": base64.b64encode(b"not a key").decode()})


def test_flac_is_lossless_stereo():
    pcm = stereo_pcm(1.0)
    data, rate = sf.read(io.BytesIO(pcm_to_flac(pcm)), dtype="int16")
    assert rate == RECORDING_SAMPLE_RATE and data.shape == (RECORDING_SAMPLE_RATE, 2)
    assert data.tobytes() == pcm


def test_encryption_binds_the_storage_key_and_needs_the_private_key():
    enc = encrypt_recording(b"audio" * 1000, "demo-mazda/2026/11/c.flac.enc", PUB)
    assert hashlib.sha256(enc.object).hexdigest() == enc.sha256
    assert decrypt(enc.object, "demo-mazda/2026/11/c.flac.enc", enc.key_wrapped, enc.nonce) == b"audio" * 1000
    with pytest.raises(Exception):
        decrypt(enc.object, "demo-hyundai/2026/11/c.flac.enc", enc.key_wrapped, enc.nonce)
    with pytest.raises(Exception):
        decrypt(enc.object, "demo-mazda/2026/11/c.flac.enc", enc.key_wrapped, enc.nonce, priv=keypair()[1])


@pytest.mark.asyncio
async def test_without_consent_nothing_is_uploaded_and_the_audio_is_deleted(tmp_path):
    store, brain = FakeStore(), FakeBrain()
    rec = CallRecording("demo-mazda", "c-no", RecordingSettings(PUB, store), tmp_dir=str(tmp_path))
    rec._on_audio(None, stereo_pcm(), RECORDING_SAMPLE_RATE, 2)
    assert list(tmp_path.iterdir())
    assert await rec.finish(False, brain) is False
    assert store.objects == {} and brain.sent == []
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_with_consent_it_is_encrypted_uploaded_and_recorded(tmp_path):
    store, brain = FakeStore(), FakeBrain()
    rec = CallRecording("demo-mazda", "c-yes", RecordingSettings(PUB, store), tmp_dir=str(tmp_path))
    pcm = stereo_pcm(2.0)
    rec._on_audio(None, pcm[: len(pcm) // 2], RECORDING_SAMPLE_RATE, 2)
    rec._on_audio(None, pcm[len(pcm) // 2 :], RECORDING_SAMPLE_RATE, 2)
    assert await rec.finish(True, brain) is True
    [(key, obj)] = store.objects.items()
    assert key.startswith("demo-mazda/") and key.endswith("/c-yes.flac.enc")
    meta = brain.sent[0]
    assert meta["storage_key"] == key and meta["bytes"] == len(obj) and meta["duration_s"] == 2.0
    assert meta["key_id"] == key_id_of(PUB) and meta["format"] == "flac"
    assert b"fLaC" not in obj[:64]  # not readable in storage
    flac = decrypt(obj, key, meta["key_wrapped"], meta["nonce"])
    data, _ = sf.read(io.BytesIO(flac), dtype="int16")
    assert data.tobytes() == pcm
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_a_failed_upload_never_raises_and_still_deletes_the_audio(tmp_path):
    class Broken:
        async def put(self, *a):
            raise RuntimeError("storage down")

    rec = CallRecording("demo-mazda", "c-err", RecordingSettings(PUB, Broken()), tmp_dir=str(tmp_path))
    rec._on_audio(None, stereo_pcm(0.5), RECORDING_SAMPLE_RATE, 2)
    assert await rec.finish(True, FakeBrain()) is False
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_in_a_pipeline_customer_is_left_and_max_is_right(tmp_path):
    store, brain = FakeStore(), FakeBrain()
    rec = CallRecording("demo-mazda", "c-pipe", RecordingSettings(PUB, store), tmp_dir=str(tmp_path))
    await rec.start()
    n = RECORDING_SAMPLE_RATE // 50  # 20 ms frames
    loud = (np.ones(n) * 5000).astype("<i2").tobytes()
    frames = []
    for _ in range(25):
        frames.append(InputAudioRawFrame(audio=loud, sample_rate=RECORDING_SAMPLE_RATE, num_channels=1))
        frames.append(OutputAudioRawFrame(audio=loud, sample_rate=RECORDING_SAMPLE_RATE, num_channels=1))
    await run_test(rec.processor, frames_to_send=frames)
    assert await rec.finish(True, brain) is True
    [(key, obj)] = store.objects.items()
    data, _ = sf.read(io.BytesIO(decrypt(obj, key, brain.sent[0]["key_wrapped"], brain.sent[0]["nonce"])), dtype="int16")
    assert data.shape[1] == 2 and len(data) > 0
    assert np.abs(data[:, 0]).max() > 1000 and np.abs(data[:, 1]).max() > 1000


def test_the_portal_decrypts_what_the_worker_encrypted(tmp_path):
    """Python encrypts, Node (control-plane/src/recording-crypto.ts, which the portal uses) decrypts."""
    npx = shutil.which("npx")
    if not npx or not (CONTROL_PLANE / "node_modules").exists():
        pytest.skip("control-plane not installed")
    key = "demo-mazda/2026/11/cross.flac.enc"
    flac = pcm_to_flac(stereo_pcm(0.5))
    enc = encrypt_recording(flac, key, PUB)
    priv_der = PRIV.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    (tmp_path / "obj").write_bytes(enc.object)
    meta = {"storageKey": key, "keyId": key_id_of(PUB), "keyWrapped": enc.key_wrapped, "nonce": enc.nonce, "sha256": enc.sha256}
    script = (
        "import { readFileSync } from 'node:fs'; import { createHash } from 'node:crypto';"
        "import { decryptRecording, loadPrivateKey } from './src/recording-crypto.ts';"
        "const [obj, meta] = [readFileSync(process.env.OBJ), JSON.parse(process.env.META)];"
        "const out = decryptRecording(obj, meta, loadPrivateKey(process.env.PRIV));"
        "console.log(createHash('sha256').update(out).digest('hex'));"
    )
    env = {**os.environ, "OBJ": str(tmp_path / "obj"), "META": json.dumps(meta), "PRIV": base64.b64encode(priv_der).decode()}
    out = subprocess.run([npx, "tsx", "--eval", script], cwd=CONTROL_PLANE, env=env, capture_output=True, text=True, shell=os.name == "nt", timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]
    assert out.stdout.strip().splitlines()[-1] == hashlib.sha256(flac).hexdigest()


@pytest.mark.asyncio
async def test_the_brain_reports_consent_only_after_the_beat_1_disclosure(brain_url):
    async def call(answers: list[str]) -> tuple[bool, int]:
        b = BrainClient(brain_url, "demo-mazda", f"rec-{uuid.uuid4().hex[:8]}", token=BRAIN_TOKEN)
        beat = 0
        await b.start({})
        for i, text in enumerate(answers, start=1):
            async for m in b.turn(i, text):
                if m.get("type") == "final":
                    beat = int(m.get("beat", 0))
            await b.commit(i, True, 1.0)
        consent = await b.end("ended")
        await b.aclose()
        return consent, beat

    assert await call([]) == (False, 0)
    consent, beat = await call(["Yes, I can hear and see you, it's been great."])
    assert beat <= 1 and consent is False  # at the recording disclosure, no answer yet
    consent, beat = await call(["Yes, I can hear and see you, it's been great.", "Yes, that makes sense.", "Yes, that makes sense."])
    assert beat >= 2 and consent is True
