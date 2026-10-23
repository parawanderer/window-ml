// policies-handler-preload.test.mjs — the `POLICIES` message to a worker that has just woken, through the BUILT worker in
// node:vm (rebuild first, `npm run build:all`). A Settings page that listed policies in an earlier worker life names ids the
// new worker has not read yet: remove / edit must act on them and a list must not be partial (src/background.ts `POLICIES`,
// src/sw/sw-policies.ts `policiesReady`; docs/dev/policies.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadBackground } = require("./helpers");
const EXT_PAGE = { url: "chrome-extension://test/sidebar.html" };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const STORED = { id: "pol-stored", scope: "global", consumer: "fetch", effect: "deny", source: '(c) => c.host === "blocked.example"', label: "never blocked.example", origin: "person", created: 1760000000000 };

function woken() {
    let release; const holdPolicies = new Promise((r) => { release = r; });
    const bg = loadBackground({ config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai" }, local: { ml_policies_global: [STORED] }, holdPolicies });
    return { bg, release };
}

// --- a message that arrives before the first read ---

test("a remove of an id the new worker has not read yet removes it once the read finishes", async () => {
    const { bg, release } = woken();
    const reply = bg.send({ type: "POLICIES", payload: { op: "remove", id: STORED.id } }, EXT_PAGE);
    await flush();
    release();
    const r = plain(await reply);
    assert.equal(r.error, undefined, `answered ${r.error}`);
    assert.deepEqual(r.data.global, []);
    await flush();
    assert.deepEqual(bg.localStore.ml_policies_global, [], "and storage agrees");
});

test("a list before the read waits for it, so it is not partial; an add before the read keeps the stored policy", async () => {
    const { bg, release } = woken();
    const added = bg.send({ type: "POLICIES", payload: { op: "add", effect: "ask", source: "(c) => false", label: "later" } }, EXT_PAGE);
    await flush();
    release();
    const r = plain(await added);
    assert.deepEqual(r.data.global.map((p) => p.id).slice(0, 1), [STORED.id]);
    assert.equal(r.data.global.length, 2);
    await flush();
    assert.equal(bg.localStore.ml_policies_global.length, 2, "storage holds both");
});
