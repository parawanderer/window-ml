// image-compaction.test.mjs — saved screenshots re-encoded as lossless WebP after they are written: which images the
// walk finds and how the events are rewritten (image-compact.ts), that libwebp with our settings gives back every pixel,
// the store's rewrite under its write lock (SessionStore.compactImages), and the background pass that drives it
// (sw-image-compact.ts). The worker, its wasm and the offscreen relay in a real browser: tests/e2e/image-compact.spec.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { collectPngs, replaceImages, isOpaque, samePixels, WEBP_LOSSLESS } from "../src/session/image-compact.ts";
import { SessionStore } from "../src/session/session-store.ts";
import { imageCompactor } from "../src/sw/sw-image-compact.ts";

const T = { timeout: 10000 };
const png = (n) => `data:image/png;base64,iVBORw0KGgo${"A".repeat(400 + n)}${n}`;
const webpOf = (url) => `data:image/webp;base64,UklGR${url.slice(-4)}`;
const SVG = "data:image/svg+xml;utf8,<svg/>";
const JPEG = "data:image/jpeg;base64,/9j/AAAA";

// --- the walk: which images, and the rewrite ---

test("collectPngs finds every distinct PNG data URL, however deep, and nothing else", () => {
    const events = [
        { kind: "agent", images: [png(1), JPEG] },
        { kind: "agent-step", feedback: { image: png(2) }, renderOut: [{ type: "look", image: png(1) }], result: SVG },
        { kind: "chat", request: { messages: [{ images: [png(2), "data:image/webp;base64,UklGR"] }] } },
    ];
    assert.deepEqual(collectPngs(events), [png(1), png(2)]);
});

test("replaceImages swaps each mapped image, keeps what holds none as the same object, and never changes the count", () => {
    const untouched = { kind: "agent-result", summary: "no images here" };
    const events = [{ kind: "agent", images: [png(1), JPEG], task: "t" }, untouched, { kind: "agent-step", feedback: { image: png(1) } }];
    const out = replaceImages(events, new Map([[png(1), webpOf(png(1))]]));
    assert.equal(out.length, 3);
    assert.deepEqual(out[0], { kind: "agent", images: [webpOf(png(1)), JPEG], task: "t" });
    assert.equal(out[1], untouched, "an event with nothing to replace is the same object");
    assert.equal(out[2].feedback.image, webpOf(png(1)));
    assert.equal(events[0].images[0], png(1), "the input is not mutated");
});

