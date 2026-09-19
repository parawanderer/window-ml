// THE CHAT PAGE AS A PLAIN WEB PAGE: dist-web/ served over http, in a browser with NO extension loaded, against the
// fake host's demo world (src/chat/demo-world.ts). Run at a phone's width and a desktop's, because the layout is the
// thing that differs and the transcript is the thing that must not (docs/spec/CHAT_PAGE.md §Testing both places).
//
// The page is driven through its own UI, and the fake host is read back through `window.__chatFake`: what command
// did the approve button send, and did the transcript change because the runtime said so.
import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./static-server.mjs";

const ROOT = path.resolve(process.env.E2E_DIST_WEB || "dist-web");

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const WAITING = "laptop:3f9a0c21", CHAT = "laptop:7b21d4e8", WATCHED = "lab-box:1d2e3f40", CAPPED = "laptop:c0ffee12";

let server, browser;
test.beforeAll(async () => {
    test.skip(!fs.existsSync(path.join(ROOT, "chat.js")), `no web build at ${ROOT} (npm run build)`);
    server = await serveStatic(ROOT);
    browser = await chromium.launch({ channel: "chromium" });
});
test.afterAll(async () => { await browser?.close(); server?.close(); });

/** A fresh page at a viewport, failing the test on any page error. */
async function open(viewport, hash = "") {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(server.url + hash);
    await page.locator(".chat").waitFor();
    return { page, errors };
}
const row = (page, key) => page.locator(`.chat-row[data-session="${key}"]`);
const commands = (page) => page.evaluate(() => globalThis.__chatFake.commands);

test("it runs with no extension: no chrome global, and the bundle loaded nothing that needs one", async () => {
    const { page, errors } = await open(DESKTOP);
    expect(await page.evaluate(() => typeof globalThis.chrome?.runtime)).toBe("undefined");
    await expect(row(page, WAITING)).toBeVisible();
    expect(errors).toEqual([]);
    await page.close();
});

