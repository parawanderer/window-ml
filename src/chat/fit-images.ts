// fit-images.ts — shrink the images of a command until it fits the hub's per-message limit.

// The hub relay closes the whole connection on a payload over its limit (about 1 MB), and a photo as a data URL is
// 1 to 3 MB. A command that goes over the hub is therefore sent with its images re-encoded smaller when it would not
// fit; one that already fits is never touched. The encoder is a `Raster` (src/raster.ts), so this runs the same in a
// page and, with a fake raster, in node.
import type { Raster } from "../raster";

/** Longest side, in pixels, tried in turn: each step is a smaller copy of the ORIGINAL, never of the last copy. */
export const FIT_SIDES = [2048, 1600, 1280, 1024, 768, 512] as const;
/** JPEG quality of a smaller copy. */
export const FIT_QUALITY = 0.85;

/** The result of fitting: the images to send, and how many of them are smaller copies. */
export interface Fitted { images: string[]; shrunk: number }

/**
 * Re-encode the largest of `images` as JPEG, at a shrinking longest side, until their data URLs total at most
 * `budget` characters. Returns null when even the smallest step does not fit, or an image will not decode.
 * An image that is already small enough in its turn is left as it is; a copy is only used when it is smaller.
 */
export async function fitImages(images: readonly string[], budget: number, raster: Raster, sides: readonly number[] = FIT_SIDES): Promise<Fitted | null> {
    const total = (xs: readonly string[]): number => xs.reduce((n, x) => n + x.length, 0);
    if (total(images) <= budget) return { images: [...images], shrunk: 0 };
    const out = [...images];
    const changed = new Set<number>();
    try {
        for (const side of sides) {
            // Largest first, and stop at the first image that makes the whole fit: the rest keep their original bytes.
            const order = out.map((_, i) => i).sort((a, b) => out[b].length - out[a].length);
            for (const i of order) {
                const copy = await shrink(images[i], side, raster);
                if (copy && copy.length < out[i].length) { out[i] = copy; changed.add(i); }
                if (total(out) <= budget) return { images: out, shrunk: changed.size };
            }
        }
    } catch { return null; }
    return null;
}

/** One image as a JPEG whose longest side is at most `side`. Never enlarged. */
async function shrink(dataUrl: string, side: number, raster: Raster): Promise<string | null> {
    const img = await raster.decode(dataUrl);
    try {
        const scale = Math.min(1, side / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
        const canvas = raster.canvas(w, h);
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        // JPEG has no alpha: a transparent PNG would turn black.
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img.source, 0, 0, w, h);
        return await raster.encode(canvas, { type: "image/jpeg", quality: FIT_QUALITY });
    } finally { img.close(); }
}
