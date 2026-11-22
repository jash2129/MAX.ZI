# Build from the repository root (the brain imports tavus-avatar/src/lib):
#   docker build -f services/brain/Dockerfile -t max-brain .
FROM node:24-slim

WORKDIR /app
# The controller code the brain runs, unchanged. It reads no files at runtime (beats and knowledge base
# are JSON imports), so prompts/ is not needed.
COPY tavus-avatar/src/lib ./tavus-avatar/src/lib
# The controller's `import "server-only"` resolves upward from tavus-avatar/src/lib: give it /app/node_modules.
# (--conditions=react-server makes it a no-op.)
RUN npm install --prefix /app --no-save --no-audit --no-fund server-only@0.0.1

# Control-plane config loader (DATABASE_URL); its tests and PGlite are not needed at runtime
COPY services/control-plane/src/db.ts services/control-plane/src/live-config.ts ./services/control-plane/src/

COPY services/brain/package.json services/brain/package-lock.json ./services/brain/
RUN cd services/brain && npm ci --omit=dev --no-audit --no-fund
COPY services/brain/src ./services/brain/src
COPY services/brain/config ./services/brain/config

WORKDIR /app/services/brain
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
CMD ["npx", "tsx", "--conditions=react-server", "src/server.ts"]
