// Reading a varint-DELIMITED protobuf stream.
//
// The messages themselves are decoded by generated code (`src/proto/chat.gen.ts`, from the schema the server
// owns). This file is the other half, which is NOT in the schema and cannot be: how one message is told from
// the next on a byte stream. That is protobuf's own delimited convention — a varint byte count before each
// message, what `writeDelimitedTo`/`parseDelimitedFrom` speak — rather than anything invented here.
//
// The whole reason it needs writing at all: `fetch()` hands back arbitrary chunks, and network chunk
// boundaries have NOTHING to do with message boundaries. One read can carry three messages and half of a
// fourth, and the next can carry the rest of that fourth. So the reader buffers, and yields only what is
// wholly present.

/** The largest single frame we will assemble, as a guard against a corrupt length prefix claiming gigabytes.
 *  A chat frame is tens of bytes; a very long reasoning delta is still kilobytes. */
export const MAX_FRAME_BYTES = 1 << 20;

/**
 * Read one varint at `at`.
 *
 * Returns null when the bytes present do not yet contain a whole one — which is not an error, it is the
 * ordinary case at the end of a network chunk, and the difference between "wait" and "fail" is the entire
 * job of this module.
 */
export function readVarint(buf: Uint8Array, at = 0): { value: number; next: number } | null {
    let value = 0, shift = 0, i = at;
    for (; i < buf.length; i++) {
        const b = buf[i];
        value += (b & 0x7f) * Math.pow(2, shift);   // not `<<`: it is a 32-bit op and a length can exceed it
        if ((b & 0x80) === 0) return { value, next: i + 1 };
        shift += 7;
        // A varint longer than this is not a length we would ever send; treat it as corruption rather than
        // reading forever.
        if (shift > 63) throw new Error("protostream: varint too long");
    }
    return null;   // incomplete — more bytes are coming
}

/**
 * A stateful reader: push the bytes as they arrive, take the whole frames that have become available.
 *
 * Deliberately NOT an async generator over the body. The caller already owns the read loop (it has an abort
 * signal, a port to push to, and per-chunk timing to stamp), and handing that loop over to get framing back
 * would be the wrong trade.
 */
export function createFrameReader(max = MAX_FRAME_BYTES) {
    let buf = new Uint8Array(0);
    return {
        /** Add a network chunk; get back every message that is now complete, in order. */
        push(chunk: Uint8Array): Uint8Array[] {
            if (chunk.length) {
                const next = new Uint8Array(buf.length + chunk.length);
                next.set(buf); next.set(chunk, buf.length);
                buf = next;
            }
            const out: Uint8Array[] = [];
            for (;;) {
                const head = readVarint(buf);
                if (!head) break;                                  // the length itself is not all here yet
                if (head.value > max) throw new Error(`protostream: frame of ${head.value} bytes refused`);
                if (buf.length < head.next + head.value) break;    // the body is not all here yet
                out.push(buf.subarray(head.next, head.next + head.value));
                buf = buf.subarray(head.next + head.value);
            }
            return out;
        },
        /** Bytes held back waiting for the rest of their frame. Non-zero at the end of a stream means the
         *  stream was CUT MID-FRAME, which a caller should treat as a transport failure rather than an end. */
        get pending(): number { return buf.length; },
    };
}
