// tip-contrast.spec.mjs — EVERY LINE OF A TOOLTIP IS READABLE, in every palette. The chart's tooltip was a mid-grey fill
// with its secondary lines in the faint tone, near 2:1, and nothing noticed because every test read its TEXT. This one
// reads its COLOURS: the real stylesheets, a tooltip built from the classes the chart and the anchored layer use, and
// each piece of text's own colour (its opacity included) against the fill, held to WCAG AA for small text (4.5:1).
//
// No extension, no build: a page with the two stylesheets, so it runs in a second.
import { test, expect } from "@playwright/test";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

// `TIP_CSS` points at another copy of sidebar.css, for checking that the test fails on the stylesheet it replaced.
const CSS = readFileSync(process.env.TIP_CSS || "src/sidebar/sidebar.css", "utf8") + readFileSync("src/chat/chat.css", "utf8");

// One of each kind of line a tip draws: the pool tip, the model tip's stamp and keys, an event tip's note and chips,
// and the anchored layer (`.tt-layer` is the surface itself; a `.tt-pop` is only the hidden source it copies).
const TIPS = `
<div class="rc-tip rc-tip-pool" role="tooltip" style="position:static">
  <div class="rc-tip-line"><span class="rc-tip-name">CUDA0</span><span class="rc-tip-size">43.34 GiB in use (45%)</span></div>
  <div class="rc-tip-line rc-tip-of">out of 95.59 GiB</div>
  <div class="rc-tip-when"><span>15:19:30.074</span><span class="rc-tip-ago">11m 41s ago</span></div>
  <div class="rc-tip-line rc-tip-dim rc-tip-holders"><span class="rc-tip-consumer"><i class="rc-tip-dot"></i>gemma4:31b</span></div>
  <div class="rc-tip-line rc-tip-dim rc-tip-holders"><span class="rc-tip-consumer"><i class="rc-tip-dot"></i>outside ollama's view 10.75 MiB</span></div>
  <div class="rc-tip-line rc-tip-keys"><span><kbd>↑↓</kbd> pick a model</span><span class="rc-tip-pct">45%</span></div>
</div>
<div class="rc-tip rc-tip-event" role="tooltip" style="position:static">
  <div class="rc-tip-line"><span class="rc-tip-name">exec</span><span class="rc-tip-size">1.2 s</span></div>
  <div class="rc-tip-note">ran in the page, waited on nothing</div>
</div>
<div class="tt-layer" style="position:static">Explained <code>here</code><span class="rc-tip-note"> and dim here</span></div>`;

/** Each text-bearing element's contrast against its tooltip's fill; the lowest few, worst first. */
async function contrasts(page) {
    return page.evaluate(() => {
        const parse = (c) => {
            const m = c.match(/color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)/);
            if (m) return [m[1] * 255, m[2] * 255, m[3] * 255, m[4] == null ? 1 : +m[4]];
            const r = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
            if (r) return [+r[1], +r[2], +r[3], r[4] == null ? 1 : +r[4]];
            throw new Error(`unparsed colour ${c}`);
        };
        const lum = ([r, g, b]) => {
            const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const out = [];
        for (const tip of document.querySelectorAll(".rc-tip, .tt-layer")) {
            const bg = parse(getComputedStyle(tip).backgroundColor);
            if (bg[3] < 1) throw new Error(`a tooltip fill is see-through (${getComputedStyle(tip).backgroundColor})`);
            for (const el of [tip, ...tip.querySelectorAll("*")]) {
                const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
                if (!own) continue;
                let alpha = 1;
                for (let e = el; e && e !== tip.parentElement; e = e.parentElement) alpha *= +getComputedStyle(e).opacity;
                const fg = parse(getComputedStyle(el).color);
                const a = fg[3] * alpha;
                const seen = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
                const [hi, lo] = [lum(seen), lum(bg)].sort((x, y) => y - x);
                out.push({ text: el.textContent.trim().slice(0, 40), cls: el.className, ratio: +((hi + 0.05) / (lo + 0.05)).toFixed(2) });
            }
        }
        return out.sort((x, y) => x.ratio - y.ratio);
    });
}

const PALETTES = [
    { name: "panel, dark", theme: "dark", calm: false },
    { name: "panel, light", theme: "light", calm: false },
    { name: "calm view, dark", theme: "dark", calm: true },
    { name: "calm view, light", theme: "light", calm: true },
];

for (const p of PALETTES) {
    test(`every line of a tooltip reads at 4.5:1 or better against its fill (${p.name})`, async () => {
        const browser = await chromium.launch({ channel: "chromium" });
        try {
            const page = await browser.newPage();
            const body = p.calm ? `<div class="chat calm">${TIPS}</div>` : TIPS;
            await page.setContent(`<!doctype html><html data-theme="${p.theme}"${p.calm ? " data-focus" : ""}><head><style>${CSS}</style></head><body>${body}</body></html>`);
            const all = await contrasts(page);
            expect(all.length, "the probe found the tooltip's text").toBeGreaterThan(8);
            const low = all.filter((c) => c.ratio < 4.5);
            expect(low, `lines under 4.5:1: ${JSON.stringify(low)}`).toEqual([]);
        } finally {
            await browser.close();
        }
    });
}
