// redteam-sh-put.test.mjs — the red-team pass for `ml.sh.put(handle, path)`: an `@file:` attachment's ORIGINAL bytes,
// written to the disk of a connected process host (SHELL.md's argv ruling, amended 2026-11-08; FILE_ATTACHMENTS.md
// ruling 3 reversed). The design the rows assert, as ruled with the coordinator and the async lane on 2026-11-08:
//
//   - The host resolves and judges; the call is resolve → judge → act, like `spawn`: `put { path, cwd, size }` answers
//     facts (id, path, root, rel, exists, existingSize, size, tilde) and writes NOTHING; `write { id, offset, bytes }`
//     appends one chunk (at most 512 KiB, the worker splits the file, so the model never sees a chunk); `commit
//     { id, replace }` renames, with `replace` true only after the person approved an overwrite; `discard { id }` drops
//     it. Outright refusals: `NoParent`, `OutsideRoots`, `IsSymlink`, `IsDirectory`, `Protected`, `TooLarge`.
//   - The caps are the host's and are ADVERTISED in `hello`: natively `put: { max: 67108864 }`, over the hub `put: null`
//     (the way `register` is `false` there); a `write` carries at most 512 KiB (`store::MAX_READ`). The worker refuses a
//     file over the advertised `max` before the first `write`, with a sentence naming the file's size and the cap.
//   - The bytes are the attachment's own, never a PDF's extracted text.
//   - An overwrite ALWAYS asks, and an allow policy lifts none of it. Two refusals no tier can allow: a protected name
//     (`.git/hooks`, `.git/config`, rc files) and a `looks_secret` target.
//   - Over the hub it is refused on BOTH sides: the worker first (a run whose `origin.remote` is true), the host too —
//     `put`, `write` and `commit` each answer `{ code: "Refused", reason: "scope" }` before reading an argument — because
//     the file would land on a machine the person is not at. The host half lives in window-ml-host and is tested there.
//   - `src/sw/iso-channel.ts` admits `op: "sh"` for call `run`|`read` with `args.length <= 2`; `put` joins that
//     allowlist by NAME and gets its own arity check (handle and path are exactly two), never a relaxed length guard.
//
// Every row is `{ todo }` because the surface does not exist yet; each asserts the DEFENDED outcome, so it fails today
// at the sentence it demands and turns with the feature. The failure is never vacuous: today `ml.sh.put` is not a
// function, so a row's "nothing was written" would pass for the wrong reason, which is why every row also demands the
// refusal's own text. The controls pass today and hold the fixture honest: the harness reaches the host, the run really
// holds an `@file:` pointer, and the bytes the worker keeps are the ones the person attached.
//
// SHELL.md's argv ruling (a pointer token of any prefix in argv is refused, "a held value, not a path", RULED
// 2026-10-28) is NOT tested here: it was found beside these rows but measured unbuilt, and it travels with the fix that
// answers it, on its own branch (`feat/sh-argv-pointer`), as that fixer's flip. Only `put` and its own surfaces are
// below.
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
const EXT = { id: "ext", url: "chrome-extension://ext/sidebar.html", origin: "chrome-extension://ext" };
const CONFIG = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
/** ml.sh on, with one root: what a person sets to get a shell at all. */
const ON = { shellEnabled: true, shellRoots: ["/w/proj"] };
/** The whole-file cap THIS fixture's host advertises in `hello` (`put: { max }`), so the row needs no 64 MiB buffer. */
const PUT_MAX = 256 * 1024;

// The attachment: a PDF whose bytes are NOT its text, so "the original bytes" and "the extracted text" are told apart.
// The marker is in the first bytes, so a chunked write carries it in its first chunk.
const MARK = "ORIGINAL-BYTES-9f3a";
const PAGE = "Revenue grew 12% in the second half.";
const PDF = { name: "report.pdf", type: "application/pdf", data: Buffer.from(`%PDF-1.7 ${MARK}`).toString("base64") };
const PDF_DOC = { pageCount: 2, pages: [{ n: 1, text: "Annual report", kind: "text", measure: {} }, { n: 2, text: PAGE, kind: "text", measure: {} }] };
const PDF_SHA = createHash("sha256").update(Buffer.from(PDF.data, "base64")).digest("hex");

