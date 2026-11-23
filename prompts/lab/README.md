# Prompt lab

Change Max's prompt and see what the change does, measured.

`baseline.md` is the prompt Max runs on today in free mode (`MAX_MODE=free`), where the AI runs the
whole call from a prompt. The code guards still apply whatever the prompt says: only the approved price
ladder, the recording disclosure word for word, no invented numbers or risky claims.

## 1. Add an AI key (once)

In `tavus-avatar/.env.local` (git-ignored; never paste keys in chat):

```
OPENAI_API_KEY=...        # or XAI_API_KEY=... (if both are set, xAI is used)
GROK_MODEL=gpt-4o-mini    # optional: the model for Max, the customers and the judge
```

## 2. Make a change

Copy `baseline.md` to a new file (e.g. `mine.md`) and edit it. Placeholders are filled from the
dealership's approved content:

| Placeholder | Becomes |
| --- | --- |
| `{{vehicle}}` | e.g. "2026 Mazda CX five" |
| `{{script}}` | the 25 approved beats, "Beat N: ..." |
| `{{facts}}` | the approved knowledge base |
| `{{disclosure}}` | the recording disclosure, word for word |
| `{{first_price}}`, `{{price_steps}}`, `{{floor}}` | the dealership's price ladder, in words |

Leave out the reply format: the lab always adds it, so an edit can't break how Max's replies are read.

## 3. Compare

From `tavus-avatar/`:

```bash
npm run prompt-lab -- --a ../prompts/lab/baseline.md --b ../prompts/lab/mine.md
```

Useful options:

- `--check "Max mentions roadside assistance before the price"`: something you want; judged yes or
  no on every call and shown as a measure (repeat the option for more).
- `--personas hard_haggler,confused_buyer`: only these customers (all 8 by default).
- `--runs 4`: more calls per customer, so smaller effects become visible (default 2).
- `--no-judge`: skip the AI judge.
- `--b` left out: A against itself, which shows the noise alone. Do this once to learn how much the
  numbers move by chance.

The report is written to `testing-skill/reports/prompt-lab-<time>.html`:

- **What changed:** only the measures that moved more than run-to-run noise.
- **The prompt diff.**
- **A against B** for every measure: hard rule failures, turns where a guard refused the AI, price
  reached, take rate, agreed rate, length, speed, and the judge's natural, listens, clear and warm
  scores, plus your checks.
- **By customer**, and **conversations side by side**, with the first turn where they differ
  highlighted.

A default run is 32 calls (8 customers × 2 runs × 2 prompts), with a few hundred AI requests. Check
your provider's pricing; a small model keeps it cheap.

`--fake` runs everything with a stand-in instead of the AI, to check the lab works without a key.
Its numbers mean nothing.

## Limits

- Free mode is not approved for real customers yet (see the root `CLAUDE.md`). The lab measures
  prompts; the release gate and approval still decide what goes live.
- The AI customers are simulations. Check a change that looks good on a few real calls too.
- The judge is an AI too. Trust large, consistent differences, not single scores.

## Learning from calls (`npm run prompt-improve`)

A loop that improves the prompt from calls, and keeps only changes that pass every gate. It never
changes what live calls use: the result is a candidate for a person to review and approve.

```bash
npm run prompt-improve -- --rounds 2                                  # from the built-in prompt
npm run prompt-improve -- --sheet "C:/Users/<you>/Downloads/Max call log - Calls.csv"
```

Each round:

1. **Collect:** the call reports in `testing-skill/reports` (free-mode calls), the calls just run on
   the current prompt, and, with `--sheet`, the call log sheet: download its **Calls** tab as CSV
   (File → Download → Comma-separated values). Testers' ratings and "What Went Wrong" notes are the
   strongest signal there is.
2. **Diagnose:** failed checks, guard refusals, judge reviews and tester notes are counted, and an AI
   ranks the causes a prompt change could fix. Causes that need a different price, rule or fact are
   marked "needs a person" and left alone.
3. **Propose:** an AI writes small, targeted edits (2 by default), told what was tried before and why
   it was refused.
4. **Safety check** (code, not AI): every rule sentence (disclosure, price ladder, floor, refusals,
   facts, honesty about being an AI) and every placeholder must stay; no new numbers, money or promise
   words; not much longer. Anything else is refused before it runs a single call.
5. **Gates:**
   - no more hard-rule failures, ever;
   - nothing significantly worse;
   - at least one experience or reliability measure significantly better;
   - **held-out customers** (4 from `testing-skill/personas.json`, never tuned on): no new failures,
     nothing worse, and the gain points the same way, or it only memorised the training customers;
   - with `--sheet`: the worst-rated real calls' customer lines replayed: no new hard failures.
6. **Remember:** every candidate and the reason it was kept or refused goes to `lessons.jsonl`, so the
   loop doesn't retry refused ideas.

It stops after `--rounds`, or earlier after two rounds with nothing accepted (converged).

Output:

- `learned/<time>/best.md`: the improved prompt, if any round passed. Compare it yourself with
  `npm run prompt-lab -- --a baseline.md --b learned/<time>/best.md --runs 4` before approving.
- `testing-skill/reports/improve-<time>.html`: the learning curve (every measure after each round),
  the causes, each candidate with its verdict and reasons, and the final prompt diff.

Cost: about `16 + rounds × 48` calls with the defaults (2 rounds: about 110 calls, several thousand AI
requests). `--fake` runs the loop with a stand-in AI to check it works; its numbers mean nothing.

Privacy: the diagnosis sends counts, testers' notes and excerpts of **simulated** calls to the AI
provider, with digit runs removed. Real calls' transcripts are never sent as excerpts; with `--sheet`,
their customer lines are replayed to Max (the same provider Max uses on live calls).
