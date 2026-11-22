"""Starts the real brain service (services/brain, Node) for the tests that need it, offline: no AI keys,
no Redis, rule-based understanding."""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time
from pathlib import Path

import httpx
import pytest

BRAIN_DIR = Path(__file__).resolve().parents[2] / "brain"
BRAIN_TOKEN = "worker-test-token"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def brain_url():
    npx = shutil.which("npx")
    if not npx or not (BRAIN_DIR / "node_modules").exists():
        pytest.skip("brain service not installed (cd services/brain && npm install)")
    port = _free_port()
    env = {k: v for k, v in os.environ.items() if k not in ("XAI_API_KEY", "OPENAI_API_KEY", "MAX_MODE", "MAX_SPEECH", "MAX_UNDERSTANDING", "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL")}
    env.update(PORT=str(port), BRAIN_TOKEN=BRAIN_TOKEN, MAX_STREAM="on")
    proc = subprocess.Popen(
        [npx, "tsx", "--conditions=react-server", "src/server.ts"],
        cwd=BRAIN_DIR,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        shell=os.name == "nt",
    )
    url = f"http://127.0.0.1:{port}"
    try:
        for _ in range(120):
            try:
                if httpx.get(f"{url}/health", timeout=0.5).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            time.sleep(0.25)
        else:
            pytest.fail("brain service did not start")
        yield url
    finally:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        else:
            proc.terminate()