test("isOpaque and samePixels", () => {
    assert.equal(isOpaque(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255])), true);
    assert.equal(isOpaque(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 254])), false);
    assert.equal(samePixels(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
    assert.equal(samePixels(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
    assert.equal(samePixels(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
});

// --- libwebp with our settings: lossless, every pixel back ---

test("WEBP_LOSSLESS round-trips every pixel through the real libwebp", T, async () => {
    globalThis.ImageData ??= class ImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
    const enc = await import("@jsquash/webp/encode.js"), dec = await import("@jsquash/webp/decode.js");
    const mod = (p) => WebAssembly.compile(fs.readFileSync(`node_modules/@jsquash/webp/codec/${p}`));
    await enc.init(await mod("enc/webp_enc_simd.wasm"), {});
    await dec.init(await mod("dec/webp_dec.wasm"), {});
    // Text-like blocks over a gradient with noise: the regions lossy compression smears first.
    const w = 320, h = 200, d = new Uint8ClampedArray(w * h * 4);
    let seed = 7;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        seed = (seed * 1103515245 + 12345) >>> 0;
        const ink = (x >> 2) % 3 === 0 && (y >> 3) % 2 === 0;
        d[i] = ink ? 20 : (x + (seed & 7)) & 255; d[i + 1] = ink ? 20 : (y * 2) & 255; d[i + 2] = ink ? 30 : (seed >> 8) & 255; d[i + 3] = 255;
    }
    const out = await enc.default(new ImageData(d, w, h), WEBP_LOSSLESS);
    const back = await dec.default(out);
    assert.equal(back.width, w);
    assert.ok(samePixels(back.data, d), "lossless: every channel of every pixel");
});

// --- the store: rewriting stored events under its write lock ---

const summary = (hash, over = {}) => ({ id: { runtime: "local", hash }, kind: "agent", status: "done", createdTs: 1000, lastTs: 1000, pendingApprovals: 0, saved: true, ...over });
const ev = (hash, n, over = {}) => ({ kind: "agent-step", id: hash, ts: 1000 + n, save: true, session: { hash, turn: 0 }, step: n, seq: n, tool: "look", ...over });

function backend(seed = []) {
    const rows = new Map(seed.map((r) => [r.hash, r])), events = new Map();
    return {
        rows: async () => [...rows.values()],
        append: async (row, from, list) => { rows.set(row.hash, row); const have = events.get(row.hash) ?? []; list.forEach((e, i) => { have[from + i] = e; }); events.set(row.hash, have); },
        events: async (hash) => [...(events.get(hash) ?? [])],
        remove: async (hashes) => { for (const h of hashes) { rows.delete(h); events.delete(h); } },
        _rows: rows, _events: events,
    };
}
const fakeEncode = async (url) => webpOf(url);

test("compactImages rewrites the stored events' PNGs, shrinks the row's bytes and split, and marks how far it went", T, async () => {
    const be = backend();
    const store = new SessionStore(be);
    store.put(summary("aaaa0001"), ev("aaaa0001", 0, { feedback: { image: png(1) } }));
    store.put(summary("aaaa0001"), ev("aaaa0001", 1, { result: "text only" }));
    store.put(summary("aaaa0001"), ev("aaaa0001", 2, { renderOut: [{ type: "look", image: png(1) }, { type: "look", image: png(2) }] }));
    await store.flush();
    const before = { ...be._rows.get("aaaa0001") };
    assert.deepEqual(store.compactable(), ["aaaa0001"]);

    const r = await store.compactImages("aaaa0001", fakeEncode);
    assert.deepEqual({ found: r.found, compacted: r.compacted }, { found: 2, compacted: 2 });
    const stored = await store.read("aaaa0001");
    assert.equal(stored.length, 3, "same count, same order");
    assert.equal(stored[0].feedback.image, webpOf(png(1)));
    assert.deepEqual(stored[2].renderOut.map((x) => x.image), [webpOf(png(1)), webpOf(png(2))]);
    assert.equal(stored[1].result, "text only");
    const row = be._rows.get("aaaa0001");
    assert.equal(row.compacted, 3);
    assert.equal(row.bytes, before.bytes - (r.bytesBefore - r.bytesAfter), "the budget sees the smaller size");
    assert.equal(row.split.total, row.bytes);
    assert.equal(row.split.imageCount, before.split.imageCount);
    assert.ok(row.split.images < before.split.images);
    assert.equal(row.split.other, before.split.other, "only image bytes move");
    assert.deepEqual(store.compactable(), [], "nothing left to go over");
    assert.equal(await store.compactImages("aaaa0001", fakeEncode), null);
});

test("an image the encoder keeps stays PNG, and is not offered again", T, async () => {
    const be = backend();
    const store = new SessionStore(be);
    store.put(summary("aaaa0002"), ev("aaaa0002", 0, { feedback: { image: png(1) } }));
    await store.flush();
    let asked = 0;
    const r = await store.compactImages("aaaa0002", async () => { asked++; return null; });
    assert.deepEqual({ found: r.found, compacted: r.compacted }, { found: 1, compacted: 0 });
    assert.equal((await store.read("aaaa0002"))[0].feedback.image, png(1));
    assert.equal(be._rows.get("aaaa0002").compacted, 1);
    assert.deepEqual(store.compactable(), []);
    assert.equal(asked, 1);
});

test("only events written after the last pass are gone over", T, async () => {
    const be = backend();
    const store = new SessionStore(be);
    store.put(summary("aaaa0003"), ev("aaaa0003", 0, { feedback: { image: png(1) } }));
    await store.flush();
    await store.compactImages("aaaa0003", fakeEncode);
    store.put(summary("aaaa0003"), ev("aaaa0003", 1, { feedback: { image: png(2) } }));
    await store.flush();
    const seen = [];
    await store.compactImages("aaaa0003", async (url) => { seen.push(url); return webpOf(url); });
    assert.deepEqual(seen, [png(2)]);
    assert.deepEqual((await store.read("aaaa0003")).map((e) => e.feedback.image), [webpOf(png(1)), webpOf(png(2))]);
});

test("a running session waits, and the biggest settled session goes first", T, async () => {
    const store = new SessionStore(backend());
    store.put(summary("aaaa0004", { status: "running" }), ev("aaaa0004", 0, { feedback: { image: png(1) } }));
    store.put(summary("aaaa0005"), ev("aaaa0005", 0, { feedback: { image: png(1) } }));
    store.put(summary("aaaa0006"), ev("aaaa0006", 0, { feedback: { image: png(900) } }));
    await store.flush();
    assert.deepEqual(store.compactable(), ["aaaa0006", "aaaa0005"]);
});

test("a session deleted while its images were encoding is not written back", T, async () => {
    const be = backend();
    const store = new SessionStore(be);
    store.put(summary("aaaa0007"), ev("aaaa0007", 0, { feedback: { image: png(1) } }));
    await store.flush();
    const r = await store.compactImages("aaaa0007", async (url) => { await store.forget(["aaaa0007"]); return webpOf(url); });
    assert.equal(r, null);
    assert.equal(be._rows.has("aaaa0007"), false);
    assert.equal(be._events.has("aaaa0007"), false, "no orphan events");
});

test("an encoder that cannot encode leaves the session as it was, to be tried again", T, async () => {
    const be = backend();
    const store = new SessionStore(be);
    store.put(summary("aaaa0008"), ev("aaaa0008", 0, { feedback: { image: png(1) } }));
    await store.flush();
    await assert.rejects(store.compactImages("aaaa0008", async () => { throw new Error("no offscreen document"); }), /no offscreen/);
    assert.equal(be._rows.get("aaaa0008").compacted, undefined);
    assert.deepEqual(store.compactable(), ["aaaa0008"]);
});

test("events written while a pass encodes are kept, and compacted by the next pass", T, async () => {
    const be = backend();
    const store = new SessionStore(be);
    store.put(summary("aaaa0009"), ev("aaaa0009", 0, { feedback: { image: png(1) } }));
    await store.flush();
    await store.compactImages("aaaa0009", async (url) => {
        store.put(summary("aaaa0009"), ev("aaaa0009", 1, { feedback: { image: png(2) } }));
        await store.flush();
        return webpOf(url);
    });
    const stored = await store.read("aaaa0009");
    assert.deepEqual(stored.map((e) => e.feedback.image), [webpOf(png(1)), png(2)]);
    assert.equal(be._rows.get("aaaa0009").compacted, 1);
    assert.equal(be._rows.get("aaaa0009").count, 2);
    assert.deepEqual(store.compactable(), ["aaaa0009"]);
});

test("UPGRADE: a session saved before compaction existed (no `compacted`) is compacted whole", T, async () => {
    // What an older build wrote: a row with no `compacted` and no `split`, and its events.
    const old = { hash: "aaaa0010", summary: summary("aaaa0010"), lastTs: 1000, createdTs: 1000, bytes: 5000, count: 2 };
    const be = backend([old]);
    be._events.set("aaaa0010", [ev("aaaa0010", 0, { feedback: { image: png(1) } }), ev("aaaa0010", 1, { feedback: { image: png(1) } })]);
    const store = new SessionStore(be);
    await store.open();
    assert.deepEqual(store.compactable(), ["aaaa0010"]);
    const r = await store.compactImages("aaaa0010", fakeEncode);
    assert.equal(r.compacted, 1);
    assert.deepEqual((await store.read("aaaa0010")).map((e) => e.feedback.image), [webpOf(png(1)), webpOf(png(1))]);
    const row = be._rows.get("aaaa0010");
    assert.equal(row.split, undefined, "an unmeasured session stays unmeasured");
    assert.equal(row.bytes, 5000 - (r.bytesBefore - r.bytesAfter));
});

test("the row's history, what a resume sends the model, is never touched", T, async () => {
    const be = backend();
    const store = new SessionStore(be);
    store.put(summary("aaaa0011"), ev("aaaa0011", 0, { feedback: { image: png(1) } }));
    const messages = [{ role: "user", content: "look", images: [png(1)] }];
    store.putHistory("aaaa0011", { kind: "agent", messages });
    await store.flush();
    await store.compactImages("aaaa0011", fakeEncode);
    assert.equal(messages[0].images[0], png(1));
    assert.equal(be._rows.get("aaaa0011").history.messages[0].images[0], png(1));
});

// --- the background pass ---

test("the pass waits for the writes to stop, compacts every candidate, and logs what it saved", T, async () => {
    const store = new SessionStore(backend());
    const records = [];
    const c = imageCompactor(store, { encode: fakeEncode, record: (r) => records.push(r), quietMs: 30 });
    store.put(summary("bbbb0001"), ev("bbbb0001", 0, { feedback: { image: png(1) } }));
    store.put(summary("bbbb0002"), ev("bbbb0002", 0, { feedback: { image: png(2) } }));
    await store.flush();
    c.kick();
    await new Promise((r) => setTimeout(r, 15));
    c.kick();   // another write: the quiet period starts again
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(records.length, 0, "not while the store is still busy");
    await new Promise((r) => setTimeout(r, 40));
    await c.pass();
    assert.deepEqual(records.map((r) => [r.subsystem, r.kind, r.key ?? null]), [
        // biggest first: bbbb0002's image is the longer one
        ["sessions", "compact-pass", null], ["sessions", "compact-images", "bbbb0002"], ["sessions", "compact-images", "bbbb0001"], ["sessions", "compact-pass-done", null],
    ]);
    const per = records.filter((r) => r.kind === "compact-images");
    assert.ok(per.every((r) => r.bytes > 0 && r.detail.compacted === 1 && r.detail.from === 0));
    const done = records.at(-1);
    assert.deepEqual(done.detail, { sessions: 2, images: 2 });
    assert.equal(done.bytes, per[0].bytes + per[1].bytes);
    assert.equal(records[0].detail.sessions, 2);
    assert.deepEqual(store.compactable(), []);
});

test("a pass whose encoder fails stops at once and logs it, leaving every session for the next", T, async () => {
    const store = new SessionStore(backend());
    const records = [];
    let calls = 0;
    const c = imageCompactor(store, { encode: async () => { calls++; throw new Error("worker gone"); }, record: (r) => records.push(r) });
    store.put(summary("bbbb0003"), ev("bbbb0003", 0, { feedback: { image: png(1) } }));
    store.put(summary("bbbb0004"), ev("bbbb0004", 0, { feedback: { image: png(2) } }));
    await store.flush();
    await c.pass();
    assert.equal(calls, 1);
    assert.deepEqual(records.map((r) => [r.level ?? "info", r.kind]), [["info", "compact-pass"], ["warn", "compact-images-failed"]], "no compact-pass-done: it did not finish");
    assert.equal(store.compactable().length, 2);
});

test("the store's writes are what kick the pass", T, async () => {
    let kicks = 0;
    const store = new SessionStore(backend(), { onWrite: () => kicks++ });
    store.put(summary("bbbb0005"), ev("bbbb0005", 0));
    await store.flush();
    assert.equal(kicks, 1);
    await store.flush();
    assert.equal(kicks, 1, "a flush with nothing to write is not a write");
});

test("a pass with nothing to do does not keep the next one from running", T, async () => {
    // The first pass finishes synchronously; a latch cleared inside it, before it was assigned, stayed set for good.
    const store = new SessionStore(backend());
    const records = [];
    const c = imageCompactor(store, { encode: fakeEncode, record: (r) => records.push(r) });
    await c.pass();
    assert.equal(records.length, 0, "an empty pass logs nothing");
    store.put(summary("bbbb0006"), ev("bbbb0006", 0, { feedback: { image: png(1) } }));
    await store.flush();
    await c.pass();
    assert.deepEqual(store.compactable(), []);
    assert.ok(records.some((r) => r.kind === "compact-images" && r.key === "bbbb0006"));
});

// --- recovering from a browser closed mid-pass ---

test("a large session is committed in chunks, so a pass stopped half way keeps what it did and the next resumes there", T, async () => {
    const be = backend();
    const store = new SessionStore(be);
    for (let n = 0; n < 20; n++) store.put(summary("cccc0001"), ev("cccc0001", n, { feedback: { image: png(n) } }));
    await store.flush();
    // The browser closes during the 11th encode: the encoder never answers again.
    let calls = 0;
    await assert.rejects(store.compactImages("cccc0001", async (url) => { if (++calls > 10) throw new Error("browser closed"); return webpOf(url); }, { chunkImages: 4 }));
    assert.equal(be._rows.get("cccc0001").compacted, 8, "two chunks of four were committed");
    const kept = be._events.get("cccc0001");
    assert.deepEqual(kept.slice(0, 8).map((e) => e.feedback.image), Array.from({ length: 8 }, (_, n) => webpOf(png(n))));
    assert.equal(kept[8].feedback.image, png(8), "the chunk in flight was not written");

    // A new worker over the same disk: the row says where to carry on.
    const again = new SessionStore(be);
    await again.open();
    const seen = [];
    const r = await again.compactImages("cccc0001", async (url) => { seen.push(url); return webpOf(url); }, { chunkImages: 4 });
    assert.equal(seen.length, 12, "only what the first pass did not commit");
    assert.equal(r.from, 8);
    assert.deepEqual((await again.read("cccc0001")).map((e) => e.feedback.image), Array.from({ length: 20 }, (_, n) => webpOf(png(n))));
    assert.equal(be._rows.get("cccc0001").compacted, 20);
    const row = be._rows.get("cccc0001");
    assert.equal(row.split.total, row.bytes, "the chunks' byte moves add up");
});

test("an image repeated across chunks is encoded once per pass", T, async () => {
    const store = new SessionStore(backend());
    // A chat event re-embeds the whole history, so the same screenshot sits in every later event.
    for (let n = 0; n < 6; n++) store.put(summary("cccc0002"), ev("cccc0002", n, { images: [png(0), png(n + 1)] }));
    await store.flush();
    const seen = [];
    await store.compactImages("cccc0002", async (url) => { seen.push(url); return webpOf(url); }, { chunkImages: 2 });
    assert.equal(seen.filter((u) => u === png(0)).length, 1);
    assert.equal(new Set(seen).size, seen.length);
});

test("one event holding more images than a chunk is a chunk of its own", T, async () => {
    const be = backend();
    const store = new SessionStore(be);
    store.put(summary("cccc0003"), ev("cccc0003", 0, { images: [png(1), png(2), png(3)] }));
    store.put(summary("cccc0003"), ev("cccc0003", 1, { images: [png(4)] }));
    await store.flush();
    const r = await store.compactImages("cccc0003", fakeEncode, { chunkImages: 2 });
    assert.equal(r.compacted, 4);
    assert.equal(be._rows.get("cccc0003").compacted, 2);
});
