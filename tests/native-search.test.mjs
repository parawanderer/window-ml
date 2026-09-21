// native-search.test.mjs — the phone app's search over the bridge (src/native/search-bridge.ts) against the demo world:
// what the page already holds answered first, then each runtime's pages, an archived session found by words inside it,
// and a runtime this device may only watch never asked. The app is not involved: this is what it would be sent.
import { test } from "node:test";
import assert from "node:assert/strict";

const { searchBridge } = await import("../src/native/search-bridge.ts");
const { ChatStore } = await import("../src/chat/chat-store.ts");
const { demoHost } = await import("../src/chat/demo-world.ts");

/** A bridge over the demo world, collecting what it posts; `ask` sends one search and waits for its pages. */
async function rig() {
    const host = demoHost(Date.now());
    const store = new ChatStore(host);
    store.start();
    await new Promise((r) => setTimeout(r, 30));   // the index arrives
    const out = [];
    const bridge = searchBridge(store, (m) => out.push(m));
    let n = 0;
    const ask = async (query, more = false) => {
        const id = more ? `s${n}` : `s${++n}`;
        const before = out.length;
        await bridge.handle({ type: "search", id, query, ...(more ? { more: true } : {}) });
        return out.slice(before);
    };
    return { host, store, out, ask, bridge };
}

/** Every row in a set of answers, by key. */
const keysOf = (pages) => pages.flatMap((p) => p.rows.map((r) => `${r.id.runtime}:${r.id.hash}`));

test("an empty search answers with what the page holds, then pages the runtimes' history", async () => {
    const { ask } = await rig();
    const first = await ask("");
    assert.ok(first.length >= 1, "an answer before any runtime replies");
    assert.ok(first[0].rows.length > 0, "the page's own index, newest first");
    assert.deepEqual(first[0].rows.map((r) => r.lastTs), [...first[0].rows.map((r) => r.lastTs)].sort((a, b) => b - a));
    assert.equal(first.at(-1).more, true, "the laptop has older sessions to page into");
    // Asking for more brings rows nothing has sent yet, never a repeat.
    const seen = new Set(keysOf(first));
    const next = await ask("", true);
    const fresh = keysOf(next);
    assert.ok(fresh.length > 0, "a second page arrives");
    assert.equal(fresh.some((k) => seen.has(k)), false, "no row is sent twice");
});

test("typing finds an archived session by words inside it, and says it is archived", async () => {
    const { ask } = await rig();
    // A phrase that appears only INSIDE an old answer, never in a title: the runtime reads the session's words.
    const pages = await ask("over-proofing");
    const rows = pages.flatMap((p) => p.rows);
    assert.ok(rows.length > 0, "the demo world has one");
    const archived = rows.find((r) => r.archived);
    assert.ok(archived, "an archived row is marked as one");
    assert.ok(archived.match?.snippet.includes("«"), "the runtime marks where it matched");
});

test("a search that matches nothing answers, and says there is no more", async () => {
    const { ask } = await rig();
    const pages = await ask("nothing here matches this at all");
    assert.deepEqual(pages.flatMap((p) => p.rows), []);
    assert.equal(pages.at(-1).more, false);
});

test("an offline runtime is never asked; a runtime this device only watches is, because searching is reading", async () => {
    const { store, ask } = await rig();
    const asked = [];
    const send = store.send.bind(store);
    store.send = (cmd, ...rest) => { asked.push(`${cmd.type}:${cmd.runtime ?? ""}`); return send(cmd, ...rest); };
    await ask("fare");
    // The old Mac is offline: asking it would hang the search on a runtime that cannot answer.
    assert.equal(asked.some((a) => a.endsWith(":old-mac")), false, `asked: ${asked.join(", ")}`);
    assert.ok(asked.some((a) => a.startsWith("sessions.search:laptop")), "the laptop is asked");
    assert.ok(asked.some((a) => a.startsWith("sessions.search:lab-box")), "so is the box this device may only watch");
});

test("the rows a search answered are remembered, so an archived one can be brought back when it is opened", async () => {
    const { ask, bridge } = await rig();
    const pages = await ask("over-proofing");
    const row = pages.flatMap((p) => p.rows).find((r) => r.archived);
    const key = `${row.id.runtime}:${row.id.hash}`;
    assert.equal(bridge.memory.row(key)?.archived, true);
    // A new search forgets the last one's rows rather than growing a map nobody reads.
    await ask("something else entirely");
    assert.equal(bridge.memory.row(key), undefined);
});
