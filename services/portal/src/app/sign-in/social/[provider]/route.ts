import { NextResponse } from "next/server";

import { auth, socialProviders } from "@/server/auth";

/** Starts Google / Microsoft sign-in (only providers configured in the environment) */
export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!(socialProviders as string[]).includes(provider)) return NextResponse.redirect(new URL("/sign-in", request.url));
  const res = (await auth.api.signInSocial({ body: { provider: provider as "google" | "microsoft", callbackURL: "/" }, headers: request.headers, asResponse: true })) as Response;
  return res;
}
