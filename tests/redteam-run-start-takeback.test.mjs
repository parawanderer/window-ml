// redteam-run-start-takeback.test.mjs — rule 4b slice C's UNDO (src/sw/sw-run-start.ts `noteSend`/`takeBack`), and the
// test-only hook the slice added (`src/background.ts` `__mlRunPayloadsForTest`). The lane's rows (tests/task-starts-turn
// .test.mjs) take ONE held message back whole; these are the shapes a second message, a repeated attachment and a page
// make of it:
//   - the hook answers a run's payload as ids and a count, and nothing a PAGE can post reaches it (`PAGE_STARTED_TYPES`,
//     the router's own type list, and the dumps that already carry a run's files) — the stated residual is that it is
//     worker-realm only, so the row measures that boundary instead of assuming it;
//   - the same bytes twice are one pointer (`holdText`'s early return AND `FileShelf.note`, src/pointers/file-pointer
//     .ts: two layers, either alone enough — a layer was removed and the control stayed green), so a take-back must not
//     leave the run with a pointer that no delivered message put there, nor drop one a delivered message does hold;
//   - `sends` is put back only by the call that raised it, so two messages taken back together leave the count where
//     the DOCUMENTED undo leaves it: measured below, with the consequence it has (a skipped turn number, nothing else).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const SITE_URL = "https://site.example/page";
const T = { timeout: 40000 };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(done, cap = 4000) { for (let i = 0; i < cap && !(await done()); i++) await tick(); return done(); }

/** A worker-built run on tab 7 whose first turn has ended: the lane's own fixture, cut to what these rows read. */
async function settled(config = {}, more = {}) {
    const hold = { adopt: null, model: null };
    const openTabs = [{ id: 7, windowId: 3, active: true, url: SITE_URL, title: "Site" }];
    const bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai", debugMode: "off", ...config },
        openTabs, ...more,
        onFetch: async (call) => {
            if (call.url.endsWith("/api/models")) return jsonResponse({ data: [{ id: "m" }] });
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            if (hold.model) await hold.model;
            return jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") { if (hold.adopt) await hold.adopt; return { pageInfo: "" }; }
            return undefined;
        },
    });
    bg.commit?.(7, { documentId: "doc-7", url: SITE_URL });
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 5 });
    const events = () => bg.tabMessages.filter(([t, m]) => t === 7 && m?.type === "ML_DEBUG_TO_PAGE").map(([, m]) => m.event);
    const turns = () => events().filter((e) => e?.kind === "agent-result" && e.id === hash).length;
    const live = () => bg.context.__mlRunStateForTest().controllers.includes(hash);
    const starting = () => bg.context.__mlRunStateForTest().starting.includes(hash);
    const idle = (n) => () => turns() >= n && !live() && !starting();
    assert.ok(await until(idle(1)), "the first turn settles");
    const notes = () => events().filter((e) => e?.kind === "agent-note").map((e) => e.text);
    const detach = () => bg.context.__mlDetachTaskForTest(hash, "ml.sh");
    const action = (kind, body) => bg.context.__mlUserRunActionForTest(hash, kind, { ...body, surface: "hud" });
    const payloads = () => JSON.parse(JSON.stringify(bg.context.__mlRunPayloadsForTest(hash)));
    const files = async () => JSON.parse(JSON.stringify((await bg.send({ type: "DUMP_RUN_STATE", payload: { run: hash } }, EXT)).data.entries.find((e) => e.id === "run.files")?.value ?? null));
    return { bg, hash, hold, openTabs, turns, live, starting, idle, notes, detach, action, payloads, files };
}
const EXT = { id: "ext", url: "chrome-extension://ext/sidebar.html", origin: "chrome-extension://ext" };
const PAGE = { tab: { id: 7, url: SITE_URL } };
const NOTES = { name: "notes.txt", type: "text/plain", text: "alpha\nbeta" };
const refused = () => (x) => /was not sent: the run's turn did not start/.test(x);

