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
import { runsOf } from "./frame-runs.mjs";

// Packed (so it is reformatted), mutating (so it is gated), and slow enough that the running output stands for a moment.
const CODE = `let o=[];${Array.from({ length: 16 }, (_, i) => `o.push({k:${i},v:[${i},${i + 1}]});`).join("")}await new Promise(r=>setTimeout(r,700));document.title="held";({code:0,ok:true,list:o.map(String),out:"line one\\nline two"})`;

// --- approve, run, result, fold ---

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
        // Settled: the step's own opening (its height ramping up as the code takes its place) is not the sequence under test, and on a
        // slower runner it is still going a second later. Wait for the height to hold still for half a second.
        let still = 0, prev = -1;
        for (let i = 0; i < 150 && still < 5; i++) {
            await chat.waitForTimeout(100);
            const hh = await chat.evaluate(() => document.querySelector(".astep.tool")?.getBoundingClientRect().height ?? -1);
            still = Math.abs(hh - prev) < 1 && hh > 0 ? still + 1 : 0;
            prev = hh;
        }
        expect(still, "the step's height never settled before the approval").toBeGreaterThanOrEqual(5);

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
        const runs = runsOf(seen.map((f) => ({ t: f.t, v: f.step })), 1).filter((r) => r.total > 60);   // a small change on a slow machine lands in a frame or two: not a snap
        expect(runs.length, dump("the sequence changed the step's height at least once (the result, the fold)")).toBeGreaterThan(0);
        for (const r of runs) {
            expect(r.duration, dump(`a ${Math.round(r.total)}px change in the step's height took ${Math.round(r.duration)}ms: it snapped (${Math.round(r.from)} → ${Math.round(r.to)})`)).toBeGreaterThanOrEqual(60);
            expect(r.maxStep, dump(`one frame moved ${Math.round(r.maxStep)}px of a ${Math.round(r.total)}px change`)).toBeLessThanOrEqual(r.total * 0.7);
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

        // 5. Unfurling the folded step again eases open. A step that had taken over from a live call kept the "hold the open animation
        // still" state past its fold, and the next unfurl played no animation at all while every other step eased.
        // Folded and still: the fold takes the calm view's collapse beat after the settle dwell, later on a slow machine, and a click on
        // a step still folding closes it instead of opening it.
        await chat.waitForFunction(() => { const st = document.querySelector(".astep.tool"); return !!st && !st.classList.contains("open") && !st.classList.contains("closing") && st.getBoundingClientRect().height < 80; }, null, { timeout: 15000 });
        await chat.waitForTimeout(150);
        await chat.evaluate(() => {
            window.__g = [];
            const t0 = performance.now();
            const tick = () => { const st = document.querySelector(".astep.tool"); window.__g.push({ t: performance.now() - t0, v: st ? st.getBoundingClientRect().height : null }); if (performance.now() - t0 < 800) requestAnimationFrame(tick); };
            requestAnimationFrame(tick);
        });
        const before = await chat.evaluate(() => { const st = document.querySelector(".astep.tool"); return `${st?.className} h=${Math.round(st?.getBoundingClientRect().height ?? -1)}`; });
        await chat.locator(".astep.tool .astep-head").first().click();
        await chat.waitForTimeout(1000);
        const after = await chat.evaluate(() => { const st = document.querySelector(".astep.tool"); return `${st?.className} h=${Math.round(st?.getBoundingClientRect().height ?? -1)}`; });
        const g = (await chat.evaluate(() => window.__g)).filter((x) => x.v != null).map((x) => ({ t: x.t, v: x.v }));
        const opened = runsOf(g, 1).filter((r) => r.total > 24);
        expect(opened.length, `the step did not open when its head was clicked. Before the click: ${before}. After: ${after}. Heights from the click: ${g.map((x) => `${Math.round(x.t)}ms:${Math.round(x.v)}`).join(" ")}`).toBeGreaterThan(0);
        for (const r of opened) {
            expect(r.duration, `unfurling: a ${Math.round(r.total)}px change took ${Math.round(r.duration)}ms, it snapped open (${Math.round(r.from)} → ${Math.round(r.to)})`).toBeGreaterThanOrEqual(60);
            expect(r.maxStep, "unfurling: one frame moved most of the change").toBeLessThanOrEqual(r.total * 0.7);
        }
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});

// --- two execs in a row: one that needs no approval, then one that does ---

const FREE = `let a=[];${Array.from({ length: 10 }, (_, i) => `a.push(document.title.length+${i});`).join("")}a.length`;
const GATED = `let o=[];${Array.from({ length: 12 }, (_, i) => `o.push({k:${i},v:[${i},${i + 1}]});`).join("")}document.title="held";o.length`;

