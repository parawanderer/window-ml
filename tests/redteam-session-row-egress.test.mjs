// redteam-session-row-egress.test.mjs — a session row (SessionSummary) as it leaves the worker, adversarially
// (SECRET_HANDLES.md, "A session row leaves the worker scrubbed", ruling 61). The lane's own rows
// (tests/session-row-scrub.test.mjs) hold the scrub function by field and the server's exits; these ask of the WORKER
// what a page, a device and the Settings panel can still make it hand out: the storage report's titles, the cold
// window before the registry's first read, a search as a guess oracle, and a page-origin client on the sessions port.
//
// The property, in one line: no string of a session row leaves the worker holding a registered VALUE — not to the
// chat page, not to a hub sink, not to the Settings panel, and not to a page that opens the port. Every row keeps a
// positive control (the row itself did arrive, so "sent nothing" is a failure and not a pass).
//
// WHAT THIS FILE DOES NOT ROW: the hub's sinks and its list (sessionServer.shownList is the lane's), the archived row
// and its snippet (the archive is SQLite behind the offscreen document, which node has no store for; the command
// scrubs the archived row and its snippet with the live one in session-commands.ts, held by the lane's rows), and a
// row's field no build names yet (the lane's fullRow covers a `currentPage` the worker never writes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadBackground, jsonResponse } = require("./helpers");
const { rowForEgress } = await import("../src/session/session-row-scrub.ts");
const { registrySubs } = await import("../src/secret-registry.ts");

const VALUE = "tok-7c1e9a4b8d2f6031";
const MARK = "[REDACTED:API_TOKEN]";
/** The front of the value: a partial match would still confirm a guess, so it must not appear either. */
const FRONT = VALUE.slice(0, 8);
const leaks = (v) => JSON.stringify(v ?? null).includes(VALUE) || JSON.stringify(v ?? null).includes(FRONT);
const holds = (v, what) => JSON.stringify(v ?? null).includes(what);
const T = { timeout: 30000 };
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await tick(); };

const config = { chatUrl: "http://llm.test/api/chat/completions", apiKey: "sk-test", model: "m", apiFormat: "openai" };
const REG = { ml_secret_registry: [{ name: "API_TOKEN", value: VALUE }] };
const EXT = { url: "chrome-extension://test/chat.html" };
const tab = (id, url) => ({ tab: { id, url, title: `Token ${VALUE}` }, url });
const start = (hash, task) => ({ kind: "agent", id: `${hash}-0`, ts: 1, save: false, session: { hash, turn: 0 }, task, model: "m", maxSteps: 5, config: null });
const result = (hash) => ({ kind: "agent-result", id: `${hash}-1`, ts: 3, save: false, session: { hash, turn: 0 }, result: "done" });

/** An extension page on the sessions port, subscribed to the index. */
function openPage(bg) {
    const port = bg.connect("ml-sessions", EXT);
    port.send({ type: "sessions" });
    let id = 0;
    const cmd = async (command) => {
        const my = ++id;
        port.send({ type: "cmd", id: my, command });
        for (let i = 0; i < 200; i++) { const r = port.messages.find((m) => m.type === "result" && m.id === my); if (r) return r.result; await tick(); }
        return null;
    };
    return { port, cmd };
}

// --- the Settings panel: the storage report's own titles ---

