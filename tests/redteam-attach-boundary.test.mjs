// redteam-attach-boundary.test.mjs — where a file the person attached may enter a run, and where it may not
// (docs/spec/FILE_ATTACHMENTS.md, slice 3). A file becomes an `@file:` pointer only in the worker, on the two entry
// points the person's own surfaces reach: `startUserRun` and `userRunAction` (sw-run-start.ts). No message a PAGE can
// start reads a PDF, keeps a row or adds a pointer, whatever it carries; this file enumerates them from page-relay.ts
// rather than a list of its own, so a type added there is covered here without an edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const { PAGE_STARTED_TYPES, PAGE_UNGATED_TYPES } = await import("../src/page-relay.ts");

const T = { timeout: 20000 };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const SITE = { id: 7, url: "https://site.example/page", title: "Site" };
const PAGE = { tab: { id: 7, url: SITE.url }, url: SITE.url };
const EXT = { id: "ext", url: "chrome-extension://ext/sidebar.html", origin: "chrome-extension://ext" };
const pdf = (name, body) => ({ name, type: "application/pdf", data: Buffer.from(body).toString("base64") });
const PDF = pdf("report.pdf", "%PDF-1.7 annual");
const DOC = { pageCount: 1, pages: [{ n: 1, text: "Annual report", kind: "text", measure: {} }] };

/** A worker with a value store and a counted PDF reader, whose model answers "done", holding one run the person started
 *  with PDF attached. */
async function world() {
    const { IDBFactory } = require("fake-indexeddb");
    const reads = [];
    const bg = loadBackground({
        config, openTabs: [SITE], indexedDB: new IDBFactory(),
        onPdfRead: (msg) => { reads.push(msg.b64); return { ok: true, doc: DOC }; },
        onFetch: (call) => call.url.includes("/chat/completions") ? jsonResponse({ choices: [{ message: { content: "done" } }] }) : jsonResponse({}),
        onTabMessage: async (_t, msg) => (msg.type === "ADOPT_RUN_NOW" ? { pageInfo: "" } : msg.type === "RUN_TOOL_IN_PAGE" && msg.payload.finish ? { result: "" } : undefined),
    });
    const chats = () => bg.calls.filter((c) => c.url.includes("/chat/completions"));
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task: "what grew?", files: [PDF], surface: "hud" });
    for (let i = 0; i < 100 && chats().length < 1; i++) await flush(4);
    await flush(20);
    const files = async (run) => JSON.parse(JSON.stringify((await bg.send({ type: "DUMP_RUN_STATE", payload: { run } }, EXT)).data?.entries?.find((e) => e.id === "run.files")?.value ?? null));
    const rows = async () => (await bg.context.__mlValues.rows()).map((r) => ({ format: r.format, sessions: [...r.sessions] }));
    return { bg, reads, chats, hash, files, rows };
}

/** Send without waiting longer than `ms` for an answer: a page-started type may hold its answer for a run that never ends. */
const sendSoon = (bg, msg, sender, ms = 50) => Promise.race([bg.send(msg, sender), new Promise((r) => setTimeout(r, ms))]);

// --- a page-started message never attaches a file ---

