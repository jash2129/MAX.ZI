import { acceptInviteAction } from "@/app/actions";
import { Notices } from "@/components/chrome";
import { portalDb } from "@/server/db";
import { peekInvite } from "@/server/portal";

export default async function Invite({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string>> }) {
  const { token } = await params;
  const search = await searchParams;
  const email = await peekInvite(portalDb(), token);
  return (
    <main className="narrow">
      <h1>Set up your account</h1>
      <Notices search={search} />
      {!email ? (
        <p className="notice warn">This invite link has expired or was already used. Ask whoever invited you for a new one.</p>
      ) : (
        <form action={acceptInviteAction} className="panel">
          <input type="hidden" name="token" value={token} />
          <p>
            Account for <strong>{email}</strong>
          </p>
          <label htmlFor="name">Your name</label>
          <input id="name" name="name" autoComplete="name" />
          <label htmlFor="password">Password (at least 12 characters)</label>
          <input id="password" name="password" type="password" minLength={12} autoComplete="new-password" required />
          <label htmlFor="confirm">Same password again</label>
          <input id="confirm" name="confirm" type="password" minLength={12} autoComplete="new-password" required />
          <p>
            <button className="primary" type="submit">
              Create account
            </button>
          </p>
        </form>
      )}
    </main>
  );
}