test("RED TEAM (#2008): the Settings storage report's largest-session titles cross the row scrub", T, async () => {
    // THE guard row for `storageReport`'s `largest` titles: the lane's fix scrubs them and writes no row of its own for
    // this exit, so this one pins it. Its sibling `sessionStorageStats` (the "Measure exactly" answer) reads the same
    // stored summaries and scrubs them, which is the contrast below and what made the miss visible.
    const { IDBFactory } = await import("fake-indexeddb");
    const bg = loadBackground({ config, indexedDB: new IDBFactory(), local: REG });
    await settle();
    bg.context.__mlKeepSessionForTest("abcd0020");
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("abcd0020", `log in with ${VALUE}`) }, tab(9, "https://site.example/"));
    void bg.send({ type: "ML_DEBUG_EVENT", event: result("abcd0020") }, tab(9, "https://site.example/"));
    await settle();
    // The person's own title, saved with the row: the title is made by them, so it holds whatever they typed.
    const page = openPage(bg);
    const renamed = await page.cmd({ type: "session.rename", session: { runtime: "local", hash: "abcd0020" }, title: `see ${VALUE} now` });
    assert.ok(holds(renamed, "see "), `positive control: the rename was accepted, got ${JSON.stringify(renamed)}`);
    await settle();
    const report = await bg.send({ type: "STORAGE_HISTORY" }, EXT);
    assert.ok(report && !report.error, `positive control: the Settings Storage section is answered, got ${JSON.stringify(report)}`);
    const mine = (report.data?.largest ?? []).filter((r) => r.hash === "abcd0020");
    assert.equal(mine.length, 1, `positive control: the saved session is among the largest, got ${JSON.stringify(report.data?.largest)}`);
    assert.equal(leaks(report.data), false, `the report hands a client the registered value: ${JSON.stringify(report.data?.largest)}`);
    assert.equal(mine[0].title, `see ${MARK} now`, `the title is the person's, with the marker where the value was: ${JSON.stringify(mine[0])}`);
    // The sibling "Measure exactly" answer reads the same rows from disk and scrubs them: the contrast that shows the
    // report's list is the one that was missed.
    const exact = await bg.send({ type: "SESSION_STORAGE_STATS" }, EXT);
    assert.ok(exact && !exact.error, `positive control: the measure answer is answered, got ${JSON.stringify(exact)}`);
    assert.equal(leaks(exact.data), false, `the exact measure answer holds the value: ${JSON.stringify(exact.data)}`);
});

// --- the cold window: before the registry's first read ---

test("RED TEAM (#2008): a page that attaches before the registry's first read is never sent the value, and is sent the row scrubbed once it can be", T, async () => {
    const bg = loadBackground({ config, local: REG });
    // The page attaches in the worker's first moments: the snapshot may be withheld, and must never carry the value.
    const page = openPage(bg);
    bg.context.__mlKeepSessionForTest("abcd0021");
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("abcd0021", `log in with ${VALUE}`) }, tab(9, `https://site.example/?key=${VALUE}`));
    await settle(80);
    assert.equal(leaks(page.port.messages), false, `a message to the page holds the value: ${JSON.stringify(page.port.messages).slice(0, 600)}`);
    const rows = page.port.messages.filter((m) => m.type === "index").flatMap((m) => m.update.type === "snapshot" ? m.update.sessions : m.update.type === "upsert" ? [m.update.session] : []).filter((s) => s.id?.hash === "abcd0021");
    assert.ok(rows.length, "positive control: the row itself was sent (a withheld window is re-sent once the registry is read)");
    assert.equal(rows.at(-1).task, `log in with ${MARK}`, `the row the page holds, once scrubbed: ${JSON.stringify(rows.at(-1))}`);
    assert.ok(!holds(rows.at(-1).page, VALUE), "the page URL is scrubbed with the task");
});

// --- search as a guess oracle ---

test("RED TEAM (#2008): a search cannot confirm a guessed value, whole or in part, and a search's snippet is scrubbed", T, async () => {
    const bg = loadBackground({ config, local: REG });
    await settle();
    const page = openPage(bg);
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("abcd0022", `log in with ${VALUE}`) }, tab(9, "https://site.example/"));
    await settle();
    for (const query of [VALUE, FRONT, `with ${FRONT}`]) {
        const found = await page.cmd({ type: "sessions.search", runtime: "local", query });
        assert.equal(holds(found, "abcd0022"), false, `the query ${JSON.stringify(query)} found the session: ${JSON.stringify(found)}`);
        assert.equal(leaks(found), false, `the answer holds the value: ${JSON.stringify(found)}`);
    }
    // Positive control: the words around the value still match, and the snippet a page gets is scrubbed.
    const byWords = await page.cmd({ type: "sessions.search", runtime: "local", query: "log in" });
    assert.ok(holds(byWords, "abcd0022"), `positive control: the session is found by its own words, got ${JSON.stringify(byWords)}`);
    assert.equal(leaks(byWords), false, `the snippet holds the value: ${JSON.stringify(byWords)}`);
    assert.ok(holds(byWords, MARK), `the snippet holds the marker: ${JSON.stringify(byWords)}`);
});