/** An "always allow" `sh` policy as a person's approval would store it (`docs/spec/POLICIES.md`), shared by the two rows
 *  that need one so the policy a row tests is the same one a control frees an ordinary call with. */
const ALLOW_SH = { id: "p-allow", scope: "global", consumer: "sh", effect: "allow", source: "() => true", label: "allow every sh call", origin: "person", created: 1 };

/** The host's refusal code for each fixture outcome (`put` is the facts call, which refuses before anything is sent). */
const REFUSAL = { "outside-roots": "OutsideRoots", "no-parent": "NoParent", "symlink": "IsSymlink", "protected": "Protected" };

/**
 * A fake host that speaks `put`'s three calls beside the ones `ml.sh.run` needs, and advertises the whole-file cap in
 * `hello` as the real host does. `put` selects what the facts call answers (`"ok"`, or a key of REFUSAL); `commit`
 * what the commit answers (`"ok"` or `"exists"`); `exists` says the target is already on disk. Every call is recorded
 * on `host.calls`, so a row can assert what the host was and was not sent.
 */
function putHost({ put = "ok", commit = "ok", exists = false, max = PUT_MAX, advertise = undefined } = {}) {
    const host = fakeNativeHost();
    const inner = host.onNative;
    host.onNative = (name, e) => {
        const recv = inner(name, {
            send: (m) => e.send(m?.value?.host === "window-ml-host" ? { ...m, value: { ...m.value, put: advertise === undefined ? { max } : advertise } } : m),
            close: (why) => e.close(why),
        });
        if (!recv) return null;
        return (m) => {
            const seq = m.seq, a = m.args ?? {};
            if (m.call === "put") {
                host.calls.push(m);
                if (put !== "ok") return e.send({ seq, error: { code: REFUSAL[put] ?? "Refused", message: `${REFUSAL[put] ?? "Refused"}: ${a.path}` } });
                return e.send({ seq, value: { id: "p1", path: String(a.path ?? "").startsWith("~") ? "/w/home/proj/inbox/report.pdf" : String(a.path ?? ""), root: "/w/proj", rel: "inbox/report.pdf", exists, existingSize: exists ? 7 : 0, size: Number(a.size ?? 0), tilde: String(a.path ?? "").startsWith("~"), expiresInMs: 600000 } });
            }
            if (m.call === "write") {
                host.calls.push(m);
                const b64 = String(a.bytes?.$bytes ?? "");
                return e.send({ seq, value: { id: a.id, received: Number(a.offset ?? 0) + Math.floor((b64.length * 3) / 4) } });
            }
            if (m.call === "commit") {
                host.calls.push(m);
                if (commit !== "ok") return e.send({ seq, error: { code: "Exists", message: `${a.id} appeared after its put` } });
                return e.send({ seq, value: { id: a.id, path: "inbox/report.pdf", rel: "inbox/report.pdf", size: 0, sha256: PDF_SHA } });
            }
            if (m.call === "discard") { host.calls.push(m); return e.send({ seq, value: {} }); }
            return recv(m);
        };
    };
    return host;
}

const callsOf = (host, call) => host.calls.filter((c) => c.call === call);
const puts = (host) => callsOf(host, "put");
const writes = (host) => callsOf(host, "write");
const commits = (host) => callsOf(host, "commit");

