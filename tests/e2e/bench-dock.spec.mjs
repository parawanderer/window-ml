// bench-dock.spec.mjs — the Python bench as a bottom DRAWER, and its full-page mode.
//
// The bench used to REPLACE the session view, so trying a snippet cost you your place in the run you opened
// it from — which is exactly the trip you would be making: copy this step's code, poke at it, look back at
// the step. These are the four things that make that loop work, and each of them was broken by the old
// shape: the transcript stays on screen, the drawer resizes, closing keeps the draft, and coming back from
// full-page lands where you left rather than on the sessions list.
//
// A real browser, because every one of these is about layout, drag, or persistence across a remount.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A finished one-step run, opened in the sidebar — so there is a transcript for the drawer to sit under. */
const setup = async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    await configureExtension(ext.sw, {
        chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay",
    });
    fake.setSide(() => null);
    fake.setScript([{ tool: "exec", args: { js: "'hello from the run'" } }, { content: "done reading" }]);
    const page = await ext.context.newPage();
    await page.setViewportSize({ width: 1400, height: 950 });
    await page.goto(`${fake.url}/api/version`);
    await waitForMl(page);
    await page.evaluate(() => window.ml.agent("read the page", { approvalRouting: "both" }));
    const frame = await openRunInSidebar(page, { task: "read the page" });
    for (let i = 0; i < 40; i++) {
        const pending = await ext.sw.evaluate(() => (globalThis.__mlApprovals?.list?.() || []).map((d) => d.key));
        for (const k of pending) await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), k);
        if (await frame.locator(".astep.tool").count()) break;
        await sleep(300);
    }
    return { fake, ext, page, frame };
};

test("the bench opens as a drawer and the run stays on screen behind it", async () => {
    const { fake, ext, frame } = await setup();
    try {
        // The whole point: opening it must not cost you the thing you were reading.
        await expect(frame.locator(".astep.tool")).toHaveCount(1);
        await expect(frame.locator(".bench-drawer")).toHaveCount(0, { timeout: 5000 });

        await frame.locator('[aria-label="Python bench"]').click();
        const drawer = frame.locator(".bench-drawer");
        await expect(drawer).toBeVisible();
        await expect(drawer.locator(".bench-code")).toBeVisible();
        await expect(frame.locator(".astep.tool"), "the transcript is still there").toHaveCount(1);
        await expect(frame.locator(".astep.tool").first()).toBeVisible();
        // …and the drawer sits BELOW it, which is what makes it a drawer rather than a replacement.
        const stepY = (await frame.locator(".astep.tool").first().boundingBox()).y;
        const drawerY = (await drawer.boundingBox()).y;
        expect(drawerY).toBeGreaterThan(stepY);
    } finally { await ext.context.close(); await fake.stop(); }
});

test("the drawer drags to resize, and remembers the height", async () => {
    const { fake, ext, page, frame } = await setup();
    try {
        await frame.locator('[aria-label="Python bench"]').click();
        const drawer = frame.locator(".bench-drawer");
        await expect(drawer).toBeVisible();
        const before = (await drawer.boundingBox()).height;

        // Dragging the grip UP grows it — the edge is where a hand goes for a drawer.
        // Grab the PILL, not the row's midpoint. The header holds controls now, so its geometric centre is a
        // <select> — aiming there stopped dragging entirely, and that is exactly the confusion the pill
        // moving into the free space fixes.
        const grip = frame.locator(".bench-grip-pill");
        const g = await grip.boundingBox();
        await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
        await page.mouse.down();
        await page.mouse.move(g.x + g.width / 2, g.y - 90, { steps: 8 });
        await page.mouse.up();
        await sleep(300);
        const after = (await drawer.boundingBox()).height;
        expect(after, `expected taller than ${before}, got ${after}`).toBeGreaterThan(before + 40);

        // It is a workspace you leave set up, not a dialog you dismiss: the height survives a reload.
        await page.reload();
        const frame2 = await openRunInSidebar(page, { task: "read the page" });
        await expect(frame2.locator(".bench-drawer")).toBeVisible({ timeout: 15000 });
        const restored = (await frame2.locator(".bench-drawer").boundingBox()).height;
        expect(Math.abs(restored - after)).toBeLessThan(12);
    } finally { await ext.context.close(); await fake.stop(); }
});

