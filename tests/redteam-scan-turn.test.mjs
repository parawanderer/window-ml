// redteam-scan-turn.test.mjs — ruling 39 PR 2's red-team pass (SECRET_HANDLES.md, "What the person sends is scrubbed
// too", the chip and "send as is"): what a hostile page, a relayed content script, a paired device or a replayed token
// must NOT get from the scan and the exemption.
//
// The lane's rows (tests/scan-turn.test.mjs, tests/scan-turn-paths.test.mjs) hold the feature's own paths: a token per
// value, a lost key, an edited draft, a page's tokens ignored, a hub device's dropped. These hold what the branches do
// not reach: a token made for one value used against another, a token replayed after the key was re-minted, the key or
// a token in what a turn produces, an exemption's reach across a chat's turns, and SCAN_TURN / ML_SESSION_REMOTE from a
// sender that is not the extension's own frame.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const sessionStore = {};
globalThis.chrome = {
    runtime: { id: "ext-id", lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => p },
    storage: {
        local: { get: async (d) => ({ ...(d ?? {}) }), set: async () => {}, remove: async () => {} },
        sync: { get: async (d) => ({ ...(d ?? {}), apiKey: "sk-test-key-012345", scrubPersonInput: true }), set: async () => {} },
        session: { get: async (k) => (typeof k === "string" && k in sessionStore ? { [k]: structuredClone(sessionStore[k]) } : { ...structuredClone(sessionStore) }), set: async (o) => { Object.assign(sessionStore, structuredClone(o)); }, remove: async (k) => { delete sessionStore[k]; } },
        onChanged: { addListener() {} },
    },
};
const { _setRegistryForTest } = await import("../src/sw/sw-secret-registry.ts");
const { scanTurn, forTurn, forModelHistory, EXEMPT_KEY, _forgetExemptKeyForTest } = await import("../src/sw/sw-scrub.ts");
const { commandAsIs } = await import("../src/session/session-commands.ts");
const { PAGE_STARTED_TYPES } = await import("../src/page-relay.ts");

const T = { timeout: 20000 };
const A = { name: "PLUG_PASSWORD", value: "REALSECRET-alpha-77" };
const B = { name: "OTHER_TOKEN", value: "REALSECRET-bravo-88" };
const MARK = (n) => `[REDACTED:${n}]`;
_setRegistryForTest([A, B]);

/** A fresh exemption key, as a restart mints one. */
function remintKey() {
    delete sessionStore[EXEMPT_KEY];
    _forgetExemptKeyForTest();
}
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// --- a token is about its own content, and about nothing after the key is gone ---

test("a token made for one value exempts that value only, never another", async () => {
    remintKey();
    const { spans } = await scanTurn([`pw ${A.value} and ${B.value}`]);
    const forA = spans[0].find((s) => s.name === A.name).token;
    const sc = await forTurn({ asIs: [forA] });
    const out = sc.text(`pw ${A.value} and ${B.value}`);
    assert.equal(out, `pw ${A.value} and ${MARK(B.name)}`, `the wrong value was exempted: ${out}`);
    assert.deepEqual(sc.sentAsIs(), [A.name]);
});

test("a token replayed after the key is re-minted exempts nothing, and the value is scrubbed again", async () => {
    remintKey();
    const { spans } = await scanTurn([A.value]);
    const old = spans[0][0].token;
    remintKey();   // the worker restarted: a new key in session storage
    const sc = await forTurn({ asIs: [old] });
    assert.equal(sc.text(`pw ${A.value}`), `pw ${MARK(A.name)}`, "a token from the old key still exempted the value");
    assert.deepEqual(sc.sentAsIs(), []);
});

test("a token is no oracle: the same value mints the same token, a different one does not, and neither is the value", async () => {
    remintKey();
    const one = (await scanTurn([A.value])).spans[0][0].token;
    const again = (await scanTurn([`x ${A.value}`])).spans[0][0].token;
    const other = (await scanTurn([B.value])).spans[0][0].token;
    assert.equal(one, again, "the same content minted two tokens");
    assert.notEqual(one, other, "two values share a token");
    assert.match(one, /^[0-9a-f]{32}$/);
    assert.ok(!one.includes(A.value.slice(0, 6)) && !A.value.includes(one), "the token carries the value");
});

