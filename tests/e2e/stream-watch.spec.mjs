// WATCHING A STREAMED RUN FROM THE CHAT PAGE, across the ways a run can be started. A run streams two separate
// things and they travel by different routes: the MODEL's reply/thinking (`agent-stream`, fanned by whichever loop
// hosts the run) and a TOOL's output as it works (`ctx.stream` → an `agent-step` delta carrying `streamOutput`).
// Both reach a watching chat page only through the background's session index, so a surface that renders them
// locally proves nothing about this one — the Commander HUD showed a streamed reply while the chat page sat on a
// token count.
//
// The modes here are the HOSTING decisions a run is routed by (ml-agent-run.ts `bgSurface`), because that is what
// decides who emits the stream: an overlay/devtools run and an off-mode run with a gated tool are hosted in the
// BACKGROUND, and a run with nothing to gate stays in the PAGE, where `stream` is documented as ignored
// (contract-agent.ts). The last of those is asserted as the gap it is, so that closing it fails this file.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

/** The chat page, open in its own tab, with page errors failing the test. */
async function openChatPage(ext) {
    const page = await ext.context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`chrome-extension://${ext.extensionId}/chat.html`);
    await page.locator(".chat").waitFor();
    return { page, errors };
}

/** Open the run whose task text this is, from the chat page's session list. */
async function watch(chat, task) {
    const row = chat.locator(".chat-row", { hasText: task });
    await row.first().waitFor({ timeout: 20000 });
    await row.first().click();
    await chat.locator(".chat-main").waitFor();
}

/** A tool that is not gated and reports its work as it goes, so the tool-output stream has a producer we control. */
/**
 * A tool that is not gated, streams a line, and then HOLDS until the test releases it.
 *
 * It waited on a timer first, and that is the test being timed rather than the product: the live window was
 * 1.2 s, which a laptop catches and a contended CI runner does not, so two of these failed on CI having passed
 * every local run. Holding on a flag makes the window as long as the watcher needs and not one beat longer —
 * the test releases it the moment it has seen what it came for. The cap is a failsafe, so a test that never
 * releases fails instead of hanging the suite.
 */
const TICKER = `{
    name: "tick", description: "report a line, then wait to be released",
    parameters: { type: "object", properties: {} },
    run: async (args, ctx) => {
        ctx.stream && ctx.stream("one\\n");
        for (let i = 0; i < 300 && !window.__mlReleaseTick; i++) await new Promise(r => setTimeout(r, 50));
        ctx.stream && ctx.stream("two\\nthree\\n");
        return "one\\ntwo\\nthree";
    },
}`;

/** Let the held tool finish, once the live output has been seen. */
const releaseTick = (site) => site.evaluate(() => { window.__mlReleaseTick = true; });

/**
 * Start a run on an ordinary page and DO NOT await it: the point is to look at it while it is still going.
 * `opts` is source text, so a tool's `run` can cross into the page.
 */
async function startRun(site, task, opts) {
    await site.evaluate(([t, o]) => {
        window.__run = window.ml.agent(t, eval(`(${o})`));
        window.__run.catch(() => {});
    }, [task, opts]);
}

const SLOW_ANSWER = "this answer arrives word by word and is long enough that a watcher sees it part way through";

for (const mode of ["overlay", "devtools", "off"]) {
    test(`a background-hosted run (${mode} mode) streams its reply and its tool's output to a watching chat page`, async () => {
        // A delay per word, so "part way through" is a real state and not a race we happen to win.
        const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 40 });
        const site0 = await startPageServer({});
        const ext = await launchExtension();
        try {
            await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: mode });
            fake.setScript([{ tool: "tick", args: {} }, { content: SLOW_ANSWER }]);
            const { page: chat, errors } = await openChatPage(ext);
            const site = await ext.context.newPage();
            await site.goto(site0.url + "/");
            await waitForMl(site);

            const task = `watch me stream in ${mode}`;
            // `extraTools` keeps the gated DOM toolset, which is what routes an OFF-mode run to the background.
            await startRun(site, task, `{ stream: true, maxSteps: 4, extraTools: [${TICKER}] }`);
            await watch(chat, task);

            // THE TOOL'S OUTPUT, while the tool is still running. The step is collapsed, so assert on the data
            // the row carries rather than on text inside a body nobody has opened.
            await expect.poll(async () => await chat.locator(".astep.tool.pending").count(), { timeout: 20000 }).toBeGreaterThan(0);
            await expect.poll(async () => await chat.evaluate(() => {
                const n = document.querySelector(".astep.tool.pending");
                return n ? n.textContent : "";
            }), { timeout: 20000, message: "the tool's live output reaches the watching page" }).toMatch(/one/);
            await releaseTick(site);   // seen it — let the tool finish so the run can reach its answer

            // THE MODEL'S REPLY, mid-generation: the streaming bubble with its live pulse, carrying a PREFIX of
            // the answer and not yet the whole of it.
            const live = chat.locator(".msg.asst.streaming");
            await expect(live, "a streaming reply bubble is drawn while the model generates").toBeVisible({ timeout: 20000 });
            // NOT the live pulse: the reading view hides it while text is arriving, because the words appearing
            // are the liveness signal and a lone dot beside them is the same thing said twice (chat.css).
            await expect(live).toContainText("this answer arrives", { timeout: 20000 });

            // And it settles into the finished reply, with the streaming bubble gone.
            await expect(chat.locator(".chat-main")).toContainText(SLOW_ANSWER, { timeout: 30000 });
            await expect(chat.locator(".msg.asst.streaming")).toHaveCount(0);
            expect(errors, "no page errors").toEqual([]);
        } finally {
            await ext.context.close();
            await site0.stop();
            await fake.stop();
        }
    });
}

test("a PAGE-hosted run streams its tool's output but not the model's reply — the documented gap, asserted so closing it is noticed", async () => {
    const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 40 });
    const site0 = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        fake.setScript([{ tool: "tick", args: {} }, { content: SLOW_ANSWER }]);
        const { page: chat, errors } = await openChatPage(ext);
        const site = await ext.context.newPage();
        await site.goto(site0.url + "/");
        await waitForMl(site);

        const task = "watch me stay in the page";
        // `tools` REPLACES the DOM toolset, so nothing in this run needs a gate: off mode then keeps the loop in
        // the page (ml-agent-run.ts `bgSurface`), which is the path that ignores `stream` for the model call.
        await startRun(site, task, `{ stream: true, maxSteps: 4, tools: [${TICKER}] }`);
        await watch(chat, task);

        // The tool's output DOES stream: `ctx.stream` is the shared loop's, and the page's own events reach the
        // index through the content shell.
        await expect.poll(async () => await chat.evaluate(() => {
            const n = document.querySelector(".astep.tool.pending");
            return n ? n.textContent : "";
        }), { timeout: 20000, message: "a page-hosted run's tool output still streams" }).toMatch(/one/);
        await releaseTick(site);

        // The model's reply does not: no `agent-stream` is ever emitted, so the answer lands whole at the end.
        await expect(chat.locator(".chat-main")).toContainText(SLOW_ANSWER, { timeout: 30000 });
        expect(await chat.locator(".msg.asst.streaming").count(), "page-hosted: no live reply bubble ever appeared").toBe(0);
        expect(errors, "no page errors").toEqual([]);
    } finally {
        await ext.context.close();
        await site0.stop();
        await fake.stop();
    }
});
