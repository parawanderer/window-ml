// ml-sh-redteam.test.mjs — the red-team pass for `ml.sh` and the native port behind it (sw-shell.ts, sw-shell-call.ts,
// the isolated exec's `sh` op): what a hostile page must NOT get from it, each property a test with a positive control in
// the same test. The page shares the main world, posts any window message, sends any page-relayed type, knows every run
// id, and is handed the call's nonce and the ask's id anyway, so what stands is what the browser vouches for.
//
// Two harnesses: the BUILT worker in node:vm (loadBackground, with tests/fake-native-host.mjs on the native port) for
// everything a message or a world can reach, and sw-shell-call.ts imported directly for the races and the cross-run
// reads a vm run cannot line up (the module's own state, driven with a ShCallContext the worker would build).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runOn, world, fromTab, SITE_URL } from "./isolated-harness.mjs";
import { fakeNativeHost } from "./fake-native-host.mjs";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const { PAGE_STARTED_TYPES } = await import("../src/page-relay.ts");

const T = { timeout: 120000 };
const ON = { shellEnabled: true, shellRoots: ["/w/proj"] };
const NO_FETCH = { fetches: [] };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** What a send got back, or "NO ANSWER" if nothing answered within `ms`. */
const within = (p, ms = 120) => Promise.race([Promise.resolve(p).then((r) => (r === undefined ? "NO ANSWER" : JSON.parse(JSON.stringify(r)))), tick(ms).then(() => "NO ANSWER")]);
const nonceOf = (code) => /__mlIsoStarted = "([0-9a-f]+)"/.exec(code)?.[1];
/** The host calls that start, resolve or read something (hello/configure open a session; cancel/discard/release end one). */
const reaching = (host) => host.calls.filter((c) => ["hello", "configure", "spawn", "start", "read"].includes(c.call)).map((c) => c.call);
const shScript = (argv, opts) => () => `(async () => { try { return JSON.stringify(await ml.sh.run(${JSON.stringify(argv)}${opts ? `, ${JSON.stringify(opts)}` : ""})); } catch (e) { return JSON.stringify({ threw: e.message, code: e.code }); } })()`;
function valueOf(result) {
    const m = /^value: (.*)$/m.exec(result) ?? /^(\{.*\})$/m.exec(result);
    assert.ok(m, `no value in: ${result}`);
    return JSON.parse(m[1]);
}
/** Every message type the router names (background.ts), plus the user-script and isolated ones handled elsewhere. */
const ROUTER_TYPES = [...new Set([...readFileSync(new URL("../src/background.ts", import.meta.url), "utf8").matchAll(/message\.type === "([A-Z_]+)"/g)].map((m) => m[1]))];
const ALL_TYPES = [...new Set([...ROUTER_TYPES, ...PAGE_STARTED_TYPES, "ISO_EXEC_ASK", "ISO_EXEC_STREAM", "FETCH_IMAGE_B64"])];
/** Types a content-script shell legitimately sends for the person (Stop, start a run, act on one): not a page's reach. */
const SHELL_ONLY = new Set(["CANCEL_RUN", "CANCEL_ALL_RUNS", "USER_START_RUN", "USER_RUN_ACTION"]);

/**
 * A fake host whose traffic a test can hold: `hold.start` delays the reply to `start`; `hold.done` holds each `done`
 * event until `release()`; a `cancel` is answered and releases the held `done` as cancelled. `rewriteError(msg)` rewrites
 * an error's message.
 */
function heldHost(opts = {}, { holdStart = false, holdDone = false, rewriteError } = {}) {
    const host = fakeNativeHost(opts);
    const held = { start: [], done: [] };
    let end;
    const out = (m) => {
        if (m?.error && rewriteError) m = { ...m, error: { ...m.error, message: rewriteError(m.error.message) } };
        if (holdStart && m?.value?.pid) { held.start.push(m); host.onStartHeld?.(); return; }
        if (holdDone && m?.event === "done") { held.done.push(m); host.onDoneHeld?.(); return; }
        end.send(m);
    };
    host.onNative = ((inner) => (name, e) => {
        end = e;
        const recv = inner(name, { send: out, close: e.close });
        return recv && ((m) => {
            if (m.call === "cancel") {
                host.calls.push(m);
                end.send({ seq: m.seq, value: {} });
                for (const d of held.done.splice(0)) end.send({ ...d, cancelled: true, ok: false, code: null, signal: "SIGTERM" });
                return;
            }
            recv(m);
        });
    })(host.onNative);
    host.releaseStart = () => { for (const m of held.start.splice(0)) end.send(m); };
    host.releaseDone = () => { for (const m of held.done.splice(0)) end.send(m); };
    return host;
}

// --- a vm harness for one worker-built run on tab 7, whose tool calls are given as {name, args} ---

/**
 * Like isolated-harness.mjs `runOn`, but each step is a full tool call (so an exec can carry `world`), isolation and the
 * page's approval are chosen, and every exec the PAGE is sent is recorded (`pageExecs`): the main world's oracle.
 */