test("✕ closes the drawer and KEEPS the script — closing is not discarding", async () => {
    const { fake, ext, page, frame } = await setup();
    try {
        await frame.locator('[aria-label="Python bench"]').click();
        const drawer = frame.locator(".bench-drawer");
        await expect(drawer).toBeVisible();
        await drawer.locator(".bench-code").fill("return 6 * 7   # my work in progress");
        // The draft is persisted when it RUNS, and the bench also reads it back on mount; either way what
        // must not happen is that closing throws it away.
        await drawer.locator(".bench-play").click();
        await sleep(600);

        await drawer.locator('[aria-label="Close the Python bench"]').click();
        await expect(frame.locator(".bench-drawer")).toHaveCount(0);
        await expect(frame.locator(".astep.tool"), "and the run is still what you are reading").toHaveCount(1);

        await frame.locator('[aria-label="Python bench"]').click();
        await expect(frame.locator(".bench-drawer .bench-code")).toHaveValue(/my work in progress/);
        // Closed stays closed across a reload, too — it is a state, not a transient.
        await frame.locator('[aria-label="Close the Python bench"]').click();
        await page.reload();
        const frame2 = await openRunInSidebar(page, { task: "read the page" });
        await expect(frame2.locator(".bench-drawer")).toHaveCount(0);
    } finally { await ext.context.close(); await fake.stop(); }
});

test("⤢ goes full-page, and BACK returns to the session you were reading", async () => {
    const { fake, ext, frame } = await setup();
    try {
        await frame.locator('[aria-label="Python bench"]').click();
        await expect(frame.locator(".bench-drawer")).toBeVisible();
        await frame.locator('[aria-label="Expand the Python bench"]').click();

        // FULL: the bench owns the view, and the drawer is gone rather than drawn twice.
        await expect(frame.locator(".bench-drawer")).toHaveCount(0);
        await expect(frame.locator(".bench-code")).toBeVisible();
        await expect(frame.locator(".astep.tool")).toHaveCount(0);

        // NO `‹` HERE. It and ⤡ both meant "back to what I was reading", differing only in whether the bench
        // came along — two adjacent chevrons for that distinction is the confusion itself. The full-page
        // header carries ✕ and ⤡ instead, both about the BENCH, with the same destination.
        await expect(frame.locator(".nav")).toHaveCount(0);
        await frame.locator('[aria-label="Dock the Python bench"]').click();
        await expect(frame.locator(".astep.tool")).toHaveCount(1);
        await expect(frame.locator(".astep.tool").first()).toContainText("exec");
    } finally { await ext.context.close(); await fake.stop(); }
});

test("full-page docks back to the drawer, and the resource panel does not fight it for the edge", async () => {
    const { fake, ext, frame } = await setup();
    try {
        // Two draggable strips on the same bottom edge is not a layout: opening one puts the other away.
        await frame.locator('[aria-label="VRAM monitor"]').click();
        await expect(frame.locator(".vram")).toBeVisible();
        await frame.locator('[aria-label="Python bench"]').click();
        await expect(frame.locator(".bench-drawer")).toBeVisible();
        await expect(frame.locator(".vram")).toHaveCount(0);

        // …and the two modes are one control from either side, so neither is a trapdoor.
        await frame.locator('[aria-label="Expand the Python bench"]').click();
        await expect(frame.locator(".bench-drawer")).toHaveCount(0);
        await frame.locator('[aria-label="Dock the Python bench"]').click();
        await expect(frame.locator(".bench-drawer")).toBeVisible();
        await expect(frame.locator(".astep.tool"), "and it lands back on the run, not the list").toHaveCount(1);
    } finally { await ext.context.close(); await fake.stop(); }
});

// THE SAME BUG, one view over. Settings and the server-tool list also REPLACE the view, and `‹` sent you to
// the sessions list from both — so glancing at a setting mid-run cost you the run you were reading. One
// `viewReturn` for all of them rather than one per destination: two would drift, and it is the same
// question ("what was I looking at").
test("back from SETTINGS returns to the session you were reading, not the list", async () => {
    const { fake, ext, frame } = await setup();
    try {
        await expect(frame.locator(".astep.tool")).toHaveCount(1);
        await frame.locator('[aria-label="Settings"]').click();
        await expect(frame.locator(".astep.tool")).toHaveCount(0);

        await frame.locator(".nav").click();
        await expect(frame.locator(".astep.tool"), "back to the run, not to the sessions list").toHaveCount(1);
        await expect(frame.locator(".astep.tool").first()).toContainText("exec");
    } finally { await ext.context.close(); await fake.stop(); }
});

test("back from the SESSIONS LIST is still the list — a stale return is not a destination", async () => {
    // Nothing is behind you there, and a value left over from a previous visit would send you somewhere you
    // did not come from. The return is read only while you are somewhere that replaced a view.
    const { fake, ext, frame } = await setup();
    try {
        await frame.locator('[aria-label="Settings"]').click();
        await frame.locator(".nav").click();
        await expect(frame.locator(".astep.tool")).toHaveCount(1);
        // Now go OUT to the list by hand, then into settings and back: it must land on the list, not on the
        // session the earlier trip remembered.
        await frame.locator(".nav").click();
        await expect(frame.locator(".astep.tool")).toHaveCount(0);
        await frame.locator('[aria-label="Settings"]').click();
        await frame.locator(".nav").click();
        await expect(frame.locator(".row").first()).toBeVisible();
        await expect(frame.locator(".astep.tool")).toHaveCount(0);
    } finally { await ext.context.close(); await fake.stop(); }
});

