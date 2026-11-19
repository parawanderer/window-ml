// redteam-scrub-cold.test.mjs — the COLD worker, adversarially: before the registry's first read has landed, no crossing
// may read an empty registry as "no secrets" (SECRET_HANDLES.md, "The scrub as built"; the lane's own rows are
// tests/secret-scrub-crossings.test.mjs). Those show the two crossings that cannot wait and one failing read; these are
// the shapes a hostile or unlucky store gives it: a `chrome.storage.local.get` that never answers, one that fails while
// a second crossing is already waiting, and the first delta after the read lands. Every row asserts the VALUE never
// crosses — not the sentence it is replaced with, so a different fail-closed wording keeps the rows meaningful.
// Last pass, at the branch head that fixes the read/change race (f752e4fc) and records a failed read (5866b0b2): the
// last three rows pin a change that arrives while the read is in flight — one, two, and one that REMOVES an entry — and
// the housekeeping record's contents. The read no longer adopts over a change, so the rows measure both directions:
// an added secret still scrubbed after the read lands, a removed one not scrubbed again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNativeHost } from "./fake-native-host.mjs";

const T = { timeout: 20000 };
const VALUE = "COLD-SECRET-9f21-3c";
const NAME = "COLD_TOKEN";
const MARK = `[REDACTED:${NAME}]`;
/** A second registered value, for the rows where two lists follow one another. */
const OTHER = "OTHER-SECRET-71b0-55";
const OTHER_LIST = [{ name: "OTHER_TOKEN", value: OTHER }];
const MARK_OTHER = "[REDACTED:OTHER_TOKEN]";
/** The front a leaked half-value would show: redacting the whole value but its tail is still a leak. */
const FRONT = VALUE.slice(0, 8);
const leaks = (s) => typeof s === "string" && (s.includes(VALUE) || s.includes(FRONT));
/** How a promise stands after a while: "settled", "rejected", or still waiting. */
const standing = async (p) => Promise.race([Promise.resolve(p).then(() => "settled", () => "rejected"), new Promise((r) => setTimeout(() => r("pending"), 250))]);

// The worker's chrome: storage with a `local.get` each row replaces, a config whose secrets are the backend's own, and
// a native port for the ml.sh row. `onChanged` keeps its listeners so a row can deliver a change to the worker.
const sync = { shellEnabled: true, shellRoots: ["/w/cold"], shellSandbox: true, shellPath: [], chatUrl: "http://host/api/chat/completions", apiKey: "sk-test-config-key" };
const localBase = async (d) => ({ ...(d ?? {}) });
const changed = [];
let native = null;
globalThis.chrome = {
    runtime: {
        id: "ext-id", lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => p,
        connectNative: (name) => {
            const onMsg = [];
            let closed = false;
            const end = { send: (m) => { if (!closed) setTimeout(() => { for (const f of onMsg) f(JSON.parse(JSON.stringify(m))); }, 0); }, close: () => { closed = true; } };
            const receive = native ? native(name, end) : null;
            return { name, postMessage: (m) => receive?.(JSON.parse(JSON.stringify(m))), disconnect: () => { closed = true; },
                onMessage: { addListener: (f) => onMsg.push(f) }, onDisconnect: { addListener() {} } };
        },
    },
    storage: {
        local: { get: (d) => localBase(d), set: async () => {}, remove: async () => {} },
        sync: { get: async (d) => ({ ...(d ?? {}), ...sync }), set: async () => {} },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: { addListener: (f) => changed.push(f) },
    },
};
const { _setRegistryForTest, _coldRegistryForTest, registryReady, registryIsReady } = await import("../src/sw/sw-secret-registry.ts");
const { forModel, forModelHistory, forBackendFromPage, forLive, forPerson } = await import("../src/sw/sw-scrub.ts");
const { shRun } = await import("../src/sw/sw-shell-call.ts");
const { TokenStore } = await import("../src/pointers/token-pipe.ts");

const ENTRIES = [{ name: NAME, value: VALUE }];
_setRegistryForTest(ENTRIES);

/** Run `f` with the registry cold and `chrome.storage.local.get` answering by `answer`, then put both back. */
async function coldWith(answer, f) {
    const real = chrome.storage.local.get;
    chrome.storage.local.get = answer;
    _coldRegistryForTest();
    try { await f(); } finally { chrome.storage.local.get = real; _setRegistryForTest(ENTRIES); }
}
const ctxFor = (runId) => ({ runId, seq: 3, local: { step: 1, seq: 3 }, signal: new AbortController().signal, tokens: new TokenStore() });

// --- the store never answers: every crossing waits, and the two that cannot wait hold their text back ---