async function drive(steps, { userScripts = true, cdp = false, approved = true, onNative, configExtra = {}, onStep, onExecute, ticks = 4000 } = {}) {
    let n = 0, bg;
    const pageExecs = [];
    const worlds = new Map();
    const us = !userScripts ? undefined : {
        available: true,
        execute: async (inj) => {
            await onExecute?.(bg, inj);
            const ctx = worlds.get(inj.worldId) ?? world({ chrome: { runtime: { sendMessage: (m) => bg.emitUserScriptMessage(m, { tab: { id: 7, url: SITE_URL }, url: SITE_URL, origin: "https://site.example", frameId: 0, documentId: "doc-1" }) } } });
            worlds.set(inj.worldId, ctx);
            const r = vm.runInContext(inj.js[0].code, ctx);
            return r && typeof r.then === "function" ? JSON.parse(JSON.stringify(await r)) : r;
        },
    };
    bg = loadBackground({
        siteGate: true, userScripts: us, ...(onNative ? { onNative } : {}),
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off", autoApproveReadonly: false, cdp, ...configExtra },
        local: approved ? { ml_site_always: ["https://site.example"] } : {},
        openTabs: [{ id: 7, url: SITE_URL, title: "Site" }],
        onFetch: async (call) => {
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            // A page's own model call (an approved page may spend tokens) is not the run's: answered, not counted.
            if (!call.body?.tools) return jsonResponse({ choices: [{ message: { content: "a page's call" } }] });
            const step = steps[n++];
            if (!step) return jsonResponse({ choices: [{ message: { content: "done" } }] });
            return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.kind === "agent-step") await onStep?.(bg, msg.event);
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish) return { result: "" };
            if (msg.payload.renderOnly || msg.payload.precheck || msg.payload.readonlyTry) return {};
            if (msg.payload.name === "exec") { pageExecs.push(msg.payload.args?.js); return { result: "value: RAN IN THE PAGE'S WORLD" }; }
            return { result: "" };
        },
    });
    bg.commit?.(7, { documentId: "doc-1", url: SITE_URL });
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 80 });
    for (let i = 0; i < ticks && n <= steps.length; i++) await tick();
    for (let i = 0; i < 40; i++) await tick();
    const last = bg.calls.filter((c) => c.url.includes("/chat/completions") && c.body?.tools).at(-1);
    const results = last.body.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    return { results, pageExecs, bg, hash };
}

// --- 1. no message a page can start opens the port, spawns, starts or reads on the host ---

test("no message type from any tab sender, with ml.sh on and a call waiting on the person, reaches the process host or answers the call's ask", T, async () => {
    const host = fakeNativeHost();
    let fired = false, before, connects, after, asked, failure;
    const runTab = { ...fromTab, documentId: "doc-1" };
    const otherTab = { tab: { id: 9, url: "https://site.example/other" }, url: "https://site.example/other", origin: "https://site.example", frameId: 0, documentId: "doc-9" };
    const evil = { tab: { id: 9, url: "https://evil.example/" }, url: "https://evil.example/", origin: "https://evil.example", frameId: 0, documentId: "doc-e" };
    const { results, bg } = await drive([{ name: "exec", args: { js: shScript(["python3", "x.py"])() } }], {
        onNative: host.onNative, configExtra: ON, ticks: 100000,
        onStep: async (bg, ev) => {
            const a = (ev.asks ?? []).find((x) => x.state === "pending");
            if (!a || fired) return;
            fired = true;
            asked = a;
            try { await barrage(bg, ev, a); } catch (e) { failure = e; }
        },
    });
    async function barrage(bg, ev, a) {
        before = reaching(host).length;
        connects = bg.nativeConnects.length;
        const req = { op: "sh", call: "run", args: [["ls"]] };
        const payload = { runId: ev.id, hash: ev.id, seq: ev.seq, ask: a.id, decision: true, persist: true, refresh: true, nonce: "0".repeat(32), req,
            op: "add", effect: "allow", consumer: "sh", source: "() => true", label: "page", js: 'ml.sh.run(["ls"])', name: "exec", args: { js: 'ml.sh.run(["ls"])' },
            messages: [{ role: "user", content: "hi" }], url: "https://example.com/" };
        const msg = (type) => ({ type, payload, runId: ev.id, seq: ev.seq, ask: a.id, nonce: "0".repeat(32), req, requestId: "r1", client: "x", call: "sh.run", args: [["ls"]] });
        // The run's own tab: only what its page can make the content script send (HANDLE_MAP), and the channel's type.
        for (const type of [...PAGE_STARTED_TYPES, "ISO_EXEC_ASK", "ISO_EXEC_STREAM"]) await within(bg.send(msg(type), runTab));
        // Another tab's content script, approved or not: every type the router knows, the shell's own excepted.
        for (const sender of [otherTab, evil]) for (const type of ALL_TYPES) if (!SHELL_ONLY.has(type)) await within(bg.send(msg(type), sender));
        for (const sender of [runTab, otherTab]) await within(bg.emitUserScriptMessage(msg("ISO_EXEC_ASK"), sender));
        await tick(50);
        after = reaching(host).length;
        assert.equal(bg.nativeConnects.length, connects, "no message opened another native port");
        // Then the person answers, through the surface (an extension sender).
        void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, ask: a.id, decision: true } });
    }
    if (failure) throw failure;
    assert.ok(fired && asked, "positive control: the call asked the person");
    assert.ok(ALL_TYPES.length > 60, `enumerated ${ALL_TYPES.length} types`);
    assert.equal(after, before, `nothing the barrage sent reached the host: ${JSON.stringify(reaching(host).slice(before))}`);
    const r = valueOf(results[0]);
    assert.deepEqual([r.ok, r.approvedBy], [true, "person"], `positive control: the person's own answer started it, no forged one or policy did: ${results[0].slice(0, 300)}`);
    assert.equal(host.calls.filter((c) => c.call === "start").length, 1, "one start, the call's");
    assert.equal(host.calls.filter((c) => c.call === "spawn").length, 1, "one spawn, the call's");
    void bg;
});

