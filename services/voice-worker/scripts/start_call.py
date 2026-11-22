"""Development: start a call on a running worker and print a link to join it in the browser.

    python scripts/start_call.py demo-mazda
    python scripts/start_call.py demo-hyundai --model "Santa Fe"

Opens Daily's own call page (no Max panels yet: those arrive as app messages for the call page Phase 4
builds). Good enough to hear Max, interrupt him, and read the turn_timing lines in the worker's log.
"""

from __future__ import annotations

import argparse
import os
import sys
import webbrowser
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from max_worker.server import load_dotenv  # noqa: E402


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("dealership_id")
    p.add_argument("--worker", default=os.getenv("WORKER_URL", "http://localhost:7860"))
    p.add_argument("--year")
    p.add_argument("--make")
    p.add_argument("--model")
    p.add_argument("--no-open", action="store_true")
    args = p.parse_args()

    load_dotenv(str(Path(__file__).resolve().parents[1] / ".env"))
    token = os.getenv("WORKER_TOKEN", "")
    deal = {k: v for k, v in {"vehicle_year": args.year, "vehicle_make": args.make, "vehicle_model": args.model}.items() if v}
    r = httpx.post(
        f"{args.worker}/calls",
        json={"dealership_id": args.dealership_id, "deal": deal},
        headers={"Authorization": f"Bearer {token}"} if token else {},
        timeout=30,
    )
    if r.status_code != 200:
        sys.exit(f"worker said {r.status_code}: {r.text}")
    body = r.json()
    link = f"{body['room_url']}?t={body['customer_token']}"
    print(f"call {body['call_id']}\njoin: {link}")
    if not args.no_open:
        webbrowser.open(link)


if __name__ == "__main__":
    main()
