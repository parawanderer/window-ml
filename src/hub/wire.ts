/**
 * Hub frames on a websocket message: the writing half of `src/protostream.ts`.
 *
 * The hub speaks the same varint-delimited framing the chat stream does, so reading is `createFrameReader`
 * unchanged. Only the writing side is new, because this is the first thing here that SENDS a delimited stream
 * rather than only consuming one.
 */
import { Frame } from "../proto/wmlhub/v1/hub.gen";
import { Bytes, concat } from "./hpke";

export { Frame };
export { Kind, Envelope, Hello, Welcome, Limits, Error as HubErrorFrame } from "../proto/wmlhub/v1/hub.gen";
export { Role } from "../proto/wmlhub/v1/identity.gen";
export type { Position, StreamRef } from "../proto/wmlhub/v1/hub.gen";

/** A varint, protobuf's own, for the length that prefixes each frame. */
export function varint(n: number): Bytes {
    const out: number[] = [];
    let left = n;
    do {
        const byte = left % 128;
        left = Math.floor(left / 128);
        out.push(left > 0 ? byte | 0x80 : byte);
    } while (left > 0);
    return new Uint8Array(out);
}

/** Several frames as one websocket message: each length-prefixed, in order. */
export function encodeFrames(frames: Frame[]): Bytes {
    const parts: Uint8Array[] = [];
    for (const frame of frames) {
        const body = Frame.encode(frame).finish();
        parts.push(varint(body.length), body);
    }
    return concat(...parts);
}