test("RED TEAM: a store that never answers holds every crossing, and nothing resolves carrying the value", T, async () => {
    await coldWith(() => new Promise(() => {}), async () => {
        const text = `log: ${VALUE} and its front ${FRONT}`;
        assert.equal(forLive(text), "", "a live delta before the read showed text");
        const held = forPerson(text);
        assert.ok(!leaks(held), held);
        assert.match(held, /not read yet/, `the person's view is not the held-back sentence: ${held}`);
        // The crossings that CAN wait: none may answer while the registry was never read, or it would answer unscrubbed.
        assert.equal(await standing(forModel(text)), "pending", "forModel answered before the registry was read");
        assert.equal(await standing(forBackendFromPage({ messages: [{ role: "user", content: text }] })), "pending", "a page-started request crossed before the registry was read");
        const history = [{ role: "tool", content: text }];
        assert.equal(await standing(forModelHistory(history)), "pending", "a resumed history crossed before the registry was read");
        assert.equal(history[0].content, text, "the history was rewritten by a crossing that had not answered");
    });
});

test("RED TEAM: ml.sh's head waits on the same read, so no program output crosses a worker that has none", T, async () => {
    const out = `DSN=postgres://app:${VALUE}@db/x\n`;
    const host = fakeNativeHost({ done: () => ({ out, err: "", code: 0 }) });
    native = host.onNative;
    sync.shellRoots = ["/w/cold1"];
    await coldWith(() => new Promise(() => {}), async () => {
        assert.equal(await standing(shRun(ctxFor("cold-head"), [["ls"], { expectMs: 5000 }])), "pending", "an ml.sh call answered before the registry was read");
        assert.equal(registryIsReady(), false, "the registry reports itself read");
    });
});

// --- the store fails: closed, and a later successful read takes over ---

test("RED TEAM: a read that fails leaves the waiting crossings closed, and the next successful read scrubs again", T, async () => {
    let fail = true;
    await coldWith(async () => {
        if (fail) throw new Error("the store is gone");
        return { ml_secret_registry: ENTRIES };
    }, async () => {
        const text = `token ${VALUE}`;
        // The two that cannot wait stay closed, and the model's own crossing answers the fail-closed sentence.
        assert.equal(forLive(text), "");
        assert.ok(!leaks(forPerson(text)), forPerson(text));
        const r = await forModel(text);
        assert.ok(!leaks(r.text) && r.changed, r.text);
        // A page-started request is REFUSED rather than sent: the crossing rejects, so nothing of it reaches a backend.
        assert.equal(await standing(forBackendFromPage({ messages: [{ role: "user", content: text }] })), "rejected", "a page-started request was not refused when the registry could not be read");
        // The failure is not sticky: the next read succeeds, and every crossing scrubs from then on.
        fail = false;
        assert.equal((await forModel(text)).text, `token ${MARK}`);
        assert.equal(forLive(text), `token ${MARK}`);
        assert.equal(forPerson(text), `token ${MARK}`);
    });
});

// --- the read lands: the first delta after it carries the whole output, scrubbed, and a front still waits ---

test("RED TEAM: the first delta after the read is scrubbed whole, and a tail that begins a value is still held back", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    await coldWith(async () => { await gate; return { ml_secret_registry: ENTRIES }; }, async () => {
        const whole = `a a a a a ${VALUE} z`;
        assert.equal(forLive(whole), "", "a delta showed before the read");
        assert.ok(!registryIsReady(), "the registry reports itself read before the read landed");
        release();
        await registryReady();
        assert.equal(forLive(whole), `a a a a a ${MARK} z`, "the delta after the read is not the whole output, scrubbed");
        // Ready is not the same as finished: a delta whose tail begins the value shows nothing of that tail.
        const cut = forLive(`x ${FRONT}`);
        assert.ok(!leaks(cut), cut);
        assert.equal(cut, "x ", `a delta ending in a value's front showed part of it: ${JSON.stringify(cut)}`);
        assert.equal(forPerson(`x ${VALUE}`), `x ${MARK}`);
    });
});

// --- a change that lands BEFORE the read does: the crossings scrub with it at once ---