/** Every byte string a `write` carried, decoded: the chunk's arg key is the host's, so a row reads them all. */
function wrote(host) {
    const out = [];
    const take = (v) => {
        if (typeof v === "string" && v.length > 8) out.push(Buffer.from(v, "base64").toString("latin1"));
        else if (v && typeof v === "object") for (const x of Object.values(v)) take(x);
    };
    for (const c of writes(host)) take(c.args ?? {});
    return out.join("");
}

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
                await onStep?.(bg, msg.event, asks, state);
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
    /** The run as the worker holds it: what a refusal must judge, rather than the option a test passed. */
    const state = async (id) => (await bg.send({ type: "DUMP_RUN_STATE", payload: { run: hash } }, EXT)).data?.entries?.find((e) => e.id === id)?.value ?? null;
    steps.push({ name: "exec", args: { js: script({ hash, ptr }), world: "isolated" } });
    release();
    for (let i = 0; i < ticks && n <= steps.length; i++) await flush(1);
    await flush(40);
    const last = bg.calls.filter((c) => c.url.includes("/chat/completions") && c.body?.tools).at(-1);
    const results = (last?.body?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
    return { results, bg, hash, ptr, asks, state };
}

/** `ml.sh.put(handle, path)` as the model would write it, answering what it answered or threw. */
const put = (handle, path) => `(async () => { try { return JSON.stringify(await ml.sh.put(${JSON.stringify(handle)}, ${JSON.stringify(path)})); } catch (e) { return JSON.stringify({ threw: e.message, code: e.code }); } })()`;

// --- 0. the fixture: the host is reachable, the run holds the file, and the bytes kept are the person's ---

