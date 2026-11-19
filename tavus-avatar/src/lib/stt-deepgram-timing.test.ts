/**
 * Turn timing with Deepgram as the default recognizer. Deepgram's text is punctuated and capitalized
 * ("Yes.", "Uh-huh.", "Wait, stop.") and it ends an utterance after 300 ms of silence, sometimes in
 * several finals. The call screen's rules (end of speech, the short-answer path, barge-in) were
 * written against the browser recognizer: these check they read Deepgram's text the same way.
 * No values are changed here.
 */
import { describe, it, expect } from "vitest";
import { bargeInDecision, BARGE_IN_GRACE_MS, BARGE_IN_MIN_WORDS, InterimBuffer } from "./turn-taking";
import { ResultAssembler, type RecognizerEvent } from "./deepgram-stt";

// A Deepgram event as the call screen reads it
const rows = (e: RecognizerEvent) => Array.from(e.results, (x) => ({ transcript: x[0].transcript, isFinal: x.isFinal }));

// The call screen's short-answer check (liveavatar-demo.tsx), same normalization and list
const QUICK = ["yes", "yeah", "yep", "yup", "no", "nope", "ok", "okay", "sure", "fine", "i did", "we did", "he did", "makes sense", "sounds good"];
const isQuickAnswer = (spoken: string) => QUICK.includes(spoken.toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim());

describe("Deepgram's punctuated text through the turn rules", () => {
  it("short answers still take the 0.3 s path", () => {
    for (const t of ["Yes.", "Yeah.", "Okay.", "OK.", "No.", "Sure.", "I did.", "Sounds good.", "Makes sense."]) expect(isQuickAnswer(t), t).toBe(true);
    expect(isQuickAnswer("Yes, I drove it.")).toBe(false);
  });

  it("backchannels never cut Max off", () => {
    for (const t of ["Mhm.", "Uh-huh.", "Yeah.", "Okay.", "Right.", "Yeah, yeah."]) {
      expect(bargeInDecision(t, 5000).interrupt, t).toBe(false);
    }
  });

  it("stop words cut him off, even in the 1.5 s grace period", () => {
    expect(bargeInDecision("Wait.", BARGE_IN_GRACE_MS - 500)).toEqual({ interrupt: true, reason: "stop_word_in_grace" });
    expect(bargeInDecision("Hold on.", 600).interrupt).toBe(true);
    expect(bargeInDecision("Stop, stop.", 5000).interrupt).toBe(true);
  });

  it("other speech waits out the grace period, then needs the minimum word count", () => {
    expect(bargeInDecision("Actually, I have a question about that.", BARGE_IN_GRACE_MS - 1).interrupt).toBe(false);
    expect(bargeInDecision("Actually, I have a question about that.", BARGE_IN_GRACE_MS + 1).interrupt).toBe(true);
    const short = Array.from({ length: BARGE_IN_MIN_WORDS - 1 }, () => "brother").join(" ");
    expect(bargeInDecision(`${short}.`, 5000)).toEqual({ interrupt: false, reason: "too_short" });
  });
});

describe("Deepgram results through the call screen's interim buffer", () => {
  it("an utterance split into two finals by a pause is one sentence with a space between", () => {
    const a = new ResultAssembler();
    const buf = new InterimBuffer();
    a.add("Yes", false);
    let e = a.add("Yes", true)!;
    let r = buf.update(rows(e), e.resultIndex);
    expect(r.final).toBe("Yes");
    e = a.add("I drove it", true)!;
    r = buf.update(rows(e), 0);
    expect(r.final).toBe("Yes I drove it");
  });

  it("a new speech start (Deepgram SpeechStarted) drops the earlier utterance, like the browser's", () => {
    const a = new ResultAssembler();
    const buf = new InterimBuffer();
    let e = a.add("Tell me more.", true)!;
    buf.update(rows(e), e.resultIndex);
    buf.reset();
    e = a.add("Okay", false)!;
    const r = buf.update(rows(e), 0);
    expect(r).toEqual({ interim: " Okay", final: "" });
  });
});
