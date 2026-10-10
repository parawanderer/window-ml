// image-worker.ts — re-encodes a saved session's PNG screenshots as lossless WebP, in a DEDICATED WORKER the offscreen
// document starts (offscreen.ts), so a one-second encode of a large screenshot holds up neither the service worker nor
// the page. libwebp is the WASM build from @jsquash/webp: Chromium's own `convertToBlob("image/webp")` encodes
// lossless at a fast effort that came out LARGER than the PNG on half of the measured images.
//
// Requests arrive as `{ id, url }` and are answered `{ id, url }` with the WebP data URL, or with `url: null` when the
// image is kept as it is: not opaque, not smaller, or not pixel-identical once decoded again. Nothing here can make a
// stored image worse; the worst outcome is that it stays a PNG.
//
// chrome-free, like archive-worker.ts: the wasm is found next to this script's own URL (build.mjs copies it).
import encode, { init } from "@jsquash/webp/encode.js";
import { simd } from "wasm-feature-detect";
import { isOpaque, PNG_DATA_URL, samePixels, WEBP_LOSSLESS } from "./image-compact";

let ready: Promise<unknown> | null = null;   // state: plumbing

/** Load libwebp once: the SIMD build where the engine has SIMD, compiled from the file beside this script. */
function load(): Promise<unknown> {
    ready ??= (async () => {
        const file = (await simd()) ? "webp_enc_simd.wasm" : "webp_enc.wasm";
        const module = await WebAssembly.compileStreaming(fetch(new URL(file, self.location.href)));
        // `init` takes the compiled module first (its types omit it), and `locateFile` keeps the glue off
        // `import.meta.url`, which a classic bundle does not have.
        const start = init as unknown as (m: WebAssembly.Module, o: { locateFile: (f: string) => string }) => Promise<unknown>;
        return start(module, { locateFile: (f) => new URL(f, self.location.href).href });
    })();
    ready.catch(() => { ready = null; });
    return ready;
}

/** Decode an image to RGBA exactly as stored: no colour conversion, no premultiplying. */
async function pixels(blob: Blob): Promise<ImageData> {
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = canvas.getContext("2d")!;
    g.drawImage(bitmap, 0, 0);
    bitmap.close();
    return g.getImageData(0, 0, canvas.width, canvas.height);
}

/** One PNG data URL as a lossless WebP data URL, or null when it should stay as it is. */
async function toWebp(url: string): Promise<string | null> {
    if (!PNG_DATA_URL.test(url)) return null;
    await load();
    const png = await (await fetch(url)).blob();
    const img = await pixels(png);
    if (!isOpaque(img.data)) return null;
    const webp = new Blob([await encode(img, WEBP_LOSSLESS)], { type: "image/webp" });
    if (webp.size >= png.size) return null;
    if (!samePixels((await pixels(webp)).data, img.data)) return null;
    const bytes = new Uint8Array(await webp.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/webp;base64,${btoa(bin)}`;
}

// One at a time: an encode holds a few hundred MB for a large screenshot, and nothing waits on the answer.
let queue: Promise<void> = Promise.resolve();   // state: plumbing
self.onmessage = (e: MessageEvent<{ id: number; url: string }>) => {
    const { id, url } = e.data;
    queue = queue.then(async () => {
        try { (self as unknown as Worker).postMessage({ id, url: await toWebp(url) }); }
        catch (err) { (self as unknown as Worker).postMessage({ id, url: null, error: String((err as Error)?.message || err) }); }
    });
};
