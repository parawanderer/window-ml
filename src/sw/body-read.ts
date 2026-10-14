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

/** How many leading bytes the binary check reads — git's own window for the same question. */
const BINARY_SNIFF = 8000;

// Formats worth NAMING when a body turns out to be binary, by their magic bytes. Not a decoder list: it lets the
// message say "a ZIP archive" instead of "binary data", which is what tells a reader whether to try another URL.
const MAGICS: [string, number[], number?][] = [
    ["an Arrow IPC file", [0x41, 0x52, 0x52, 0x4f, 0x57, 0x31]],               // ARROW1
    ["a ZIP archive (also .xlsx/.docx/.jar)", [0x50, 0x4b, 0x03, 0x04]],
    ["a gzip stream", [0x1f, 0x8b]],
    ["a PNG image", [0x89, 0x50, 0x4e, 0x47]],
    ["a JPEG image", [0xff, 0xd8, 0xff]],
    ["a GIF image", [0x47, 0x49, 0x46, 0x38]],
    ["a PDF document", [0x25, 0x50, 0x44, 0x46]],                               // %PDF
    ["an SQLite database", [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66]],  // "SQLite f"
    ["a WebAssembly module", [0x00, 0x61, 0x73, 0x6d]],
    ["a WebP image", [0x57, 0x45, 0x42, 0x50], 8],                             // RIFF....WEBP
];

/**
 * Is this body BINARY rather than text, and if so, what does it look like? Null for text.
 *
 * Binary means a NUL byte in the first 8,000 bytes, the rule git uses: no text encoding a web server sends as
 * UTF-8 contains one, and nearly every binary format does within its header. The one text exception is UTF-16,
 * which is full of NULs, so a UTF-16 byte-order mark reads as text. A PDF is named even without a NUL (its
 * header is ASCII), because a PDF decoded as text is the same unreadable stream.
 *
 * Exists because a body nobody recognised used to be decoded as UTF-8 and handed to the model byte for byte.
 */
export function binaryKind(bytes: Uint8Array): string | null {
    const head = bytes.subarray(0, BINARY_SNIFF);
    if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) return null;
    const named = MAGICS.find(([, sig, at = 0]) => head.length >= at + sig.length && sig.every((b, i) => head[at + i] === b))?.[0];
    if (named === "a PDF document") return named;
    return head.includes(0) ? (named ?? "unrecognised binary data") : null;
}

/**
 * The media type of a RASTER image these bytes start with, or null when they are not one. Decided by magic bytes alone,
 * never by a header: PNG, JPEG, GIF, WebP, BMP, ICO and AVIF/HEIF. SVG is text and is not here.
 *
 * Exists so the worker's image read for a page (sw-image-fetch.ts) hands back only an image, whatever the server says
 * the body is: an HTML page or a JSON answer served as `image/png` is refused.
 */
export function imageMime(b: Uint8Array): string | null {
    const at = (off: number, sig: number[]) => b.length >= off + sig.length && sig.every((x, i) => b[off + i] === x);
    const ascii = (off: number, s: string) => at(off, [...s].map((c) => c.charCodeAt(0)));
    if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
    if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
    if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
    if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
    if (ascii(0, "BM") && at(6, [0, 0, 0, 0])) return "image/bmp";            // two reserved zero words after the size
    if (at(0, [0, 0, 1, 0]) && b.length >= 6 && b[4] + b[5] > 0) return "image/x-icon";
    if (ascii(4, "ftyp")) {
        const brand = String.fromCharCode(...b.subarray(8, 12));
        if (brand === "avif" || brand === "avis") return "image/avif";
        if (["heic", "heix", "mif1", "msf1"].includes(brand)) return "image/heif";
    }
    return null;
}
