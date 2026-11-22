from array import array

from max_worker.avatar import MEDIA_STALL_S, SPEECH_STALL_S, AvatarHealth, is_audible
from max_worker.delivery import ReplyDelivery, expected_speech_seconds


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


# ---- delivery -------------------------------------------------------------------------------------


def one_second_of_audio(d: ReplyDelivery, seconds: float = 1.0, rate: int = 24000):
    d.add_audio(int(seconds * rate * 2), rate)


def test_finished_reply_is_heard_in_full():
    d = ReplyDelivery(1, text="Great. Have you had a chance to drive it?")
    d.finished = True
    assert d.outcome(0, interrupted=False) == (True, 1.0)


def test_cut_early_is_not_heard_and_reports_the_fraction():
    d = ReplyDelivery(1, text="word " * 28)  # ~10 s expected
    one_second_of_audio(d, 10)
    d.bot_started(0.0)
    heard, fraction = d.outcome(2.5, interrupted=True)
    assert heard is False
    assert abs(fraction - 0.25) < 0.01


def test_cut_late_counts_as_heard():
    d = ReplyDelivery(1, text="word " * 28)
    one_second_of_audio(d, 10)
    d.bot_started(0.0)
    heard, fraction = d.outcome(9.0, interrupted=True)
    assert heard is True and fraction >= 0.8


def test_playback_pauses_are_not_counted():
    d = ReplyDelivery(1)
    one_second_of_audio(d, 4)
    d.bot_started(0.0)
    d.bot_stopped(1.0)  # gap between early part and the rest
    d.bot_started(5.0)
    assert abs(d.fraction_heard(6.0) - 0.5) < 0.01


def test_while_tts_is_still_generating_the_text_estimate_is_the_denominator():
    d = ReplyDelivery(1, text="word " * 28)  # 10 s
    one_second_of_audio(d, 1)  # only 1 s generated so far
    d.bot_started(0.0)
    assert d.fraction_heard(1.0) < 0.15


def test_expected_speech_seconds():
    assert expected_speech_seconds("") == 0
    assert expected_speech_seconds("hi") == 1.2
    assert abs(expected_speech_seconds("w " * 28) - 10) < 0.01


# ---- avatar health --------------------------------------------------------------------------------


def pcm(level: int, n: int = 480) -> bytes:
    return array("h", [level] * n).tobytes()


def test_is_audible():
    assert is_audible(pcm(0)) is False
    assert is_audible(pcm(40)) is False
    assert is_audible(pcm(3000)) is True
    assert is_audible(b"\x01") is False


def test_healthy_avatar_never_fails():
    c = Clock()
    h = AvatarHealth(c)
    h.mark_started()
    for _ in range(20):
        c.t += 0.5
        h.media_received(False)
        h.speech_sent()
        h.media_received(True)
        assert h.check() is None
    assert not h.voice_only


def test_media_stall_switches_to_voice_only_once():
    c = Clock()
    h = AvatarHealth(c)
    h.mark_started()
    c.t += MEDIA_STALL_S + 0.1
    assert h.check() == "avatar_media_stalled"
    assert h.voice_only
    assert h.check() is None  # reported once


def test_avatar_that_never_speaks_back():
    c = Clock()
    h = AvatarHealth(c)
    h.mark_started()
    h.speech_sent()
    for _ in range(int(SPEECH_STALL_S / 0.5) + 2):
        c.t += 0.5
        h.media_received(False)  # silent frames keep arriving
    assert h.check() == "avatar_not_speaking"


def test_start_failure():
    h = AvatarHealth(Clock())
    assert h.fail("avatar_start_failed") == "avatar_start_failed"
    assert h.voice_only
    assert h.fail("again") is None
