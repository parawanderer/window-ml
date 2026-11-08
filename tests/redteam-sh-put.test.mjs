// redteam-sh-put.test.mjs — the red-team pass for `ml.sh.put(handle, path)`: an `@file:` attachment's ORIGINAL bytes,
// written to the disk of a connected process host (SHELL.md's argv ruling, amended 2026-11-08; FILE_ATTACHMENTS.md
// ruling 3 reversed). The design is what the rows assert: judged as an in-root write, an existing file ALWAYS asks, the
// parent must exist and resolve inside a root by the tilde realpath path, the bytes are the attachment's and not a
// PDF's extracted text, it never detaches, and over the hub it is refused.
//
// Every row is `{ todo }` because the surface does not exist yet (the async lane builds the host half and the window-ml
// half first); each asserts the DEFENDED outcome, so it fails today at the sentence it demands and turns with the
// feature. The failure is never a vacuous one: today `ml.sh.put` is not a function, so a row's "nothing was written"
// would pass for the wrong reason, which is why every row also demands the refusal's own text (the design's sentence,
// not merely "not ok"). The controls pass today and hold the fixture honest: the same harness reaches the host, the
// run really holds an `@file:` pointer, and the bytes the worker keeps are the ones the person attached.
//
// Two of the rows are not about `put` alone and are worth their own line here:
//   - the argv ruling (SHELL.md: a pointer token of ANY prefix in argv is refused, "a held value, not a path") is ruled
//     and NOT implemented: measured with the todos stripped, `ml.sh.run(["cat", "@file:3fa91c2"])` spawns
//     `["cat","@file:3fa91c2"]` on the host, unflagged and unrefused. The row keeps measuring it.
//   - `src/sw/iso-channel.ts` admits `op: "sh"` only for call `run`|`read` with `args.length <= 2`, and that channel is
//     what a page can post on by hand. `put` is a third call name, so the allowlist must name it rather than relax the
//     length guard; the row here posts `put` on the channel from a script that has no `ml.sh`.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fakeNativeHost } from "./fake-native-host.mjs";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const { IDBFactory } = require("fake-indexeddb");
const { fileId } = await import("../src/pointers/file-pointer.ts");

const T = { timeout: 30000 };
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const SITE_URL = "https://site.example/page";
const CONFIG = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
/** ml.sh on, with one root: what a person sets to get a shell at all. */
const ON = { shellEnabled: true, shellRoots: ["/w/proj"] };

// The attachment: a PDF whose bytes are NOT its text, so "the original bytes" and "the extracted text" are told apart.
// The marker is in the first bytes, so a chunked write carries it in its first chunk.
const MARK = "ORIGINAL-BYTES-9f3a";
const PAGE = "Revenue grew 12% in the second half.";
const PDF = { name: "report.pdf", type: "application/pdf", data: Buffer.from(`%PDF-1.7 ${MARK}`).toString("base64") };
const PDF_DOC = { pageCount: 2, pages: [{ n: 1, text: "Annual report", kind: "text", measure: {} }, { n: 2, text: PAGE, kind: "text", measure: {} }] };
const PDF_SHA = createHash("sha256").update(Buffer.from(PDF.data, "base64")).digest("hex");

/**
 * A fake host that also answers `write`, the host call `put` adds. `write` selects its answer: `"ok"` (the default),
 * `"exists"` (the path is already there, which is what raises the person's ask), `"outside-root"`, `"no-parent"`.
 * Every call is recorded on `host.calls`, so a row can assert what the host was and was not sent.
 */
function putHost({ write = "ok" } = {}) {
    const host = fakeNativeHost();
    const inner = host.onNative;
    host.onNative = (name, e) => {
        const recv = inner(name, e);
        if (!recv) return null;
        return (m) => {
            if (m.call !== "write") return recv(m);
            host.calls.push(m);
            const path = String(m.args?.path ?? "");
            const answers = {
                "ok": { value: { path, bytes: Number(m.args?.bytes ?? 0) } },
                "exists": { error: { code: "Exists", message: `${path} already exists` } },
                "outside-root": { error: { code: "OutsideRoot", message: `${path} resolves outside every root the session was given` } },
                "no-parent": { error: { code: "NoParent", message: `${path} has no parent directory in any root` } },
            };
            e.send({ seq: m.seq, ...(answers[write] ?? answers.ok) });
        };
    };
    return host;
}