// ✕ AND ⤡ GO TO THE SAME PLACE from full-page — what differs is whether the bench comes with you. That is
// the whole distinction the two glyphs carry, and it is why there is no `‹` beside them to muddle it.
test("from full-page, ✕ and ⤡ both return you to the session — with and without the bench", async () => {
    const { fake, ext, frame } = await setup();
    try {
        await frame.locator('[aria-label="Python bench"]').click();
        await frame.locator('[aria-label="Expand the Python bench"]').click();
        await expect(frame.locator(".astep.tool")).toHaveCount(0);

        // ✕ — back to the run, bench gone.
        await frame.locator('[aria-label="Close the Python bench"]').click();
        await expect(frame.locator(".astep.tool")).toHaveCount(1);
        await expect(frame.locator(".bench-drawer")).toHaveCount(0);

        // …and reopening returns to FULL, because the dock is a remembered preference and not something you
        // re-choose every time. (Closing did not reset it — ✕ is about the bench being open, ⤢/⤡ about its
        // shape, and conflating the two would make one of them surprising.)
        await frame.locator('[aria-label="Python bench"]').click();
        await expect(frame.locator(".bench-code")).toBeVisible();
        await expect(frame.locator(".bench-drawer")).toHaveCount(0);
        await expect(frame.locator(".astep.tool")).toHaveCount(0);

        // ⤡ — back to the run, bench docked. Same destination, different fate for the bench.
        await frame.locator('[aria-label="Dock the Python bench"]').click();
        await expect(frame.locator(".astep.tool")).toHaveCount(1);
        await expect(frame.locator(".bench-drawer")).toBeVisible();
    } finally { await ext.context.close(); await fake.stop(); }
});

// THE ENVIRONMENT PANEL — what the sandbox actually IS, in both modes. Read from the running interpreter
// rather than from our own manifest: the manifest says what we asked for, and the wheel that installed is
// what the code will import. A panel reporting the first while the second differs is worse than none.
//
// An e2e because that is the only place the real interpreter answers: a unit test would be asserting
// against a fixture of the thing under test.
test("the bench reports the sandbox's real Python and package versions, and filters them", async () => {
    const { fake, ext, frame } = await setup();
    try {
        await frame.locator('[aria-label="Python bench"]').click();
        const env = frame.locator(".bench-env-btn");
        await expect(env).toBeVisible();
        // CLOSED by default and fetched on OPEN: reading it starts the sandbox, which is what a first
        // python_exec pays for — doing that on mount would make every glance at the bench cost a cold start.
        await expect(frame.locator(".bench-env-body")).toHaveCount(0);

        await env.click();
        await expect(frame.locator(".bench-env-body")).toBeVisible();
        // Real versions, from the interpreter. Asserted as SHAPE, not as a literal — pinning "3.14" would
        // make this fail on the next Pyodide bump for no reason.
        await expect(frame.locator(".bench-env-head")).toContainText(/Python\s+3\.\d+/, { timeout: 60000 });
        await expect(frame.locator(".bench-env-head")).toContainText(/Pyodide\s+\d/);

        // Every package the sandbox ships, each with the version that actually installed.
        const rows = frame.locator(".bench-env-list li");
        expect(await rows.count()).toBeGreaterThan(3);
        await expect(frame.locator(".bench-env-list li", { hasText: "pandas" })).toBeVisible();
        await expect(frame.locator(".bench-env-list li", { hasText: "numpy" }).locator(".bench-env-pv"))
            .toHaveText(/\d+\.\d+/, { timeout: 10000 });

        // FILTER. It is about to become the way you find a package to install, so it is a real control now.
        await frame.locator(".bench-env-q").fill("pand");
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toContainText("pandas");
        await frame.locator(".bench-env-q").fill("zzz");
        await expect(frame.locator(".bench-env-list")).toContainText("Nothing matches");

        // What is NOT built is SAID, not drawn as a control that no-ops — you cannot tell one of those from
        // a bug, and you try it twice.
        await expect(frame.locator(".bench-env-soon")).toContainText(/not built yet/);
    } finally { await ext.context.close(); await fake.stop(); }
});

