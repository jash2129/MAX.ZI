import { redirect } from "next/navigation";

import { Notices } from "@/components/chrome";
import { currentPerson } from "@/server/session";

import { Enroll } from "./enroll";

export default async function TwoFactorSetup({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const person = await currentPerson();
  if (!person) redirect("/sign-in");
  if (person.twoFactorEnabled) redirect("/");
  const search = await searchParams;
  return (
    <main className="narrow">
      <h1>Set up two-factor sign-in</h1>
      <p className="muted">
        {person.needsTwoFactor
          ? "You can change or approve dealership configuration, so two-factor sign-in is required before you continue."
          : "Recommended for every account."}
      </p>
      <Notices search={search} />
      <Enroll />
    </main>
  );
}