test("CONTROL: the same harness reaches the host for an ordinary call, so a row's 'nothing sent' is not 'the host was never reachable'", T, async () => {
    const host = putHost();
    const { results } = await runPut({ host, script: () => 'JSON.stringify(await ml.sh.run(["ls"]))' });
    assert.equal(callsOf(host, "spawn").length, 1, `the host was not reached: ${results[0]?.slice(0, 300)}`);
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

// --- 1. the path: in a root or not at all, and the host resolves it ---

test("RED TEAM: a path that leaves the root writes nothing, and the refusal names the root rather than the file", { ...T, todo: "open: the host judges `OutsideRoots` at `put`; the row pins that no chunk is ever sent for `../escape.pdf`, an absolute path or a nested `..`, and that the refusal says so" }, async () => {
    for (const path of ["../escape.pdf", "/etc/escape.pdf", "inbox/../../escape.pdf"]) {
        const host = putHost({ put: "outside-roots" });
        const { results } = await runPut({ host, script: ({ ptr }) => put(ptr, path) });
        assert.deepEqual(writes(host), [], `${path}: a chunk of the file was sent`);
        assert.deepEqual(commits(host), [], `${path}: the file was committed`);
        assert.match(why(answer(results[0])), /OutsideRoots|outside|root|\.\./i, `${path}: the refusal does not say it leaves the root: ${results[0]?.slice(0, 300)}`);
    }
});

test("RED TEAM: a symlinked root cannot carry the write out of it: `IsSymlink` surfaces and nothing is written", { ...T, todo: "open: the host refuses `IsSymlink` at `put`; the row pins that the model sees that refusal, not a success, and that the put is not retried in a loop" }, async () => {
    const host = putHost({ put: "symlink" });
    const { results } = await runPut({ host, script: ({ ptr }) => put(ptr, "inbox/report.pdf") });
    const a = answer(results[0]);
    assert.ok(!a.path, `a refused put was reported as written: ${results[0]?.slice(0, 300)}`);
    assert.match(why(a), /IsSymlink|symlink|link/i, `the host's refusal was not what the model saw: ${results[0]?.slice(0, 300)}`);
    assert.ok(puts(host).length <= 1, `the refused put was retried: ${puts(host).length}`);
    assert.deepEqual(writes(host), [], "a chunk was sent for a symlinked target");
});

test("RED TEAM: a parent that is not there is refused, and the file is not created where the person made no directory", { ...T, todo: "open: the host refuses `NoParent` at `put`; the row pins that the refusal surfaces and no chunk is sent" }, async () => {
    const host = putHost({ put: "no-parent" });
    const { results } = await runPut({ host, script: ({ ptr }) => put(ptr, "nowhere/deep/report.pdf") });
    assert.deepEqual(writes(host), [], "a chunk was sent for a path with no parent");
    assert.match(why(answer(results[0])), /NoParent|no parent|does not exist/i, `the refusal does not name the missing parent: ${results[0]?.slice(0, 300)}`);
});

test("RED TEAM: a `~`-spelled path is the HOST's to resolve: `~/…` lands on the resolved path, and another user's home is refused", { ...T, todo: "open: `put`'s facts carry `path`/`tilde`; the row pins that a `~` path is accepted through those facts and committed at the RESOLVED path, while `~someone/…` is refused with nothing written" }, async () => {
    const home = putHost();
    const r1 = await runPut({ host: home, script: ({ ptr }) => put(ptr, "~/proj/inbox/report.pdf") });
    assert.equal(puts(home).length, 1, `the put never reached the host that resolves the tilde: ${r1.results[0]?.slice(0, 300)}`);
    const committed = commits(home).map((c) => String(c.args?.path ?? ""));
    assert.ok(committed.length > 0, `the tilde path was not committed: ${r1.results[0]?.slice(0, 300)}`);
    assert.ok(committed.every((p) => !p.startsWith("~") && p.startsWith("/")), `a literal ~ was committed: ${JSON.stringify(committed)}`);
    const other = putHost({ put: "outside-roots" });
    const r2 = await runPut({ host: other, script: ({ ptr }) => put(ptr, "~someone/report.pdf") });
    assert.deepEqual(writes(other), [], "another user's home was written to");
    assert.match(why(answer(r2.results[0])), /OutsideRoots|outside|root|~|home/i, `the refusal does not name the other home: ${r2.results[0]?.slice(0, 300)}`);
});

test("RED TEAM: a protected name and a looks-secret target are refused outright: no ask, no chunk, whatever the policy allows", { ...T, todo: "open: `Protected` (sandbox::protected_rels, looks_secret) is refused at `put` and no tier can allow it; the row stores an ALLOW policy that frees an ordinary target and then demands no ask and nothing written for `.git/hooks/pre-commit`, `.git/config`, `.zshrc` and `.env`" }, async () => {
    const local = { ml_policies_global: [ALLOW_SH] };
    // The control this row rests on: the same stored policy frees an ordinary in-root target, so a protected name's "no
    // ask" is the refusal's doing and not a policy that never loaded or never applied.
    const plainHost = putHost();
    const control = await runPut({ host: plainHost, localExtra: local, autoApprove: false, script: ({ ptr }) => put(ptr, "inbox/report.pdf") });
    assert.equal(puts(plainHost).length, 1, `an ordinary put never reached the host: ${control.results[0]?.slice(0, 300)}`);
    assert.deepEqual(control.asks, [], `the stored allow policy did not free an ordinary target, so this row proves nothing: ${JSON.stringify(control.asks)}`);
    assert.ok(commits(plainHost).length > 0, `the allow policy did not free the ordinary commit: ${control.results[0]?.slice(0, 300)}`);
    for (const path of [".git/hooks/pre-commit", ".git/config", ".zshrc", ".env"]) {
        const host = putHost({ put: "protected" });
        const { results, asks } = await runPut({ host, localExtra: local, script: ({ ptr }) => put(ptr, path) });
        assert.deepEqual(writes(host), [], `${path}: a protected name was written`);
        assert.deepEqual(commits(host), [], `${path}: a protected name was committed`);
        assert.deepEqual(asks, [], `${path}: a protected name raised an ask, so a tier could allow it: ${JSON.stringify(asks)}`);
        assert.match(why(answer(results[0])), /Protected|protected|secret/i, `${path}: the refusal does not say it is protected: ${results[0]?.slice(0, 300)}`);
    }
});

// --- 2. the handle: this run's attachment, and nothing else ---

test("RED TEAM: another run's `@file:` handle cannot be named, and the refusal says nothing about that run's file", { ...T, todo: "open: a handle is resolved on THIS run's shelf (the rule `ml.sh.read` keeps for outputs), so a second run's pointer is a miss and never reaches the host" }, async () => {
    const host = putHost();
    const first = await runPut({ host, script: () => "JSON.stringify({ done: true })" });
    const otherPtr = `@file:${fileId(first.hash, 1)}`;
    const second = putHost();
    const { results } = await runPut({ host: second, script: ({ ptr }) => put(otherPtr === ptr ? "@file:0000000" : otherPtr, "inbox/report.pdf") });
    assert.deepEqual(puts(second), [], "another run's attachment reached the host");
    const text = why(answer(results[0]));
    assert.match(text, /ValueMissing|not a file this run holds|another run|no such file/i, `the refusal does not say the handle is not this run's: ${results[0]?.slice(0, 300)}`);
    assert.ok(!text.includes("report.pdf") && !text.includes(PAGE), `the refusal carried the other run's file: ${text.slice(0, 200)}`);
});

test("RED TEAM: the bytes written are the attachment's ORIGINAL bytes, never the PDF's extracted text", { ...T, todo: "open: `put` streams the value-store `bytes` row, so a PDF's page text must never be what reaches the disk" }, async () => {
    const host = putHost();
    const { results } = await runPut({ host, script: ({ ptr }) => put(ptr, "inbox/report.pdf") });
    assert.ok(writes(host).length > 0, `nothing was written: ${results[0]?.slice(0, 300)}`);
    const text = wrote(host);
    assert.ok(text.includes(MARK), `the write did not carry the attachment's own bytes: ${JSON.stringify(text.slice(0, 120))}`);
    assert.ok(!text.includes(PAGE), "the write carried the PDF's extracted text instead of its bytes");
});

// --- 3. writing is judged: an existing file asks, even where an allow policy covers the call ---

test("RED TEAM: an existing file asks the person, and no allow policy commits over it without the answer", { ...T, todo: "open: `put`'s facts carry `exists`, the ask is raised before any commit, and `replace` is true only after the person says yes" }, async () => {
    const host = putHost({ exists: true });
    const allow = { id: "p-allow", scope: "global", consumer: "sh", effect: "allow", source: "() => true", label: "allow every call", origin: "person", created: 1 };
    let atAsk = null;
    const { results } = await runPut({
        host, localExtra: { ml_policies_global: [allow] }, autoApprove: false,
        script: ({ ptr }) => put(ptr, "inbox/report.pdf"),
        onStep: (bg, ev, seen) => {
            const a = seen.find((x) => x.state === "pending");
            if (!a || atAsk) return;
            atAsk = { commits: commits(host).length, replaces: commits(host).filter((c) => c.args?.replace === true).length, ask: a };
            void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, ask: a.id, decision: true } });
        },
    });
    assert.ok(atAsk, `no ask was raised for an existing file, even under an allow policy: ${results[0]?.slice(0, 300)}`);
    assert.equal(atAsk.replaces, 0, "the file was replaced before the person answered");
    assert.ok(commits(host).some((c) => c.args?.replace === true), `the person's answer did not lead to a replacing commit: ${results[0]?.slice(0, 300)}`);
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
    assert.deepEqual(puts(host), [], "the hand-posted put reached the host");
});

