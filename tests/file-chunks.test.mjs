// file-chunks.test.mjs — a file sent over the hub in `file.put` chunks (docs/spec/FILE_ATTACHMENTS.md, "Over the hub:
// chunks in an acknowledged window"): the frame that carries a chunk raw after its JSON (src/hub/file-frame.ts), and
// the runtime's store that puts the chunks back together and checks them against their hash
// (src/hub/runtime/file-chunks.ts). The path end to end, through a real hub, is tests/hub-file-put.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkSize, fileCap, frameChunk, sha256Hex, unframe, FILE_BURST_SHARE } from "../src/hub/file-frame.ts";
import { FileChunks } from "../src/hub/runtime/file-chunks.ts";

const enc = new TextEncoder();
const bytesOf = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
const LIMITS = { maxFileBytes: 1000, maxTotalBytes: 2500, ttlMs: 60_000 };
/** A store on a clock the test moves, and a file cut into `count` chunks. */
function world(limits = LIMITS) {
    let t = 0;
    const store = new FileChunks(limits, () => t);
    return { store, tick: (ms) => { t += ms; } };
}
async function fileOf(n, count, seed = 1) {
    const data = bytesOf(n, seed);
    const size = Math.ceil(n / count);
    const chunks = Array.from({ length: count }, (_, i) => data.subarray(i * size, (i + 1) * size));
    return { data, chunks, sha256: await sha256Hex(data), put: (i) => ({ sha256: null, index: i, count, bytes: n }) };
}

// --- the frame: JSON, a zero byte, the raw chunk ---

test("a chunk rides raw after its JSON and comes back exactly; a body with no zero byte is all JSON", () => {
    const json = enc.encode(JSON.stringify({ type: "file.put", sha256: "ab", index: 0, count: 1, bytes: 3 }));
    const chunk = Uint8Array.of(0, 255, 0);
    const { json: j, chunk: c } = unframe(frameChunk(json, chunk));
    assert.deepEqual([...j], [...json]);
    assert.deepEqual([...c], [...chunk], "zero bytes inside the chunk survive: only the first zero splits");
    assert.deepEqual(unframe(json), { json, chunk: null });
});

test("no JSON a command can be written as contains a zero byte, so the split is never inside it", () => {
    for (const v of ["\u0000", "a\u0000b", { k: "\u0000" }, ["\u0000\u0001"], "é漢😀"]) {
        assert.ok(!enc.encode(JSON.stringify(v)).includes(0), JSON.stringify(v));
    }
});

test("a chunk is the hub's limit less the seal, the header, the separator and the margin; a file's cap is the runtime's or the burst share", () => {
    assert.equal(chunkSize(1_000_000, 900, 200, 512), 1_000_000 - 900 - 200 - 1 - 512);
    assert.equal(chunkSize(1000, 900, 200, 512), 0);
    assert.equal(fileCap(20, 0), 20, "no allowance announced: the runtime's cap");
    assert.equal(fileCap(20 * 1048576, 32 * 1048576), Math.floor(32 * 1048576 * FILE_BURST_SHARE), "the default 32 MiB burst: 19.2 MiB, under the runtime's 20");
    assert.equal(fileCap(20 * 1048576, 64 * 1048576), 20 * 1048576);
    assert.equal(fileCap(20 * 1048576, 16 * 1048576), Math.floor(16 * 1048576 * FILE_BURST_SHARE));
});

// --- the store: chunks back into a checked file ---

