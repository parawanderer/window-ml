// live-call.spec.mjs — a tool call the model is still WRITING is drawn in the sidebar as it arrives: the code grows in
// the turn, with the caret where it grows, and the step replaces it once the call lands. The fragments are read in the
// service worker and travel as `agent-stream` events to the panel, so only a real browser runs the whole path. Two
// wires fragment a call: OpenAI-shaped SSE always, and Ollama native only from a patched server's `tool_call_deltas`.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A read-only survey long enough to arrive over seconds: forty comment lines and one expression, so it runs unasked.
const JS = [...Array.from({ length: 40 }, (_, i) => `// survey line ${i + 1} of the page title`), "document.title"].join("\n");

/** Run `pageInfo` then a slowly written `exec` on `wire`; sample the sidebar's live call while it is written. */
async function watchLiveCall({ apiFormat, path, deltas }) {
    const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 150 });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.origin + path, apiKey: "", apiFormat, model: "fake-model", debugMode: "overlay" });
        fake.setScript([
            { tool: "pageInfo", args: {} },
            { tool: "exec", args: { js: JS }, ...(deltas ? { deltas: true } : {}), emit: Array.from({ length: 40 }, () => ({ kind: "call" })) },
            { content: "Done." },
        ]);
        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.goto(site.url + "/");
        await waitForMl(page);
        const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, site.url);
        await ext.sw.evaluate((id) => globalThis.__mlStartUserRunForTest(id, { task: "survey the title", stream: true, hud: "quiet", surface: "overlay" }), tabId);
        const frame = await openRunInSidebar(page, { task: "survey the title" });

        // Sample the live call until the run is over: what it showed, in order.
        const samples = [];
        for (let i = 0; i < 200 && fake.calls().length < 3; i++) {
            const s = await frame.evaluate(() => {
                const lc = document.querySelector(".live-call");
                return lc && { name: lc.querySelector(".tool-name")?.textContent, code: lc.querySelector(".live-call-code")?.textContent ?? null,
                               writing: !!lc.querySelector(".live-call-code.writing") };
            }).catch(() => null);
            if (s) samples.push(s);
            await sleep(100);
        }
        expect(fake.calls().length, "the run used its whole script").toBeGreaterThanOrEqual(3);
        // The run is over once no step is pending (AGENTS.md: wait for the RUN, not for something a collapsed step hides).
        await expect.poll(() => frame.locator(".astep.tool.pending").count(), { timeout: 15000 }).toBe(0);
        const after = await frame.locator(".live-call").count();
        return { samples, after, apiFormat };
    } finally {
        await ext.close();
        fake.stop?.();
        site.stop?.();
    }
}

/** What every wire must show: the exec's source growing in place, decoded, caret on, and gone once the step lands. */
function expectGrew({ samples, after }) {
    const code = samples.filter((s) => s.code);
    expect(code.length, `the call was drawn while written: ${JSON.stringify(samples.slice(0, 3))}`).toBeGreaterThan(1);
    expect(code.every((s) => s.name === "exec"), "named from the first fragment").toBe(true);
    // Each sample is a prefix of the source (no JSON quoting, no `\n` escapes), and they grow.
    for (const s of code) expect(JS.replace(/\n/g, "").startsWith(s.code.replace(/\n/g, "")), `not a prefix: ${s.code.slice(-60)}`).toBe(true);
    const lens = [...new Set(code.map((s) => s.code.length))];
    expect(lens.length, "seen at more than one length").toBeGreaterThan(1);
    expect(lens, "growing, never shrinking").toEqual([...lens].sort((a, b) => a - b));
    expect(code.some((s) => s.writing && s.code.length < JS.length), "the caret is on while the source arrives").toBe(true);
    expect(after, "the step replaced the live call").toBe(0);
}

// --- the call being written, on each wire that fragments it ---

test("OpenAI fragments: the exec's source grows in the sidebar with a caret, and the step replaces it", async () => {
    test.setTimeout(90_000);
    expectGrew(await watchLiveCall({ apiFormat: "openai", path: "/api/chat/completions" }));
});

test("Ollama native with tool_call_deltas (patched server): the same, and the whole call is the one that runs", async () => {
    test.setTimeout(90_000);
    expectGrew(await watchLiveCall({ apiFormat: "ollama", path: "/ollama/api/chat", deltas: true }));
});
