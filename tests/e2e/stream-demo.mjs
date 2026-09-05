// stream-demo.mjs — a NARRATED VISUAL demo (not a test) of LIVE tool-output streaming.
//
//   npm run build && node --import tsx tests/e2e/stream-demo.mjs
//
// Opens a headful browser, slides the overlay sidebar open on a real agent run, and drives TWO deliberately
// SLOW tools so you can watch their output fill in Jupyter-style instead of appearing all at once:
//   1. `exec`        — console.log lines paced by awaits      (page-side console → ctx.stream)
//   2. `python_exec` — print() lines paced by time.sleep      (offscreen WORKER stdout → the whole reverse chain)
// The run is BACKGROUND-hosted (overlay mode = design A), so this exercises the real path: the page tool's
// ctx.stream → PAGE_TOOL_STREAM → service worker → the loop's throttled fan → an agent-step `streamOutput`
// delta → the step's live Out on every surface.
//
// Deterministic (scripted fake-LLM, no model/key). Approvals are resolved from the SW's __mlApprovals channel
// so it runs hands-free. Screenshots land in tests/e2e/artifacts/stream-demo/. Env: HOLD=0 to exit at the end.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { launchExtension, configureExtension, waitForMl, narrate } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

const ART = path.join(path.dirname(fileURLToPath(import.meta.url)), "artifacts", "stream-demo");
mkdirSync(ART, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOLD = process.env.HOLD !== "0";

// Paced JS: enough lines to OVERFLOW the capped output cell, so the scroll + tail-follow is visible.
const EXEC_JS = `
const wait = (ms) => new Promise(r => setTimeout(r, ms));
// FIRST, not last. One deliberately WIDE line with the needle at its far end — what the find bar's
// horizontal reveal is for: with wrapping off, a match past the right-hand fold used to be painted and
// counted while the view never moved. It leads because truncation eats the END: after eighteen lines of
// output the needle was past the cap and simply absent, and the demo reported "No results" for a reason
// that had nothing to do with scrolling.
console.log('a very wide line ' + '-'.repeat(200) + ' NEEDLEFAR');
for (let i = 1; i <= 18; i++) { console.log('exec line ' + i + ' — streaming into a capped, scrollable cell'); await wait(260); }
console.log('exec finished');
return 'exec done';
`.trim();

// Paced Python: same idea, but the prints originate in the offscreen Pyodide WORKER.
const PY_CODE = `
import time
for i in range(1, 19):
    print(f"python line {i} — streaming into a capped, scrollable cell")
    time.sleep(0.26)
print("python finished")
"done"
`.trim();

// Resolve every approval gate the run opens, via the SW-only __mlApprovals channel (the same control channel
// the Playwright approval tests use) — so the demo never waits on a human click.
async function autoApprove(sw, log) {
    const pending = await sw.evaluate(() => (globalThis.__mlApprovals?.list?.() || []).map(d => ({ key: d.key, tool: d.tool })));
    for (const { key, tool } of pending) {
        await sw.evaluate((k) => globalThis.__mlApprovals.resolve(k, true), key);
        log(`  approved: ${tool}`);
    }
}

const main = async () => {
    const log = (m) => console.log(m);
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    // A NARRATED DEMO: it exists to be watched, so it keeps a real window even though the harness is now
    // headless by default. (Everything else — the e2e suite, bench cells, observe without WATCH — runs
    // headless, because a window that steals focus on every launch makes the machine unusable.)
    const ext = await launchExtension({ headful: true });
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
            debugMode: "overlay",        // overlay → BACKGROUND-hosted run (the real streaming path)
            autoApprovePython: true,     // readonly python needs no gate
        });
        // WRAPPING OFF, before anything mounts. The horizontal half of the find only means something when a
        // line can actually run off the edge — and this pref is read at MOUNT, so setting it later (as a
        // first version of this demo did) leaves every block wrapped and the sideways beat measuring 0px,
        // which looks exactly like the fix not working.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_debug_codewrap: false }));
        fake.setScript([
            { tool: "exec", args: { js: EXEC_JS } },
            { tool: "python_exec", args: { code: PY_CODE, mode: "readonly" } },
            // A NON-streaming tool, to show the SAME output cell wrapping any tool's plain result — a fetched
            // page is the case you actually want Ctrl+F for.
            { tool: "fetch_url", args: { url: site.url + "/" } },
            { content: "Both code tools streamed live; the fetched page uses the same output cell." },
        ]);

        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1500, height: 950 });
        await page.goto(site.url + "/");
        await waitForMl(page);

        log("starting the run (stream: true) …");
        await page.evaluate(() => {
            window.ml.agent("run the two slow tools", {
                stream: true, approvalRouting: "both", extraTools: [window.ml.pythonTool()],
            });
        });

        // Slide the overlay open at half width and click into the live session.
        await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot?.getElementById("ml-sb-host"), null, { timeout: 15000 });
        await page.evaluate(() => {
            const root = document.getElementById("ml-sb-root").shadowRoot;
            const panel = root.getElementById("ml-sb-host");
            panel.style.width = `${Math.round(window.innerWidth / 2)}px`;
            panel.classList.add("open");
            root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
        });
        const frame = await (async () => {
            for (let i = 0; i < 60; i++) {
                const f = page.frames().find((fr) => /sidebar\.html/.test(fr.url()));
                if (f) return f;
                await sleep(100);
            }
            throw new Error("sidebar iframe never appeared");
        })();
        // Click into the run, then keep the newest step EXPANDED so its live Out is visible as it fills.
        for (let i = 0; i < 40; i++) {
            const row = frame.locator("button.row").first();
            if (await row.count()) { await row.click({ timeout: 2000 }).catch(() => {}); }
            if (await frame.locator('button.nav[aria-label="Back to sessions"]').count()) break;
            await sleep(200);
        }
        log("sidebar open — watch the Out blocks fill in line by line.");

        // Poll fast: approve gates, EXPAND every collapsed tool step (the wrapper drives the UI — a step
        // starts collapsed, and we want its live Out visible), and snapshot each new line as it lands.
        // Polling well under the 700ms line cadence so no line is missed.
        let shot = 0, lastSeen = "";
        // Expand each tool step EXACTLY ONCE (keyed by its stable data-astep-seq) — re-clicking every tick
        // would toggle it shut and make the panel flicker.
        const expanded = new Set();
        const expandNew = async () => {
            const steps = frame.locator(".astep.tool");
            const n = await steps.count().catch(() => 0);
            for (let k = 0; k < n; k++) {
                const st = steps.nth(k);
                const seq = await st.getAttribute("data-astep-seq").catch(() => null);
                if (seq == null || expanded.has(seq)) continue;
                const cls = (await st.getAttribute("class").catch(() => "")) || "";
                if (!cls.includes("open")) await st.locator(".astep-head").click({ timeout: 600 }).catch(() => {});
                expanded.add(seq);
            }
        };
        const answered = async () => (await frame.locator(".msg.asst").filter({ hasText: "same output cell" }).count().catch(() => 0)) > 0;
        for (let i = 0; i < 700; i++) {
            if (i % 4 === 0) await autoApprove(ext.sw, log);      // gates open rarely — don't pay for it every tick
            await expandNew();
            const live = await frame.locator(".astep-streaming").last().textContent().catch(() => null);
            if (live && live !== lastSeen) {
                lastSeen = live;
                log(`  live → ${live.trim().split("\n").pop()}`);
                if (++shot <= 14) await page.screenshot({ path: path.join(ART, `live-${String(shot).padStart(2, "0")}.png`) }).catch(() => {});
            }
            if (await answered()) break;    // only stop once the FINAL answer lands (so python runs too)
            await sleep(120);
        }
        await sleep(800);
        // Expand anything still collapsed so the FINISHED cells (with their truncation marking) are visible.
        await expandNew();
        await sleep(300);
        await page.screenshot({ path: path.join(ART, "final.png") }).catch(() => {});

        // --- the "captured, but NOT sent to the model" marking -------------------------------------------
        const unseen = frame.locator(".r-unseen-lbl").first();
        if (await unseen.count()) {
            await unseen.scrollIntoViewIfNeeded().catch(() => {});
            await sleep(250);
            await page.screenshot({ path: path.join(ART, "truncation-marking.png") }).catch(() => {});
            log("captured the truncation marking (output the model never received).");
        } else log("  (no truncation marking — output stayed under the model cap)");

        await narrate(page, "The in-cell find bar", { sub: "Click the Out cell, then Ctrl+F — substring only, with a match count." });
        // --- the in-cell find bar (click the cell to focus it, then Ctrl+F) ------------------------------
        const cell = frame.locator(".r-py-stdout .r-outscroll").last();
        await cell.click({ position: { x: 20, y: 20 } }).catch(() => {});
        await page.keyboard.press("Control+f");
        await sleep(250);
        // Search for something that is ACTUALLY in the cell being searched. This used to type "step" on the
        // assumption that the last cell was fetch_url's fetched page; it is python's `value` cell, holding
        // the word "done" — so the demo captured a truthful, pointless "No results" and looked like the find
        // was broken. The console cell above it is the one worth searching.
        await page.keyboard.type("python line");
        await sleep(500);
        await page.screenshot({ path: path.join(ART, "find-bar.png") }).catch(() => {});
        const n = await frame.locator(".r-find-n").first().textContent().catch(() => null);
        log(`find bar: ${n ?? "(not open)"}`);
        // Step to the next match so the "current match" highlight is on a different line.
        await frame.locator(".r-find-nav").last().click().catch(() => {});
        await sleep(400);
        await page.screenshot({ path: path.join(ART, "find-next.png") }).catch(() => {});

        // --- and the find scrolls SIDEWAYS to a match past the fold ---------------------------------------
        // The bug: reveal only adjusted scrollTop, so a match beyond the right-hand edge was painted and
        // counted while nothing moved — the bar reading "1 of 1" over an unchanged screen. (Wrapping was
        // turned off at configure time, above: with it on there is no horizontal overflow to reveal.)
        await narrate(page, "…and the find scrolls SIDEWAYS", { sub: "In the RAW view, where a long line really does run off the edge." });
        await page.keyboard.press("Escape").catch(() => {});
        await sleep(400);
        // THE RAW VIEW, not the console. The streamed console section is `overflow-x: hidden` by design and
        // wraps, so it can never scroll sideways — pointing the beat at it measured 0px and looked exactly
        // like the fix failing. Raw is one long JSON line inside the same findable cell, which is the case
        // the horizontal reveal exists for and the one that was reported.
        await frame.locator(".astep.tool .rr-toggle button", { hasText: "raw" }).first().click().catch(() => {});
        await sleep(500);
        const wide = frame.locator(".io-raw .r-outscroll").first();
        const scrolledBy = () => wide.evaluate((el) =>
            Math.max(0, ...[el, ...el.querySelectorAll("*")].map((n) => n.scrollLeft || 0))).catch(() => 0);
        // Say out loud whether there is anything to scroll. A beat that measures 0px because the line WRAPS
        // is indistinguishable, in the terminal, from the fix not working — which cost a full re-run to tell
        // apart, twice.
        const overflow = await wide.evaluate((el) => {
            const all = [el, ...el.querySelectorAll("*")];
            const s = all.find((n) => n.scrollWidth > n.clientWidth + 1);
            return s ? `${s.className || s.tagName} overflows by ${s.scrollWidth - s.clientWidth}px` : "NOTHING overflows (the line wrapped — nothing to reveal)";
        }).catch((e) => `could not measure: ${e}`);
        log(`the cell: ${overflow}`);
        log(`codewrap attr: ${await frame.evaluate(() => document.documentElement.dataset.codewrap ?? "(unset)")}`);
        log(`cell white-space: ${await wide.evaluate((el) => getComputedStyle(el).whiteSpace).catch(() => "?")}`);
        log(`before the find, scrolled sideways by: ${await scrolledBy()}px`);
        await wide.click({ position: { x: 20, y: 20 } }).catch(() => {});
        await page.keyboard.press("Control+f");
        await sleep(250);
        await page.keyboard.type("NEEDLEFAR");
        await sleep(700);
        const n2 = await frame.locator(".r-find-n").first().textContent().catch(() => null);
        log(`the find says: ${n2 ?? "(bar not open)"}`);
        log(`after finding a match past the fold:   ${await scrolledBy()}px`);
        await page.screenshot({ path: path.join(ART, "find-sideways.png") }).catch(() => {});
        log(`\ndone — screenshots in ${ART}`);
        if (HOLD) {
            log("holding the browser open (HOLD=0 to skip). Close the window or Ctrl+C to exit.");
            await page.waitForEvent("close", { timeout: 0 }).catch(() => {});
        }
    } finally {
        if (!HOLD) { await ext.close().catch(() => {}); }
        fake.stop?.(); site.stop?.();
    }
    process.exit(0);
};
main().catch((e) => { console.log("ERR", e); process.exit(2); });
