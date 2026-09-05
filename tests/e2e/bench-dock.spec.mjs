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
        await drawer.locator(".bench-run").click();
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

        // BACK is a RETURN. Landing on the sessions list is the thing that made the bench feel like a trip
        // away from your work, and it is what this test exists to stop coming back.
        await frame.locator(".nav").click();
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
