/**
 * End-to-end, in a real browser, against a running portal and a NON-PRODUCTION database (a Neon branch):
 *
 *   node e2e/flow.mjs <file with the owner's invite link> [portal url]
 *
 * invite link -> account -> two-factor set-up -> dealerships -> new price draft -> edit -> submit ->
 * release gate -> diff -> approve -> rollback -> add a person (invite link) -> sign out -> sign in with
 * two-factor. Then attacks: sign-up without an invite, for an invited and for an unknown email.
 * Prints one line per step; exits non-zero on the first failure.
 */
import { readFileSync } from "node:fs";

import { generate } from "otplib";
import { chromium, firefox } from "playwright";

const inviteLink = readFileSync(process.argv[2], "utf8").trim();
const base = process.argv[3] || new URL(inviteLink).origin;
const PASSWORD = `e2e-${Math.random().toString(36).slice(2)}-Pass!`;
let secret = "";
// A portal far from its database (this machine to Neon US East: ~300 ms a round trip) is slow; deployed
// next to it, pages take milliseconds. E2E_WAIT_MS raises or lowers the wait.
const WAIT = Number(process.env.E2E_WAIT_MS) || 60_000;

const step = (name) => console.log(`ok  ${name}`);
const fail = (name, why) => {
  console.log(`FAIL ${name}: ${why}`);
  process.exit(1);
};
/** Waits until the page's visible text contains `text` (headings split across elements included) */
const expectText = async (page, text, name) => {
  const until = Date.now() + WAIT;
  let seen = "";
  while (Date.now() < until) {
    seen = await page.locator("body").innerText().catch(() => "");
    if (seen.replace(/\s+/g, " ").includes(text)) {
      // let the page finish loading its scripts before the next interaction (as a person would)
      await page.waitForLoadState("networkidle").catch(() => {});
      return step(name);
    }
    await page.waitForTimeout(250);
  }
  fail(name, `"${text}" not on ${page.url()}\n${seen.slice(0, 600)}`);
};
const code = async () => generate({ secret });

let failedSince = 0;
/**
 * Clicks a submit and waits for `text`. If the browser itself failed the request (seen on this machine:
 * net::ERR_NETWORK_IO_SUSPENDED from Windows power management), it clicks again; a request that reached
 * the server is never repeated.
 */
const submit = async (page, selector, text, name) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = failedSince;
    await page.click(selector);
    const until = Date.now() + WAIT;
    while (Date.now() < until) {
      const seen = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
      if (seen.includes(text)) {
        await page.waitForLoadState("networkidle").catch(() => {});
        return step(attempt > 1 ? `${name} (after ${attempt - 1} browser-side network failure)` : name);
      }
      if (failedSince > before) break;
      await page.waitForTimeout(250);
    }
    if (failedSince === before) break;
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  fail(name, `"${text}" never appeared on ${page.url()}
--- page shows ---
${(await page.locator("body").innerText().catch(() => "")).slice(0, 900)}`);
};

