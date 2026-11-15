// chat-code-morph.spec.mjs — the calm chat's reformat of a streamed script, over the REAL runtime: a page's `ml.agent` run
// held at its exec gate, watched from chat.html. The morph (code-morph.ts) draws flying characters only when the live block
// was watched being written; a provider that sends the call as ONE block however the prose streams, and a run that does
// not stream at all, show the step with nothing to fly from, and an animation there is noise. The gallery flow
// (tests/gallery-flows/CodeMorphDemo.mjs) checks the motion frame by frame; this checks WHEN it happens.

import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

// Packed on purpose (one line, no indentation) and mutating, so the exec gate always opens.
const PACKED = `let o=[];${Array.from({ length: 14 }, (_, i) => `o.push({k:${i},v:[${i},${i + 1}]});`).join("")}document.title="held";o.length`;

/**
 * Run one agent that writes PACKED, held at its approval card, with the chat page watching, and say whether characters flew.
 * `call` is how the fake model delivers the call; `stream` is the run's own option.
 */
async function flew({ call, stream }) {
    const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 200 });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off", autoApproveReadonly: false });
        fake.setScript([{ tool: "exec", args: { js: PACKED }, ...(call === "fragments" ? { emit: Array.from({ length: 14 }, () => ({ kind: "call" })) } : call === "two" ? { emit: [{ kind: "call" }, { kind: "call" }] } : {}) }, { content: "done" }]);
        const chat = await ext.context.newPage();
        const errors = [];
        chat.on("pageerror", (e) => errors.push(e.message));
        await chat.goto(`chrome-extension://${ext.extensionId}/chat.html`);
        await chat.locator(".chat").waitFor();
        // The calm view is the one that morphs, and the page opens in it.
        await expect(chat.locator("html[data-calm]")).toHaveCount(1);
        // Record whether the flying layer EVER exists: it lives for a quarter of a second, too short to poll for.
        await chat.evaluate(() => {
            window.__flew = 0;
            new MutationObserver(() => { if (document.querySelector(".code-morph")) window.__flew++; }).observe(document.body, { childList: true, subtree: true });
        });
        const site1 = await ext.context.newPage();
        await site1.goto(site.url + "/");
        await waitForMl(site1);
        void site1.evaluate((s) => window.ml.agent("rename the page", { env: false, approvalRouting: "both", stream: s }), stream).catch(() => {});
        await chat.locator(".chat-row", { hasText: "rename the page" }).click();
        await expect(chat.locator(".astep-approve")).toBeVisible({ timeout: 30_000 });
        await chat.waitForTimeout(600);   // past the beat: a layer that is going to draw has drawn
        expect(errors).toEqual([]);
        return await chat.evaluate(() => window.__flew > 0);
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
}

test.describe.configure({ mode: "default" });

test("a call the model wrote in fragments, watched live, flies into its reformatted layout", async () => {
    test.setTimeout(120_000);
    expect(await flew({ call: "fragments", stream: true }), "the characters flew").toBe(true);
});

test("a call a provider sends as ONE block never flies, though the run streams", async () => {
    test.setTimeout(120_000);
    expect(await flew({ call: "whole", stream: true }), "nothing was watched being written").toBe(false);
});

test("a call written in two quick pieces stands too briefly to be watched, so it never flies", async () => {
    test.setTimeout(120_000);
    expect(await flew({ call: "two", stream: true }), "a live block that grew twice").toBe(false);
});

test("a run that does not stream never flies", async () => {
    test.setTimeout(120_000);
    expect(await flew({ call: "fragments", stream: false }), "there is no live block at all").toBe(false);
});
