// scan-turn.test.mjs — the composer's scan and "send as is" (ruling 39, PR 2; SECRET_HANDLES.md, "Per value"): `scanTurn`
// answers spans, names and keyed tokens, and `forTurn` given tokens leaves the values they were made from and nothing
// else. The router's sender check and the entry points are tests/scan-turn-paths.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";

const VALUE = "REALSECRET-4b1d-77";
const OTHER = "OTHERSECRET-9c2e-11";
const KEY = "sk-test-config-key-0123";

const sync = { apiKey: KEY };
let session = {};
let localGet = async (d) => ({ ...(d ?? {}) });
globalThis.chrome = {
    runtime: { id: "ext-id", lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => p },
    storage: {
        local: { get: (d) => localGet(d), set: async () => {}, remove: async () => {} },
        sync: { get: async (d) => ({ ...(d ?? {}), ...sync }), set: async () => {} },
        session: {
            get: async (k) => (typeof k === "string" ? (k in session ? { [k]: session[k] } : {}) : { ...session }),
            set: async (o) => { Object.assign(session, o); },
            remove: async () => {},
        },
        onChanged: { addListener() {} },
    },
};
const { _setRegistryForTest, _coldRegistryForTest } = await import("../src/sw/sw-secret-registry.ts");
const { forTurn, scanTurn, withAsIs, EXEMPT_KEY, _forgetExemptKeyForTest } = await import("../src/sw/sw-scrub.ts");
const { TurnUnreadable } = await import("../src/secret-registry.ts");

_setRegistryForTest([{ name: "PLUG_PASSWORD", value: VALUE }, { name: "ROUTER_PIN", value: OTHER }]);

/** The scan's spans for one text. */
async function spansOf(text) { return (await scanTurn([text])).spans[0]; }

// --- the scan: offsets, names and tokens, never a value ---

test("the scan answers each registered value's offsets, name and a token, and never the value", async () => {
    const text = `pw ${VALUE} pin ${OTHER} key ${KEY}`;
    const r = await scanTurn([text, `file ${VALUE}`]);
    assert.equal(r.spans.length, 2);
    const [a, b, c] = r.spans[0];
    assert.deepEqual([a.name, b.name, c.name], ["PLUG_PASSWORD", "ROUTER_PIN", "window-ml-api-key"]);
    assert.equal(text.slice(a.start, a.end), VALUE);
    assert.equal(text.slice(c.start, c.end), KEY);
    for (const s of r.spans.flat()) assert.match(s.token, /^[0-9a-f]{32}$/);
    assert.equal(r.spans[1][0].token, a.token, "one value, one token, in every text of the draft");
    assert.notEqual(a.token, b.token);
    const wire = JSON.stringify(r);
    for (const v of [VALUE, OTHER, KEY]) assert.ok(!wire.includes(v), "the answer holds no value");
    assert.equal((await spansOf("nothing here")).length, 0);
});

test("the token is keyed: it is not a plain SHA-256 of the value, and the key lives in session storage", async () => {
    const [s] = await spansOf(VALUE);
    const { createHash } = await import("node:crypto");
    const plain = createHash("sha256").update(VALUE).digest("hex");
    assert.ok(!plain.startsWith(s.token), "a bare hash of a short secret would be an offline guessing oracle");
    assert.match(String(session[EXEMPT_KEY]), /^[0-9a-f]{64}$/);
});

test("the scan with scrubPersonInput off answers no spans and says so", async () => {
    sync.scrubPersonInput = false;
    try { assert.deepEqual(await scanTurn([VALUE]), { spans: [[]], off: true }); } finally { delete sync.scrubPersonInput; }
});

test("a registry that cannot be read makes the scan say so, as the send would refuse", async () => {
    localGet = async () => { throw new Error("gone"); };
    _coldRegistryForTest();
    try { assert.ok(await scanTurn([VALUE]).then(() => false, (e) => e instanceof TurnUnreadable)); } finally {
        localGet = async (d) => ({ ...(d ?? {}) });
        _setRegistryForTest([{ name: "PLUG_PASSWORD", value: VALUE }, { name: "ROUTER_PIN", value: OTHER }]);
    }
});

// --- send as is: the token leaves its value and nothing else ---

