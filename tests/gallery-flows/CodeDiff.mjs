// CodeDiff.mjs — the gallery flow behind CodeDiff's `@gallery-flow` (src/sidebar/transcript/render-panel.tsx). It opens the
// maximised view in the shared modal, hovers the close button so its tip shows (it must draw ABOVE the modal), shoots,
// then switches the view inside the modal and checks the inline block followed.

export default async ({ page, tile, shot }) => {
    // The page is shared with the flows that run after this one: give back the viewport, close the card and take the tip layer down.
    const viewport = page.viewportSize();
    // The gallery prints only the FIRST line of a flow's error (scripts/gallery.mjs), and a `waitFor` timeout carries none of the
    // page it timed out on: the state that matters — where the tile is, whether the card exists and is visible, whether the tip
    // layer is up, and what the page SAW of the pointer — goes in that line.
    const probe = async (why) => new Error(`${why}; ${await page.evaluate(() => {
        const rect = (e) => (e ? ["x", "y", "width", "height"].map((k, i) => Math.round(e.getBoundingClientRect()[k])).join(",") : "none");
        const sel = document.querySelector(".gl-tile.sel"), rm = [...document.querySelectorAll(".r-max")];
        const layer = document.getElementById("gl-tip-layer"), close = document.querySelector(".r-max-head button[aria-label=Close]");
        return `tile=${rect(sel)} frame=${rect(sel?.querySelector(".gl-frame"))} dialogs=${document.querySelectorAll(".chat-dialog-back").length} rmax=${rm.length} [${rm.map((e) => { const r = e.getBoundingClientRect(); return `${rect(e)}:${r.width > 0 && r.height > 0 ? "shown" : "hidden"}`; }).join(" ")}] close=${document.querySelectorAll(".r-max-head button[aria-label=Close]").length} tips=${document.querySelectorAll(".cursor-tip").length} layer=${layer ? `+${layer.childElementCount}` : "none"} closeVis=${close ? (close.checkVisibility ? close.checkVisibility() : "?") : "gone"} scrollY=${Math.round(scrollY)} vp=${innerWidth}x${innerHeight} saw=[${(window.__tip ?? []).map((e) => `${Math.round(e.t)}ms ${e.text}${e.n > 1 ? ` ×${e.n}` : ""}`).join(" | ")}]`;
    })}`);
    try {
        await page.evaluate(() => globalThis.__gallery.mountTipLayer());
        await page.setViewportSize({ width: 1000, height: 640 });
        // WHAT THE PAGE SAW OF THE TIP. The tip can leave four ways — a pointer-leave, a scroll anywhere under this document,
        // a window blur, or its trigger being unmounted or hidden (tooltip-layer.ts `watchTrigger`) — and it can be never
        // raised at all. The probe above cannot tell those apart, so record them: every pointer event that reaches the Close
        // button, every scroll and blur, and every change in the number of `.cursor-tip`s in the document. Consecutive
        // duplicates are collapsed (a hover is dozens of pointermoves).
        await page.evaluate(() => {
            const seen = (window.__tip = []);
            const t0 = performance.now();
            const note = (text) => {
                const last = seen[seen.length - 1];
                if (last && last.text === text) { last.n++; last.t = performance.now() - t0; return; }
                seen.push({ t: performance.now() - t0, text, n: 1 });
                if (seen.length > 20) seen.shift();
            };
            window.__note = note;
            const onClose = (e) => e.composedPath?.().some((n) => n?.getAttribute?.("aria-label") === "Close");
            for (const type of ["pointerover", "pointermove", "pointerleave", "pointerout"]) {
                document.addEventListener(type, (e) => { if (onClose(e)) note(`${type} on Close`); }, true);
            }
            document.addEventListener("scroll", (e) => note(`scroll ${e.target?.nodeName ?? "?"}.${String(e.target?.className ?? "")}`), true);
            addEventListener("blur", () => note("window blur"));
            let up = 0;
            new MutationObserver(() => {
                const n = document.querySelectorAll(".cursor-tip").length;
                if (n !== up) { up = n; note(`cursor-tip x${n}${document.getElementById("gl-tip-layer") ? "" : " (layer gone)"}`); }
            }).observe(document.body, { childList: true, subtree: true });
        });
        await tile.locator(".r-diff-max").click();
        try { await page.locator(".r-max").waitFor({ timeout: 5_000 }); } catch { throw await probe("no visible .r-max after the maximise click"); }
        await page.evaluate(() => window.__note?.("hover"));
        await page.locator(".r-max-head button[aria-label=Close]").hover();
        try { await page.locator(".cursor-tip").waitFor({ timeout: 5_000 }); } catch { throw await probe("no .cursor-tip after hovering Close"); }
        await shot("maximised, close tip");
        if (process.env.CODEDIFF_SHOTS) await page.screenshot({ path: `${process.env.CODEDIFF_SHOTS}-maximised.png` });
        const tipAbove = await page.evaluate(() => {
            const tip = document.querySelector(".cursor-tip"), back = document.querySelector(".chat-dialog-back");
            return Number(getComputedStyle(tip).zIndex) > Number(getComputedStyle(back).zIndex);
        });
        if (!tipAbove) throw new Error("the tip is not above the modal");
        const top = await page.evaluate(() => document.querySelector(".r-max-head").getBoundingClientRect().top - document.querySelector(".chat-dialog").getBoundingClientRect().top);
        if (top > 20) throw new Error(`the title row sits ${top}px below the modal's top`);
        await page.locator(".r-max-head .r-diff-segbtn", { hasText: "code" }).click();
        if (await page.locator(".r-max-head .r-diff-segbtn.on").innerText() !== "code") throw new Error("the modal's switch did not change view");
        await shot("switched to code in the modal");
        if (process.env.CODEDIFF_SHOTS) await page.screenshot({ path: `${process.env.CODEDIFF_SHOTS}-switched.png` });
    } finally {
        if (viewport) await page.setViewportSize(viewport);
        if (await page.locator(".chat-dialog-back").count()) {
            await page.keyboard.press("Escape");
            await page.locator(".chat-dialog-back").waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
        }
        await page.evaluate(() => globalThis.__gallery.unmountTipLayer());
    }
};
