// server-tools.spec.mjs — end-to-end proof that a tool running on the SERVER reaches the model, streams
// while it runs, and cannot be run by a page that was never approved.
//
// Needs a real browser for the part that matters: the privileged fetch happens in the service worker, the
// grant is minted by the background loop's approval, and the frames cross SW → content → page. Every one of
// those is the thing under test, so a mocked version would test a mock.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

/** One bundle with one function, as `/api/v1/tools/` lists it. */
const BUNDLE = {
    id: "srv1", name: "Search", description: "Web search.",
    specs: [{ name: "search_web", description: "Search the web.", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }],
};

test("a server-side tool runs, streams, and its result reaches the model", async () => {
    const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 20 });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "k", apiFormat: "openai", model: "fake-model", debugMode: "overlay",
        });
        fake.setServerTools([BUNDLE]);
        fake.setServerToolScript({ frames: [
            { type: "output", text: "searching…\n", atMs: 5 },
            { type: "event", event: { type: "mcp:progress", progress: 1, total: 2 }, atMs: 30 },
            { type: "output", text: "found 3\n", atMs: 60 },
            { type: "result", result: { hits: 3 }, name: "search_web", durationMs: 940, queuedMs: 12 },
        ] });
        // The model calls the generated per-function tool, then answers from what came back.
        fake.setScript([
            { tool: "srv1__search_web", args: { q: "ollama" } },
            (req) => ({ content: `The tool said: ${JSON.stringify(req.messages.at(-1)?.content ?? "")}` }),
        ]);

        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        // approvalRouting "external" + the SW-only channel: approve without a human, the way the harness
        // approves every other gate.
        const run = page.evaluate(() => window.ml.agent("search for ollama", {
            serverTools: ["srv1"], maxSteps: 4, approvalRouting: "both",
        }));
        await ext.sw.evaluate(async () => {
            for (let i = 0; i < 100; i++) {
                const pending = globalThis.__mlApprovals?.list?.() || [];
                if (pending.length) { globalThis.__mlApprovals.resolve(pending[0].key, true); return; }
                await new Promise((r) => setTimeout(r, 100));
            }
            throw new Error("no approval gate appeared for the server tool");
        });
        const res = await run;

        expect(res.summary).toContain("hits");
        // The call reached the endpoint as {name, arguments} against the right bundle.
        const calls = fake.toolCalls();
        expect(calls.length).toBe(1);
        expect(calls[0].toolId).toBe("srv1");
        expect(calls[0].name).toBe("search_web");
        expect(calls[0].arguments).toEqual({ q: "ollama" });
        expect(calls[0].stream).toBe(true, "the loop streams, so it asks the server to");
    } finally {
        await ext.context.close(); await site.stop(); await fake.stop();
    }
});

test("a transport failure is NOT reported to the model as a tool that returned nothing", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "k", apiFormat: "openai", model: "fake-model", debugMode: "overlay",
        });
        fake.setServerTools([BUNDLE]);
        // Output, then the connection simply ends — no result frame.
        fake.setServerToolScript({ frames: [{ type: "output", text: "half a log", atMs: 0 }] });
        let toolResult = null;
        fake.setScript([
            { tool: "srv1__search_web", args: { q: "x" } },
            (req) => { toolResult = String(req.messages.at(-1)?.content ?? ""); return { content: "done" }; },
        ]);

        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        const run = page.evaluate(() => window.ml.agent("search", { serverTools: ["srv1"], maxSteps: 4, approvalRouting: "both" }));
        await ext.sw.evaluate(async () => {
            for (let i = 0; i < 100; i++) {
                const p = globalThis.__mlApprovals?.list?.() || [];
                if (p.length) { globalThis.__mlApprovals.resolve(p[0].key, true); return; }
                await new Promise((r) => setTimeout(r, 100));
            }
        });
        await run;

        // The model must be able to tell "it did not complete" from "it returned nothing", because it will
        // act very differently on the two and cannot distinguish them itself.
        expect(toolResult).toMatch(/transport failure|did not complete/i);
        expect(toolResult).not.toMatch(/^Error: null/);
    } finally {
        await ext.context.close(); await site.stop(); await fake.stop();
    }
});

test("a page that was never approved cannot run a server tool", async () => {
    // The escalation the choke point closes: the handler is reachable by any page through the relay, and
    // the fetch spends the user's API key on a caller-chosen tool.
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "k", apiFormat: "openai", model: "fake-model", debugMode: "off",
            pageApprovalWhitelist: "",
        });
        fake.setServerTools([BUNDLE]);
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        const r = await page.evaluate(() => window.ml.execServerTool("srv1", "search_web", { q: "x" }).catch((e) => String(e)));

        expect(String(r)).toMatch(/needs approval/);
        expect(fake.toolCalls().length).toBe(0, "refused BEFORE the privileged fetch, not after");
    } finally {
        await ext.context.close(); await site.stop(); await fake.stop();
    }
});
