// palette.ts — THE COLOUR A NAME GETS, and the palettes it comes from: the one choice ("Colour palette") behind
// every surface that identifies something by colour.
//
// Split out of panel-state.ts, which is the resource panel's state and reads `chrome.storage.local` for the
// chart layout. None of this needs a browser — the palettes are data and the two pickers are pure — and the
// moment a log wanted the same colours (`TimedOutput`'s `groups`, run-log-view.tsx), importing them dragged a
// `chrome.*` reference into the chat page's bundle, which that build refuses outright.
//
// Two rules, and which one applies is about what is being coloured: a NAME is hashed (`colorFor`), because the
// set is open and a model must keep its colour whoever else shows up; an ORDERED SET is assigned by position
// (`poolColor`), because then distinct colours are free and a collision is just a bug.
import { signal } from "@preact/signals";

/**
 * The palettes a model's colour can come from. A model's colour is its identity across the whole panel — the
 * line, the band, the row, its lane blocks, its ticks on the strip — so this is a real preference rather
 * than decoration: which eight hues read as distinct depends on the display, the theme and the eyes.
 *
 * `grafana` is the classic dashboard palette, which is what a lot of people are already reading GPU graphs
 * in; `warm`/`cool` narrow the range for a panel sitting beside other colour; `vivid` is the original.
 * Every palette is eight long, because the assignment hashes a name into it and a shorter one collides more.
 */
export const VRAM_PALETTES: Record<string, string[]> = {
    vivid:   ["#6366f1", "#22c55e", "#f59e0b", "#ec4899", "#06b6d4", "#a855f7", "#ef4444", "#84cc16"],
    grafana: ["#7EB26D", "#EAB839", "#6ED0E0", "#EF843C", "#E24D42", "#1F78C1", "#BA43A9", "#705DA0"],
    cool:    ["#4C78A8", "#54A24B", "#72B7B2", "#B279A2", "#439894", "#5C7EC1", "#83B4D8", "#3F8F7A"],
    warm:    ["#E45756", "#F58518", "#EECA3B", "#B279A2", "#D67195", "#C4693D", "#E7955A", "#B4451F"],
};

/** Which one is in use, for every surface that colours something by its name. The stored key is still
 *  `ml_vram_palette`: renaming it would reset a choice every existing install has already made, and a storage
 *  key is not a label. A sidebar-only display pref in `chrome.storage.local`, like the font scale and the
 *  code-block prefs — it changes how the panel LOOKS, not what the extension does, so it has no business in
 *  the synced `MlConfig`. */
export const vramPalette = signal<string>("vivid");

/** THE COLOUR FOR A NAME: hashed into the chosen palette, so it is stable for as long as the thing is called
 *  the same and identical on every surface that draws it. Named for models, which is what it coloured first,
 *  but it is not about them — a log's groups are coloured with it too (TimedOutput's `groups`), which is why
 *  the setting is "Colour palette" rather than "Model colours". */
export const colorFor = (name: string) => {
    const p = VRAM_PALETTES[vramPalette.value] ?? VRAM_PALETTES.vivid;
    return p[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % p.length];
};

/** A POOL's colour. Pools are an ordered set, not names to hash, so they get distinct colours by construction
 *  — which `VRAM_COLORS[i % 8]` stopped doing on a box with more than eight pools: an 8-GPU node (eight cards
 *  plus system RAM) gave card 0 and System RAM the same indigo, in a legend whose entire job is telling the
 *  lines apart. Past the curated palette, hues are spread evenly over however many pools there are. */
export function poolColor(i: number, count: number): string {
    const pal = VRAM_PALETTES[vramPalette.value] ?? VRAM_PALETTES.vivid;
    if (count <= pal.length) return pal[i % pal.length];
    // Golden-angle-free even spread: with the count known, evenly spaced hues are maximally far apart, and
    // fixed saturation/lightness keeps them legible on both themes.
    return `hsl(${Math.round((i * 360) / count)}deg 70% 55%)`;
}

export const VRAM_PALETTE_KEY = "ml_vram_palette";   // storage.local: which colour palette names the models

export const VRAM_COLORS = VRAM_PALETTES.vivid;   // the default palette — a model keeps its colour for as long as it is DRAWN, not just while resident
