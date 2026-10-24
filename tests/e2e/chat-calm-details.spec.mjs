// chat-calm-details.spec.mjs — small things the calm chat page gets right or visibly wrong: the transcript's measure
// against the composer's, the send hint that retires once a device knows the keys, the start page's tab list kept
// current and its last pick remembered, and how a tool call arrives in a group that is folding or open.
//
// Against dist-web/ and the fake host's demo world, like chat-web.spec.mjs (whose `open` this repeats: a spec file
// shares no helpers with another).
import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./static-server.mjs";

const ROOT = path.resolve(process.env.E2E_DIST_WEB || "dist-web");
const DESKTOP = { width: 1280, height: 800 };
const CHAT = "laptop:7b21d4e8";

let server, browser;
test.beforeAll(async () => {
    test.skip(!fs.existsSync(path.join(ROOT, "chat.js")), `no web build at ${ROOT} (npm run build)`);
    server = await serveStatic(ROOT);
    browser = await chromium.launch({ channel: "chromium" });
});
test.afterAll(async () => { await browser?.close(); server?.close(); });

/** A fresh page, failing the test on any page error; `prefs` seeds this device's stored preferences before the first
 *  paint, as `wml-chat:<key>` in localStorage, which is where the web adapter keeps them. */
async function open(hash = "", prefs = null) {
    const page = await browser.newPage({ viewport: DESKTOP });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    if (prefs) await page.addInitScript((p) => {
        // Only where nothing is stored yet: this runs again on a reload, which must find what the page wrote.
        for (const [k, v] of Object.entries(p)) { try { if (localStorage.getItem("wml-chat:" + k) == null) localStorage.setItem("wml-chat:" + k, JSON.stringify(v)); } catch { /* no storage */ } }
    }, prefs);
    await page.goto(server.url + hash);
    await page.locator(".chat").waitFor();
    return { page, errors };
}
const commands = (page) => page.evaluate(() => globalThis.__chatFake.commands);
const width = (loc) => loc.evaluate((el) => el.getBoundingClientRect().width);

// --- two measures: the conversation a little wider than the box you write in ---

test("the transcript's column is 708px and the composer's box stays 672px, inside it on both sides", async () => {
    const { page, errors } = await open(`#/s/${encodeURIComponent(CHAT)}`);
    const column = page.locator(".chat-transcript > div").first();
    const box = page.locator(".composer-row");
    await expect(box).toBeVisible();
    expect(await width(column)).toBe(708);
    expect(await width(box)).toBe(672);
    // Not "the same centre": a classic scrollbar takes its width out of the transcript's scroller and not the composer's,
    // which moves one centre by half of it. What the eye reads is the box resting inside the column.
    const edges = (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return [r.left, r.right]; });
    const [[cl, cr], [bl, br]] = [await edges(column), await edges(box)];
    expect(cl).toBeLessThan(bl);
    expect(cr).toBeGreaterThan(br);
    expect(errors).toEqual([]);
    await page.close();
});

// --- the send hint: said until this device has shown it knows the keys ---

test("the composer's hint is not drawn again once Enter has sent and Shift+Enter has broken a line, and the send button teaches nothing", async () => {
    // One send short of knowing the keys (view-mode.tsx `knowsKeys`): three sends by Enter and one Shift+Enter.
    const { page, errors } = await open(`#/s/${encodeURIComponent(CHAT)}`, { "view.keys": { sends: 2, newlines: 1 } });
    const hint = page.locator(".composer-foot .chint");
    const input = page.locator(".composer .cinput");
    await expect(hint).toBeVisible();

    // The BUTTON is not the keys: a send by click leaves the hint where it was, back once the box empties.
    await input.fill("sent by the button");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(input).toHaveValue("");
    await expect(hint).toBeVisible();

    await input.fill("sent by Enter");
    await input.press("Enter");
    await expect(input).toHaveValue("");
    // Learned: the emptied box does not bring it back, and it gives up its width as it does while typing.
    await expect(hint).toBeHidden();
    await expect.poll(() => width(hint)).toBe(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("wml-chat:view.keys")))).toEqual({ sends: 3, newlines: 1 });

    // A reload does not draw it at all.
    await page.reload();
    await expect(page.locator(".composer-row")).toBeVisible();
    await expect(page.locator(".chint")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.close();
});