test("the environment panel is there in FULL-page mode too", async () => {
    // It is a property of the bench, not of one of its shapes — you are as likely to want it while writing
    // a long script as a short one.
    const { fake, ext, frame } = await setup();
    try {
        await frame.locator('[aria-label="Python bench"]').click();
        await frame.locator('[aria-label="Expand the Python bench"]').click();
        await expect(frame.locator(".bench-drawer")).toHaveCount(0);
        // The BUTTON is the affordance (it lives in the bench's header row in both shapes); `.bench-env` is
        // now only the panel it opens, and does not exist until it does.
        await expect(frame.locator(".bench-env-btn")).toBeVisible();
        await frame.locator(".bench-env-btn").click();
        await expect(frame.locator(".bench-env-head")).toContainText(/Python\s+3\./, { timeout: 60000 });
    } finally { await ext.context.close(); await fake.stop(); }
});

// ▶ BENCH ON A STEP is the drawer's reason to exist: you press it FROM a step, to compare against that step.
// It used to go straight to the full page — which is exactly the trip the drawer exists to stop, and the
// demo is what caught it. Both openers go through one `openBench` now, and it honours the dock.
test("a step's ▶ bench hands over the script and opens the DRAWER, keeping the step on screen", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
            debugMode: "overlay", autoApprovePython: true,
        });
        fake.setSide(() => null);
        fake.setScript([
            { tool: "python_exec", args: { code: "rows=[{'a':1},{'a':2}]\nreturn len(rows)", mode: "readonly" } },
            { content: "two" },
        ]);
        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1400, height: 950 });
        await page.goto(`${fake.url}/api/version`);
        await waitForMl(page);
        await page.evaluate(() => {
            window.ml.agent("add", { approvalRouting: "both", extraTools: [window.ml.pythonTool()] });
        });
        const frame = await openRunInSidebar(page, { task: "add" });
        for (let i = 0; i < 60; i++) {
            const pending = await ext.sw.evaluate(() => (globalThis.__mlApprovals?.list?.() || []).map((d) => d.key));
            for (const k of pending) await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), k);
            if (await frame.locator(".astep.tool").count()) break;
            await sleep(400);
        }
        const step = frame.locator(".astep").first();
        if (!(await step.locator(".r-py-in").count())) await step.locator(".astep-head").click();
        await step.locator(".code-tool", { hasText: "bench" }).click();

        // THE DRAWER, not the full page — and the step is still there to compare against.
        await expect(frame.locator(".bench-drawer")).toBeVisible();
        await expect(frame.locator(".astep.tool")).toHaveCount(1);
        // It carries exactly what the block DRAWS — the reflowed source. That is the invariant worth
        // asserting rather than any particular spacing: py-format never changes a token, so the reflowed
        // form is the code that ran, and what lands in the bench is what you pressed the button next to.
        const drawn = (await frame.locator(".astep .r-py-in .code").first().innerText()).replace(/\s+$/, "");
        expect(drawn, "the reflow did something, or this test compares two identical strings")
            .not.toBe("rows=[{'a':1},{'a':2}]\nreturn len(rows)");
        await expect(frame.locator(".bench-drawer .bench-code")).toHaveValue(drawn);
    } finally { await ext.context.close(); await fake.stop(); }
});

// THE HANDLE IS CENTRED ON THE ROW. It was briefly centred in the row's LEFTOVER space instead — a flex child
// in the spacer — which put it visibly off to one side, because the name and its controls are far wider than
// the two icons opposite. What forced that arrangement was the pill landing on top of the mode picker, so the
// picker moved to the right group; this pins both halves of that, since fixing either one alone reintroduces
// the other.
test("the drawer's grab handle is centred, and nothing interactive sits under it", async () => {
    const { fake, ext, frame } = await setup();
    try {
        await frame.locator('[aria-label="Python bench"]').click();
        await expect(frame.locator(".bench-drawer")).toBeVisible();
        const geo = await frame.evaluate(() => {
            const row = document.querySelector(".bench-drawer .bench-top");
            const pill = document.querySelector(".bench-drawer .bench-grip-pill");
            if (!row || !pill) return null;
            const r = row.getBoundingClientRect(), p = pill.getBoundingClientRect();
            const mid = r.left + r.width / 2;
            // What the pointer would actually hit at the pill's centre — the pill itself is pointer-events:
            // none, so this is whatever lies beneath it.
            const under = document.elementFromPoint(p.left + p.width / 2, p.top + p.height / 2);
            return { off: Math.abs((p.left + p.width / 2) - mid), rowW: r.width,
                     underTag: under?.tagName ?? "", underCls: (under?.className ?? "").toString() };
        });
        expect(geo, "the drawer draws a handle").not.toBeNull();
        expect(geo.off, `the handle is ${Math.round(geo.off)}px off the row's centre`).toBeLessThanOrEqual(2);
        // …and the row's middle is free, so pressing the handle drags instead of opening a dropdown.
        expect(["SELECT", "OPTION", "INPUT", "BUTTON"], `a control sits under the handle (${geo.underTag}.${geo.underCls})`)
            .not.toContain(geo.underTag);
    } finally { await ext.context.close(); await fake.stop(); }
});

