// current-client.test.mjs — `ml.current.client` (current-client.ts): who sent a user message, read from the channel it
// came over, never from what the message says about itself (docs/spec/CURRENT_CONTEXT.md, "The runtime and the client").
//
// Four places decide it, each tested here: the projection from a recorded origin (`clientOf`), the command handler's
// reading of the channel (`commandOrigin`), the snapshot that puts it on `meta[i]` and on `client`, and the chat client
// that makes the one claim a sender is allowed (`ui`).
import test from "node:test";
import assert from "node:assert/strict";
import { clientOf, clientUiOf } from "../src/agent/current-client.ts";
import { PROMPT_SURFACE_LABEL, promptSurfaceNote, seesPage } from "../src/agent/prompt-surface.ts";
import { snapshotCurrent, UNRECORDED } from "../src/agent/current-context.ts";
import { commandOrigin, THIS_BROWSER } from "../src/session/session-commands.ts";
import { SCOPE_NAMES } from "../src/session/session-host.ts";
import { ChatStore } from "../src/chat/chat-store.ts";
import { clientUi, webPlatform } from "../src/chat/platform.ts";

const SURFACES = Object.keys(PROMPT_SURFACE_LABEL);
const ORIGINS = SURFACES.flatMap((surface) => [{ surface }, { surface, remote: true }]);

// --- the record from an origin ---

test("seesPage and the prose note agree on every surface, here and remote: one rule, two readers", () => {
    for (const o of ORIGINS) {
        const blind = /cannot see the page/.test(promptSurfaceNote(o));
        assert.equal(seesPage(o), !blind, JSON.stringify(o));
        assert.equal(clientOf(o).seesPage, seesPage(o), JSON.stringify(o));
    }
    // The one case that cannot see it, so the loop above is not vacuous.
    assert.equal(clientOf({ surface: "chat", remote: true }).seesPage, false);
});

test("via is hub only for the chat app on another device; every other origin is this browser and holds every scope", () => {
    for (const o of ORIGINS) {
        const c = clientOf(o);
        const hub = o.surface === "chat" && o.remote === true;
        assert.equal(c.via, hub ? "hub" : "this browser", JSON.stringify(o));
        assert.equal(c.surface, o.surface);
        if (!hub) assert.deepEqual(c.may, Object.fromEntries(SCOPE_NAMES.map((s) => [s, true])), "this browser may do everything");
    }
});

test("a hub sender's may is its scopes, one boolean per known scope; without scopes it says nothing rather than guess", () => {
    const c = clientOf({ surface: "chat", remote: true, scopes: ["view", "drive", "not-a-scope"] });
    assert.deepEqual(Object.keys(c.may).sort(), [...SCOPE_NAMES].sort(), "keyed by the Scope union, and only by it");
    assert.equal(c.may.drive, true);
    assert.equal(c.may.view, true);
    assert.equal(c.may.approve, false, "approve is never implied by drive");
    assert.equal(c.may.admin, false);
    assert.equal("may" in clientOf({ surface: "chat", remote: true }), false, "unknown scopes: absent, not all-false");
});

test("an unknown origin is no record at all, never 'this browser'", () => {
    for (const o of [null, undefined, {}, { remote: true }]) assert.equal(clientOf(o), null, JSON.stringify(o));
});

test("a ui claim keeps only short names: an id, a URL, an origin or a long string cannot ride it", () => {
    const hex = "a".repeat(64);
    assert.deepEqual(clientUiOf(["printDoc", "pairing", "printDoc"]), ["printDoc", "pairing"], "deduplicated");
    assert.equal(clientUiOf([hex, "https://evil.example/x", "https://a.b", "x".repeat(41), "1abc", "a b", 7, null, { a: 1 }]), undefined);
    assert.equal(clientUiOf("printDoc"), undefined, "not a list");
    assert.equal(clientUiOf([]), undefined);
    assert.equal(clientUiOf(Array.from({ length: 40 }, (_, i) => `n${i}`)).length, 16, "capped");
    assert.equal("ui" in clientOf({ surface: "chat", ui: [hex] }), false);
});

