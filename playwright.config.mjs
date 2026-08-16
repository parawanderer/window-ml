// Playwright config for the E2E suite (tests/e2e/*.spec.mjs) — the heavy, real-Chromium tests that load
// the built extension. Deliberately separate from the fast node:test suite (`npm test`), which never runs
// these. See CLAUDE.md "End-to-end tests". Run with `npm run test:e2e` (builds dist/ first).
import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./tests/e2e",
    testMatch: /.*\.spec\.mjs$/,
    timeout: 60_000,
    fullyParallel: false,
    workers: 1,        // one shared extension + servers → serialize
    retries: 0,
    reporter: "list",
    use: { actionTimeout: 15_000 },
});
