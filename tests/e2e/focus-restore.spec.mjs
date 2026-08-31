// focus-restore.spec.mjs — the corner card borrows PAGE focus while an approval prompt is up (so Enter/Esc
// drive it) and must HAND IT BACK when the approval resolves. Without that, a HUD-driven run's next
// `type("@focus")` (and its precheck) reads the card (#ml-sb-card) instead of the field/canvas the run was
// working on — the "isn't a text field or canvas" wasted-retries bug. Only a real browser has cross-iframe
// focus + the real content-script shell, so this is an e2e; the agent is the deterministic fake-LLM.
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
        modelFilter: "", debugMode: "off",       // off-mode → the corner CARD hosts the approval (the focus-borrower)
        autoApproveReadonly: false,               // force the exec gate open so the card actually shows an approval
    });
});

test.afterAll(async () => {
    await ext?.close();
    await fake?.stop();
    await site?.stop();
});

const activeId = (page) => page.evaluate(() => document.activeElement && document.activeElement.id);

test("the card returns focus to the page element after an approval resolves", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);

    // A focusable page element the "run" is notionally working on — focus it, like a field/canvas mid-run.
    await page.evaluate(() => {
        const i = document.createElement("input");
        i.id = "field";
        document.body.appendChild(i);
        i.focus();
    });
    expect(await activeId(page)).toBe("field");

    // One gated action (a mutating exec — requiresApproval, never auto-approved here). It doesn't touch #field's
    // focus, so the ONLY thing that moves focus is the card borrowing it. approvalRouting:"both" keeps the UI
    // (so the card shows + grabs focus) while also listing the gate on the SW channel (so we can read hash/seq).
    fake.setScript([
        { tool: "exec", args: { js: "document.title = 'RAN'; 'ok'" } },
        { content: "Done." },
    ]);
    const runPromise = page.evaluate(() => window.ml.agent("set the title with exec", { env: false, approvalRouting: "both" }));

    // The card mounts + borrows focus when the approval appears → focus leaves #field for the card host.
    await expect.poll(() => activeId(page), { timeout: 15000 }).not.toBe("field");
    expect(await activeId(page)).toBe("ml-sb-card");   // the corner card host now holds focus

    // Resolve through the UI PATH (the card posts its decision to the shell) — NOT the SW channel, because the
    // focus-restore lives in the shell's approval handler. Post it from INSIDE the card iframe so the shell's
    // `e.source === frame.contentWindow` origin check passes (exactly what a human's Approve click does).
    const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
    expect(gate.tool).toBe("exec");
    const cardFrame = page.frames().find(f => f.url().includes("sidebar.html"));
    expect(cardFrame, "the card iframe is present").toBeTruthy();
    await cardFrame.evaluate(({ hash, seq }) => {
        window.parent.postMessage({ __mlSidebarApp: "approval", hash, seq, decision: true }, "*");
    }, { hash: gate.runId, seq: gate.seq });

    // THE ASSERTION: focus is handed back to #field, so the run's next @focus/type would target the page.
    await expect.poll(() => activeId(page), { timeout: 15000 }).toBe("field");

    await runPromise;   // the fake-LLM's second step answers "Done." — the run completes cleanly
});
