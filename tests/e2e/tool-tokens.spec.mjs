// tool-tokens.spec.mjs — validates the tool-token answer pipeline END-TO-END in a REAL browser: the actual
// agent loop mints a token, the model CITES it (embed / image syntax), finalizeAnswer keeps that designation,
// and resolveOutputs hands the caller structured data (res.outputs) — the whole chain jsdom can't run (it feeds
// synthetic events rather than executing the real loop / finalize / resolve). Deterministic via the scriptable
// fake-LLM, whose final step reads the minted id out of the tool result and cites it — exactly what a real model
// does (there is NO auto-fallback: an uncited output is never surfaced).
import { test, expect } from "@playwright/test";
import { TOKEN_HEX_SRC } from "../../token-id.ts";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

let ext, fake, site;

test.beforeAll(async () => {
    fake = await startFakeLlm({ model: "fake-model" });
    site = await startPageServer({});
    ext = await launchExtension();
    await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", modelFilter: "", debugMode: "off" });
});

test.afterAll(async () => {
    await ext?.close();
    await fake?.stop();
    await site?.stop();
});

test("tool tokens e2e: a computed output flows through the REAL loop → res.answer (embed) + res.outputs (2D matrix)", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);

    // A tool that returns a table render, opted into a token; the final step is REACTIVE — it reads the minted
    // `@tool:<id>` out of the tool-result message and EMBEDS it (image syntax), exactly as a real model would.
    // finalizeAnswer keeps that designated citation and res.outputs carries the 2D data.
    fake.setScript([
        { tool: "compute", args: { token: true } },
        (reqBody) => {
            const toolMsg = [...(reqBody.messages || [])].reverse().find((m) => m.role === "tool");
            // Built from TOKEN_HEX_SRC, not hardcoded: this used to read `{6}` and silently kept working
            // as a WRONG test when the check character made ids 7 characters. It captured the first six,
            // the model cited a truncated id, nothing resolved, and `outputs` came back empty — a failure
            // that looks like the token pipeline is broken rather than the test.
            const id = String(toolMsg?.content || "").match(new RegExp(`@tool:(${TOKEN_HEX_SRC})`))?.[1];
            return { content: `The totals are ![the totals](@tool:${id}:out).` };
        },
    ]);
    const res = await page.evaluate(() => {
        const tool = window.ml.defineTool({
            name: "compute",
            description: "computes a table",
            parameters: { type: "object", properties: { token: { type: "boolean" } } },
            run: () => ({ content: "a table", render: { type: "table", columns: ["Rep", "Total"], rows: [["Gia", 850], ["Kim", 810]] } }),
        });
        return window.ml.agent("compute the totals", { tools: [tool], toolTokens: true });
    });

    // The model's reply EMBEDS the output inline with IMAGE syntax (`![…](@tool:<id>:out)`), not a link — and
    // because it's cited inline, finalizeAnswer dedups it out of the bottom `answer` block (no double render).
    expect(res.summary).toMatch(new RegExp(`!\\[[^\\]]*\\]\\(@tool:${TOKEN_HEX_SRC}:out\\)`));
    expect(res.answer || "").not.toMatch(/@tool:/);
    // And res.outputs hands the CALLER the structured 2D data — the headless-scripting payload.
    expect(res.outputs).toHaveLength(1);
    expect(res.outputs[0].kind).toBe("table");
    expect(res.outputs[0].columns).toEqual(["Rep", "Total"]);
    expect(res.outputs[0].rows).toEqual([["Gia", 850], ["Kim", 810]]);
});

test("tool tokens e2e: OFF (default) — no token param leaks to the model, and res.outputs is absent", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);

    fake.setScript([{ content: "done." }]);
    // Capture the tools/system prompt the model was actually sent (the fake records each request body).
    const res = await page.evaluate(() => {
        const tool = window.ml.defineTool({ name: "exec", description: "runs js", parameters: { type: "object", properties: { js: { type: "string" } } }, run: () => "x" });
        return window.ml.agent("do it", { tools: [tool] });   // toolTokens OFF (default)
    });
    expect(res.outputs).toBeUndefined();
    // The request the fake saw carries no `token` param on any tool, and no token clause in the system prompt.
    const body = fake.calls().at(-1);
    for (const t of body.tools || []) expect(t.function.parameters?.properties?.token).toBeFalsy();
    const sys = (body.messages.find((m) => m.role === "system") || {}).content || "";
    expect(sys).not.toMatch(/SHOWING TOOL OUTPUTS|@tool:/);
});
