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
//   6. THE ENVIRONMENT PANEL says what the sandbox IS — the Python and Pyodide versions and every package
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
import { launchExtension, configureExtension, waitForMl, openRunInSidebar, narrate } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const ART = path.join(path.dirname(fileURLToPath(import.meta.url)), "artifacts", "bench-demo");
mkdirSync(ART, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOLD = process.env.HOLD !== "0";

// Dense on purpose, like a model writes it — so what lands in the bench is the REFLOWED form.
const CODE = "import pandas as pd\nrows=[{'rep':'Gia','q1':210,'q2':220},{'rep':'Kim','q1':190,'q2':205}]\ndf=pd.DataFrame(rows)\ndf['total']=df['q1']+df['q2']\nreturn df.sort_values('total',ascending=False)";

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
        for (let i = 0; i < 30 && !(await drawer.locator(".bench-out").count()); i++) await sleep(300);
        await sleep(800);
        await narrate(page, "Run it, in the sandbox python_exec uses", { sub: "The green \u25b6 in the header, or \u2318/Ctrl+Enter from anywhere in the bench." });
        log("\n--- ran it (the same offscreen Pyodide sandbox python_exec uses) ---");
        log((await drawer.locator(".bench-out").textContent().catch(() => "(no output)")).trim().slice(0, 300));
        await frame.page().screenshot({ path: path.join(ART, "2-ran-in-drawer.png") });

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
        if (HOLD) { log("\nholding the browser open — close the window or Ctrl+C to exit"); await new Promise(() => {}); }
    } finally {
        if (!HOLD) { await ext.context.close(); await fake.stop(); }
    }
};

main().catch((e) => { console.error(e); process.exit(1); });
