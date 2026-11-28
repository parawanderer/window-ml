// files-hide-policies.test.mjs — hiding rules for a session's files (POLICIES.md, "Hiding files", ruling 34) through the
// policy store: today's store read by the new code, adding and removing a rule, the session's view rows, the command, the
// list the offscreen reader asks for, the reader itself bound by it, and every reader in src/ built with the rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// What the build before this one left in chrome.storage.local: no `files` row anywhere.
const OLD_STORE = {
    ml_policies_global: [
        { id: "pol-old-g1", scope: "global", consumer: "fetch", effect: "deny", source: '(c) => c.host === "blocked.example"', label: "never blocked.example", origin: "person", created: 1760000000000 },
    ],
    ml_policies_run: {
        "h-old": [{ id: "pol-old-r1", scope: "run", consumer: "fetch", effect: "allow", source: '(c) => c.kind === "fetch" && c.url === "https://a.example/x"', label: "fetch https://a.example/x", origin: "card", created: 1760000000002 }],
    },
};

let stored = structuredClone(OLD_STORE);
const sent = [];
const sessionStored = {};
/** Holds every session-storage read until opened: a worker that woke and has not read its map yet. */
let sessionGate = Promise.resolve();
globalThis.chrome = {
    runtime: { getURL: (p) => `chrome-extension://test/${p}`, sendMessage: async (m) => { sent.push(m); } },
    storage: { local: {
        get: async () => structuredClone(stored),
        set: async (o) => { stored = { ...stored, ...structuredClone(o) }; },
    }, session: {
        // The worker's session storage: what survives an eviction, so a fresh module over it is a restarted worker.
        get: async (keys) => { await sessionGate; return Object.fromEntries(keys.filter((k) => k in sessionStored).map((k) => [k, structuredClone(sessionStored[k])])); },
        set: async (o) => { Object.assign(sessionStored, structuredClone(o)); },
    } },
};
const P = await import("../src/sw/sw-policies.ts");
const { addFilesRule, removeFilesRule, filesHideList, signalFilesHideChanges, noteFilesListed, filesListedIdle, FILES_LISTED_KEY, LISTED_RULES_MAX } = await import("../src/sw/sw-files-hide.ts");
const { HIDE_LIMIT_HARD_LINK, HIDE_LIMIT_LINUX_LATE } = await import("../src/sw/files-hide-view.ts");
const { DEFAULT_HOLDS, HIDE_ENTRIES_MAX, resolveHidden } = await import("../src/files-hide.ts");
const { makeHideRule, HIDE_LIST_TTL_MS } = await import("../src/session/files-hide-rule.ts");
const { RangedReader } = await import("../src/session/ranged-reader.ts");
const { createCommandHandler } = await import("../src/session/session-commands.ts");
const { SessionIndex } = await import("../src/session/session-index.ts");
const { validList } = await import("../src/sw/policy-valid.ts");
await P.policiesReady;

const filesRows = (hash, platform) => P.sessionPolicies(hash, platform).rows.filter((r) => r.consumer === "files");
const OFFSCREEN = { url: "chrome-extension://test/offscreen.html" };

// --- the upgrade: today's store, with no files rows, read by the new code ---

test("UPGRADE: a store with no files rows judges as before, and the view holds no files row until a rule exists", () => {
    assert.deepEqual(P.globalPolicies(), OLD_STORE.ml_policies_global, "no field added, none dropped");
    assert.equal(P.judgeCall("h-old", "fetch", P.fetchFacts("https://a.example/x")).decision, "allow");
    assert.equal(P.judgeCall("h-old", "fetch", P.fetchFacts("https://blocked.example/")).decision, "deny");
    assert.deepEqual(filesRows("h-old"), [], "a consumer's default rows come with its first rule, as for every consumer");
    assert.ok(P.sessionPolicies("h-old").rows.some((r) => r.consumer === "fetch" && r.entry.id === "pol-old-r1"), "the other consumers' rows are still there");
    assert.deepEqual(P.filesHideEntries("h-old"), []);
});

