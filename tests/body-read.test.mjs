// A size cap has to apply while a body is READ, not to what is kept afterwards. The old path called
// `res.text()` and then sliced, so a 1 GB response was held whole before being cut. These tests use a real
// `Response` over a counting stream, because the property is about how much gets PULLED — a result that is
// merely short would pass against the broken version too.
import test from "node:test";
import assert from "node:assert";
import { readCapped, decodeCapped } from "../src/body-read.ts";

/** A Response whose body is produced on demand, one chunk per pull, recording how many chunks were asked for. */
function countingResponse(chunkBytes, totalChunks) {
    const stats = { pulled: 0, cancelled: false };
    const body = new ReadableStream({
        pull(controller) {
            if (stats.pulled >= totalChunks) { controller.close(); return; }
            stats.pulled++;
            controller.enqueue(new Uint8Array(chunkBytes).fill(0x61));   // "aaaa…"
        },
        cancel() { stats.cancelled = true; },
    }, { highWaterMark: 0 });
    return { res: new Response(body), stats };
}

test("the cap STOPS the read: a huge body is never pulled past the limit", async () => {
    // 1,000 chunks of 1 MB is a 1 GB body. Reading 3.5 MB of it must pull about four chunks, not a thousand.
    const { res, stats } = countingResponse(1_000_000, 1000);
    const { bytes, truncated } = await readCapped(res, 3_500_000);
    assert.equal(bytes.length, 3_500_000);
    assert.equal(truncated, true);
    assert.ok(stats.pulled <= 5, `pulled ${stats.pulled} chunks — the cap has to stop the READ, not trim the result`);
    assert.equal(stats.cancelled, true, "the stream is cancelled, so the network layer stops too");
});

test("a body under the cap is read whole and not marked truncated", async () => {
    const { res } = countingResponse(1000, 3);
    const { bytes, truncated } = await readCapped(res, 10_000);
    assert.equal(bytes.length, 3000);
    assert.equal(truncated, false);
});

test("a body exactly at the cap is not truncated", async () => {
    const { res } = countingResponse(1000, 4);
    const { bytes, truncated } = await readCapped(res, 4000);
    assert.equal(bytes.length, 4000);
    assert.equal(truncated, false, "nothing was left unread");
});

test("a multi-byte character split by the cut is dropped, not rendered as a character the document never had", () => {
    const whole = new TextEncoder().encode("price: 5€");   // € is three bytes
    const cut = whole.subarray(0, whole.length - 1);       // split inside it
    assert.equal(decodeCapped(cut, true), "price: 5", "the incomplete tail is dropped");
    assert.equal(decodeCapped(whole, false), "price: 5€");
    // The untruncated path flushes, so a genuinely malformed body still shows its replacement character.
    assert.match(decodeCapped(cut, false), /�$/);
});

test("a response with no stream falls back to what it does offer, capped afterwards", async () => {
    // The shape of the hand-built mocks in the background tests: text() and nothing else.
    const mock = { text: async () => "x".repeat(50) };
    const capped = await readCapped(mock, 20);
    assert.equal(capped.bytes.length, 20);
    assert.equal(capped.truncated, true);
    const whole = await readCapped(mock, 100);
    assert.equal(decodeCapped(whole.bytes, whole.truncated), "x".repeat(50));
    // …and a real bodiless response (a 204) reads as empty, not as an error.
    const empty = await readCapped(new Response(null, { status: 204 }), 100);
    assert.equal(empty.bytes.length, 0);
    assert.equal(empty.truncated, false);
});
