// The bench's single-run driver (tests/e2e/run-once.mjs), in the parts that need no browser: which `ml` factory a
// tools subset gets each factory-made tool from. A wrong pair once made a subset drop fetch_url with no error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FACTORY_TOOLS, declaredVision } from "../tests/e2e/run-once.mjs";
import * as factories from "../src/ml/ml-tool-factories.ts";

// --- tools a subset gets from a factory ---

test("each factory-made tool a subset may name comes from the factory that makes a tool of that name, exposed on ml under that member", () => {
    const injected = readFileSync(new URL("../src/injected.ts", import.meta.url), "utf8");
    assert.deepEqual(FACTORY_TOOLS.map(([n]) => n), ["fetch_url", "click", "type"]);
    for (const [name, member] of FACTORY_TOOLS) {
        assert.equal(typeof factories[member], "function", `src/ml/ml-tool-factories.ts exports ${member}`);
        assert.equal(factories[member].call({ defineTool: factories.defineTool }).name, name, `${member}() makes the tool ${name}`);
        assert.match(injected, new RegExp(`\\b${member}: ${member}\\b`), `ml.${member} is the factory (src/injected.ts)`);
    }
});

// --- whether a cloud driver sees images ---

test("declaredVision: a cloud driver sees unless it is on the text-only list", () => {
    for (const m of ["openrouter.minimax/minimax-m3", "litellm.google/gemini-flash-latest", "ui.minimax-m3"]) assert.equal(declaredVision(m, {}), "yes", m);
    for (const m of ["deepseek.deepseek-v4-pro", "deepseek.deepseek-flash", "ui.deepseek-v4-pro"]) assert.equal(declaredVision(m, {}), "no", m);
});

test("declaredVision: E2E_MODEL_VISION overrides the list either way, and anything else leaves it", () => {
    assert.equal(declaredVision("deepseek.deepseek-v4-pro", { E2E_MODEL_VISION: "yes" }), "yes");
    assert.equal(declaredVision("openrouter.minimax/minimax-m3", { E2E_MODEL_VISION: " NO " }), "no");
    assert.equal(declaredVision("openrouter.minimax/minimax-m3", { E2E_MODEL_VISION: "maybe" }), "yes");
});