/** Run a script in the bench and wait for it to SETTLE. The signal is the live elapsed readout going away —
 *  it is the pane's own "still running", so its absence is the finish, and it survives the pane having no
 *  footer once settled. (Waiting on the Run button re-enabling would be the same thing read off the header.) */
const runInBench = async (frame, code) => {
    await frame.locator(".bench-code").fill(code);
    await frame.locator(".bench-play").click();
    // …but only once it has actually STARTED, or an immediate check catches the pre-run state.
    for (let i = 0; i < 30 && !(await frame.locator(".bench-outpane").count()); i++) await sleep(100);
    for (let i = 0; i < 100; i++) {
        if (!(await frame.locator(".bench-outpane .r-ranfor.live").count())
            && await frame.locator(".bench-play:not([disabled])").count()) return;
        await sleep(400);
    }
    throw new Error("the bench never produced a result");
};

// THE OUTPUT IS A PANE WITH TABS, not a block stacked under the editor. The log stacks these sections as
// disclosures because a step is a row in a scrolling transcript; the bench is a LOOP, and there the output
// you ran the script to see was arriving COLLAPSED behind two clicks on every single run. Same renderers
// either way — `pyOutSections` is shared, so the two surfaces cannot disagree about what a result HAS.
test("the output pane tabs its sections, and lands you on the value rather than on stdout", async () => {
    const { fake, ext, frame } = await setup();
    try {
        await frame.locator('[aria-label="Python bench"]').click();
        await runInBench(frame, "print('one')\nprint('two')\nreturn {'answer': 42}");

        const tabs = frame.locator(".bench-tab");
        expect(await tabs.allTextContents()).toEqual(["stdout", "value"]);
        await expect(frame.locator(".bench-tab.on"), "the VALUE is what you ran it for").toHaveText("value");
        await expect(frame.locator(".bench-outbody")).toContainText("42");
        // Nothing is folded away: the thing you ran the script to see is on screen, not behind a disclosure.
        await expect(frame.locator(".bench-outbody .r-py-sec")).toHaveCount(0);

        await tabs.filter({ hasText: "stdout" }).click();
        await expect(frame.locator(".bench-outbody")).toContainText("one");
        await expect(frame.locator(".bench-outbody")).toContainText("two");
        await expect(frame.locator(".bench-outbody")).not.toContainText("42");
    } finally { await ext.context.close(); await fake.stop(); }
});

// THE ONE THING TABS ARE WORSE AT than disclosures is that they can hide something with no sign of it. So a
// failure is MARKED and takes the selection — you were looking at the value because that is what you are
// iterating on, and the moment it breaks that is no longer the question.
test("a failure marks its tab and takes the selection; anything else leaves you where you were", async () => {
    const { fake, ext, frame } = await setup();
    try {
        await frame.locator('[aria-label="Python bench"]').click();
        await runInBench(frame, "print('before it broke')\nreturn 1");
        await frame.locator(".bench-tab", { hasText: "stdout" }).click();
        await expect(frame.locator(".bench-tab.on")).toHaveText("stdout");

        // A run that merely printed something must NOT move you off the tab you are working in.
        await runInBench(frame, "print('still fine')\nreturn 2");
        await expect(frame.locator(".bench-tab.on"), "your tab survives the next run").toHaveText("stdout");

        // A failure does.
        await runInBench(frame, "print('before it broke')\nraise ValueError('boom')");
        await expect(frame.locator(".bench-tab.on")).toHaveText("error");
        await expect(frame.locator(".bench-tab.err"), "…and it is marked, so clicking away cannot hide it").toHaveCount(1);
        await expect(frame.locator(".bench-outbody")).toContainText("boom");
        // What it printed on the way there is still one click away, not lost.
        await frame.locator(".bench-tab", { hasText: "stdout" }).click();
        await expect(frame.locator(".bench-outbody")).toContainText("before it broke");
        await expect(frame.locator(".bench-tab.err"), "the mark stays while you read it").toHaveCount(1);
    } finally { await ext.context.close(); await fake.stop(); }
});

// UNTIL YOU RUN IT, THERE IS NO OUTPUT PANE — the editor has the whole bench. An empty pane with a line of
// placeholder in it is chrome promising something it does not have, and it takes half the room you came here
// to write in. It arrives on ▶ (carrying "running…", which is the feedback that moment needs) and stays.
test("the output pane arrives with the first run, and the editor has the bench until then", async () => {
    const { fake, ext, frame } = await setup();
    try {
        await frame.locator('[aria-label="Python bench"]').click();
        await expect(frame.locator(".bench-code")).toBeVisible();
        await expect(frame.locator(".bench-outpane"), "nothing to show, so nothing is shown").toHaveCount(0);
        await expect(frame.locator(".bench-div"), "…and nothing to divide either").toHaveCount(0);

        const wholeBench = (await frame.locator(".bench-split").boundingBox()).height;
        const editorAlone = (await frame.locator(".bench-code").boundingBox()).height;
        expect(editorAlone / wholeBench, "the editor has all of it").toBeGreaterThan(0.9);

        await runInBench(frame, "print('now there is something')");
        await expect(frame.locator(".bench-outpane")).toBeVisible();
        await expect(frame.locator(".bench-div")).toBeVisible();
        expect((await frame.locator(".bench-code").boundingBox()).height).toBeLessThan(editorAlone);
    } finally { await ext.context.close(); await fake.stop(); }
});