test("the start page's hint says only how the box sends, and fades where it stands once the keys are known", async () => {
    const { page, errors } = await open("", { "view.keys": { sends: 3, newlines: 0 } });
    const hint = page.locator(".chat-start-hint");
    await expect(hint).toHaveText("Enter to start · Shift+Enter for a new line");
    const before = await hint.evaluate((el) => el.getBoundingClientRect().height);

    const box = page.locator(".chat-start-box textarea");
    await box.fill("first line");
    await box.press("Shift+Enter");
    await expect(hint).toHaveClass(/\bretired\b/);
    await expect.poll(() => hint.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
    // It keeps its line: the column is centred, and a line folding away under the box would carry the box with it.
    expect(await hint.evaluate((el) => el.getBoundingClientRect().height)).toBe(before);

    await page.reload();
    await expect(page.locator(".chat-start-box textarea")).toBeVisible();
    await expect(page.locator(".chat-start-hint")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.close();
});

// --- the start page's tabs: current when you come back, and the last pick offered again ---

test("a tab opened while away is asked for when the page has focus again, without moving the choice", async () => {
    const { page, errors } = await open();
    const pill = page.getByRole("button", { name: /^Where it runs/ });
    await expect(pill).toContainText("The front page");
    const asks = async () => (await commands(page)).filter((c) => c.type === "tabs.list").length;
    const was = await asks();

    // Opening a tab means leaving this one, so coming back is what asks.
    await page.evaluate(() => {
        globalThis.__chatFake.tabs.push({ tabId: 501, windowId: 1, title: "Opened while away", url: "https://away.example/", active: true });
        window.dispatchEvent(new Event("focus"));
    });
    await expect.poll(asks).toBe(was + 1);
    await expect(pill).toContainText("The front page");
    await pill.click();
    await expect(page.getByRole("listbox", { name: "Where it runs" }).getByRole("option", { name: /Opened while away/ })).toBeVisible();
    expect(errors).toEqual([]);
    await page.close();
});

test("the tab picked last is the start page's choice again after a reload, and so is a new tab", async () => {
    const { page, errors } = await open();
    const pill = page.getByRole("button", { name: /^Where it runs/ });
    const list = page.getByRole("listbox", { name: "Where it runs" });
    await expect(pill).toContainText("The front page");
    await pill.click();
    await list.getByRole("option", { name: /Your cart/ }).click();
    await expect(pill).toContainText("Your cart");

    await page.reload();
    await expect(pill).toContainText("Your cart");
    await page.locator(".chat-start-box textarea").fill("check the cart");
    await page.locator(".chat-start-box textarea").press("Enter");
    const cart = await page.evaluate(() => globalThis.__chatFake.tabs.find((t) => /Your cart/.test(t.title)).tabId);
    await expect.poll(async () => (await commands(page)).at(-1)).toMatchObject({ type: "agent.start", target: { kind: "tab", tabId: cart } });

    await page.locator(".chat-list .chat-start").click();
    await pill.click();
    await list.getByRole("option", { name: "New tab" }).click();
    await page.reload();
    await expect(pill).toContainText("New tab");
    expect(errors).toEqual([]);
    await page.close();
});

// --- a call arriving in a group: the group's motion for its own rows, a call's own slide for one that joins ---

const RUN = "laptop:9a8b7c6d";

/** Open a running agent session of our own, with "group all" on (the default). */
async function liveRun() {
    const { page, errors } = await open();
    await page.evaluate((key) => {
        const [runtime, hash] = key.split(":");
        const now = Date.now();
        globalThis.__chatFake.addSession(
            { id: { runtime, hash }, kind: "agent", status: "running", createdTs: now, lastTs: now, pendingApprovals: 0, saved: true, title: "Live", task: "x", model: "qwen3:32b" },
            [{ id: `${hash}-0`, ts: now, save: true, session: { hash, turn: 0 }, kind: "agent", task: "x", model: "qwen3:32b", maxSteps: 30, config: undefined }]);
    }, RUN);
    await page.goto(server.url + `#/s/${encodeURIComponent(RUN)}`);
    await page.locator(".chat-transcript").waitFor();
    /** One call as a run sends it: a pending START, then its DONE under the same seq. */
    const call = async (n, doneAfter = 300) => {
        const emit = (over) => page.evaluate(([key, n, over]) => {
            const hash = key.split(":")[1];
            globalThis.__chatFake.emit(key, { id: `${hash}-0`, ts: Date.now(), save: true, session: { hash, turn: 0 }, kind: "agent-step",
                step: n, seq: n, tool: n % 2 ? "exec" : "look", approval: "readonly", arguments: { js: "1" }, reasoning: "Checking.", reasoningTokens: 9, ...over });
        }, [RUN, n, over]);
        await emit({ pending: true });
        await page.waitForTimeout(doneAfter);
        await emit({ pending: false, result: "ok", toolMs: 200 });
    };
    /** Every animation running in the transcript while `during` runs and for `ms` after, as `name@first-class`, sampled
     *  each frame in the page (a long-lived evaluate promise can be collected before it settles). */
    const animationsFor = async (ms, during) => {
        await page.evaluate(() => {
            const seen = globalThis.__seen = new Set();
            const tick = () => {
                for (const a of document.querySelector(".chat-transcript").getAnimations({ subtree: true }))
                    if (a.animationName) seen.add(`${a.animationName}@${a.effect.target.classList[0]}`);
                if (globalThis.__seen === seen) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
        await during();
        await page.waitForTimeout(ms);
        return page.evaluate(() => { const s = [...globalThis.__seen]; globalThis.__seen = null; return s; });
    };
    return { page, errors, call, animationsFor };
}

test("a group forming over rows already on screen collapses them without playing their entrance again", async () => {
    const { page, errors, call, animationsFor } = await liveRun();
    await call(1);
    await page.waitForTimeout(1200);   // long enough on screen to have been read (`FOLD_SEEN_MS`)
    const seen = await animationsFor(500, () => call(2, 100));
    expect(seen).toContain("chat-step-close@astreak-body");
    // The row being folded was on screen already: it must not blink out and drift back in under the collapse.
    expect(seen).not.toContain("chat-turn-in@aturn");
    expect(seen).not.toContain("chat-tool-in@astep");
    await expect(page.locator(".astreak .astreak-calls")).toHaveText("2 tool calls");
    expect(errors).toEqual([]);
    await page.close();
});

test("a call joining an OPEN group slides in from the left; the rows it was opened with stay still", async () => {
    const { page, errors, call, animationsFor } = await liveRun();
    await call(1);
    await page.waitForTimeout(1200);
    await call(2);
    await page.waitForTimeout(800);
    await page.locator(".astreak-head").click();
    await expect(page.locator(".astreak-body .astep.tool")).toHaveCount(2);
    await page.waitForTimeout(400);

    const seen = await animationsFor(300, () => call(3, 200));
    await expect(page.locator(".astreak-body .astep.tool")).toHaveCount(3);
    expect(seen).toContain("chat-tool-in@astep");
    // Only the new row: the two the group was opened with are its own and do not move.
    const fresh = page.locator(".astreak-body .astep.tool.fresh");
    await expect(fresh).toHaveCount(1);
    await expect(page.locator(".astreak-body .astep.tool").last()).toHaveClass(/\bfresh\b/);
    // The slide is from the LEFT and from nothing, on the arrival curve.
    const from = await page.evaluate(() => {
        const rule = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
            .find((r) => r instanceof CSSKeyframesRule && r.name === "chat-tool-in");
        const f = rule.cssRules[0].style;
        return { opacity: f.opacity, transform: f.transform };
    });
    expect(from.opacity).toBe("0");
    expect(from.transform).toMatch(/^translateX\(-\d+px\)$/);
    expect(errors).toEqual([]);
    await page.close();
});
