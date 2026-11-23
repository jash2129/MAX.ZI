/**
 * Streaming chat completions (OpenAI-compatible SSE, used for xAI Grok), and the helpers that let Max
 * start speaking once the first sentence of a reply is ready instead of waiting for all of it.
 *
 * Server only (reads the API key).
 */

/** Streaming replies (MAX_STREAM=on): the call screen gets Max's first sentences before the rest */
export function streamingEnabled(): boolean {
  return (process.env.MAX_STREAM ?? "").trim().toLowerCase() === "on";
}

export interface LlmTarget {
  endpoint: string;
  apiKey: string;
  model: string;
}

/** Which AI provider Max uses: AI_PROVIDER ("openai" or "xai") if that key is set, else xAI if its key is set, else OpenAI */
export function aiProvider(): "openai" | "xai" | null {
  const xai = Boolean(process.env.XAI_API_KEY?.trim());
  const openai = Boolean(process.env.OPENAI_API_KEY?.trim());
  const want = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (want === "openai" && openai) return "openai";
  if (want === "xai" && xai) return "xai";
  return xai ? "xai" : openai ? "openai" : null;
}

const isGrokModel = (m: string | undefined) => Boolean(m && /^grok/i.test(m.trim()));

/**
 * The configured provider, or null without a key: the one place every AI call chooses its provider and
 * model. Model: `modelOverride`, then OPENAI_MODEL (OpenAI) or GROK_MODEL (xAI). A Grok model name is
 * never sent to OpenAI (GROK_MODEL is often left set when switching): OpenAI then gets OPENAI_MODEL or
 * gpt-4o-mini.
 */
export function llmTarget(modelOverride?: string): LlmTarget | null {
  const provider = aiProvider();
  if (!provider) return null;
  if (provider === "xai") {
    return {
      endpoint: "https://api.x.ai/v1/chat/completions",
      apiKey: process.env.XAI_API_KEY!.trim(),
      model: modelOverride?.trim() || process.env.GROK_MODEL?.trim() || "grok-4.20-0309-non-reasoning",
    };
  }
  const pick = [modelOverride, process.env.OPENAI_MODEL, process.env.GROK_MODEL].map((m) => m?.trim()).find((m) => m && !isGrokModel(m));
  return {
    endpoint: "https://api.openai.com/v1/chat/completions",
    apiKey: process.env.OPENAI_API_KEY!.trim(),
    model: pick || "gpt-4o-mini",
  };
}

export interface StreamRequest {
  target: LlmTarget;
  messages: Array<{ role: string; content: string }>;
  maxTokens: number;
  temperature: number;
  json?: boolean;
  signal: AbortSignal;
}

/** Yields the reply's text as it arrives. Throws on an HTTP error (message "http <status>"). */
export async function* streamChat(req: StreamRequest, fetchImpl: typeof fetch = fetch): AsyncGenerator<string> {
  const res = await fetchImpl(req.target.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.target.apiKey}` },
    body: JSON.stringify({
      model: req.target.model,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stream: true,
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
      messages: req.messages,
    }),
    signal: req.signal,
  });
  if (!res.ok || !res.body) throw new Error(`http ${res.status}`);
  // A provider (or a test) that answers with one ordinary JSON completion instead of a stream
  if ((res.headers.get("content-type") ?? "").includes("application/json") || !(res.headers.get("content-type") ?? "").includes("event-stream")) {
    const text = await res.text();
    if (!text.trimStart().startsWith("data:")) {
      try {
        const content = JSON.parse(text)?.choices?.[0]?.message?.content;
        if (typeof content === "string" && content) yield content;
      } catch {
        // not JSON either: nothing to say
      }
      return;
    }
    yield* parseSse(text);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) yield delta;
      } catch {
        // a keep-alive or partial line: ignore
      }
    }
  }
}

/** SSE text that arrived all at once */
function* parseSse(text: string): Generator<string> {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return;
    try {
      const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) yield delta;
    } catch {
      // ignore
    }
  }
}

/** Collapses whitespace the same way everywhere, so the early part is always a prefix of the whole */
export const tidy = (t: string) => t.replace(/\s+/g, " ").trim();

/**
 * The complete leading sentences of `text` once they hold at least `minWords` words, and the rest.
 * A sentence counts as complete only when more text follows it (so "3." of "3.50" never splits).
 */
export function takeLeadSentences(text: string, minWords = 6): { lead: string; rest: string } | null {
  const re = /[.!?]["')\]]?\s+(?=\S)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].trimEnd().length;
    const lead = tidy(text.slice(0, end));
    if (lead.split(" ").length >= minWords) return { lead, rest: text.slice(m.index + m[0].length) };
  }
  return null;
}

/**
 * Reads the string value of `"say"` from a JSON object that is still arriving. Returns the text so far
 * (unescaped) and whether the closing quote was reached; null until `"say": "` has been seen.
 */
export function partialJsonString(json: string, key = "say"): { text: string; complete: boolean } | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  if (!m) return null;
  let out = "";
  for (let i = m.index + m[0].length; i < json.length; i++) {
    const c = json[i];
    if (c === "\\") {
      const n = json[i + 1];
      if (n === undefined) break;
      if (n === "u") {
        const hex = json.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 5;
      } else {
        out += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "" : n;
        i += 1;
      }
    } else if (c === '"') {
      return { text: out, complete: true };
    } else out += c;
  }
  return { text: out, complete: false };
}
