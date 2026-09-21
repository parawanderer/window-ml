// image-budget.ts — HOW MUCH IMAGE A MESSAGE MAY CARRY over the hub: the budget, the shrink steps and the arithmetic
// attach.ts runs them with. Pure, so it is tested without a phone (tests/mobile-attach.test.mjs).

/** Every image of one message together, as data-URL characters: what leaves room in a 1 MiB sealed command. */
export const IMAGE_BUDGET = 640_000;
/** The most images one message carries. */
export const MAX_IMAGES = 4;
/** Each try at shrinking an image, in order: the longest edge in pixels and the JPEG quality. The first is what a
 *  vision model reads at full detail; the later ones trade detail for size. */
export const SHRINK_STEPS: readonly { edge: number; quality: number }[] = [
    { edge: 1568, quality: 0.72 },
    { edge: 1280, quality: 0.6 },
    { edge: 1024, quality: 0.5 },
    { edge: 768, quality: 0.45 },
];

/** How many data-URL characters are left for more images, given the ones already attached. */
export function roomLeft(images: readonly string[]): number {
    return Math.max(0, IMAGE_BUDGET - images.reduce((n, i) => n + i.length, 0));
}

/** The size one new image may take: an even share of what is left among the images still to come, so the first
 *  of several cannot take the whole budget. */
export function shareFor(images: readonly string[], coming: number): number {
    return Math.floor(roomLeft(images) / Math.max(1, coming));
}

/** The size a resize to `edge` gives, keeping the aspect: never larger than the original. */
export function fitEdge(width: number, height: number, edge: number): { width: number; height: number } {
    const long = Math.max(width, height);
    if (long <= edge) return { width, height };
    const k = edge / long;
    return { width: Math.round(width * k), height: Math.round(height * k) };
}
