// redteam-files-hide.test.mjs — the red-team pass on ruling 34's first build (#2088, feat/hide-show-files, POLICIES.md
// "Hiding files"): the `files` consumer of `hide` and `show`, the offscreen `/files` reader bound by the worker's
// resolved list, and the one `policy.files` command. Every row states what a hostile page, a model, or one careless
// gesture must NOT get. This list binds the extension's own readers (`/files` in Python, ml.fs); since PR B (#2155)
// every spawn the worker makes carries it too (tests/redteam-spawn-hide.test.mjs), and a host that does not declare it
// is refused while a `hide` applies. Still a stated limit, in force at this head and NOT rowed as an escape: a file
// made after the call starts, or renamed over the path, is not covered for that call (the hide list's stated limit).
//
// The builder's rows (tests/files-hide.test.mjs, tests/files-hide-policies.test.mjs) hold the rule's own tables, the
// upgrade from an empty store, the add/remove path, two refusals, the reader's open/read under one spelling, and the
// enumerated `new RangedReader`/`openChannel` sites. These hold the routes they do not take: every sender shape at the
// router, the spellings and verbs a reader can be handed, the refusals in obfuscated form and what a refused rule
// stored by ANY route decides, the generic policy page, and the routes that are not the command.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadBackground } = require("./helpers");

// The worker-side modules read chrome.storage at evaluation; a plain in-memory store is enough here (the router rows use
// the background harness's own store, seeded per test).
let stored = { ml_policies_global: [], ml_policies_run: {} };
globalThis.chrome = {
    runtime: { getURL: (p = "") => `chrome-extension://test/${p}`, sendMessage: async () => ({}), onMessage: { addListener: () => {} } },
    storage: {
        local: { get: async () => structuredClone(stored), set: async (o) => { stored = { ...stored, ...structuredClone(o) }; } },
        sync: { get: async (d) => ({ ...d }), set: async () => {} },
    },
};

const { resolveHidden, patternRefusal } = await import("../src/files-hide.ts");
const { makeHideRule } = await import("../src/session/files-hide-rule.ts");
const { RangedReader } = await import("../src/session/ranged-reader.ts");
const { createCommandHandler } = await import("../src/session/session-commands.ts");
const { SessionIndex } = await import("../src/session/session-index.ts");
const P = await import("../src/sw/sw-policies.ts");
const { addFilesRule, removeFilesRule } = await import("../src/sw/sw-files-hide.ts");
const { checkProposal } = await import("../src/sw/policy-proposal.ts");
const { settingDecl } = await import("../src/setting-class.ts");
const { DEFAULT_CONFIG } = await import("../src/contract/contract-config.ts");
await P.policiesReady;

const LIMIT = "(a file made or renamed after the call starts is not covered — the hide list's stated limit)";
const EXT = { url: "chrome-extension://test/chat.html" };
const OFFSCREEN = { url: "chrome-extension://test/offscreen.html" };
const pageSender = (tabId) => ({ tab: { id: tabId, url: "https://site.example/page" }, url: "https://site.example/page", origin: "https://site.example", frameId: 0 });
const filesRule = (id, effect, source, scope = "global") => ({ id, scope, consumer: "files", effect, source, label: `${effect} ${source}`, origin: "person", created: 1 });
const code = async (p) => { try { await p; return "ok"; } catch (e) { return e.code ?? String(e); } };
/** An answer from the background harness's vm, as a plain object (its own realm's prototypes fail deepStrictEqual). */
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));

// --- the reader: no verb, and no spelling, reaches a held file ---

/** A reader over one session holding `.env` (h1) and `notes.txt` (h2), with the rule over `entries`; the clock is frozen so
 *  only `hide.forget()` refreshes the list. */
function readerOver(entries) {
    const bytes = new TextEncoder().encode("TOKEN=abc");
    const rows = [
        { handle: "h1", name: ".env", key: "k1", bytes: bytes.length, sha256: "s1", attachedMs: 1 },
        { handle: "h2", name: "notes.txt", key: "k2", bytes: bytes.length, sha256: "s2", attachedMs: 1 },
    ];
    const source = { attached: async () => rows, blob: async () => new Blob([bytes]), secretForms: async () => [] };
    const hide = makeHideRule(async () => entries, () => 0);
    const ch = new RangedReader({ source, hidden: hide.rule }).openChannel("files");
    ch.setSession("sess");
    return { ch, hide };
}