test("phone: the list first, a session on its own, approve through the runtime, and back", async () => {
    const { page, errors } = await open(PHONE);
    // One pane: the list, grouped by runtime, with the open approval badged.
    await expect(page.locator(".chat-main")).toHaveCount(0);
    await expect(page.locator(".chat-rt", { hasText: "Lab box" }).locator(".chat-chip")).toHaveText("view only");
    await expect(row(page, WAITING).locator(".chat-appr-badge")).toHaveText("1 approval");

    await row(page, WAITING).click();
    await expect(page.locator(".chat-list")).toHaveCount(0);
    await expect(page).toHaveURL(/#s=laptop%3A3f9a0c21$/);
    const approve = page.locator(".astep-approve .appr-btn.yes");
    await expect(approve).toBeVisible();
    // Touch-sized, at a phone's width.
    const box = await approve.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(40);

    await approve.click();
    await expect.poll(() => commands(page)).toContainEqual({ type: "approval.answer", session: { runtime: "laptop", hash: "3f9a0c21" }, seq: 2, decision: "approve" });
    // The gate closes because the runtime sent the resolved step, not because the button assumed it would.
    await expect(page.locator(".astep-approve")).toHaveCount(0);
    await expect(page.locator(".chat-waiting")).toHaveCount(0);

    // The back button returns to the list, and the list has caught up with the index.
    await page.locator(".chat-head .nav").click();
    await expect(page.locator(".chat-main")).toHaveCount(0);
    await expect(row(page, WAITING).locator(".chat-appr-badge")).toHaveCount(0);
    // No horizontal scroll anywhere at this width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
});

test("phone: a runtime this device may only watch gets no composer, and says why", async () => {
    const { page } = await open(PHONE, `#s=${encodeURIComponent(WATCHED)}`);
    await expect(page.locator(".chat-readonly")).toContainText("watch sessions on Lab box");
    await expect(page.locator(".composer")).toHaveCount(0);
    await page.close();
});

test("desktop: both panes, a message becomes a turn from the runtime, and a refused command says so", async () => {
    const { page, errors } = await open(DESKTOP);
    await expect(page.locator(".chat-list")).toBeVisible();
    await expect(page.locator(".chat-start-box")).toBeVisible();
    await row(page, CHAT).click();
    await expect(page.locator(".chat-list")).toBeVisible();
    await expect(row(page, CHAT)).toHaveClass(/active/);
    await expect(page.locator(".chat-transcript .katex").first()).toBeVisible();

    await page.locator(".composer .cinput").fill("and at 128k?");
    await page.locator(".composer .cinput").press("Enter");
    await expect(page.locator(".chat-transcript")).toContainText("You said: and at 128k?");

    // The runtime refuses: the page says why, in words, rather than doing nothing.
    await page.evaluate(() => { globalThis.__chatFake.handlers["session.send"] = () => ({ ok: false, error: { code: "forbidden", message: "that grant was revoked" } }); });
    await page.locator(".composer .cinput").fill("again");
    await page.locator(".composer .cinput").press("Enter");
    await expect(page.locator(".chat-notice.error")).toContainText("Not allowed from this device: that grant was revoked");
    expect(errors).toEqual([]);
    await page.close();
});

test("desktop: a runtime that lost a session's history keeps what is shown and says so; a deleted one closes", async () => {
    const { page } = await open(DESKTOP, `#s=${encodeURIComponent(CHAT)}`);
    await expect(page.locator(".chat-transcript")).toContainText("Quantising the cache");
    await page.evaluate((k) => globalThis.__chatFake.restart(k, false), CHAT);
    await expect(page.locator(".chat-truncated")).toBeVisible();
    await expect(page.locator(".chat-transcript")).toContainText("Quantising the cache");

    await page.evaluate((k) => globalThis.__chatFake.deleteSession(k), CHAT);
    await expect(page.locator(".chat-start-box")).toBeVisible();
    await expect(row(page, CHAT)).toHaveCount(0);
    await expect(page.locator(".chat-notice")).toContainText("deleted");
    await page.close();
});

test("calm view is what the page opens in, and the toggle hands the panel's detail back", async () => {
    const { page } = await open(DESKTOP, `#s=${encodeURIComponent(WAITING)}`);
    await expect(page.locator(".chat")).toHaveClass(/calm/);
    // Calm rides the shared reading attribute, so the step counters the panel draws are quiet here…
    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-focus"))).toBe(true);
    await expect(page.locator(".step-pill").first()).toBeHidden();
    // …but nothing has left the document: the toggle brings all of it back, and the approval never quiets.
    await expect(page.locator(".astep-approve")).toBeVisible();
    // The page's tools live in the gear's menu at the bottom-left, rather than in a band across the top.
    await page.locator(".chat-gear-btn").click();
    await page.getByRole("menuitemcheckbox", { name: "Calm view" }).click();
    await expect(page.locator(".chat")).not.toHaveClass(/calm/);
    await expect(page.locator(".step-pill").first()).toBeVisible();
    // The choice is this device's, so it survives a reload.
    await page.reload();
    await expect(page.locator(".chat")).not.toHaveClass(/calm/);
    await page.close();
});

test("the page's code size is a setting of its own, and the prose keeps its size", async () => {
    const { page, errors } = await open(DESKTOP, `#s=${encodeURIComponent(CHAT)}`);
    const size = () => page.evaluate(() => getComputedStyle(document.querySelector(".chat")).getPropertyValue("--code-fs").trim());
    expect(await size()).toBe("12.5px");
    // Settings is on every build: this page's display settings need no runtime behind them.
    await page.locator(".chat-gear-btn").click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await page.getByRole("radio", { name: "Large", exact: true }).first().click();
    expect(await size()).toBe("14px");
    // The docked panels' base size is its own setting, beside it.
    const panelFs = () => page.evaluate(() => getComputedStyle(document.querySelector(".chat")).getPropertyValue("--panel-fs").trim());
    expect(await panelFs()).toBe("12px");
    await page.getByRole("radiogroup", { name: "Panel text size" }).getByRole("radio", { name: "Small" }).click();
    expect(await panelFs()).toBe("11px");
    await expect(page.locator(".chat-set-sample")).toHaveCSS("font-size", "14px");
    // A device preference, so it survives a reload; Escape takes the sheet away.
    await page.reload();
    expect(await size()).toBe("14px");
    // Runtimes: each runtime's own facts, read-only, over the contract: what it offers and the models it lists.
    await page.locator(".chat-gear-btn").click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await page.getByRole("tab", { name: "Runtimes" }).click();
    await page.getByRole("radiogroup", { name: "Runtime" }).getByRole("radio", { name: "Work laptop" }).click();
    await expect(page.locator(".rt-caps")).toContainText("Agent runs");
    // The default first, then A→Z, each tagged with where it runs; an ⓘ says the model access filter is on (and how
    // much it hid), never what the filter is.
    await expect(page.locator(".rt-models li")).toHaveText([/qwen3:32b\s*default\s*local/, /gemma3:27b\s*local/, /litellm\.google\/gemini-flash-latest\s*cloud/, /nomic-embed-text\s*local/]);
    await expect(page.locator(".chat-set-row", { hasText: "Archive folder" })).toContainText("Needs reconnecting in that browser's Settings, 2 months waiting");
    await page.locator(".rt-filtered").hover();
    await expect(page.locator(".cursor-tip")).toContainText("2 of this backend's models are hidden");
    await expect(page.getByRole("region", { name: "Storage" }).or(page.locator("section[aria-label=Storage]"))).toContainText(/keeps no saved sessions|Saved sessions/);
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
    await page.close();
});

test("desktop: the session list hides to a rail and comes back, and is out of the tab order while hidden", async () => {
    const { page } = await open(DESKTOP, `#s=${encodeURIComponent(CHAT)}`);
    const list = page.locator(".chat-list");
    await expect(list).toBeVisible();
    await expect(page.locator(".chat-rail")).toHaveCount(0);
    await page.locator(".chat-list .head .chat-list-btn").click();
    await expect(list).toBeHidden();
    // What stays at the edge is a rail: the list, a new session, search, and the gear.
    const rail = page.locator(".chat-rail");
    await expect(rail.getByRole("button", { name: "Search sessions" })).toBeVisible();
    await expect(rail.getByRole("button", { name: "Page menu" })).toBeVisible();
    await rail.getByRole("button", { name: "Show the session list" }).click();
    await expect(list).toBeVisible();
    await expect(page.locator(".chat-rail")).toHaveCount(0);
    await page.close();
});

test("a reload keeps the open session", async () => {
    const { page } = await open(PHONE);
    await row(page, CHAT).click();
    await expect(page.locator(".chat-transcript")).toContainText("Quantising the cache");
    await page.reload();
    await expect(page.locator(".chat-transcript")).toContainText("Quantising the cache");
    // Wide display math scrolls in its own box; the page itself never scrolls sideways at a phone's width.
    await expect(page.locator(".katex-display").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator(".katex-display").first().evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");
    await page.close();
});

test("phone: starting a chat from the list, and the start page asks only what it must", async () => {
    const { page, errors } = await open(PHONE);
    // The compose button opens the start page, on Agent: a run on a page is what this page is for.
    await page.locator(".chat-start").click();
    const box = page.locator(".chat-start-box textarea");
    await expect(box).toBeFocused();
    await expect(page.getByRole("radio", { name: "Agent" })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("radio", { name: "Chat" }).click();

    // One runtime can hold a chat here — the lab box has `agent` and no `chat`, the old Mac is offline — so there is
    // nothing to choose between and the page does not ask; a chat has no "where" either.
    await expect(page.getByRole("combobox", { name: "Runtime" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Where it runs/ })).toHaveCount(0);

    await box.fill("what is a shared worker?");
    await box.press("Enter");

    // The page opens the session the runtime answered with, and the transcript is the runtime's, not the form's.
    await expect(page).toHaveURL(/#s=laptop%3A/);
    await expect(page.locator(".chat-main")).toContainText("You said: what is a shared worker?");
    expect(errors).toEqual([]);
    await page.close();
});

test("desktop: with nothing open the page is a start box; an agent run picks a tab, or a new one", async () => {
    const { page, errors } = await open(DESKTOP);
    // No "Pick a session.": the empty page is somewhere to start the next one.
    await expect(page.locator(".chat-pick")).toHaveCount(0);
    const box = page.locator(".chat-start-box textarea");
    await expect(box).toBeVisible();

    // The tab picker is filled from the runtime's own `tabs.list`, so the titles are the runtime's, and it starts on
    // the tab showing in the first window.
    const pill = page.getByRole("button", { name: /^Where it runs/ });
    await expect(pill).toContainText("The front page");
    await pill.click();
    const list = page.getByRole("listbox", { name: "Where it runs" });
    // "New tab" first, then a rule, then the tabs window by window, in the browser's order.
    const options = list.getByRole("option");
    await expect(options.first()).toHaveText("New tab");
    await expect(list.locator(".tp-rule")).toHaveCount(1);
    await expect(options).toHaveText([/New tab/, /The front page.*news\.example/, /Tables — API reference/, /Pointers — the pipe dialect/, /Your cart/, /Inbox \(3\)/, /Flights AMS → LIS/]);
    await expect(list.locator(".tp-window")).toHaveCount(3);
    // A group the runtime can name has a coloured heading; one it cannot (no tabGroups grant) is a plain rule. Both
    // indent their tabs. A runtime-made icon is drawn; a tab without one gets its site's letter.
    await expect(list.locator(".tp-group")).toHaveText([/Research\s*2/]);
    await expect(list.locator(".tp-group-rule")).toHaveCount(1);
    await expect(list.locator(".tp-row.indent")).toHaveCount(3);
    await expect(list.getByRole("option", { name: /The front page/ }).locator("img.tp-fav")).toHaveCount(1);
    await expect(list.getByRole("option", { name: /Inbox/ }).locator(".tp-letter")).toHaveText("M");
    // The host is what fits; hovering it shows the whole address, over the list.
    await list.getByRole("option", { name: /Flights AMS/ }).locator(".tp-host").hover();
    const tip = page.locator(".cursor-tip");
    await expect(tip).toHaveText("https://flights.example/search?from=AMS&to=LIS");
    expect(await tip.evaluate((el) => Number(getComputedStyle(el).zIndex))).toBeGreaterThan(await list.evaluate((el) => Number(getComputedStyle(el).zIndex)));
    // The keyboard walks it: Escape closes without leaving the start page.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(page.locator(".chat-start-box")).toBeVisible();
    // Choosing a new tab adds a URL box, because a tab that does not exist has no title to choose.
    await pill.click();
    await list.getByRole("option", { name: "New tab" }).click();
    await expect(pill).toContainText("New tab");
    await expect(page.locator(".chat-pick-url")).toBeVisible();

    // The model is the chosen runtime's list: its default first and by name, an embedding model left out (it
    // cannot run an agent), and picking another one sends it; the default sends no model at all.
    // It is the tab picker's popover: a filter, the rows A→Z, a cloud model tagged as the Commander tags it.
    const modelPill = page.getByRole("button", { name: /^Model:/ });
    await expect(modelPill).toHaveText("qwen3:32b");
    await expect(modelPill).toHaveAccessibleName("Model: Default · qwen3:32b");
    await modelPill.click();
    const models = page.getByRole("listbox", { name: "Model" });
    await expect(models.getByRole("option")).toHaveText(["qwen3:32bdefault", "gemma3:27b", "litellm.google/gemini-flash-latestcloud"]);
    await models.getByRole("searchbox", { name: "Filter models" }).fill("gem");
    await expect(models.getByRole("option")).toHaveText(["gemma3:27b", "litellm.google/gemini-flash-latestcloud"]);
    await page.keyboard.press("Enter");
    await expect(models).toHaveCount(0);
    await expect(modelPill).toContainText("gemma3:27b");

    await box.fill("summarise the front page");
    await box.press("Enter");
    await expect(page).toHaveURL(/#s=laptop%3A/);
    await expect.poll(async () => (await commands(page)).at(-1)).toMatchObject({ type: "agent.start", task: "summarise the front page", target: { kind: "blank" }, model: "gemma3:27b" });

    // The compose button brings it back from an open session.
    await page.locator(".chat-list .chat-start").click();
    await expect(page.locator(".chat-start-box textarea")).toBeFocused();
    expect(errors).toEqual([]);
    await page.close();
});

test("a transcript that arrives from a short ring pages back to its start as you reach the top, and says when it cannot", async () => {
    const RUN = "laptop:5e6f7a80";
    // The whole history, for comparison.
    const full = await open(DESKTOP, `#s=${encodeURIComponent(RUN)}`);
    await expect(full.page.locator(".answer-rendered").first()).toBeVisible();
    // The demo's clock starts at page load, so two pages a second apart differ in their times and nothing else.
    const text = (p) => p.locator(".chat-transcript").innerText().then((t) => t.replace(/\d{1,2}:\d{2}:\d{2}( [AP]M)?/g, "T"));
    const whole = await text(full.page);
    await full.page.close();

    // The same session through a ring that holds only its last few events, as a hub's does.
    const { page, errors } = await open(DESKTOP);
    await page.evaluate(() => { globalThis.__chatFake.ringLimit = 3; });
    await row(page, RUN).click();
    // The edge at the top is on screen in a short transcript, so the earlier pages come in on their own, until the
    // transcript is the whole one and there is no edge left.
    await expect.poll(async () => (await commands(page)).filter((c) => c.type === "session.backfill").length).toBeGreaterThan(0);
    await expect(page.locator(".chat-earlier")).toHaveCount(0);
    await expect.poll(() => text(page)).toBe(whole);
    expect(errors).toEqual([]);
    await page.close();

    // A page the runtime cannot serve says why where the page would have been, and offers it again.
    const failing = await open(DESKTOP);
    await failing.page.evaluate(() => {
        globalThis.__chatFake.ringLimit = 3;
        globalThis.__chatFake.handlers["session.backfill"] = () => ({ ok: false, error: { code: "unavailable", message: "the box is asleep" } });
    });
    await row(failing.page, RUN).click();
    await expect(failing.page.locator(".chat-earlier.err")).toContainText("the box is asleep");
    await expect(failing.page.locator(".chat-notice")).toHaveCount(0);
    await failing.page.evaluate(() => { delete globalThis.__chatFake.handlers["session.backfill"]; });
    await failing.page.getByRole("button", { name: "Try again" }).click();
    await expect(failing.page.locator(".chat-earlier")).toHaveCount(0);
    await failing.page.close();
});

test("the tab list ends inside the window however short it is, and scrolls instead", async () => {
    for (const height of [360, 460, 700]) {
        const { page, errors } = await open({ width: 1000, height });
        await page.getByRole("button", { name: /^Where it runs/ }).click();
        const list = page.getByRole("listbox", { name: "Where it runs" });
        await expect(list).toBeVisible();
        const box = await list.boundingBox();
        expect(box.y, `top inside at ${height}px`).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height, `bottom inside at ${height}px`).toBeLessThanOrEqual(height);
        // Whatever did not fit is still reachable: the last tab scrolls into view.
        await list.getByRole("option", { name: /Flights AMS/ }).scrollIntoViewIfNeeded();
        await expect(list.getByRole("option", { name: /Flights AMS/ })).toBeInViewport();
        expect(errors).toEqual([]);
        await page.close();
    }
});

test("an answer that cites its own steps renders the tool's output, not a retyping of it", async () => {
    const { page, errors } = await open(DESKTOP, "#s=laptop%3A5e6f7a80");
    const answer = page.locator(".answer-rendered").first();
    // Every form the renderer has, in one answer: a value quoted mid-sentence, a table and an image embedded as
    // blocks with the model's caption under them, and a link that jumps to the step instead of showing it.
    await expect(answer.locator(".tok-inline > .tok-val")).toHaveText("3");
    await expect(answer.locator(".tok-block .r-df-table")).toBeVisible();
    await expect(answer.locator(".tok-block img")).toBeVisible();
    await expect(answer.locator(".tok-link")).toHaveText("the survey step");
    await expect(answer.locator(".tok-anno").first()).toHaveText("Every fare, cheapest first");
    // The mark that says this came from a tool and not from the model is a COLOUR, and the inline form carries it
    // too — an inline `code` background over the tint is what made a citation read as something typed in backticks.
    const tint = await answer.locator(".tok-inline").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(tint).not.toBe("rgba(0, 0, 0, 0)");
    expect(await answer.locator(".tok-inline > .tok-val").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    expect(errors).toEqual([]);
    await page.close();
});

test("a citation takes you to the step on the FIRST click, not the second", async () => {
    const { page, errors } = await open(DESKTOP, "#s=laptop%3A5e6f7a80");
    const scroller = page.locator(".chat-transcript");
    await expect(page.locator(".tok-link")).toBeVisible();
    // The transcript follows its newest event, so it opens at the bottom, which is the case this regressed in:
    // clicking a citation opened the step, the step's growth fired the resize handler, and the pin to the bottom
    // overwrote the scroll that was already under way. The second click found the step open, nothing grew, and it
    // worked — which is what made it look like a flaky animation rather than a fight between two behaviours.
    const bottom = await scroller.evaluate((el) => el.scrollTop);
    expect(bottom).toBeGreaterThan(50);
    await page.locator(".tok-link").click();
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeLessThan(bottom - 40);
    await expect(page.locator('[data-astep-seq="1"]')).toHaveClass(/open/);
    expect(errors).toEqual([]);
    await page.close();
});

test("desktop: the list folds a runtime away, and marks what moved while you were elsewhere", async () => {
    const { page, errors } = await open(DESKTOP, `#s=${encodeURIComponent(CHAT)}`);
    const rows = page.locator(".chat-list .chat-row");
    await expect(rows).toHaveCount(6);

    await page.locator(".chat-rt[data-runtime='laptop']").click();
    await expect(rows).toHaveCount(2);
    await expect(page.locator(".chat-rt[data-runtime='laptop']")).toHaveAttribute("aria-expanded", "false");
    // …and it is this device's choice, so it survives a reload.
    await page.reload();
    await expect(rows).toHaveCount(2);
    await page.locator(".chat-rt[data-runtime='laptop']").click();
    await expect(rows).toHaveCount(6);

    // A session that moves while another one is open is marked; reading it is catching up with it.
    await expect(row(page, WAITING).locator(".chat-moved")).toHaveCount(0);
    await page.evaluate((k) => globalThis.__chatFake.emit(k, {
        kind: "agent-step", id: `${k}-9`, ts: Date.now(), save: true, session: { hash: k.split(":")[1], turn: 9 },
        step: 3, seq: 9, tool: "exec", arguments: { js: "1" }, result: "1",
    }), WAITING);
    await expect(row(page, WAITING).locator(".chat-moved")).toBeVisible();
    await row(page, WAITING).click();
    await expect(row(page, WAITING).locator(".chat-moved")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.close();
});

test("desktop: a run says which tab it is driving, and peeks at it", async () => {
    const { page, errors } = await open(DESKTOP, `#s=${encodeURIComponent(WAITING)}`);
    // The header names the page, not only the machine and the model.
    await expect(page.locator(".chat-lede-sub .chat-page")).toHaveText("flights.example");
    await expect(row(page, WAITING).locator(".chat-page")).toHaveText("flights.example");
    // A plain chat is on no page at all, and says nothing rather than something empty.
    await expect(row(page, CHAT).locator(".chat-page")).toHaveCount(0);
    // The chip asks the RUNTIME to bring the tab forward, so it works the same over a hub.
    await page.locator(".chat-lede-sub .chat-page").click();
    await expect.poll(() => commands(page)).toContainEqual({ type: "tab.focus", runtime: "laptop", tabId: 41 });

    await page.locator(".chat-lede .chat-peek").click();
    await expect.poll(() => commands(page)).toContainEqual({
        type: "tab.screenshot", runtime: "laptop", target: { session: { runtime: "laptop", hash: "3f9a0c21" } },
    });
    await expect(page.locator(".chat-lightbox img")).toBeVisible();
    await page.locator(".chat-lightbox").click();

    // The browser can only capture the tab its window is showing, so a refusal is a sentence rather than nothing.
    await page.evaluate(() => {
        globalThis.__chatFake.handlers["tab.screenshot"] = () => ({ ok: false, error: { code: "conflict", message: "that tab is not in front in its window, so it cannot be captured" } });
    });
    await page.locator(".chat-lede .chat-peek").click();
    await expect(page.locator(".chat-notice")).toContainText("not in front in its window");
    expect(errors).toEqual([]);
    await page.close();
});

test("desktop: a run whose tab has closed still says which page it was on", async () => {
    const { page } = await open(DESKTOP, `#s=${encodeURIComponent(CAPPED)}`);
    await expect(page.locator(".chat-lede-sub .chat-page")).toHaveText("flights.example");
    // No tab to capture, so nothing offers to look at one.
    await expect(page.locator(".chat-peek")).toHaveCount(0);
    await expect(page.locator(".chat-resume")).toBeVisible();
    await page.close();
});

test("desktop: a run whose page has gone offers a resume instead of a composer, and picks where", async () => {
    const { page, errors } = await open(DESKTOP, `#s=${encodeURIComponent(CAPPED)}`);

    // The capped run has no open tab, so sending to it would end at a tab that is closed. The page offers the one
    // thing that would work instead, and not both.
    await expect(page.locator(".chat-resume")).toContainText("The page this run was on is gone");
    await expect(page.locator(".composer")).toHaveCount(0);

    await page.locator(".chat-resume").click();
    // The SAME where-picker a fresh run uses, and no message box: resuming takes no turn.
    await expect(page.locator('[data-field="tab"] option').first()).toHaveText("The front page");
    await expect(page.locator('[data-field="text"]')).toHaveCount(0);
    // What it will lose is said BEFORE it happens, not reported in the transcript after.
    await expect(page.locator('[data-field="lost"]')).toContainText("approval grants");

    await page.locator('[data-field="where"] select').selectOption("blank");
    await page.locator('[data-field="page"] input').fill("https://plots.example/");
    await page.locator(".chat-new-foot .btn").click();

    await expect.poll(async () => (await commands(page)).at(-1)).toMatchObject({
        type: "session.resume",
        session: { runtime: "laptop", hash: "c0ffee12" },
        target: { kind: "blank", url: "https://plots.example/" },
    });
    // The runtime answered, so the form closes and the transcript gains the seam — and the composer is back, because
    // the run has a page again.
    await expect(page.locator(".resume-divider")).toContainText("resumed on plots.example");
    await expect(page.locator(".chat-resume")).toHaveCount(0);
    await expect(page.locator(".composer")).toBeVisible();
    expect(errors).toEqual([]);
    await page.close();
});

test("desktop: a run whose tab is still open gets its composer, not a resume", async () => {
    // The distinction is the tab, not the status: two ways to continue one run is one too many.
    const { page, errors } = await open(DESKTOP, `#s=${encodeURIComponent(WAITING)}`);
    await expect(page.locator(".composer")).toBeVisible();
    await expect(page.locator(".chat-resume")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.close();
});

test("desktop: a row's menu pins a session to the top, and deletes one only after asking", async () => {
    const { page, errors } = await open(DESKTOP);
    const menuOf = (key) => page.locator(`.chat-row-wrap:has(.chat-row[data-session="${key}"]) .chat-row-more`);
    // Pin: the session moves out of its runtime's group into Pinned, and a reload keeps it there (a device pref).
    await menuOf(CHAT).click();
    await page.getByRole("menuitem", { name: "Pin to the top" }).click();
    await expect(page.locator(".chat-pinned").locator(`.chat-row[data-session="${CHAT}"]`)).toBeVisible();
    await expect(page.locator(".chat-group:not(.chat-pinned)").locator(`.chat-row[data-session="${CHAT}"]`)).toHaveCount(0);
    // …and the RUNTIME is told, because its pin is the one that keeps the session from being expired or evicted.
    await expect.poll(async () => (await commands(page)).find((c) => c.type === "session.pin")).toMatchObject({ pinned: true, session: { hash: CHAT.split(":")[1] } });
    await page.reload();
    await expect(page.locator(".chat-pinned").locator(`.chat-row[data-session="${CHAT}"]`)).toBeVisible();

    // A runtime past its pin limit refuses, says so, and the list does not keep a pin the runtime would not.
    await page.evaluate(() => { globalThis.__chatFake.handlers["session.pin"] = () => ({ ok: false, error: { code: "conflict", message: "at most 100 sessions can be pinned; unpin one first" } }); });
    await menuOf(CAPPED).click();
    await page.getByRole("menuitem", { name: "Pin to the top" }).click();
    await expect(page.locator(".chat-notice.error")).toContainText("at most 100 sessions can be pinned");
    await expect(page.locator(".chat-pinned").locator(`.chat-row[data-session="${CAPPED}"]`)).toHaveCount(0);
    await page.evaluate(() => { delete globalThis.__chatFake.handlers["session.pin"]; });

    // Rename: the runtime's title, so what the row shows is what the runtime stored, after its upsert.
    await menuOf(CHAT).click();
    await page.getByRole("menuitem", { name: "Rename…" }).click();
    const field = page.getByRole("textbox", { name: "Session name" });
    await expect(field).toBeFocused();
    await expect(page.locator(".chat-dialog-hint")).toHaveText("Clear to let the model name it.");
    await field.fill("  KV   cache sizing  ");
    await field.press("Enter");
    await expect.poll(async () => (await commands(page)).find((c) => c.type === "session.rename")).toMatchObject({ title: "  KV   cache sizing  " });
    await expect(page.locator(`.chat-row[data-session="${CHAT}"] .row-title`)).toHaveText("KV cache sizing");

    // A runtime this device may only watch offers no delete.
    await menuOf(WATCHED).click();
    await expect(page.getByRole("menuitem", { name: "Delete…" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Delete asks first; Cancel sends nothing.
    await menuOf(CAPPED).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Plot the fare prices");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect((await commands(page)).filter((c) => c.type === "session.delete")).toEqual([]);
    // Confirmed, the RUNTIME deletes it and the row goes because the runtime said so.
    await menuOf(CAPPED).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(row(page, CAPPED)).toHaveCount(0);
    expect((await commands(page)).filter((c) => c.type === "session.delete").map((c) => c.session.hash)).toEqual(["c0ffee12"]);
    expect(errors).toEqual([]);
    await page.close();
});

test("desktop: the list shows the last month, and the search page holds every session with its date", async () => {
    const { page, errors } = await open(DESKTOP, `#s=${encodeURIComponent(CHAT)}`);
    const list = page.locator(".chat-list");
    await expect(list.locator(".chat-row", { hasText: "Tokyo in four days" })).toHaveCount(0);
    await expect(list.locator(".chat-older-go .chat-older-n")).toHaveText("48");

    // "Older sessions" opens the search page in the main pane, focused, newest first, drawn forty at a time.
    await list.locator(".chat-older-go").click();
    const search = page.locator(".chat-search");
    await expect(search.locator("input")).toBeFocused();
    await expect(search.locator(".chat-search-row")).toHaveCount(40);
    await expect(search.locator(".chat-search-row").first().locator(".chat-search-date")).toHaveText(/\S/);
    const toEnd = () => search.locator(".chat-sheet-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await toEnd();
    await expect(search.locator(".chat-search-row")).toHaveCount(54);
    // Past what the page holds, the runtime's ARCHIVE: asked for a page at a time, and each of its rows marked.
    await expect(async () => { await toEnd(); expect(await search.locator(".chat-search-row").count()).toBe(84); }).toPass();
    await expect(search.locator(".chat-search-arch")).toHaveCount(30);
    // A runtime whose archive folder lost its permission says so at the foot: search still works, the copy is paused.
    await expect(search.locator(".chat-search-foot")).toContainText("Reconnect Work laptop's archive folder");
    await expect(search.locator(".chat-search-foot")).toContainText("2 months are not yet copied");
    expect((await commands(page)).some((c) => c.type === "sessions.list")).toBe(true);

    // A search matches the PAGE a run is on, not only its title, and reaches months back.
    await search.locator("input").fill("flights");
    await expect(search.locator(".chat-search-row")).toHaveCount(3);
    // …and into the archive, once typing pauses: 4 listed, 3 archived.
    await search.locator("input").fill("tokyo");
    await expect(search.locator(".chat-search-row")).toHaveCount(7);
    // A word only an archived session's ANSWER holds is found by the runtime, with the snippet that says why.
    await search.locator("input").fill("gluten");
    await expect(search.locator(".chat-search-row")).toHaveCount(2);
    await expect(search.locator(".chat-search-snip mark").first()).toHaveText("gluten");
    // Opening an archived row brings it back first, and then it is an ordinary session.
    await search.locator(".chat-search-row").first().click();
    await expect.poll(async () => (await commands(page)).some((c) => c.type === "session.unarchive")).toBe(true);
    await expect(page.locator(".chat-lede-title")).toHaveText("Why does my sourdough collapse? (again)");
    await page.getByRole("button", { name: "Search sessions" }).first().click();
    // Escape closes it from anywhere on the page, not only from inside the box.
    await search.locator(".chat-search-label").click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".chat-search")).toHaveCount(0);
    await page.getByRole("button", { name: "Search sessions" }).first().click();
    await page.locator(".chat-search input").fill("tokyo");
    // Opening one puts the search page away.
    await search.locator(".chat-search-row").first().click();
    await expect(page.locator(".chat-search")).toHaveCount(0);
    await expect(page.locator(".chat-lede-title")).toHaveText("Tokyo in four days");
    expect(errors).toEqual([]);
    await page.close();
});

test("the attention list: an inbox above the gear, problems counted, each said for where it is fixed, suggestions dismissable", async () => {
    const { page, errors } = await open(DESKTOP);
    // Two problems (the laptop's lapsed archive folder, the box's code this page does not know) and one suggestion.
    const btn = page.locator(".chat-list-foot .chat-att-btn");
    await expect(btn).toContainText("Needs attention");
    await expect(btn.locator(".chat-att-n")).toHaveText("2");
    await btn.click();
    const sheet = page.getByRole("main", { name: "Needs attention" });
    const items = sheet.locator(".chat-att-item");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText("The archive folder needs reconnecting");
    // Neither runtime's settings can be changed from here, so each says where it is fixed rather than offering a button.
    await expect(items.nth(0)).toContainText("It is fixed on Work laptop.");
    await expect(sheet.locator(".chat-att-fix")).toHaveCount(0);
    await expect(sheet).toContainText("does not know");
    const tip = items.filter({ hasText: "No utility model" });
    await tip.getByRole("button", { name: "Dismiss" }).click();
    await expect(items).toHaveCount(2);
    // Dismissed on this device: it stays away after a reload, and the count never included it.
    await page.reload();
    await btn.click();
    await expect(items).toHaveCount(2);
    await expect(btn.locator(".chat-att-n")).toHaveText("2");
    // Off any tooltip first: a first Escape over one only mutes it.
    await page.mouse.move(600, 300);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.close();
});

test("a tab group folds from its heading, starts as the browser's strip has it, and stays as it was left", async () => {
    const { page, errors } = await open(DESKTOP);
    // Folded in the browser's own strip: the picker starts it folded, its tabs out of the list and out of the arrows' way.
    await page.evaluate(() => { globalThis.__chatFake.tabGroups[0].collapsed = true; });
    const pill = page.getByRole("button", { name: /^Where it runs/ });
    await pill.click();
    const list = page.getByRole("listbox", { name: "Where it runs" });
    const research = list.getByRole("button", { name: /^Research, 2 tabs/ });
    await expect(research).toHaveAttribute("aria-expanded", "false");
    await expect(list.getByRole("option", { name: /Tables — API reference/ })).toHaveCount(0);
    // Typing opens every group: a match inside a fold is still found.
    await list.getByRole("searchbox", { name: "Filter tabs" }).fill("Tables");
    await expect(list.getByRole("option", { name: /Tables — API reference/ })).toHaveCount(1);
    await list.getByRole("searchbox", { name: "Filter tabs" }).fill("");
    // A click opens it, and the choice is this device's from then on, over the browser's.
    await research.click();
    await expect(research).toHaveAttribute("aria-expanded", "true");
    await expect(list.getByRole("option", { name: /Tables — API reference/ })).toHaveCount(1);
    // The arm: a line in the group's colour beside its tabs.
    expect(await list.locator(".tp-grp").first().evaluate((el) => getComputedStyle(el, "::before").backgroundColor)).toBe("rgb(138, 180, 248)");
    await page.reload();
    await page.evaluate(() => { globalThis.__chatFake.tabGroups[0].collapsed = true; });
    await pill.click();
    await expect(research).toHaveAttribute("aria-expanded", "true");
    await research.click();
    await expect(research).toHaveAttribute("aria-expanded", "false");
    expect(errors).toEqual([]);
    await page.close();
});

test("a chosen tab that closes is never swapped for another: the pill says so and starting waits for a new pick", async () => {
    const { page, errors } = await open(DESKTOP);
    const box = page.locator(".chat-start-box textarea");
    const pill = page.getByRole("button", { name: /^Where it runs/ });
    const list = page.getByRole("listbox", { name: "Where it runs" });
    const close = (title) => page.evaluate((t) => { const f = globalThis.__chatFake; f.tabs = f.tabs.filter((x) => x.title !== t); }, title);
    const starts = async () => (await commands(page)).filter((c) => c.type === "agent.start");

    // Chosen, then closed before the list is next asked for: the refresh keeps the choice and says it closed. It used
    // to move to the tab in front, which would have started the run on a page nobody picked.
    await pill.click();
    await list.getByRole("option", { name: /Your cart/ }).click();
    await expect(pill).toContainText("Your cart");
    await close("Your cart");
    await pill.click();
    await page.keyboard.press("Escape");
    await expect(pill).toContainText("That tab closed");
    await box.fill("check out");
    await box.press("Enter");
    await expect(page.locator(".chat-start-send")).toBeDisabled();
    expect(await starts()).toEqual([]);

    // Closed while the list is OPEN: the row is still there and can be picked, and the runtime refuses the start
    // rather than running it elsewhere. What was typed stays, to be sent again.
    await pill.click();
    await expect(list.getByRole("option", { name: /Inbox/ })).toHaveCount(1);
    await close("Inbox (3)");
    await list.getByRole("option", { name: /Inbox/ }).click();
    await box.press("Enter");
    await expect.poll(async () => (await starts()).length).toBe(1);
    await expect(page.locator(".chat-start-box textarea")).toHaveValue("check out");
    await expect(page).not.toHaveURL(/#s=/);
    // Picking a tab that is open starts there, and only there.
    await pill.click();
    await list.getByRole("option", { name: /Flights AMS/ }).click();
    await box.press("Enter");
    await expect(page).toHaveURL(/#s=laptop%3A/);
    const last = (await starts()).at(-1);
    const flights = await page.evaluate(() => globalThis.__chatFake.tabs.find((t) => /Flights/.test(t.title)).tabId);
    expect(last.target).toEqual({ kind: "tab", tabId: flights });
    expect(errors).toEqual([]);
    await page.close();
});

test("the start row fits one line at the start box's full width, however long the tab title and the model name", async () => {
    const { page } = await open({ width: 1280, height: 800 });
    await page.evaluate(() => {
        const f = globalThis.__chatFake;
        f.tabs[0].title = "Verify TLS certificates, instead of disabling verification for the whole session, by default";
        f.models[0].id = "qwen3.8-flash-next-extra-long-name:vision";
    });
    // The page asked before the names changed: switch kinds to ask again.
    await page.getByRole("radio", { name: "Chat" }).click();
    await page.getByRole("radio", { name: "Agent" }).click();
    await page.getByRole("button", { name: /^Where it runs/ }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: /^Where it runs/ })).toContainText("Verify TLS");
    const tops = await page.locator(".chat-start-row > *").evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 0 && getComputedStyle(e).position !== "fixed").map((e) => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2)));
    expect(Math.max(...tops) - Math.min(...tops), `row items' centres: ${tops.join(", ")}`).toBeLessThanOrEqual(4);
    await page.close();
});

test("the model pill waits as a placeholder of its own size and slides in; a second open draws it at once", async () => {
    const page = await browser.newPage({ viewport: DESKTOP });
    await page.addInitScript(() => { globalThis.__chatFakeLatencyMs = 700; });
    await page.goto(server.url);
    const wait = page.getByRole("status", { name: "Loading models" });
    await expect(wait).toBeVisible();
    const rowBox = () => page.locator(".chat-start-row").boundingBox();
    const before = await rowBox();
    const pill = page.getByRole("button", { name: /^Model:/ });
    await expect(pill).toBeVisible();
    await expect(wait).toHaveCount(0);
    await expect(pill).toHaveClass(/tp-pill-in/);
    // The row kept its height: the placeholder held the pill's place.
    expect(Math.abs((await rowBox()).height - before.height)).toBeLessThanOrEqual(1);
    // Away to a session and back: the list is remembered, so no placeholder and no animation this time.
    await page.locator(".chat-row").first().click();
    await page.locator(".chat-list .chat-start").click();
    await expect(pill).toBeVisible();
    await expect(pill).not.toHaveClass(/tp-pill-in/);
    await page.close();
});

test("tabs the runtime could not list are counted in a warning at the top of the list, with where to allow them", async () => {
    const { page, errors } = await open(DESKTOP);
    await page.evaluate(() => { globalThis.__chatFake.tabsWithheld = 7; });
    const pill = page.getByRole("button", { name: /^Where it runs/ });
    await pill.click();   // opening asks for the list again, which now reports them
    const list = page.getByRole("listbox", { name: "Where it runs" });
    const warn = list.getByRole("note");
    await expect(warn).toContainText("7 open tabs are not listed: the extension may only read the sites you allowed it.");
    // This device cannot grant for that runtime (the web build has no extension), so it says where it is allowed.
    await expect(warn).toContainText("Allowed in that browser's extension settings");
    await expect(warn.getByRole("button")).toHaveCount(0);
    // It is about the whole list: filtering hides it, and the listed tabs are all still there.
    await expect(list.getByRole("option")).toHaveCount(7);
    await list.getByRole("searchbox", { name: "Filter tabs" }).fill("cart");
    await expect(warn).toHaveCount(0);
    await list.getByRole("searchbox", { name: "Filter tabs" }).fill("");
    // One is said as one; none says nothing.
    await page.evaluate(() => { globalThis.__chatFake.tabsWithheld = 1; });
    await page.keyboard.press("Escape");
    await pill.click();
    await expect(warn).toContainText("1 open tab is not listed");
    await page.evaluate(() => { globalThis.__chatFake.tabsWithheld = 0; });
    await page.keyboard.press("Escape");
    await pill.click();
    await expect(list.getByRole("option").first()).toBeVisible();
    await expect(warn).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.close();
});
