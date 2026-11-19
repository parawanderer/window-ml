// redteam-policies-session-view.test.mjs — the `POLICIES` message's session read and checked removal (window-ml#1975,
// branch feat/policy-effective-read at 17d4da92), adversarially: what a page, a content script relaying for one, or a
// wrong removal class must NOT get from `{op:"session"}` and `{op:"removeChecked"}` (docs/spec/POLICIES.md, "The
// effective view"). The lane's rows (tests/policies-session-view-handler.test.mjs) pin the shapes through the built
// worker; these probe the SENDER a hostile page really produces, the `confirm` a caller can get wrong, the reach of a
// global removal, what a row may carry, and `effectiveRows`' overrule of a consumer's wrong class (sw-policy-view.ts
// `removal`). A page cannot remove anything, and no setting or relayed message type reaches the store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { effectiveRows, registerRemovalClass } from "../src/sw/sw-policy-view.ts";
import { settingDecl, modelWritable } from "../src/setting-class.ts";
import { HANDLE_MAP, PAGE_STARTED_TYPES } from "../src/page-relay.ts";

const require = createRequire(import.meta.url);
const { loadBackground } = require("./helpers");
const EXT_PAGE = { url: "chrome-extension://test/sidebar.html" };
// The sender a CONTENT SCRIPT relaying for a page produces: our id, the page's url, the tab. `isExtensionSender` reads
// the url, so this is the shape that matters; a `{url}` without an id is not what the browser reports.
const RELAY = { id: "test", url: "https://site.example/", tab: { id: 7 } };
const OTHER_EXT = { id: "other", url: "chrome-extension://otherextension/sidebar.html" };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const pol = (id, effect, scope = "global") => ({ id, scope, consumer: "fetch", effect, source: "(c) => c.host === \"a.example\"", label: id, origin: "person", created: 1 });

