// chat-expand-snap.spec.mjs — expanding a tool step or a group of calls in the calm chat, sampled on every animation frame, over the
// chat page's web build (dist-web/, the fake host: no extension, no model).
//
// Two faults were one or two frames long, which no assertion on a settled state can see:
//  - A STEP opened on `height: 0 → auto` under `overflow: hidden`, and the body's floated `@tool:` chip row was inside it; when the
//    animation ended `overflow` went back to `visible`, the float fell out of the body's height and the step lost 22px in one frame.
//  - A GROUP did the same with the 26px under its last row (a margin that collapses out of an unclipped body), and its rows' titles
//    faded in from opacity 0 under a body that was already open, so the second frame was bare rows.
// So each test reads the layout every frame and asserts on its SHAPE: the height only grows while it opens, the last animated
// frame is the settled height, and a title is drawn at full strength on every frame the group has rows.

import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./static-server.mjs";
import { runsOf } from "./frame-runs.mjs";

const ROOT = path.resolve(process.env.E2E_DIST_WEB || "dist-web");
const KEY = "laptop:5e6f7a80", HASH = "5e6f7a80";

let server, browser;
test.beforeAll(async () => {
    test.skip(!fs.existsSync(path.join(ROOT, "chat.js")), `no web build at ${ROOT} (npm run build:all)`);
    server = await serveStatic(ROOT);
    browser = await chromium.launch({ channel: "chromium" });
});
test.afterAll(async () => { await browser?.close(); server?.close(); });

// A screenshot result: an image with a size of its own, so the body has something taller than a line to open onto.
const SHOT = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#8ab"/></svg>').toString("base64")}`;
const execStep = (seq, title, token) => ({
    tool: "exec", seq, step: seq, arguments: { js: `document.title.length + ${seq}`, title }, result: `console:\nline ${seq}\n\nvalue: ${seq}`,
    token, approval: "readonly", toolMs: 40,
    renderIn: { type: "code", text: `document.title.length + ${seq}`, lang: "javascript" },
    renderOut: { type: "exec-out", stdout: Array.from({ length: 6 }, (_, i) => `line ${seq}.${i}`).join("\n"), seen: 40, value: String(seq) },
});
const STEPS = [
    execStep(900, "Read the title", "a900001"),
    { tool: "pageInfo", seq: 901, step: 901, arguments: {}, result: "URL: https://example.com/" },
    { tool: "look", seq: 902, step: 902, arguments: { title: "See the page" }, result: "Screenshot of the viewport captured.", token: "b900002", toolMs: 40, renderOut: { type: "image", src: SHOT, label: "viewport" } },
    { tool: "pageInfo", seq: 903, step: 903, arguments: {}, result: "URL: https://example.com/" },
    execStep(904, "Survey the comments", "c900004"), execStep(905, "Count the authors", "c900005"), execStep(906, "Quote the code", "c900006"),
];

async function openSession() {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem("wml-chat:view.groupAll", JSON.stringify(false)));
    await page.goto(server.url);
    await page.locator(".chat").waitFor();
    await page.evaluate(({ steps, key, hash }) => {
        const now = Date.now();
        steps.forEach((s, i) => globalThis.__chatFake.emit(key, { kind: "agent-step", id: `${hash}-x${i}`, ts: now + i, save: true, session: { hash, turn: 0 }, ...s }));
    }, { steps: STEPS, key: KEY, hash: HASH });
    await page.goto(`${server.url}#s=${encodeURIComponent(KEY)}`);
    await page.locator('[data-astep-seq="900"]').waitFor();
    return { page, errors };
}