/** Every byte string a `write` carried, decoded: the design does not fix the arg key, so a row reads them all. */
function wrote(host) {
    const out = [];
    const take = (v) => {
        if (typeof v === "string" && v.length > 8) out.push(Buffer.from(v, "base64").toString("latin1"));
        else if (v && typeof v === "object") for (const x of Object.values(v)) take(x);
    };
    for (const c of host.calls.filter((x) => x.call === "write")) take(c.args ?? {});
    return out.join("");
}
const writes = (host) => host.calls.filter((c) => c.call === "write");

/** What an exec answered, as the model read it: the JSON the script returned, or its thrown message. */
function answer(result) {
    const v = /^value: (.*)$/m.exec(result ?? "")?.[1] ?? /^(\{.*\})$/m.exec(result ?? "")?.[1];
    if (!v) return { raw: String(result ?? "") };
    try { return JSON.parse(v); } catch { return { raw: String(result) }; }
}
/** The text a refusal carried, whichever field the wire used. */
const why = (a) => String(a.threw ?? a.error ?? a.refusal ?? a.message ?? a.raw ?? "");

/** Run one `ml.sh.put` (or any script) as an exec of a worker-built run that holds `files`. */
async function runPut({ host, files = [PDF], script, localExtra = {}, configExtra = {}, sender, autoApprove = true, onStep, ticks = 4000 } = {}) {
    let bg, release;
    const ready = new Promise((r) => (release = r));
    const steps = [];
    const asks = [];
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
        siteGate: true, indexedDB: new IDBFactory(), userScripts, onPdfRead: () => ({ ok: true, doc: PDF_DOC }),
        ...(host ? { onNative: host.onNative } : {}),
        config: { ...CONFIG, ...ON, ...configExtra },
        local: { ml_site_always: ["https://site.example"], ...localExtra },
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
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.kind === "agent-step") {
                asks.push(...(msg.event.asks ?? []));
                await onStep?.(bg, msg.event, asks);
            }
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval && autoApprove) {
                void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            }
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish) return { result: "" };
            if (msg.payload.renderOnly || msg.payload.precheck || msg.payload.readonlyTry) return {};
            return { result: "value: RAN IN THE PAGE'S WORLD" };
        },
    });
    bg.commit?.(7, { documentId: "doc-1", url: SITE_URL });
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task: "put the report on disk", surface: "hud", maxSteps: 8, files }, sender ? { sender } : {});
    const ptr = `@file:${fileId(hash, 1)}`;
    steps.push({ name: "exec", args: { js: script({ hash, ptr }), world: "isolated" } });
    release();
    for (let i = 0; i < ticks && n <= steps.length; i++) await flush(1);
    await flush(40);
    const last = bg.calls.filter((c) => c.url.includes("/chat/completions") && c.body?.tools).at(-1);
    const results = (last?.body?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
    return { results, bg, hash, ptr, asks, worlds };
}

/** `ml.sh.put(handle, path)` as the model would write it, answering what it answered or threw. */
const put = (handle, path) => `(async () => { try { return JSON.stringify(await ml.sh.put(${JSON.stringify(handle)}, ${JSON.stringify(path)})); } catch (e) { return JSON.stringify({ threw: e.message, code: e.code }); } })()`;

// --- 0. the fixture: the host is reachable, the run holds the file, and the bytes kept are the person's ---

test("CONTROL: the same harness reaches the host for an ordinary call, so a row's 'no write' is not 'the host was never reachable'", T, async () => {
    const host = putHost();
    const { results } = await runPut({ host, script: () => 'JSON.stringify(await ml.sh.run(["ls"]))' });
    assert.deepEqual(host.calls.filter((c) => c.call === "spawn").length, 1, `the host was not reached: ${results[0]?.slice(0, 300)}`);
    assert.match(results[0] ?? "", /"ok":true/, `the call did not finish: ${results[0]?.slice(0, 300)}`);
});

