"""Client for the brain service (services/brain). One instance per call."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

# Said when the brain cannot be reached at all: never silence (PRD brain rule 8). It does not move the
# script; the customer repeats and the next turn goes to the brain as usual.
BRAIN_DOWN_LINE = "Sorry, could you say that one more time?"


class BrainError(Exception):
    pass


class BrainClient:
    def __init__(
        self,
        base_url: str,
        dealership_id: str,
        call_id: str,
        token: str | None = None,
        http: httpx.AsyncClient | None = None,
        turn_timeout_s: float = 6.0,
    ) -> None:
        self.dealership_id = dealership_id
        self.call_id = call_id
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        self._http = http or httpx.AsyncClient(base_url=base_url, headers=headers, timeout=httpx.Timeout(turn_timeout_s, connect=2.0))
        if http is not None and token:
            self._http.headers.update(headers)
        self._turn_timeout_s = turn_timeout_s

    def _ids(self) -> dict[str, str]:
        return {"dealership_id": self.dealership_id, "call_id": self.call_id}

    async def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            res = await self._http.post(path, json={**self._ids(), **body})
        except httpx.HTTPError as e:
            raise BrainError(f"{path}: {e!r}") from e
        if res.status_code != 200:
            raise BrainError(f"{path}: HTTP {res.status_code} {res.text[:200]}")
        return res.json()

    async def start(self, deal: dict[str, str] | None = None) -> dict[str, Any]:
        return await self._post("/calls", {"deal": deal or {}})

    async def turn(self, turn_id: int, transcript: str) -> AsyncIterator[dict[str, Any]]:
        """Yields the brain's NDJSON lines: at most one {"type":"early"}, then {"type":"final"}."""
        body = {**self._ids(), "turn_id": turn_id, "transcript": transcript}
        try:
            async with self._http.stream("POST", "/turn", json=body, timeout=self._turn_timeout_s) as res:
                if res.status_code != 200:
                    raise BrainError(f"/turn: HTTP {res.status_code}")
                got_final = False
                async for line in res.aiter_lines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        msg = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if msg.get("type") == "error":
                        raise BrainError(f"/turn: {msg.get('status')} {msg.get('error')}")
                    if msg.get("type") == "final":
                        got_final = True
                    yield msg
                if not got_final:
                    raise BrainError("/turn: stream ended without a final reply")
        except httpx.HTTPError as e:
            raise BrainError(f"/turn: {e!r}") from e

    async def commit(self, turn_id: int, heard: bool, fraction_heard: float, timings: dict[str, int | None] | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"turn_id": turn_id, "heard": heard, "fraction_heard": round(fraction_heard, 3)}
        if timings:
            body["timings"] = timings  # stage timings for the call record (numbers only)
        return await self._post("/commit", body)

    async def reprompt(self, kind: str) -> str:
        return str((await self._post("/reprompt", {"kind": kind})).get("text", ""))

    async def end(self, reason: str = "ended") -> None:
        """Ends the call in the brain, which then writes its outcome, review and webhook."""
        try:
            await self._post("/end", {"reason": reason})
        except BrainError:
            pass  # state expires in Redis anyway

    async def aclose(self) -> None:
        await self._http.aclose()
