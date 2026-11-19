// policies-session-view-handler.test.mjs — the `POLICIES` message's session read and checked removal, through the BUILT worker in
// node:vm (rebuild first, `npm run build:all`): extension pages only, a read that carries rows, and a widening removal that
// refuses without `confirm` (src/background.ts, src/sw/sw-policies.ts `sessionPolicies`/`removeFromSession`; docs/spec/POLICIES.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadBackground } = require("./helpers");
const EXT_PAGE = { url: "chrome-extension://test/sidebar.html" };
const PAGE = { url: "https://site.example/", tab: { id: 7 } };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const pol = (id, effect, scope = "global") => ({ id, scope, consumer: "fetch", effect, source: "(c) => c.host === \"a.example\"", label: id, origin: "person", created: 1 });

function bgWith(globals, runs = {}) {
    return loadBackground({ config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai" }, local: { ml_policies_global: globals, ml_policies_run: runs } });
}

// --- who may ask ---

test("a page, and a content script relaying for one, gets nothing from the session read or the checked removal", async () => {
    const bg = bgWith([pol("g-deny", "deny")]);
    for (const payload of [{ op: "session", hash: "h1" }, { op: "removeChecked", hash: "h1", id: "g-deny", confirm: true }]) {
        assert.equal(plain(await bg.send({ type: "POLICIES", payload }, PAGE)).error, "refused", payload.op);
    }
    assert.equal(bg.localStore.ml_policies_global.length, 1, "and nothing was removed");
});

// --- the read ---

test("the session read lists the default, the global and the session's rows, and no other session's", async () => {
    const bg = bgWith([pol("g-allow", "allow")], { h1: [pol("r-deny", "deny", "run")], h2: [pol("other", "ask", "run")] });
    const r = plain(await bg.send({ type: "POLICIES", payload: { op: "session", hash: "h1" } }, EXT_PAGE));
    assert.equal(r.error, undefined);
    assert.deepEqual(r.data.rows.map((x) => [x.layer, x.entry.id]), [["default", "builtin"], ["global", "g-allow"], ["session", "r-deny"]]);
    assert.equal(r.data.rows[2].wins, true);
    assert.deepEqual(r.data.rows[2].overrides, ["g-allow"]);
});

test("a session read without a hash is refused", async () => {
    const r = plain(await bgWith([]).send({ type: "POLICIES", payload: { op: "session" } }, EXT_PAGE));
    assert.match(r.error, /session hash/);
});

// --- the checked removal ---

test("a widening removal without confirm answers `confirm` with the row; with it, the view without the row", async () => {
    const bg = bgWith([pol("g-allow", "allow")], { h1: [pol("r-deny", "deny", "run")] });
    const first = plain(await bg.send({ type: "POLICIES", payload: { op: "removeChecked", hash: "h1", id: "r-deny" } }, EXT_PAGE));
    assert.equal(first.error, "confirm");
    assert.equal(first.data.row.entry.id, "r-deny");
    assert.deepEqual(first.data.row.removal.exposes.map((e) => e.id).sort(), ["builtin", "g-allow"]);
    const done = plain(await bg.send({ type: "POLICIES", payload: { op: "removeChecked", hash: "h1", id: "r-deny", confirm: true } }, EXT_PAGE));
    assert.equal(done.error, undefined);
    assert.deepEqual(done.data.rows.map((x) => x.entry.id), ["builtin", "g-allow"]);
});

test("a narrowing removal needs no confirm, and an id outside this session's view is refused", async () => {
    const bg = bgWith([], { h1: [pol("r-allow", "allow", "run")], h2: [pol("other", "allow", "run")] });
    assert.equal(plain(await bg.send({ type: "POLICIES", payload: { op: "removeChecked", hash: "h1", id: "other", confirm: true } }, EXT_PAGE)).error, "no such policy");
    const done = plain(await bg.send({ type: "POLICIES", payload: { op: "removeChecked", hash: "h1", id: "r-allow" } }, EXT_PAGE));
    assert.equal(done.error, undefined);
    assert.deepEqual(done.data.rows, []);
});