// FULL-PAGE IS THE SAME COMPONENT — one `PythonBench`, one output renderer. The drawer only injects its grip
// and shape controls into the shared header, and full-page takes its height from the view instead. Worth
// pinning because "the other mode renders it differently" is exactly the drift a shared component prevents.
test("full-page draws the same tabbed output pane the drawer does", async () => {
    const { fake, ext, frame } = await setup();
    try {
        await frame.locator('[aria-label="Python bench"]').click();
        await frame.locator('[aria-label="Expand the Python bench"]').click();
        await expect(frame.locator(".bench-drawer")).toHaveCount(0);

        await runInBench(frame, "print('one')\nreturn {'answer': 42}");
        expect(await frame.locator(".bench-tab").allTextContents()).toEqual(["stdout", "value"]);
        await expect(frame.locator(".bench-tab.on")).toHaveText("value");
        await expect(frame.locator(".bench-div")).toBeVisible();
        // …and it is using the VIEW's height rather than its content's, or the divider has nothing to divide.
        const split = await frame.locator(".bench-split").boundingBox();
        expect(split.height, "the split is given the page's height").toBeGreaterThan(300);
    } finally { await ext.context.close(); await fake.stop(); }
});

// THE DIVIDER sizes the two panes against each other. A RATIO, not a pixel height: the bench is itself
// resizable (the drawer's edge, and the panel it lives in), so pinning the editor to pixels would let a
// shorter drawer eat the whole output pane.
test("the divider resizes the script against its output, and the ratio is remembered", async () => {
    const { fake, ext, page, frame } = await setup();
    try {
        await frame.locator('[aria-label="Python bench"]').click();
        await runInBench(frame, "print('hello')");
        const before = (await frame.locator(".bench-code").boundingBox()).height;

        const d = await frame.locator(".bench-div").boundingBox();
        await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
        await page.mouse.down();
        await page.mouse.move(d.x + d.width / 2, d.y - 70, { steps: 8 });
        await page.mouse.up();
        await sleep(300);
        const after = (await frame.locator(".bench-code").boundingBox()).height;
        expect(after, `expected the editor to shrink from ${before}`).toBeLessThan(before - 30);
        // …and the output took the room, rather than the drawer growing.
        expect((await frame.locator(".bench-drawer").boundingBox()).height).toBeCloseTo(
            (await frame.locator(".bench-drawer").boundingBox()).height, 0);

        // It is a workspace you leave set up: the ratio survives a reload. It has to be RUN again first —
        // a fresh bench has no result and therefore no output pane at all, so the editor is full height
        // until there is something to divide it with.
        await page.reload();
        const frame2 = await openRunInSidebar(page, { task: "read the page" });
        await expect(frame2.locator(".bench-code")).toBeVisible({ timeout: 15000 });
        await runInBench(frame2, "print('hello')");
        const restored = (await frame2.locator(".bench-code").boundingBox()).height;
        expect(Math.abs(restored - after)).toBeLessThan(14);
    } finally { await ext.context.close(); await fake.stop(); }
});

// THE DIVIDER IS ONE LINE AND A HANDLE. It drew its own hairline for a while, a few pixels under the
// editor's own bottom border, which put TWO rules across the bench with the pill stranded between them
// belonging to neither. And the pill's offset is SET rather than left to fall out of centring — centred it
// read as sitting ON the border, and the space above it read as padding the textarea had grown.
test("the divider draws no second rule, and its pill sits a set 4px below the editor", async () => {
    const { fake, ext, frame } = await setup();
    try {
        await frame.locator('[aria-label="Python bench"]').click();
        await runInBench(frame, "print('hello')");
        const geo = await frame.evaluate(() => {
            const ta = document.querySelector(".bench-code").getBoundingClientRect();
            const pill = document.querySelector(".bench-div-pill").getBoundingClientRect();
            const div = document.querySelector(".bench-div");
            const before = getComputedStyle(div, "::before");
            return { gap: pill.top - ta.bottom, rule: before.content, bg: before.backgroundColor };
        });
        expect(geo.gap, `the pill hangs 4px under the editor's border, got ${geo.gap}`).toBeGreaterThan(3);
        expect(geo.gap).toBeLessThan(6);
        // No second rule: the editor's own border is the line, and a `::before` here would double it.
        expect(geo.rule === "none" || geo.bg === "rgba(0, 0, 0, 0)").toBe(true);
    } finally { await ext.context.close(); await fake.stop(); }
});