test("a stored row whose effect does not fit its consumer is dropped on load, both ways", () => {
    const rows = [
        { id: "a", scope: "global", consumer: "files", effect: "allow", source: "/files/agent/x", label: "x", origin: "person", created: 1 },
        { id: "b", scope: "global", consumer: "fetch", effect: "hide", source: "(c) => true", label: "y", origin: "person", created: 1 },
        { id: "c", scope: "global", consumer: "files", effect: "hide", source: "/files/agent/x", label: "z", origin: "person", created: 1 },
    ];
    assert.deepEqual(validList(rows, "global").map((p) => p.id), ["c"]);
});

// --- adding a rule ---

test("a refused pattern is refused with its reason and stores nothing", () => {
    const before = JSON.stringify(stored);
    for (const source of ["files/agent/x", "/files/**/x", "/files/agent/../x", "/files/agent/"]) {
        const r = addFilesRule("h1", { effect: "hide", source, scope: "session" });
        assert.equal(typeof r.refused, "string", source);
    }
    assert.equal(typeof addFilesRule("h1", { effect: "show", source: "/files/agent/.ssh/id_rsa", scope: "global" }).refused, "string");
    assert.equal(JSON.stringify(stored), before, "the store is byte-unchanged");
});

test("a session hide holds a file no default holds, through the list the reader is given; the same rule twice is one", () => {
    const a = addFilesRule("h1", { effect: "hide", source: "/files/agent/notes.txt", scope: "session" });
    const b = addFilesRule("h1", { effect: "hide", source: "/files/agent/notes.txt", scope: "session" });
    assert.equal(a.id, b.id);
    const list = P.filesHideEntries("h1");
    assert.equal(resolveHidden("/files/agent/notes.txt", list).hidden, true);
    assert.equal(resolveHidden("/files/agent/other.txt", list).hidden, false);
    assert.deepEqual(P.filesHideEntries("h2"), [], "another session's rule does not bind this one");
    assert.equal(P.judgeCall("h1", "fetch", P.fetchFacts("https://x.example/")).decision, undefined, "a files rule is never judged as a script");
});

test("show .env releases it while every other dotenv name stays held", () => {
    addFilesRule("h3", { effect: "show", source: "/files/agent/.env", scope: "session" });
    const list = P.filesHideEntries("h3");
    assert.equal(resolveHidden("/files/agent/.env", list).hidden, false);
    for (const p of ["/files/agent/.env.local", "/files/agent/.env.production", "/files/attached/h1/.env"]) assert.equal(resolveHidden(p, list).hidden, true, p);
});

test("a session show over a global hide decides, and the session's list comes first", () => {
    const g = addFilesRule("h4", { effect: "hide", source: "/files/agent/report.csv", scope: "global" });
    const s = addFilesRule("h4", { effect: "show", source: "/files/agent/report.csv", scope: "session" });
    const list = P.filesHideEntries("h4");
    assert.deepEqual(list.map((e) => e.layer).slice(0, 1), ["session"]);
    assert.equal(resolveHidden("/files/agent/report.csv", list).hidden, false);
    assert.equal(resolveHidden("/files/agent/report.csv", P.filesHideEntries("h-other")).hidden, true, "every other session keeps the global hide");
    P.removePolicy(g.id); P.removePolicy(s.id);
});

test("a scope holding the most rules refuses one more", () => {
    for (let i = 0; i < HIDE_ENTRIES_MAX; i++) assert.ok(addFilesRule("h-cap", { effect: "hide", source: `/files/agent/f${i}`, scope: "session" }).id);
    assert.match(addFilesRule("h-cap", { effect: "hide", source: "/files/agent/one-more", scope: "session" }).refused, /already holds/);
    P.forgetRunPolicies("h-cap");
});

