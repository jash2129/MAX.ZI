import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request switch for "no extra AI calls in here". Used by the combined Option C turn: while the
 * controller works out the candidate lines (and while it builds the chosen one), the classifier and the
 * knowledge base use their rules and keywords instead of AI calls, because the one combined AI call
 * understands the customer and words the reply. `quiet` also silences the per-turn log lines of those
 * trial runs. AsyncLocalStorage keeps it to this request only, even with calls running side by side.
 */
const store = new AsyncLocalStorage<{ noExtraLLM: boolean; quiet: boolean }>();

export function withoutExtraLLM<T>(fn: () => Promise<T>, opts: { quiet?: boolean } = {}): Promise<T> {
  return store.run({ noExtraLLM: true, quiet: Boolean(opts.quiet) }, fn);
}

export function extraLLMAllowed(): boolean {
  return !store.getStore()?.noExtraLLM;
}

/** Trial runs while planning a combined turn: no per-turn log lines */
export function isQuietRun(): boolean {
  return Boolean(store.getStore()?.quiet);
}
