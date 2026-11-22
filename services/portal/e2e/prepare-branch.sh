#!/usr/bin/env bash
# Resets a disposable Neon branch to production's state and prepares it for e2e/flow.mjs:
#   migrations, the portal's two logins (into services/portal/.env.local), Better Auth's tables, and a
#   one-time invite link for the seeded platform owner (written to the file given, never printed).
#
#   bash e2e/prepare-branch.sh <branch name> <control-plane env file for that branch> <invite link file>
#   bash e2e/prepare-branch.sh portal-dev .env.portal-dev /tmp/owner-invite.txt
#
# The env file holds the BRANCH's owner connection strings (neon connection-string <branch> ...).
set -euo pipefail

branch="${1:?branch name}"
envfile="${2:?control-plane env file for the branch}"
linkfile="${3:?file to write the invite link to}"
if [ "$branch" = "production" ] || [ "$branch" = "main" ]; then
  echo "refusing: $branch is not a disposable branch" >&2
  exit 1
fi

here="$(cd "$(dirname "$0")/.." && pwd)"
cp="$here/../control-plane"

echo "== resetting $branch to its parent"
(cd "$cp" && neon branches reset "$branch" --parent >/dev/null)

echo "== migrations, logins, auth tables, invite"
(cd "$cp" && ENV_FILE="$envfile" npm run --silent migrate)
(cd "$cp" && ENV_FILE="$envfile" npm run --silent service-login -- portal "$here/.env.local" PORTAL_DATABASE_URL)
(cd "$cp" && ENV_FILE="$envfile" npm run --silent service-login -- auth_service "$here/.env.local" AUTH_DATABASE_URL)
(cd "$here" && npm run --silent auth:migrate)
(cd "$cp" && ENV_FILE="$envfile" npm run --silent invite -- owner@example.com "$linkfile")
echo "== ready"
