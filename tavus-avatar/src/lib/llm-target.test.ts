import { afterEach, describe, expect, it } from "vitest";

import { aiProvider, llmTarget } from "./llm-stream";

const KEYS = ["XAI_API_KEY", "OPENAI_API_KEY", "AI_PROVIDER", "GROK_MODEL", "OPENAI_MODEL"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const env = (vars: Partial<Record<(typeof KEYS)[number], string>>) => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
};

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("which AI Max uses", () => {
  it("AI_PROVIDER=openai wins over an xAI key; a Grok model name is never sent to OpenAI", () => {
    env({ XAI_API_KEY: "x", OPENAI_API_KEY: "o", AI_PROVIDER: "openai", GROK_MODEL: "grok-4.20-0309-non-reasoning" });
    expect(aiProvider()).toBe("openai");
    expect(llmTarget()).toEqual({ endpoint: "https://api.openai.com/v1/chat/completions", apiKey: "o", model: "gpt-4o-mini" });
    process.env.OPENAI_MODEL = "gpt-4.1-mini";
    expect(llmTarget()?.model).toBe("gpt-4.1-mini");
    expect(llmTarget("grok-3")?.model).toBe("gpt-4.1-mini");
  });

  it("without AI_PROVIDER: xAI if its key is set (as before), else OpenAI; none = null", () => {
    env({ XAI_API_KEY: "x", OPENAI_API_KEY: "o" });
    expect(llmTarget()).toMatchObject({ endpoint: "https://api.x.ai/v1/chat/completions", apiKey: "x", model: "grok-4.20-0309-non-reasoning" });
    env({ OPENAI_API_KEY: "o" });
    expect(aiProvider()).toBe("openai");
    env({});
    expect(llmTarget()).toBeNull();
  });

  it("a provider asked for without its key falls back to the one that has a key", () => {
    env({ OPENAI_API_KEY: "o", AI_PROVIDER: "xai" });
    expect(aiProvider()).toBe("openai");
  });
});