test("with ml.sh on and its port closed (idle, or the host exited), no message from a tab sender starts the host again; the Settings page's refresh does", T, async () => {
    const host = fakeNativeHost();
    const bg = loadBackground({ config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "m", apiFormat: "openai", ...ON }, siteGate: true, local: { ml_site_always: ["https://site.example"] }, onNative: host.onNative, onFetch: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }) });
    for (let i = 0; i < 20; i++) await tick();
    host.exit();
    for (let i = 0; i < 20; i++) await tick();
    const connects = bg.nativeConnects.length, calls = host.calls.length;
    const senders = [{ ...fromTab, documentId: "doc-1" }, { tab: { id: 9, url: "https://evil.example/" }, url: "https://evil.example/", origin: "https://evil.example", frameId: 0, documentId: "e" }];
    for (const sender of senders) for (const type of ALL_TYPES) if (!SHELL_ONLY.has(type)) await within(bg.send({ type, payload: { refresh: true, runId: "r", messages: [{ role: "user", content: "hi" }] } }, sender), 60);
    await tick(30);
    assert.equal(bg.nativeConnects.length, connects, "a tab's message started the host");
    assert.deepEqual(host.calls.slice(calls), [], "a tab's message reached the host");
    // Positive control: the extension's own Settings page measures it, which reconnects.
    await bg.send({ type: "SHELL_STATUS", payload: { refresh: true } }, { id: "test", url: "chrome-extension://test/sidebar.html" });
    assert.equal(bg.nativeConnects.length, connects + 1, "positive control: the Settings refresh reconnected");
});

// --- 2. the page's main world never gets ml.sh ---

test("a script that names ml.sh never runs in the page's world: world \"page\", no isolation, world \"isolated\" without it, or an unapproved page are refused, and the host is never reached", T, async () => {
    const exec = (args) => [{ name: "exec", args }];
    const js = 'await ml.sh.run(["ls"])';
    const cases = [
        ["world page, isolation available", exec({ js, world: "page" }), {}],
        ["no isolation, no world", exec({ js }), { userScripts: false }],
        ["no isolation, world isolated", exec({ js, world: "isolated" }), { userScripts: false }],
        ["no isolation, world page", exec({ js, world: "page" }), { userScripts: false }],
        ["unapproved page, no isolation", exec({ js }), { userScripts: false, approved: false }],
        ["unapproved page, world page", exec({ js, world: "page" }), { approved: false }],
        ["ml.sh in a comment, world page", exec({ js: '/* ml.sh */ document.title', world: "page" }), {}],
    ];
    for (const [label, steps, o] of cases) {
        const host = fakeNativeHost();
        const { results, pageExecs, bg } = await drive(steps, { onNative: host.onNative, configExtra: ON, ...o });
        assert.equal(pageExecs.length, 0, `${label}: the page's world was sent the script`);
        assert.match(results[0] ?? "", /^Error:/, `${label}: refused: ${results[0]?.slice(0, 200)}`);
        assert.deepEqual(host.calls.filter((c) => c.call === "spawn"), [], `${label}: the host was reached`);
    }
    // Positive control: the same script with isolation and no world runs isolated and reaches the host; a plain script
    // with world page does reach the page's world.
    const host = fakeNativeHost();
    const ok = await drive([...exec({ js: 'JSON.stringify(await ml.sh.run(["ls"]))' }), ...exec({ js: "document.title", world: "page" })], { onNative: host.onNative, configExtra: ON });
    assert.match(ok.results[0], /"ok":true/, `positive control: ran isolated: ${ok.results[0].slice(0, 200)}`);
    assert.deepEqual(ok.pageExecs, ["document.title"], "positive control: the page's world is reachable for a plain script");
});