// --- the port itself: a page-origin client ---

test("RED TEAM (#2008): a page that opens the sessions port is disconnected and gets no row", T, async () => {
    const bg = loadBackground({ config, local: REG });
    await settle();
    bg.context.__mlKeepSessionForTest("abcd0023");
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("abcd0023", `log in with ${VALUE}`) }, tab(9, "https://site.example/"));
    await settle();
    const pageOrigin = bg.connect("ml-sessions", { url: "https://site.example/", tab: { id: 9, url: "https://site.example/" } });
    pageOrigin.send({ type: "sessions" });
    await settle();
    assert.equal(pageOrigin.wasDisconnected(), true, "the worker closes a page's sessions port");
    assert.deepEqual(pageOrigin.messages, [], "a page gets no index, scrubbed or not");
    // Positive control: the same worker answers an extension page, so the port and the index are alive.
    const page = openPage(bg);
    await settle();
    assert.ok(holds(page.port.messages, "abcd0023"), `positive control: an extension page is served, got ${JSON.stringify(page.port.messages).slice(0, 300)}`);
    assert.equal(leaks(page.port.messages), false, "the extension page's rows hold no value either");
});

// --- side.call, purpose title: the name a client is told ---
//
// A paired phone asks `side.call` for a session's title, and the command hands the answer of `deps.title` back as it
// is (session-commands.ts, "side.call"). That dep is `titleSession`, which returns the index's stored title — the
// person's rename, or the one the utility model made from a task — so the answer is only as scrubbed as its exit makes
// it. The port is this harness's reachable ingress; the hub's `runSessionCommand(c, { via: "hub" })` ends at the same
// handler and the same dep, so a phone reads exactly this answer.

test("RED TEAM (#2008): side.call asks for a person-set title and is handed the title raw", T, async () => {
    const bg = loadBackground({ config: { ...config, utilityModel: "tiny" }, local: REG });
    await settle();
    const page = openPage(bg);
    bg.context.__mlKeepSessionForTest("abcd0024");
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("abcd0024", "log in") }, tab(9, "https://site.example/"));
    await settle();
    // The person's own name for the session, typed with the value in it.
    const renamed = await page.cmd({ type: "session.rename", session: { runtime: "local", hash: "abcd0024" }, title: `see ${VALUE} now` });
    assert.ok(holds(renamed, "see "), `positive control: the rename was accepted, got ${JSON.stringify(renamed)}`);
    const asked = await page.cmd({ type: "side.call", runtime: "local", purpose: "title", session: { runtime: "local", hash: "abcd0024" }, messages: [{ role: "user", content: "name this" }], maxTokens: 32 });
    assert.ok(holds(asked, "see "), `positive control: the ask was answered with the session's title, got ${JSON.stringify(asked)}`);
    assert.equal(leaks(asked), false, `side.call hands the caller the person's title raw: ${JSON.stringify(asked)}`);
    assert.ok(holds(asked, MARK), `the person's words survive with the value as its marker: ${JSON.stringify(asked)}`);
});

