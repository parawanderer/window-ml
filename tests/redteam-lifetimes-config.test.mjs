// redteam-lifetimes-config.test.mjs — rule 4b slice D: two of the person's SETTINGS (`pythonIdleMinutes`,
// `detachedTaskMaxMin`) are now in the public config a page reads through `ml.config()`, and the system prompt states
// them (docs/spec/ASYNC_CALLS.md, PROMPT_BUDGET.md). The lane's rows (tests/agent-start.test.mjs) prove the figures are
// the ones the code enforces; these are the boundary rows, each measured against c9ab1f5e by mutating what it covers:
//   - an unapproved page learns NEITHER (the origin gate, not the handler): the answer is a refusal with no data;
//   - no message a page posts SETS either, over every type the router handles, and the one knob a page does have
//     (`SET_MODEL`) writes the model alone;
//   - the public subset gained EXACTLY those two keys, enumerated, so a third cannot ride along unnoticed;
//   - a worker's own config (the URL, the key, the filter, the roots) composes a prompt that states the two figures and
//     carries no secret — the clause is built from two numbers, never from the config object;
//     The answer a page gets is the public subset ITSELF, enumerated in the row: measured that GET_CONFIG is not run
//     through the registry scrub (a value equal to a registered secret crossed it), so what keeps a secret off that
//     answer is `publicConfig`'s fixed key list, which is the list the row asserts.
//
// Measured at c9ab1f5e: dropping the two keys from `publicConfig` reds rows 1 and 3; answering the page with the
// config whole reds row 1 with chatUrl, apiKey and modelFilter in the key list; letting a page's GET_CONFIG skip the
// origin gate reds row 1's unapproved half; making `lifetimeFigures` ignore the config reds row 4.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const { publicConfig, DEFAULT_CONFIG } = await import("../src/contract/contract-config.ts");
const { assembleRun } = await import("../src/agent/run-assembly.ts");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const T = { timeout: 60000 };
const SITE_URL = "https://site.example/page";
const SITE = { tab: { id: 7, url: SITE_URL } };
const IDLE = 17, CAP = 47;   // distinctive: neither may reach a page that was not allowed the site

/** The worker with the two settings set, and the site approved or not through the REAL gate (`siteGate`). */
function boot({ allowed, config = {}, local = {} }) {
    return loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai", debugMode: "off", pythonIdleMinutes: IDLE, detachedTaskMaxMin: CAP, ...config },
        local: { ml_site_always: allowed ? ["https://site.example"] : [], ...local },
        session: {},
        siteGate: true,
        openTabs: [{ id: 7, windowId: 3, active: true, url: SITE_URL, title: "Site" }],
        onFetch: async (call) => (call.url.endsWith("/api/models") ? jsonResponse({ data: [{ id: "m" }, { id: "m2" }] }) : jsonResponse({})),
    });
}

// --- the site's approval is what decides it, not the handler ---

test("RED TEAM: an unapproved page gets neither lifetime figure, and an approved one gets exactly the two", T, async () => {
    const no = boot({ allowed: false });
    const refused = await no.send({ type: "GET_CONFIG" }, SITE);
    assert.ok(refused?.error, `an unapproved page was answered with data: ${JSON.stringify(refused).slice(0, 300)}`);
    assert.equal(refused?.data, undefined, "a refused request still carried a config");
    const text = JSON.stringify(refused);
    assert.ok(!/pythonIdleMinutes|detachedTaskMaxMin/.test(text), `the refusal names the settings: ${text}`);

    const yes = boot({ allowed: true });
    const got = await yes.send({ type: "GET_CONFIG" }, SITE);
    assert.equal(got?.data?.pythonIdleMinutes, IDLE, `an approved page did not get the idle figure: ${JSON.stringify(got).slice(0, 300)}`);
    assert.equal(got?.data?.detachedTaskMaxMin, CAP, "an approved page did not get the detached cap");
    // And nothing else: the answer is `publicConfig(config, …)` itself, never the config. Enumerated, so a handler that
    // answered the config whole reds here with the URL or the key in hand.
    assert.deepEqual(Object.keys(got.data).sort(), Object.keys(publicConfig({ ...DEFAULT_CONFIG }, false)).sort(), `the page's answer is not the public subset: ${JSON.stringify(Object.keys(got.data))}`);
    for (const secret of ["chatUrl", "apiKey", "modelFilter", "shellRoots", "shellPath"]) assert.ok(!(secret in got.data), `GET_CONFIG handed the page ${secret}`);
});

// --- no page has a way to write either one ---