test(`RED TEAM: a held file's bytes come out of no verb, in any spelling ${LIMIT}`, async () => {
    const { ch } = readerOver([]);
    // Positive control: with nothing holding it a file reads, so every refusal below is the rule's, not the harness's.
    const { fd } = await ch.open("attached/h2/notes.txt");
    const buf = new Uint8Array(5);
    assert.equal(await ch.read(fd, 0, 5, buf), 5);
    assert.equal(new TextDecoder().decode(buf), "TOKEN");
    // The default hold: stat marks it, open refuses, and the listing names it without carrying a byte of it.
    assert.equal((await ch.stat("attached/h1/.env")).hidden, true, "stat says a held file is readable");
    assert.equal(await code(ch.open("attached/h1/.env")), "EACCES");
    const dir = await ch.opendir("attached/h1", { limit: 10 });
    const listed = dir.entries.find((e) => e.name === ".env");
    assert.ok(listed && listed.hidden === true, "the held name is listed and marked hidden");
    for (const k of Object.keys(listed)) assert.ok(!/content|bytes|body|text|blob/i.test(k), `a listed entry carries ${k}`);
    // Every other spelling a caller might try is refused before it resolves, so the rule is given exactly the string it
    // matched on and no alternate spelling reaches the bytes.
    for (const p of ["/attached/h1/.env", "./attached/h1/.env", "attached/h1/./.env", "attached/h1/../h1/.env", "attached//h1/.env", "attached/h1/.env/", "attached/h1/.env\u0000"]) {
        assert.equal(await code(ch.open(p)), "ENOENT", `${JSON.stringify(p)} opened past the rule`);
        assert.equal(await code(ch.stat(p)), "ENOENT", `${JSON.stringify(p)} stated past the rule`);
    }
    // A descriptor opened BEFORE a mid-session hide: its read and its fstat both consult the rule, not the open time.
    const list = [];
    const live = makeHideRule(async () => list, () => 0);
    const src = { attached: async () => [{ handle: "h3", name: "a.txt", key: "k3", bytes: 5, sha256: "s3", attachedMs: 1 }], blob: async () => new Blob([new TextEncoder().encode("HELLO")]), secretForms: async () => [] };
    const ch3 = new RangedReader({ source: src, hidden: live.rule }).openChannel("files");
    ch3.setSession("sess");
    const o = await ch3.open("attached/h3/a.txt");
    assert.equal(await ch3.read(o.fd, 0, 5, new Uint8Array(5)), 5, "positive control: readable before the hide");
    list.push({ id: "h", effect: "hide", source: "/files/attached/h3/a.txt", layer: "session" });
    live.forget();
    assert.equal(await code(ch3.read(o.fd, 0, 5, new Uint8Array(5))), "EACCES", "a descriptor outlived the hide");
    assert.equal((await ch3.fstat(o.fd)).hidden, true, "fstat did not consult the rule");
});

// --- the router: FILES_HIDE_LIST answers the offscreen document alone ---

test(`RED TEAM: FILES_HIDE_LIST answers no sender but the offscreen document, and only that session's rules ${LIMIT}`, async () => {
    const bg = loadBackground({
        local: {
            ml_policies_global: [filesRule("hid-g", "hide", "/files/agent/global.txt")],
            ml_policies_run: { h1: [filesRule("hid-s", "hide", "/files/agent/s1.txt", "run")] },
        },
    });
    for (const [who, sender] of [
        ["a page", pageSender(7)],
        ["an extension page", EXT],
        ["a DevTools panel", { url: "chrome-extension://test/devtools.html" }],
        ["the offscreen URL with a tab", { tab: { id: 7 }, url: "chrome-extension://test/offscreen.html" }],
    ]) assert.deepEqual(plain(await bg.send({ type: "FILES_HIDE_LIST", session: "h1" }, sender)), { entries: null }, `${who} got the list`);
    for (const bad of [{ session: 5 }, { session: "" }, { session: { hash: "h1" } }, {}])
        assert.deepEqual(plain(await bg.send({ type: "FILES_HIDE_LIST", ...bad }, OFFSCREEN)), { entries: null }, `the offscreen document answered ${JSON.stringify(bad)} with the list`);
    // Positive control: the offscreen document does get the session's list, and only that session's session rules.
    const got = await bg.send({ type: "FILES_HIDE_LIST", session: "h1" }, OFFSCREEN);
    assert.ok(got.entries.some((e) => e.source === "/files/agent/global.txt") && got.entries.some((e) => e.source === "/files/agent/s1.txt"), JSON.stringify(got));
    const other = await bg.send({ type: "FILES_HIDE_LIST", session: "h2" }, OFFSCREEN);
    assert.ok(!other.entries.some((e) => e.source === "/files/agent/s1.txt"), "another session's session rule was in the answer");
});

