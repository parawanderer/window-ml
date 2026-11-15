// chat-transitions.spec.mjs — the calm chat's approve → run → result → fold sequence, sampled on every animation frame, over the
// REAL runtime with a scripted model: a page's `ml.agent` run held at its exec gate and answered from chat.html.
//
// Every fault this guards against was one frame long, which no assertion on a final state can see: the output block appearing
// at once, the result popping in under the code, the step folding in one frame (its close animation was held at `none` by a
// more specific rule), and the transcript letting go of the bottom when the result arrived. So the test reads the layout each
// frame and asserts on its SHAPE: a change in height happens over time, not in a frame; the fold's animation is running while
// it folds; the view is at the bottom throughout.

import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

// Packed (so it is reformatted), mutating (so it is gated), and slow enough that the running output stands for a moment.
const CODE = `let o=[];${Array.from({ length: 16 }, (_, i) => `o.push({k:${i},v:[${i},${i + 1}]});`).join("")}await new Promise(r=>setTimeout(r,700));document.title="held";({code:0,ok:true,list:o.map(String),out:"line one\\nline two"})`;

/**
 * Change runs in a series of heights: each maximal stretch of frames in which the height keeps changing, with how much it
 * changed, how long it took and its biggest single-frame step. A one-frame change is a run of duration 0.
 */
export function runsOf(series, minDelta = 1) {
    const runs = [];
    let cur = null;
    for (let i = 1; i < series.length; i++) {
        const d = series[i].v - series[i - 1].v;
        if (Math.abs(d) >= minDelta) {
            if (!cur || series[i].t - cur.lastT > 60) { cur = { from: series[i - 1].v, to: series[i].v, startT: series[i - 1].t, lastT: series[i].t, maxStep: Math.abs(d) }; runs.push(cur); }
            else { cur.to = series[i].v; cur.lastT = series[i].t; cur.maxStep = Math.max(cur.maxStep, Math.abs(d)); }
        }
    }
    return runs.map((r) => ({ ...r, total: Math.abs(r.to - r.from), duration: r.lastT - r.startT }));
}

