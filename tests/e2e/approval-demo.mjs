// A narrated, SLOW walkthrough of approval-over-IPC (idea #2) — NOT a test, a demo you run to WATCH the flow.
// It fires a REAL background agent run that blocks on a privileged `exec` gate, then drives the decision
// entirely through the service-worker-only `__mlApprovals` channel (the way an orchestrator would), printing
// the pending-gate descriptor it sees and each approve/reject it sends. The page main world is walled off
// from the channel — proving the security boundary. Deterministic: a scripted fake-LLM stands in for the
// model, so there's NO Ollama/API key needed.
//
// RUN IT (build first — the demo loads the built dist/ extension):
//   npm run build && node --import tsx tests/e2e/approval-demo.mjs
//   PACE=2500 HOLD=6000 node --import tsx tests/e2e/approval-demo.mjs    # slower (ms per line / per result)
// It opens a HEADFUL Chromium window — watch the browser TAB TITLE flip as each decision lands.
//
// WHAT YOU'LL SEE — three runs of the same gated action (an `exec` that renames the page):
//   1. APPROVE  → resolve(key, true)  → the exec runs, tab title becomes "AGENT-WAS-HERE".
//   2. REJECT   → resolve(key, false) → the exec is refused, tab title stays "UNTOUCHED".
//   3. POLICY   → a driver inspects gate.arguments and auto-approves a READ, rejects a WRITE.
// The automated (assertion) version of this flow is approval.spec.mjs; this file is the human-readable one.

import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

const PACE = +(process.env.PACE || 1600);   // pause between narrated lines (ms)
const HOLD = +(process.env.HOLD || 3500);   // pause on the result so you can see the tab title (ms)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Log a line, THEN pause a beat so it's readable as it happens.
const say = async (line, ms = PACE) => { console.log(line); await sleep(ms); };

async function waitForGate(sw) {
    for (let i = 0; i < 100; i++) {
        const gates = await sw.evaluate(() => globalThis.__mlApprovals.list());
        if (gates.length) return gates[0];
        await sleep(150);
    }
    throw new Error("no gate appeared");
}

const fake = await startFakeLlm({ model: "fake-model" });
const site = await startPageServer({});
// A NARRATED DEMO: it exists to be watched, so it keeps a real window even though the harness is now
// headless by default. (Everything else — the e2e suite, bench cells, observe without WATCH — runs
// headless, because a window that steals focus on every launch makes the machine unusable.)
const ext = await launchExtension({ headful: true });
await configureExtension(ext.sw, {
    chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
    modelFilter: "", debugMode: "off", autoApproveReadonly: false,
});

async function runOnce(label, decision) {
    await say(`\n━━━ ${label} ━━━`, 700);
    const page = await ext.context.newPage();
    await page.bringToFront();
    await page.goto(site.url + "/");
    await waitForMl(page);
    await page.evaluate(() => { document.title = "UNTOUCHED"; });
    await say(`→ tab title starts as "UNTOUCHED" (watch it)`);

    fake.setScript([
        { tool: "exec", args: { js: "document.title = 'AGENT-WAS-HERE'; 'title set'" } },
        { content: "Done." },
    ]);

    await say(`→ firing ml.agent({ approvalRouting: "both" }); it will BLOCK on the exec gate…`);
    const run = page.evaluate(() => window.ml.agent("Set the page title with exec.", { env: false, approvalRouting: "both" })).catch((e) => ({ error: String(e) }));

    const gate = await waitForGate(ext.sw);
    await say(`→ __mlApprovals.list() — seen ONLY from the service-worker realm:`);
    await say("  " + JSON.stringify(gate, null, 2).replace(/\n/g, "\n  "), PACE + 800);
    await say(`→ can the PAGE reach the channel? ${await page.evaluate(() => typeof globalThis.__mlApprovals)}  (undefined = walled off)`);

    await say(`→ __mlApprovals.resolve("${gate.key}", ${decision})   ${decision ? "← APPROVE" : "← REJECT"}`);
    const ok = await ext.sw.evaluate(({ key, d }) => globalThis.__mlApprovals.resolve(key, d), { key: gate.key, d: decision });
    await say(`  resolve() returned: ${ok}`);

    const result = await run;
    await say(`→ run finished. summary: ${JSON.stringify(result?.summary ?? result)}`);
    await say(`→ tab title is now: "${await page.title()}"   ${decision ? "(exec RAN → mutated)" : "(exec REFUSED → unchanged)"}`, HOLD);
    await page.close();
}

// A policy an orchestrator might apply: allow read-only exec, refuse anything that mutates. (A crude regex
// here for illustration — a real driver would reuse the extension's own read-only interpreter, evalReadonly,
// which IS the whitelist; see AGENTS.md "Read-only exec auto-approve".)
const looksLikeWrite = (js) =>
    /\b[\w.]+\s*=\s*[^=]/.test(js) ||
    /\.(setAttribute|remove|click|append|prepend|insertBefore|replaceChild)\b/.test(js);

async function runPolicy() {
    await say(`\n━━━ POLICY DRIVER: auto-approve reads, reject writes ━━━`, 700);
    const page = await ext.context.newPage();
    await page.bringToFront();
    await page.goto(site.url + "/");
    await waitForMl(page);
    await page.evaluate(() => { document.title = "UNTOUCHED"; });

    fake.setScript([
        { tool: "exec", args: { js: "document.querySelectorAll('a').length" } },   // read → allowed
        { tool: "exec", args: { js: "document.title = 'POLICY-BYPASSED'" } },       // write → refused
        { content: "Finished what I was allowed to." },
    ]);

    await say(`→ firing the run; the driver will decide EACH gate on its own…`);
    let done = false;
    const run = page.evaluate(() => window.ml.agent("Inspect the page, then rename it.", { env: false, approvalRouting: "external" }))
        .then((r) => { done = true; return r; }).catch((e) => { done = true; return { error: String(e) }; });

    const seen = new Set();
    while (!done) {
        const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
        if (gate && !seen.has(gate.key)) {
            seen.add(gate.key);
            const write = looksLikeWrite(gate.arguments.js);
            await say(`  gate: exec ${JSON.stringify(gate.arguments.js)}\n        → policy: ${write ? "WRITE ✗ reject" : "READ ✓ approve"}`);
            await ext.sw.evaluate(({ key, d }) => globalThis.__mlApprovals.resolve(key, d), { key: gate.key, d: !write });
        }
        await sleep(120);
    }
    const result = await run;
    await say(`→ run finished. summary: ${JSON.stringify(result?.summary ?? result)}`);
    await say(`→ tab title is now: "${await page.title()}"   (the WRITE was refused, so still UNTOUCHED)`, HOLD);
    await page.close();
}

await runOnce("APPROVE the exec", true);
await runOnce("REJECT the exec", false);
await runPolicy();

await say("\n✓ done — approve, reject, and a read-only policy, all driven purely over IPC, no UI touched.", 500);
await ext.close();
await fake.stop();
await site.stop();
