/**
 * Streaming replies and Option C in one AI call. The AI is mocked with real SSE streams.
 *  - the stream reader, the first-sentences splitter and the partial-JSON reader
 *  - Option C: one AI call understands and words the reply; the approved line rules what may be said
 *  - streaming: Max's first sentences are released early only after the checks that can run on them,
 *    and whatever follows always starts with them
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { streamChat, takeLeadSentences, partialJsonString, llmTarget } from "./llm-stream";
import { processControllerTurn, processClientTurn, getOrCreateCallState, resetCallState, BEATS, pendingCommits } from "./beat-controller";
import { DEFAULT_DEAL_CONFIG } from "./deal-config";
import { HANDOFF_LINE } from "./max-lines";
import { POST } from "../app/api/chat/grok/route";

const ENV = { ...process.env };

/** An SSE response that delivers `content` in small pieces, like the real API */
function sse(content: string, pieceSize = 7): Response {
  const enc = new TextEncoder();
  const pieces: string[] = [];
  for (let i = 0; i < content.length; i += pieceSize) pieces.push(content.slice(i, i + pieceSize));
  const body = new ReadableStream({
    start(c) {
      for (const p of pieces) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

let fetchMock: ReturnType<typeof vi.fn>;
/** The AI answers each request with the next of `replies` (the last one repeats); fn gets the request body */
function ai(...replies: Array<string | ((body: any) => string)>) {
  let i = 0;
  fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const r = replies[Math.min(i++, replies.length - 1)];
    return sse(typeof r === "function" ? r(body) : r);
  });
  vi.stubGlobal("fetch", fetchMock);
}
const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));

beforeEach(() => {
  process.env.XAI_API_KEY = "test-key";
  delete process.env.MAX_MODE;
  delete process.env.MAX_STREAM;
});
afterEach(() => {
  process.env = { ...ENV };
  vi.unstubAllGlobals();
});

function atBeat(beat: number) {
  const sid = `st_${Math.random().toString(36).slice(2)}`;
  resetCallState(sid);
  const st = getOrCreateCallState(sid);
  st.step0_completed = true;
  st.current_beat = beat;
  st.delivered_beats = Array.from({ length: beat }, (_, i) => i + 1);
  st.last_spoken_text = BEATS.find((b) => b.id === beat)?.text ?? "";
  return sid;
}

describe("the stream reader", () => {
  it("reads SSE pieces in order", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse("Hello there, how are you?", 3)));
    let out = "";
    for await (const d of streamChat({ target: llmTarget()!, messages: [], maxTokens: 10, temperature: 0, signal: new AbortController().signal })) out += d;
    expect(out).toBe("Hello there, how are you?");
  });

  it("also takes one ordinary JSON completion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "Plain reply." } }] }), { status: 200 })));
    let out = "";
    for await (const d of streamChat({ target: llmTarget()!, messages: [], maxTokens: 10, temperature: 0, signal: new AbortController().signal })) out += d;
    expect(out).toBe("Plain reply.");
  });

  it("throws on an HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    const it = streamChat({ target: llmTarget()!, messages: [], maxTokens: 10, temperature: 0, signal: new AbortController().signal });
    await expect(it.next()).rejects.toThrow("http 503");
  });
});

describe("first sentences and partial JSON", () => {
  it("releases whole sentences only, once they are long enough and more text follows", () => {
    expect(takeLeadSentences("Oh nice.")).toBeNull();
    expect(takeLeadSentences("Oh nice. That")).toBeNull(); // 2 words: too short
    expect(takeLeadSentences("Oh, that's rough to hear, honestly. So the")).toEqual({ lead: "Oh, that's rough to hear, honestly.", rest: "So the" });
    expect(takeLeadSentences("It is three dollars and 3.50 is")).toBeNull(); // "3." is not a sentence end
  });
  it("reads the say string of a JSON object that is still arriving", () => {
    expect(partialJsonString('{"sa')).toBeNull();
    expect(partialJsonString('{"say": "Hi \\"there\\", how')).toEqual({ text: 'Hi "there", how', complete: false });
    expect(partialJsonString('{"say": "Done.", "beat": 3}')).toEqual({ text: "Done.", complete: true });
  });
});