test("chunks in any order make the file once the last is in, checked against its hash, and the file is kept for reuse", async () => {
    const { store } = world();
    const f = await fileOf(900, 3);
    const put = (i) => store.put("phone", { ...f.put(i), sha256: f.sha256 }, f.chunks[i]);
    assert.deepEqual(await put(2), { ok: true, held: 1, complete: false });
    assert.deepEqual(store.have("phone", f.sha256), { held: [2], count: 3, complete: false });
    assert.deepEqual(await put(0), { ok: true, held: 2, complete: false });
    assert.deepEqual(await put(1), { ok: true, held: 3, complete: true });
    assert.deepEqual([...store.get(f.sha256)], [...f.data]);
    assert.deepEqual([...store.get(f.sha256)], [...f.data], "a second read finds it too: the same file attached again is not sent again");
    assert.deepEqual(store.have("tablet", f.sha256), { held: [], count: 0, complete: true }, "a checked file is anyone's by its hash");
    assert.deepEqual(await put(0), { ok: true, held: 3, complete: true }, "a late duplicate of a done file is answered done");
});

test("chunks that do not hash to the name they were sent under are refused, and nothing is kept", async () => {
    const { store } = world();
    const f = await fileOf(600, 2);
    const lie = "0".repeat(64);
    await store.put("phone", { ...f.put(0), sha256: lie }, f.chunks[0]);
    const r = await store.put("phone", { ...f.put(1), sha256: lie }, f.chunks[1]);
    assert.equal(r.ok, false);
    assert.match(r.message, /do not hash to/);
    assert.equal(store.get(lie), null);
    assert.equal(store.heldBytes(), 0);
});

test("an upload in progress is its sender's: another device's chunks under the same hash start their own", async () => {
    const { store } = world();
    const f = await fileOf(600, 2);
    await store.put("phone", { ...f.put(0), sha256: f.sha256 }, f.chunks[0]);
    // A tablet sends rubbish for index 1 of the same hash: its own upload fails the check, the phone's is untouched.
    await store.put("tablet", { ...f.put(0), sha256: f.sha256 }, bytesOf(300, 9));
    const bad = await store.put("tablet", { ...f.put(1), sha256: f.sha256 }, bytesOf(300, 9));
    assert.equal(bad.ok, false);
    assert.deepEqual(await store.put("phone", { ...f.put(1), sha256: f.sha256 }, f.chunks[1]), { ok: true, held: 2, complete: true });
});

test("the same file sent in another shape (a different chunk count) starts over; a chunk sent twice counts once", async () => {
    const { store } = world();
    const f = await fileOf(600, 3), g = await fileOf(600, 2);
    await store.put("phone", { ...f.put(0), sha256: f.sha256 }, f.chunks[0]);
    await store.put("phone", { ...f.put(0), sha256: f.sha256 }, f.chunks[0]);
    assert.deepEqual(store.have("phone", f.sha256).held, [0]);
    assert.deepEqual(await store.put("phone", { ...g.put(0), sha256: g.sha256 }, g.chunks[0]), { ok: true, held: 1, complete: false });
    assert.deepEqual(store.have("phone", g.sha256), { held: [0], count: 2, complete: false });
    assert.deepEqual(await store.put("phone", { ...g.put(1), sha256: g.sha256 }, g.chunks[1]), { ok: true, held: 2, complete: true });
});

test("ADVERSARIAL: a put that cannot be a chunk of a real file is refused before anything is kept", async () => {
    const { store } = world();
    const sha256 = "a".repeat(64);
    const one = Uint8Array.of(1);
    for (const [c, chunk, why] of [
        [{ sha256: "A".repeat(64), index: 0, count: 1, bytes: 1 }, one, "uppercase hash"],
        [{ sha256: "a".repeat(63), index: 0, count: 1, bytes: 1 }, one, "short hash"],
        [{ sha256: { length: 64 }, index: 0, count: 1, bytes: 1 }, one, "hash not a string"],
        [{ sha256, index: 1, count: 1, bytes: 1 }, one, "index past count"],
        [{ sha256, index: -1, count: 1, bytes: 1 }, one, "negative index"],
        [{ sha256, index: 0.5, count: 2, bytes: 2 }, one, "fractional index"],
        [{ sha256, index: 0, count: 0, bytes: 1 }, one, "zero count"],
        [{ sha256, index: 0, count: 5, bytes: 2 }, one, "more chunks than bytes"],
        [{ sha256, index: 0, count: 1, bytes: 1001 }, one, "past the file cap"],
        [{ sha256, index: 0, count: 1, bytes: 0 }, one, "empty file"],
        [{ sha256, index: 0, count: 1, bytes: "1" }, one, "bytes not a number"],
        [{ sha256, index: 0, count: 1, bytes: 1 }, new Uint8Array(), "empty chunk"],
    ]) {
        const r = await store.put("phone", c, chunk);
        assert.equal(r.ok, false, why);
        assert.equal(r.code, "invalid", why);
    }
    assert.equal(store.heldBytes(), 0);
});

