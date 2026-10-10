// frames.ts — reading a held run's screen as bench/stream.mjs sends it: frames, each a 4-byte big-endian length and a JPEG.

/**
 * Read a stream of frames, calling `onFrame` with each JPEG as soon as all of it has arrived. Settles when the stream
 * ends (the held run let go, or its process died), and rejects when it breaks or is aborted.
 */
export async function readScreenFrames(body: ReadableStream<Uint8Array>, onFrame: (jpeg: Uint8Array<ArrayBuffer>) => void): Promise<void> {
    const reader = body.getReader();
    let buf: Uint8Array<ArrayBuffer> = new Uint8Array(0);
    for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const next = new Uint8Array(buf.length + value.length);
        next.set(buf);
        next.set(value, buf.length);
        buf = next;
        while (buf.length >= 4) {
            const n = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0);
            if (buf.length < 4 + n) break;
            onFrame(buf.slice(4, 4 + n));
            buf = buf.slice(4 + n);
        }
    }
}
