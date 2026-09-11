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

// What you WATCH stream in must still be there once the step lands. A remote tool's frames and its returned
// value are different things — progress it produced as it worked, and what it answered with — and the panel
// was replacing one with the other, so the output vanished at exactly the moment the step finished. (The
// descriptor was also built with a `code:` field the `code` render does not have, so it drew an empty block
// and only the result survived.) This asserts BOTH halves are present afterwards.
test("a server tool's streamed output survives the step landing, beside its result", async () => {
    const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 20 });
    const site = await startPageServer({});
    const ext = await launchExtension();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "k", apiFormat: "openai", model: "fake-model", debugMode: "overlay",
        });
        fake.setServerTools([BUNDLE]);
        // Deliberately DIFFERENT text in the frames and in the result: if the panel showed only one of them,
        // a fixture where they matched would pass while the bug was still there.
        fake.setServerToolScript({ frames: [
            { type: "output", text: "PROGRESS-ONE\n", atMs: 5 },
            { type: "output", text: "PROGRESS-TWO\n", atMs: 40 },
            { type: "result", result: "FINAL-ANSWER", name: "search_web", durationMs: 900, queuedMs: 10 },
        ] });
        fake.setScript([
            { tool: "srv1__search_web", args: { q: "ollama" } },
            { content: "done" },
        ]);

        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.goto(site.url + "/");
        await waitForMl(page);
        const run = page.evaluate(() => window.ml.agent("search for ollama", {
            serverTools: ["srv1"], maxSteps: 4, approvalRouting: "both", stream: true,
        }));

        // Open the overlay and drop into the live session, so the step's rendered Out is on screen.
        await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });
        await page.evaluate(() => {
            const root = document.getElementById("ml-sb-root").shadowRoot;
            const panel = root.getElementById("ml-sb-host");
            panel.style.width = "700px";
            panel.classList.add("open");
            root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
        });
        const frame = await (async () => {
            for (let i = 0; i < 60; i++) {
                const f = page.frames().find((fr) => /sidebar\.html/.test(fr.url()));
                if (f) return f;
                await sleep(100);
            }
            throw new Error("sidebar iframe never appeared");
        })();
        for (let i = 0; i < 40; i++) {
            const row = frame.locator("button.row").first();
            if (await row.count()) { await row.click({ timeout: 2000 }).catch(() => {}); break; }
            await sleep(200);
        }

        await ext.sw.evaluate(async () => {
            for (let i = 0; i < 150; i++) {
                const pending = globalThis.__mlApprovals?.list?.() || [];
                if (pending.length) { globalThis.__mlApprovals.resolve(pending[0].key, true); return; }
                await new Promise((r) => setTimeout(r, 100));
            }
            throw new Error("no approval gate appeared for the server tool");
        });
        await run;

        // The finished step, expanded.
        const step = frame.locator(".astep", { hasText: "srv1__search_web" }).first();
        await expect.poll(() => step.count(), { timeout: 15000 }).toBeGreaterThan(0);
        if (!(await step.evaluate((e) => e.classList.contains("open")))) {
            await step.locator(".astep-head").click();
        }
        await expect.poll(async () => (await step.innerText()).includes("FINAL-ANSWER"), { timeout: 10000 }).toBe(true);

        const shown = await step.innerText();
        expect(shown, "the streamed frames are still there after the step landed").toContain("PROGRESS-ONE");
        expect(shown, "…all of them, not just the last").toContain("PROGRESS-TWO");
        expect(shown, "…beside what the tool actually returned").toContain("FINAL-ANSWER");
    } finally {
        await ext.context.close(); await site.stop(); await fake.stop();
    }
});