test("a token sends its value as is; a second value in the same turn is still redacted, and the note counts only it", async () => {
    const [s] = await spansOf(VALUE);
    const sc = await forTurn({ asIs: [s.token] });
    assert.equal(sc.text(`${VALUE} and ${OTHER}`), `${VALUE} and [REDACTED:ROUTER_PIN]`);
    assert.equal(sc.note(), "\n[1 secret redacted (ROUTER_PIN)]");
    assert.deepEqual(sc.sentAsIs(), ["PLUG_PASSWORD"]);
});

test("a token made for one value's content does not exempt a different value", async () => {
    const [s] = await spansOf(VALUE);
    const sc = await forTurn({ asIs: [s.token] });
    assert.equal(sc.text(OTHER), "[REDACTED:ROUTER_PIN]");
    assert.equal(sc.text(KEY), "[REDACTED:window-ml-api-key]");
    assert.equal((await forTurn({ asIs: ["0".repeat(32), "not a token"] })).text(VALUE), "[REDACTED:PLUG_PASSWORD]");
});

test("a token replayed with the text around it edited still exempts the unchanged value; an edited value is scrubbed", async () => {
    const [s] = await spansOf(`first draft ${VALUE}`);
    const sc = await forTurn({ asIs: [s.token] });
    assert.equal(sc.text(`a rewritten message, then ${VALUE}.`), `a rewritten message, then ${VALUE}.`);
    _setRegistryForTest([{ name: "PLUG_PASSWORD", value: VALUE }, { name: "PLUG_PASSWORD_2", value: `${VALUE}-x` }]);
    try {
        assert.equal((await forTurn({ asIs: [s.token] })).text(`${VALUE}-x`), "[REDACTED:PLUG_PASSWORD_2]", "a longer value is another value");
    } finally { _setRegistryForTest([{ name: "PLUG_PASSWORD", value: VALUE }, { name: "ROUTER_PIN", value: OTHER }]); }
});

test("a page's tokens are ignored: its turn is scrubbed by value", async () => {
    const [s] = await spansOf(VALUE);
    const sc = await forTurn({ site: true, asIs: [s.token] });
    assert.equal(sc.text(VALUE), "[REDACTED]");
    assert.deepEqual(sc.sentAsIs(), []);
});

test("LOST KEY: session storage cleared (a browser restart) while a draft holds tokens: the send exempts nothing and the scan answers new ones", async () => {
    const [s] = await spansOf(VALUE);
    session = {};
    _forgetExemptKeyForTest();
    const sc = await forTurn({ asIs: [s.token] });
    assert.equal(sc.text(VALUE), "[REDACTED:PLUG_PASSWORD]", "fails closed");
    assert.deepEqual(sc.sentAsIs(), []);
    const [again] = await spansOf(VALUE);
    assert.notEqual(again.token, s.token, "the chip shows again, with a token the new key matches");
    assert.equal((await forTurn({ asIs: [again.token] })).text(VALUE), VALUE);
});

test("a session store that cannot be read exempts nothing and still sends the turn scrubbed", async () => {
    const [s] = await spansOf(VALUE);
    const get = chrome.storage.session.get;
    chrome.storage.session.get = async () => { throw new Error("session storage is gone"); };
    _forgetExemptKeyForTest();
    try {
        const sc = await forTurn({ asIs: [s.token] });
        assert.equal(sc.text(VALUE), "[REDACTED:PLUG_PASSWORD]");
    } finally { chrome.storage.session.get = get; _forgetExemptKeyForTest(); }
});

// --- the display marks a value sent as is by name ---

test("the turn's display names what was sent as is, never a token, and is left alone when nothing was", async () => {
    const [s] = await spansOf(VALUE);
    const sc = await forTurn({ asIs: [s.token] });
    sc.text(`use ${VALUE}`);
    const shown = withAsIs({ typed: `use ${VALUE}`, context: [] }, sc);
    assert.deepEqual(shown, { typed: `use ${VALUE}`, context: [], asIs: ["PLUG_PASSWORD"] });
    assert.ok(!JSON.stringify(shown).includes(s.token));
    assert.deepEqual(withAsIs(undefined, sc, "typed"), { typed: "typed", context: [], asIs: ["PLUG_PASSWORD"] });
    const none = await forTurn();
    none.text(VALUE);
    const d = { typed: "x", context: [] };
    assert.equal(withAsIs(d, none), d);
});
