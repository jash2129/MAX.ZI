import { verifyTwoFactorAction } from "@/app/actions";
import { Notices } from "@/components/chrome";

export default async function TwoFactor({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const search = await searchParams;
  return (
    <main className="narrow">
      <h1>Two-factor code</h1>
      <p className="muted">Enter the 6-digit code from your authenticator app, or one of your backup codes.</p>
      <Notices search={search} />
      <form action={verifyTwoFactorAction} className="panel">
        <label htmlFor="code">Code</label>
        <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus />
        <p>
          <button className="primary" type="submit">
            Verify
          </button>
        </p>
      </form>
    </main>
  );
}
