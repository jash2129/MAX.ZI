# Build from the repository root (the portal imports the controller and the control plane's db code):
#   docker build -f services/portal/Dockerfile -t max-portal .
FROM node:24-slim

WORKDIR /app
# The controller (release gate) and the control plane's database helpers, as the portal imports them
COPY tavus-avatar/src/lib ./tavus-avatar/src/lib
COPY services/control-plane/src/db.ts ./services/control-plane/src/db.ts
# The controller's `import "server-only"` resolves upward from tavus-avatar/src/lib
RUN npm install --prefix /app --no-save --no-audit --no-fund server-only@0.0.1

COPY services/portal/package.json services/portal/package-lock.json ./services/portal/
RUN cd services/portal && npm ci --no-audit --no-fund
COPY services/portal ./services/portal

WORKDIR /app/services/portal
# Pages are rendered per request: the build needs no database. These placeholders only let modules load
# during the build; the real values come from the service's environment at runtime.
RUN PORTAL_DATABASE_URL=postgres://build-only@localhost/none AUTH_DATABASE_URL=postgres://build-only@localhost/none \
    BETTER_AUTH_SECRET=build-only-placeholder-not-used-at-runtime-0000 \
    npx next build --webpack && npm prune --omit=dev

ENV NODE_ENV=production PORT=3100
EXPOSE 3100
CMD ["sh", "-c", "npx next start -p ${PORT}"]