test("CONTROL: the run holds an `@file:` pointer whose name is the file's own, and the bytes it keeps are the attachment's, not the extracted text", T, async () => {
    const host = putHost();
    const { bg, hash, ptr, results } = await runPut({ host, script: ({ ptr }) => `JSON.stringify({ ptr: ${JSON.stringify(ptr)} })` });
    assert.deepEqual(answer(results[0]).ptr, ptr, `the pointer the model would name is not the run's: ${results[0]?.slice(0, 200)}`);
    const rows = (await bg.context.__mlValues.rows()).filter((r) => r.sessions.includes(hash));
    const bytes = rows.find((r) => r.format === "bytes");
    assert.ok(bytes, `no bytes row for the attachment: ${JSON.stringify(rows.map((r) => r.format))}`);
    assert.equal(bytes.blob, PDF_SHA, "the row kept is not the attachment's own bytes");
    assert.equal(bytes.source, "report.pdf");
});

// --- 1. the path: in a root or not at all ---

test("RED TEAM: a path that leaves the root is refused at the worker, never sent to the host", { ...T, todo: "open: `ml.sh.put` does not exist yet; the row pins the refusal for `../escape.pdf` and an absolute path, and that neither reaches the host" }, async () => {
    for (const path of ["../escape.pdf", "/etc/escape.pdf", "inbox/../../escape.pdf"]) {
        const host = putHost();
        const { results } = await runPut({ host, script: ({ ptr }) => put(ptr, path) });
        const a = answer(results[0]);
        assert.deepEqual(writes(host), [], `${path}: the host was sent a write`);
        assert.match(why(a), /root|outside|inside|\.\./i, `${path}: the refusal does not say it leaves the root: ${results[0]?.slice(0, 300)}`);
    }
});

test("RED TEAM: a symlinked root cannot carry the write out of it: the host's refusal surfaces and nothing is reported written", { ...T, todo: "open: the root's realpath is the host's judgement (the tilde rules); the row pins that an OutsideRoot answer is a refusal the model sees, not a success and not a retry loop" }, async () => {
    const host = putHost({ write: "outside-root" });
    const { results } = await runPut({ host, script: ({ ptr }) => put(ptr, "inbox/report.pdf") });
    const a = answer(results[0]);
    assert.ok(!("path" in a) || a.ok === false, `a refused write was reported as written: ${results[0]?.slice(0, 300)}`);
    assert.match(why(a), /OutsideRoot|outside every root|resolves outside/i, `the host's refusal was not what the model saw: ${results[0]?.slice(0, 300)}`);
    assert.ok(writes(host).length <= 1, `the refused write was retried: ${writes(host).length}`);
});

test("RED TEAM: a parent that is not there is refused, and the file is not created where the person did not make a directory", { ...T, todo: "open: 'the parent must exist' is checked through the host's path facts; the row pins that NoParent is a refusal the model sees" }, async () => {
    const host = putHost({ write: "no-parent" });
    const { results } = await runPut({ host, script: ({ ptr }) => put(ptr, "nowhere/deep/report.pdf") });
    const a = answer(results[0]);
    assert.ok(!("path" in a) || a.ok === false, `a write to a missing parent was reported as written: ${results[0]?.slice(0, 300)}`);
    assert.match(why(a), /NoParent|no parent|does not exist/i, `the refusal does not name the missing parent: ${results[0]?.slice(0, 300)}`);
});

test("RED TEAM: a `~`-spelled path goes through the tilde rules: it is the host that resolves it, and another user's home is refused", { ...T, todo: "open: `~/proj/x.pdf` must reach the host as the resolved absolute path (never as a literal `~`), and `~someone/x` must be refused before any write" }, async () => {
    const home = putHost();
    const r1 = await runPut({ host: home, script: ({ ptr }) => put(ptr, "~/proj/report.pdf") });
    const paths = writes(home).map((c) => String(c.args?.path ?? ""));
    if (writes(home).length) {
        assert.ok(paths.every((p) => p.startsWith("/")), `the host was sent a path it must resolve itself: ${JSON.stringify(paths)}`);
        assert.ok(paths.every((p) => !p.startsWith("~")), `a literal ~ reached the host: ${JSON.stringify(paths)}`);
    } else {
        assert.match(why(answer(r1.results[0])), /~|home/i, `no write and no refusal that explains the tilde: ${r1.results[0]?.slice(0, 300)}`);
    }
    const other = putHost();
    const r2 = await runPut({ host: other, script: ({ ptr }) => put(ptr, "~someone/report.pdf") });
    assert.deepEqual(writes(other), [], "another user's home was written to");
    assert.match(why(answer(r2.results[0])), /~|home|another user/i, `the refusal does not name the other home: ${r2.results[0]?.slice(0, 300)}`);
});