test("a script that reaches ml.sh by a name the router does not read gets no ml.sh, in whatever world it runs, and the host is never reached", T, async () => {
    const variants = ['ml?.sh.run(["ls"])', 'ml["sh"].run(["ls"])', 'const { sh } = ml; sh.run(["ls"])', 'Reflect.get(ml, "sh").run(["ls"])'];
    for (const v of variants) {
        for (const world of ["page", "isolated", undefined]) {
            const host = fakeNativeHost();
            const js = `(async () => { try { return JSON.stringify(await ${v}); } catch (e) { return "threw: " + e.message; } })()`;
            const { results } = await drive([{ name: "exec", args: { js, ...(world ? { world } : {}) } }], { onNative: host.onNative, configExtra: ON });
            assert.deepEqual(host.calls.filter((c) => c.call === "spawn"), [], `${v} (${world}): reached the host: ${results[0]?.slice(0, 200)}`);
        }
    }
});

test("a script that does not name ml.sh, isolated for another reason, cannot reach the sh op by posting on its world's channel itself", T, async () => {
    const host = fakeNativeHost();
    // Isolated because it reads a pointer; the channel exists for that read, and the script posts an sh op on it by hand.
    const script = () => 'const v = @tool:"orders"; const head = (await v.pipe("head -n 1")).text; const r = await chrome.runtime.sendMessage({ type: "ISO_EXEC_ASK", nonce: globalThis.__mlIsoStarted, req: { op: "s" + "h", call: "run", args: [["ls"]] } }); return "<<<" + JSON.stringify({ head: head.length > 0, r }) + ">>>"';
    const { results } = await runOn("userScripts", [script], { onNative: host.onNative, configExtra: ON });
    const got = JSON.parse(/<<<(.*)>>>/.exec(results[0])?.[1] ?? "null");
    assert.equal(got?.head, true, `positive control: the channel answered the script's own read: ${results[0].slice(0, 300)}`);
    assert.match(got?.r?.error ?? "", /ml\.sh is not available/, "the hand-posted sh op was not refused");
    assert.deepEqual(host.calls.filter((c) => c.call === "spawn"), [], "the hand-posted sh op reached the host");
});

// --- 3. the isolated channel's sh op from anyone but the call's own world ---

test("an ISO_EXEC_ASK with op sh from the page's tab (runtime message, forged or guessed nonce, another frame, document or world, or after the exec ended) reaches no host call", T, async () => {
    const host = fakeNativeHost();
    const got = {};
    let first;
    const sh = { op: "sh", call: "run", args: [["ls"]] };
    const { results, bg } = await runOn("userScripts", [shScript(["ls"]), shScript(["ls"])], {
        ...NO_FETCH, onNative: host.onNative, configExtra: ON,
        onExecute: async (bg, inj) => {
            const nonce = nonceOf(inj.js[0].code);
            if (!nonce) return;
            const own = { tab: { id: 7 }, frameId: 0, documentId: "doc-1", userScriptWorldId: inj.worldId };
            const spawns = () => host.calls.filter((c) => c.call === "spawn").length;
            const s0 = spawns();
            if (!first) {
                first = { nonce, own };
                got["runtime.onMessage, run's tab, live nonce"] = await within(bg.send({ type: "ISO_EXEC_ASK", nonce, req: sh }, { ...fromTab, documentId: "doc-1" }));
                const shapes = { "another tab": { ...own, tab: { id: 9 } }, "a sub-frame": { ...own, frameId: 3 }, "no frame": { ...own, frameId: undefined }, "another document": { ...own, documentId: "doc-0" }, "no document": { ...own, documentId: undefined }, "another run's world": { ...own, userScriptWorldId: "wml-0123456789abcdef" } };
                for (const [k, s] of Object.entries(shapes)) got[k] = await within(bg.emitUserScriptMessage({ type: "ISO_EXEC_ASK", nonce, req: sh }, s));
                for (const bad of ["", "0".repeat(32), nonce.toUpperCase(), `${nonce} `]) got[`nonce ${JSON.stringify(bad)}`] = await within(bg.emitUserScriptMessage({ type: "ISO_EXEC_ASK", nonce: bad, req: sh }, own));
                got["a stream message carrying sh"] = await within(bg.emitUserScriptMessage({ type: "ISO_EXEC_STREAM", nonce, text: "x", req: sh }, own));
                await tick(30);
                got.spawnsFromForgeries = spawns() - s0;
            } else {
                // The second exec: the first one's nonce, from its own world's sender, once that exec has ended.
                got["after the exec ended"] = await within(bg.emitUserScriptMessage({ type: "ISO_EXEC_ASK", nonce: first.nonce, req: sh }, first.own));
                await tick(30);
                got.spawnsAfterEnd = spawns() - s0;
                // Positive control: the live nonce from the call's own world is served (and spawns).
                got.own = await within(bg.emitUserScriptMessage({ type: "ISO_EXEC_ASK", nonce, req: sh }, own), 3000);
                got.spawnsFromOwn = spawns() - s0;
            }
        },
    });
    assert.equal(got.own?.ok?.ok, true, `positive control: the call's own world is answered: ${JSON.stringify(got.own)?.slice(0, 200)}`);
    assert.equal(got.spawnsFromOwn, 1, "positive control: its request reached the host");
    for (const [k, v] of Object.entries(got)) if (!["own", "spawnsFromOwn", "spawnsFromForgeries", "spawnsAfterEnd"].includes(k)) assert.equal(v, "NO ANSWER", k);
    assert.equal(got.spawnsFromForgeries, 0, "a forged request reached the host");
    assert.equal(got.spawnsAfterEnd, 0, "a request after its exec ended reached the host");
    assert.equal(valueOf(results[0]).ok, true, "the script's own call ran");
    // After the run's turn is over, the same: nothing is served.
    const late = await within(bg.emitUserScriptMessage({ type: "ISO_EXEC_ASK", nonce: first.nonce, req: sh }, first.own));
    assert.equal(late, "NO ANSWER");
});

