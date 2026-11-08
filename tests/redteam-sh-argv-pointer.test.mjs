// redteam-sh-argv-pointer.test.mjs — SHELL.md's argv ruling (RULED 2026-10-28): an argv item that IS a pointer token
// (`@tool:` or `@file:`) is refused by the shell call itself as "a held value, not a path", because the token names a
// value window.ml holds and never a name on the host's disk. The boundary matters as much as the refusal: an item that
// merely CONTAINS a token (`./notes@file:9f3a.txt`, `--in=@file:x`) is the program's own text, and refusing it would
// break a real filename.
//
// Found by the red-team pass (session window-ml-redteam-e3) on 2026-11-08 and measured UNBUILT on main then:
// `ml.sh.run(["cat", "@file:3fa91c2"])` spawned `["cat","@file:3fa91c2"]` on the host, unflagged. This file is the
// finder's flip: the refusal row failed at `!argvSent.includes(token)` before `parseShRun` grew `heldValueRefusal`; it
// passes from src/shell/sh-call.ts in this branch on. It travels with the fix that answers it, on its own branch, so the
// row cannot be lost to a later rebase of the put rows it was first written beside.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fakeNativeHost } from "./fake-native-host.mjs";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const { IDBFactory } = require("fake-indexeddb");

const T = { timeout: 30000 };
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const SITE_URL = "https://site.example/page";
const CONFIG = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
/** ml.sh on, with one root: what a person sets to get a shell at all. */
const ON = { shellEnabled: true, shellRoots: ["/w/proj"] };

/** The tokens: one of each prefix, as a page-script or a model would spell them (`onerror@tool:cafe` is an id shape). */
const TOKENS = ["@file:3fa91c2", "@tool:ab12cd3"];

/** What an exec answered, as the model read it: the JSON the script returned, or its thrown message. */
function answer(result) {
    const v = /^value: (.*)$/m.exec(result ?? "")?.[1] ?? /^(\{.*\})$/m.exec(result ?? "")?.[1];
    if (!v) return { raw: String(result ?? "") };
    try { return JSON.parse(v); } catch { return { raw: String(result) }; }
}
/** The text a refusal carried, whichever field the wire used. */
const why = (a) => String(a.threw ?? a.error ?? a.refusal ?? a.message ?? a.raw ?? "");

/** Run one script as an exec of a worker-built run that may use `ml.sh`, and answer what the model was told. */
async function runShell({ host, script, ticks = 4000 } = {}) {
    let bg, release;
    const ready = new Promise((r) => (release = r));
    const steps = [];
    let n = 0;
    const worlds = new Map();
    const userScripts = {
        available: true,
        execute: async (inj) => {
            const ctx = worlds.get(inj.worldId) ?? vm.createContext({
                console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
                chrome: { runtime: { sendMessage: (m) => bg.emitUserScriptMessage(m, { tab: { id: 7, url: SITE_URL }, url: SITE_URL, origin: "https://site.example", frameId: 0, documentId: "doc-1" }) } },
            });
            worlds.set(inj.worldId, ctx);
            const r = vm.runInContext(inj.js[0].code, ctx);
            return r && typeof r.then === "function" ? JSON.parse(JSON.stringify(await r)) : r;
        },
    };
    bg = loadBackground({
        siteGate: true, indexedDB: new IDBFactory(), userScripts,
        ...(host ? { onNative: host.onNative } : {}),
        config: { ...CONFIG, ...ON },
        local: { ml_site_always: ["https://site.example"] },
        openTabs: [{ id: 7, url: SITE_URL, title: "Site" }],
        onFetch: async (call) => {
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            if (!call.body?.tools) return jsonResponse({ choices: [{ message: { content: "a page's own call" } }] });
            await ready;
            const step = steps[n++];
            if (!step) return jsonResponse({ choices: [{ message: { content: "done" } }] });
            return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) {
                void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            }
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish) return { result: "" };
            if (msg.payload.renderOnly || msg.payload.precheck || msg.payload.readonlyTry) return {};
            return { result: "value: RAN IN THE PAGE'S WORLD" };
        },
    });
    bg.commit?.(7, { documentId: "doc-1", url: SITE_URL });
    await bg.context.__mlStartUserRunForTest(7, { task: "run a program", surface: "hud", maxSteps: 8 }, {});
    steps.push({ name: "exec", args: { js: script, world: "isolated" } });
    release();
    for (let i = 0; i < ticks && n <= steps.length; i++) await flush(1);
    await flush(40);
    const last = bg.calls.filter((c) => c.url.includes("/chat/completions") && c.body?.tools).at(-1);
    const results = (last?.body?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
    // The loop ends either because the model was called again (the run finished its only step) or at the cap; a row that
    // cannot tell those apart passes on a stall, which is the trap the tick loop exists to avoid.
    return { results, bg, finished: n > steps.length };
}

/** What `ml.sh.run` was sent as the host saw it: every argv the fixture host was asked to spawn. */
const spawnArgvs = (host) => host.calls.filter((c) => c.call === "spawn").map((c) => c.args?.argv ?? null);

/** `ml.sh.run(argv)` as the model would write it, answering what it answered or threw. */
const run = (argv) => `(async () => { try { return JSON.stringify(await ml.sh.run(${JSON.stringify(argv)})); } catch (e) { return JSON.stringify({ threw: e.message, code: e.code }); } })()`;

// --- the refusal: a token IS a held value, never an argv item the host sees ---

test("RED TEAM: an `@file:` or `@tool:` token given as an argv item never reaches the host", T, async () => {
    for (const token of TOKENS) {
        const host = fakeNativeHost();
        const { results } = await runShell({ host, script: run(["cat", token]) });
        const a = answer(results[0]);
        const sent = JSON.stringify(spawnArgvs(host));
        assert.ok(!sent.includes(token), `${token}: the token reached the host as an argv item: ${sent.slice(0, 300)}`);
        assert.deepEqual(spawnArgvs(host), [], `${token}: a program was spawned for a refused argv: ${sent.slice(0, 300)}`);
        assert.ok(!a.ok, `${token}: the refused call was reported as run: ${results[0]?.slice(0, 300)}`);
        const text = why(a);
        assert.match(text, /held value/i, `${token}: the refusal does not say it is a held value: ${text.slice(0, 300)}`);
        assert.ok(text.includes(token), `${token}: the refusal does not quote the token it refused: ${text.slice(0, 300)}`);
    }
});

// --- the boundary: text that merely CONTAINS a token is the program's, and must keep working ---

test("CONTROL: an argv item that merely CONTAINS a token still reaches the host, unchanged", T, async () => {
    for (const item of ["./notes@file:9f3a.txt", "inbox/@tool:ab12cd3.txt"]) {
        const host = fakeNativeHost();
        const { results, finished } = await runShell({ host, script: run(["ls", item]) });
        assert.ok(finished, `${item}: the run never finished, so this row measured a stall: ${results[0]?.slice(0, 300)}`);
        const sent = spawnArgvs(host);
        assert.equal(sent.length, 1, `${item}: a file whose name contains a token was refused: ${results[0]?.slice(0, 300)}`);
        assert.ok(JSON.stringify(sent[0]).includes(item), `${item}: the item did not reach the host as itself: ${JSON.stringify(sent[0]).slice(0, 300)}`);
    }
});