// THE SELECTED SECTION FILLS THE PANE. A short box floating in a tall empty pane reads as output that got
// cut off — and the divider is where you already said how much room you wanted, so a second cap here would
// be the pane arguing with the gesture that sized it.
test("the output fills its pane — text and a DataFrame alike — and the table loses its collapse control", async () => {
    const { fake, ext, frame } = await setup();
    try {
        await frame.locator('[aria-label="Python bench"]').click();
        await runInBench(frame, "print('a line')\nreturn 1");
        const fill = async (sel) => {
            const body = await frame.locator(".bench-outbody").boundingBox();
            const inner = await frame.locator(sel).boundingBox();
            return inner.height / body.height;
        };
        expect(await fill(".bench-outbody .r-outcell"), "a one-line value still fills the pane").toBeGreaterThan(0.8);

        await runInBench(frame, "import pandas as pd\nprint('built it')\nreturn pd.DataFrame({'a': [1, 2], 'b': [3, 4]})");
        await expect(frame.locator(".bench-tab.on"), "a returned frame is a real table, not a JSON blob").toHaveText("value (DataFrame)");
        await expect(frame.locator(".bench-outbody .r-df-table")).toBeVisible();
        expect(await fill(".bench-outbody .r-df"), "so does a table").toBeGreaterThan(0.8);
        // Collapsing is for a LOG, where a wide table sits in a transcript you are reading past. Here the tab
        // strip already decides what is on screen, so a "hide table" undoes the choice you just made with it.
        await expect(frame.locator(".bench-outbody .r-df-btn", { hasText: /hide|show/ })).toHaveCount(0);
        await expect(frame.locator(".bench-outbody .r-df-btn", { hasText: "copy CSV" }), "copy stays — that one does something").toHaveCount(1);
        // …at the pane's BOTTOM RIGHT. Alone above the grid it was the least important thing in the pane
        // sitting in the most prominent place, with a whole row to itself.
        const copy = await frame.locator(".bench-outbody .r-df-btn", { hasText: "copy CSV" }).boundingBox();
        const grid = await frame.locator(".bench-outbody .r-df-scroll").boundingBox();
        const pane = await frame.locator(".bench-outbody").boundingBox();
        expect(copy.y, "below the grid, not above it").toBeGreaterThan(grid.y + grid.height - 1);
        expect(copy.y + copy.height, "…at the bottom of the pane").toBeGreaterThan(pane.y + pane.height - 40);
        expect(copy.x + copy.width, "…and to the right").toBeGreaterThan(pane.x + pane.width - 60);
    } finally { await ext.context.close(); await fake.stop(); }
});

// LIVE STDOUT — the SAME worker tee the model-invoked `python_exec` gets, painting a different widget. The
// interesting part is the last hop: the SW relays a page's chunks through that tab's content script, and the
// bench is an extension iframe INSIDE a tab, so it HAS a `sender.tab` and would have had its own output
// posted to the page instead. The discriminator is the sending FRAME's url, which Chrome sets.
test("the bench streams stdout as the script runs, and the value supersedes it at the end", async () => {
    const { fake, ext, frame } = await setup();
    try {
        await frame.locator('[aria-label="Python bench"]').click();
        // Warm the sandbox first: a cold start is seconds of nothing, which would make this test about
        // Pyodide's download rather than about the tee.
        await runInBench(frame, "print('warm')");

        await frame.locator(".bench-code").fill(
            "import time\nprint('FIRST')\ntime.sleep(2)\nprint('SECOND')\nreturn {'answer': 42}");
        await frame.locator(".bench-play").click();

        // MID-RUN: the first line is on screen while the script is still sleeping, and the run is visibly
        // alive. If this only arrived at the end the assertion below would still pass, so the elapsed
        // "running…" readout is what pins that this is genuinely mid-flight.
        await expect(frame.locator(".bench-outbody")).toContainText("FIRST", { timeout: 8000 });
        await expect(frame.locator(".bench-outbody"), "…and the rest has not happened yet").not.toContainText("SECOND");
        await expect(frame.locator(".bench-outpane .r-ranfor.live")).toBeVisible();

        // SETTLED: the real result supersedes the live stdout, and the value is what you land on — the
        // streaming pass must not leave you pinned to stdout, since you never chose it.
        await expect(frame.locator(".bench-outpane .r-ranfor.live")).toHaveCount(0, { timeout: 20000 });
        expect(await frame.locator(".bench-tab").allTextContents()).toEqual(["stdout", "value"]);
        await expect(frame.locator(".bench-tab.on"), "an auto-pick never sticks — only a click does").toHaveText("value");
        await expect(frame.locator(".bench-outbody")).toContainText("42");
        await frame.locator(".bench-tab", { hasText: "stdout" }).click();
        await expect(frame.locator(".bench-outbody")).toContainText("FIRST");
        await expect(frame.locator(".bench-outbody")).toContainText("SECOND");
    } finally { await ext.context.close(); await fake.stop(); }
});

