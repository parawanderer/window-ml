// raster.ts — the image seam under the vision helpers: decode a data URL, draw on a canvas, encode a PNG, in a page or in the worker.

// The crop, overlay, grid, letterbox and stitch helpers draw the same way wherever they run; only where an image and a
// canvas come from differs. A page has `Image`, `document.createElement("canvas")` and `toDataURL`; the service worker
// has none of those, and has `createImageBitmap`, `OffscreenCanvas` and `convertToBlob` instead. A helper takes a
// `Raster` (defaulting to `pageRaster`) and goes through it for those three things, so one drawing body serves both.
// The PNG BYTES the two encoders produce differ; the decoded pixels do not (tests/e2e/raster.spec.mjs).

/** The drawing calls a helper may make, which a page canvas's 2D context and an OffscreenCanvas's both provide. */
export type Raster2D = CanvasState & CanvasDrawImage & CanvasImageData & CanvasRect & CanvasText & CanvasTextDrawingStyles
    & CanvasFillStrokeStyles & CanvasPathDrawingStyles & CanvasDrawPath & CanvasPath;

/** A decoded image: what to hand `drawImage`, its size in pixels, and `close()` to free it once drawn. */
export interface RasterImage {
    readonly source: CanvasImageSource;
    readonly width: number;
    readonly height: number;
    close(): void;
}

/** A canvas to draw on: a page `<canvas>` or an `OffscreenCanvas`. */
export interface RasterCanvas {
    width: number;
    height: number;
    getContext(type: "2d", options?: CanvasRenderingContext2DSettings): Raster2D | null;
}

/** Where images and canvases come from, and how a canvas becomes a PNG data URL. */
export interface Raster {
    /** Decode an image data URL. Rejects when it is not an image. */
    decode(dataUrl: string): Promise<RasterImage>;
    /** A blank `w`×`h` canvas. */
    canvas(w: number, h: number): RasterCanvas;
    /** The canvas as a `data:image/png;base64,…` URL. */
    encode(c: RasterCanvas): Promise<string>;
}

/** The page's raster: `Image`, a document `<canvas>` and `toDataURL`, as every vision helper drew before the seam. */
export const pageRaster: Raster = {
    decode: (dataUrl) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} });
        img.onerror = () => reject(new Error("the image did not decode"));
        img.src = dataUrl;
    }),
    canvas: (w, h) => {
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        return c as unknown as RasterCanvas;
    },
    encode: async (c) => (c as unknown as HTMLCanvasElement).toDataURL("image/png"),
};

/** Base64 of bytes, in chunks: a screenshot is too large for one spread into `String.fromCharCode`. */
function bytesToBase64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

/** The service worker's raster: `createImageBitmap` over the data URL's bytes, an `OffscreenCanvas`, `convertToBlob`. */
export const workerRaster: Raster = {
    decode: async (dataUrl) => {
        const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    },
    canvas: (w, h) => new OffscreenCanvas(w, h) as unknown as RasterCanvas,
    encode: async (c) => {
        const blob = await (c as unknown as OffscreenCanvas).convertToBlob({ type: "image/png" });
        return `data:image/png;base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
    },
};

/**
 * Decode `dataUrl` through `raster`, run `draw` on it, and free the image whatever `draw` does. A decode failure
 * rejects with `loadError`, the sentence each helper has always given for an image it could not load.
 */
export async function withDecoded<T>(raster: Raster, dataUrl: string, loadError: string, draw: (img: RasterImage) => T | Promise<T>): Promise<T> {
    let img: RasterImage;
    try { img = await raster.decode(dataUrl); } catch { throw new Error(loadError); }
    try { return await draw(img); } finally { img.close(); }
}
