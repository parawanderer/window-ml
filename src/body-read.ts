// Reading a response body with the cap applied WHILE reading, not after.
//
// `ml.fetch` used to call `res.text()` and slice the result to its size cap — which caps what is KEPT, not what
// is read. A 1 GB response was held whole first (about 2 GB once it is a UTF-16 string), in a service worker,
// and only then cut down. The binary branch called `res.arrayBuffer()` with no cap at all. A cap that runs after
// the allocation it exists to prevent protects nothing.
//
// Its own module, with no imports, so it can be tested against a real `Response` without loading the service
// worker's other layers.

/** Read at most `maxBytes` of a response body, then STOP — cancelling the stream so the rest is never
 *  downloaded, let alone held. `truncated` says whether there was more.
 *
 *  A response with no readable body stream (a HEAD, a 204, or a hand-built object in a test) falls back to
 *  `arrayBuffer()` and is capped afterwards; there is nothing larger than the cap to avoid in that case that
 *  a stream would have avoided, because there is no stream. */
export async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
    const reader = res.body?.getReader?.();
    if (!reader) {
        const all = new Uint8Array(await bodyFallback(res));
        return all.length > maxBytes ? { bytes: all.subarray(0, maxBytes), truncated: true } : { bytes: all, truncated: false };
    }
    const chunks: Uint8Array[] = [];
    let kept = 0, truncated = false;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const room = maxBytes - kept;
        if (value.length > room) {
            // Keep what fits and stop pulling. `cancel` tells the network layer we are done, so the remainder is
            // not buffered on our behalf either.
            if (room > 0) { chunks.push(value.subarray(0, room)); kept += room; }
            truncated = true;
            try { await reader.cancel(); } catch { /* already closed */ }
            break;
        }
        chunks.push(value);
        kept += value.length;
    }
    const bytes = new Uint8Array(kept);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.length; }
    return { bytes, truncated };
}

/** A response without a stream: use whatever it does offer. `text()` is the one every hand-built mock in
 *  the test suite implements, so it is accepted too, and encoded back to bytes. */
async function bodyFallback(res: Response): Promise<ArrayBuffer> {
    if (typeof res.arrayBuffer === "function") {
        try { return await res.arrayBuffer(); } catch { /* fall through to text */ }
    }
    if (typeof res.text === "function") return new TextEncoder().encode(await res.text()).buffer as ArrayBuffer;
    return new ArrayBuffer(0);
}

/** Decode capped bytes as UTF-8 — the same decoding `res.text()` always applied (the Fetch standard's `text()`
 *  is UTF-8 regardless of the declared charset). When the body was CUT, a multi-byte character can be split at
 *  the cut; decoding in streaming mode and not flushing drops that incomplete tail instead of rendering it as
 *  a replacement character that was never in the document. */
export function decodeCapped(bytes: Uint8Array, truncated: boolean): string {
    const d = new TextDecoder("utf-8");
    return truncated ? d.decode(bytes, { stream: true }) : d.decode(bytes);
}