// --- 4. the nested ask is answered only by the person, about the host's facts ---

test("a nested ml.sh ask is not answered by SET_APPROVAL from another tab, a guessed or malformed ask id, another run's id, another seq, or the step's own key", T, async () => {
    const host = fakeNativeHost({ facts: (args) => ({ argv: args.argv, program: { path: "/opt/host-resolved/python3", inRoot: false, fingerprint: "7:7:7:7" }, cwd: { path: "/w/proj/sub", inRoot: true }, env: { set: [], secrets: [], free: true }, repo: null, repoConfigRunsCode: null, paths: [], effects: "unknown", mode: "host", sandboxed: true, placement: "host-sandbox" }) });
    let fired = false, startsBeforeLegit = -1, asked;
    const { results } = await runOn("userScripts", [shScript(["python3", "x.py"], { cwd: "sub" })], {
        ...NO_FETCH, onNative: host.onNative, configExtra: ON,
        onStep: async (bg, ev) => {
            const a = (ev.asks ?? []).find((x) => x.state === "pending");
            if (!a || fired) return;
            fired = true;
            asked = a;
            const ok = { runId: ev.id, seq: ev.seq, ask: a.id, decision: true };
            const ext = undefined;   // an extension sender: the panel
            const other = { tab: { id: 9, url: "https://site.example/x" }, url: "https://site.example/x", origin: "https://site.example", frameId: 0, documentId: "d9" };
            const forged = [
                [ok, other],
                [{ ...ok, ask: `a${"0".repeat(24)}` }, ext],
                [{ ...ok, ask: a.id.toUpperCase() }, ext],
                [{ ...ok, ask: null }, ext],
                [{ ...ok, ask: [a.id] }, ext],
                [{ ...ok, runId: "run-someone-else" }, ext],
                [{ ...ok, seq: ev.seq + 1 }, ext],
                [{ ...ok, seq: ev.seq - 1 }, ext],
                [{ runId: ev.id, seq: ev.seq, decision: true }, ext],
            ];
            for (const [p, s] of forged) await within(s ? bg.send({ type: "SET_APPROVAL", payload: p }, s) : bg.send({ type: "SET_APPROVAL", payload: p }), 30);
            await tick(30);
            startsBeforeLegit = host.calls.filter((c) => c.call === "start").length;
            void bg.send({ type: "SET_APPROVAL", payload: ok });
        },
    });
    assert.ok(fired, "positive control: asked");
    assert.equal(startsBeforeLegit, 0, "a forged answer started the call");
    assert.equal(valueOf(results[0]).approvedBy, "person", "positive control: the legitimate answer started it");
    // The card's facts are the host's resolution, never the script's word.
    assert.equal(asked.facts.program.path, "/opt/host-resolved/python3");
    assert.equal(asked.facts.cwd.path, "/w/proj/sub");
    assert.equal(asked.facts.effects, "unknown");
    assert.equal(asked.facts.placement, "host-sandbox");
});

test("a script cannot put facts on its own card: an option the call does not take is refused before the host is reached", T, async () => {
    const host = fakeNativeHost();
    for (const opts of [{ effects: [] }, { placement: "host-sandbox" }, { facts: { effects: [] } }, { approvedBy: "person" }, { shell: true }]) {
        const { results } = await runOn("userScripts", [shScript(["python3", "x.py"], opts)], { ...NO_FETCH, onNative: host.onNative, configExtra: ON });
        assert.equal(valueOf(results[0]).code, "BadRequest", JSON.stringify(opts));
    }
    assert.deepEqual(host.calls.filter((c) => c.call === "spawn"), []);
});

// --- 6. cancel while a call waits on the person or runs (vm) ---

