// FilterChips.mjs — the gallery flow behind FilterChips' `@gallery-flow` (src/sidebar/filter-chips.tsx). It measures the
// gap between each chip's label and its count: a chip with a tip is a `.tt`, an inline-flex, which once dropped the
// space between them (`evict3`), and only a layout engine shows that, so jsdom tests cannot.

export default async ({ tile, shot }) => {
    await tile.locator(".rc-lane-chip").first().waitFor({ timeout: 5_000 });
    const gaps = await tile.locator(".rc-lane-chip").evaluateAll((chips) => chips.flatMap((chip) => {
        const n = chip.querySelector(".rc-chip-n");
        if (!n) return [];
        const before = document.createRange();
        before.setStart(chip, 0);
        before.setEndBefore(n.previousSibling ?? n);   // the label alone: stop before the space, not after it
        return [{ chip: chip.textContent, tipped: chip.classList.contains("tt"), gap: n.getBoundingClientRect().left - before.getBoundingClientRect().right }];
    }));
    if (!gaps.some((g) => g.tipped)) throw new Error("no chip with a tip rendered, so the flow checks nothing");
    const tight = gaps.filter((g) => g.gap < 2);
    if (tight.length) throw new Error(`no space before the count: ${tight.map((g) => JSON.stringify(g)).join(", ")}`);
    await shot("spaced");
};
