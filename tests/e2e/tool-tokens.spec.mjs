// tool-tokens.spec.mjs — validates the tool-token answer pipeline END-TO-END in a REAL browser: the actual
// agent loop mints a token, finalizeAnswer auto-embeds the computed output (image syntax), and resolveOutputs
// hands the caller structured data (res.outputs) — the whole chain jsdom can't run (it feeds synthetic events
// rather than executing the real loop / finalize / resolve). Deterministic via the scriptable fake-LLM.
import { test, expect } from "@playwright/test";
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

    // A tool that returns a table render, opted into a token; the model then answers WITHOUT citing → the
    // auto-fallback must EMBED the output at the bottom (image syntax) and res.outputs must carry the 2D data.
    fake.setScript([
        { tool: "compute", args: { token: true } },
        { content: "The totals are computed." },
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

    // The answer EMBEDS the output with IMAGE syntax (`![…](@tool:<id>:out)`), not a link.
    expect(res.answer).toMatch(/!\[[^\]]*\]\(@tool:[0-9a-f]{6}:out\)/);
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