test("cancelling the run while an ml.sh call waits on the person starts nothing, and the host discards the call", T, async () => {
    const host = fakeNativeHost();
    let fired = false;
    await runOn("userScripts", [shScript(["python3", "x.py"])], {
        ...NO_FETCH, onNative: host.onNative, configExtra: ON,
        onStep: async (bg, ev) => {
            if (fired || !(ev.asks ?? []).some((x) => x.state === "pending")) return;
            fired = true;
            void bg.send({ type: "CANCEL_RUN", payload: { runId: ev.id } });
        },
    });
    for (let i = 0; i < 50 && !host.names().includes("discard"); i++) await tick(5);
    assert.ok(fired, "positive control: the call asked");
    assert.ok(host.names().includes("discard"), "the host was told to discard the resolved call");
    assert.ok(!host.names().includes("start"), "nothing started after the cancel");
});

test("cancelling the run while an ml.sh call runs cancels the process on the host", T, async () => {
    const host = heldHost({}, { holdDone: true });
    let sent = false;
    host.onDoneHeld = () => {
        if (sent) return;
        sent = true;
        // Once the worker has the start's answer (the process is running), the person presses Stop.
        setTimeout(() => void host.bg.send({ type: "CANCEL_RUN", payload: { runId: host.runId } }), 50);
        // A host that never hears the cancel finishes on its own a moment later, so the run ends either way.
        setTimeout(() => host.releaseDone(), 400);
    };
    const { bg } = await runOn("userScripts", [shScript(["ls"])], {
        ...NO_FETCH, onNative: host.onNative, configExtra: ON,
        onBg: (b) => { host.bg = b; },
        onStep: (_bg, ev) => { host.runId = ev.id; },
    });
    for (let i = 0; i < 100 && !host.names().includes("cancel"); i++) await tick(5);
    assert.ok(sent, "positive control: the process started and was running");
    assert.ok(host.names().includes("cancel"), "the running process was cancelled on the host");
    void bg;
});

// --- 8. what crosses back carries no server URL or API key ---

const LONG_KEY = "sk-redteam-0123456789abcdef";
const leakyHost = () => heldHost({ refuse: { spawn: "Failed" } }, { rewriteError: () => `spawn refused near http://host/api/chat/completions with ${LONG_KEY}` });
const SECRET = new RegExp(`${LONG_KEY}|http://host\\b`);

test("a host error that names the server URL or the API key reaches the model without them", T, async () => {
    const host = leakyHost();
    const script = () => `(async () => { try { await ml.sh.run(["ls"]); return "no throw"; } catch (e) { return "RAW:" + e.message; } })()`;
    const { results } = await runOn("userScripts", [script], { ...NO_FETCH, onNative: host.onNative, configExtra: { ...ON, apiKey: LONG_KEY } });
    assert.match(results[0], /RAW:Failed: spawn refused/, `positive control: the error crossed: ${results[0].slice(0, 300)}`);
    assert.doesNotMatch(results[0], SECRET, "the model read the URL or the key");
});

test("a host error that names the server URL or the API key reaches the script without them", T, async () => {
    const host = leakyHost();
    // The script encodes what it was handed, so the scrub at the tool result cannot recognise it.
    const script = () => `(async () => { try { await ml.sh.run(["ls"]); return "no throw"; } catch (e) { return "HEX:" + [...e.message].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join(""); } })()`;
    const { results } = await runOn("userScripts", [script], { ...NO_FETCH, onNative: host.onNative, configExtra: { ...ON, apiKey: LONG_KEY } });
    const hex = /HEX:([0-9a-f]+)/.exec(results[0])?.[1];
    assert.ok(hex, `positive control: the script saw an error: ${results[0].slice(0, 300)}`);
    const seen = hex.match(/.{4}/g).map((h) => String.fromCharCode(parseInt(h, 16))).join("");
    assert.match(seen, /spawn refused/, "positive control: decoded");
    assert.doesNotMatch(seen, SECRET, `the script was handed the URL or the key: ${seen}`);
});

// --- the module itself: races, held output and the probe (sw-shell-call.ts, imported directly) ---

