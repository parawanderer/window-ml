// ml-wire-harness.mjs — a worker-built run whose python_exec cell is a fake wire client, for the `ml` wire's tests.

// The built worker in node:vm (tests/helpers.js `loadBackground`). The run's model calls fetch_url (a capture to point
// at), then python_exec; the fake offscreen document receives the PY_RUN with its wire client and, while the cell
// "runs", plays `cell(wire, bg)`, whose calls go to the worker as the real offscreen document's would.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

export const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const tick = () => new Promise((r) => setTimeout(r, 0));
export const SITE = { id: 3, windowId: 1, active: true, url: "https://site.example/report", title: "Report" };
/** The browser's facts for a message from the extension's offscreen document. */
export const OFFSCREEN = Object.freeze({ id: "test", url: "chrome-extension://test/offscreen.html", origin: "chrome-extension://test" });
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off", autoApprovePython: true, cdp: true };
export const DATA_URL = "https://data.example/report.csv";

/**
 * Run a worker-built run whose python_exec cell plays `cell`.
 * @param cell `(wire, bg) => Promise<void>`: the cell's body, given the PY_RUN's `wire` and the worker
 * @param opts `body`: what fetch_url reads at `url`; `mode`: python_exec's mode; `siteGate: false` approves every page
 * @returns the worker, the PY_RUN messages and a `call(wire, call, args, sender?, run?)` helper
 */
export async function wireRun(cell, { body = "region,total\nnorth,12\nsouth,30\n", mode = "readonly", url = DATA_URL, siteGate = true } = {}) {
    let turns = 0;
    const pyRuns = [];
    const calls = [
        { name: "fetch_url", args: { url } },
        { name: "python_exec", args: { code: "print(await ml.config())", mode } },
    ];
    const bg = loadBackground({
        config, siteGate, openTabs: [SITE],
        onFetch: (c) => {
            if (c.url === url) return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
            if (/\/(api|v1)\/models$/.test(c.url)) return jsonResponse({ data: [{ id: "default-model" }, { id: "other-model" }] });
            if (!c.url.includes("/chat/completions")) return jsonResponse({});
            const n = turns++;
            return n < calls.length
                ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: calls[n].name, arguments: JSON.stringify(calls[n].args) } }] } }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onPyRun: async (msg) => {
            if (msg.type !== "PY_RUN") return { ok: true, prewarm: "started" };
            pyRuns.push(plain(msg));
            await cell(plain(msg.wire), bg);
            return { ok: true, value: "cell ran", stdout: "" };
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            return { result: "" };
        },
    });
    await bg.context.__mlStartUserRunForTest(SITE.id, { task: "read the report", surface: "hud" });
    for (let i = 0; i < 3000 && turns <= calls.length; i++) await tick();
    await new Promise((r) => setTimeout(r, 20));
    return { bg, pyRuns };
}

let seq = 0;
/**
 * Send one wire call to the worker, as a client would.
 * @param bg the worker
 * @param wire the PY_RUN's `{ client, run }`
 * @param call the member
 * @param args its arguments
 * @param over `sender` (default the offscreen document) and fields to put over the request
 * @returns the answer, as plain data
 */
export async function wireCall(bg, wire, call, args = [], { sender = OFFSCREEN, ...over } = {}) {
    const req = { type: "ML_CALL", client: wire?.client, run: wire?.run ?? null, seq: ++seq, call, args, ...over };
    return plain(await bg.send(req, { ...sender }));
}
