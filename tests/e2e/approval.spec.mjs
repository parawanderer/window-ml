// approval.spec.mjs — end-to-end for idea #2: approval-over-IPC. A background-hosted run's privileged gate
// can be resolved from OUTSIDE the browser via the service-worker-only `__mlApprovals` channel — the same
// unforgeable gate a human clicks, opened by an automated driver instead. Proves the security boundary too:
// the page main world cannot see or resolve the gate (no chrome.runtime, different realm).
//
// The gated action is a MUTATING `exec` (sets document.title) — requiresApproval, and never auto-approved
// (autoApproveReadonly is off here + a mutation isn't in the read-only dialect anyway), so the gate always
// opens. The run is background-hosted because off-mode + a requiresApproval tool on a non-whitelisted origin
// routes through the SW (design A) — which is where the gate, and this channel, live.

import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

let ext, fake, site;

test.beforeAll(async () => {
    fake = await startFakeLlm({ model: "fake-model" });
    site = await startPageServer({});
    ext = await launchExtension();
    await configureExtension(ext.sw, {
        chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
        modelFilter: "", debugMode: "off",
        autoApproveReadonly: false,   // force the exec gate open (don't auto-approve a survey)
    });
});

test.afterAll(async () => {
    await ext?.close();
    await fake?.stop();
    await site?.stop();
});

// Wait until exactly one gate is pending on the SW-side channel, then return its descriptor.
async function waitForGate(sw) {
    await expect.poll(async () => (await sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 15000 }).toBe(1);
    const [gate] = await sw.evaluate(() => globalThis.__mlApprovals.list());
    return gate;
}

test("external APPROVE via __mlApprovals: no UI, the gate resolves and the tool then runs", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);

    fake.setScript([
        { tool: "exec", args: { js: "document.title = 'APPROVED-RAN'; 'title set'" } },
        { content: "Done." },
    ]);
    // Fire the run; it BLOCKS on the exec approval gate (background-hosted). approvalRouting:"both" opts the
    // gate into the external channel (UI still shows too). Don't await yet.
    const runPromise = page.evaluate(() => window.ml.agent("Set the page title to APPROVED-RAN using exec.", { env: false, approvalRouting: "both" }));

    const gate = await waitForGate(ext.sw);
    expect(gate.tool).toBe("exec");
    expect(gate.arguments.js).toContain("APPROVED-RAN");   // the descriptor carries WHAT is being approved
    expect(typeof gate.key).toBe("string");

    // SECURITY: the page main world cannot see or resolve the channel — it lives only in the SW realm.
    expect(await page.evaluate(() => typeof globalThis.__mlApprovals)).toBe("undefined");

    // Approve OUT OF BAND — no click, no SET_APPROVAL from any UI surface.
    const ok = await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), gate.key);
    expect(ok).toBe(true);

    await runPromise;                                   // the run finishes now the gate is resolved
    expect(await page.title()).toBe("APPROVED-RAN");    // the tool actually ran, AFTER the external approval
    expect(await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).toHaveLength(0);   // gate cleared
    await page.close();
});

test("external DENY via __mlApprovals: the tool does NOT run, and the run still completes", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    await page.evaluate(() => { document.title = "UNTOUCHED"; });

    fake.setScript([
        { tool: "exec", args: { js: "document.title = 'SHOULD-NOT-RUN'; 'x'" } },
        { content: "Understood — I did not change it." },
    ]);
    // approvalRouting:"external" ALSO suppresses the UI buttons — only the channel can resolve it.
    const runPromise = page.evaluate(() => window.ml.agent("Set the title.", { env: false, approvalRouting: "external" }));

    const gate = await waitForGate(ext.sw);
    expect(gate.routing).toBe("external");
    const ok = await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, false), gate.key);
    expect(ok).toBe(true);

    await runPromise;
    expect(await page.title()).toBe("UNTOUCHED");   // denied → the mutation never ran
    await page.close();
});

test("OPT-IN: a default 'ui' run's gate is NOT listed or resolvable by the channel", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    fake.setScript([
        { tool: "exec", args: { js: "document.title = 'UI-ONLY'; 'x'" } },
        { content: "done" },
    ]);
    const before = fake.calls().length;   // calls accumulate across tests → measure THIS run's
    // Default routing ("ui") — a human is meant to approve; an external driver must NOT be able to.
    page.evaluate(() => window.ml.agent("Set the title.", { env: false })).catch(() => {});   // fire-and-forget (stays gated; rejects on page.close — swallow it)
    // Wait until the run has actually reached the gate (its tool-call request hit the model), then assert
    // the channel can't see it — the gate exists internally, but only opted-in runs are exposed.
    await expect.poll(() => fake.calls().length - before, { timeout: 15000 }).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(500);   // let the gate open after the tool-call response
    expect(await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).toHaveLength(0);
    await page.close();   // abandons the still-gated run (harmless); afterAll tears the SW down
});

test("resolve() on an unknown/stale key is a harmless no-op (returns false)", async () => {
    expect(await ext.sw.evaluate(() => globalThis.__mlApprovals.resolve("nope:999", true))).toBe(false);
});