// The worker's chrome, as much of it as sw-shell.ts and sw-shell-call.ts use. The policy store's read is held until
// released, so the first test sees a store that is not loaded yet.
let releasePolicies;
const policiesHeld = new Promise((r) => { releasePolicies = r; });
const sync = { ...ON, chatUrl: "http://host/api/chat/completions", apiKey: "sk-test" };
let native = null;
globalThis.chrome = {
    runtime: {
        id: "ext-id", lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => p,
        connectNative: (name) => {
            const onMsg = [], onDisc = [];
            let closed = false;
            const close = (why) => { if (closed) return; closed = true; setTimeout(() => { globalThis.chrome.runtime.lastError = { message: why }; for (const f of onDisc) f(); globalThis.chrome.runtime.lastError = undefined; }, 0); };
            const end = { send: (m) => { if (!closed) setTimeout(() => { for (const f of onMsg) f(JSON.parse(JSON.stringify(m))); }, 0); }, close };
            const receive = native ? native(name, end) : null;
            if (!receive) close("Specified native messaging host not found.");
            return { name, postMessage: (m) => { if (closed) throw new Error("disconnected"); receive?.(JSON.parse(JSON.stringify(m))); }, disconnect: () => { closed = true; }, onMessage: { addListener: (f) => onMsg.push(f) }, onDisconnect: { addListener: (f) => onDisc.push(f) } };
        },
    },
    storage: {
        local: { get: async (keys) => { if (Array.isArray(keys)) await policiesHeld; return {}; }, set: async () => {}, remove: async () => {} },
        sync: { get: async (d) => ({ ...(d ?? {}), ...sync }), set: async () => {} },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: { addListener() {} },
    },
};
const { shRun, shRead, releaseShOutputs, SH_READ_MAX } = await import("../src/sw/sw-shell-call.ts");
const { TokenStore } = await import("../src/pointers/token-pipe.ts");
let rootN = 0;
/** A fresh host for one test: a new workspace root, so the worker reconnects and configures it. */
function useHost(host) { native = host.onNative; sync.shellRoots = [`/w/p${++rootN}`]; return host; }
const ctxFor = (runId, signal = new AbortController().signal) => ({ runId, seq: 3, local: { step: 1, seq: 3 }, signal, tokens: new TokenStore() });
const gitFacts = (inRoot, fp = "1:2:3:4", sandboxed = true) => (args) => ({ argv: args.argv, program: { path: inRoot ? "/w/proj/bin/git" : "/usr/bin/git", inRoot, fingerprint: fp }, cwd: { path: args.cwd, inRoot: true }, env: { set: [], secrets: [], free: true }, repo: null, repoConfigRunsCode: null, paths: [], effects: "unknown", mode: "host", sandboxed, placement: sandboxed ? "host-sandbox" : "host-plain" });
const gitDone = (_id, spawn) => (spawn?.argv?.[1] === "--version" ? { out: "git version 2.44.0\n", err: "", code: 0 } : { out: "", err: "", code: 0 });

test("the version probe never runs while the policy store is not loaded (then, once it is, it does)", T, async () => {
    const host = useHost(fakeNativeHost({ facts: gitFacts(false, "5:5:5:5"), done: gitDone }));
    const r = await shRun(ctxFor("run-unloaded"), [["git", "status"]]);
    assert.equal(r.code, "Denied", `no one to ask, so refused: ${JSON.stringify(r)}`);
    try {
        assert.deepEqual(host.calls.filter((c) => c.call === "start"), [], "the probe (or the call) started while the store was not loaded");
    } finally { releasePolicies(); }
    await tick(10);
    // Positive control: loaded, the same program is probed under the sandbox.
    const r2 = await shRun(ctxFor("run-loaded"), [["git", "status"]]);
    assert.equal(r2.ok?.ok, true, JSON.stringify(r2));
    assert.equal(host.calls.filter((c) => c.call === "start" && host.calls.some((s) => s.call === "spawn" && s.id === c.args.id && s.args.argv[1] === "--version")).length, 1, "positive control: the probe started once loaded");
});

test("the version probe never runs a program inside the workspace roots, nor on the plain host", T, async () => {
    for (const [label, facts] of [["in root", gitFacts(true, "6:6:6:6")], ["plain host", gitFacts(false, "8:8:8:8", false)]]) {
        const host = useHost(fakeNativeHost({ facts, done: gitDone, sandbox: label !== "plain host" }));
        await shRun(ctxFor(`run-${label}`), [["git", "status"]]);
        assert.deepEqual(host.calls.filter((c) => c.call === "spawn" && c.args.argv[1] === "--version"), [], `${label}: probed`);
    }
});

test("a program inside the workspace roots is never described by a version read from another file, even one with the same fingerprint (a hard link)", T, async () => {
    // First the real git, outside the roots: probed and cached under its fingerprint.
    const out = useHost(fakeNativeHost({ facts: gitFacts(false, "4:4:4:4"), done: gitDone }));
    const r1 = await shRun(ctxFor("run-link"), [["git", "status"]]);
    assert.equal(r1.ok?.ok, true, `positive control: described outside the roots, it ran: ${JSON.stringify(r1)}`);
    assert.equal(out.calls.filter((c) => c.call === "spawn" && c.args.argv[1] === "--version").length, 1, "positive control: probed");
    // Then a file inside the roots with the same device, inode, size and mtime (a hard link the script made).
    const inRoot = useHost(fakeNativeHost({ facts: gitFacts(true, "4:4:4:4"), done: gitDone }));
    const r2 = await shRun(ctxFor("run-link"), [["git", "status"]]);
    assert.ok(!inRoot.names().includes("start"), `an in-root program was described by a cached version and started without a card: ${JSON.stringify(r2).slice(0, 300)}`);
});