test("RED TEAM (#2008): a title the model made from a task before the value was registered is handed out raw afterwards", T, async () => {
    const bg = loadBackground({
        config: { ...config, utilityModel: "tiny" },
        onFetch: () => jsonResponse({ choices: [{ message: { content: `Log in with ${VALUE}` } }] }),
    });
    await settle();
    const page = openPage(bg);
    bg.context.__mlKeepSessionForTest("abcd0025");
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("abcd0025", `log in with ${VALUE}`) }, tab(9, "https://site.example/"));
    await settle();
    const made = await bg.send({ type: "SESSION_TITLE", payload: { hash: "abcd0025", messages: [{ role: "user", content: `name this: log in with ${VALUE}` }] } }, EXT);
    assert.ok(holds(made, "Log in"), `positive control: a title was made from the task, got ${JSON.stringify(made)}`);
    // The value is registered AFTER the title was stored: the index keeps the title raw and scrubs it at each exit.
    bg.setLocal(REG);
    await settle();
    const asked = await page.cmd({ type: "side.call", runtime: "local", purpose: "title", session: { runtime: "local", hash: "abcd0025" }, messages: [{ role: "user", content: "name this" }], maxTokens: 32 });
    assert.ok(holds(asked, "Log in"), `positive control: the stored title was handed back, got ${JSON.stringify(asked)}`);
    assert.equal(leaks(asked), false, `side.call hands out the title stored before the registration: ${JSON.stringify(asked)}`);
    assert.ok(holds(asked, MARK), `the title's own words survive, the value as its marker: ${JSON.stringify(asked)}`);
});

// --- the scrub's depth: a text nested past it ---

test("RED TEAM (#2008): a text nested past the scrub's depth is refused, not handed out raw", () => {
    // `scrubLeaves` walks `depth` levels and, past them, returns the object whole (`depth < 0`), so every string under
    // it crosses unscrubbed. The row type has no field that deep today; the property is the scrub's, and the lane's
    // fix refuses at that point rather than passing the subtree through. A refusal (a throw) hands nothing out, which
    // is the same pass as a withheld string.
    const SUBS = registrySubs([{ name: "API_TOKEN", value: VALUE }]);
    const deep = (n) => { let v = VALUE; for (let i = 0; i < n; i++) v = { [`n${i}`]: v }; return v; };
    const base = { id: { runtime: "local", hash: "abcd0030" }, kind: "agent", status: "done", model: "m" };
    // Positive control: within the depth the text IS scrubbed, so the walk and the registry are alive.
    assert.ok(!holds(rowForEgress({ ...base, extra: { a: { b: VALUE } } }, SUBS), VALUE), "control: a text within the depth is scrubbed");
    for (const extra of [deep(6), [deep(6)], { a: [{ b: { c: [{ d: VALUE }] } }] }]) {
        let out;
        try { out = rowForEgress({ ...base, extra }, SUBS); } catch { continue; }   // refused: nothing was handed out
        assert.equal(leaks(out), false, `a text beyond the scrub's depth is handed out raw: ${JSON.stringify(out)}`);
    }
});

// --- the scrub's KEYS: a registered value used as one is text too ---

const rowBase = { id: { runtime: "local", hash: "abcd0031" }, kind: "agent", status: "done", model: "m", title: "a title" };

test("RED TEAM (#2008): a registered value used as a KEY of a nested field is scrubbed like text", () => {
    // A tool or an index that groups by page-supplied text (a header, a device name, a page title) puts a value in a
    // KEY, and JSON keeps keys as keys. Every exit sends the row as JSON, so a key is a string a client reads.
    const SUBS = registrySubs([{ name: "API_TOKEN", value: VALUE }]);
    const out = rowForEgress({ ...rowBase, extra: { [VALUE]: ["row"], plain: VALUE } }, SUBS);
    assert.equal(leaks(out), false, `a key is handed out raw: ${JSON.stringify(out)}`);
    assert.ok(Object.hasOwn(out.extra, MARK), `the key is scrubbed to the marker: ${JSON.stringify(out.extra)}`);
    assert.ok(holds(out.extra, MARK), "control: the value in a leaf is scrubbed too");
});

test("RED TEAM (#2008): two keys that scrub to one text keep both values, numbered", () => {
    // A key already written as the marker beside the value it names: after the scrub both read the same, and a copy
    // that kept only one would report to the person that half their data vanished.
    const SUBS = registrySubs([{ name: "API_TOKEN", value: VALUE }]);
    const out = rowForEgress({ ...rowBase, extra: { [MARK]: "first", [VALUE]: "second" } }, SUBS);
    assert.equal(leaks(out), false, JSON.stringify(out));
    assert.deepEqual(Object.values(out.extra).sort(), ["first", "second"], `both values survive: ${JSON.stringify(out.extra)}`);
    assert.equal(Object.keys(out.extra).length, 2, "under two keys");
});

