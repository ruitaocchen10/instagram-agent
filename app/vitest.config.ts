import { defineConfig } from "vitest/config";

// Unit tests cover the pure/isolatable seams in lib/ and the Node sidecar. They must not touch
// the network, the OS keychain, or a running Tauri host — the Tauri modules are
// mocked per-test (see lib/*.test.ts). No jsdom needed: nothing under test
// renders React or touches the DOM.
export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts", "sidecar/**/*.test.ts"],
    environment: "node",
  },
});
