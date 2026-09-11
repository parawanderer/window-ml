// The protobuf chat stream: the SCHEMA PIN, the generated decoder, and the framing.
//
// Three separable things, and only the last is ours. The schema belongs to the box that serves the stream, so
// the risk is not that our code is wrong — it is that our copy of someone else's contract quietly stops being
// their contract. That is what the pin is for, and it is checked here rather than trusted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPin, protocVersion, generate } from "../scripts/gen-proto.mjs";
import { readVarint, createFrameReader, MAX_FRAME_BYTES } from "../src/protostream.ts";

test("the vendored schema is byte-for-byte the file at the pinned commit", () => {
    // OFFLINE, deliberately: a git blob id is content-addressed, so this holds in CI and in a fresh checkout
    // where the private repo it came from is unreachable. A pin that can only be checked on one laptop is a
    // pin nobody checks.
    const r = checkPin({ remote: false });
    assert.ok(r.local, "the copy hashes to the pinned blob");
});

test("the checked-in decoder is what the schema generates", () => {
    // CHECKED IN because CI has no protoc, which means it can go stale in exactly the way a generated file is
    // supposed to make impossible — so where protoc IS present, regenerate and diff. Skipped otherwise rather
    // than failing a machine that never asked for a protobuf toolchain (the same rule the CPython tests use).
    if (!protocVersion()) return;
    const tmp = mkdtempSync(join(tmpdir(), "protogen-"));
    try {
        const fresh = generate(tmp);
        const shipped = readFileSync(new URL("../src/proto/chat.gen.ts", import.meta.url), "utf8");
        assert.equal(fresh, shipped, "src/proto/chat.gen.ts is stale — run `npm run gen-proto`");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("readVarint: waits for an incomplete one rather than guessing", () => {
    assert.deepEqual(readVarint(new Uint8Array([0x05])), { value: 5, next: 1 });
    // Multi-byte: 300 = 0xAC 0x02.
    assert.deepEqual(readVarint(new Uint8Array([0xac, 0x02])), { value: 300, next: 2 });
    // The high bit says "more to come", and there is none yet. NULL, not zero and not a throw: this is the
    // ordinary state at the end of a network chunk, and telling it apart from a real value is the whole job.
    assert.equal(readVarint(new Uint8Array([0xac])), null);
    assert.equal(readVarint(new Uint8Array([])), null);
    // Reads at an offset, so a caller can walk a buffer without copying.
    assert.deepEqual(readVarint(new Uint8Array([0xff, 0xff, 0x07]), 2), { value: 7, next: 3 });
    // Beyond any length we would ever be sent is corruption, not patience.
    assert.throws(() => readVarint(new Uint8Array(Array(12).fill(0x80))), /too long/);
});

/** Frame a payload the way the server does: its length as a varint, then its bytes. */
const framed = (...payloads) => {
    const out = [];
    for (const p of payloads) {
        let n = p.length;
        do { out.push(n > 127 ? (n & 0x7f) | 0x80 : n); n >>>= 7; } while (n);
        out.push(...p);
    }
    return new Uint8Array(out);
};
const bytes = (...n) => new Uint8Array(n);

test("createFrameReader: network chunks have nothing to do with message boundaries", () => {
    const wire = framed(bytes(1, 2, 3), bytes(4), bytes(5, 6));

    // Everything at once.
    assert.deepEqual(createFrameReader().push(wire).map((f) => [...f]), [[1, 2, 3], [4], [5, 6]]);

    // ONE BYTE AT A TIME — the pathological case, and the one that proves nothing is assumed about arrival.
    const r = createFrameReader();
    const got = [];
    for (const b of wire) got.push(...r.push(new Uint8Array([b])));
    assert.deepEqual(got.map((f) => [...f]), [[1, 2, 3], [4], [5, 6]]);
    assert.equal(r.pending, 0, "nothing held back once every frame has landed");

    // Three messages and HALF of a fourth, then the rest — the shape the handover warns about.
    const r2 = createFrameReader();
    const split = 8;
    const wire2 = framed(bytes(1, 2, 3), bytes(4), bytes(5, 6), bytes(7, 8, 9));
    const first = r2.push(wire2.subarray(0, split));
    assert.ok(first.length < 4, "a partial frame is not yielded");
    assert.ok(r2.pending > 0, "…it is held");
    const rest = r2.push(wire2.subarray(split));
    assert.deepEqual([...first, ...rest].map((f) => [...f]), [[1, 2, 3], [4], [5, 6], [7, 8, 9]]);
    assert.equal(r2.pending, 0);
});

test("createFrameReader: a length prefix claiming the world is refused", () => {
    // A corrupt or misaligned prefix would otherwise have us buffer until we ran out of memory, waiting for
    // bytes that are never coming.
    const huge = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f]);   // ~4 GB
    assert.throws(() => createFrameReader().push(huge), /refused/);
    assert.ok(MAX_FRAME_BYTES > 65536, "…but the cap is far above any real frame");
});

test("createFrameReader: a stream cut mid-frame is visible as held bytes", () => {
    // The distinction a caller needs: a stream that ENDED and one that was CUT. Bytes still pending at the
    // end mean the last frame never arrived, which is a transport failure and not a completion — reporting
    // partial output as a finished answer is a wrong answer dressed as an empty one.
    const r = createFrameReader();
    r.push(framed(bytes(1, 2, 3)).subarray(0, 3));
    assert.ok(r.pending > 0);
});

test("the generated decoder reads a real frame, tool calls included", async () => {
    const { Frame } = await import("../src/proto/chat.gen.ts");
    // Hand-built on the wire rather than round-tripped through our own encoder — there isn't one, and a test
    // that encodes with the same field numbers it decodes proves only that it agrees with itself.
    // Frame.delta (field 2, wire type 2) { Delta.content (field 1) = "hi" }
    const deltaBody = bytes(0x0a, 0x02, 0x68, 0x69);              // 1<<3|2, len 2, "hi"
    const frame = bytes(0x12, deltaBody.length, ...deltaBody);    // 2<<3|2
    const f = Frame.decode(frame);
    assert.equal(f.delta?.content, "hi");
    assert.equal(f.start, undefined, "a oneof carries exactly one arm");

    // TOOL CALLS ARE IN THE SCHEMA ALREADY, even though the server does not emit them yet — which is the
    // reason this decoder is GENERATED rather than hand-written to the fields we happen to see today. The
    // day they start arriving, this passes without a change here.
    // Delta.tool_calls (field 3) { ToolCall.function (field 4) { Function.name (field 1) = "go" } }
    const fnBody = bytes(0x0a, 0x02, 0x67, 0x6f);
    const tcBody = bytes(0x22, fnBody.length, ...fnBody);
    const d2 = bytes(0x1a, tcBody.length, ...tcBody);
    const f2 = Frame.decode(bytes(0x12, d2.length, ...d2));
    assert.equal(f2.delta?.toolCalls?.[0]?.function?.name, "go");
});

test("the decoder skips fields it does not know rather than failing on them", async () => {
    const { Frame } = await import("../src/proto/chat.gen.ts");
    // A server that adds a field must not break a client that has not regenerated. Field 99, varint.
    const deltaBody = bytes(0x0a, 0x02, 0x68, 0x69, 0xd8, 0x06, 0x2a);
    const f = Frame.decode(bytes(0x12, deltaBody.length, ...deltaBody));
    assert.equal(f.delta?.content, "hi", "the known field still reads");
});
