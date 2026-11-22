"""Turn-taking rules, ported unchanged from tavus-avatar/src/lib/turn-taking.ts (tuned on live calls).

Keep the two in step: tests/test_policy.py mirrors the TypeScript cases.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# No barge-in this early in a line unless a stop word is said (live call 1ee5181b: a "yeah" right as Max
# began a line cut him after 0.3 s, so his question was never heard).
BARGE_IN_GRACE_MS = 1500
# After the grace period, anything that is not a stop phrase needs this many words to cut Max off.
BARGE_IN_MIN_WORDS = 4
# A reply counts as heard once this much of it was played (beat-controller.ts DELIVERED_FRACTION).
DELIVERED_FRACTION = 0.8
# Silence handling (turn-taking.ts): re-prompt after this long, at most this many times in a row.
SILENCE_PROMPT_MS = 12000
MAX_SILENCE_PROMPTS = 3

_GRACE_STOP_WORDS = re.compile(r"\b(stop|wait|hold on|excuse me|who is this|who s this)\b")
# Stop phrases cut Max at any length after the grace period. Nothing else short does (live call ba0dad23
# cut him on "brother", "are you", "who are").
_STOP_PHRASES = re.compile(r"\b(stop|wait|hold on|hang on|excuse me|listen|hear me out|let me (speak|finish|explain))\b")
_BACKCHANNEL = {
    "yes", "yeah", "yep", "ok", "okay", "sure", "mm hm", "mm hmm", "mhm", "uh huh", "uhhuh", "right",
    "uh", "um", "hmm", "hm", "i see", "got it",
}
_MULTIWORD_BACKCHANNEL = re.compile(r"\b(mm hm+|uh huh|i see|got it)\b")


def norm(text: str) -> str:
    text = re.sub(r"[^a-z0-9 ]", " ", text.lower())
    return re.sub(r"\s+", " ", text).strip()


def _is_backchannel_only(n: str) -> bool:
    if n in _BACKCHANNEL:
        return True
    chunks = _MULTIWORD_BACKCHANNEL.sub("_", n).split(" ")
    return all(w == "_" or w in _BACKCHANNEL for w in chunks)


@dataclass(frozen=True)
class BargeIn:
    interrupt: bool
    reason: str


def barge_in_decision(transcript: str, ms_into_line: float) -> BargeIn:
    """Should this customer speech cut Max off, ms_into_line after he started the current line?"""
    n = norm(transcript)
    if not n:
        return BargeIn(False, "empty")
    if _is_backchannel_only(n):
        return BargeIn(False, "backchannel")
    if ms_into_line < BARGE_IN_GRACE_MS:
        return BargeIn(True, "stop_word_in_grace") if _GRACE_STOP_WORDS.search(n) else BargeIn(False, "grace_period")
    if _STOP_PHRASES.search(n):
        return BargeIn(True, "stop_phrase")
    if len(n.split(" ")) >= BARGE_IN_MIN_WORDS:
        return BargeIn(True, "substantive_speech")
    return BargeIn(False, "too_short")
