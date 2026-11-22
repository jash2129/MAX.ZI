import { portalDb } from "@/server/db";
import { PortalError } from "@/server/portal";
import { playerFromEnv, playRecording } from "@/server/recordings";
import { requirePerson } from "@/server/session";

export const dynamic = "force-dynamic";

const CONTENT_TYPE: Record<string, string> = { flac: "audio/flac", wav: "audio/wav", ogg: "audio/ogg" };
const plain = (status: number, text: string) => new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/**
 * GET /d/<dealership>/calls/<call>/recording: the decrypted audio, for the signed-in person if they may
 * read the dealership's calls. Every playback is in the audit log. Supports byte ranges (seeking).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; callId: string }> }) {
  const person = await requirePerson();
  const { id, callId } = await params;
  const player = playerFromEnv();
  if (!player) return plain(503, "Recordings are not set up on this portal (RECORDING_PRIVATE_KEY and S3_*).");
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  // One audit entry per playback: the first request (no range, or from byte 0)
  const first = !range || range[1] === "" || range[1] === "0";
  let audio: Buffer;
  let format: string;
  try {
    ({ audio, format } = await playRecording(portalDb(), player, person.id, id, decodeURIComponent(callId), { audit: first }));
  } catch (err) {
    if (err instanceof PortalError) return plain(404, err.message);
    console.error(JSON.stringify({ event: "recording_play_failed", error: String((err as Error)?.message ?? err).slice(0, 200) }));
    return plain(500, "The recording could not be played.");
  }
  const headers: Record<string, string> = {
    "Content-Type": CONTENT_TYPE[format] ?? "application/octet-stream",
    "Cache-Control": "no-store, private",
    "Accept-Ranges": "bytes",
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
  };
  if (range && (range[1] !== "" || range[2] !== "")) {
    const size = audio.length;
    let start = range[1] === "" ? size - Number(range[2]) : Number(range[1]);
    let end = range[1] === "" || range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
    start = Math.max(0, start);
    if (start >= size || end < start) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}`, "Cache-Control": "no-store" } });
    end = Math.min(end, size - 1);
    return new Response(new Uint8Array(audio.subarray(start, end + 1)), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
  }
  return new Response(new Uint8Array(audio), { status: 200, headers: { ...headers, "Content-Length": String(audio.length) } });
}