test("the model's policy list carries no files rule: a hidden file reads as absent, and its path would say it exists", () => {
    addFilesRule("h1", { effect: "hide", source: "/files/agent/payroll-2026.xlsx", scope: "session" });
    addFilesRule("h1", { effect: "hide", source: "/files/agent/payroll-2025.xlsx", scope: "global" });
    const seen = JSON.stringify(P.policiesForModel("h1"));
    assert.ok(!seen.includes("payroll"), seen);
    assert.ok(P.filesHideEntries("h1").some((e) => e.source.includes("payroll-2026")), "positive control: the rule is stored");
});

// --- the view rows ---

test("with a rule, the view holds the four defaults first, and a hide row's label states its limits, the Linux one only on a Linux host", () => {
    const h = addFilesRule("h5", { effect: "hide", source: "/files/agent/a.txt", scope: "session" });
    const sh = addFilesRule("h5", { effect: "show", source: "/files/agent/.env", scope: "session" });
    const rows = filesRows("h5");
    assert.deepEqual(rows.slice(0, DEFAULT_HOLDS.length).map((r) => [r.layer, r.entry.id]), DEFAULT_HOLDS.map((d) => ["default", d.id]));
    for (const r of rows.slice(0, DEFAULT_HOLDS.length)) assert.equal(r.removal, undefined, "a default cannot be removed");
    for (const platform of [undefined, "macos", "linux"]) {
        const of = (id) => filesRows("h5", platform).find((r) => r.entry.id === id).entry.label;
        const lines = of(h.id).split("\n");
        assert.deepEqual(lines, ["hide /files/agent/a.txt", ...(platform === "linux" ? [HIDE_LIMIT_LINUX_LATE] : []), HIDE_LIMIT_HARD_LINK], String(platform));
        assert.equal(of(sh.id), "show /files/agent/.env", "a show row states no hide limit");
        for (const r of filesRows("h5", platform)) assert.doesNotMatch(r.entry.label, /not applied yet/, "PR B binds a spawned process: the old words are gone");
    }
    for (const line of [HIDE_LIMIT_LINUX_LATE, HIDE_LIMIT_HARD_LINK]) assert.doesNotMatch(line, /\n| {2}/, "one plain line each");
    const keys = new Set(["consumer", "layer", "entry", "wins", "overrides", "overriddenBy", "removal"]);
    for (const r of rows) for (const k of Object.keys(r)) assert.ok(keys.has(k), `a files row carries ${k}`);
});

test("a show over a default names the default it overrides; a session show over a global hide names that hide", () => {
    const g = addFilesRule("h6", { effect: "hide", source: "/files/agent/*.csv", scope: "global" });
    const s = addFilesRule("h6", { effect: "show", source: "/files/agent/.env", scope: "session" });
    const t = addFilesRule("h6", { effect: "show", source: "/files/agent/data.csv", scope: "session" });
    const rows = filesRows("h6");
    const of = (id) => rows.find((r) => r.entry.id === id);
    assert.deepEqual(of(s.id).overrides, ["default:dotenv"]);
    assert.deepEqual(of("default:dotenv").overriddenBy, [s.id]);
    assert.deepEqual(of(t.id).overrides, [g.id]);
    assert.ok(of(g.id).overriddenBy.includes(t.id));
    assert.equal(of(s.id).entry.origin, "person");
    assert.equal(of(s.id).entry.label, "show /files/agent/.env");
    P.removePolicy(g.id);
});

