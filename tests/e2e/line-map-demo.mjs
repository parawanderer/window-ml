// line-map-demo.mjs — a NARRATED VISUAL demo (not a test) of THE LINE-MAPPING SYSTEM.
//
//   npm run build && node --import tsx tests/e2e/line-map-demo.mjs
//
// THE PROBLEM IT EXISTS FOR, in one sentence: we reformat code so a person can read it, and a stack trace's
// entire content is a line number — so without a map the two silently stop agreeing, and the reader is sent
// to a line that is not the one that failed. Both languages have a formatter (ours for Python,
// js-beautify for `exec`'s JS) and both now publish a map, derived two different ways for the same reason.
//
// Four things that only make sense side by side, all driven by a scripted fake-LLM so it runs hands-free:
//
//   1. THE CODE IS REFLOWED for reading. A model writes dense one-liners on purpose — that is the right
//      trade for the thing paying per token and the wrong one for the person reading the step. The rendered
//      view breaks them open; the raw view (and the model's context, and the export) keep the original.
//   2. THE TOKENS ARE UNCHANGED. Toggle rendered⇄raw on the In block: same program, two spacings.
//   3. A TRACEBACK STILL POINTS SOMEWHERE TRUE. Reflowing moves line numbers, so the formatter publishes a
//      map and the traceback maps through it — click a line number and the line it means lights up green.
//      The deepest user frame is marked as the failure; the prelude's own frame is dimmed, never dropped.
//   4. A DATAFRAME CELL SAYS WHAT IT IS. A dict cell renders as JSON rather than "[object Object]"; a set
//      renders as the list pandas turns it into; and an object with no JSON form at all — a class instance,
//      which pandas would serialise to an empty object, a plausible value that is not the truth — renders as
//      a red "unrenderable Probe" marker NAMING its Python type. The type is recorded in the sandbox,
//      because that is the last place it is still known.
//   5. JS REPORTS ITS LINE TOO. It has no traceback worth rendering (an evaluated script's stack is mostly
//      the wrapper), so `exec` measures the offset its wrapper adds and reports one line — clickable, into
//      the beautified code, through the derived map. Before this a JS failure said WHAT and never WHERE.
//
// Screenshots land in tests/e2e/artifacts/line-map-demo/. Env: HOLD=0 to exit instead of waiting.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const ART = path.join(path.dirname(fileURLToPath(import.meta.url)), "artifacts", "line-map-demo");
mkdirSync(ART, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOLD = process.env.HOLD !== "0";

// The real shape a model wrote, off a real run: one 180-character line holding a dict of two lists. Built
// from a literal rather than a loaded table so the step SUCCEEDS — the point of this one is the reflow, and
// a step that also errored would make the second one (which is about the traceback) say nothing new.
const DENSE = [
    // a cell with NO JSON form — see the narration for step 1
    "class Probe:",
    "    def __repr__(self): return '<Probe live>'",
    "rows = [{'Rep':'Gia','Q1':210,'Q2':220},{'Rep':'Kim','Q1':190,'Q2':205},{'Rep':'Ada','Q1':150,'Q2':160}]",
    "df = pd.DataFrame(rows)",
    "qs = ['Q1','Q2']",
    "grand = df[qs].values.sum()",
    "per_q = df[qs].sum()",
    "rep = df.groupby('Rep', sort=False)[qs].sum().sum(axis=1).sort_values(ascending=False)",
    "out = pd.DataFrame({'metric':['Grand total','Per quarter']+['Top rep: '+rep.index[0]],'value':[grand, dict(per_q), int(rep.iloc[0])],'source':[Probe(), Probe(), Probe()]})",
    "return out",
].join("\n");

// Fails on the user's line 4 — inside a function the user defined, so the deepest frame is the interesting
// one and the frame above it is the call path.
// The REALISTIC failure: a model prints progress as it goes and then trips over something. stdout and the
// traceback then share the Out block, which is the case worth looking at — a clean error with no output is
// the easy one.
// The JS half. `exec` beautifies with js-beautify, which hands back NO map — so one is derived from the two
// texts (line-map.ts). A model writes JS as compactly as it writes Python, for the same reason.
const DENSE_JS = [
    "const rows=[{rep:'Gia',q1:210,q2:220},{rep:'Kim',q1:190,q2:205},{rep:'Ada',q1:150,q2:160}];",
    "const total=rows.reduce((a,r)=>a+r.q1+r.q2,0);",
    "console.log('total',total);",
    "const top=rows.slice().sort((a,b)=>(b.q1+b.q2)-(a.q1+a.q2))[0];",
    "console.log('top',top.rep);",
    "return {total,top:top.rep,missing:rows.map(r=>r.q3.toFixed(1))};",
].join("\n");

const PRINTS_THEN_FAILS = [
    "import pandas as pd",
    "rows = [{'Rep': 'Gia', 'Q1': 210}, {'Rep': 'Kim', 'Q1': 190}]",
    "df = pd.DataFrame(rows)",
    "print('loaded', len(df), 'rows')",
    "print('columns:', list(df.columns))",
    "total = df['Q1'].sum()",
    "print('Q1 total =', total)",
    "print('now the quarter that is not there…')",
    "print(df['Q4'].sum())",
].join("\n");

const FAILS = [
    "import pandas as pd",
    "def total(frame):",
    "    return frame['nope'].sum()",
    "rows = pd.DataFrame([{'a': 1}])",
    "total(rows)",
].join("\n");

const main = async () => {
    const log = (m) => console.log(m);
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension({ headful: true });
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
            debugMode: "overlay", autoApprovePython: true,
        });
        fake.setScript([
            { tool: "python_exec", args: { code: DENSE, mode: "readonly" } },
            { tool: "python_exec", args: { code: FAILS, mode: "readonly" } },
            { tool: "python_exec", args: { code: PRINTS_THEN_FAILS, mode: "readonly" } },
            // The JS twin: dense on one line, beautified for reading, and it throws on the last one.
            { tool: "exec", args: { js: DENSE_JS } },
            { content: "Python reflowed and mapped; JS beautified and mapped the same way." },
        ]);

        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1500, height: 980 });
        await page.goto(`${fake.url}/api/version`);
        await waitForMl(page);

        log("starting the run …");
        await page.evaluate(() => {
            window.ml.agent("crunch the table, then trip over a missing column", {
                approvalRouting: "both", extraTools: [window.ml.pythonTool()],
            });
        });

        // Open the sidebar AND the run inside it. The panel opens on the sessions LIST, so a demo that only
        // slides it open reads an empty transcript and reports that nothing works — see openRunInSidebar.
        const frame = await openRunInSidebar(page, { task: "crunch the table" });

        // Approvals, from the SW-only channel, so nothing waits on a click.
        for (let i = 0; i < 40; i++) {
            const pending = await ext.sw.evaluate(() => (globalThis.__mlApprovals?.list?.() || []).map((d) => d.key));
            for (const k of pending) await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), k);
            await sleep(400);
            if (await frame.locator(".r-py-in").count() >= 2) break;
        }
        await sleep(1500);

        // 1 + 2 — the reflowed code, and the same tokens raw. Address the FIRST step explicitly: both are
        // python steps and "the first .r-py-in on the page" is whichever happens to be expanded.
        const steps = frame.locator(".astep");
        log(`\n(${await steps.count()} steps in the run)`);
        const dense = steps.nth(0);
        if (!(await dense.locator(".r-py-in").count())) await dense.locator(".astep-head").click().catch(() => {});
        await sleep(700);
        const shown = await dense.locator(".r-py-in .code").first().textContent().catch(() => "");
        log("\n--- step 1, as RENDERED (reflowed for reading) ---\n" + shown.trim());
        await dense.locator(".rr-toggle button", { hasText: "raw" }).first().click().catch(() => {});
        await sleep(500);
        const raw = await dense.locator(".io-body").first().textContent().catch(() => "");
        // The raw view is the tool call's JSON; pull the one line that makes the point — the model's own
        // dense `pd.DataFrame({…})`, unbroken, exactly as it sent it.
        const dense1 = /out = pd\.DataFrame\(\{[^\n"]*/.exec(raw || "");
        log("\n--- step 1, as RAW (exactly what the model sent) — the same tokens, unbroken ---\n"
            + (dense1 ? dense1[0] : "(not found)"));
        await frame.page().screenshot({ path: path.join(ART, "1-raw-vs-rendered.png") });
        await dense.locator(".rr-toggle button", { hasText: "rendered" }).first().click().catch(() => {});
        await sleep(400);

        // 2b — the returned frame's cells. Three kinds side by side: a dict that has a JSON form, and a
        // class instance that has none. pandas serialises the second to an empty object, which is a
        // PLAUSIBLE value and therefore the worst possible answer — so the sandbox names its type on the
        // way out and the cell renders as a marker instead of as a fact that is not true.
        const cells = dense.locator(".r-df-table tbody td");
        const bad = dense.locator(".r-td-unrend");
        log(`\n--- step 1's returned frame: ${await cells.count()} cells, ${await bad.count()} with no JSON form ---`);
        if (await bad.count()) {
            log("    " + (await bad.first().textContent()).trim() + "   ← hover it for the type and why");
            await bad.first().scrollIntoViewIfNeeded().catch(() => {});
            await bad.first().hover().catch(() => {});
            await sleep(600);
            await frame.page().screenshot({ path: path.join(ART, "1b-unrenderable-cell.png") });
        }

        // 3 — the traceback, in the step that failed. Click the deepest user frame's line number and watch
        // that line light up in the In block above it.
        const failing = steps.nth(1);
        if (!(await failing.locator(".code.tb").count())) await failing.locator(".astep-head").click().catch(() => {});
        await sleep(700);
        const links = failing.locator(".tb-line");
        const n = await links.count();
        log(`\n--- the traceback has ${n} clickable user frames; the deepest is marked as the failure ---`);
        if (n) {
            await links.last().click();
            await sleep(900);
            await frame.page().screenshot({ path: path.join(ART, "2-traceback-jump.png") });
            log("    clicked the deepest frame — the line it names pulsed green in the In block");
        }

        // 4 — the realistic one: output AND a traceback in the same Out. stdout keeps everything the script
        // managed to print before it broke, which is usually most of what tells you WHY.
        const printer = steps.nth(2);
        if (!(await printer.locator(".code.tb").count())) await printer.locator(".astep-head").click().catch(() => {});
        await sleep(800);
        const stdout = await printer.locator(".r-py-stdout").textContent().catch(() => "");
        log("\n--- step 3: what it printed BEFORE it failed (kept, not discarded) ---\n" + (stdout || "(none)").trim());
        const failedAt = await printer.locator(".cline-fail").textContent().catch(() => "");
        log("\n--- step 3: the line marked as the failure ---\n" + (failedAt || "(none)").trim());
        await printer.locator(".cline-fail").scrollIntoViewIfNeeded().catch(() => {});
        await sleep(400);
        await frame.page().screenshot({ path: path.join(ART, "3-prints-then-fails.png") });

        // 5 — the JS twin. Beautified by js-beautify, which returns no map, so one is derived from the two
        // texts — the same guarantee reached a different way.
        const js = steps.nth(3);
        if (await js.count()) {
            if (!(await js.locator(".code").count())) await js.locator(".astep-head").click().catch(() => {});
            await sleep(800);
            const jsShown = await js.locator(".r-code, .code").first().textContent().catch(() => "");
            log("\n--- step 4: dense JS, beautified for reading (same tokens) ---\n" + (jsShown || "").trim().slice(0, 420));
            const mapped = await js.locator("[data-py-map]").getAttribute("data-py-map").catch(() => null);
            log("\n--- step 4: the derived line map (original → shown) ---\n" + (mapped || "(none — nothing moved)"));
            await frame.page().screenshot({ path: path.join(ART, "4-js-beautified.png") });

            // 6 — the part JS did not have until now. There is no traceback to render (an evaluated
            // script's stack is almost entirely the wrapper), so `exec` measures what its wrapper adds and
            // reports ONE line — which then travels the identical route a python frame does: through the
            // derived map, into the beautified code, marked red.
            const jsErr = js.locator(".r-py-err .tb-line");
            if (await jsErr.count()) {
                log(`\n--- step 4: the failure names line ${(await jsErr.first().textContent()).trim()} of the model's own source ---`);
                await jsErr.first().click();
                await sleep(900);
                const lit = await js.locator(".cline-fail, .cline-pulse-fail").first().textContent().catch(() => "");
                log("    clicked it — the line it means lit up:\n    " + (lit || "(not found)").trim());
                await frame.page().screenshot({ path: path.join(ART, "5-js-error-line.png") });
            } else {
                log("\n--- step 4: NO line number on the JS failure (this is the regression this demo watches for) ---");
            }
        }

        log(`\nscreenshots → ${ART}`);
        if (HOLD) { log("\nholding the browser open — close the window or Ctrl+C to exit"); await new Promise(() => {}); }
    } finally {
        if (!HOLD) { await ext.context.close(); await fake.stop(); }
    }
};
main().catch((e) => { console.error(e); process.exit(1); });
