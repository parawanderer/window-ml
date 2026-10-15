#!/usr/bin/env node
// chat-scroll-bench.mjs — what a LONG session costs the chat page: nodes, time to a settled first paint on reload, and
// the main-thread time of scrolling up through all of it. A measuring tool, not a test: it asserts nothing, so a slow
// machine cannot fail CI. The numbers go in the PR that changes the window (docs/dev/sidebar.md, "Transcript").
//
//   node scripts/build-web.mjs && node tests/e2e/chat-scroll-bench.mjs
//   N=1000 KIND=chat|agent WIDTH=1280 RUNS=3 CV=1 node tests/e2e/chat-scroll-bench.mjs
//   E2E_DIST_WEB=<dir>   a build elsewhere (a baseline to compare against)
//   CV=1                 injects `content-visibility: auto` on the turns, to price the CSS before shipping it
//
// WHAT EACH NUMBER TIMES (all in the page's own process, headless Chromium, the fake host with ZERO latency):
//   settle_ms   navigation start -> the first frame after which the transcript has turns and its scrollHeight did not
//               change for 3 consecutive animation frames. Includes parse, reduce of every event, first render, layout.
//   nodes_first elements in the document at that point (the session list included); tnodes_* count only the transcript.
//   up_*        CDP Performance.getMetrics deltas across the whole scroll-up: from the settled page, repeat { scroll to
//               the top; wait for the earlier items to draw (click "Show N earlier" if the build has the button) }
//               until nothing is held back. Script = JS, layout = Layout, style = RecalcStyle, in ms of main-thread time.
//   up_wall_ms  wall clock of that loop, which includes the waits.
//   nodes_all   elements once everything is drawn. heap_mb: JS heap after a forced GC at that point.
//   down_*      the same deltas for one pass back DOWN in viewport-sized steps, which is where content-visibility's
//               skipped layout shows (or does not).
import { chromium } from "@playwright/test";
import path from "node:path";
import { serveStatic } from "./static-server.mjs";

const ROOT = path.resolve(process.env.E2E_DIST_WEB || "dist-web");
const N = Number(process.env.N) || 1000, KIND = process.env.KIND || "chat", WIDTH = Number(process.env.WIDTH) || 1280;
const RUNS = Number(process.env.RUNS) || 3;
const KEY = KIND === "agent" ? "laptop:10a9a9e1" : "laptop:10a9c4a7";
const CV = process.env.CV ? ".msg, .aturn, .astreak { content-visibility: auto; contain-intrinsic-size: auto 260px; }" : "";
const server = await serveStatic(ROOT);
const browser = await chromium.launch({ channel: "chromium" });

async function once() {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 800 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    if (CV) await page.addInitScript((css) => { document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = css; document.head.append(s); }); }, CV);
    await page.addInitScript(() => {
        window.__settle = new Promise((resolve) => {
            let last = -1, same = 0;
            const tick = () => {
                const t = document.querySelector(".chat-transcript");
                const h = t ? t.scrollHeight : -1, has = !!t?.querySelector(".msg, .aturn");
                if (has && h === last) { if (++same >= 3) return resolve(Math.round(performance.now())); } else same = 0;
                last = h; requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
    });
    await page.goto(`${server.url}?long=${N}#/s/${encodeURIComponent(KEY)}`);
    const settle_ms = await page.evaluate(() => window.__settle);
    const nodes_first = await page.evaluate(() => document.querySelectorAll("*").length);
    const tnodes_first = await page.evaluate(() => document.querySelectorAll(".chat-transcript *").length);
    const m0 = await metrics(), w0 = Date.now();
    const held = () => page.evaluate(() => document.querySelector(".chat-window-rest")?.textContent ?? "");
    const frames = (n = 2) => page.evaluate((k) => new Promise((r) => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
    let rounds = 0;
    for (; rounds < 400; rounds++) {
        const btn = page.locator(".chat-window-edge .chat-earlier-retry");
        if (await btn.count()) await btn.click();
        await page.evaluate(() => { const t = document.querySelector(".chat-transcript"); t.scrollTop = 0; });
        await frames(3);
        if (!(await held())) break;
    }
    await frames(3);
    const m1 = await metrics(), up_wall_ms = Date.now() - w0;
    const nodes_all = await page.evaluate(() => document.querySelectorAll("*").length);
    const tnodes_all = await page.evaluate(() => document.querySelectorAll(".chat-transcript *").length);
    await cdp.send("HeapProfiler.collectGarbage");
    const heap_mb = (await metrics()).JSHeapUsedSize / 1048576;
    // One pass back down.
    const d0 = await metrics();
    await page.evaluate(async () => {
        const t = document.querySelector(".chat-transcript");
        for (let y = 0; y < t.scrollHeight; y += t.clientHeight) { t.scrollTop = y; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }
    });
    const d1 = await metrics();
    const ms = (a, b, k) => Math.round((b[k] - a[k]) * 1000);
    await page.close();
    return {
        settle_ms, nodes_first, tnodes_first, tnodes_all, up_script_ms: ms(m0, m1, "ScriptDuration"), up_layout_ms: ms(m0, m1, "LayoutDuration"), up_style_ms: ms(m0, m1, "RecalcStyleDuration"),
        up_wall_ms, rounds, nodes_all, heap_mb: Math.round(heap_mb * 10) / 10,
        down_script_ms: ms(d0, d1, "ScriptDuration"), down_layout_ms: ms(d0, d1, "LayoutDuration"), down_style_ms: ms(d0, d1, "RecalcStyleDuration"),
    };
}
const runs = [];
for (let i = 0; i < RUNS; i++) runs.push(await once());
const med = (k) => runs.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
const out = Object.fromEntries(Object.keys(runs[0]).map((k) => [k, med(k)]));
console.log(JSON.stringify({ N, KIND, WIDTH, CV: !!CV, RUNS, dist: ROOT, median: out }));
await browser.close(); server.close();