test("removing a show narrows at once; removing a hide waits for the confirm and names what then decides", () => {
    const h = addFilesRule("h7", { effect: "hide", source: "/files/agent/*.txt", scope: "session" });
    const s = addFilesRule("h7", { effect: "show", source: "/files/agent/keep.txt", scope: "global" });
    const rows = filesRows("h7");
    assert.equal(rows.find((r) => r.entry.id === s.id).removal.class, "narrows");
    assert.equal(rows.find((r) => r.entry.id === h.id).removal.class, "widens");
    assert.deepEqual(removeFilesRule("h7", h.id, false), { removed: false, why: "confirm", exposes: [s.id] });
    assert.ok(P.filesHideEntries("h7").some((e) => e.id === h.id), "not removed without the confirm");
    assert.deepEqual(removeFilesRule("h7", h.id, true), { removed: true });
    assert.deepEqual(removeFilesRule("h7", s.id, false), { removed: true });
    assert.deepEqual(removeFilesRule("h-old", "pol-old-r1", true), { removed: false, why: "unknown" }, "another consumer's policy is not this command's");
    assert.ok(P.runPolicies("h-old").some((p) => p.id === "pol-old-r1"));
});

// --- the command ---

test("policy.files: one command adds and removes a rule from any renderer, with its refusals", async () => {
    const index = new SessionIndex({ runtime: "local", spawn: "w1" });
    index.ingest({ kind: "agent", id: "c0de0001", ts: 1, save: false, session: { hash: "c0de0001", turn: 0 }, task: "t", model: "m", maxSteps: 3, config: null }, { tabId: 1, trusted: true });
    const run = createCommandHandler({ runtime: "local", index, addFilesRule, removeFilesRule });
    const session = { runtime: "local", hash: "c0de0001" };
    const added = await run({ type: "policy.files", session, op: "add", effect: "hide", source: "/files/agent/x.txt", scope: "session" }, { via: "hub", scopes: ["approve"] });
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(resolveHidden("/files/agent/x.txt", P.filesHideEntries("c0de0001")).hidden, true);
    const bad = await run({ type: "policy.files", session, op: "add", effect: "allow", source: "/files/agent/x.txt", scope: "session" });
    assert.equal(bad.error.code, "invalid");
    const refused = await run({ type: "policy.files", session, op: "add", effect: "hide", source: "/files/**", scope: "session" });
    assert.equal(refused.error.code, "invalid");
    assert.deepEqual(await run({ type: "policy.files", session, op: "remove", id: added.data.id }), { ok: true, data: { removed: false, confirm: { exposes: [] } } });
    assert.deepEqual(await run({ type: "policy.files", session, op: "remove", id: added.data.id, confirm: true }), { ok: true, data: { removed: true } });
    assert.equal((await run({ type: "policy.files", session, op: "remove", id: "nope", confirm: true })).error.code, "not-found");
    const bare = createCommandHandler({ runtime: "local", index });
    assert.equal((await bare({ type: "policy.files", session, op: "add", effect: "hide", source: "/files/agent/x", scope: "session" })).error.code, "unsupported");
});

// --- the list the offscreen reader asks for ---

test("FILES_HIDE_LIST answers the offscreen document only", async () => {
    addFilesRule("h8", { effect: "hide", source: "/files/agent/y.txt", scope: "session" });
    assert.deepEqual(await filesHideList({ session: "h8" }, { tab: { id: 1 }, url: "https://evil.example/" }), { entries: null });
    assert.deepEqual(await filesHideList({ session: "h8" }, { url: "chrome-extension://test/sidebar.html" }), { entries: null });
    assert.deepEqual(await filesHideList({ session: 5 }, OFFSCREEN), { entries: null });
    const r = await filesHideList({ session: "h8" }, OFFSCREEN);
    assert.ok(r.entries.some((e) => e.source === "/files/agent/y.txt" && e.layer === "session"));
});