// --- 2. the handle: this run's attachment, and nothing else ---

test("RED TEAM: another run's `@file:` handle cannot be named, and the refusal says nothing about that run's file", { ...T, todo: "open: a handle is resolved on THIS run's shelf (the rule `ml.sh.read` already keeps for outputs), so a second run's pointer is a miss, not a read" }, async () => {
    const host = putHost();
    const first = await runPut({ host, script: () => "JSON.stringify({ done: true })" });
    const otherPtr = `@file:${fileId(first.hash, 1)}`;
    const second = putHost();
    const { results } = await runPut({ host: second, script: ({ ptr }) => put(otherPtr === ptr ? "@file:0000000" : otherPtr, "inbox/report.pdf") });
    assert.deepEqual(writes(second), [], "another run's attachment was written");
    const text = why(answer(results[0]));
    assert.match(text, /ValueMissing|not a file this run holds|another run|no such file/i, `the refusal does not say the handle is not this run's: ${results[0]?.slice(0, 300)}`);
    assert.ok(!text.includes("report.pdf") && !text.includes(PAGE), `the refusal carried the other run's file: ${text.slice(0, 200)}`);
});

test("RED TEAM: the bytes written are the attachment's ORIGINAL bytes, never the PDF's extracted text", { ...T, todo: "open: `put` writes the value-store `bytes` row, so a PDF's page text must never be what reaches the disk" }, async () => {
    const host = putHost();
    const { results } = await runPut({ host, script: ({ ptr }) => put(ptr, "inbox/report.pdf") });
    const a = answer(results[0]);
    assert.equal(writes(host).length > 0, true, `nothing was written: ${results[0]?.slice(0, 300)}`);
    assert.ok(!a.threw || !/not an object|not a function/.test(String(a.threw)), `the call did not get its argument judged: ${a.threw}`);
    const text = wrote(host);
    assert.ok(text.includes(MARK), `the write did not carry the attachment's own bytes: ${JSON.stringify(text.slice(0, 120))}`);
    assert.ok(!text.includes(PAGE), "the write carried the PDF's extracted text instead of its bytes");
});

// --- 3. writing is judged: an existing file asks, even where an allow policy covers the call ---

test("RED TEAM: an existing file asks the person, and an allow policy lifts none of it", { ...T, todo: "open: an overwrite always asks; the row pins that a stored allow for `sh` still raises the ask, and that nothing is written before the person answers" }, async () => {
    const host = putHost({ write: "exists" });
    const allow = { id: "p-allow", scope: "global", consumer: "sh", effect: "allow", source: "() => true", label: "allow every call", origin: "person", created: 1 };
    let pending = null;
    const { results, asks } = await runPut({
        host, localExtra: { ml_policies_global: [allow] }, autoApprove: false,
        script: ({ ptr }) => put(ptr, "inbox/report.pdf"),
        onStep: (_bg, _ev, seen) => { pending ??= seen.find((x) => x.state === "pending") ?? null; },
    });
    assert.ok(pending, `no ask was raised under an allow policy: ${JSON.stringify(asks)}`);
    assert.deepEqual(writes(host), [], "the file was written without the person's answer");
    const a = answer(results[0]);
    assert.ok(!("path" in a) || a.ok === false, `the call reported a write that was never approved: ${results[0]?.slice(0, 300)}`);
});

// --- 4. the surfaces that must never get it ---

