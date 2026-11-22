import { redirect } from "next/navigation";

import { signInAction } from "@/app/actions";
import { Notices } from "@/components/chrome";
import { socialProviders } from "@/server/auth";
import { currentPerson } from "@/server/session";

export default async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  if (await currentPerson()) redirect("/");
  const search = await searchParams;
  return (
    <main className="narrow">
      <h1>Sign in</h1>
      <p className="muted">Max portal. Accounts are by invitation from your dealership or agency.</p>
      <Notices search={search} />
      <form action={signInAction} className="panel">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
        <p>
          <button className="primary" type="submit">
            Sign in
          </button>
        </p>
      </form>
      {socialProviders.length > 0 && (
        <div className="panel" style={{ marginTop: 12 }}>
          <p className="muted">Or with your work account (the email you were invited with):</p>
          <div className="row">
            {socialProviders.map((p) => (
              <a key={p} className="button" href={`/sign-in/social/${p}`}>
                {p === "google" ? "Google" : "Microsoft"}
              </a>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