test("the files-changed hint: only a listed session whose resolved rules changed hears it, after the reader is told to drop its lists", async () => {
    const off = signalFilesHideChanges((hash) => sent.push({ type: "HINT", hash }));
    await noteFilesListed("hint-a");
    await noteFilesListed("hint-b");
    const run = async (change) => { sent.length = 0; const r = await change(); await filesListedIdle(); return { r, log: sent.map((m) => (m.type === "HINT" ? `hint:${m.hash}` : m.type)) }; };
    const mine = await run(() => addFilesRule("hint-a", { effect: "hide", source: "/files/agent/x.txt", scope: "session" }));
    assert.deepEqual(mine.log, ["FILES_HIDE_CHANGED", "hint:hint-a"], "A only, and the reader's signal comes first");
    const global = await run(() => addFilesRule("hint-a", { effect: "hide", source: "/files/agent/g.txt", scope: "global" }));
    assert.deepEqual(global.log, ["FILES_HIDE_CHANGED", "hint:hint-a", "hint:hint-b"], "a global rule changes every listed session's");
    const other = await run(() => P.addGlobalPolicy({ consumer: "fetch", effect: "deny", source: '(c) => c.host === "hint.example"', label: "never hint.example" }));
    assert.deepEqual(other.log, ["FILES_HIDE_CHANGED"], "a policy of another consumer changes no session's rules");
    const again = await run(() => P.removePolicy(other.r.id));
    assert.deepEqual(again.log, ["FILES_HIDE_CHANGED"]);
    const unlisted = await run(() => addFilesRule("hint-never-listed", { effect: "hide", source: "/files/agent/u.txt", scope: "session" }));
    assert.deepEqual(unlisted.log, ["FILES_HIDE_CHANGED"], "a session never listed is not hinted");
    const removed = await run(() => removeFilesRule("hint-a", mine.r.id, true));
    assert.deepEqual(removed.log, ["FILES_HIDE_CHANGED", "hint:hint-a"], "removing a rule is a change too");
    const same = await run(() => addFilesRule("hint-b", { effect: "hide", source: "/files/agent/g.txt", scope: "session" }));
    assert.ok(same.log.includes("hint:hint-b"), "a session rule over the global one changes the resolved list");
    const twice = await run(() => { P.removePolicy(global.r.id); });
    assert.deepEqual(twice.log, ["FILES_HIDE_CHANGED", "hint:hint-a", "hint:hint-b"], "each session whose resolved list changed is hinted once");
    const none = await run(() => P.removePolicy("not-a-policy"));
    assert.deepEqual(none.log.filter((l) => l.startsWith("hint:")), [], "nothing changed, nothing hinted");
    // What is stored is a fingerprint per session, never a rule's source.
    const kept = JSON.stringify(sessionStored[FILES_LISTED_KEY]);
    assert.ok(kept.includes("hint-a") && !kept.includes("/files/"), kept);
    off();
});

test("the files-changed hint: past LISTED_RULES_MAX listed sessions the oldest is dropped, and listing again makes a session the newest", async () => {
    const off = signalFilesHideChanges((hash) => sent.push({ type: "HINT", hash }));
    const first = "cap-first";
    await noteFilesListed(first);
    for (let i = 0; i < LISTED_RULES_MAX - 1; i++) void noteFilesListed(`cap-${i}`);
    void noteFilesListed(first);   // listed again: now the newest, so the next drop takes another
    await noteFilesListed("cap-last");
    sent.length = 0;
    const g = addFilesRule("cap-x", { effect: "hide", source: "/files/agent/cap.txt", scope: "global" });
    await filesListedIdle();
    const heard = sent.filter((m) => m.type === "HINT").map((m) => m.hash);
    assert.equal(heard.length, LISTED_RULES_MAX, "never more sessions than the bound");
    assert.ok(heard.includes(first) && heard.includes("cap-last"));
    assert.ok(!heard.includes("cap-0"), "the oldest listed was dropped, and hears nothing");
    P.removePolicy(g.id);
    await filesListedIdle();
    off();
});

test("the files-changed hint survives a worker restart: a fresh module over the same session storage hints a session listed before it", async () => {
    await noteFilesListed("restart-a");
    // The worker is evicted and wakes again: a new module instance, nothing in its memory, the same session storage.
    const fresh = await import(`../src/sw/sw-files-hide.ts?restart=${Date.now()}`);
    const heard = [];
    const off = fresh.signalFilesHideChanges((hash) => heard.push(hash));
    const r = fresh.addFilesRule("restart-a", { effect: "hide", source: "/files/agent/after-restart.txt", scope: "session" });
    await fresh.filesListedIdle();
    assert.deepEqual(heard, ["restart-a"], "the session listed before the restart is hinted after it");
    fresh.removeFilesRule("restart-a", r.id, true);
    await fresh.filesListedIdle();
    off();
});