test("RED TEAM (#2008): a __proto__ key stays a key and does not become the copy's prototype", () => {
    // A row built from parsed JSON can carry an own "__proto__" (JSON.parse makes one); a copy written with `out[k] =`
    // would set the prototype instead, silently losing the field and poisoning every lookup on the copy.
    const SUBS = registrySubs([{ name: "API_TOKEN", value: VALUE }]);
    const extra = JSON.parse(`{"__proto__": {"polluted": ${JSON.stringify(VALUE)}}, "ok": 1}`);
    const out = rowForEgress({ ...rowBase, extra }, SUBS);
    assert.equal(leaks(out), false, JSON.stringify(out));
    assert.equal(Object.getPrototypeOf(out.extra), Object.prototype, "the copy's prototype is untouched");
    assert.ok(Object.hasOwn(out.extra, "__proto__"), "the key survives as data");
    assert.equal(out.extra.polluted, undefined, "and nothing it held became an inherited field");
});

test("RED TEAM (#2008): past the depth, a subtree whose KEY the scrub would change is dropped, and a plain one is kept", () => {
    const SUBS = registrySubs([{ name: "API_TOKEN", value: VALUE }]);
    const at = (leaf) => { let v = leaf; for (let i = 0; i < 5; i++) v = { [`n${i}`]: v }; return v; };
    // Control: a plain-keyed, text-free subtree past the depth is data, and is kept.
    const kept = rowForEgress({ ...rowBase, extra: at({ a: 1 }) }, SUBS);
    assert.equal(assertKept(kept, "extra"), true, "control: a text-free plain subtree is kept");
    // A value used as a key past the depth is text the walk cannot reach: withheld, never sent as it is.
    const out = rowForEgress({ ...rowBase, extra: at({ [VALUE]: 1 }) }, SUBS);
    assert.equal(leaks(out), false, `a key past the depth is handed out: ${JSON.stringify(out)}`);
    // And a text VALUE past the depth, which the previous section covers, stays withheld.
    assert.equal(leaks(rowForEgress({ ...rowBase, extra: at({ a: VALUE }) }, SUBS)), false);
});

/** Whether the row still carries `extra` (the control's own field, not a withheld one). */
function assertKept(row, field) {
    return row && typeof row === "object" && row[field] !== undefined;
}

test("RED TEAM (#2008): with no substitutions to trust, a key is kept only in a schema's shape", () => {
    // With no subs every string is withheld, so an object whose fields are all text empties and is dropped whole.
    const out = rowForEgress({ ...rowBase, extra: { plain: "x", [VALUE]: "y", "has space": "z" } }, null);
    assert.equal(leaks(out), false, `a key is handed out with no subs: ${JSON.stringify(out)}`);
    assert.equal(out.extra, undefined, "an object emptied by the scrub is nothing to send");
    // With data that survives (numbers), only the schema-shaped KEY keeps its entry.
    const data = rowForEgress({ ...rowBase, extra: { plain: 1, [VALUE]: 2, "has space": 3 } }, null);
    assert.equal(leaks(data), false, `a key is handed out with no subs: ${JSON.stringify(data)}`);
    assert.equal(Object.keys(data.extra).join(","), "plain", "a schema-shaped key is kept, the others' entries are dropped");
    // The stated residue, pinned: a registered value that itself has a schema key's shape survives as a key on this
    // path (SECRET_HANDLES.md, the stored scrub's known limits). The row asserts TODAY's behaviour, so a repair that
    // removes the residue has to change this row deliberately.
    const shaped = "plugsecretword";
    const residue = rowForEgress({ ...rowBase, extra: { [shaped]: 1 } }, null);
    assert.ok(Object.hasOwn(residue.extra, shaped), "the residue: a schema-shaped value used as a key survives with no subs");
});
