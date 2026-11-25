import { cookies } from "next/headers";

import { createTestLinkAction, revokeTestLinkAction } from "@/app/actions";
import { CopyField } from "@/components/copy-field";
import { portalDb } from "@/server/db";
import { listTestLinks, type Kind } from "@/server/portal";
import { portalUrl } from "@/server/url";

const day = (t: string) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * "Share with a client": a link to test this version with no account (/t/<token>). Managers only. A
 * new link is shown once (its token isn't stored), then listed with its use and a Turn off button.
 */
export async function ShareLinks({ personId, dealershipId, kind, versionId, back }: { personId: string; dealershipId: string; kind: Kind; versionId: string; back: string }) {
  const links = await listTestLinks(portalDb(), personId, versionId);
  const fresh = (await cookies()).get("flash_test_link")?.value ?? null;
  const freshUrl = fresh && fresh.startsWith("mxt_") ? `${portalUrl()}/t/${fresh}` : null;
  const active = links.filter((l) => !l.revoked_at && new Date(l.expires_at) > new Date());

  return (
    <section className="panel" style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }} aria-labelledby={`share-${versionId}`}>
      <div>
        <strong id={`share-${versionId}`}>Share with a client</strong>
        <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>
          A link to test this version with no sign-in: they see only the call (type, voice or video), not your settings. Up to 400 messages and 20 video calls
          per link.
        </p>
      </div>
      {freshUrl && (
        <div className="notice ok" style={{ margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          <span>New link ready. Copy it now: it&apos;s shown only once.</span>
          <CopyField value={freshUrl} label="Client test link" />
        </div>
      )}
      <form action={createTestLinkAction} className="row" style={{ alignItems: "flex-end" }}>
        <input type="hidden" name="dealership" value={dealershipId} />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="version" value={versionId} />
        <input type="hidden" name="back" value={back} />
        <div style={{ flex: "1 1 180px" }}>
          <label htmlFor={`label-${versionId}`} style={{ marginTop: 0 }}>
            Who it&apos;s for (optional)
          </label>
          <input id={`label-${versionId}`} name="label" maxLength={80} placeholder="e.g. Sunrise Mazda, John" />
        </div>
        <div style={{ flex: "0 1 130px" }}>
          <label htmlFor={`days-${versionId}`} style={{ marginTop: 0 }}>
            Works for
          </label>
          <select id={`days-${versionId}`} name="days" defaultValue="7">
            <option value="1">1 day</option>
            <option value="3">3 days</option>
            <option value="7">7 days</option>
            <option value="14">14 days</option>
            <option value="30">30 days</option>
          </select>
        </div>
        <button className="primary" type="submit">
          Create link
        </button>
      </form>
      {links.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {links.map((l) => {
            const on = active.includes(l);
            return (
              <li key={l.id} className="row" style={{ justifyContent: "space-between", fontSize: 14, padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                <span>
                  <b>{l.label || l.prefix + "…"}</b>{" "}
                  <span className="muted">
                    {on ? `until ${day(l.expires_at)}` : l.revoked_at ? "turned off" : "expired"} · {l.turns_used} messages · {l.video_used} video
                  </span>
                </span>
                {on && (
                  <form action={revokeTestLinkAction}>
                    <input type="hidden" name="link" value={l.id} />
                    <input type="hidden" name="back" value={back} />
                    <button className="danger" type="submit" style={{ minHeight: 34 }}>
                      Turn off
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