test("the files-changed hint: a rule change that arrives before the stored map has loaded is compared after the load, not dropped", async () => {
    await noteFilesListed("late-a");
    let open;
    sessionGate = new Promise((res) => { open = res; });
    const heard = [];
    const off = signalFilesHideChanges((hash) => heard.push(hash));
    const r = addFilesRule("late-a", { effect: "hide", source: "/files/agent/late.txt", scope: "session" });
    await new Promise((res) => setTimeout(res, 10));
    assert.deepEqual(heard, [], "nothing is said before the map is read");
    open();
    sessionGate = Promise.resolve();
    await filesListedIdle();
    assert.deepEqual(heard, ["late-a"], "the change waited for the map and was compared against it");
    off();
    removeFilesRule("late-a", r.id, true);
    await filesListedIdle();
});

test("a policy change tells the offscreen reader to drop its lists", () => {
    const off = signalFilesHideChanges();
    sent.length = 0;
    addFilesRule("h9", { effect: "hide", source: "/files/agent/z.txt", scope: "session" });
    assert.ok(sent.some((m) => m.type === "FILES_HIDE_CHANGED"));
    off();
});

// --- the reader bound by the list ---

/** A reader over one session holding `.env` and `notes.txt` attached as h1, with the rule asking `ask`. */
function readerWith(ask, now) {
    const bytes = new TextEncoder().encode("TOKEN=abc");
    const rows = [{ handle: "h1", name: ".env", key: "k1", bytes: bytes.length, sha256: "s1", attachedMs: 1 }, { handle: "h2", name: "notes.txt", key: "k2", bytes: bytes.length, sha256: "s2", attachedMs: 1 }];
    const source = { attached: async () => rows, blob: async () => new Blob([bytes]), secretForms: async () => [] };
    const hide = makeHideRule(ask, now);
    const ch = new RangedReader({ source, hidden: hide.rule }).openChannel("files");
    ch.setSession("sess");
    return { ch, hide };
}
const code = async (p) => { try { await p; return "ok"; } catch (e) { return e.code; } };

test("the reader: a default-held file is listed hidden and refused; a show releases it after the change signal", async () => {
    let entries = [];
    const { ch, hide } = readerWith(async () => entries);
    assert.equal((await ch.stat("attached/h1/.env")).hidden, true);
    assert.equal(await code(ch.open("attached/h1/.env")), "EACCES");
    assert.equal((await ch.stat("attached/h2/notes.txt")).hidden, false);
    entries = [{ id: "x", effect: "show", source: "/files/attached/h1/.env", layer: "session" }];
    assert.equal(await code(ch.open("attached/h1/.env")), "EACCES", "the list is reused until it changes");
    hide.forget();
    assert.equal(await code(ch.open("attached/h1/.env")), "ok");
});

test("the reader: a hide made while a file is open stops the next read through it", async () => {
    let entries = [];
    let t = 0;
    const { ch } = readerWith(async () => entries, () => t);
    const { fd } = await ch.open("attached/h2/notes.txt");
    entries = [{ id: "y", effect: "hide", source: "/files/attached/h2/notes.txt", layer: "global" }];
    t += HIDE_LIST_TTL_MS;
    assert.equal(await code(ch.read(fd, 0, 4, new Uint8Array(4))), "EACCES");
});