test("RED TEAM: no message a page posts sets either lifetime, and the model knob writes the model alone", T, async () => {
    const bg = boot({ allowed: true });
    const src = readFileSync(join(ROOT, "src", "background.ts"), "utf8");
    const routed = [...src.matchAll(/message\.type === "([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]);
    const relay = await import("../src/page-relay.ts");
    const types = [...new Set([...routed, ...relay.PAGE_STARTED_TYPES, ...relay.PAGE_RELAYED_EXTRA])];
    assert.ok(routed.length >= 60, `the router's own list is the battery, and it read ${routed.length} types`);
    const payload = { pythonIdleMinutes: 5, detachedTaskMaxMin: 5, config: { pythonIdleMinutes: 5, detachedTaskMaxMin: 5 }, settings: { pythonIdleMinutes: 5, detachedTaskMaxMin: 5 }, model: "m" };
    for (const type of types) {
        await Promise.race([
            bg.send({ type, payload }, SITE).catch(() => undefined),
            new Promise((res) => setTimeout(res, 300)),
        ]);
    }
    assert.equal(bg.stored.pythonIdleMinutes, IDLE, `a page's message changed pythonIdleMinutes: ${JSON.stringify(bg.stored)}`);
    assert.equal(bg.stored.detachedTaskMaxMin, CAP, "a page's message changed detachedTaskMaxMin");

    // The control: the one setting a page may change is the model, and the handler reads that field alone.
    const set = await bg.send({ type: "SET_MODEL", payload: { model: "m2", pythonIdleMinutes: 5, detachedTaskMaxMin: 5 } }, SITE);
    assert.equal(set?.data, "m2", `SET_MODEL did not take the model: ${JSON.stringify(set)}`);
    assert.equal(bg.stored.model, "m2", "the model was not written");
    assert.equal(bg.stored.pythonIdleMinutes, IDLE, "SET_MODEL carried pythonIdleMinutes into the settings");
    assert.equal(bg.stored.detachedTaskMaxMin, CAP, "SET_MODEL carried detachedTaskMaxMin into the settings");
});

// --- the public subset: exactly the two new keys, and none of the secrets ---

test("RED TEAM: the public config gained exactly the two lifetimes, and still names no secret", () => {
    const pub = publicConfig({ ...DEFAULT_CONFIG }, false);
    // The documented list (docs/API.md, `ml.config()`), enumerated: a key added later reds this until it is documented
    // here and there, which is the point — a page's view of the person's settings is a reviewed surface.
    assert.deepEqual(Object.keys(pub).sort(), [
        "apiFormat", "autoApprovePython", "autoApproveReadonly", "autoApproveSelfSource", "cdp", "commanderServerTools",
        "debugMode", "defaultModelVision", "detachedTaskMaxMin", "groundingEnabled", "groundingModel", "groundingRange",
        "labelMatch", "model", "ocrModel", "ocrNumCtx", "pageApprovalAllowed", "pierceClosedShadow", "pythonIdleMinutes",
        "selfIntrospection", "serverToolsOff", "utilityForceCpu", "utilityModel", "utilityNumCtx",
    ]);
    for (const secret of ["chatUrl", "apiKey", "modelFilter", "shellRoots", "shellPath", "shellSandbox"]) {
        assert.ok(!(secret in pub), `the public config carries ${secret}`);
    }
    assert.equal(typeof pub.pythonIdleMinutes, "number", "the idle figure crossed as something other than a number");
    assert.equal(typeof pub.detachedTaskMaxMin, "number", "the cap crossed as something other than a number");
});

// --- the prompt states the two figures and nothing else of the person's config ---

test("RED TEAM: a worker's own config composes a prompt with the two figures and none of its secrets", T, async () => {
    const FULL = {
        ...DEFAULT_CONFIG, autoApproveReadonly: true, pythonIdleMinutes: 3, detachedTaskMaxMin: 5,
        apiKey: "SK-LEAK-0001", chatUrl: "https://leak.example/v1/chat/completions", modelFilter: "FILTER-LEAK",
        shellRoots: ["/leak/root"], shellPath: ["/leak/bin"],
    };
    const ml = { config: async () => FULL, domTools: [], defineTool: (d) => d, _modelVision: async () => null, _resolveVisionModel: async () => null };
    const { systemPrompt } = await assembleRun(ml, "t", { tools: [], navigate: false });
    assert.match(systemPrompt, /after 3 min idle between turns/, "the person's idle figure is not in the prompt");
    assert.match(systemPrompt, /to its end or 5 min\./, "the person's cap is not in the prompt");
    for (const leak of ["SK-LEAK-0001", "leak.example", "FILTER-LEAK", "/leak/root", "/leak/bin"]) {
        assert.ok(!systemPrompt.includes(leak), `the prompt carried ${leak}`);
    }
    // The paragraph itself is built from the two numbers: no other setting's value is anywhere inside it.
    const at = systemPrompt.indexOf("HOW LONG THINGS LAST");
    assert.ok(at > 0, "the prompt has no lifetimes list to read");
    const para = systemPrompt.slice(at, systemPrompt.indexOf("\n\n", at + 10) === -1 ? undefined : systemPrompt.indexOf("\n\n", at + 10));
    assert.match(para, /HOW LONG THINGS LAST\. Python variables: this run/);
    assert.equal(para.match(/\d+(?:\.\d+)?/g).join(","), "3,5", `the paragraph carries figures beyond the two lifetimes: ${para}`);
});