test("an exec that needs no approval, then one that does: the second stream replaces the first at once, its step is never drawn beside a live block, and its code flies", async () => {
    test.setTimeout(120_000);
    const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 120 });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        fake.setScript([
            { tool: "exec", args: { js: FREE }, emit: Array.from({ length: 10 }, () => ({ kind: "call" })) },
            { tool: "exec", args: { js: GATED }, emit: Array.from({ length: 12 }, () => ({ kind: "call" })) },
            { content: "done." }]);
        const chat = await ext.context.newPage();
        const errors = [];
        chat.on("pageerror", (e) => errors.push(e.message));
        await chat.setViewportSize({ width: 1100, height: 760 });
        await chat.goto(`chrome-extension://${ext.extensionId}/chat.html`);
        await chat.locator(".chat").waitFor();
        await chat.evaluate(() => {
            window.__flew = 0;
            new MutationObserver(() => { if (document.querySelector(".code-morph")) window.__flew++; }).observe(document.body, { childList: true, subtree: true });
            window.__f = [];
            const t0 = performance.now();
            const tick = () => {
                const live = document.querySelector(".live-call");
                window.__f.push({
                    t: performance.now() - t0, live: live ? live.getBoundingClientRect().height : null, liveCount: document.querySelectorAll(".live-call").length,
                    opening: !!document.querySelector(".astep.tool.open.pending.awaiting"), liveAlso: !!live,
                    leaving: !!document.querySelector(".live-leaving"), card: !!document.querySelector(".astep-approve"),
                });
                if (performance.now() - t0 < 13000) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
        const site1 = await ext.context.newPage();
        await site1.goto(site.url + "/");
        await waitForMl(site1);
        void site1.evaluate(() => window.ml.agent("do two things", { env: false, approvalRouting: "both", stream: true })).catch(() => {});
        await chat.locator(".chat-row", { hasText: "do two things" }).click();
        await expect(chat.locator(".astep-approve")).toBeVisible({ timeout: 30_000 });
        await chat.waitForTimeout(1500);
        const f = await chat.evaluate(() => window.__f);
        expect(errors).toEqual([]);
        const dump = (m) => `${m}\n${f.filter((_, i) => i % 3 === 0).map((r) => `${Math.round(r.t)}ms live=${r.live && Math.round(r.live)} leaving=${r.leaving} opening=${r.opening} card=${r.card}`).join("\n")}`;

        // The step that is opening for approval never stands beside a live block: it draws after the block has gone.
        expect(f.filter((r) => r.opening && r.liveAlso).length, dump("the opening step was drawn while a live block was still on the page")).toBe(0);
        // The second call displaces the first's held block: it is replaced at once, not left standing (or folding) over the new
        // call's stream. At most one live block is ever on the page.
        expect(f.every((r) => r.liveCount <= 1), dump("two live blocks stood on the page at once")).toBe(true);
        // The second call's code flies into its approval step.
        expect(await chat.evaluate(() => window.__flew > 0), dump("the gated call's code did not fly")).toBe(true);
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});

// --- a held call that needs no approval folds away ---

test("a quickly written exec that needs no approval: its held block folds away smoothly instead of vanishing", async () => {
    test.setTimeout(120_000);
    const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 40 });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        // The reply is slow to start, so nothing displaces the held block while it stands and folds.
        // The call starts being written after a pause, so the session is open in the page before it does (a slow runner opened it after the whole call had been written).
        fake.setScript([{ tool: "exec", args: { js: FREE }, emit: [{ kind: "pause", ms: 2500 }, ...Array.from({ length: 10 }, () => ({ kind: "call" }))] }, { content: "done.", emit: [{ kind: "pause", ms: 4000 }, { kind: "answer", text: "done." }] }]);
        const chat = await ext.context.newPage();
        await chat.setViewportSize({ width: 1100, height: 760 });
        await chat.goto(`chrome-extension://${ext.extensionId}/chat.html`);
        await chat.locator(".chat").waitFor();
        await chat.evaluate(() => {
            window.__f = [];
            const t0 = performance.now();
            const tick = () => {
                const live = document.querySelector(".live-call");
                const box = document.querySelector(".live-hold");   // the wrapper is what folds
                window.__f.push({ t: performance.now() - t0, live: live && box ? box.getBoundingClientRect().height : null, leaving: !!document.querySelector(".live-leaving") });
                if (performance.now() - t0 < 6000) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
        const site1 = await ext.context.newPage();
        await site1.goto(site.url + "/");
        await waitForMl(site1);
        void site1.evaluate(() => window.ml.agent("read the title", { env: false, approvalRouting: "both", stream: true })).catch(() => {});
        await chat.locator(".chat-row", { hasText: "read the title" }).click();
        await chat.waitForTimeout(6200);
        const f = await chat.evaluate(() => window.__f);
        const dump = (m) => `${m}\n${f.filter((_, i) => i % 3 === 0).map((r) => `${Math.round(r.t)}ms live=${r.live && Math.round(r.live)} leaving=${r.leaving}`).join("\n")}`;
        const shown = f.filter((r) => r.live != null);
        expect(shown.length, dump("no live block was ever drawn")).toBeGreaterThan(10);
        // Stood at least the minimum, then folded: the height falls over time to nothing, in more than a frame or two.
        const folding = f.filter((r) => r.leaving && r.live != null);
        expect(folding.length, dump("the held block never folded")).toBeGreaterThanOrEqual(4);
        for (let i = 1; i < folding.length; i++) expect(folding[i].live, dump("the folding block grew")).toBeLessThanOrEqual(folding[i - 1].live + 1);
        expect(folding[0].live - folding[folding.length - 1].live, dump("it did not shrink while it folded")).toBeGreaterThan(20);
        expect(shown[shown.length - 1].t - shown[0].t, dump("the block stood less than the minimum")).toBeGreaterThanOrEqual(1000);
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});