// --- the refusals, in obfuscated form, and the belt under every other write route ---

test(`RED TEAM: a show over a credential directory, ** or .. is refused in every obfuscated form ${LIMIT}`, () => {
    for (const d of [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store", "Keychains"]) {
        const at = (s) => `/files/agent/${s}/x`;
        const classed = d[0] === "." ? `[.]${d.slice(1)}` : `[${d[0]}]${d.slice(1)}`;
        for (const s of [at(d), `/files/agent/${d}`, `/files/attached/h1/${d}/id_rsa`, at(classed), at(`${d.slice(0, -1)}?`), at(`.*${d.slice(-1)}`)])
            assert.equal(typeof patternRefusal(s, "show"), "string", `show ${s} was accepted`);
    }
    for (const d of ["gcloud", "gh"])
        for (const s of [`/files/agent/.config/${d}/x`, `/files/agent/.config/${d}`, `/files/agent/.config/${d.slice(0, -1)}?/x`, `/files/agent/.config/${d[0]}*/x`, `/files/agent/.c*/${d}/x`])
            assert.equal(typeof patternRefusal(s, "show"), "string", `show ${s} was accepted`);
    for (const s of ["/files/agent/../../x", "/files/../agent/x", "/files/agent/x/..", "/files/agent/**", "/files/**/x", "/files/**", "/files/agent/a**b", "/**"]) {
        assert.equal(typeof patternRefusal(s, "show"), "string", `show ${s} was accepted`);
        assert.equal(typeof patternRefusal(s, "hide"), "string", `hide ${s} was accepted`);
    }
    // Positive controls: ordinary paths, globs and the non-credential lookalikes are accepted.
    for (const s of ["/files/agent/.env", "/files/agent/*.txt", "/files/agent/gcloud/x", "/files/agent/.config/other/x", "/files/agent/Keychains.md"])
        assert.equal(patternRefusal(s, "show"), undefined, `show ${s} was refused`);
});

test(`RED TEAM: a refused rule stored by ANY route decides nothing ${LIMIT}`, () => {
    // The refusals are checked again when the list is resolved, so a row that reached storage around the command (an
    // imported backup, an older build, a direct settings edit) cannot release through a refused pattern.
    const hide = { id: "h", effect: "hide", source: "/files/agent/.ssh/id_rsa", layer: "global" };
    for (const stored of [
        { id: "s1", effect: "show", source: "/files/agent/.ssh/id_rsa", layer: "session" },
        { id: "s2", effect: "show", source: "/files/agent/.ssh", layer: "session" },
        { id: "s3", effect: "show", source: "/files/agent/**", layer: "global" },
        { id: "s4", effect: "show", source: "/files/agent/../../.env", layer: "session" },
    ]) assert.deepEqual(resolveHidden("/files/agent/.ssh/id_rsa", [stored, hide]), { hidden: true, by: "h" }, `stored "${stored.source}" (${stored.effect}) released it`);
    assert.deepEqual(resolveHidden("/files/agent/.env", [{ id: "s5", effect: "show", source: "/files/agent/**.env", layer: "session" }]), { hidden: true, by: "default:dotenv" });
    assert.equal(resolveHidden("/files/agent/.env", [{ id: "s6", effect: "show", source: "/files/agent/.env", layer: "session" }]).hidden, false, "positive control: a valid show releases");
});

// --- the generic policy page cannot drop or neuter a hiding rule ---

test(`RED TEAM: the policy page cannot remove a hiding rule without the widening confirmation ${LIMIT}`, async () => {
    // The DevTools Settings policy list renders every stored rule with one-click Remove and Edit (settings.tsx,
    // PolicyRow). For a `files` row those send the generic `remove`/`edit` ops, which know nothing of the removal class:
    // removing a `hide` widens, and the spec has the renderer show the entry and the paths it would release first.
    const bg = loadBackground({ local: { ml_policies_global: [filesRule("hid-d1", "hide", "/files/agent/redteam-r.txt"), filesRule("hid-d2", "hide", "/files/agent/redteam-c.txt")], ml_policies_run: {} } });
    const removed = await bg.send({ type: "POLICIES", payload: { op: "remove", id: "hid-d1" } }, EXT);
    const still = (bg.localStore.ml_policies_global ?? []).some((p) => p.id === "hid-d1");
    assert.ok(still, `one click on the policy page dropped a hiding rule with no confirmation and no list of what it exposes${removed?.error ? ` (it answered "${removed.error}")` : ""}`);
    // The route the session view uses DOES wait for the confirm: positive control that the removal classes are sound.
    const ask = await bg.send({ type: "POLICIES", payload: { op: "removeChecked", hash: "h1", id: "hid-d2" } }, EXT);
    assert.equal(ask?.error, "confirm", JSON.stringify(ask));
});

test(`RED TEAM: the policy page cannot turn a hiding rule into one that decides nothing ${LIMIT}`, async () => {
    const bg = loadBackground({ local: { ml_policies_global: [filesRule("hid-e", "hide", "/files/agent/redteam-e.txt")], ml_policies_run: {} } });
    // PolicyRow's effect select offers allow/ask/deny. Saved over a `hide`, `editPolicy` stores the value, leaves the
    // consumer `files` (which `judgeCall` never evaluates), and `filesHideEntries` then drops the row: the hold vanishes
    // silently, with the row still shown as a policy.
    await bg.send({ type: "POLICIES", payload: { op: "edit", id: "hid-e", effect: "allow" } }, EXT);
    const row = (bg.localStore.ml_policies_global ?? []).find((p) => p.id === "hid-e");
    assert.ok(row && (row.effect === "hide" || row.effect === "show"), `the page turned a hide into "${row?.effect}", which holds nothing and judges nothing`);
    // A source edited to a refused pattern is inert: the belt above holds even when the edit itself goes through.
    await bg.send({ type: "POLICIES", payload: { op: "edit", id: "hid-e", source: "/files/**" } }, EXT);
    const after = (bg.localStore.ml_policies_global ?? []).find((p) => p.id === "hid-e");
    if (after?.effect === "hide") assert.equal(resolveHidden("/files/agent/redteam-e.txt", [{ id: after.id, effect: "hide", source: after.source, layer: "global" }]).hidden, true);
});

// --- no other route writes a files rule ---

test(`RED TEAM: no page, model or setting writes a files rule; the one command is the route ${LIMIT}`, async () => {
    const bg = loadBackground({ local: { ml_policies_global: [], ml_policies_run: {} } });
    // The policy page's add op takes fetch/sh/setting only; `files` is refused and nothing is stored.
    const r = await bg.send({ type: "POLICIES", payload: { op: "add", consumer: "files", effect: "hide", source: "/files/agent/x.txt", label: "hide x.txt" } }, EXT);
    assert.ok(r?.error, "the policy page stored a files rule");
    assert.equal((bg.localStore.ml_policies_global ?? []).length, 0);
    // A page (or its content-script relay) is refused the policy page outright.
    assert.equal(plain(await bg.send({ type: "POLICIES", payload: { op: "list" } }, pageSender(7))).error, "refused");
    // Positive control: the same add op does work for its own consumers, so the refusal above is about `files`.
    const ok = await bg.send({ type: "POLICIES", payload: { op: "add", consumer: "fetch", effect: "allow", source: '(c) => c.host === "a.example"', label: "fetch a.example" } }, EXT);
    assert.ok(ok?.data?.global?.some((p) => p.consumer === "fetch"), JSON.stringify(ok));
    // The model's proposal cannot name the consumer either, so there is no card route in yet.
    assert.match(checkProposal({ consumer: "files", effect: "hide", when: "(c) => true", label: "hide x" }).error, /consumer/);
    assert.ok(checkProposal({ consumer: "fetch", effect: "allow", when: '(c) => c.host === "a.example"', label: "fetch a.example" }).proposal, "positive control");
    // change_setting has no NAME for the store: every key it can take is one of the config's, and none is a policy key.
    assert.equal(settingDecl("ml_policies_global"), null);
    assert.equal(settingDecl("ml_policies_run"), null);
    const keys = Object.keys(DEFAULT_CONFIG);
    assert.ok(keys.length > 10, "positive control: the config was read");
    for (const k of keys) assert.ok(!/polic|hide/i.test(k), `a config key names the hiding list: ${k}`);
    assert.ok(settingDecl("theme"), "positive control: a real setting resolves");
    // And the one command: a refused pattern stores nothing, and the accepted one holds.
    const index = new SessionIndex({ runtime: "local", spawn: "w1" });
    index.ingest({ kind: "agent", id: "f11e0001", ts: 1, save: false, session: { hash: "f11e0001", turn: 0 }, task: "t", model: "m", maxSteps: 3, config: null }, { tabId: 1, trusted: true });
    const run = createCommandHandler({ runtime: "local", index, addFilesRule, removeFilesRule });
    const session = { runtime: "local", hash: "f11e0001" };
    for (const [effect, source] of [["hide", "/files/agent/**"], ["hide", "/files/agent/../x"], ["show", "/files/agent/.ssh/id_rsa"]]) {
        const out = await run({ type: "policy.files", session, op: "add", effect, source, scope: "session" }, { via: "hub", scopes: ["approve"] });
        assert.equal(out.error?.code, "invalid", `the command took ${effect} ${source}`);
    }
    const added = await run({ type: "policy.files", session, op: "add", effect: "hide", source: "/files/agent/redteam-cmd.txt", scope: "session" }, { via: "hub", scopes: ["approve"] });
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(resolveHidden("/files/agent/redteam-cmd.txt", P.filesHideEntries("f11e0001")).hidden, true);
});

// --- a widening removal sees every session it widens ---

test(`RED TEAM: a widening removal waits for the confirm, and a global hide taken from one session's view widens every session ${LIMIT}`, () => {
    // A session hide over a global show: removing the hide would let the show decide again, so it waits and names it.
    const show = addFilesRule("red-f1", { effect: "show", source: "/files/agent/redteam-f.txt", scope: "global" });
    const hide = addFilesRule("red-f1", { effect: "hide", source: "/files/agent/redteam-f.txt", scope: "session" });
    assert.equal(resolveHidden("/files/agent/redteam-f.txt", P.filesHideEntries("red-f1")).hidden, true);
    assert.deepEqual(removeFilesRule("red-f1", hide.id, false), { removed: false, why: "confirm", exposes: [show.id] });
    assert.ok(P.filesHideEntries("red-f1").some((e) => e.id === hide.id), "the hide went without the confirm");
    assert.deepEqual(removeFilesRule("red-f1", hide.id, true), { removed: true });
    P.removePolicy(show.id);
    // A global hide removed from one session's view widens EVERY session: refused without the confirm, and the other
    // session — which never showed the row — stays held until it is confirmed.
    const g = addFilesRule("red-f1", { effect: "hide", source: "/files/agent/redteam-g.txt", scope: "global" });
    assert.equal(resolveHidden("/files/agent/redteam-g.txt", P.filesHideEntries("red-f2")).hidden, true);
    assert.deepEqual(removeFilesRule("red-f1", g.id, false), { removed: false, why: "confirm", exposes: [] });
    assert.ok(P.filesHideEntries("red-f2").some((e) => e.id === g.id), "one session's refused removal changed another's");
    assert.deepEqual(removeFilesRule("red-f1", g.id, true), { removed: true });
    for (const h of ["red-f1", "red-f2"]) assert.equal(resolveHidden("/files/agent/redteam-g.txt", P.filesHideEntries(h)).hidden, false, h);
});
