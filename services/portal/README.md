# Max portal

The admin portal (PRD: "Multi-dealership platform and admin portal"). Next.js 16, server-rendered.
Every read and write runs as the signed-in person through Postgres row-level security
(`../control-plane`), so what someone sees and may change is decided by the database, never by
filtering in this app.

## What it does

| Screen | Who |
| --- | --- |
| Dealerships you can see, with their live versions and pending drafts | everyone |
| A dealership: script, price ladder and knowledge-base versions; people; recent changes (audit log) | everyone in it |
| New draft from the live version; edit; submit for testing; run the release gate; back to draft; delete | managers (and agency admins, the platform owner) |
| Side-by-side changes against the live version; approve (needs a passing gate); one-step rollback | approvers (and the platform owner) |
| Add a person in a role and get a one-time invite link; new link; remove | managers add managers and viewers; agency admins and the platform owner also approvers |

**Release gate**: `tavus-avatar/src/lib/release-gate.ts`. Sixteen scripted customer journeys
(cooperative, haggler, refuser, lowballer, asks for a human, asks questions, mumbles fragments, and
others) run through the real controller on the version in test, with the dealership's other live
versions. They're scored by the simulator's scorecard and its hard checks. It takes about a second
and needs no AI keys. The result is stored with its source (`scripted suite v1`) and the mode it ran
in. It checks the rules applied to the dealership's content; the AI-persona simulator
(`scripts/sim-batch.ts`) judges how natural the wording sounds and is not wired in yet.

## Sign-in

Better Auth, self-hosted in this app. Neon's managed auth has no two-factor yet; Neon suggests this
setup for that case.

- **Invite-only.** A password account is created only through a one-time invite link (7 days; only
  its hash is stored). There is no email verification, so open sign-up would let anyone claim an
  invited person's email first. Google and Microsoft sign-in, which verify the email, work for emails
  already added. Set `GOOGLE_*` / `MICROSOFT_*` to show them.
- **Two-factor (authenticator app) is required** for everyone who can edit or approve, before any
  page opens. Backup codes are given at set-up.
- **Passwords, sessions and two-factor secrets** are in the `auth` schema, reached only by
  `auth_login`. The portal's own login (`portal_login`) can't read them (checked on Neon:
  "permission denied for schema auth").
- **Invite links are shown once**, from a two-minute cookie, never in a URL.

## Environment (`.env.local`, git-ignored)

| Variable | |
| --- | --- |
| `PORTAL_DATABASE_URL` | `portal_login`: acts as `app_user` (the signed-in person) and the test gate |
| `AUTH_DATABASE_URL` | `auth_login`: Better Auth's tables, `search_path = auth` |
| `BETTER_AUTH_SECRET` | 32+ random bytes |
| `PORTAL_URL` | e.g. `https://portal.example.com` (used for invite links and cookies) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT_ID` | optional |

Do not set Max's AI switches (`MAX_SPEECH`, `MAX_UNDERSTANDING`, `MAX_MODE`) here: the release gate
must run on the rule-based controller.

## Set up a database (once per environment)

```bash
cd ../control-plane
npm run migrate                                                      # 005-007: sign-in lookup, auth schema, invites
npm run service-login -- portal       ../portal/.env.local PORTAL_DATABASE_URL
npm run service-login -- auth_service ../portal/.env.local AUTH_DATABASE_URL
cd ../portal && npm run auth:migrate                                 # Better Auth's tables, in the auth schema
cd ../control-plane && npm run invite -- owner@example.com /path/to/link.txt   # the first admin's way in
```

Use `ENV_FILE=<file>` in front of the control-plane commands to target a branch. Each command prints
the database host it is about to change.

## Run and test

```bash
npm install
npm run build && npm start          # http://localhost:3100
npm test                            # data layer: real Postgres (PGlite), real roles; 19 tests
```

End to end, in a real browser, against a **disposable Neon branch** (never production):

```bash
bash e2e/prepare-branch.sh portal-dev ../control-plane/.env.portal-dev /tmp/link.txt   # resets the branch
npm start &
node e2e/flow.mjs /tmp/link.txt http://localhost:3100      # E2E_BROWSER=firefox to use Firefox
```

The flow covers:

- invite, account and two-factor set-up, and pages closed until two-factor is on;
- a price change end to end: draft, edit, an invalid ladder refused, submit, the gate, the diff,
  approve, then rollback;
- adding a person, signing out, and signing back in with a wrong and then a right code;
- sign-up attempts without an invite, which must be refused.

## Not yet

- Script editing is a form per beat, plus JSON for fixed lines and recaps; the knowledge base is
  edited as JSON. It's usable, but not friendly.
- Not yet built: dashboards, the calls list and call inspector (call records aren't written by the
  worker yet), agency and dealership creation screens, usage and billing.
- The AI-persona simulator is not wired into the gate.
