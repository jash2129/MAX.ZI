"""Mirrors tavus-avatar/src/lib/turn-taking.test.ts (bargeInDecision): the port must behave the same."""

import pytest

from max_worker.policy import BARGE_IN_GRACE_MS, barge_in_decision


def test_yeah_early_does_not_interrupt():
    assert barge_in_decision("yeah", 400).interrupt is False


def test_stop_word_in_grace():
    d = barge_in_decision("wait, hold on", 400)
    assert d.interrupt and d.reason == "stop_word_in_grace"


def test_real_question_after_grace():
    assert barge_in_decision("what does the warranty actually cover", 2000).interrupt


@pytest.mark.parametrize("text", ["yes", "okay", "sure", "mm-hm", "uh-huh", "right", "um", "hmm", "I see", "got it", "yeah yeah", "okay got it"])
@pytest.mark.parametrize("ms", [0, 800, 5000])
def test_backchannels_never_interrupt(text, ms):
    assert barge_in_decision(text, ms).interrupt is False


def test_grace_period_only_stop_words():
    assert barge_in_decision("tell me more about it", 0).interrupt is False
    assert barge_in_decision("who is this", 300).interrupt is True
    assert barge_in_decision("excuse me", BARGE_IN_GRACE_MS - 1).interrupt is True
    assert barge_in_decision("tell me more about it", BARGE_IN_GRACE_MS + 1).interrupt is True


@pytest.mark.parametrize("text", ["brother", "are you", "who are", "actually", "Audi"])
def test_short_non_stop_words_do_not_interrupt(text):
    assert barge_in_decision(text, 7000).interrupt is False


@pytest.mark.parametrize("text", ["wait a second", "stop", "hold on", "hang on", "excuse me", "listen", "hear me out", "let me finish"])
def test_stop_phrases_cut_at_any_length(text):
    assert barge_in_decision(text, 3000).interrupt is True


def test_substantive_speech():
    d = barge_in_decision("this is taking forever", 3000)
    assert d.interrupt and d.reason == "substantive_speech"


def test_empty():
    assert barge_in_decision("  ", 3000).reason == "empty"