// --- the command handler reads the channel ---

test("commandOrigin: the channel says where and which scopes; the command can add only a ui claim", () => {
    assert.deepEqual(commandOrigin(THIS_BROWSER), { surface: "chat" });
    assert.deepEqual(commandOrigin({ via: "this browser", scopes: ["view"] }), { surface: "chat" }, "this browser carries no scope list: it holds them all");
    assert.deepEqual(commandOrigin({ via: "hub", scopes: ["view", "drive"] }), { surface: "chat", remote: true, scopes: ["view", "drive"] });
    assert.deepEqual(commandOrigin({ via: "hub" }), { surface: "chat", remote: true });
    assert.deepEqual(commandOrigin({ via: "hub", scopes: ["view"] }, ["printDoc", "https://x.example"]), { surface: "chat", remote: true, scopes: ["view"], ui: ["printDoc"] });
    // A body that claims to be from the hub, or to hold scopes, is a body: only `from` is read for either.
    assert.deepEqual(commandOrigin(THIS_BROWSER, { remote: true, scopes: ["admin"] }), { surface: "chat" });
});

// --- the snapshot: meta[i].client, and client as the latest user message's ---

test("meta[i].client is on user messages only, and client is the LATEST user message's: the conversation changing hands", () => {
    const here = clientOf({ surface: "hud" });
    const away = clientOf({ surface: "chat", remote: true, scopes: ["view", "drive"] });
    const s = snapshotCurrent({
        run: { id: "h1", model: null, step: 1, maxSteps: 5, startedTs: 1 },
        messages: [{ role: "system", content: "s" }, { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }],
        recorded: [{ ...UNRECORDED, ts: 1, client: here }, { ...UNRECORDED, ts: 1, client: here }, { ...UNRECORDED, ts: 2, client: here }, { ...UNRECORDED, ts: 3, client: away }],
        now: 4,
    });
    assert.deepEqual(s.meta.map((m) => m.client?.via ?? null), [null, "this browser", null, "hub"]);
    assert.deepEqual(s.client, away);
    assert.notEqual(s.client, s.meta[3].client, "copies: a script writing one does not change the other");
});

test("UPGRADE: history with no recorded sender reads as unknown, never as this browser", () => {
    // What a resumed session carries in: its earlier messages were appended by a turn that is gone, so nothing recorded
    // them, as with every session stored before this field existed.
    const s = snapshotCurrent({
        run: { id: "h1", model: null, step: 1, maxSteps: 5, startedTs: 1 },
        messages: [{ role: "system", content: "s" }, { role: "user", content: "old" }, { role: "assistant", content: "b" }, { role: "user", content: "older still" }],
        recorded: [{ ...UNRECORDED, ts: 1 }],
        now: 4,
    });
    assert.equal(s.meta.some((m) => "client" in m), false);
    assert.equal("client" in s, false);
});

// --- the client's own claim ---

test("clientUi names the platform's optional members it has: the phone app's WebView has no print dialog", () => {
    assert.deepEqual(clientUi(webPlatform), ["printDoc"]);
    assert.deepEqual(clientUi({ ...webPlatform, pairing: {} }), ["printDoc", "pairing"]);
    const { printDoc: _p, ...native } = webPlatform;
    assert.deepEqual(clientUi({ ...native, kind: "native" }), []);
});

test("the store stamps its ui on the two commands that carry a person's message, and on nothing else", async () => {
    const sent = [];
    const store = new ChatStore({ send: async (c) => { sent.push(c); return { ok: true, data: {} }; } });
    await store.send({ type: "session.send", session: { runtime: "r", hash: "h" }, text: "older client" });
    store.ui = ["printDoc"];
    await store.send({ type: "session.send", session: { runtime: "r", hash: "h" }, text: "hi" });
    await store.send({ type: "agent.start", runtime: "r", task: "t", target: { kind: "new" } });
    await store.send({ type: "session.cancel", session: { runtime: "r", hash: "h" } });
    assert.deepEqual(sent.map((c) => c.ui ?? null), [null, ["printDoc"], ["printDoc"], null]);
});
