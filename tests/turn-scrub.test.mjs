// turn-scrub.test.mjs — what a person or a page SENDS is scrubbed by registered value where it becomes a turn (ruling
// 39, SECRET_HANDLES.md, "What the person sends is scrubbed too"): `forTurn` in sw-scrub.ts, against a registry set in
// memory. The wiring into each entry point (a run's start, a steer, the chat page's chat) is tests/turn-scrub-paths.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";

const VALUE = "REALSECRET-4b1d-77";
const NAME = "PLUG_PASSWORD";
const MARK = `[REDACTED:${NAME}]`;
const KEY = "sk-test-config-key-0123";   // the extension's own saved API key, 23 characters
const OWN = "[REDACTED:window-ml-api-key]";

const sync = { apiKey: KEY };
const changed = [];
let syncFails = false;
let localGet = async (d) => ({ ...(d ?? {}) });
globalThis.chrome = {
    runtime: { id: "ext-id", lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => p },
    storage: {
        local: { get: (d) => localGet(d), set: async () => {}, remove: async () => {} },
        sync: { get: async (d) => { if (syncFails) throw new Error("sync is gone"); return { ...(d ?? {}), ...sync }; }, set: async () => {} },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: { addListener(f) { changed.push(f); } },
    },
};
const { _setRegistryForTest, _coldRegistryForTest } = await import("../src/sw/sw-secret-registry.ts");
const { forTurn, forModelHistory, OWN_KEY_NAME } = await import("../src/sw/sw-scrub.ts");
const { TurnUnreadable } = await import("../src/secret-registry.ts");
const { DEFAULT_CONFIG } = await import("../src/contract/contract-config.ts");

_setRegistryForTest([{ name: NAME, value: VALUE }]);

/** With the setting set to `v` (undefined: a stored config from before the key), run `f`. */
async function withSetting(v, f) {
    const had = Object.prototype.hasOwnProperty.call(sync, "scrubPersonInput");
    const old = sync.scrubPersonInput;
    if (v === undefined) delete sync.scrubPersonInput; else sync.scrubPersonInput = v;
    try { await f(); } finally { if (had) sync.scrubPersonInput = old; else delete sync.scrubPersonInput; }
}

// --- a person's turn: names, and the note the model reads ---

test("a person's turn has each registered value replaced by its marker, and the note names and counts it", async () => {
    const s = await forTurn();
    assert.equal(s.text(`my password is ${VALUE}, again ${encodeURIComponent(VALUE)}`), `my password is ${MARK}, again ${MARK}`);
    assert.equal(s.note(), `\n[2 secrets redacted (${NAME})]`);
    // One scrub counts every text of the turn: a file's text after the words.
    assert.equal(s.text(`file: ${VALUE}`), `file: ${MARK}`);
    assert.equal(s.note(), `\n[3 secrets redacted (${NAME})]`);
    const clean = await forTurn();
    assert.equal(clean.text("nothing here"), "nothing here");
    assert.equal(clean.note(), "", "a turn with nothing taken out has no note");
});

test("the extension's own saved key is redacted with no registration, as window-ml-api-key, from 12 characters", async () => {
    assert.equal(OWN_KEY_NAME, "window-ml-api-key");
    _setRegistryForTest([]);
    try {
        const s = await forTurn();
        assert.equal(s.text(`use ${KEY} here`), `use ${OWN} here`);
        assert.equal(s.note(), "\n[1 secret redacted (window-ml-api-key)]");
        // The URL and the model filter are not credentials: a person names them in ordinary questions.
        sync.chatUrl = "http://10.0.0.9:3000/api/chat/completions";
        assert.equal((await forTurn()).text("is http://10.0.0.9:3000 up?"), "is http://10.0.0.9:3000 up?");
        delete sync.chatUrl;
        // An 11-character key is not matched: it would match ordinary text.
        sync.apiKey = "sk-short-11";
        assert.equal((await forTurn()).text("sk-short-11 is a word here"), "sk-short-11 is a word here");
    } finally { sync.apiKey = KEY; _setRegistryForTest([{ name: NAME, value: VALUE }]); }
});

test("a key replaced since the worker started is still redacted in a person's turn", async () => {
    const OLD = "sk-replaced-key-77665544";
    for (const f of changed) f({ apiKey: { oldValue: OLD, newValue: KEY } }, "sync");
    const s = await forTurn();
    assert.equal(s.text(`old ${OLD} new ${KEY}`), `old ${OWN} new ${OWN}`);
});

// --- a page's turn: bare, no note, and nothing turns it off ---