/** Send two messages with the SAME bytes while a turn is starting, and fail that turn's start: both are taken back. */
async function twoHeldThenRefused() {
    const { IDBFactory } = require("fake-indexeddb");
    const r = await settled({}, { indexedDB: new IDBFactory() });
    let release;
    r.hold.adopt = new Promise((res) => { release = res; });
    r.detach().finish({ text: "built" });
    assert.ok(await until(r.starting), "the turn is starting (the page's adopt is held)");
    const prior = r.payloads();   // before either message: what the run's count and files really are
    assert.equal(await r.action("send", { text: "first", files: [NOTES] }), "steer", "the first message is held for the turn, said as sent");
    assert.equal(await r.action("send", { text: "second", files: [NOTES] }), "steer", "the second is held the same way");
    const held = r.payloads();
    assert.deepEqual(held.flatMap((p) => p.files).length, 1, `the same bytes are one pointer, not two: ${JSON.stringify(held)}`);
    const id = held.flatMap((p) => p.files)[0];
    r.hold.adopt = null;
    r.bg.context.__mlCancelAllRunsForTest();
    release();
    assert.ok(await until(() => !r.starting()), "the start gave up");
    assert.ok(await until(() => r.notes().filter(refused()).length === 2), `both messages are said not to have been sent: ${r.notes().join(" | ")}`);
    return { r, id, held, prior };
}

// --- the hook the slice added: worker-realm only, and only ids ---