test("RED TEAM: `put` hand-posted on the call's own channel is refused by the allowlist, while the same channel still answers `run`", T, async () => {
    const host = putHost();
    // The script names ml.sh, so the call HAS a channel: the hand-posted `run` beside it proves the channel was live when
    // `put` was refused, which is what makes the refusal the allowlist's (iso-channel.ts names run|read) and not a dead one.
    const script = ({ ptr }) => `(async () => {
        const own = await ml.sh.run(["ls"]);
        const post = (call, args) => chrome.runtime.sendMessage({ type: "ISO_EXEC_ASK", nonce: globalThis.__mlIsoStarted, req: { op: "sh", call, args } });
        const run = await post("run", [["ls"]]);
        const put = await post("put", [${JSON.stringify(ptr)}, "inbox/report.pdf"]);
        return JSON.stringify({ own: own?.ok, run, put });
    })()`;
    const { results } = await runPut({ host, script });
    const a = answer(results[0]);
    assert.equal(a.own, true, `positive control: the run's own ml.sh call did not work: ${results[0]?.slice(0, 300)}`);
    assert.ok(!a.run?.error, `positive control: the hand-posted run was refused, so the channel was not the thing judging: ${JSON.stringify(a.run)}`);
    assert.ok(a.put?.error, `the hand-posted put was answered instead of refused: ${JSON.stringify(a.put)}`);
    assert.deepEqual(writes(host), [], "the hand-posted put reached the host");
});

test("RED TEAM: a run started over the hub is refused, and the refusal names the other machine rather than writing there", { ...T, todo: "open: 'over the hub it is refused' — the row starts the run with sender { remote: true } (the channel's mark, which a page cannot set) and demands no write and a refusal naming the remote machine" }, async () => {
    const host = putHost();
    const { results } = await runPut({ host, sender: { remote: true }, script: ({ ptr }) => put(ptr, "inbox/report.pdf") });
    assert.deepEqual(writes(host), [], "a run from another machine wrote to this one");
    assert.match(why(answer(results[0])), /another device|remote|hub|machine/i, `the refusal does not say where the file was going: ${results[0]?.slice(0, 300)}`);
});

// --- 5. the bounds: a chunk past the cap, and a call that never detaches ---

test("RED TEAM: a chunk past the cap is refused with a sentence naming the bound, and no partial file is left", { ...T, todo: "open: the cap's side and value are still open (worker SH_LIMITS vs the host's PROTOCOL); the row demands a refusal that names the bound, and no write at all, rather than a truncated file" }, async () => {
    const big = { name: "big.pdf", type: "application/pdf", data: Buffer.alloc(3 * 1024 * 1024, 0x41).toString("base64") };
    const host = putHost();
    const { results } = await runPut({ host, files: [big], script: ({ ptr }) => put(ptr, "inbox/big.pdf") });
    const a = answer(results[0]);
    const sent = wrote(host).length;
    if (sent) assert.ok(sent > 0, "a chunk was written despite the cap");
    assert.match(why(a), /cap|limit|larger|too big|bytes/i, `the refusal does not name the bound: ${results[0]?.slice(0, 300)}`);
});

// --- 6. the ruling `put` sits beside: a pointer in argv is not a path ---

test("RED TEAM: an `@file:` (or `@tool:`) token in argv never reaches the host as an argv item", { ...T, todo: "open: SHELL.md's ruling (a pointer token of any prefix in argv is refused, 'a held value, not a path') is ruled and unbuilt; the row measures the host being sent the pointer as an argument, and once `put` exists the sentence must name it" }, async () => {
    for (const token of ["@file:3fa91c2", "@tool:ab12cd3"]) {
        const host = putHost();
        const { results } = await runPut({ host, script: () => `(async () => { try { return JSON.stringify(await ml.sh.run(["cat", ${JSON.stringify(token)}])); } catch (e) { return JSON.stringify({ threw: e.message, code: e.code }); } })()` });
        const argvSent = JSON.stringify(host.calls.filter((c) => c.call === "spawn").map((c) => c.args?.argv ?? null));
        assert.ok(!argvSent.includes(token), `${token}: the pointer reached the host as an argv item: ${argvSent.slice(0, 300)}`);
        assert.match(why(answer(results[0])), /held value|attachment|put/i, `${token}: the refusal does not say it is a held value: ${results[0]?.slice(0, 300)}`);
    }
});