test("RED TEAM: a run started over the hub is refused at the worker, and the run really is marked remote", { ...T, todo: "open: refused on both sides — the worker reads the RUN's `origin.remote` (not the option a test passes) and says the file would land on a machine the person is not at; the host's half (async/put in window-ml-host) answers Refused/scope to put, write and commit before reading an argument, and is covered there" }, async () => {
    const host = putHost();
    let live = null;
    const { results } = await runPut({
        host, sender: { remote: true }, script: ({ ptr }) => put(ptr, "inbox/report.pdf"),
        // Read WHILE the turn runs: `run.input` is dropped at turn end, so a read after it would be "unknown", not "not remote".
        onStep: async (bg, ev, seen, state) => { live ??= await state("run.input"); },
    });
    assert.equal(live?.origin?.remote, true, `the run is not marked remote, so this row is not about the hub: ${JSON.stringify(live?.origin)}`);
    assert.deepEqual(puts(host), [], "a run from another machine reached this one with a put");
    assert.match(why(answer(results[0])), /another device|remote|hub|machine|not at/i, `the refusal does not say where the file was going: ${results[0]?.slice(0, 300)}`);
});

// --- 5. the bounds: a file over the advertised cap is refused before anything is sent ---

test("RED TEAM: a file over the host's advertised cap is refused by the worker, naming the size and the cap, with no chunk sent", { ...T, todo: "open: `hello` advertises `put: { max }` (64 MiB first); the worker refuses over it before the first `write`, and the sentence names both numbers" }, async () => {
    const big = { name: "big.pdf", type: "application/pdf", data: Buffer.alloc(300 * 1024, 0x41).toString("base64") };
    const host = putHost({ max: PUT_MAX });
    const { results } = await runPut({ host, files: [big], script: ({ ptr }) => put(ptr, "inbox/big.pdf") });
    // Whether the facts call happens before the check is the implementation's to choose (async: "before the first
    // `write`"); what must not happen is a chunk or a commit.
    assert.deepEqual(writes(host), [], "an over-cap file sent a chunk");
    assert.deepEqual(commits(host), [], "an over-cap file was committed");
    const text = why(answer(results[0]));
    assert.match(text, /262144|256\s?KiB|256\s?KB/i, `the refusal does not name the cap: ${results[0]?.slice(0, 300)}`);
    assert.match(text, /307200|300\s?KiB|300\s?KB/i, `the refusal does not name the file's size: ${results[0]?.slice(0, 300)}`);
});