/** Click `clickSel` and record every frame of `rootSel` for `ms`: its height, whether its body is animating, and each title's display and opacity. */
async function sampleClick(page, rootSel, clickSel, ms = 800) {
    await page.evaluate(([rootSel, ms]) => {
        window.__fr = [];
        const t0 = performance.now();
        const tick = () => {
            const el = document.querySelector(rootSel);
            const body = el?.querySelector(":scope > .astep-body, :scope > .astreak-body");
            window.__fr.push({
                t: performance.now() - t0, h: el ? el.getBoundingClientRect().height : null, hasBody: !!body,
                animating: !!body && body.getAnimations().some((a) => a.playState === "running"),
                said: [...(el?.querySelectorAll(".astep-said") ?? [])].map((x) => { const c = getComputedStyle(x); return { display: c.display, opacity: +c.opacity }; }),
            });
            if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }, [rootSel, ms]);
    await page.locator(clickSel).click();
    await page.waitForTimeout(ms + 300);
    return (await page.evaluate(() => window.__fr)).filter((f) => f.h != null);
}

const fmt = (frames) => frames.map((f) => `${Math.round(f.t)}ms h=${f.h.toFixed(1)} body=${f.hasBody} anim=${f.animating} said=${f.said.map((s) => `${s.display}/${s.opacity.toFixed(2)}`).join(",")}`).join("\n");

/** What an expand must look like: it grows over time, never overshoots, and its last animated frame is the settled height. */
function expectCleanOpen(frames, what) {
    const dump = `${what}\n${fmt(frames)}`;
    const animated = frames.filter((f) => f.animating);
    expect(animated.length, `${what}: the body never animated\n${dump}`).toBeGreaterThan(3);
    for (let i = 1; i < frames.length; i++) expect(frames[i].h, `${what}: the height shrank ${frames[i - 1].h.toFixed(1)} → ${frames[i].h.toFixed(1)} at ${Math.round(frames[i].t)}ms\n${dump}`).toBeGreaterThanOrEqual(frames[i - 1].h - 1);
    // No frame is taller than where it settles. Not "the last animated frame EQUALS the settled height": at a loaded
    // runner's 30 frames a second the last sampled frame is still a few px short of the end (463.5 of 465.6), which is
    // growth, not a snap. The snap this guards against was an OVERSHOOT (482.9, then 460.8 in one frame).
    const settled = frames.at(-1).h;
    for (const f of frames) expect(f.h, `${what}: ${f.h.toFixed(1)}px at ${Math.round(f.t)}ms is taller than the ${settled.toFixed(1)}px it settled at\n${dump}`).toBeLessThanOrEqual(settled + 1);
    const runs = runsOf(frames.map((f) => ({ t: f.t, v: f.h })), 1).filter((r) => r.total > 40);
    expect(runs.length, `${what}: the height never changed\n${dump}`).toBeGreaterThan(0);
    for (const r of runs) expect(r.maxStep, `${what}: one frame moved ${Math.round(r.maxStep)}px of a ${Math.round(r.total)}px change\n${dump}`).toBeLessThanOrEqual(r.total * 0.7);
}

// --- A: a step opens onto the height it settles at ---

test("expanding an exec step, a look step with a screenshot and a step inside a group: no frame is taller than the settled step", async () => {
    test.setTimeout(60_000);
    const { page, errors } = await openSession();
    for (const seq of [900, 902]) {
        const sel = `[data-astep-seq="${seq}"]`;
        const frames = await sampleClick(page, sel, `${sel} > .astep-head`);
        expect(frames.some((f) => f.hasBody), `step ${seq} never opened`).toBe(true);
        expectCleanOpen(frames, `step ${seq}`);
        await page.locator(`${sel} > .astep-head`).click();     // fold it again
        await page.waitForFunction((s) => !document.querySelector(`${s} > .astep-body`), sel, { timeout: 5000 });
    }
    // Inside an open group.
    const group = page.locator(".astreak").filter({ has: page.locator(".astreak-tool", { hasText: "exec" }) }).last();
    await group.locator(".astreak-head").click();
    await expect(page.locator('[data-astep-seq="905"]')).toBeVisible();
    await page.waitForTimeout(500);
    const sel = '[data-astep-seq="905"]';
    expectCleanOpen(await sampleClick(page, sel, `${sel} > .astep-head`), "step 905 inside a group");
    expect(errors).toEqual([]);
    await page.close();
});

// --- B: a group opens onto its settled height, and its rows' titles are there from the first frame ---

test("expanding a group of calls: the rows' titles are drawn at full strength on every frame, and the height grows to the settled one", async () => {
    test.setTimeout(60_000);
    const { page, errors } = await openSession();
    const group = page.locator(".astreak").filter({ has: page.locator(".astreak-tool", { hasText: "exec" }) }).last();
    await expect(group).toBeVisible();
    await page.evaluate(() => { const g = [...document.querySelectorAll(".astreak")].at(-1); g.setAttribute("data-snap-group", ""); });
    const frames = await sampleClick(page, ".astreak[data-snap-group]", ".astreak[data-snap-group] > .astreak-head");
    const withRows = frames.filter((f) => f.hasBody);
    expect(withRows.length, `the group never drew its rows\n${fmt(frames)}`).toBeGreaterThan(5);
    for (const f of withRows) {
        expect(f.said.length, `a frame had no titles\n${fmt(frames)}`).toBe(3);
        for (const s of f.said) {
            expect(s.display, `a title was not displayed at ${Math.round(f.t)}ms\n${fmt(frames)}`).not.toBe("none");
            expect(s.opacity, `a title was faded at ${Math.round(f.t)}ms\n${fmt(frames)}`).toBeGreaterThanOrEqual(0.99);
        }
    }
    expectCleanOpen(frames, "the group");
    expect(errors).toEqual([]);
    await page.close();
});