// A PLACEHOLDER THAT SAYS SO. Handing a script you just got working to the model is the obvious next move
// and it is not built; drawn rather than omitted so the row's shape is settled, DISABLED rather than
// live-but-inert, because an affordance that silently does nothing cannot be told from a bug.
test("the send-to-model button is present and disabled, and says it is unbuilt", async () => {
    const { fake, ext, frame } = await setup();
    try {
        await frame.locator('[aria-label="Python bench"]').click();
        const send = frame.locator(".bench-send");
        await expect(send).toBeVisible();
        await expect(send).toBeDisabled();
        await expect(send.locator(".tt-pop")).toContainText(/not built yet/i);
        // To the RIGHT of Run, which is the live one.
        const play = await frame.locator(".bench-play").boundingBox();
        expect((await send.boundingBox()).x).toBeGreaterThan(play.x);
    } finally { await ext.context.close(); await fake.stop(); }
});

// NO STRIP OF THE DRAWER'S OWN GROUND BETWEEN THE HEADER AND THE EDITOR. The bench is a flex column with a
// `gap`, and the gap applied after the header too — so the drawer's background showed through between two
// panel-coloured surfaces. In the dark theme that is invisible; in the light one it is a white bar across the
// drawer, which is how it shipped. Geometry is the pin: touching means nothing can show through, whatever the
// two surfaces are painted.
test("the bench header sits flush on the editor, with no band of the drawer showing between", async () => {
    const { fake, ext, frame } = await setup();
    try {
        await frame.locator('[aria-label="Python bench"]').click();
        await expect(frame.locator(".bench-code")).toBeVisible();
        const gap = await frame.evaluate(() => {
            const top = document.querySelector(".bench-top").getBoundingClientRect();
            const code = document.querySelector(".bench-code").getBoundingClientRect();
            return code.top - top.bottom;
        });
        expect(gap, "the editor starts where the header ends").toBeLessThanOrEqual(1);
        expect(gap, "…and does not overlap it either").toBeGreaterThanOrEqual(-1);
    } finally { await ext.context.close(); await fake.stop(); }
});

// THE ENVIRONMENT PANEL OPENS DOWNWARD, UNDER ITS BUTTON. There were two `.bench-env` rules for a while —
// one from when the button lived in a bar at the BOTTOM, anchoring the panel with `bottom: calc(100% + 5px)`
// so it opened upward out of that bar — and the later one won. With the button now in the header at the TOP,
// the panel opened off the top of the drawer. A duplicate selector is invisible in review and decided by
// source order, so this pins the OUTCOME rather than the rule.
test("the environment panel opens below its button, on screen, with the chevron turned", async () => {
    const { fake, ext, frame } = await setup();
    try {
        await frame.locator('[aria-label="Python bench"]').click();
        const btn = frame.locator(".bench-env-btn");
        await expect(btn).toBeVisible();
        await btn.click();
        await expect(frame.locator(".bench-env-body")).toBeVisible({ timeout: 60000 });

        const geo = await frame.evaluate(() => {
            const b = document.querySelector(".bench-env-btn").getBoundingClientRect();
            const p = document.querySelector(".bench-env").getBoundingClientRect();
            const tri = document.querySelector(".bench-env-btn .tri");
            return { belowButton: p.top >= b.top, onScreen: p.top >= 0 && p.left >= 0,
                     within: p.bottom <= window.innerHeight + 1,
                     turned: getComputedStyle(tri).transform };
        });
        expect(geo.belowButton, "the panel hangs UNDER the button, not above it").toBe(true);
        expect(geo.onScreen, "…and is not off the top or left of the frame").toBe(true);
        expect(geo.within, "…nor hanging out of the bottom").toBe(true);
        // The chevron says the disclosure is open. Its selector used to reach DOWN from `.bench-env`, which
        // no longer contains the button — so it silently stopped turning.
        expect(geo.turned, "the chevron turns when it is open").not.toBe("none");

        // It does not push the editor: opening it must not move the code you opened it to compare against.
        const before = await frame.locator(".bench-code").boundingBox();
        await btn.click();
        await expect(frame.locator(".bench-env-body")).toHaveCount(0);
        const after = await frame.locator(".bench-code").boundingBox();
        expect(Math.abs(after.y - before.y), "the editor stays put whether the panel is open or shut").toBeLessThanOrEqual(1);
    } finally { await ext.context.close(); await fake.stop(); }
});