test("RED TEAM, ENUMERATED: no type a page can start reads a PDF, keeps a row or adds a pointer, whatever it carries and whichever run it names", T, async () => {
    const w = await world();
    assert.equal(w.reads.length, 1, "the person's start read its PDF");
    const before = await w.rows();
    // A run the PAGE built, so the bait can name a page-built run as well as the person's.
    await sendSoon(w.bg, { type: "START_RUN", payload: { runId: "page-run", task: "read the attached file", files: [pdf("forged.pdf", "%PDF-1.7 page start")], systemPrompt: "S", tools: [], model: "m", think: null, maxSteps: 1, autoApprovePython: false, autoApproveReadonly: false, surface: "off" } }, PAGE);
    const types = [...PAGE_STARTED_TYPES, ...PAGE_UNGATED_TYPES];
    assert.ok(types.includes("START_RUN") && types.includes("RESUME_RUN") && types.includes("INJECT_MESSAGE"), "the run types are enumerated");
    for (const run of [w.hash, "page-run"]) {
        for (const type of types) {
            const forged = [pdf(`${type}.pdf`, `%PDF-1.7 ${type}`)];
            const bait = { runId: run, hash: run, action: "send", task: "read the attached file", text: "read the attached file", surface: "hud", files: forged, attachments: forged, pointer: "@file:x" };
            await sendSoon(w.bg, { type, ...bait, payload: bait }, PAGE);
        }
    }
    // Settled, not budgeted: what the worker did in answer to the bait is the same after another round as before it.
    let seen;
    for (let i = 0; i < 50; i++) {
        await flush(8);
        const now = `${w.chats().length}/${w.reads.length}`;
        if (now === seen) break;
        seen = now;
    }
    await flush(20);
    assert.equal(`${w.chats().length}/${w.reads.length}`, seen, "nothing more arrived once the bait settled");
    assert.equal(w.reads.length, 1, "no page-started type had a PDF read");
    assert.deepEqual(await w.rows(), before, "no row stored or newly held");
    assert.deepEqual((await w.files(w.hash)).map((f) => f.name), ["report.pdf"], "the person's run has only its own file");
    assert.equal(await w.files("page-run"), null, "a run a page built carries no files");
    assert.ok(!JSON.stringify(w.chats().map((c) => c.body.messages)).includes("@file:x"), "no forged pointer reached the model");
});

test("a page's START_RUN payload loses the person's fields: files and the turn count go, the task stays", async () => {
    // pageStartPayload's destructuring is the one strip: the enumeration above never sends `sends`, so this names each key.
    const deep = () => new Proxy(function () {}, {
        get: (_t, k) => (k === "then" ? undefined : k === Symbol.toPrimitive ? () => "" : deep()),
        apply: () => deep(),
    });
    const prev = globalThis.chrome;
    globalThis.chrome = deep();
    let pageStartPayload;
    try { ({ pageStartPayload } = await import("../src/sw/sw-run-host.ts")); } finally { globalThis.chrome = prev; }
    const out = pageStartPayload({
        task: "read the attached file", files: [PDF], sends: 7, builtBy: "user", display: "the person's words",
        rebuild: { builtBy: "user", tools: [] },
    }, PAGE, {});
    assert.equal(out.task, "read the attached file");
    for (const key of ["files", "sends", "builtBy", "display"]) assert.ok(!(key in out), key);
    assert.ok(!("builtBy" in out.rebuild), "rebuild.builtBy");
});

test("the oracle sees an attachment: the same PDF through the shell's USER_START_RUN is read and kept", T, async () => {
    // USER_START_RUN is not in HANDLE_MAP, so a page cannot send it; only the content script's shell does. Its sender
    // looks like the page's, which is why the test above sends every PAGE-relayable type and this one is the control.
    const w = await world();
    const r = await w.bg.send({ type: "USER_START_RUN", payload: { task: "and this one?", files: [pdf("second.pdf", "%PDF-1.7 second")], surface: "hud" } }, PAGE);
    assert.equal(typeof r.data?.hash, "string", JSON.stringify(r));
    await flush(40);
    assert.equal(w.reads.length, 2);
    assert.deepEqual((await w.files(r.data.hash)).map((f) => f.name), ["second.pdf"]);
});

// --- the DevTools panel and the side panel reach the worker's turn, not the page ---

