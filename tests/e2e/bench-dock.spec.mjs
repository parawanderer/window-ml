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
        const grip = frame.locator(".bench-grip");
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
