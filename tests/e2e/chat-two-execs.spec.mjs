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
            const t0 = performance.now();
            const tick = () => {
                const cells = [...document.querySelectorAll(".live-call, .astep.tool")].map((el) => {
                    const body = el.querySelector(".astep-body");
                    const path = []; for (let n = el.parentElement; n && path.length < 4; n = n.parentElement) path.push(n.className.toString().split(" ")[0]);
                    return { path: path.join("<"), cls: el.className.replace(/astep|tool|pending/g, "").trim(), live: el.classList.contains("live-call"), h: Math.round(el.getBoundingClientRect().height), open: el.classList.contains("open"), rail: !!body?.querySelector(".fold-rail"), card: !!el.querySelector(".astep-approve"), dot: el.querySelector(".dot")?.className ?? "" };
                });
                window.__f.push({
                    grouped: !!document.querySelector(".astreak"), t: performance.now() - t0, cells, thinking: document.querySelectorAll(".athinking").length,
                    rolled: document.querySelectorAll(".tick-d.rolled").length,
                    written: (() => { const w = document.querySelector(".live-call .astep-preview.written"); return w ? parseFloat(getComputedStyle(w).opacity) : null; })(),
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
        await chat.locator(".chat-row", { hasText: "do two things" }).click();
        await expect(chat.locator(".astep-approve")).toBeVisible({ timeout: 30_000 });
        await chat.waitForTimeout(2500);
        await chat.getByRole("button", { name: /^Approve/ }).first().click();
        await chat.waitForTimeout(1500);
        await expect(chat.locator(".astep-approve").last()).toBeVisible({ timeout: 30_000 });
        await chat.waitForTimeout(2500);
        await chat.getByRole("button", { name: /^Approve/ }).last().click();
        await chat.waitForTimeout(4000);
        const f = await chat.evaluate(() => window.__f);
        expect(errors).toEqual([]);
        const dump = (m) => `${m}\n${f.filter((_, i) => i % 4 === 0).map((r) => `${Math.round(r.t)}ms th=${r.thinking} ` + r.cells.map((c) => `${c.live ? "L" : "S"}(${c.path})[${c.cls}]${c.h}${c.open ? "o" : ""}${c.rail ? "|" : "_"}${c.card ? "$" : ""}`).join(" ")).join("\n")}`;
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
        // 3b. The counters' digits roll as they change (the thinking's tokens, the call's characters), instead of being redrawn.
        expect(Math.max(...f.map((r) => r.rolled)), dump("no figure rolled while the model was writing")).toBeGreaterThan(0);
        // 3c. A call written in full sends its "writing… N chars" readout away over time: its opacity passes through the middle.
        const fading = f.filter((r) => r.written != null);
        expect(fading.length, dump("no written call ever sent its readout away")).toBeGreaterThan(0);
        expect(fading.some((r) => r.written > 0.08 && r.written < 0.92), dump("the readout went from drawn to gone in one frame")).toBe(true);
        // 3d. What sits under the composer arrives instead of appearing: when drawn, it carries its slide-in.
        const foot = f.map((r) => r.foot.split(",")).filter((x) => x[0] || x[1]);
        if (foot.length) expect(foot[0].some((n) => /chat-foot-from/.test(n)), dump(`the run's figures appeared with no slide (${foot[0]})`)).toBe(true);
        // 4. Each cell's height changes over time: nothing is drawn at its height from one frame to the next.
        for (let k = 0; k < 2; k++) {
            const series = f.filter((r) => r.cells[k]).map((r) => ({ t: r.t, v: r.cells[k].h }));
            for (const r of runsOf(series, 1).filter((x) => x.total > 60)) {
                expect(r.duration, dump(`cell ${k}: a ${Math.round(r.total)}px change took ${Math.round(r.duration)}ms (${r.from} → ${r.to})`)).toBeGreaterThanOrEqual(60);
            }
        }
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});