test("a call whose run is cancelled while the host resolves it is never started, and the host discards it", T, async () => {
    const ctl = new AbortController();
    const host = useHost(fakeNativeHost({ facts: (args) => { ctl.abort(); return { ...gitFacts(false, "3:1:3:1")(args), argv: args.argv, program: { path: "/bin/ls", inRoot: false, fingerprint: "3:1:3:1" } }; } }));
    const r = await shRun(ctxFor("run-cancel-ls", ctl.signal), [["ls"]]);
    assert.equal(r.code, "Denied", JSON.stringify(r));
    assert.ok(host.names().includes("spawn") && host.names().includes("discard"), `positive control: resolved, then discarded: ${host.names()}`);
    assert.ok(!host.names().includes("start"), "started after the cancel");
});

test("nothing starts after the run is cancelled: not the call, and not its version probe", T, async () => {
    const ctl = new AbortController();
    const host = useHost(fakeNativeHost({ facts: (args) => { if (args.argv[1] !== "--version") ctl.abort(); return gitFacts(false, "9:1:9:1")(args); }, done: gitDone }));
    const r = await shRun(ctxFor("run-cancel-probe", ctl.signal), [["git", "status"]]);
    assert.equal(r.code, "Denied", `positive control: the call itself was refused: ${JSON.stringify(r)}`);
    assert.deepEqual(host.calls.filter((c) => c.call === "start"), [], `started after the cancel: ${JSON.stringify(host.calls.filter((c) => c.call === "start" || c.call === "spawn").map((c) => c.args))}`);
});

test("a cancel that lands while the host is starting the process still cancels it", T, async () => {
    const ctl = new AbortController();
    const host = useHost(heldHost({}, { holdStart: true, holdDone: true }));
    host.onStartHeld = () => { ctl.abort(); host.releaseStart(); };
    // A host that never hears the cancel finishes on its own, so the call ends either way.
    host.onDoneHeld = () => setTimeout(() => host.releaseDone(), 200);
    const r = await shRun(ctxFor("run-cancel-start", ctl.signal), [["ls"]]);
    assert.ok(host.names().includes("start"), `positive control: it was started: ${JSON.stringify(r).slice(0, 200)}`);
    assert.ok(host.names().includes("cancel"), "the process started under a cancel was never cancelled");
});

// --- 5. ml.sh.read reads only this run's held output ---

test("ml.sh.read returns only output the host holds for THIS run: not another run's, not a loop pointer, not after release or the port closing, and a range is bounded", T, async () => {
    const big = "x".repeat(70000) + "TAIL";
    const host = useHost(fakeNativeHost({ done: () => ({ out: big, err: "", code: 0 }) }));
    const a = ctxFor("run-A"), b = ctxFor("run-B");
    const ra = await shRun(a, [["ls"]]);
    const tok = ra.ok?.stdout?.token;
    assert.match(tok ?? "", /^@tool:[0-9a-f]{7}$/, `positive control: a held output: ${JSON.stringify(ra).slice(0, 200)}`);
    const reads = () => host.calls.filter((c) => c.call === "read").length;
    const own = await shRead(a, [tok, { offset: 70000, length: 10 }]);
    assert.equal(own.ok?.text, "TAIL", "positive control: its own run reads it");
    let r0 = reads();
    assert.equal((await shRead(b, [tok, { offset: 70000, length: 10 }])).code, "Refused", "another run read it");
    assert.equal((await shRead(b, [tok.slice(6)])).code, "Refused", "another run read it by bare id");
    // A pointer the loop itself noted for the run (not one the host holds), and a made-up one.
    a.tokens.note({ id: "abcdef1", tool: "fetch_url", kind: "text", out: "secret page", in: "{}", t: Date.now(), step: 1, seq: 1 });
    for (const t of ["@tool:abcdef1", "abcdef1", "@tool:0000000", "@tool:", "", "@tool:../" + tok.slice(6)]) assert.equal((await shRead(a, [t])).code, "Refused", `read ${JSON.stringify(t)}`);
    for (const range of [{ offset: -1 }, { length: -1 }, { offset: 1.5 }, { offset: "0" }, { length: Infinity }, { offset: NaN }]) assert.equal((await shRead(a, [tok, range])).code, "BadRequest", JSON.stringify(range));
    assert.equal(reads(), r0, "a refused read reached the host");
    // A huge length is clipped to one chunk before it reaches the host.
    await shRead(a, [tok, { offset: 0, length: Number.MAX_SAFE_INTEGER }]);
    assert.ok(host.calls.filter((c) => c.call === "read").at(-1).args.length <= SH_READ_MAX, "an unbounded length reached the host");
    // Released with its session: gone.
    releaseShOutputs("run-A");
    r0 = reads();
    assert.equal((await shRead(a, [tok])).code, "Refused", "read after its session was released");
    assert.equal(reads(), r0, "a released read reached the host");
    // A new output, then the port closes (an eviction, a host exit): gone, and nothing is read on a new port.
    const ra2 = await shRun(a, [["ls"]]);
    const tok2 = ra2.ok.stdout.token;
    host.exit();
    await tick(10);
    r0 = reads();
    assert.equal((await shRead(a, [tok2])).code, "Refused", "read after the port closed");
    assert.equal(reads(), r0, "a stale read reached a host");
});
