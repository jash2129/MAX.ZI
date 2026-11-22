import { resolve } from "path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "server-only": resolve(import.meta.dirname, "../../tavus-avatar/test/server-only-stub.ts") },
  },
  test: { environment: "node", testTimeout: 60_000, hookTimeout: 60_000 },
});