// E2E_BROWSER=firefox: Chromium on some Windows laptops fails requests with net::ERR_NETWORK_IO_SUSPENDED
const browser = await (process.env.E2E_BROWSER === "firefox" ? firefox : chromium).launch();
const page = await browser.newPage();
// Diagnostics: form posts and browser errors (printed only on failure, see fail())
const trace = [];
const interesting = (u) => !new URL(u).pathname.startsWith("/_next/static") && !u.includes("favicon");
page.on("request", (r) => interesting(r.url()) && trace.push(`${r.method()} ${new URL(r.url()).pathname}${new URL(r.url()).search} rsc=${r.headers()["rsc"] ? 1 : 0} action=${r.headers()["next-action"] ? 1 : 0}`));
page.on("response", async (r) => {
  if (!interesting(r.url())) return;
  const h = r.headers();
  trace.push(`  -> ${r.status()} ${new URL(r.url()).pathname} redirect=${h["x-action-redirect"] ?? h["location"] ?? ""}`);
});
page.on("console", (m) => m.type() === "error" && trace.push(`console error: ${m.text().slice(0, 200)}`));
page.on("pageerror", (e) => trace.push(`page error: ${String(e).slice(0, 200)}`));
page.on("requestfailed", (r) => {
  if (r.method() === "POST") failedSince++;
  trace.push(`request failed: ${r.method()} ${new URL(r.url()).pathname} ${r.failure()?.errorText}`);
});
process.on("exit", (c) => c && console.log(trace.slice(-12).join("\n")));
try {
  // 1. invite -> account
  await page.goto(inviteLink);
  await expectText(page, "Account for owner@example.com", "invite link shows the invited email");
  await page.fill("#name", "Platform Owner");
  await page.fill("#password", PASSWORD);
  await page.fill("#confirm", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL(/\/account\/two-factor/, { timeout: WAIT });
  step("account created; an admin is sent straight to two-factor set-up");

  // 2. pages are closed until two-factor is on
  await page.goto(`${base}/`);
  await page.waitForURL(/\/account\/two-factor/);
  step("the dealership list is not reachable before two-factor is on");

  // 3. two-factor set-up
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.locator(".qr svg").waitFor({ timeout: 20_000 });
  await page.click("summary");
  secret = (await page.locator("details .mono").innerText()).trim();
  if (!/^[A-Z2-7]+=*$/.test(secret)) fail("two-factor secret", `unexpected secret format "${secret}"`);
  step("QR code and backup codes shown");
  await page.fill("#code", await code());
  await page.click("form:has(#code) button[type=submit]");
  await expectText(page, "Two-factor sign-in is on", "two-factor turned on with a code from the secret");
  await expectText(page, "Hyundai of Dallas", "dealership list shows the platform owner's dealerships");

  // 4. a price change, start to finish
  await Promise.all([page.waitForURL(/\/d\/demo-mazda$/, { timeout: WAIT }), page.click("a[href='/d/demo-mazda']")]);
  await expectText(page, "Price ladder", "dealership page");
  await submit(page, 'section:has-text("Price ladder") button:has-text("New draft")', "Price ladder v2", "new price draft from the live version");
  await page.fill("#steps", "5, 4.50, 4");
  await page.fill("#notes", "e2e: spring pricing");
  await submit(page, "text=Save draft", "Draft saved", "draft saved");
  await expectText(page, "[5,4.5,4]", "the diff shows the new ladder against the live one");
  await page.fill("#steps", "3, 4");
  await submit(page, "text=Save draft", "highest first", "an invalid ladder is refused with a reason");
  await submit(page, "text=Submit for testing", "In test", "submitted for testing");
  await submit(page, "text=Run release gate", "Release gate run: passed", "release gate passed");
  await expectText(page, "scripted suite v1", "gate result recorded with its source");
  await submit(page, "text=Approve and make live", "Approved: the new version is live", "approved");

  // 5. rollback
  await Promise.all([
    page.waitForURL(/\/d\/demo-mazda\/price\//, { timeout: WAIT }),
    page.locator("section", { hasText: "Price ladder" }).locator("a", { hasText: "v1" }).first().click(),
  ]);
  await submit(page, "text=Make this version live again", "Rolled back", "rolled back to v1");

  // 6. add a person
  await page.fill("#email", "e2e.viewer@example.com");
  await page.selectOption("#role", "viewer");
  await submit(page, "text=Add person and create invite link", "Invite link for e2e.viewer@example.com", "person added; invite link shown once");
  await expectText(page, "Recent changes", "audit log on the page");

  // 7. sign out, sign in again with two-factor
  await page.click("text=Sign out");
  await page.waitForURL(/\/sign-in/);
  await page.fill("#email", "owner@example.com");
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL(/\/sign-in\/two-factor/, { timeout: WAIT });
  step("password accepted; two-factor code asked");
  await page.fill("#code", "000000");
  await page.click("button[type=submit]");
  await expectText(page, "Invalid", "a wrong code is refused");
  await page.fill("#code", await code());
  await page.click("button[type=submit]");
  await expectText(page, "Dealerships", "signed in with the right code");

  // 8. attacks on sign-up without an invite (straight at the auth API, as an attacker would)
  for (const [email, label] of [
    ["e2e.viewer@example.com", "an invited person's email, without their link"],
    ["intruder@example.com", "an unknown email"],
  ]) {
    const res = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ email, password: "intruder-password-123", name: "x" }),
    });
    if (res.ok) fail(`sign-up refused: ${label}`, `HTTP ${res.status}`);
    step(`sign-up refused (HTTP ${res.status}): ${label}`);
  }
  console.log("ALL PASSED");
} finally {
  await browser.close();
}
