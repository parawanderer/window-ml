// chat-two-execs.spec.mjs — a turn that writes TWO gated execs side by side, in the calm chat, sampled on every animation frame.
//
// The cells a model writes stay where they are drawn: each one that needs an approval gains its card in place, and once it is
// decided it folds and settles while the next cell gets its card. Every fault guarded here was a frame or two long: the second cell
// vanishing when the first one's step landed and sliding back in from nothing, the side rail missing from the cell that was
// waiting, a second "thinking" row while the live one was still drawn, and the code of a decided cell vanishing in a frame.

import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";
import { runsOf } from "./frame-runs.mjs";

const pack = (tag) => `let o=[];${Array.from({ length: 14 }, (_, i) => `o.push({k:${i},v:[${i},${i + 1}]});`).join("")}document.title="${tag}";({n:o.length,tag:"${tag}"})`;

// --- two gated execs in one turn ---

test("two gated execs in one turn: both cells stay drawn, keep their rail, and fold in place as each is approved", async () => {
    test.setTimeout(150_000);
    const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 110 });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off", autoApproveReadonly: false });
        fake.setScript([
            { reasoning: "I will read the page title and then count the rows on it.", tools: [{ tool: "exec", args: { js: pack("one") } }, { tool: "exec", args: { js: pack("two") } }], emit: [{ kind: "think", text: "I will read the page title " }, { kind: "think", text: "and then count the rows on it." }, ...Array.from({ length: 12 }, () => ({ kind: "call" }))] },
            { content: "Both ran." }]);
        const chat = await ext.context.newPage();
        const errors = [];
        chat.on("pageerror", (e) => errors.push(e.message));
        await chat.setViewportSize({ width: 1100, height: 760 });
        await chat.goto(`chrome-extension://${ext.extensionId}/chat.html`);
        await chat.locator(".chat").waitFor();
        await chat.evaluate(() => {
            window.__f = [];
            // The animations are PAUSED AND SEEKED, not left to the frame rate. A loaded runner draws frames 100-700 ms apart,
            // which is most or all of a 260 ms fade: sampled in real time, a product that eased exactly as designed reads as
            // drawn-then-gone, which is the failure this spec was seeing on CI. A paused CSS animation can be placed at any
            // fraction of its duration and the page re-renders there at once, so the curve itself is read.
            window.__seek = { fade: null, size: [] };
            // What can move the measured box: the properties the calm chat's own animations drive (chat.css — `chat-ask-in`'s
            // height, margins and padding; the step's open and handoff sizes). An OPACITY-only animation excuses nothing, however
            // long it runs: it moves no pixel of the cell's height.
            const SIZED = new Set(["height", "max-height", "min-height", "grid-template-rows", "margin-top", "margin-bottom", "padding-top", "padding-bottom", "top", "bottom", "inset", "transform", "translate", "scale"]);
            const kebab = (k) => k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
            /** the properties an animation moves: a transition names one, a keyframe animation carries them in its keyframes */
            const propsOf = (a) => a.transitionProperty ? [a.transitionProperty] : (a.effect?.getKeyframes?.() ?? []).flatMap((k) => Object.keys(k).map(kebab));
            const sized = (el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === "running" && propsOf(a).some((p) => SIZED.has(p)));
            /** pause an animation, read `value()` at 10…90% of its duration, then put it back exactly where it was */
            const seek = (label, a, value) => {
                const dur = Number(a.effect.getTiming().duration);
                if (!(dur > 0)) return null;
                const was = Number(a.currentTime) || 0;
                const pts = [];
                a.pause();
                try { for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) { a.currentTime = f * dur; pts.push([f, value()]); } }
                finally { a.currentTime = was; a.play(); }
                return { name: typeof a.animationName === "string" ? a.animationName : (a.transitionProperty ?? label), dur, pts };
            };
            const sought = new Set();
            const tok = (el, name) => +(getComputedStyle(el).getPropertyValue(name).trim() || 0);
            const t0 = performance.now();
            const tick = () => {
                const cells = [...document.querySelectorAll(".live-call, .astep.tool")].map((el) => {
                    const body = el.querySelector(".astep-body");
                    const path = []; for (let n = el.parentElement; n && path.length < 4; n = n.parentElement) path.push(n.className.toString().split(" ")[0]);
                    // Every size animation that starts in this cell is seeked once, reading the CELL's height at each point: that is
                    // the box the assertion below measures, and the curve the product draws it with.
                    const anims = sized(el);
                    for (const a of anims) if (!sought.has(a)) { sought.add(a); const s = seek("size", a, () => Math.round(el.getBoundingClientRect().height)); if (s) window.__seek.size.push({ cell: el.className, calm: tok(el, "--calm-reflow-ms"), ...s }); }
                    return { path: path.join("<"), cls: el.className.replace(/astep|tool|pending/g, "").trim(), live: el.classList.contains("live-call"), h: Math.round(el.getBoundingClientRect().height), open: el.classList.contains("open"), rail: !!body?.querySelector(".fold-rail"), card: !!el.querySelector(".astep-approve"), dot: el.querySelector(".dot")?.className ?? "", sz: anims.length };
                });
                const w = document.querySelector(".live-call .astep-preview.written");
                if (w && !window.__seek.fade) {
                    const tr = w.getAnimations().find((a) => a.transitionProperty === "opacity");
                    const s = tr && seek("opacity", tr, () => +parseFloat(getComputedStyle(w).opacity).toFixed(3));
                    if (s) window.__seek.fade = { calm: tok(w, "--calm-flow-ms"), ...s };
                }
                window.__f.push({
                    grouped: !!document.querySelector(".astreak"), bar: !!document.querySelector(".chat-waiting"), cardSeen: (() => { const c = document.querySelector(".astep-approve:not(.leaving):not(.closing)"); if (!c) return false; const r = c.getBoundingClientRect(); return r.height > 20 && r.top >= 0 && r.bottom <= innerHeight; })(), reply: !!document.querySelector(".msg.asst"), folding: !!document.querySelector(".astep.closing, .astreak-body.closing"), quiet: document.querySelectorAll(".live-call-quiet").length, liveTips: [...document.querySelectorAll(".live-call .dot-tip-line")].map((e) => e.textContent).join("|"), t: performance.now() - t0, cells, thinking: document.querySelectorAll(".athinking").length,
                    written: w ? parseFloat(getComputedStyle(w).opacity) : null,
                    foot: [".run-stats", ".usage-gauge"].map((q) => { const e = document.querySelector(q); return e ? getComputedStyle(e).animationName : ""; }).join(","),
                });
                if (performance.now() - t0 < 22000) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
        const site1 = await ext.context.newPage();
        await site1.goto(site.url + "/");
        await waitForMl(site1);
        void site1.evaluate(() => window.ml.agent("do two things", { env: false, approvalRouting: "both", stream: true })).catch(() => {});
        await chat.bringToFront();   // the site's tab opened after it; the chat is the one being sampled (see chat-transitions.spec.mjs)
        await chat.locator(".chat-row", { hasText: "do two things" }).click();
        await expect(chat.locator(".astep-approve")).toBeVisible({ timeout: 30_000 });
        await chat.waitForTimeout(6000);                           // long enough for a call that had gone quiet to say so (4 s)
        await chat.getByRole("button", { name: /^Approve/ }).first().click();
        await chat.waitForTimeout(1500);
        await expect(chat.locator(".astep-approve").last()).toBeVisible({ timeout: 30_000 });
        await chat.waitForTimeout(2500);
        await chat.getByRole("button", { name: /^Approve/ }).last().click();
        await chat.waitForTimeout(4000);
        const [f, seeks] = await chat.evaluate(() => [window.__f, window.__seek]);
        expect(errors).toEqual([]);
        const dump = (m) => `${m}\n${f.filter((_, i) => i % 4 === 0).map((r) => `${Math.round(r.t)}ms th=${r.thinking} ` + r.cells.map((c) => `${c.live ? "L" : "S"}(${c.path})[${c.cls}]${c.h}${c.open ? "o" : ""}${c.rail ? "|" : "_"}${c.card ? "$" : ""}`).join(" ")).join("\n")}`;
        /** a seeked curve, as it failed: the animation, its duration and what was read at each tenth of it */
        const curve = (s) => `${s.name} over ${Math.round(s.dur)}ms: ` + s.pts.map(([at, v]) => `${Math.round(at * 100)}%=${typeof v === "number" ? Math.round(v * 100) / 100 : v}`).join(" ");
        if (process.env.DUMP) console.log(dump("frames"));

        // 1. Once two cells have been drawn, there are never fewer: the second one does not vanish while the first is decided.
        let most = 0;
        for (const r of f.filter((x) => !x.grouped)) { most = Math.max(most, r.cells.length); if (most >= 2) expect(r.cells.length, dump(`a cell vanished at ${Math.round(r.t)}ms, before the calls were grouped`)).toBeGreaterThanOrEqual(2); }
        expect(most, dump("the two calls were never both drawn")).toBeGreaterThanOrEqual(2);
        // 2. One "thinking" row at a time.
        expect(Math.max(...f.map((r) => r.thinking)), dump("two thinking rows were on the page at once")).toBeLessThanOrEqual(1);
        // 3. The cell that is open wears its rail in every frame it is drawn open (the rail snapped in at the approval).
        const bare = f.filter((r) => r.cells.some((c) => c.open && c.h > 60 && !c.rail));
        expect(bare.length, dump("an open cell had no rail")).toBe(0);
        // 3a. The "waiting on your approval" bar is not put up while the card is merely not drawn yet (its call is still held on screen).
        expect(f.filter((r) => r.bar && !r.cells.some((c) => c.card)).length, dump("the approval bar was up before there was a card to approve")).toBe(0);
        // 3e. A call that is written and waiting behind the one at the gate is not "quiet" (no clock), and its dot says it waits its turn.
        const queuedFrames = f.filter((r) => r.cells.some((c) => c.card) && r.cells.some((c) => c.live));
        expect(queuedFrames.length, dump("no frame had a card and a waiting call")).toBeGreaterThan(10);
        expect(queuedFrames.filter((r) => r.quiet > 0).length, dump("a call waiting its turn showed the no-output clock")).toBe(0);
        expect(queuedFrames.every((r) => /waiting its turn/.test(r.liveTips)), dump("the waiting call's dot did not say it waits its turn")).toBe(true);
        // 3f. The model's next words are not drawn while the calls are still collapsing into their group: a beat of quiet between the two.
        const firstReply = f.find((r) => r.reply);
        if (firstReply) {
            const lastFold = [...f].reverse().find((r) => r.folding && r.t < firstReply.t);
            expect(lastFold && firstReply.t - lastFold.t, dump("the reply started while the calls were still folding, or with no beat after")).toBeGreaterThanOrEqual(250);
            expect(f.filter((r) => r.reply && r.folding).length, dump("the reply was drawn during a fold")).toBe(0);
        }
        // 3g. The bar is for a gate out of reach: never while the card to answer is on screen (a card folding away from the one before it was watched instead).
        expect(f.filter((r) => r.bar && r.cardSeen).length, dump("the approval bar was up while the card was in view")).toBeLessThan(4);
        // 3c. A call written in full sends its "writing… N chars" readout away over time: its fade is paused mid-flight and
        // SEEKED, so the curve itself is read. Sampled in real time on a loaded runner, a correct 260 ms fade shows as drawn then
        // gone (frames 100-700 ms apart); a cut, or a transition of no length, has no curve to read at all.
        const fading = f.filter((r) => r.written != null);
        expect(fading.length, dump("no written call ever sent its readout away")).toBeGreaterThan(0);
        const fade = seeks.fade;
        expect(fade, dump("the readout left with no opacity fade to read (a cut, or a transition of no length)")).not.toBeNull();
        expect(Math.round(fade.dur), dump(`the readout's fade lasts ${fade.dur}ms, not the calm flow's ${fade.calm}ms: ${curve(fade)}`)).toBe(Math.round(fade.calm));
        const ops = fade.pts.map(([, v]) => v);
        expect(ops[0], dump(`the readout was already at ${ops[0]} a tenth into its fade: ${curve(fade)}`)).toBeGreaterThan(0.8);
        expect(ops.at(-1), dump(`the readout was still at ${ops.at(-1)} nine tenths into its fade: ${curve(fade)}`)).toBeLessThan(0.2);
        expect(ops[2], dump(`the middle of the fade is at ${ops[2]}, neither end: ${curve(fade)}`)).toBeGreaterThan(0.05);
        expect(ops[2], dump(`the middle of the fade is at ${ops[2]}, neither end: ${curve(fade)}`)).toBeLessThan(0.95);
        // Every tenth below the one before it: a `steps(1)` curve holds its start value and jumps, so it fails here.
        for (let i = 1; i < ops.length; i++) expect(ops[i], dump(`the readout's opacity did not fall at every step of its fade: ${curve(fade)}`)).toBeLessThan(ops[i - 1]);
        // 3d. What sits under the composer arrives instead of appearing: when drawn, it carries its slide-in.
        const foot = f.map((r) => r.foot.split(",")).filter((x) => x[0] || x[1]);
        if (foot.length) expect(foot[0].some((n) => /chat-foot-from/.test(n)), dump(`the run's figures appeared with no slide (${foot[0]})`)).toBe(true);
        // 4a. Each cell's height changes over time, and the curve that moves it is read by seeking: every size animation that runs
        // in a cell is paused and placed at a tenth … nine tenths of its duration, the cell's box measured at each point. The
        // steepest fifth of a cubic-bezier(.4, 0, .2, 1) moves under half the total, so a box that snaps — or is moved by a
        // `steps(1)` curve — fails here whatever the frame rate was.
        for (const s of seeks.size) {
            const hs = s.pts.map(([, v]) => v);
            const span = hs.at(-1) - hs[0];
            if (Math.abs(span) < 30) continue;   // this animation moves the cell by under a card's worth of pixels: nothing is drawn at a height here
            expect(s.dur, dump(`a ${s.dur}ms animation moved the cell ${Math.abs(span)}px: ${curve(s)}`)).toBeGreaterThanOrEqual(100);
            const dir = Math.sign(span);
            for (let i = 1; i < hs.length; i++) {
                expect(Math.abs(hs[i] - hs[i - 1]), dump(`the cell moved ${Math.abs(hs[i] - hs[i - 1])}px between ${Math.round(s.pts[i - 1][0] * 100)}% and ${Math.round(s.pts[i][0] * 100)}% of a ${Math.abs(span)}px change: ${curve(s)}`)).toBeLessThanOrEqual(Math.abs(span) * 0.5);
                expect(Math.sign(hs[i] - hs[i - 1]) || dir, dump(`the cell reversed mid-animation: ${curve(s)}`)).toBe(dir);
            }
        }
        // 4b. Nothing is drawn at a cell's height from one frame to the next. A piece the frames could not resolve is excused ONLY
        // when a size animation — one that can move the box — was running inside that cell at every frame of it: an opacity-only
        // animation excuses nothing, and neither does a snap between two still frames.
        for (let k = 0; k < 2; k++) {
            const series = f.filter((r) => r.cells[k]).map((r) => ({ t: r.t, v: r.cells[k].h, sz: r.cells[k].sz }));
            for (const r of runsOf(series, 1).filter((x) => x.total > 60)) {
                if (r.duration >= 60) continue;
                const inside = series.filter((s) => s.t >= r.startT && s.t <= r.lastT);
                expect(inside.length > 0 && inside.every((s) => s.sz > 0), dump(`cell ${k}: a ${Math.round(r.total)}px change took ${Math.round(r.duration)}ms with no size animation running (${r.from} → ${r.to})`)).toBe(true);
            }
        }
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});