// MEASURED at 087e543b and fixed by f752e4fc: the read the worker started at import answered with what it read BEFORE
// the change and `adopt()`ed it, so once it landed `forLive` and `forPerson` showed the value again. The read now adopts
// only when no change arrived while it was in flight, and the three rows below measure that from both sides.
test("RED TEAM: a change that lands while the first read is in flight is what the crossings scrub with at once", T, async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    await coldWith(async () => { await gate; return { ml_secret_registry: [] }; }, async () => {
        const first = registryReady();
        assert.ok(!registryIsReady(), "the registry is ready before its read landed");
        assert.equal(forLive(`k ${VALUE}`), "", "a delta showed before the read landed");
        // A change delivered the way `chrome.storage.local` delivers one (an extension context writing the key).
        for (const f of changed) f({ ml_secret_registry: { oldValue: [], newValue: ENTRIES } }, "local");
        assert.equal(registryIsReady(), true, "a change did not make the registry ready");
        assert.equal(forLive(`k ${VALUE}`), `k ${MARK}`, "the changed registry is not the one scrubbing");
        assert.equal(forPerson(`k ${VALUE}`), `k ${MARK}`);
        // The read's own list is older than the change: landing after it must not put the value back on show.
        release();
        await first;
        assert.equal(forLive(`k ${VALUE}`), `k ${MARK}`, "the read's older list overwrote the change");
        assert.equal((await forModel(`k ${VALUE}`)).text, `k ${MARK}`);
    });
});

// --- two changes during the read, and a change that REMOVES an entry: the last change is the state ---

test("RED TEAM: two changes while the read is in flight: the SECOND is the state, not the read's list and not the first", T, async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    await coldWith(async () => { await gate; return { ml_secret_registry: [] }; }, async () => {
        const first = registryReady();
        // The first change registers NAME; the second replaces the list with OTHER alone, which also REMOVES NAME.
        for (const f of changed) f({ ml_secret_registry: { oldValue: [], newValue: ENTRIES } }, "local");
        assert.equal(forLive(`a ${VALUE}`), `a ${MARK}`, "the first change did not scrub at once");
        for (const f of changed) f({ ml_secret_registry: { oldValue: ENTRIES, newValue: OTHER_LIST } }, "local");
        release();
        await first;
        assert.equal(forLive(`a ${VALUE} b ${OTHER}`), `a ${VALUE} b ${MARK_OTHER}`, "the last change is not the state the crossings scrub with");
        assert.equal((await forModel(`a ${VALUE} b ${OTHER}`)).text, `a ${VALUE} b ${MARK_OTHER}`, "the model's crossing read the first change or the read's list");
        assert.equal(forPerson(`x ${OTHER}`), `x ${MARK_OTHER}`);
    });
});

test("RED TEAM: an entry REMOVED while the read is in flight is not resurrected by the read's older list", T, async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    // The store still holds the entry when the read reaches it; the person removes it before the answer is taken in.
    await coldWith(async () => { await gate; return { ml_secret_registry: ENTRIES }; }, async () => {
        const first = registryReady();
        for (const f of changed) f({ ml_secret_registry: { oldValue: ENTRIES, newValue: [] } }, "local");
        assert.equal(registryIsReady(), true, "a change did not make the registry ready");
        assert.equal(forLive(`k ${VALUE}`), `k ${VALUE}`, "a delta was scrubbed against a registry the person had emptied");
        release();
        await first;
        assert.equal(forLive(`k ${VALUE}`), `k ${VALUE}`, "the read's older list resurrected a secret the person had removed");
        assert.equal((await forModel(`k ${VALUE}`)).text, `k ${VALUE}`, "the model's crossing still treats the removed value as secret");
        assert.equal(forPerson(`k ${VALUE}`), `k ${VALUE}`, "the person's crossing still treats the removed value as secret");
    });
});

// --- the failed read's housekeeping record: the event and nothing of the store ---

test("RED TEAM: a failed read records the event alone, whatever its error carries, and a read that succeeds records nothing", T, async () => {
    const { housekeeping } = await import("../src/sw/sw-housekeeping.ts");
    const real = housekeeping.record;
    const seen = [];
    housekeeping.record = (r) => seen.push(r);
    try {
        // The store rejects with the value in its message: an implementation that logged the error would leak it here.
        await coldWith(async () => { throw new Error(`cannot read ml_secret_registry: ${VALUE}`); }, async () => {
            await assert.rejects(registryReady());
            assert.deepEqual(seen, [{ level: "warn", subsystem: "secrets", kind: "registry-unreadable" }], `the record is not the bare event: ${JSON.stringify(seen)}`);
            assert.ok(!leaks(JSON.stringify(seen)), `the record carried the value: ${JSON.stringify(seen)}`);
            // And the crossings a failed read reaches say nothing of the store's message either.
            assert.ok(!leaks(forPerson(`x ${VALUE}`)), forPerson(`x ${VALUE}`));
            assert.equal(forLive(`x ${VALUE}`), "");
        });
        seen.length = 0;
        await coldWith(async () => ({ ml_secret_registry: ENTRIES }), async () => {
            await registryReady();
            assert.deepEqual(seen, [], `a read that succeeded recorded an event: ${JSON.stringify(seen)}`);
            assert.equal(forLive(`x ${VALUE}`), `x ${MARK}`, "the read that succeeded is not the one scrubbing");
        });
    } finally { housekeeping.record = real; }
});
