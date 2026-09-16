// A size cap has to apply while a body is READ, not to what is kept afterwards. The old path called
// `res.text()` and then sliced, so a 1 GB response was held whole before being cut. These tests use a real
// `Response` over a counting stream, because the property is about how much gets PULLED — a result that is
// merely short would pass against the broken version too.
import test from "node:test";
import assert from "node:assert";
import { readCapped, decodeCapped, binaryKind } from "../src/body-read.ts";

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

// A body nobody recognised used to be decoded as UTF-8 and handed to the model byte for byte.
const bytesOf = (...parts) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));

test("binaryKind: a NUL in the head is binary, and a known format is NAMED", () => {
    assert.equal(binaryKind(bytesOf("ARROW1", [0, 0, 0xff, 0xff])), "an Arrow IPC file");
    assert.equal(binaryKind(bytesOf([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0])), "a ZIP archive (also .xlsx/.docx/.jar)");
    assert.equal(binaryKind(bytesOf([0x89], "PNG\r\n", [0x1a, 0x0a, 0, 0, 0])), "a PNG image");
    assert.equal(binaryKind(bytesOf("RIFF", [0x10, 0, 0, 0], "WEBPVP8 ")), "a WebP image");
    assert.equal(binaryKind(bytesOf([0xff, 0xff, 0xff, 0xff, 0x50, 1, 0, 0])), "unrecognised binary data", "an Arrow STREAM has no magic");
});

test("binaryKind: text is null — including UTF-16 with its NULs, and a NUL too late to be the header's", () => {
    assert.equal(binaryKind(bytesOf("id,name\n1,Ada\n")), null);
    assert.equal(binaryKind(bytesOf("# Title\n\nprose, ünïcödé ✓")), null);
    assert.equal(binaryKind(bytesOf([0xff, 0xfe], "h", [0], "i", [0])), null, "UTF-16 LE with a BOM is text");
    assert.equal(binaryKind(bytesOf("x".repeat(9000), [0])), null, "only the first 8,000 bytes are sniffed");
    assert.equal(binaryKind(new Uint8Array(0)), null);
});

test("binaryKind: a PDF is binary even though its header is ASCII", () => {
    assert.equal(binaryKind(bytesOf("%PDF-1.7\n%\u00e2\u00e3\n1 0 obj")), "a PDF document");
});