// --- nothing of the key or a token rides the turn ---

test("neither the key nor a token appears in the turn's text, its display or its note", async () => {
    remintKey();
    const { spans } = await scanTurn([A.value]);
    const token = spans[0][0].token;
    const sc = await forTurn({ asIs: [token] });
    const text = sc.text(`pw ${A.value}${sc.note()}`);
    assert.ok(text.includes(A.value), "the person's own 'send as is' value did not reach the turn");
    assert.ok(!text.includes(token), "a token is in the turn's text");
    assert.ok(!/[0-9a-f]{32}/.test(text.replace(A.value, "")), `a hex token is in the text: ${text}`);
    // The display marks the value by NAME (withAsIs, in sw-scrub.ts), which is the only record the turn keeps.
    const { withAsIs } = await import("../src/sw/sw-scrub.ts");
    const display = JSON.stringify(withAsIs(undefined, sc, "pw") ?? {});
    assert.ok(display.includes(A.name) && !display.includes(token), display);
    assert.ok(!display.includes(sessionStore[EXEMPT_KEY]), "the key rode the display");
});

// --- a chat's other turns ---

test("an exemption is this turn's: a stored chat's turns are scrubbed with a plain scrub, whatever one turn was sent as is", async () => {
    remintKey();
    const { spans } = await scanTurn([A.value]);
    const sc = await forTurn({ asIs: [spans[0][0].token] });
    assert.ok(sc.text(A.value).includes(A.value), "control: the token exempts this turn");
    // A resume reads the stored history with a scrub built WITHOUT tokens (none are stored), so both turns are scrubbed.
    const history = [{ role: "user", content: `first ${A.value}` }, { role: "assistant", content: "ok" }, { role: "user", content: `second ${A.value}` }];
    await forModelHistory(history, await forTurn({}));
    assert.deepEqual(history.filter((m) => m.role === "user").map((m) => m.content), [`first ${MARK(A.name)}`, `second ${MARK(A.name)}`]);
});

// --- the senders ---

test("SCAN_TURN is refused for a page and a relayed content script, before the payload is read, and neither learns a span", async () => {
    const bg = loadBackground({ config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "m", apiFormat: "openai" }, local: { ml_secret_registry: [A] } });
    for (const sender of [{ tab: { id: 7, url: "https://site.example/" }, url: "https://site.example/", origin: "https://site.example" }, { tab: { id: 7, url: "https://site.example/" }, url: "chrome-extension://ext/content.js?page=https://site.example/", origin: "https://site.example" }]) {
        // The payload is a getter that throws: if the handler read it before judging the sender, this row fails with
        // that throw rather than an answer, which is what "before the payload is read" means measurably.
        const payload = {};
        Object.defineProperty(payload, "texts", { get() { throw new Error("the payload was read before the sender was judged"); } });
        const r = await bg.send({ type: "SCAN_TURN", payload }, sender);
        assert.equal(r.error, "refused", `a non-extension sender got ${JSON.stringify(r)}`);
        assert.equal("data" in r, false, `a non-extension sender was answered spans: ${JSON.stringify(r)}`);
    }
    assert.ok(!PAGE_STARTED_TYPES.has("SCAN_TURN"), "SCAN_TURN is a page-started type");
});

test("ML_SESSION_REMOTE from a page tab is refused, and asIs from any sender but the extension's own frame is dropped", async () => {
    // The command layer's rule, in one function: `via` is the worker's account of who asked, so a token list from a hub
    // device or a page is not even looked at.
    const tokens = ["a".repeat(32)];
    assert.equal(commandAsIs(tokens, { via: "hub" }), undefined, "a hub device's asIs survived");
    assert.equal(commandAsIs(tokens, { via: "page" }), undefined, "a page's asIs survived");
    assert.deepEqual(commandAsIs(tokens, { via: "this browser" }), tokens, "control: the extension's own frame keeps them");
    assert.equal(commandAsIs(["x".repeat(65)], { via: "this browser" }), undefined, "a >64-character token is not a token");
    // And a page cannot send the remote call at all: it is not a page-started type, so the router never relays it.
    assert.ok(!PAGE_STARTED_TYPES.has("ML_SESSION_REMOTE"), "ML_SESSION_REMOTE is a page-started type");
});