test("the reader: a list that cannot be had hides every path, and is asked for again", async () => {
    let fail = true;
    const { ch } = readerWith(async () => { if (fail) throw new Error("worker gone"); return []; });
    assert.equal((await ch.stat("attached/h2/notes.txt")).hidden, true);
    assert.equal(await code(ch.open("attached/h2/notes.txt")), "EACCES");
    fail = false;
    assert.equal(await code(ch.open("attached/h2/notes.txt")), "ok", "a failed ask is not kept");
    const unread = readerWith(async () => null);
    assert.equal(await code(unread.ch.open("attached/h2/notes.txt")), "EACCES", "a store the worker could not read answers null: hidden");
});

// --- why a path is hidden, and whether removing a rule is the way out ---

test("why: removing is the way out only for this session's hide on exactly that path; every other decider says show", async () => {
    const e = (id, effect, source, layer) => ({ id, effect, source, layer });
    const entries = [
        e("s-exact", "hide", "/files/agent/a.txt", "session"),
        e("s-dir", "hide", "/files/agent/priv", "session"),
        e("s-glob", "hide", "/files/agent/*.log", "session"),
        e("g-exact", "hide", "/files/agent/g.txt", "global"),
        e("s-show", "show", "/files/agent/priv/ok.txt", "session"),
    ];
    const { rule, why } = makeHideRule(async () => entries);
    assert.deepEqual(await why("s", "agent/a.txt"), { by: "s-exact", unhide: "remove" });
    assert.deepEqual(await why("s", "agent/priv/x.txt"), { by: "s-dir", unhide: "show" }, "a hide on a directory above holds other paths too");
    assert.deepEqual(await why("s", "agent/priv"), { by: "s-dir", unhide: "remove" }, "the directory itself is its rule's exact path");
    assert.deepEqual(await why("s", "agent/run.log"), { by: "s-glob", unhide: "show" }, "a glob holds other paths too");
    assert.deepEqual(await why("s", "agent/g.txt"), { by: "g-exact", unhide: "show" }, "a global rule is not this session's to remove");
    assert.deepEqual(await why("s", "attached/h1/.env"), { by: "default:dotenv", unhide: "show" });
    assert.equal(await rule("s", "agent/priv/ok.txt"), false, "a session show on a file under a session-hidden directory releases it");
    assert.equal(await rule("s", "agent/priv/x.txt"), true, "its neighbours stay held");
    assert.deepEqual(await why("s", "agent/plain.txt"), { unhide: "show" }, "no deciding rule: no `by`");
});

// --- every reader in src/ is built with the rule ---

/** Every hand-written .ts file under src/ (a generated `*.gen.ts` quotes source, it does not run it). */
function sources(dir = "src") {
    return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") && !p.endsWith(".gen.ts") ? [p] : []; });
}

test("ENUMERATED: every RangedReader in src/ is built with a hide rule, and the list of them is pinned", () => {
    const built = [];
    for (const f of sources()) {
        const text = readFileSync(f, "utf8");
        for (const m of text.matchAll(/new RangedReader\(/g)) {
            const call = text.slice(m.index, text.indexOf("\n", m.index));
            built.push(f);
            assert.match(call, /hidden:/, `${f}: a RangedReader built without the hide rule reads past every hide`);
        }
    }
    // A new reader is a new place a hidden file can be read: add it here only once it is built with the rule.
    assert.deepEqual(built, ["src/offscreen.ts"]);
});

test("ENUMERATED: the front ends that read /files all open channels on that one reader", () => {
    const opens = [];
    for (const f of sources()) {
        const text = readFileSync(f, "utf8");
        for (const m of text.matchAll(/\.openChannel\(/g)) opens.push(`${f}:${text.slice(Math.max(0, m.index - 20), m.index).trim().split(/[\s(=>]+/).pop()}`);
    }
    // Python's mount (files-host.ts, through setFilesReader) and ml.fs (fs-serve.ts, once it lands) both use `filesReader`.
    for (const o of opens) assert.match(o, /filesReader$/, `${o}: a channel on a reader other than the one bound by the hide rule`);
    assert.ok(opens.length >= 1);
});
