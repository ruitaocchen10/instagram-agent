import { defineConfig } from "vitest/config";

// Unit tests cover the pure/isolatable seams in lib/ only. They must not touch
// the network, the OS keychain, or a running Tauri host — the Tauri modules are
// mocked per-test (see lib/*.test.ts). No jsdom needed: nothing under test
// renders React or touches the DOM.
export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
});