test("RED TEAM: a host that does not advertise `put` gets no bytes at all", { ...T, todo: "open: `hello` reports `put: { max }` natively and `put: null` over the hub (as `register` is false there); a worker that cannot see a cap must not attempt the write, and must say the host cannot take a file" }, async () => {
    const host = putHost({ advertise: null });
    const { results } = await runPut({ host, script: ({ ptr }) => put(ptr, "inbox/report.pdf") });
    assert.deepEqual(puts(host), [], "a host that advertises no `put` was still offered a file");
    assert.deepEqual(writes(host), [], "a host that advertises no `put` was sent a chunk");
    assert.match(why(answer(results[0])), /cannot take|can't take|does not support|doesn't support|no put|older/i, `the refusal does not say the host cannot take a file: ${results[0]?.slice(0, 300)}`);
});

test("RED TEAM: a file bigger than one chunk is sent as contiguous chunks the host's cap allows, and their join is the file", { ...T, todo: "open: the host owns the chunk cap (512 KiB, PROTOCOL's `store::MAX_READ`) and the worker splits, so no chunk exceeds it, the offsets are contiguous from 0, and the concatenation hashes to the attachment — a truncating or overlapping split must not pass as a written file" }, async () => {
    const bytes = Buffer.alloc(700 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const big = { name: "big.pdf", type: "application/pdf", data: bytes.toString("base64") };
    const host = putHost({ max: 2 * 1024 * 1024 });
    const { results } = await runPut({ host, files: [big], script: ({ ptr }) => put(ptr, "inbox/big.pdf") });
    const w = writes(host);
    assert.ok(w.length >= 2, `a file past one chunk was sent as ${w.length} write(s): ${results[0]?.slice(0, 300)}`);
    const chunk = (c) => { let out = null; const take = (v) => { if (out === null && typeof v === "string" && v.length > 8) out = Buffer.from(v, "base64"); else if (v && typeof v === "object") for (const x of Object.values(v)) take(x); }; take(c.args ?? {}); return out; };
    let offset = 0;
    const parts = [];
    for (const c of w) {
        const b = chunk(c);
        assert.ok(b, "a write carried no bytes");
        assert.ok(b.length <= 512 * 1024, `a chunk was ${b.length} bytes, past the host's 512 KiB cap`);
        assert.equal(Number(c.args?.offset ?? -1), offset, `a chunk started at ${c.args?.offset}, not ${offset}`);
        offset += b.length;
        parts.push(b);
    }
    const joined = Buffer.concat(parts);
    assert.equal(joined.length, bytes.length, `the join is ${joined.length} bytes, not the file's ${bytes.length}`);
    assert.equal(createHash("sha256").update(joined).digest("hex"), createHash("sha256").update(bytes).digest("hex"), "the join is not the file");
});