test("approving a streamed exec in the calm chat: nothing snaps, the fold animates, and the view stays at the bottom", async () => {
    test.setTimeout(120_000);
    const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 150 });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off", autoApproveReadonly: false });
        fake.setScript([{ tool: "exec", args: { js: CODE }, emit: Array.from({ length: 16 }, () => ({ kind: "call" })) }, { content: "All done, nothing else to report." }]);
        const chat = await ext.context.newPage();
        const errors = [];
        chat.on("pageerror", (e) => errors.push(e.message));
        await chat.setViewportSize({ width: 1100, height: 620 });          // short enough that the step is taller than the view: there is a bottom to hold
        await chat.goto(`chrome-extension://${ext.extensionId}/chat.html`);
        await chat.locator(".chat").waitFor();
        await expect(chat.locator("html[data-calm]")).toHaveCount(1);
        const site1 = await ext.context.newPage();
        await site1.goto(site.url + "/");
        await waitForMl(site1);
        void site1.evaluate(() => window.ml.agent("rename the page", { env: false, approvalRouting: "both", stream: true })).catch(() => {});
        await chat.locator(".chat-row", { hasText: "rename the page" }).click();
        await expect(chat.locator(".astep-approve")).toBeVisible({ timeout: 30_000 });
        await chat.waitForTimeout(900);

        // Every frame from the click: the step's height, the body's animation, and how far the transcript is from its bottom.
        await chat.evaluate(() => {
            window.__frames = [];
            const t0 = performance.now();
            const scroller = (el) => { for (let n = el?.parentElement; n; n = n.parentElement) { const o = getComputedStyle(n).overflowY; if ((o === "auto" || o === "scroll") && n.scrollHeight > n.clientHeight) return n; } return null; };
            const tick = () => {
                const st = document.querySelector(".astep.tool");
                const body = st?.querySelector(".astep-body");
                const sc = scroller(st);
                window.__frames.push({
                    t: performance.now() - t0, step: st ? st.getBoundingClientRect().height : null,
                    closing: !!st?.classList.contains("closing"), anim: body ? getComputedStyle(body).animationName : null,
                    body: body ? body.getBoundingClientRect().height : null, anims: body ? body.getAnimations().map((a) => a.id || a.animationName).join("+") : "", kids: body ? [...body.children].map((c) => `${c.className.toString().split(" ")[0]}:${Math.round(c.getBoundingClientRect().height)}`).join(",") : "",
                    bottom: sc ? sc.scrollHeight - sc.scrollTop - sc.clientHeight : null, scrollable: !!sc,
                });
                if (performance.now() - t0 < 5200) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
        await chat.getByRole("button", { name: /^Approve/ }).first().click();
        await chat.waitForTimeout(5400);
        const frames = await chat.evaluate(() => window.__frames);
        expect(errors).toEqual([]);

        const dump = (extra) => `${extra}\n${frames.map((f) => `${Math.round(f.t)}ms step=${f.step && Math.round(f.step)} closing=${f.closing} anim=${f.anim} body=${f.body && Math.round(f.body)} anims=${f.anims} kids=${f.kids} bottom=${f.bottom && Math.round(f.bottom)}`).join("\n")}`;
        const seen = frames.filter((f) => f.step != null);
        expect(seen.length, dump("the step was never drawn")).toBeGreaterThan(20);

        // 1. A change in the step's height happens over time. A block that snaps in or a fold that snaps shut is a run of one frame.
        const runs = runsOf(seen.map((f) => ({ t: f.t, v: f.step })), 1).filter((r) => r.total > 24);
        expect(runs.length, dump("the sequence changed the step's height at least once (the result, the fold)")).toBeGreaterThan(0);
        for (const r of runs) {
            expect(r.duration, dump(`a ${Math.round(r.total)}px change in the step's height took ${Math.round(r.duration)}ms: it snapped (${Math.round(r.from)} → ${Math.round(r.to)})`)).toBeGreaterThanOrEqual(100);
            expect(r.maxStep, dump(`one frame moved ${Math.round(r.maxStep)}px of a ${Math.round(r.total)}px change`)).toBeLessThanOrEqual(r.total * 0.45);
        }

        // 2. The fold is an ANIMATION while it folds. It was held at `none` by a rule more specific than its own.
        const closingFrames = frames.filter((f) => f.closing);
        expect(closingFrames.length, dump("the step never folded")).toBeGreaterThan(0);
        expect(closingFrames.every((f) => f.anim && f.anim !== "none"), dump("the step folded with no animation on its body")).toBe(true);

        // 3. It folds AFTER the result has been on screen for a moment, not in the render the result arrives in.
        const firstClose = closingFrames[0].t;
        expect(firstClose, dump("the step folded the instant it settled")).toBeGreaterThan(500);

        // 4. The transcript follows its bottom. It may trail a growing block by a glide's worth for a few frames; what the fault was
        // is LETTING GO of it, which leaves the view stranded off the bottom for good.
        const scrollable = frames.filter((f) => f.scrollable && f.bottom != null);
        expect(scrollable.length, dump("the transcript was never taller than its view, so there was no bottom to hold")).toBeGreaterThan(20);
        let longest = 0, since = null;
        for (const f of scrollable) { if (f.bottom > 90) { since ??= f.t; longest = Math.max(longest, f.t - since); } else since = null; }
        expect(longest, dump(`the view was more than 90px off the bottom for ${Math.round(longest)}ms at a stretch`)).toBeLessThanOrEqual(250);
        const tail = scrollable.slice(-10);
        expect(tail.every((f) => f.bottom <= 2), dump("the view did not end at the bottom")).toBe(true);
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});