test("a page's turn gets the bare [REDACTED] for a registered value and for the saved key, and no note", async () => {
    const s = await forTurn({ site: true });
    const out = s.text(`${VALUE} and ${KEY}`);
    assert.equal(out, "[REDACTED] and [REDACTED]");
    assert.ok(!out.includes(NAME) && !out.includes(OWN_KEY_NAME), out);
    assert.equal(s.note(), "", "a page is never told a name");
});

test("a page's scrubInput: false and the setting turned off leave a page's turn scrubbed by value", async () => {
    await withSetting(false, async () => {
        assert.equal((await forTurn({ site: true, off: true })).text(VALUE), "[REDACTED]");
    });
});

// --- the person's levels: the setting, and the call's scrubInput: false ---

test("scrubPersonInput off, or the person's call asking for its turn as it is, sends a person's turn unchanged", async () => {
    assert.equal(DEFAULT_CONFIG.scrubPersonInput, true, "on by default");
    await withSetting(false, async () => {
        const s = await forTurn();
        assert.equal(s.text(VALUE), VALUE);
        assert.equal(s.note(), "");
    });
    const off = await forTurn({ off: true });
    assert.equal(off.text(`${VALUE} ${KEY}`), `${VALUE} ${KEY}`);
});

test("UPGRADE: a stored config from before scrubPersonInput reads as on", async () => {
    await withSetting(undefined, async () => {
        assert.equal((await forTurn()).text(VALUE), MARK);
    });
});

// --- a store that cannot be read holds the turn (ruling 44) ---

test("a registry that cannot be read refuses the turn, naming scrubInput: false to a person and not to a page", async () => {
    localGet = async () => { throw new Error(`cannot read ml_secret_registry: ${VALUE}`); };
    _coldRegistryForTest();
    try {
        const person = await forTurn().then(() => null, (e) => e);
        assert.ok(person instanceof TurnUnreadable, String(person));
        assert.match(person.message, /secret store could not be read/);
        assert.match(person.message, /scrubInput: false/);
        assert.ok(!person.message.includes(VALUE), person.message);
        const page = await forTurn({ site: true }).then(() => null, (e) => e);
        assert.ok(page instanceof TurnUnreadable, String(page));
        assert.doesNotMatch(page.message, /scrubInput/);
        // The person's own off switch does not need the store.
        assert.equal((await forTurn({ off: true })).text(VALUE), VALUE);
    } finally { localGet = async (d) => ({ ...(d ?? {}) }); _setRegistryForTest([{ name: NAME, value: VALUE }]); }
});

test("a config that cannot be read refuses the turn too", async () => {
    syncFails = true;
    try {
        assert.ok(await forTurn().then(() => false, (e) => e instanceof TurnUnreadable));
        assert.ok(await forTurn({ site: true }).then(() => false, (e) => e instanceof TurnUnreadable));
    } finally { syncFails = false; }
});

// --- deep: a turn's display and page context ---

test("deep scrubs every string of a display, leaves image data alone and keeps the shape", async () => {
    const s = await forTurn();
    const display = { typed: `see ${VALUE}`, context: [{ kind: "element", element: { text: `selected ${VALUE}`, tag: "p" } }], src: `data:${VALUE}` };
    assert.deepEqual(s.deep(display), { typed: `see ${MARK}`, context: [{ kind: "element", element: { text: `selected ${MARK}`, tag: "p" } }], src: `data:${VALUE}` });
});

// --- a history stored before the input scrub ---

test("UPGRADE: a resumed history's user turns go through the turn scrub only when it is given, and tool turns as before", async () => {
    const stored = () => [
        { role: "system", content: `system ${VALUE}` },
        { role: "user", content: `old task ${VALUE}` },
        { role: "assistant", content: "ok" },
        { role: "tool", content: `out ${VALUE}` },
    ];
    const kept = stored();
    await forModelHistory(kept);
    assert.equal(kept[1].content, `old task ${VALUE}`, "without the turn scrub, a user turn is left (a run that scrubbed its input already)");
    assert.equal(kept[3].content, `out ${MARK}`);
    const old = stored();
    const n = await forModelHistory(old, await forTurn());
    assert.equal(n, 2);
    assert.equal(old[1].content, `old task ${MARK}`);
    assert.equal(old[0].content, `system ${VALUE}`, "the system prompt is the worker's, not the person's");
    const page = stored();
    await forModelHistory(page, await forTurn({ site: true }));
    assert.equal(page[1].content, "old task [REDACTED]");
});
