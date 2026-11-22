import { resolve } from "path";

import { defineConfig } from "vitest/config";

// The brain imports the controller from tavus-avatar/src/lib. Next swaps "server-only" for a no-op;
// under Vitest it is aliased to the same stub tavus-avatar's own tests use.
export default defineConfig({
  resolve: {
    alias: {
      "server-only": resolve(import.meta.dirname, "../../tavus-avatar/test/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