test("ADVERSARIAL: a chunk sent again with other bytes replaces the first, and the file is refused by its hash, never kept wrong", async () => {
    const { store } = world();
    const f = await fileOf(600, 2);
    await store.put("phone", { ...f.put(0), sha256: f.sha256 }, f.chunks[0]);
    await store.put("phone", { ...f.put(0), sha256: f.sha256 }, bytesOf(300, 9));
    const r = await store.put("phone", { ...f.put(1), sha256: f.sha256 }, f.chunks[1]);
    assert.deepEqual([r.ok, r.code], [false, "invalid"]);
    assert.match(r.message, /do not hash to/);
    assert.equal(store.get(f.sha256), null);
    assert.equal(store.heldBytes(), 0);
});

test("ADVERSARIAL: chunks adding up past the bytes they claim are refused, and the upload dropped", async () => {
    const { store } = world();
    const sha256 = "b".repeat(64);
    await store.put("phone", { sha256, index: 0, count: 2, bytes: 10 }, bytesOf(8));
    const r = await store.put("phone", { sha256, index: 1, count: 2, bytes: 10 }, bytesOf(8));
    assert.equal(r.ok, false);
    assert.match(r.message, /more than its 10 bytes/);
    assert.deepEqual(store.have("phone", sha256), { held: [], count: 0, complete: false });
});

test("ADVERSARIAL: the store never holds more than its total: the oldest go first, and an upload that cannot fit is refused", async () => {
    const { store, tick } = world({ maxFileBytes: 1000, maxTotalBytes: 1500, ttlMs: 60_000 });
    const a = await fileOf(1000, 1, 1), b = await fileOf(1000, 1, 2);
    await store.put("phone", { ...a.put(0), sha256: a.sha256 }, a.chunks[0]);
    tick(1);
    await store.put("phone", { ...b.put(0), sha256: b.sha256 }, b.chunks[0]);
    assert.equal(store.get(a.sha256), null, "the older file made room");
    assert.ok(store.get(b.sha256));
    assert.ok(store.heldBytes() <= 1500);
    const tiny = world({ maxFileBytes: 1000, maxTotalBytes: 500, ttlMs: 60_000 });
    const r = await tiny.store.put("phone", { sha256: "c".repeat(64), index: 0, count: 2, bytes: 1000 }, bytesOf(600));
    assert.deepEqual([r.ok, r.code], [false, "unavailable"]);
    assert.equal(tiny.store.heldBytes(), 0);
});

test("a file not touched within the TTL is gone, in progress or done; a read keeps it", async () => {
    const { store, tick } = world();
    const f = await fileOf(300, 1), g = await fileOf(300, 2, 5);
    await store.put("phone", { ...f.put(0), sha256: f.sha256 }, f.chunks[0]);
    await store.put("phone", { ...g.put(0), sha256: g.sha256 }, g.chunks[0]);
    tick(40_000);
    assert.ok(store.get(f.sha256), "read: kept another TTL");
    tick(40_000);
    assert.ok(store.get(f.sha256));
    assert.deepEqual(store.have("phone", g.sha256).held, [], "the upload nobody finished is gone");
    tick(60_001);
    assert.equal(store.get(f.sha256), null);
});
