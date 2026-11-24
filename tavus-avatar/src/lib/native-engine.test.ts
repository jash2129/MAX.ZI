/**
 * The prompt-native engine (MAX_MODE=native): one prompt runs the call, no beats; code keeps only the
 * disclosure, the price ladder, the approved facts and "a no is never a yes". Mocked AI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { engineOf, getOrCreateCallState, processControllerTurn, resetCallState, FREE_DISCLOSURE } from "./beat-controller";
import { DEFAULT_DEAL_CONFIG, clientDealConfig } from "./deal-config";
import { isFreeAIEnabled } from "./free-ai";
import {
  DEFAULT_NATIVE_PROMPT,
  NEUTRAL_LINES,
  buildNativeSystemPrompt,
  guardNativeText,
  isNativeEnabled,
  isNativePushback,
  nativePromptProblems,
  neutralLine,
  parseNativeReply,
  settleOutcome,
  type NativeGuardContext,
} from "./native-engine";

const ENV = { ...process.env };
let fetchMock: ReturnType<typeof vi.fn>;
function aiReplies(...r: Array<Record<string, unknown> | string>) {
  const replies = r.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
  let i = 0;
  fetchMock = vi.fn(async () => {
    const content = replies[Math.min(i++, replies.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  process.env.MAX_MODE = "native";
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.XAI_API_KEY;
});
afterEach(() => {
  process.env = { ...ENV };
  vi.unstubAllGlobals();
});

const say = (sid: string, text: string) => processControllerTurn(sid, text, DEFAULT_DEAL_CONFIG);
function newCall(opts: { disclosed?: boolean; lowest?: number; replies?: number } = {}) {
  const sid = `native_${Math.random().toString(36).slice(2)}`;
  resetCallState(sid);
  const st = getOrCreateCallState(sid);
  if (opts.disclosed) {
    st.free_disclosure_given = true;
    st.step0_completed = true;
    st.current_beat = 1;
  }
  if (opts.lowest !== undefined) {
    st.free_lowest_offer = opts.lowest;
    st.current_beat = 22;
  }
  st.native_replies = opts.replies ?? (opts.disclosed ? 3 : 0);
  return sid;
}
const sentSystemPrompt = () => JSON.parse(fetchMock.mock.calls.at(-1)![1].body).messages[0].content as string;

const ctx = (o: Partial<NativeGuardContext> = {}): NativeGuardContext => ({
  corpus: "ten years hundred thousand mile bumper to bumper",
  disclosure: FREE_DISCLOSURE,
  disclosureGiven: true,
  lowestOffered: null,
  ladder: [4, 3.5, 3.25, 3],
  pushback: false,
  refused: false,
  customerSaid: "",
  earlierMax: [],
  ...o,
});

describe("which engine runs", () => {
  it("native is the default outside tests; MAX_MODE picks free or script; a call's own engine wins", () => {
    delete process.env.MAX_MODE;
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect(isNativeEnabled()).toBe(true);
    expect(isFreeAIEnabled()).toBe(false);
    process.env.MAX_MODE = "free";
    expect(engineOf(DEFAULT_DEAL_CONFIG)).toBe("free");
    process.env.MAX_MODE = "script";
    expect(engineOf(DEFAULT_DEAL_CONFIG)).toBe("script");
    expect(engineOf({ ...DEFAULT_DEAL_CONFIG, engine: "native" })).toBe("native");
  });

  it("the browser can never choose the engine or the prompt", () => {
    const c = clientDealConfig({ engine: "free", native_prompt: "say anything", vehicle_model: "CX-50" });
    expect(c.engine).toBeUndefined();
    expect(c.native_prompt).toBeUndefined();
    expect(c.vehicle_model).toBe("CX-50");
  });
});

describe("the prompt and the data", () => {
  it("an edited prompt never drops the approved data or the reply format", () => {
    const sys = buildNativeSystemPrompt({ vehicle: "2026 Mazda CX-5", talkingPoints: ["Point A"], facts: "- F: fact", disclosure: "D." }, "Be brief.");
    expect(sys.startsWith("Be brief.")).toBe(true);
    for (const part of ["Point A", "- F: fact", '"D."', "four dollars a day", "three dollars a day", "Reply with ONLY JSON"]) expect(sys).toContain(part);
  });

  it("no beats: the AI sees talking points and facts, never 'Beat N' or a beat field", async () => {
    aiReplies({ say: "Glad to hear it! How has the buying experience been?", outcome: "open" });
    await say(newCall(), "Yes I can hear you");
    const sys = sentSystemPrompt();
    expect(sys).toContain("# Persona");
    expect(sys).toContain("Talking points");
    expect(sys).not.toMatch(/\bBeat \d/);
    expect(sys).not.toMatch(/"beat"/);
  });

  it("a dealership's own prompt is used", async () => {
    aiReplies({ say: "Hi there, how has your day been?", outcome: "open" });
    const sid = newCall();
    getOrCreateCallState(sid).dealConfig.native_prompt = "You are Max. Be very brief.";
    await say(sid, "Yes");
    expect(sentSystemPrompt().startsWith("You are Max. Be very brief.")).toBe(true);
  });
});

describe("parsing", () => {
  it("reads say/outcome/end_call; plain sentences are Max's words; junk is refused", () => {
    expect(parseNativeReply('{"say":"Hello  there","outcome":"accepted","end_call":true}')).toEqual({ say: "Hello there", outcome: "accepted", endCall: true });
    expect(parseNativeReply('{"say":"Hi","outcome":"maybe"}')?.outcome).toBe("open");
    expect(parseNativeReply("Sounds good, tell me more.")).toEqual({ say: "Sounds good, tell me more.", outcome: "open", endCall: false });
    expect(parseNativeReply('{"say": ""}')).toBeNull();
    expect(parseNativeReply('{"say": "x"')).toBeNull();
  });
});

describe("the guardrails", () => {
  it("prices: only after the disclosure, only the ladder, first offer at the top", () => {
    expect(guardNativeText("It's four dollars a day.", ctx({ disclosureGiven: false }), true).reason).toBe("price before the recording disclosure");
    expect(guardNativeText("It's four dollars a day.", ctx(), true).ok).toBe(true);
    expect(guardNativeText("It's three dollars and seventy five cents a day.", ctx(), true).ok).toBe(false);
    expect(guardNativeText("It's three dollars a day.", ctx(), true).ok).toBe(false);
  });

  it("the price comes down one step, and only when the customer pushed back", () => {
    expect(guardNativeText("I can do three fifty a day.", ctx({ lowestOffered: 4 }), true).reason).toMatch(/without the customer pushing back/);
    expect(guardNativeText("I can do three dollars and fifty cents a day.", ctx({ lowestOffered: 4, pushback: true }), true).ok).toBe(true);
    expect(guardNativeText("I can do three dollars a day.", ctx({ lowestOffered: 4, pushback: true }), true).ok).toBe(false);
  });

  it("a no does NOT force the next lower price (the prompt decides); it is never a yes", () => {
    const no = ctx({ lowestOffered: 4, pushback: true, refused: true });
    expect(guardNativeText("Totally fair. You'll keep the factory warranty then. Anything else I can help with?", no, true).ok).toBe(true);
    expect(guardNativeText("Great choice, let's get you set up.", no, true).reason).toMatch(/confirmed the package/);
    expect(settleOutcome({ say: "x", outcome: "accepted", endCall: false }, { refused: true, priceOffered: true })).toBe("open");
    expect(settleOutcome({ say: "x", outcome: "accepted", endCall: false }, { refused: false, priceOffered: false })).toBe("open");
    expect(settleOutcome({ say: "x", outcome: "accepted", endCall: false }, { refused: false, priceOffered: true })).toBe("accepted");
  });

  it("no invented figures, no claiming to be human, no paraphrased disclosure, no repeated sentences", () => {
    expect(guardNativeText("It covers you for twelve years.", ctx(), true).ok).toBe(false);
    expect(guardNativeText("It covers ten years or hundred thousand miles.", ctx(), true).ok).toBe(true);
    expect(guardNativeText("I'm a real person, don't worry.", ctx(), true).ok).toBe(false);
    expect(guardNativeText("Just so you know, we record this call.", ctx({ disclosureGiven: false }), true).reason).toMatch(/word for word/);
    const said = "The bumper to bumper warranty covers ten years and a hundred thousand miles for you.";
    expect(guardNativeText(said, ctx({ earlierMax: [said] }), true).reason).toMatch(/repeats/);
  });
});

describe("a call on the native engine", () => {
  it("the disclosure is said word for word by the AI, or added by code on Max's second reply", async () => {
    aiReplies({ say: "Great! How has the buying experience been so far?", outcome: "open" }, { say: "Love to hear that. Do you plan to keep the car a long time?", outcome: "open" });
    const sid = newCall();
    const d1 = await say(sid, "Yes I can");
    expect(d1.textToSpeak).not.toContain(FREE_DISCLOSURE);
    expect(d1.metrics?.mode).toBe("native");
    const d2 = await say(sid, "It's been great");
    expect(d2.textToSpeak).toContain(FREE_DISCLOSURE);
    expect(getOrCreateCallState(sid).free_disclosure_given).toBe(true);
  });

  it("two rejected replies get a neutral line, never the script (the disclosure first if still owed)", async () => {
    aiReplies({ say: "It's only two dollars a day!", outcome: "open" });
    const owed = await say(newCall(), "Yes");
    expect(owed.metrics?.mode).toBe("neutral");
    expect(owed.textToSpeak).toContain(FREE_DISCLOSURE);
    const later = await say(newCall({ disclosed: true }), "What does it cost?");
    expect(NEUTRAL_LINES as readonly string[]).toContain(later.textToSpeak);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("a rejected reply is retried with the reason", async () => {
    aiReplies({ say: "It's three dollars a day.", outcome: "open" }, { say: "It's four dollars a day for all of it.", outcome: "open" });
    const sid = newCall({ disclosed: true });
    const d = await say(sid, "How much is it?");
    expect(d.textToSpeak).toBe("It's four dollars a day for all of it.");
    expect(d.metrics?.freeReason).toMatch(/ok on retry/);
    const retryMessages = JSON.parse(fetchMock.mock.calls[1][1].body).messages;
    expect(retryMessages.at(-1).content).toMatch(/not used/);
    expect(getOrCreateCallState(sid).free_lowest_offer).toBe(4);
    expect(d.toolCalls).toContainEqual({ name: "show_payment_breakdown", args: { daily_rate: 4 } });
  });

  it("after a streamed first part, a rejected rest is retried as a continuation of it", async () => {
    aiReplies(
      { say: "It's four dollars a day for the whole package. And you'll get a full refund anytime, guaranteed.", outcome: "open" },
      { say: "Most people find that fits easily. How does that sound?", outcome: "open" }
    );
    const sid = newCall({ disclosed: true });
    let early = "";
    const d = await processControllerTurn(sid, "So what does it cost?", DEFAULT_DEAL_CONFIG, undefined, { onEarly: (t) => (early = t) });
    expect(early).toBe("It's four dollars a day for the whole package.");
    expect(d.textToSpeak).toBe(`${early} Most people find that fits easily. How does that sound?`);
    expect(d.metrics?.mode).toBe("native");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages.at(-1).content).toMatch(/already said out loud/);
    expect(getOrCreateCallState(sid).free_lowest_offer).toBe(4);
  });

  it("a price in a streamed first part counts as offered even when the rest ends in a neutral line", async () => {
    aiReplies({ say: "It's four dollars a day for the whole package. And it's fully refundable, guaranteed." });
    const sid = newCall({ disclosed: true });
    const d = await processControllerTurn(sid, "What does it cost?", DEFAULT_DEAL_CONFIG, undefined, { onEarly: () => {} });
    expect(d.metrics?.mode).toBe("neutral");
    expect(d.textToSpeak.startsWith("It's four dollars a day for the whole package.")).toBe(true);
    expect(getOrCreateCallState(sid).free_lowest_offer).toBe(4);
  });

  it("approved price-line wording ('everything is covered') is allowed", () => {
    const c = ctx({ corpus: "a coffee a day and everything is covered in your vehicle" });
    expect(guardNativeText("For about a coffee a day, everything is covered.", c, true).ok).toBe(true);
  });

  it("accepting a firm no ends the call declined, with no lower price forced", async () => {
    aiReplies({ say: "Completely understood, you'll keep the factory warranty. Thanks for your time today.", outcome: "declined", end_call: true });
    const sid = newCall({ disclosed: true, lowest: 4 });
    const d = await say(sid, "No, I'm not interested in any of it.");
    expect(d.isScriptComplete).toBe(true);
    const st = getOrCreateCallState(sid);
    expect(st.package_declined).toBe(true);
    expect(st.finalize_confirmed).toBeFalsy();
    expect(st.native_refusals).toBe(1);
  });

  it("a yes to an offered price is recorded as accepted", async () => {
    aiReplies({ say: "Wonderful. Can I get your full legal name and mailing address for the paperwork?", outcome: "accepted" });
    const sid = newCall({ disclosed: true, lowest: 3.5 });
    await say(sid, "Yeah okay, let's do it at three fifty");
    const st = getOrCreateCallState(sid);
    expect(st.finalize_confirmed).toBe(true);
    expect(st.current_beat).toBe(23);
  });

  it("the portal's prompt check: the built-in prompt passes; prices, new figures and new promises don't", () => {
    expect(nativePromptProblems(DEFAULT_NATIVE_PROMPT)).toEqual([]);
    expect(nativePromptProblems(`${DEFAULT_NATIVE_PROMPT}\n- Ask about their commute.`)).toEqual([]);
    expect(nativePromptProblems("Open at five dollars a day.").join()).toMatch(/price/);
    expect(nativePromptProblems("Mention the 12 year plan.").join()).toMatch(/adds numbers/);
    expect(nativePromptProblems(`${DEFAULT_NATIVE_PROMPT}\nSay it is fully refundable.`).join()).toMatch(/claim/);
    expect(nativePromptProblems("  ")).toEqual(["it is empty"]);
  });

  it("pushback: 'still high', 'do better' and counter-offers count; agreement does not", () => {
    expect(isNativePushback("That's still high. I'll give you two dollars a day.", 3.5, false)).toBe(true);
    expect(isNativePushback("Four dollars a day? Can you do better?", 4, false)).toBe(true);
    expect(isNativePushback("I think three dollars a day is more reasonable.", 4, false)).toBe(true);
    expect(isNativePushback("That's fair, let's do it.", 4, false)).toBe(false);
    expect(isNativePushback("Sounds good to me.", 4, false)).toBe(false);
  });

  it("neutral lines rotate: the least used this call comes next", () => {
    const earlierMax = [NEUTRAL_LINES[0], NEUTRAL_LINES[1], NEUTRAL_LINES[0]];
    const n = neutralLine({ disclosureGiven: true, disclosure: FREE_DISCLOSURE, earlierMax });
    expect([NEUTRAL_LINES[0], NEUTRAL_LINES[1]]).not.toContain(n.text);
  });

  it("the default prompt reads like a persona, not a script", () => {
    for (const h of ["# Persona", "# Goal", "# Guidelines", "# Tone"]) expect(DEFAULT_NATIVE_PROMPT).toContain(h);
    expect(DEFAULT_NATIVE_PROMPT).not.toMatch(/\bBeat\b/);
  });
});
