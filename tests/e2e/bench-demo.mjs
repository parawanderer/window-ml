// bench-demo.mjs — a NARRATED VISUAL demo (not a test) of the PYTHON BENCH in its two shapes.
//
//   npm run build && node --import tsx tests/e2e/bench-demo.mjs
//
// THE PROBLEM IT EXISTS FOR: the bench used to REPLACE the session view. So "let me try that snippet" cost
// you your place in the run you opened it from — which is exactly the trip you would be making: copy this
// step's code, poke at it, look back at the step. You went to the bench, lost the transcript, came back to
// the sessions LIST, and had to find your way in again.
//
// Five things, in the order the demo walks them:
//
//   1. IT OPENS AS A DRAWER, under the run. The transcript stays exactly where it was — the drawer is a
//      SIBLING of the scroll container rather than content inside it, so it does not even scroll the log.
//   2. ▶ BENCH ON A STEP hands it that step's script. The code arrives reflowed, which is the code that ran
//      (py-format never changes a token), so what lands is what you pressed the button next to.
//   3. IT RUNS, against the same offscreen Pyodide sandbox `python_exec` uses — and you can edit first.
//   4. IT DRAGS to resize, and remembers. How much of it you want depends on the script.
//   5. ⤢ GOES FULL-PAGE for a long script, and BACK RETURNS to the session you were reading rather than to
//      the sessions list. ⤡ docks it again. Two real modes, one control from either side.
//
//   6. THE OUTPUT IS A SECOND PANE, not a block stacked under the editor. It is not there at all until you
//      run something — an empty pane with a placeholder in it is chrome promising what it does not have,
//      and it takes half the room you came here to write in. stdout STREAMS into it as the script runs. a divider sizes the two against
//      each other, and a TAB STRIP picks which part of the result you are looking at. The log stacks these
//      as disclosures because a step is a row in a scrolling transcript; the bench is a LOOP, and there the
//      output you ran the script to see was arriving collapsed behind two clicks on every run. Same
//      renderers either way — only the composition differs. A failure MARKS its tab and takes the
//      selection; anything else leaves you on the tab you were working in.
//
//   7. THE ENVIRONMENT PANEL says what the sandbox IS — the Python and Pyodide versions and every package
//      you can import, with the version that actually installed, read from the running interpreter rather
//      than from our own manifest. Filterable, because that is about to be how you find a package to
//      install. In both modes: it is a property of the bench, not of one of its shapes.
//
//   …and ✕ closes it WITHOUT discarding the draft. Closing is not throwing away.
//
// Deterministic: a scripted fake-LLM, and the python runs for real in the extension's sandbox.
// Screenshots land in tests/e2e/artifacts/bench-demo/. Env: HOLD=0 to exit instead of waiting.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar, narrate, narrateDone } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const ART = path.join(path.dirname(fileURLToPath(import.meta.url)), "artifacts", "bench-demo");
mkdirSync(ART, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOLD = process.env.HOLD !== "0";

// Dense on purpose, like a model writes it — so what lands in the bench is the REFLOWED form.
const CODE = "import pandas as pd\nrows=[{'rep':'Gia','q1':210,'q2':220},{'rep':'Kim','q1':190,'q2':205}]\ndf=pd.DataFrame(rows)\ndf['total']=df['q1']+df['q2']\nprint('loaded',len(df),'reps')\nprint('columns:',list(df.columns))\nreturn df.sort_values('total',ascending=False)";

const main = async () => {
    const log = (m) => console.log(m);
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension({ headful: true });
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
            debugMode: "overlay", autoApprovePython: true,
        });
        fake.setSide(() => null);
        fake.setScript([
            { tool: "python_exec", args: { code: CODE, mode: "readonly" } },
            { content: "Gia leads on the two quarters combined." },
        ]);

        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1500, height: 1000 });
        await page.goto(`${fake.url}/api/version`);
        await waitForMl(page);
        await page.evaluate(() => {
            window.ml.agent("total the quarters", { approvalRouting: "both", extraTools: [window.ml.pythonTool()] });
        });
        const frame = await openRunInSidebar(page, { task: "total the quarters" });
        for (let i = 0; i < 60; i++) {
            const pending = await ext.sw.evaluate(() => (globalThis.__mlApprovals?.list?.() || []).map((d) => d.key));
            for (const k of pending) await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), k);
            if (await frame.locator(".astep.tool").count()) break;
            await sleep(400);
        }
        await sleep(1200);

        // 2 — the button on the STEP, which is the whole point of the drawer existing: it hands the bench
        // this step's script and you keep the step on screen to compare against.
        const step = frame.locator(".astep").first();
        if (!(await step.locator(".r-py-in").count())) await step.locator(".astep-head").click();
        await sleep(500);
        await narrate(page, "A finished run, with a python step", { sub: "Its code is reflowed for reading — py-format never changes a token." });
        log("\n--- the step's code, as drawn (reflowed — this is what the bench will get) ---");
        log((await step.locator(".r-py-in .code").first().textContent()).trim());
        await step.locator(".code-tool", { hasText: "bench" }).click();
        await sleep(900);

        // 1 — and the run is STILL THERE, under it.
        const drawer = frame.locator(".bench-drawer");
        await narrate(page, "\u25b6 bench opens it as a DRAWER", { sub: "The run stays on screen — that is the trip the drawer exists for." });
        log(`\n--- the bench opened as a DRAWER: ${await drawer.count()} · the run behind it: ${await frame.locator(".astep.tool").count()} step(s), still on screen ---`);
        log("--- what landed in it ---\n" + (await drawer.locator(".bench-code").inputValue()));
        await frame.page().screenshot({ path: path.join(ART, "1-drawer-with-run.png") });

        // 3 — it RUNS, for real, in the same sandbox python_exec uses.
        await drawer.locator(".bench-code").fill(
            (await drawer.locator(".bench-code").inputValue()) + "\n# edited here, then run:\n");
        await drawer.locator(".bench-play").click();
        for (let i = 0; i < 30 && !(await drawer.locator(".bench-outbody .r-python, .bench-outbody .dftable, .bench-outbody .code").count()); i++) await sleep(300);
        await sleep(800);
        await narrate(page, "Run it, in the sandbox python_exec uses", { sub: "The green \u25b6 in the header, or \u2318/Ctrl+Enter from anywhere in the bench. The \u21b3 beside it is a placeholder \u2014 disabled, so it reads as unbuilt rather than broken." });
        log("\n--- ran it (the same offscreen Pyodide sandbox python_exec uses) ---");
        log((await drawer.locator(".bench-outbody").textContent().catch(() => "(no output)")).trim().slice(0, 300));
        await frame.page().screenshot({ path: path.join(ART, "2-ran-in-drawer.png") });

        // 6a — THE TAB STRIP. The script printed on its way to returning a DataFrame, so the result has two
        // sections; stacked as disclosures they were both collapsed, on every run.
        const tabs = drawer.locator(".bench-tab");
        await narrate(page, "The result is TABS, not stacked disclosures", { sub: "You land on the value. stdout is one click, and neither is folded away." });
        log(`\n--- tabs: ${(await tabs.allTextContents()).join(" | ")} · showing: ${(await drawer.locator(".bench-tab.on").textContent())} ---`);
        await frame.page().screenshot({ path: path.join(ART, "2b-tabs-value.png") });
        await tabs.filter({ hasText: "stdout" }).click();
        await sleep(500);
        await narrate(page, "\u2026and what it printed on the way", { sub: "Same renderers the log uses \u2014 only the composition differs." });
        log("--- stdout tab ---\n" + (await drawer.locator(".bench-outbody").textContent()).trim());
        await frame.page().screenshot({ path: path.join(ART, "2c-tabs-stdout.png") });

        // 6b — A FAILURE MARKS ITS TAB AND TAKES THE SELECTION. This is the one thing tabs are worse at than
        // disclosures — a disclosure at least advertises that something exists — so it is handled explicitly.
        const good = await drawer.locator(".bench-code").inputValue();
        await drawer.locator(".bench-code").fill(good + "\nraise ValueError('and this is what a failure looks like')\n");
        await drawer.locator(".bench-play").click();
        for (let i = 0; i < 40 && !(await drawer.locator(".bench-tab.err").count()); i++) await sleep(300);
        await sleep(600);
        await narrate(page, "A failure MARKS its tab and takes the selection", { sub: "You were on stdout; the error is what you now need. What it printed first is still one click away." });
        log(`\n--- after a raise: tabs ${(await tabs.allTextContents()).join(" | ")} · showing: ${(await drawer.locator(".bench-tab.on").textContent())} ---`);
        await frame.page().screenshot({ path: path.join(ART, "2d-error-tab.png") });
        await drawer.locator(".bench-code").fill(good);
        await drawer.locator(".bench-play").click();
        await sleep(1500);

        // 6d — LIVE STDOUT. The same worker tee the model-invoked python_exec gets, painting a different
        // widget. The last hop is the interesting part: the SW relays a PAGE's chunks through its content
        // script, and the bench is an extension iframe inside a tab — so it has a `sender.tab` and its own
        // output would have gone to the page. The sending FRAME's url is what tells them apart.
        await drawer.locator(".bench-code").fill(
            "import time\nfor i in range(6):\n    print('line', i, '\u2014 printed as it happens')\n    time.sleep(0.7)\nreturn 'done'");
        await drawer.locator(".bench-play").click();
        await narrate(page, "stdout STREAMS in, Jupyter-style", { sub: "The same worker tee the agent's python_exec uses \u2014 and the elapsed clock says it is still going." });
        await sleep(2200);
        log("\n--- mid-run, with the script still sleeping ---");
        log((await drawer.locator(".bench-outbody").textContent()).trim());
        log(`--- and the pane says it is alive: ${(await drawer.locator(".bench-outpane .r-ranfor").textContent()).trim()} ---`);
        await frame.page().screenshot({ path: path.join(ART, "2f-streaming.png") });
        for (let i = 0; i < 40 && (await drawer.locator(".bench-outpane .r-ranfor.live").count()); i++) await sleep(400);
        await sleep(500);
        await narrate(page, "\u2026and the result supersedes it", { sub: "You land on the VALUE: an auto-pick never sticks, only a tab you clicked does." });
        log(`--- settled: tabs ${(await tabs.allTextContents()).join(" | ")} \u00b7 showing ${(await drawer.locator(".bench-tab.on").textContent())} ---`);
        await frame.page().screenshot({ path: path.join(ART, "2g-streaming-settled.png") });
        await drawer.locator(".bench-code").fill(good);
        await drawer.locator(".bench-play").click();
        await sleep(1800);

        // 6c — THE DIVIDER. A ratio, not a pixel height: the bench is itself resizable, so pinning the
        // editor to pixels would let a shorter drawer eat the whole output pane.
        const codeBefore = (await drawer.locator(".bench-code").boundingBox()).height;
        const div = await drawer.locator(".bench-div").boundingBox();
        await page.mouse.move(div.x + div.width / 2, div.y + div.height / 2);
        await page.mouse.down();
        await page.mouse.move(div.x + div.width / 2, div.y - 90, { steps: 12 });
        await page.mouse.up();
        await sleep(500);
        await narrate(page, "The divider sizes the two against each other", { sub: "A ratio, not pixels \u2014 the drawer itself resizes, and the output must not get squeezed out." });
        log(`\n--- dragged the divider: editor ${Math.round(codeBefore)}px \u2192 ${Math.round((await drawer.locator(".bench-code").boundingBox()).height)}px (remembered) ---`);
        await frame.page().screenshot({ path: path.join(ART, "2e-divider.png") });

        // 4 — drag it taller. How much of the bench you want depends on the script.
        const before = (await drawer.boundingBox()).height;
        const g = await frame.locator(".bench-grip-pill").boundingBox();   // the pill, not the row: its midpoint is now a <select>
        await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
        await page.mouse.down();
        await page.mouse.move(g.x + g.width / 2, g.y - 140, { steps: 12 });
        await page.mouse.up();
        await sleep(500);
        await narrate(page, "Drag the top edge to resize", { sub: "The grab pill sits in the row's free space, so it never lands on a control." });
        log(`\n--- dragged the top edge: ${Math.round(before)}px → ${Math.round((await drawer.boundingBox()).height)}px (remembered across a reload) ---`);
        await frame.page().screenshot({ path: path.join(ART, "3-dragged.png") });

        // 6 — what the sandbox is. Fetched on OPEN (reading it starts the interpreter, which is what a first
        // python_exec pays for), so a glance at the bench costs nothing until you ask.
        await drawer.locator(".bench-env-btn").click();
        for (let i = 0; i < 40 && !(await frame.locator(".bench-env-head").count()); i++) await sleep(400);
        await narrate(page, "What the sandbox actually IS", { sub: "Read from the running interpreter, not from our package manifest. Click off it or press Escape to dismiss." });
        log("\n--- the environment, from the running interpreter ---");
        log("    " + (await frame.locator(".bench-env-head").textContent().catch(() => "(none)")).replace(/\s+/g, " ").trim());
        for (const row of await frame.locator(".bench-env-list li").allTextContents()) log("    " + row.replace(/\s+/g, " ").trim());
        await frame.page().screenshot({ path: path.join(ART, "3b-environment.png") });
        await frame.locator(".bench-env-q").fill("pand");
        await sleep(400);
        log(`--- filtered to "pand": ${(await frame.locator(".bench-env-list li").allTextContents()).join(", ").trim()} ---`);
        log("    " + (await frame.locator(".bench-env-soon").textContent()).replace(/\s+/g, " ").trim());
        await frame.page().screenshot({ path: path.join(ART, "3c-environment-filtered.png") });
        await drawer.locator(".bench-env-btn").click();
        await sleep(300);

        // 5 — full page, and BACK.
        await frame.locator('[aria-label="Expand the Python bench"]').click();
        await sleep(700);
        await narrate(page, "\u2921 full page, for a long script", { sub: "Same header, same controls — the drawer only adds the grip and the shape buttons." });
        log(`\n--- ⤢ full page: drawer gone (${await frame.locator(".bench-drawer").count()}), transcript gone (${await frame.locator(".astep.tool").count()}) — the right shape for a long script ---`);
        await frame.page().screenshot({ path: path.join(ART, "4-full-page.png") });

        // ⤡ and ✕ both go BACK to the session — what differs is whether the bench comes with you. That is
        // the whole distinction, and it is why there is no `‹` beside them to muddle it.
        await frame.locator('[aria-label="Dock the Python bench"]').click();
        await sleep(700);
        await narrate(page, "\u2922 docked \u2014 and back to the session you left", { sub: "Not the sessions list. The script is intact." });
        log(`--- ⤡ docked and RETURNED to the session: ${await frame.locator(".astep.tool").count()} step(s), not the sessions list ---`);
        await sleep(300);
        log(`--- and the bench is a drawer again, script intact:\n${(await frame.locator(".bench-drawer .bench-code").inputValue()).split("\n").slice(-2).join("\n")}`);
        await frame.page().screenshot({ path: path.join(ART, "5-back-and-docked.png") });

        log(`\nscreenshots → ${ART}`);
        // The banner says whose window it is now. A headful demo takes the pointer and the keyboard, and a
        // watcher cannot tell a finished demo from a paused one — so they either wait, or they click into
        // the middle of a beat.
        await narrateDone(page);
        if (HOLD) { log("\nholding the browser open — close the window or Ctrl+C to exit"); await new Promise(() => {}); }
    } finally {
        if (!HOLD) { await ext.context.close(); await fake.stop(); }
    }
};

main().catch((e) => { console.error(e); process.exit(1); });