describe("Option C in one AI call (MAX_UNDERSTANDING=ai + MAX_SPEECH=ai)", () => {
  beforeEach(() => {
    process.env.MAX_UNDERSTANDING = "ai";
    process.env.MAX_SPEECH = "ai";
  });

  /** The AI picks `meaning`, then says the matching option's reply with a reaction in front */
  const picks = (meaning: string, reaction = "Oh man, that sounds like a rough time with that car.") => (body: any) => {
    const user = JSON.parse(body.messages[1].content);
    const option = user.OPTIONS.find((o: any) => o.for_meanings.includes(meaning));
    return `{"meaning": "${meaning}", "option": "${option.option}", "topics": [], "confidence": 0.9, "reason": "test"}\n${reaction} ${option.reply}`;
  };

  it("one AI call understands the customer and words the reply", async () => {
    ai(picks("story_or_comment"));
    const d = await processControllerTurn(atBeat(9), "Oh man, my last car blew a transmission right after the warranty ended", DEFAULT_DEAL_CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodies()[0].messages[1].content).toContain("OPTIONS");
    expect(d.metrics?.combined).toBe(true);
    expect(d.metrics?.understanding).toBe("ai");
    expect(d.metrics?.speech).toBe("ai");
    expect(d.textToSpeak.startsWith("Oh man, that sounds like a rough time")).toBe(true);
    expect(d.beatId).toBe(10);
  });

  it("streams: the first sentences go out early and the reply starts with them", async () => {
    ai(picks("story_or_comment"));
    const early: string[] = [];
    const d = await processControllerTurn(atBeat(9), "Oh man, my last car blew a transmission right after the warranty ended", DEFAULT_DEAL_CONFIG, undefined, { onEarly: (t) => early.push(t) });
    expect(early).toEqual(["Oh man, that sounds like a rough time with that car."]);
    expect(d.earlyText).toBe(early[0]);
    expect(d.textToSpeak.startsWith(early[0])).toBe(true);
  });

  it("a fixed answer (asks for a person) is said word for word, never early", async () => {
    ai(picks("wants_human"));
    const early: string[] = [];
    const d = await processControllerTurn(atBeat(9), "honestly I would really rather talk with a manager about all this", DEFAULT_DEAL_CONFIG, undefined, { onEarly: (t) => early.push(t) });
    expect(early).toEqual([]);
    expect(d.textToSpeak).toContain(HANDOFF_LINE);
    expect(d.metrics?.speechReason).toBe("fixed answer");
  });

  it("an early part, then a whole reply that fails the checker: the approved line follows it", async () => {
    ai((body: any) => {
      const user = JSON.parse(body.messages[1].content);
      const option = user.OPTIONS.find((o: any) => o.for_meanings.includes("story_or_comment"));
      return `{"meaning": "story_or_comment", "option": "${option.option}", "confidence": 0.9, "reason": "t"}\nOh man, that sounds like a rough time with that car. And it's all guaranteed for free.`;
    });
    const early: string[] = [];
    const sid = atBeat(9);
    const d = await processControllerTurn(sid, "Oh man, my last car blew a transmission right after the warranty ended", DEFAULT_DEAL_CONFIG, undefined, { onEarly: (t) => early.push(t) });
    expect(early).toHaveLength(1);
    expect(d.metrics?.speech).toBe("script");
    expect(d.textToSpeak.startsWith(early[0])).toBe(true);
    expect(d.textToSpeak).not.toMatch(/guaranteed|free/);
    // The rules still see the approved line, not the spoken words
    expect(getOrCreateCallState(sid).last_spoken_text.startsWith("Oh man")).toBe(false);
  });

  it("an unusable header: the rules decide and the approved line is said, with no second AI call", async () => {
    ai("not a header at all\nwhatever");
    const d = await processControllerTurn(atBeat(9), "Oh man, my last car blew a transmission right after the warranty ended", DEFAULT_DEAL_CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(d.metrics?.understanding).toBe("rules");
    expect(d.metrics?.speech).toBe("script");
  });

  it("a question: the knowledge base does not make its own AI call inside the combined turn", async () => {
    ai(picks("other_question", "Good question."));
    await processControllerTurn(atBeat(9), "Do I have to come back to this dealership for the service work?", DEFAULT_DEAL_CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a short clear reply skips the combined call: only the wording call", async () => {
    ai("Sounds good. So here's the next part.");
    const d = await processControllerTurn(atBeat(9), "okay", DEFAULT_DEAL_CONFIG);
    expect(d.metrics?.combined).toBeUndefined();
    expect(bodies().every((b) => !b.messages[1].content.includes("OPTIONS"))).toBe(true);
  });
});

describe("free mode streams too (MAX_MODE=free)", () => {
  beforeEach(() => {
    process.env.MAX_MODE = "free";
  });

  it("the first sentences of 'say' go out early", async () => {
    ai('{"say": "Oh man, that sounds like a rough time with that car. That is exactly why we go over the coverage.", "beat": 9}');
    const early: string[] = [];
    const sid = atBeat(9);
    getOrCreateCallState(sid).free_disclosure_given = true;
    const d = await processControllerTurn(sid, "my last car blew a transmission", DEFAULT_DEAL_CONFIG, undefined, { onEarly: (t) => early.push(t) });
    expect(d.metrics?.mode).toBe("free");
    expect(early).toEqual(["Oh man, that sounds like a rough time with that car."]);
    expect(d.textToSpeak.startsWith(early[0])).toBe(true);
  });

  it("a whole reply rejected after an early part: no retry, the script carries on after it", async () => {
    ai('{"say": "Oh man, that sounds like a rough time with that car. And it is four dollars a day.", "beat": 9}');
    const early: string[] = [];
    const sid = atBeat(9);
    getOrCreateCallState(sid).free_disclosure_given = true;
    const d = await processControllerTurn(sid, "my last car blew a transmission", DEFAULT_DEAL_CONFIG, undefined, { onEarly: (t) => early.push(t) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(d.metrics?.mode).toBe("script");
    expect(d.textToSpeak.startsWith(early[0])).toBe(true);
    expect(d.textToSpeak).not.toMatch(/four dollars/);
  });

  it("an early part that would break a rule is never released", async () => {
    ai('{"say": "Sure thing, it is just two dollars a day for all of it. Shall we?", "beat": 23}');
    const early: string[] = [];
    await processControllerTurn(atBeat(22), "what's the price", DEFAULT_DEAL_CONFIG, undefined, { onEarly: (t) => early.push(t) });
    expect(early).toEqual([]);
  });
});

describe("the turn API streams when MAX_STREAM=on", () => {
  const post = (body: unknown) => POST(new Request("http://x/api/chat/grok", { method: "POST", body: JSON.stringify(body) }));

  it("sends the early part, then the final reply, and keeps the turn ready for its commit", async () => {
    process.env.MAX_STREAM = "on";
    process.env.MAX_MODE = "free";
    ai('{"say": "Oh man, that sounds like a rough time with that car. That is exactly why we go over the coverage.", "beat": 9}');
    const sid = atBeat(9);
    getOrCreateCallState(sid).free_disclosure_given = true;
    const res = await post({ sessionId: sid, turnId: 7, stream: true, messages: [{ role: "user", content: "my last car blew a transmission" }] });
    expect(res.headers.get("content-type")).toContain("ndjson");
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["early", "final"]);
    expect(lines[1].text.startsWith(lines[0].text)).toBe(true);
    expect(lines[1].earlyText).toBe(lines[0].text);
    expect(pendingCommits.get(sid)?.turnId).toBe(7);
  });

  it("without MAX_STREAM it answers with one JSON reply, as before", async () => {
    ai("Sounds good. So here's the next part.");
    const res = await post({ sessionId: atBeat(9), turnId: 1, stream: true, messages: [{ role: "user", content: "okay" }] });
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).text).toBeTruthy();
  });

  it("processClientTurn passes the early part through", async () => {
    process.env.MAX_MODE = "free";
    ai('{"say": "Oh man, that sounds like a rough time with that car. That is exactly why we go over it.", "beat": 9}');
    const sid = atBeat(9);
    getOrCreateCallState(sid).free_disclosure_given = true;
    const early: string[] = [];
    const d = await processClientTurn(sid, "my last car blew a transmission", 3, DEFAULT_DEAL_CONFIG, { onEarly: (t) => early.push(t) });
    expect(early).toHaveLength(1);
    expect(d.earlyText).toBe(early[0]);
  });
});
