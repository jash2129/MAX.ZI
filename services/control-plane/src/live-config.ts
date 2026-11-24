import { asService, type Db } from "./db.ts";

/** What a call needs from the control plane: one dealership's identity plus its LIVE versions. */
export interface LiveDealershipConfig {
  id: string;
  name: string;
  max_display_name: string;
  mode: "scripted" | "guided" | "free";
  branding: Record<string, unknown>;
  avatar: Record<string, unknown>;
  default_vehicle: { year?: string; make?: string; model?: string };
  speech_keyterms: string[];
  /** Recorded on the call, so calls in progress keep their versions (PRD) */
  versions: { script: string | null; price: string | null; kb: string | null };
  /** free_prompt: free mode's prompt template, approved with the script (null = the built-in one) */
  script: { beats: unknown[]; disclosure: string; fixed_lines: Record<string, string>; recaps: Record<string, string>; free_prompt: string | null; native_prompt: string | null; agent: Record<string, unknown> } | null;
  price: { steps: number[]; floor: number; products: unknown[] } | null;
  /** The live knowledge-base version's entries exactly as approved (status, speak, sources ...) */
  kb: { facts: unknown[] } | null;
  /** Dealership facts plus the platform's shared facts, in one simple shape */
  facts: Array<{ topic: string; answer: string; keywords: string[]; shared: boolean }>;
}

/**
 * Reads as brain_service: the database only shows it dealerships and LIVE versions, so a draft or an
 * unapproved ladder can never reach a call, whatever this code does.
 */
export async function loadLiveConfig(db: Db, dealershipId: string): Promise<LiveDealershipConfig | null> {
  return asService(db, "brain_service", async (tx) => {
    const d = (
      await tx.query<any>(
        "select id, name, max_display_name, mode, branding, avatar, default_vehicle, speech_keyterms from dealership where id = $1",
        [dealershipId]
      )
    ).rows[0];
    if (!d) return null;
    const script = (await tx.query<any>("select id, beats, disclosure, fixed_lines, recaps, free_prompt, native_prompt, agent from script_version where dealership_id = $1 and status = 'live'", [dealershipId])).rows[0];
    const price = (await tx.query<any>("select id, steps, floor, products from price_ladder_version where dealership_id = $1 and status = 'live'", [dealershipId])).rows[0];
    const kb = (await tx.query<any>("select id, facts from kb_version where dealership_id = $1 and status = 'live'", [dealershipId])).rows[0];
    const shared = (await tx.query<any>("select topic, answer, keywords from shared_fact where active order by created_at")).rows;
    return {
      id: d.id,
      name: d.name,
      max_display_name: d.max_display_name,
      mode: d.mode,
      branding: d.branding ?? {},
      avatar: d.avatar ?? {},
      default_vehicle: d.default_vehicle ?? {},
      speech_keyterms: d.speech_keyterms ?? [],
      versions: { script: script?.id ?? null, price: price?.id ?? null, kb: kb?.id ?? null },
      script: script ? { beats: script.beats, disclosure: script.disclosure, fixed_lines: script.fixed_lines ?? {}, recaps: script.recaps ?? {}, free_prompt: script.free_prompt ?? null, native_prompt: script.native_prompt ?? null, agent: script.agent ?? {} } : null,
      price: price ? { steps: (price.steps as Array<string | number>).map(Number), floor: Number(price.floor), products: price.products ?? [] } : null,
      kb: kb ? { facts: kb.facts ?? [] } : null,
      facts: [
        ...((kb?.facts ?? []) as any[]).map((f) => ({ topic: String(f.topic ?? ""), answer: String(f.answer ?? ""), keywords: (f.keywords ?? []).map(String), shared: false })),
        ...shared.map((f: any) => ({ topic: f.topic, answer: f.answer, keywords: f.keywords ?? [], shared: true })),
      ],
    };
  });
}