function bgWith(globals, runs = {}) {
    return loadBackground({ config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai" }, local: { ml_policies_global: globals, ml_policies_run: runs } });
}
const ids = (bg) => [bg.localStore.ml_policies_global.map((p) => p.id), Object.fromEntries(Object.entries(bg.localStore.ml_policies_run ?? {}).map(([h, l]) => [h, l.map((p) => p.id)]))];

// --- A. who may ask: the sender the browser reports, never what the message says ---

test("RED TEAM: a content script relaying for a page is refused both ops, confirm or not, and nothing is removed", async () => {
    const bg = bgWith([pol("g-deny", "deny")], { h1: [pol("r-deny", "deny", "run")] });
    const before = plain(ids(bg));
    for (const payload of [
        { op: "session", hash: "h1" },
        { op: "removeChecked", hash: "h1", id: "g-deny" },
        { op: "removeChecked", hash: "h1", id: "g-deny", confirm: true },
        { op: "removeChecked", hash: "h1", id: "r-deny", confirm: true },
        // A relayed message claiming the shape of an extension page, and claiming to be one in the payload, is still read
        // by its url.
        { op: "removeChecked", hash: "h1", id: "g-deny", confirm: true, from: "extension", url: "chrome-extension://test/sidebar.html" },
    ]) {
        const r = plain(await bg.send({ type: "POLICIES", payload }, RELAY));
        assert.equal(r.error, "refused", `${payload.op} (${payload.id ?? ""}) was answered: ${JSON.stringify(r).slice(0, 200)}`);
        assert.equal(r.data, undefined, "a refused op returned data");
    }
    assert.deepEqual(plain(ids(bg)), before, "a relayed sender changed the store");
});

test("RED TEAM: another extension's page, and a sender with no url, are refused the read", async () => {
    const bg = bgWith([pol("g-deny", "deny")]);
    assert.equal(plain(await bg.send({ type: "POLICIES", payload: { op: "session", hash: "h1" } }, OTHER_EXT)).error, "refused");
    assert.equal(plain(await bg.send({ type: "POLICIES", payload: { op: "session", hash: "h1" } }, {})).error, "refused");
    assert.equal(plain(await bg.send({ type: "POLICIES", payload: { op: "removeChecked", hash: "h1", id: "g-deny", confirm: true } }, OTHER_EXT)).error, "refused");
    assert.deepEqual(plain(ids(bg))[0], ["g-deny"]);
});

// --- B. the widening removal: a boolean `confirm` and a reach the caller is told ---

test("RED TEAM: only `confirm: true` confirms; a truthy spelling is refused with the row and removes nothing", async () => {
    const bg = bgWith([pol("g-allow", "allow")], { h1: [pol("r-deny", "deny", "run")] });
    for (const confirm of ["true", 1, {}, [], "yes"]) {
        const r = plain(await bg.send({ type: "POLICIES", payload: { op: "removeChecked", hash: "h1", id: "r-deny", confirm } }, EXT_PAGE));
        assert.equal(r.error, "confirm", `${JSON.stringify(confirm)} confirmed a widening removal`);
        assert.equal(r.data.row.entry.id, "r-deny", "the refusal did not carry the row");
        assert.equal(r.data.row.removal.class, "widens");
    }
    assert.deepEqual(plain(ids(bg))[1], { h1: ["r-deny"] }, "a refused removal changed the store");
    const done = plain(await bg.send({ type: "POLICIES", payload: { op: "removeChecked", hash: "h1", id: "r-deny", confirm: true } }, EXT_PAGE));
    assert.equal(done.error, undefined, JSON.stringify(done).slice(0, 200));
    assert.deepEqual(plain(ids(bg))[1], {});
});

test("RED TEAM: removing a global row reaches every session, and the row says so before it is removed", async () => {
    const bg = bgWith([pol("g-deny", "deny")], { h1: [], h2: [] });
    const read = plain(await bg.send({ type: "POLICIES", payload: { op: "session", hash: "h1" } }, EXT_PAGE));
    const row = read.data.rows.find((x) => x.entry.id === "g-deny");
    assert.equal(row.removal.reach, "all", "a global row's removal claims to reach one session");
    assert.equal(row.removal.class, "widens");
    const done = plain(await bg.send({ type: "POLICIES", payload: { op: "removeChecked", hash: "h1", id: "g-deny", confirm: true } }, EXT_PAGE));
    assert.equal(done.error, undefined);
    const other = plain(await bg.send({ type: "POLICIES", payload: { op: "session", hash: "h2" } }, EXT_PAGE));
    assert.ok(!other.data.rows.some((x) => x.entry.id === "g-deny"), "another session still lists a global row that was removed from h1's view");
});

test("RED TEAM: a removeChecked for an id outside this session's view removes nothing, whatever confirm says", async () => {
    const bg = bgWith([], { h1: [pol("r-allow", "allow", "run")], h2: [pol("other", "deny", "run")] });
    for (const confirm of [undefined, true]) {
        const r = plain(await bg.send({ type: "POLICIES", payload: { op: "removeChecked", hash: "h1", id: "other", ...(confirm === undefined ? {} : { confirm }) } }, EXT_PAGE));
        assert.equal(r.error, "no such policy", "another session's policy was reachable from this one's view");
    }
    assert.deepEqual(plain(ids(bg))[1], { h1: ["r-allow"], h2: ["other"] });
    // The default row cannot be removed at all.
    const b = plain(await bg.send({ type: "POLICIES", payload: { op: "removeChecked", hash: "h1", id: "builtin", confirm: true } }, EXT_PAGE));
    assert.equal(b.error, "no such policy");
});

// --- C. what a row may carry ---

test("RED TEAM: the session read carries a policy's own words, never a call, a value or a hidden field", () => {
    const bg = bgWith([pol("g-allow", "allow")], { h1: [pol("r-deny", "deny", "run")] });
    return bg.send({ type: "POLICIES", payload: { op: "session", hash: "h1" } }, EXT_PAGE).then((res) => {
        const read = plain(res);
        const entryKeys = new Set(["id", "label", "source", "effect", "origin", "created", "broken"]);
        const rowKeys = new Set(["consumer", "layer", "entry", "wins", "overrides", "overriddenBy", "removal"]);
        for (const row of read.data.rows) {
            for (const k of Object.keys(row.entry)) assert.ok(entryKeys.has(k), `an entry carries ${k}`);
            for (const k of Object.keys(row)) assert.ok(rowKeys.has(k), `a row carries ${k}`);
            if (!row.removal) continue;
            assert.deepEqual(Object.keys(row.removal).sort(), ["class", "exposes", "reach"]);
            for (const e of row.removal.exposes) assert.deepEqual(Object.keys(e).sort(), ["effect", "id", "label"], "an exposure carries more than what it names");
        }
        assert.deepEqual(Object.keys(read.data).sort(), ["builtin", "rows"], "the read carries more than the rows and the default");
    });
});

// --- D. a consumer's wrong removal class fails closed (sw-policy-view.ts `removal`) ---

test("RED TEAM: a classifier that says narrows for a deny is overruled to widens, with what it exposed", () => {
    registerRemovalClass("rt-wrong", () => "narrows");
    const rows = effectiveRows([{ id: "d1", consumer: "rt-wrong", label: "hide", source: "(c) => true", effect: "deny" }], [], { label: "built-in", source: "x" });
    const deny = rows.find((r) => r.entry.id === "d1");
    assert.equal(deny.removal.class, "widens", "a deny removed as narrows needs no confirmation");
    assert.deepEqual(deny.removal.exposes.map((e) => e.id), ["builtin"], "a widening removal did not name the row left to decide");
    // The control: the same wrong class on an ALLOW stays narrows, so the overrule is not "always widens".
    const allow = effectiveRows([{ id: "a1", consumer: "rt-wrong", label: "show", source: "(c) => true", effect: "allow" }], [], { label: "built-in", source: "x" }).find((r) => r.entry.id === "a1");
    assert.equal(allow.removal.class, "narrows");
});

// --- E. no other path reaches the store ---

test("RED TEAM: the policy store is not a setting and POLICIES is not relayed, so no settings or page path reaches it", () => {
    for (const key of ["ml_policies_global", "ml_policies_run"]) {
        assert.equal(settingDecl(key), null, `${key} is a classified setting`);
        assert.equal(modelWritable(key), false, `${key} is model-writable`);
    }
    assert.ok(!Object.values(HANDLE_MAP).some((e) => e && (e.type === "POLICIES" || e.responseType === "POLICIES")), "POLICIES is in the page relay");
    assert.ok(!PAGE_STARTED_TYPES.has("POLICIES"), "POLICIES is a page-started type");
});