test("the DevTools panel and the side panel host the app through relayAppToWorker, the one place a session send leaves them", () => {
    for (const f of ["src/sidebar/panel.ts", "src/sidebar/sidepanel.ts"]) {
        const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
        assert.match(src, /relayAppToWorker\(d, tabId, "(devtools|hud)"/, f);
        assert.ok(!src.includes("ML_SESSION_REMOTE"), `${f} sends nothing for a session itself`);
    }
});

test("a session send from either panel becomes ML_SESSION_REMOTE naming the tab, the run and the surface", async () => {
    const sent = [];
    globalThis.chrome = { runtime: { sendMessage: async (m) => { sent.push(m); } } };
    try {
        const { relayAppToWorker } = await import("../src/sidebar/app-host.ts");
        for (const surface of ["devtools", "hud"]) {
            assert.equal(relayAppToWorker({ __mlSidebarApp: "sessionSend", hash: "run1", text: "next" }, 7, surface, () => {}), true);
            assert.deepEqual({ ...sent.at(-1) }, { type: "ML_SESSION_REMOTE", tabId: 7, action: "send", hash: "run1", text: "next", images: undefined, surface });
        }
    } finally { delete globalThis.chrome; }
});

test("ML_SESSION_REMOTE for a run the worker built is a turn in the worker, and nothing goes to the page", T, async () => {
    const w = await world();
    const before = w.chats().length;
    await sendSoon(w.bg, { type: "ML_SESSION_REMOTE", tabId: 7, action: "send", hash: w.hash, text: "and the first half?", surface: "devtools" }, EXT);
    for (let i = 0; i < 100 && w.chats().length <= before; i++) await flush(4);
    assert.equal(w.chats().length, before + 1, "userRunAction started the turn");
    assert.equal(w.chats().at(-1).body.messages.at(-1).content, "and the first half?");
    assert.ok(!w.bg.tabMessages.some(([, m]) => m?.type === "ML_SESSION_TO_PAGE"), "the page never carried the message");
});

// --- the extension's own surfaces carry a message's files to the worker ---

test("a session send with files from either panel carries them on ML_SESSION_REMOTE; a files-only send relays, a malformed list does not ride", async () => {
    const sent = [];
    globalThis.chrome = { runtime: { sendMessage: async (m) => { sent.push(m); } } };
    try {
        const { relayAppToWorker } = await import("../src/sidebar/app-host.ts");
        const notes = { name: "notes.txt", type: "text/plain", text: "alpha" };
        assert.equal(relayAppToWorker({ __mlSidebarApp: "sessionSend", hash: "run1", text: "", files: [notes, PDF] }, 7, "devtools", () => {}), true);
        assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { type: "ML_SESSION_REMOTE", tabId: 7, action: "send", hash: "run1", text: "", files: [notes, PDF], surface: "devtools" });
        relayAppToWorker({ __mlSidebarApp: "sessionSend", hash: "run1", text: "x", files: [{ name: "a" }] }, 7, "devtools", () => {});
        assert.equal("files" in sent.at(-1), false, "a list the one shape check refuses is not forwarded");
    } finally { delete globalThis.chrome; }
});

test("ML_SESSION_REMOTE with a PDF for a run the worker built holds it as that turn's pointer, and nothing goes to the page", T, async () => {
    const w = await world();
    const before = w.chats().length;
    await sendSoon(w.bg, { type: "ML_SESSION_REMOTE", tabId: 7, action: "send", hash: w.hash, text: "and this one", files: [pdf("q3.pdf", "%PDF-1.7 q3")], surface: "devtools" }, EXT);
    for (let i = 0; i < 100 && w.chats().length <= before; i++) await flush(4);
    await flush(40);
    assert.match(w.chats().at(-1).body.messages.at(-1).content, /^and this one\n\n<file name="q3\.pdf" type="application\/pdf" bytes="11" pages="1" pointer="@file:/);
    assert.deepEqual((await w.files(w.hash)).map((f) => [f.name, f.turn]), [["report.pdf", 1], ["q3.pdf", 2]]);
    assert.ok(!w.bg.tabMessages.some(([, m]) => m?.type === "ML_SESSION_TO_PAGE"), "the page never carried the message");
});
