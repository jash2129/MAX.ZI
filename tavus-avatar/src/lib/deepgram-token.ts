import "server-only";

// A short-lived Deepgram token for the browser's speech-to-text stream (src/lib/deepgram-stt.ts).
// The API key stays on the server; the token only needs to be valid when the WebSocket opens.
// Used by /api/stt/token (the call) and /api/health (can this deployment mint one?).
export const TOKEN_TTL_SECONDS = 60;

export type MintResult =
  | { ok: true; token: string; expiresIn: number }
  | { ok: false; status: number; error: string };

export async function mintDeepgramToken(fetchImpl: typeof fetch = fetch): Promise<MintResult> {
  const key = process.env.DEEPGRAM_API_KEY?.trim();
  if (!key) return { ok: false, status: 503, error: "DEEPGRAM_API_KEY is not set" };
  try {
    const res = await fetchImpl("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl_seconds: TOKEN_TTL_SECONDS }),
    });
    if (!res.ok) return { ok: false, status: 502, error: `Deepgram answered ${res.status}` };
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return { ok: false, status: 502, error: "no token in Deepgram's reply" };
    return { ok: true, token: data.access_token, expiresIn: data.expires_in ?? TOKEN_TTL_SECONDS };
  } catch {
    return { ok: false, status: 502, error: "could not reach Deepgram" };
  }
}