test("RED TEAM: no message a page posts reaches the payload dump, and the dumps that do carry a run's files refuse a page", T, async () => {
    const { IDBFactory } = require("fake-indexeddb");
    const r = await settled({}, { indexedDB: new IDBFactory() });
    // A delivered message puts a real pointer on the run, so a leak has something to leak.
    let release;
    r.hold.model = new Promise((res) => { release = res; });
    r.detach().finish({ text: "built" });
    assert.ok(await until(() => r.live()), "a started turn is live, at its model call");
    assert.equal(await r.action("send", { text: "see this", files: [NOTES] }), "steer", "the live turn takes the message and its file");
    const id = r.payloads().flatMap((p) => p.files)[0];
    assert.ok(typeof id === "string" && id, `the run holds a file id: ${JSON.stringify(r.payloads())}`);

    // The spy: anything in the worker that reaches the hook is counted. The hook itself is replaced, so a caller that
    // goes through the global is seen; `globalThis` is a different realm from the page's, which is the point.
    const calls = [];
    const real = r.bg.context.__mlRunPayloadsForTest;
    r.bg.context.__mlRunPayloadsForTest = (h) => { calls.push(h); return real(h); };

    // The battery is ENUMERATED, not sampled: every type the router tests for, plus every type page-relay.ts lets a page
    // start, plus the fire-and-forget ones. Each is posted as the page the run is on, with the run named every way one
    // of these messages names it.
    const src = readFileSync(join(ROOT, "..", "src", "background.ts"), "utf8");
    const routed = [...src.matchAll(/message\.type === "([A-Z][A-Z0-9_]*)"|message\.type === ?"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1] ?? m[2]);
    const relay = await import("../src/page-relay.ts");
    const types = [...new Set([...routed, ...relay.PAGE_STARTED_TYPES, ...relay.PAGE_RELAYED_EXTRA])];
    assert.ok(routed.length >= 60, `the router's type list is the battery, and it read ${routed.length} of them: the source shape changed under this row`);
    assert.ok(types.includes("DUMP_RUN_STATE"), "the battery includes the dump that already carries a run's files");
    const answers = [];
    // Every key one of these messages might name its run by, and the hook's own name as a "console": a handler that
    // evaluates either would reach it.
    const payload = { run: r.hash, runId: r.hash, hash: r.hash, files: true, sends: true, console: "__mlRunPayloadsForTest", watches: ["__mlRunPayloadsForTest"] };
    for (const type of types) {
        answers.push(await Promise.race([
            r.bg.send({ type, payload }, PAGE).then((a) => ({ type, a }), (e) => ({ type, a: { error: String(e?.message ?? e) } })),
            new Promise((res) => setTimeout(() => res({ type, a: undefined, silent: true }), 400)),
        ]));
    }
    assert.deepEqual(calls, [], `a message a page posted reached the payload dump: ${JSON.stringify(calls)}`);

    // The instrument: the page IS seen as a page, by the handler that refuses one for exactly this.
    const dump = answers.find((x) => x.type === "DUMP_RUN_STATE");
    assert.match(JSON.stringify(dump?.a), /Refused: the run's state is for extension pages/, `the page sender was not recognised as a page: ${JSON.stringify(dump)}`);

    // And no answer, silent or not, carries the pointer or a send count to the page.
    const leaked = answers.filter((x) => JSON.stringify(x.a ?? null).includes(id) || /"sends"\s*:/.test(JSON.stringify(x.a ?? null)));
    assert.deepEqual(leaked, [], `an answer to a page carried the run's own state: ${JSON.stringify(leaked).slice(0, 400)}`);

    // The realm: only the worker's bundle defines the name, so a page's own scripts cannot name it at all.
    const owners = readdirSync(ROOT).filter((f) => f.endsWith(".js") && readFileSync(join(ROOT, f), "utf8").includes("__mlRunPayloadsForTest"));
    assert.deepEqual(owners, ["background.js"], `the test hook is defined outside the worker's bundle: ${JSON.stringify(owners)}`);
    release();
    assert.ok(await until(r.idle(2)), "the turn ends");
});

test("RED TEAM: the payload dump answers ids and a count, never what the person typed or a file's name", T, async () => {
    const { held, id } = await twoHeldThenRefused();
    const answer = JSON.stringify(held);
    assert.ok(answer.includes(id), `the dump names the run's file: ${answer}`);
    for (const p of held) {
        assert.deepEqual(Object.keys(p).sort(), ["files", "sends"], `the dump carries a member no test needs: ${answer}`);
        assert.ok(p.files.every((f) => typeof f === "string"), `a file is not an id: ${answer}`);
        assert.ok(p.sends === undefined || typeof p.sends === "number", `the count is not a number: ${answer}`);
    }
    assert.ok(!/first|second|notes\.txt|alpha/.test(answer), `the dump carried the message or the file's name: ${answer}`);
});

// --- the same bytes twice: one pointer, and a take-back that leaves the shelf as it found it ---

test("RED TEAM: two messages with the same bytes taken back together leave one pointer, and then none", T, async () => {
    const { r, id } = await twoHeldThenRefused();
    assert.deepEqual(r.payloads().flatMap((p) => p.files), [], `a taken-back message left its pointer (${id}) on a payload: ${JSON.stringify(r.payloads())}`);
    // The SHELF itself (`sessionTokens(hash).files`) is not reachable from the bundle: no surface reads it, `run.files`
    // reads the payload (`workerFiles`, src/sw/sw-runs.ts), and a rebuilt worker puts the shelf back FROM the payload —
    // so a `takeBack` that stopped dropping would change nothing either row above can see. Measured: removing the
    // `shelf.drop` in `takeBack` leaves both green. What it would leave is a pointer resolvable by name in a later
    // `exec` via `@file:<id>` — an id the model was never shown, since the refused message never reached it.
    assert.equal(await r.files(), null, `run.files still lists the taken-back pointer: ${JSON.stringify(await r.files())}`);
});

test("RED TEAM: a take-back never drops a pointer a DELIVERED message holds", T, async () => {
    const { IDBFactory } = require("fake-indexeddb");
    const r = await settled({}, { indexedDB: new IDBFactory() });
    let release;
    r.hold.model = new Promise((res) => { release = res; });
    r.detach().finish({ text: "built" });
    assert.ok(await until(() => r.live()));
    assert.equal(await r.action("send", { text: "the file", files: [NOTES] }), "steer", "delivered to the live turn");
    const id = r.payloads().flatMap((p) => p.files)[0];
    release();
    assert.ok(await until(r.idle(2)), "the turn ends, and the delivered message's file is the run's");
    // A later message with the SAME bytes, held while the next turn starts, then taken back: the pointer it deduped to
    // belongs to the delivered message, and must survive.
    let adopt;
    r.hold.adopt = new Promise((res) => { adopt = res; });
    r.detach().finish({ text: "again" });
    assert.ok(await until(r.starting));
    assert.equal(await r.action("send", { text: "same file", files: [NOTES] }), "steer");
    r.hold.adopt = null;
    r.bg.context.__mlCancelAllRunsForTest();
    adopt();
    assert.ok(await until(() => !r.starting()));
    assert.ok(await until(() => r.notes().some(refused())), `the held message is said not to have been sent: ${r.notes().join(" | ")}`);
    assert.deepEqual(r.payloads().flatMap((p) => p.files), [id], `the delivered message's file was taken back with the refused one: ${JSON.stringify(r.payloads())}`);
    const shelf = await r.files();
    const rows = Array.isArray(shelf) ? shelf : (shelf?.entries ?? []);
    assert.equal(rows.length, 1, `the shelf no longer holds the delivered message's file: ${JSON.stringify(shelf)}`);
});

// --- `sends`: the documented undo, and what it costs ---

// MEASURED at eddf348e (one message sent, two held): `prior` 1, `held` 3, after both take-backs 2 — one high. Both
// messages are taken back in the order they were held, so the FIRST one's undo is skipped (a later message raised the
// count past its turn) and the SECOND restores its own `before`, which is the first message's turn. For n taken back
// together the count ends n-1 high: the payload claims messages the person never sent, and `nextSend`
// (sw-run-start.ts:213) numbers the person's next message past them, so a turn number is skipped. Only `nextSend` reads
// the member, so the cost is the skip; the fix shape is to run the take-backs in REVERSE (dropPendingSteers,
// flushPendingSteers), which restores each in turn. Not pinned as a red: the JSDoc states the per-call undo this
// follows, and nothing delivered collides — the row bounds the drift instead, so a fix (drift 0) stays green.
test("RED TEAM: taking back two held messages never lowers `sends` below a delivered message's turn", T, async () => {
    const { r, held, prior } = await twoHeldThenRefused();
    const after = r.payloads();
    const was = Math.max(1, ...prior.map((p) => p.sends ?? 1));   // the count of messages the run HAD before these two
    const raised = Math.max(1, ...held.map((p) => p.sends ?? 1)); // and what the two held messages raised it to
    for (const p of after) assert.ok((p.sends ?? 1) >= was, `a take-back lowered the count below the messages the run had: ${JSON.stringify({ was, after })}`);
    for (const p of after) assert.ok((p.sends ?? 1) <= raised, `a take-back left the count above the refused messages: ${JSON.stringify(after)}`);
    // The count never claims more than the messages the run really sent plus the refusal: one high per pair, and
    // `nextSend` numbers the next message past that, so no two DELIVERED messages can share a turn.
    const claims = Math.max(1, ...after.map((p) => p.sends ?? 1));
    assert.ok(claims <= was + 1, `the count claims ${claims} messages where ${was} were sent: ${JSON.stringify({ prior, after })}`);
    assert.equal(await r.action("send", { text: "third" }), "turn", "the run takes the person's next message");
    const numbered = r.payloads().map((p) => p.sends);
    assert.ok(numbered.every((n) => n > claims && n > was), `a delivered message collided with a turn the run already sent: ${JSON.stringify({ was, claims, numbered })}`);
});
