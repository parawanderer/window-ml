// Playwright config for the E2E suite (tests/e2e/*.spec.mjs) — the heavy, real-Chromium tests that load
// the built extension. Deliberately separate from the fast node:test suite (`npm test`), which never runs
// these. See CLAUDE.md "End-to-end tests". Run with `npm run test:e2e` (builds dist/ first).
import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./tests/e2e",
    testMatch: /.*\.spec\.mjs$/,
    timeout: 60_000,
    // Every test launches its own browser (a fresh temp profile) and its own fake servers on port 0, so
    // nothing is shared across tests and they run in parallel. The few specs that share one browser across
    // their tests (a beforeAll) pin themselves with `test.describe.configure({ mode: "default" })`. Serial
    // was 26 minutes in CI, most of it waiting on timers rather than CPU.
    fullyParallel: true,
    // A CI runner has 4 vCPUs: 3 workers leaves one for the server processes the tests start. Locally,
    // Playwright's default (half the cores).
    workers: process.env.CI ? 3 : undefined,
    // ONE RETRY IN CI, and none locally. Not a licence to ignore flakes — three of them were just fixed by
    // finding what each test was actually asking (a premise that depended on machine speed), and that is the
    // work when a test is wrong. This is for the other kind: ~240 tests that each drive a real browser on a
    // 4-vCPU runner, where a lost frame or a slow handshake is the runner, not the product.
    //
    // The distinction it buys is the one the gate needs: red now means BROKEN (it failed twice), where it
    // used to mean "something happened". And it does not hide anything — Playwright reports a retried pass as
    // FLAKY, by name, in the same summary, so a test that starts needing its retry says so out loud. Treat a
    // flaky line as a bug report, not as a pass.
    retries: process.env.CI ? 1 : 0,
    reporter: "list",
    use: { actionTimeout: 15_000 },
});
