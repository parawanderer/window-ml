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
// A capped run whose tab is still OPEN, against CAPPED, whose page has gone: the two offer different things.
const CAPPED_HERE = "laptop:beef1234";

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
// The row in the session's OWN runtime group. A session waiting on you is also listed in "Needs you" at the top, so
// this matches twice; `.last()` is the one where it lives, which is the one every assertion here means.
const row = (page, key) => page.locator(`.chat-row[data-session="${key}"]`).last();
const commands = (page) => page.evaluate(() => globalThis.__chatFake.commands);

test("it runs with no extension: no chrome global, and the bundle loaded nothing that needs one", async () => {
    const { page, errors } = await open(DESKTOP);
    expect(await page.evaluate(() => typeof globalThis.chrome?.runtime)).toBe("undefined");
    await expect(row(page, WAITING)).toBeVisible();
    expect(errors).toEqual([]);
    await page.close();
});

test("phone: the list first, a session on its own, approve through the runtime, and back @mobile", async () => {
    const { page, errors } = await open(PHONE);
    // One pane: the list, grouped by runtime, with the open approval badged.
    await expect(page.locator(".chat-main")).toHaveCount(0);
    await expect(page.locator(".chat-rt", { hasText: "Lab box" }).locator(".chat-chip")).toHaveText("view only");
    await expect(row(page, WAITING).locator(".chat-appr-badge")).toHaveText("1 pending");

    await row(page, WAITING).click();
    await expect(page.locator(".chat-list")).toHaveCount(0);
    await expect(page).toHaveURL(/#\/s\/laptop%3A3f9a0c21$/);
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
    await page.getByRole("button", { name: "Back to sessions" }).click();
    await expect(page.locator(".chat-main")).toHaveCount(0);
    await expect(row(page, WAITING).locator(".chat-appr-badge")).toHaveCount(0);
    // No horizontal scroll anywhere at this width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
});

test("phone: a runtime this device may only watch gets no composer, and says why @mobile", async () => {
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

test("phone: what was typed survives leaving the session, a reload, and a send that fails @mobile", async () => {
    const { page, errors } = await open(PHONE, `#/s/${encodeURIComponent(CHAT)}`);
    const box = page.locator(".composer .cinput");
    await box.fill("half a thought");
    // Back to the list and in again, then a reload: the draft is still there.
    await page.locator(".chat-sheet-back").click();
    await row(page, CHAT).click();
    await expect(box).toHaveValue("half a thought");
    // The address follows after the paint; reloading before it would land on the list.
    await expect(page).toHaveURL(/#\/s\//);
    await page.reload();
    await expect(box).toHaveValue("half a thought");

    // The network fails the send: the box empties at once, then the message comes back, with the notice.
    await page.evaluate(() => { globalThis.__chatFake.handlers["session.send"] = () => ({ ok: false, error: { code: "unavailable", message: "network down" } }); });
    await box.fill("a long message I do not want to type twice");
    await box.press("Enter");
    await expect(page.locator(".chat-notice.error")).toContainText("network down");
    await expect(box).toHaveValue("a long message I do not want to type twice");
    // And it is saved, not just shown: a reload keeps it.
    await page.reload();
    await expect(box).toHaveValue("a long message I do not want to type twice");

    // Once it goes through, it is gone from the box and from storage.
    await box.press("Enter");
    await expect(page.locator(".chat-transcript")).toContainText("You said: a long message I do not want to type twice");
    await expect(box).toHaveValue("");
    await page.reload();
    await expect(box).toHaveValue("");
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

test("phone: starting a chat from the list, and the start page asks only what it must @mobile", async () => {
    const { page, errors } = await open(PHONE);
    // The compose button opens the start page, on Agent: a run on a page is what this page is for.
    await page.locator(".chat-start").click();
    const box = page.locator(".chat-start-box textarea");
    await expect(box).toBeFocused();
    // On a phone the kind is a pill like the tab and the model, not two segments: the start row fits on one line.
    await expect(page.getByRole("radio", { name: "Agent" })).toHaveCount(0);
    const kind = page.getByRole("button", { name: "Kind: Agent" });
    await kind.click();
    const kinds = page.getByRole("listbox", { name: "Kind" });
    await expect(kinds.getByRole("option")).toHaveCount(2);
    await expect(kinds.getByRole("option", { name: /^Chat/ })).toContainText("Just the conversation");
    await kinds.getByRole("option", { name: /^Chat/ }).click();
    await expect(page.getByRole("button", { name: "Kind: Chat" })).toBeVisible();

    // One runtime can hold a chat here — the lab box has `agent` and no `chat`, the old Mac is offline — so there is
    // nothing to choose between and the page does not ask; a chat has no "where" either.
    await expect(page.getByRole("combobox", { name: "Runtime" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Where it runs/ })).toHaveCount(0);

    await box.fill("what is a shared worker?");
    await box.press("Enter");

    // The page opens the session the runtime answered with, and the transcript is the runtime's, not the form's.
    await expect(page).toHaveURL(/#\/s\/laptop%3A/);
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
    // It is the tab picker's popover: a filter, the rows A→Z, and where each model runs as a quiet mark (`WhereMark`).
    const modelPill = page.getByRole("button", { name: /^Model:/ });
    await expect(modelPill).toHaveText("qwen3:32b");
    await expect(modelPill).toHaveAccessibleName("Model: Default · qwen3:32b");
    await modelPill.click();
    const models = page.getByRole("listbox", { name: "Model" });
    await expect(models.getByRole("option")).toHaveText(["qwen3:32bdefault", "gemma3:27b", "litellm.google/gemini-flash-latest"]);
    await expect(models.getByRole("option", { name: /gemini-flash-latest/ }).getByLabel("cloud model")).toHaveCount(1);
    await expect(models.getByRole("option", { name: /gemma3:27b/ }).getByLabel("cloud model")).toHaveCount(0);
    await models.getByRole("searchbox", { name: "Filter models" }).fill("gem");
    await expect(models.getByRole("option")).toHaveText(["gemma3:27b", "litellm.google/gemini-flash-latest"]);
    await page.keyboard.press("Enter");
    await expect(models).toHaveCount(0);
    await expect(modelPill).toContainText("gemma3:27b");

    await box.fill("summarise the front page");
    await box.press("Enter");
    await expect(page).toHaveURL(/#\/s\/laptop%3A/);
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
    // Visible rows: a folded group stays mounted so it can slide, hidden once it has.
    const rows = page.locator(".chat-list .chat-row:visible");
    await expect(rows).toHaveCount(7);

    // Calm: the heading's chevron sits after the name and shows only while the pointer is on the heading.
    const head = page.locator(".chat-rt[data-runtime='laptop']");
    const tri = head.locator(".tri");
    const opacity = () => tri.evaluate((e) => getComputedStyle(e).opacity);
    const after = await head.evaluate((h) => h.querySelector(".tri").getBoundingClientRect().left > h.querySelector(".chat-rt-name").getBoundingClientRect().right);
    expect(after, "the chevron follows the name").toBe(true);
    await page.mouse.move(0, 0);
    await expect.poll(opacity).toBe("0");
    await head.hover();
    await expect.poll(opacity).toBe("1");

    await head.click();
    // Three, not two: folding a machine tidies its group away, and the "Needs you" row survives it. Folding is about
    // what you want to look at; a gate is about what has stopped until you come back to it, and one you have hidden
    // is one you forget. The phone computes its own needs-you list from every session, with no fold filter either.
    await expect(rows).toHaveCount(3);
    await expect(tri).not.toHaveClass(/open/);
    await page.mouse.move(0, 0);
    await expect.poll(opacity).toBe("0");
    await expect(page.locator(".chat-rt[data-runtime='laptop']")).toHaveAttribute("aria-expanded", "false");
    // …and it is this device's choice, so it survives a reload.
    await page.reload();
    await expect(rows).toHaveCount(3);
    await page.locator(".chat-rt[data-runtime='laptop']").click();
    await expect(rows).toHaveCount(7);

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
    // In the LIST, on a row in its own runtime group. WAITING is not one: it sits in "Needs you", where a row names
    // the machine instead, because out of its group that is the thing it has lost.
    await expect(row(page, CAPPED).locator(".chat-page")).toHaveText("flights.example");
    await expect(row(page, WAITING).locator(".chat-row-rt")).toHaveText("Work laptop");
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
    await expect(page.locator(".chat-resume")).toContainText("The tab this run worked in has closed");
    await expect(page.locator(".composer")).toHaveCount(0);

    await page.locator(".chat-resume").click();
    // A DIALOG over the session, not a screen replacing it: the transcript is still behind it.
    await expect(page.locator(".chat-dialog-back")).toBeVisible();
    await expect(page.locator(".chat-transcript")).toBeVisible();
    // The SAME where-picker a fresh run uses — the real one, with the page's own icon — and no message box:
    // resuming takes no turn.
    await expect(page.locator(".chat-dialog .tp-pill-tab")).toContainText("The front page");
    await expect(page.locator('[data-field="text"]')).toHaveCount(0);
    // What it will lose is said BEFORE it happens, not reported in the transcript after.
    await expect(page.locator('[data-field="lost"]')).toContainText("approval grants");

    await page.locator(".chat-dialog .tp-pill-tab").click();
    await page.locator(".tp-pop .tp-title", { hasText: "New tab" }).click();
    await page.locator(".chat-dialog .chat-pick-url").fill("https://plots.example/");
    await page.locator(".chat-dialog-actions .btn.primary").click();

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

/** WCAG relative luminance of an `rgb(r, g, b)` string. */
function luminance(css) {
    const [r, g, b] = css.match(/[\d.]+/g).slice(0, 3).map(Number)
        .map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** The WCAG contrast ratio between two `rgb()` strings, 1:1 (identical) to 21:1 (black on white). */
function contrast(a, b) {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
}

test("the two answers to an approval are both legible, measured rather than eyeballed", async () => {
    // Deny is the OUTLINED half of a consent control, and an outline at `--border` sits near 1.4:1 against the card
    // — drawn, and effectively invisible. That is the wrong thing for one of two answers to a question about what an
    // agent may do, and it is the kind of wrong that looks fine to whoever chose the colour. So it is measured:
    // WCAG wants 3:1 for a non-text UI boundary and 4.5:1 for body-sized text.
    const { page, errors } = await open(DESKTOP, `#s=${encodeURIComponent(WAITING)}`);
    const seen = await page.evaluate(() => {
        const btn = document.querySelector(".astep-approve .appr-btn.no");
        const card = document.querySelector(".astep-approve");
        const cs = getComputedStyle(btn);
        return { text: cs.color, border: cs.borderTopColor, card: getComputedStyle(card).backgroundColor };
    });
    expect(contrast(seen.border, seen.card)).toBeGreaterThanOrEqual(3);
    expect(contrast(seen.text, seen.card)).toBeGreaterThanOrEqual(4.5);
    expect(errors).toEqual([]);
    await page.close();
});

test("desktop: a picker inside a dialog opens against its own pill, not somewhere else on the page", async () => {
    // The pickers place their popovers in VIEWPORT coordinates (position: fixed). Any ancestor with a transform —
    // including the identity one an `animation-fill-mode: both` leaves behind after a dialog's entrance — becomes
    // their containing block instead, and the list lands a whole card away from the pill that opened it. Nothing
    // about that is visible in the markup, so it is asserted geometrically.
    const { page, errors } = await open(DESKTOP, `#s=${encodeURIComponent(CAPPED)}`);
    await page.locator(".chat-resume").click();
    const pill = page.locator(".chat-dialog .tp-pill-tab");
    await pill.click();
    const pop = page.locator(".tp-pop");
    await expect(pop).toBeVisible();
    const [p1, p2] = [await pill.boundingBox(), await pop.boundingBox()];
    expect(Math.abs(p2.x - p1.x)).toBeLessThan(8);                       // lined up with the pill's left edge
    expect(p2.y - (p1.y + p1.height)).toBeGreaterThanOrEqual(0);         // directly below it…
    expect(p2.y - (p1.y + p1.height)).toBeLessThan(24);                  // …by the anchor's small gap, not a card
    expect(errors).toEqual([]);
    await page.close();
});

test("desktop: the copy button on your own prompt stays lit while you reach for it", async () => {
    // The row holding these buttons hangs BELOW the bubble, outside it, so `:hover` on the message alone went false
    // the moment the pointer set off towards them: they faded to nothing while staying clickable, which reads as
    // buttons that run away. The reach is the test — hovering them is not enough, because that always worked.
    const { page, errors } = await open(DESKTOP, `#s=${encodeURIComponent(CHAT)}`);
    const msg = page.locator(".msg.user").first();
    const acts = msg.locator(".umsg-acts");
    const copy = acts.locator('button[aria-label="Copy this message"]');
    await expect(acts).toHaveCSS("opacity", "0");
    await msg.hover();
    await expect(acts).toHaveCSS("opacity", "1");
    // Now leave the message for the buttons, which is where it broke.
    await copy.hover();
    await expect(acts).toHaveCSS("opacity", "1");
    // The timestamp shares the row with them and is a third of it, so crossing it must not count as leaving either.
    await msg.locator(".mrow .time").hover();
    await expect(acts).toHaveCSS("opacity", "1");
    await copy.click();
    await expect(msg.locator(".umsg-acts svg")).toHaveCount(2);   // still there, and the tick swapped in
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
    await expect(search.locator(".chat-search-row")).toHaveCount(55);
    // Past what the page holds, the runtime's ARCHIVE: asked for a page at a time, and each of its rows marked.
    await expect(async () => { await toEnd(); expect(await search.locator(".chat-search-row").count()).toBe(85); }).toPass();
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
    // Dismissed on this device: it stays away after a reload, and the count never included it. The list is in the
    // address (#/attention), so the reload reopens it rather than needing the button again.
    await page.reload();
    await expect(page).toHaveURL(/#\/attention$/);
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
    await expect(page).not.toHaveURL(/#\/s\//);
    // Picking a tab that is open starts there, and only there.
    await pill.click();
    await list.getByRole("option", { name: /Flights AMS/ }).click();
    await box.press("Enter");
    await expect(page).toHaveURL(/#\/s\/laptop%3A/);
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

test("this page's theme: chosen from the gear, applied at once, kept per device, and the same choice in Settings", async () => {
    const page = await browser.newPage({ viewport: DESKTOP, colorScheme: "dark" });
    await page.goto(server.url);
    await page.locator(".chat").waitFor();
    const theme = () => page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    expect(await theme()).toBe("dark");   // the system's, as the extension's Auto means
    await page.locator(".chat-list-foot .chat-gear-btn").click();
    const menu = page.getByRole("menu", { name: "Page menu" });
    // The choices stay mounted so closing animates, but a closed list is out of reach: not in the tree, not tabbable.
    await expect(menu.getByRole("menuitemradio")).toHaveCount(0);
    await page.getByRole("menuitem", { name: /Theme for this page/ }).click();
    // The extension is on Auto here, so following it would mean the same as System: no fourth choice.
    await expect(menu.getByRole("menuitemradio")).toHaveText(["System", "Light", "Dark"]);
    await expect(menu.getByRole("menuitemradio", { name: "System" })).toHaveAttribute("aria-checked", "true");
    await menu.getByRole("menuitemradio", { name: "Light" }).click();
    expect(await theme()).toBe("light");
    await expect(menu.getByRole("menuitem", { name: /Theme for this page/ })).toContainText("Light");
    await menu.getByRole("menuitem", { name: /Theme for this page/ }).click();
    await expect(menu.getByRole("menuitemradio")).toHaveCount(0);
    await page.reload();
    await page.locator(".chat").waitFor();
    expect(await theme()).toBe("light");
    await page.locator(".chat-list-foot .chat-gear-btn").click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    const seg = page.getByRole("radiogroup", { name: "Theme" });
    await expect(seg.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
    await seg.getByRole("radio", { name: "System" }).click();
    expect(await theme()).toBe("dark");
    await page.close();
});

test("closing a step eases to a stop: nothing under it snaps once the body has gone", async () => {
    const { page, errors } = await open(DESKTOP, `#s=${encodeURIComponent(WAITING)}`);
    const step = page.locator(".astep.tool", { hasText: "exec" }).first();
    await step.waitFor();
    if (!/\bopen\b/.test(await step.getAttribute("class"))) { await step.locator(".astep-head").click(); await page.waitForTimeout(400); }
    // What sits under the step, frame by frame through the close. The body kept 16px of padding at `height: 0`, and the
    // step kept its open margins until the body unmounted, so the last frame jumped ~22px after an easing that had
    // slowed to 3px a frame.
    const ys = await step.evaluate(async (el) => {
        const next = el.nextElementSibling || el.parentElement.nextElementSibling;
        const out = [];
        el.querySelector(".astep-head").click();
        const t0 = performance.now();
        while (performance.now() - t0 < 450) { await new Promise(requestAnimationFrame); out.push(next.getBoundingClientRect().top); }
        return out;
    });
    const moves = ys.slice(1).map((y, i) => y - ys[i]).filter((d) => Math.abs(d) > 0.05);
    expect(moves.length, "it animated over several frames").toBeGreaterThan(4);
    const biggest = Math.max(...moves.map(Math.abs));
    expect(Math.abs(moves.at(-1)), `the last frame's move (${moves.map((d) => d.toFixed(1)).join(" ")})`).toBeLessThan(Math.max(4, biggest * 0.25));
    await expect(step).not.toHaveClass(/\bopen\b/);
    expect(errors).toEqual([]);
});

/** Settings → Devices, opened fresh (the panel reads the membership when it mounts). */
async function openDevices(page) {
    if (!(await page.getByRole("tab", { name: "Devices" }).count())) {
        await page.locator(".chat-list-foot .chat-gear-btn").click();
        await page.getByRole("menuitem", { name: "Settings" }).click();
    } else {
        await page.getByRole("tab", { name: "This page" }).click();
    }
    await page.getByRole("tab", { name: "Devices" }).click();
}

test("pairing a device: find it by its code, compare fingerprints, grant only what this device holds", async () => {
    const { page, errors } = await open(DESKTOP);
    // A label is the offering device's own word: markup in it is text, never HTML.
    await page.evaluate(() => globalThis.__pairFake.addOffer("HACK 0001", { label: "<img src=x onerror=window.__owned=1>", role: "client", fingerprint: "0000aaaa1111" }));
    await openDevices(page);
    await expect(page.locator(".pair-card").first()).toContainText("“Shane's phone”");
    await page.getByRole("button", { name: "Pair a device" }).click();

    // A code nobody is waiting under says so, rather than failing in general words.
    await page.getByLabel("Its code").fill("ZZZZ 9999");
    await page.getByRole("button", { name: "Find it" }).click();
    await expect(page.getByRole("alert")).toContainText("No device is waiting under that code");

    // Typed any old way: lower case, a hyphen.
    await page.getByLabel("Its code").fill("7k3m-q9xd");
    await page.getByRole("button", { name: "Find it" }).click();
    await expect(page.locator(".pair-h").first()).toHaveText("“Kitchen tablet” wants to join as a device");
    await expect(page.locator(".pair-fp")).toHaveText("a41c 9e07 d3b2");
    // This phone passes on only what it holds (view, drive, screen): no approve, no desktop, no install on offer.
    const boxes = page.locator(".pair-grant .pair-check");
    await expect(boxes).toHaveText([/See sessions/, /Start and steer/, /See its screen/]);
    await expect(page.getByRole("checkbox", { name: /See sessions/ })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /See its screen/ })).not.toBeChecked();
    await page.getByRole("checkbox", { name: /See its screen/ }).check();
    // The confirm is the answer to the question on screen, not an OK.
    await page.getByRole("button", { name: "They match: pair it" }).click();
    await expect(page.locator(".pair-h").first()).toHaveText("Paired");
    expect(await page.evaluate(() => globalThis.__pairFake.confirmed.map((c) => [c.label, c.grant.scopes.join(",")])))
        .toEqual([["Kitchen tablet", "view,drive,screen"]]);

    // "They don't match" pairs nothing and says why that matters.
    await page.getByRole("button", { name: "Pair another" }).click();
    await page.getByLabel("Its code").fill("HACK0001");
    await page.getByRole("button", { name: "Find it" }).click();
    await expect(page.locator(".pair-h").first()).toContainText("<img src=x onerror=window.__owned=1>");
    expect(await page.evaluate(() => globalThis.__owned)).toBeUndefined();
    await page.getByRole("button", { name: "They don't match" }).click();
    await expect(page.locator(".pair-h").first()).toHaveText("Nothing was paired");
    expect(await page.evaluate(() => globalThis.__pairFake.confirmed.length)).toBe(1);
    expect(errors).toEqual([]);
});

test("joining an account: the code and this device's fingerprint, then the account once the other side confirms", async () => {
    const { page, errors } = await open(DESKTOP);
    await page.evaluate(() => globalThis.__pairFake.setMembership(null));
    await openDevices(page);
    await expect(page.locator(".pair-h").first()).toHaveText("This device is in no account");
    // Creating says where the root would live and what losing it costs, before anyone relies on it.
    await page.getByRole("button", { name: "Create an account" }).click();
    const warn = page.getByRole("note");
    await expect(warn).toContainText("The root key is kept only in this site's data in this browser.");
    await expect(warn).toContainText("nothing can be paired or renewed");
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: "Join an account" }).click();
    await page.getByRole("button", { name: "Get a code" }).click();
    await expect(page.locator(".pair-code")).toHaveText("7K3M Q9XD");
    await expect(page.locator(".pair-fp")).toHaveText("3f9a 0c21 b7e4");
    // The QR carries the offer's text: what is drawn is exactly what the encoder makes of it, module for module.
    const qr = page.getByRole("img", { name: /Pairing QR code/ });
    await expect(qr).toBeVisible();
    const { encode } = await import("uqr");
    const want = encode(`WMLPAIR:1:7K3MQ9XD:3F9A0C21B7E4${"0".repeat(52)}`, { ecc: "M", border: 2 }).data.flat().filter(Boolean).length;
    expect(Number(await qr.getAttribute("data-modules"))).toBe(want);
    // …and it SCANS: where the browser has a barcode reader (macOS, Android; not Linux CI), the drawing decodes to it.
    const scanned = await page.evaluate(async () => {
        if (!("BarcodeDetector" in window)) return null;
        const img = new Image();
        img.src = "data:image/svg+xml;utf8," + encodeURIComponent(new XMLSerializer().serializeToString(document.querySelector(".pair-qr")));
        await img.decode();
        const c = document.createElement("canvas");
        c.width = c.height = 400;
        c.getContext("2d").drawImage(img, 0, 0, 400, 400);
        return (await new BarcodeDetector({ formats: ["qr_code"] }).detect(c)).map((g) => g.rawValue);
    });
    if (scanned) expect(scanned).toEqual([`WMLPAIR:1:7K3MQ9XD:3F9A0C21B7E4${"0".repeat(52)}`]);
    await expect(page.getByRole("status")).toContainText(/works for [0-9]:[0-5][0-9]/);

    // The hub gave up on it: said with what to do, and the form is back for another go.
    await page.evaluate(() => globalThis.__pairFake.fail("timed-out"));
    await expect(page.getByRole("alert")).toContainText("Nobody answered the code in time");
    // Cancelling withdraws the offer: nothing is left answerable under the code.
    await page.getByRole("button", { name: "Get a code" }).click();
    await expect(page.locator(".pair-code")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(await page.evaluate(() => globalThis.__pairFake.waiting)).toBeNull();

    // And answered from the other side: this device is in the account, as what it chose to be called.
    await page.getByRole("button", { name: "Join an account" }).click();
    await page.getByLabel("Call this device").fill("Kitchen tablet");
    await page.getByRole("button", { name: "Get a code" }).click();
    await expect(page.locator(".pair-code")).toBeVisible();
    await page.evaluate(() => globalThis.__pairFake.answer());
    await expect(page.locator(".pair-h").first()).toHaveText("“Kitchen tablet”, a device");
    await expect(page.getByRole("button", { name: "Pair a device" })).toHaveCount(0);
    await expect(page.locator(".pair-card").first()).toContainText("Pair new devices on the one that holds the account's root");
    expect(errors).toEqual([]);
});

test("the devices on the account: which is this one, when each was seen, and removing one only after saying what it costs", async () => {
    const { page, errors } = await open(DESKTOP);
    await openDevices(page);
    const list = page.getByRole("region", { name: "Devices on this account" });
    const rows = list.locator(".pair-dev");
    await expect(rows).toHaveCount(4);
    const row = (name) => rows.filter({ hasText: name });
    // The one in your hand says so, and cannot be removed from here.
    await expect(row("Shane's phone").locator(".pair-dev-self")).toHaveText("This device");
    await expect(row("Shane's phone").getByRole("button", { name: "Remove…" })).toHaveCount(0);
    // Last seen is on every row; what each may do is in words.
    await expect(row("Kitchen tablet").locator(".pair-dev-seen")).toContainText("Seen");
    await expect(row("Kitchen tablet")).toContainText("See sessions");
    await expect(row("Work laptop")).toContainText("No scopes: it drives nothing");
    await expect(row("Work laptop")).toContainText("Can pair other devices");
    await expect(row("Work laptop")).toContainText("Signs revocations for this account");
    // A certificate's end is when it needs renewing; a lapsed one says to pair again.
    await expect(row("Kitchen tablet")).toContainText(/needs renewing within \d+ days/);
    await expect(row("Old phone")).toContainText("expired: pair it again");
    await expect(list).toContainText("A device stays until it is removed");

    // The revocation signer: the cost first, and a button that says it is going ahead anyway.
    await row("Work laptop").getByRole("button", { name: "Remove…" }).click();
    await expect(row("Work laptop")).toContainText("unable to remove ANY device");
    await row("Work laptop").getByRole("button", { name: "Keep it" }).click();
    await expect(rows).toHaveCount(4);

    // An ordinary device: one confirmation, then it is gone and the list says so.
    await row("Kitchen tablet").getByRole("button", { name: "Remove…" }).click();
    await row("Kitchen tablet").getByRole("button", { name: "Remove it" }).click();
    await expect(rows).toHaveCount(3);
    await expect(list.getByRole("status")).toContainText("“Kitchen tablet” was removed");

    // The connection history is folded until asked for, newest first.
    const history = page.locator(".pair-history");
    await expect(history.locator(".pair-log")).toHaveCount(0);
    await history.locator("summary").click();
    await expect(history.locator(".pair-log li").first()).toContainText("revoked");
    expect(errors).toEqual([]);
});

test("opening the page at an address writes no history: the hash is never wiped and pushed back", async () => {
    const page = await browser.newPage({ viewport: DESKTOP });
    await page.addInitScript(() => {
        globalThis.__historyWrites = [];
        for (const f of ["pushState", "replaceState"]) { const o = history[f].bind(history); history[f] = (a, b, u) => { globalThis.__historyWrites.push(`${f} ${u}`); return o(a, b, u); }; }
    });
    for (const hash of [`#/s/${encodeURIComponent(CHAT)}`, "#/settings/devices", "#/search"]) {
        await page.goto(`${server.url}${hash}`);
        await expect(page.locator(".chat")).toBeVisible();
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => globalThis.__historyWrites), hash).toEqual([]);
        expect(new URL(page.url()).hash).toBe(hash);
    }
    await page.close();
});

test("addresses: a link opens a view and its tab, the address follows what is on screen, and back undoes a step", async () => {
    // A path, as someone would type or paste it; the server sends it to its hash, where the page routes.
    const page = await browser.newPage({ viewport: DESKTOP });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${server.url}settings/devices`);
    await expect(page).toHaveURL(/#\/settings\/devices$/);
    await expect(page.getByRole("tab", { name: "Devices" })).toHaveAttribute("aria-selected", "true");

    // Another tab rewrites the address in place: back does not step through tabs.
    await page.getByRole("tab", { name: "Runtimes" }).click();
    await expect(page).toHaveURL(/#\/settings\/runtimes$/);

    // Closing Settings and opening it again from the gear: back from there closes it.
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page).not.toHaveURL(/#\/settings/);
    await page.locator(".chat-list-foot .chat-gear-btn").click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await expect(page).toHaveURL(/#\/settings\//);
    await page.goBack();
    await expect(page.getByRole("tablist", { name: "Settings" })).toHaveCount(0);

    // The other views have addresses too, and a reload keeps the one you are on.
    await page.goto(`${server.url}#/search`);
    await expect(page.getByRole("main", { name: /Search/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("main", { name: /Search/ })).toBeVisible();
    expect(errors).toEqual([]);
    await page.close();
});

test("the phone app's start page is the standalone client, not the demo @mobile", async () => {
    // `dist-app/index.html` is the standalone client, served as a site of its own. The demo world
    // (window.__chatFake) must never be what it opens.
    const { serveStatic } = await import("./static-server.mjs");
    const app = await serveStatic("dist-app");
    const page = await browser.newPage({ viewport: PHONE });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
        await page.goto(app.url);
        await expect(page.locator(".pair-h").first()).toHaveText("This device is in no account");
        await expect(page.getByRole("button", { name: "Create an account" })).toBeVisible();
        expect(await page.evaluate(() => typeof globalThis.__chatFake)).toBe("undefined");
        expect(errors).toEqual([]);
    } finally {
        await page.close();
        await app.close();
    }
});

test("a waiting count is the accent in the calm view and the warning yellow outside it @mobile", async () => {
    // Something waiting on you is the app ASKING, not a warning that something went wrong, so in the reading view it
    // is the accent — the colour the phone app draws the same state in. The busy developer view keeps the yellow,
    // where it sits among the other machinery and a second accent would say nothing. It is the same at either
    // pointer size: the touch-only cyan existed because yellow read as an alarm in a phone's frame, which is not a
    // problem the accent has.
    const notice = async (opts) => {
        const ctx = await browser.newContext({ viewport: PHONE, ...opts });
        const page = await ctx.newPage();
        await page.goto(server.url);
        const v = await page.evaluate(() => {
            const mk = (host) => getComputedStyle(host.appendChild(Object.assign(document.createElement("span"), { className: "chat-appr-badge" }))).backgroundColor;
            return { calm: mk(document.querySelector(".chat.calm")), plain: mk(document.body) };
        });
        await ctx.close();
        return v;
    };
    const touch = { hasTouch: true, isMobile: true };
    expect(await notice({ colorScheme: "dark" })).toEqual({ calm: "rgb(99, 102, 241)", plain: "rgb(234, 179, 8)" });
    expect(await notice({ colorScheme: "dark", ...touch })).toEqual({ calm: "rgb(99, 102, 241)", plain: "rgb(234, 179, 8)" });
    expect(await notice({ colorScheme: "light" })).toEqual({ calm: "rgb(99, 102, 241)", plain: "rgb(202, 138, 4)" });
});

test("phone (touch): the tab picker opens without raising the keyboard, and stays open when the keyboard comes @mobile", async () => {
    // A touch phone, not a narrow desktop: a coarse pointer, touch input, and the keyboard as a window resize.
    const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
        await page.goto(server.url);
        await page.locator(".chat").waitFor();
        await page.locator(".chat-start").tap();
        const pill = page.getByRole("button", { name: /^Where it runs/ });
        await pill.tap();
        const list = page.getByRole("listbox", { name: "Where it runs" });
        await expect(list).toBeVisible();
        // Nothing asked to type yet, so the filter does not have focus (which is what raises a phone's keyboard).
        expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("INPUT");
        // Tapping the filter raises the keyboard, which reaches the page as a shorter window. The list used to close
        // on any resize, so on Android it opened, the keyboard came up, and both were gone. Now it re-fits.
        await list.locator("input").tap();
        await page.setViewportSize({ width: PHONE.width, height: 480 });
        await page.waitForTimeout(200);
        await expect(list).toBeVisible();
        await page.keyboard.type("docs");
        await expect(list.getByRole("option", { name: /Tables/ })).toBeVisible();
        const box = await list.boundingBox();
        expect(box.y + box.height, "the list fits the window the keyboard left").toBeLessThanOrEqual(480);
        expect(errors).toEqual([]);
    } finally { await ctx.close(); }
});

test("phone (touch): no view scrolls sideways, and everything a finger taps is at least 40px @mobile", async () => {
    // Measured, not eyeballed: every button, tab, option and menu row on every view, on a touch phone. Text fields and
    // links inside a sentence are exempt (a finger taps INTO a field; a link's target is its line). What this caught
    // the day it was written: 22px icon buttons in the headers and rows, 30px runtime headings, a 23px "Dismiss".
    const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const probe = () => page.evaluate(async () => {
        // Measured at rest: the list's rows slide in from the left as the page opens, and a row mid-slide is not a row
        // off the screen.
        // (Finite ones only: a loading shimmer runs forever.)
        await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
        const W = innerWidth, out = [];
        if (document.documentElement.scrollWidth > W + 1) out.push(`the page scrolls sideways (${document.documentElement.scrollWidth}px)`);
        const name = (e) => (e.getAttribute("aria-label") || e.textContent || e.className).trim().replace(/\s+/g, " ").slice(0, 40);
        for (const e of document.querySelectorAll("button, [role=button], [role=tab], [role=radio], [role=option], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], summary")) {
            const r = e.getBoundingClientRect();
            if (!r.width || !r.height || getComputedStyle(e).visibility === "hidden" || e.closest("[inert],[aria-hidden=true]")) continue;
            // Sideways, anything; above or below, only what floats (a menu, a list): a page's content scrolls to it.
            const floats = e.closest("[role=menu], .chat-menu, .tp-pop");
            // For what floats, the POPUP must be on the screen; its rows may scroll inside it.
            const fr = floats?.getBoundingClientRect();
            if (r.right > W + 1 || r.left < -1 || (fr && (fr.top < -1 || fr.bottom > innerHeight + 1))) out.push(`off the screen: "${name(e)}"`);
            // A chip inside a line of text takes the finger with a hidden area around it (`::after`), so measure that.
            if (e.hasAttribute("data-inline-target")) {
                const a = getComputedStyle(e, "::after");
                const grow = (v) => -parseFloat(v) || 0;
                if (Math.min(r.width + grow(a.left) + grow(a.right), r.height + grow(a.top) + grow(a.bottom)) < 40) out.push(`${Math.round(r.width)}x${Math.round(r.height)} with no larger area: "${name(e)}"`);
                continue;
            }
            // A round button is round: as wide as it is tall, not stretched across a column.
            if (e.classList.contains("hbtn") && Math.abs(r.width - r.height) > 2) out.push(`a round button drawn ${Math.round(r.width)}x${Math.round(r.height)}: "${name(e)}"`);
            if (Math.min(r.width, r.height) < 40) out.push(`${Math.round(r.width)}x${Math.round(r.height)}: "${name(e)}"`);
        }
        return out;
    });
    try {
        for (const hash of ["", "#/s/laptop%3A3f9a0c21", "#/s/laptop%3A7b21d4e8", "#/settings/page", "#/settings/runtimes", "#/settings/devices", "#/search", "#/attention"]) {
            await page.goto(server.url + hash);
            await page.locator(".chat").waitFor();
            await page.waitForTimeout(300);
            expect(await probe(), `view ${hash || "(the list)"}`).toEqual([]);
        }
        // The gear's menu on a phone: it rose from a gear at the TOP of the screen, off the screen entirely.
        await page.goto(server.url);
        await page.locator(".chat").waitFor();
        await page.locator(".chat-list .head .chat-gear-btn").tap();
        await expect(page.getByRole("menu", { name: "Page menu" })).toBeVisible();
        expect(await probe(), "the gear's menu, open").toEqual([]);
        await page.goto(server.url);
        await page.locator(".chat-start").tap();
        expect(await probe(), "the start page").toEqual([]);
        await page.getByRole("button", { name: /^Where it runs/ }).tap();
        expect(await probe(), "the start page with the tab picker open").toEqual([]);
        expect(errors).toEqual([]);
    } finally { await ctx.close(); }
});

test("a session's model is at the top of its page and switches it; a runtime or session that cannot says why", async () => {
    for (const vp of [PHONE, DESKTOP]) {
        const { page, errors } = await open(vp, `#s=${encodeURIComponent(CHAT)}`);
        const pill = () => page.getByRole("button", { name: /^Model: / });
        const list = page.getByRole("listbox", { name: "Model" });
        await expect(pill()).toBeVisible();

        // The laptop switches: the pill shows what the runtime's index now says.
        await pill().click();
        await list.getByRole("option", { name: "gemma3:27b" }).click();
        await expect(pill()).toHaveAccessibleName("Model: gemma3:27b");
        const sent = (await commands(page)).filter((c) => c.type === "session.model");
        expect(sent.map((c) => c.model)).toEqual(["gemma3:27b"]);

        // A session whose loop is in a page: the runtime refuses, and the list says whose the model is from then on.
        await page.evaluate(() => { globalThis.__chatFake.handlers["session.model"] = () => ({ ok: false, error: { code: "unsupported", message: "the page script owns this session's model" } }); });
        await pill().click();
        await list.getByRole("option", { name: "qwen3:32b" }).click();
        await expect(page.locator(".chat-notice.error")).toContainText("the page script owns");
        await pill().click();
        await expect(list.getByRole("note")).toContainText("belongs to the page script");
        await expect(list.getByRole("option").first()).toHaveAttribute("aria-disabled", "true");
        await page.keyboard.press("Escape");
        await expect(list).toBeHidden();

        // A runtime that cannot switch at all: the same list, disabled, saying so.
        await page.evaluate(() => globalThis.__chatFake.setRuntime("laptop", { capabilities: { chat: true, agent: true } }));
        await pill().click();
        await expect(list.getByRole("note")).toContainText("cannot switch a session's model");
        expect(errors, `at ${vp.width}px`).toEqual([]);
        await page.close();
    }
});

test("the start page's model: in the box's row when the page is wide, at the top of the screen on a phone @mobile", async () => {
    for (const [vp, where] of [[DESKTOP, ".chat-start-row"], [PHONE, ".chat-start-top"]]) {
        const { page, errors } = await open(vp);
        if (vp === PHONE) await page.locator(".chat-start").click();
        const pill = page.getByRole("button", { name: /^Model: / });
        await expect(pill).toBeVisible();
        expect(await pill.evaluate((e, sel) => !!e.closest(sel), where), `at ${vp.width}px it sits in ${where}`).toBe(true);
        expect(errors).toEqual([]);
        await page.close();
    }
});

/** A Y4M video of one QR code, for Chromium's fake camera: raw 4:2:0 frames, the code's modules drawn black on white. */
async function qrVideo(text) {
    const { encode } = await import("uqr");
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const q = encode(text, { ecc: "M", border: 4 });
    const W = 480, H = 480, cell = Math.floor(W / q.size), off = Math.floor((W - cell * q.size) / 2);
    const y = Buffer.alloc(W * H, 255);
    q.data.forEach((row, r) => row.forEach((on, c) => {
        if (!on) return;
        for (let dy = 0; dy < cell; dy++) y.fill(0, (off + r * cell + dy) * W + off + c * cell, (off + r * cell + dy) * W + off + (c + 1) * cell);
    }));
    const uv = Buffer.alloc((W / 2) * (H / 2), 128);
    const frame = Buffer.concat([Buffer.from("FRAME\n"), y, uv, uv]);
    const file = path.join(mkdtempSync(path.join(tmpdir(), "qr-")), "qr.y4m");
    writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...Array(10).fill(frame)]));
    return file;
}

/** A page whose camera films `video`, on the web build, opened at Settings → Devices → Pair a device. */
async function pairWithCamera(video, { noNativeReader = false } = {}) {
    const b = await chromium.launch({ channel: "chromium", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${video}`] });
    const ctx = await b.newContext({ viewport: PHONE, permissions: ["camera"] });
    // WebKit has no BarcodeDetector, so an iPhone reads with jsQR: take the browser's reader away to read the same way.
    if (noNativeReader) await ctx.addInitScript(() => { delete globalThis.BarcodeDetector; });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${server.url}#/settings/devices`);
    await page.getByRole("button", { name: "Pair a device" }).click();
    return { b, page, errors };
}

test("scanning the new device's QR code: a match needs no comparing, a code naming other keys is refused @mobile", async () => {
    // The right code: the demo's waiting tablet, with its fingerprint in full.
    const good = await pairWithCamera(await qrVideo(`WMLPAIR:1:7K3MQ9XD:A41C9E07D3B2${"0".repeat(52)}`));
    try {
        await good.page.getByRole("button", { name: "Scan its QR code" }).click();
        await expect(good.page.locator(".pair-checked")).toHaveText("Scanned: the QR code named this device's keys, and they match.", { timeout: 15_000 });
        // Nothing to compare by eye: no fingerprint, no "do these match?", just what it may do.
        await expect(good.page.locator(".pair-card .pair-fp")).toHaveCount(0);
        await good.page.getByRole("button", { name: "Pair it", exact: true }).click();
        await expect(good.page.locator(".pair-h").first()).toHaveText("Paired");
        expect(await good.page.evaluate(() => globalThis.__pairFake.confirmed.map((c) => c.label))).toEqual(["Kitchen tablet"]);
        // The camera is off once it has read the code.
        expect(await good.page.evaluate(() => document.querySelectorAll("video").length)).toBe(0);
        expect(good.errors).toEqual([]);
    } finally { await good.b.close(); }

    // The same code, but a fingerprint that is not the waiting device's: refused, with no way to go on. Read by jsQR,
    // the reader every WebKit (the iPhone app, Safari) uses.
    const bad = await pairWithCamera(await qrVideo(`WMLPAIR:1:7K3MQ9XD:${"F".repeat(64)}`), { noNativeReader: true });
    expect(await bad.page.evaluate(() => typeof globalThis.BarcodeDetector)).toBe("undefined");
    try {
        await bad.page.getByRole("button", { name: "Scan its QR code" }).click();
        await expect(bad.page.locator(".pair-h").first()).toHaveText("Nothing was paired", { timeout: 15_000 });
        await expect(bad.page.locator(".pair-card").first()).toContainText("named other keys");
        await expect(bad.page.getByRole("button", { name: /pair it/i })).toHaveCount(0);
        expect(await bad.page.evaluate(() => globalThis.__pairFake.confirmed.length)).toBe(0);
        expect(bad.errors).toEqual([]);
    } finally { await bad.b.close(); }
});

/** A session of `turns` chat turns on the laptop, added through the fake host; answers with its key. */
async function longThread(page, turns, hash = `long${turns}`) {
    return page.evaluate(({ turns, hash }) => {
        const now = Date.now();
        const events = [];
        for (let i = 0; i < turns; i++) {
            const base = { id: `${hash}-${i}`, ts: now - (turns - i) * 1000, save: true, session: { hash, turn: i } };
            events.push({ ...base, kind: "chat", streaming: false,
                request: { model: "qwen3:32b", extend: null, messages: [{ role: "user", content: `Question ${i}` }], images: null, toolIds: null, schema: false, think: null, maxTokens: null },
                config: { system: null, model: "qwen3:32b", think: null, schema: false, toolIds: null, maxTokens: null, save: true } });
            events.push({ ...base, ts: base.ts + 500, kind: "chat-result", model: "qwen3:32b", extend: null, reasoning: null,
                sources: null, structured: false, usage: null, content: `Answer ${i} to that question.` });
        }
        globalThis.__chatFake.addSession({ id: { runtime: "laptop", hash }, kind: "chat", status: "done",
            createdTs: now - turns * 1000, lastTs: now, pendingApprovals: 0, title: `${turns} turns`, model: "qwen3:32b" }, events);
        return `laptop:${hash}`;
    }, { turns, hash });
}

test("a long transcript draws its newest turns only, and 'show earlier' draws more without losing the reader's place", async () => {
    const { page, errors } = await open(PHONE);
    const key = await longThread(page, 400);
    await page.goto(`${server.url}#/s/${encodeURIComponent(key)}`);
    await page.locator(".chat-transcript").getByText("Answer 399").waitFor();

    // Bounded: a 400-turn session draws a window, not 400 turns. (Measured before this existed: 34k nodes at 1000.)
    const drawn = () => page.locator(".chat-transcript .msg.user").count();
    expect(await drawn()).toBeLessThan(120);
    expect(await drawn()).toBeGreaterThan(20);
    await expect(page.locator(".chat-window-rest")).toContainText("earlier in this session");
    // The oldest turns are NOT in the DOM: this is a window, not a CSS trick.
    await expect(page.locator(".chat-transcript").getByText("Answer 0", { exact: false })).toHaveCount(0);

    // Growing keeps the reader where they were: the turn under the eye must not move. Read from the TOP of the
    // window, which is where someone who is about to ask for more of the past actually is (and not following the tail).
    const oldest = page.locator(".chat-transcript .msg.user .utext").first();
    const text = (await oldest.textContent()).trim();   // by TEXT: after growth, "the first turn" is a different one
    const anchor = page.locator(".chat-transcript .utext", { hasText: text }).first();
    await anchor.scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    const before = await anchor.boundingBox();
    const was = await drawn();
    await page.locator(".chat-window-edge .chat-earlier-retry").click();
    await expect.poll(drawn).toBeGreaterThan(was);
    await page.waitForTimeout(100);
    const after = await anchor.boundingBox();
    expect(Math.abs(after.y - before.y)).toBeLessThan(60);
    expect(errors).toEqual([]);
    await page.close();
});

test("growing the window adds to the TOP: the newest turn is still drawn, whatever was asked for", async () => {
    const { page, errors } = await open(PHONE);
    const key = await longThread(page, 300, "grow1");
    await page.goto(`${server.url}#/s/${encodeURIComponent(key)}`);
    await page.locator(".chat-transcript").getByText("Answer 299").waitFor();
    const drawn = () => page.locator(".chat-transcript .msg.user").count();
    const first = await drawn();
    for (let i = 0; i < 3; i++) {
        const was = await drawn();
        await page.locator(".chat-window-edge .chat-earlier-retry").click();
        await expect.poll(drawn).toBeGreaterThan(was);
    }
    expect(await drawn()).toBeGreaterThan(first);
    // The end of the conversation is what a transcript is anchored to: growing it must never push the newest out.
    await expect(page.locator(".chat-transcript").getByText("Answer 299")).toHaveCount(1);
    expect(errors).toEqual([]);
    await page.close();
});

test("a citation to a step the window no longer draws brings it back, rather than doing nothing", async () => {
    const { page, errors } = await open(DESKTOP);
    // Pad the cited run with enough later steps that its FIRST step falls outside what the transcript draws. Emitted
    // while the session is closed, so they are in its log when it is opened.
    await page.evaluate(() => {
        const key = "laptop:5e6f7a80", hash = "5e6f7a80", now = Date.now();
        // BETWEEN the cited step (1) and the answer (at step 3), so the answer carrying the citation stays drawn
        // while the step it names is pushed out of the window.
        for (let i = 0; i < 140; i++) {
            globalThis.__chatFake.emit(key, {
                kind: "agent-step", id: `${hash}-pad${i}`, ts: now + i, save: true, session: { hash, turn: 0 },
                step: 1 + (i + 1) / 200, seq: 100 + i, tool: "exec", arguments: { js: `${i}` }, result: `${i}`,
            });
        }
    });
    await page.goto(`${server.url}#s=laptop%3A5e6f7a80`);
    await expect(page.locator(".tok-link")).toBeVisible();
    // The cited step is NOT drawn: it is far enough back that the window holds it out.
    await expect(page.locator('[data-astep-seq="1"]')).toHaveCount(0);
    await expect(page.locator(".chat-window-rest")).toBeVisible();

    // Clicking the citation is what a reader does next, and it has to land on the step it names.
    await page.locator(".tok-link").click();
    await expect(page.locator('[data-astep-seq="1"]')).toHaveCount(1);
    await expect(page.locator('[data-astep-seq="1"]')).toHaveClass(/open/);
    expect(errors).toEqual([]);
    await page.close();
});

// A fade PROMISES there is more that way. Drawn at rest it promises it about nothing, and a dimmed first line with
// clear space above it reads as precisely the cut-off document the fade was added to soften — which is what the
// session list did, over its own first group heading, while sitting at the top of a list that fits on screen.
test("an edge fades only where the document continues past it", async () => {
    const { page, errors } = await open(PHONE);
    const alpha = (sel, pseudo) => page.evaluate(([s, p]) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const cs = getComputedStyle(el, p);
        return cs.display === "none" ? 0 : parseFloat(cs.opacity);
    }, [sel, pseudo]);

    // The list, at its top and short enough to need no scrolling: neither end continues, so neither end fades.
    await page.locator(".chat-list-scroll").waitFor();
    await expect.poll(() => alpha(".chat-list-scroll", "::before")).toBe(0);
    await expect.poll(() => alpha(".chat-list-scroll", "::after")).toBe(0);

    // A transcript long enough to scroll, which opens pinned to its newest turn: the end is reached, the start is
    // several screens up, so the top fades and the bottom does not.
    const key = await longThread(page, 30, "fade");
    await page.goto(`${server.url}#/s/${encodeURIComponent(key)}`);
    await page.locator(".chat-transcript").getByText("Answer 29").waitFor();
    await expect.poll(() => alpha(".chat-transcript", "::after")).toBe(0);
    await expect.poll(() => alpha(".chat-transcript", "::before")).toBe(1);

    // And the other way round once the reader is back at the start.
    await page.locator(".chat-transcript").evaluate((el) => { el.scrollTop = 0; });
    await expect.poll(() => alpha(".chat-transcript", "::before")).toBe(0);
    await expect.poll(() => alpha(".chat-transcript", "::after")).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
});

// IN-CHAT OPTIONS ON A WIDE PAGE. The calm view has no header band by design, which left the session's own actions —
// looking at its page, exporting it — with no door at all on the view that is the default.
test("the wide chat's ⋮ carries the session's own options, and Export chat writes a file", async () => {
    const { page, errors } = await open(DESKTOP, `#/s/${encodeURIComponent(CHAT)}`);
    await page.locator(".chat-transcript").waitFor();
    await page.locator(".chat-more-float").click();
    const menu = page.locator(".chat-head-menu");
    await expect(menu).toContainText("Export chat");

    await menu.getByRole("menuitem", { name: /Export chat/ }).click();
    const dialog = page.locator(".chat-dialog");
    await expect(dialog.locator("h2")).toHaveText("Export chat");
    // Three shapes, and this page can print, so PDF is among them.
    await expect(dialog.locator(".chat-export-opt")).toHaveCount(3);

    // The file is really written: the export goes through the services seam to the platform's own saveFile, and
    // nothing before this checked that the chat page had one wired at all.
    const [download] = await Promise.all([
        page.waitForEvent("download"),
        dialog.getByRole("button", { name: "Export" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^ml-(chat|agent)-.*\.(md|zip)$/);
    await expect(dialog).toHaveCount(0);   // and it closes behind itself
    expect(errors).toEqual([]);
    await page.close();
});

// The collapse chevron has no gutter to sit in at a phone's width, and on the left of the footer row it was the one
// control in the transcript lined up with nothing — under the paragraph's first character, as if it belonged to it.
test("the answer's collapse control sits in the gutter on a wide page and with the other controls on a phone @mobile", async () => {
    const x = async (page, sel) => (await page.locator(sel).first().boundingBox()).x;
    const wide = await open(DESKTOP, `#/s/${encodeURIComponent(CHAT)}`);
    await wide.page.locator(".msg.asst .who-toggle").waitFor();
    expect(await x(wide.page, ".msg.asst .who-toggle")).toBeLessThan(await x(wide.page, ".msg.asst .md"));
    expect(wide.errors).toEqual([]);
    await wide.page.close();

    const phone = await open(PHONE, `#/s/${encodeURIComponent(CHAT)}`);
    await phone.page.locator(".msg.asst .who-toggle").waitFor();
    expect(await x(phone.page, ".msg.asst .who-toggle")).toBeGreaterThan(await x(phone.page, ".msg.asst .mrow .icon-btn"));
    expect(phone.errors).toEqual([]);
    await phone.page.close();
});

// Continue is the ONE thing a capped run offers, and the panel's pill is sized for a 360px column where everything
// is small together. On a page this wide that same pill read as a footnote under the line that had just said the
// run stopped — a chip among the prose rather than the way onward.
test("the Continue pill is sized as an action on a wide page, not as a chip", async () => {
    // CAPPED_HERE, not CAPPED: Continue is only offered on a run whose page still holds it.
    const { page, errors } = await open(DESKTOP, `#s=${encodeURIComponent(CAPPED_HERE)}`);
    const wrap = page.locator(".continue-wrap");
    await expect(wrap).toBeVisible();
    const box = await wrap.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(34);
    // Both halves of the split control fill it: a chevron half shorter than the button leaves a seam down the pill.
    expect((await page.locator(".continue-more").boundingBox()).height).toBe(box.height);
    expect(errors).toEqual([]);
    await page.close();
});

// "waiting on you" beside "1 approval" is the same fact in two voices. The badge is the one that says how many and
// reads at a glance, so where there is a count the count IS the status.
test("a session waiting on you says so once, as one badge", async () => {
    const { page, errors } = await open(DESKTOP);
    const meta = row(page, WAITING).locator(".chat-row-meta");
    await expect(meta.locator(".chat-appr-badge")).toHaveText("1 pending");
    await expect(meta).not.toContainText("waiting on you");
    await expect(meta.locator(".chat-status")).toHaveCount(0);
    // A status with no count of its own still speaks: the badge only replaces what it can say better.
    await expect(row(page, CAPPED).locator(".chat-status")).toHaveText("stopped at its step cap");
    expect(errors).toEqual([]);
    await page.close();
});

// A GATE THAT HAS NOT BEEN DRAWN YET IS NOT A GATE THAT IS OUT OF REACH, and reading the two alike put the bar on
// screen for a few frames of every reload: the summary says an approval is pending before the transcript's events
// have arrived, so there was no card to find, and the bar announced a gate about to appear right under it.
// Recorded with an observer rather than polled, because a flash is exactly what a poll misses.
test("the approval bar does not flash on load when the gate is right there", async () => {
    const page = await browser.newPage({ viewport: DESKTOP });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
        globalThis.__barSeen = 0;
        new MutationObserver((records) => {
            for (const r of records) for (const n of r.addedNodes) {
                if (n.nodeType === 1 && (n.matches?.(".chat-waiting") || n.querySelector?.(".chat-waiting"))) globalThis.__barSeen++;
            }
        }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(`${server.url}#/s/${encodeURIComponent(WAITING)}`);

    // The gate itself lands and is on screen, so the bar has nothing to say.
    await page.locator(".astep-approve").waitFor();
    await expect(page.locator(".astep-approve")).toBeInViewport();
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => globalThis.__barSeen)).toBe(0);
    await expect(page.locator(".chat-waiting")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.close();
});

// A card with neither a fix nor a Dismiss reads as a message that ignored you. The answer — it clears when the
// machine it is about is put right, and not before — belongs in a corner, not on every card.
test("a card that cannot be dismissed says why, by pointer and by tap", async () => {
    const { page, errors } = await open(DESKTOP, "#/attention");
    const cards = page.locator(".chat-att-item");
    const stuck = cards.filter({ hasText: "archive folder needs reconnecting" });
    const dismissable = cards.filter({ hasText: "No utility model" });

    // Only where there is nothing to press: a card you CAN dismiss has no question to answer.
    await expect(stuck.locator(".chat-att-why")).toHaveCount(1);
    await expect(dismissable.locator(".chat-att-dismiss")).toHaveCount(1);
    await expect(dismissable.locator(".chat-att-why")).toHaveCount(0);

    // Tapping says it IN the card. The panel's tooltip cannot: a touch tap begins with the pointerdown that hides it.
    await expect(stuck.locator(".chat-att-why-note")).toHaveCount(0);
    await stuck.locator(".chat-att-why").click();
    await expect(stuck.locator(".chat-att-why-note")).toContainText("until it is put right on Work laptop");
    await stuck.locator(".chat-att-why").click();
    await expect(stuck.locator(".chat-att-why-note")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.close();
});

// The notes sit UNDER the results, so one about a machine the filter has excluded reads as being about the results
// above it: picking Lab box and being told to reconnect Work laptop's folder looks like Lab box is the one at fault.
test("the archive-folder note follows the device filter, rather than speaking for every machine", async () => {
    const { page, errors } = await open(DESKTOP, "#/search");
    const foot = page.locator(".chat-search-foot");
    const devices = page.locator(".chat-search-devices");

    // Across every device, the lapsed one is named.
    await expect(foot).toContainText("Work laptop's archive folder");

    // Narrowed to a machine that has no such problem, it says nothing at all.
    await devices.getByRole("button", { name: "Lab box" }).click();
    await expect(foot).toHaveCount(0);

    // Narrowed to the machine it IS about, it comes back.
    await devices.getByRole("button", { name: "Work laptop" }).click();
    await expect(foot).toContainText("Work laptop's archive folder");
    expect(errors).toEqual([]);
    await page.close();
});

// Being invisible at rest does not make a thing take no room. The fold chevron sat between a runtime's name and its
// badge, so a heading with a badge held a chevron-shaped hole in the middle of itself — which reads as the badge
// having drifted away from the name.
test("a runtime's fold chevron sits after everything its heading says, not inside it", async () => {
    const { page, errors } = await open(DESKTOP);
    const head = page.locator(".chat-rt", { hasText: "Lab box" });
    const x = async (sel) => (await head.locator(sel).boundingBox()).x;
    const [name, chip, tri] = [await x(".chat-rt-name"), await x(".chat-chip"), await x(".tri")];
    expect(chip).toBeGreaterThan(name);
    expect(tri).toBeGreaterThan(chip);
    // And the badge follows the name closely, rather than across a gap left for something you cannot see.
    const nameBox = await head.locator(".chat-rt-name").boundingBox();
    expect(chip - (nameBox.x + nameBox.width)).toBeLessThan(12);
    expect(errors).toEqual([]);
    await page.close();
});

// A fade you have not earned yet must not be on screen AT ALL. It used to default to drawn and be taken away once
// the scroller had been measured, so a session opened at its start showed the fade for a frame and you watched it
// leave. Sampled every frame from before the app loads, because one look after the fact sees only the end state.
test("opening a session that is already at its start never shows the fade at all @mobile", async () => {
    const page = await browser.newPage({ viewport: PHONE });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
        globalThis.__fades = [];
        const tick = () => {
            const el = document.querySelector(".chat-transcript");
            if (el) {
                const top = getComputedStyle(el, "::before"), bot = getComputedStyle(el, "::after");
                globalThis.__fades.push([top.display === "none" ? 0 : parseFloat(top.opacity), parseFloat(bot.opacity)]);
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
    await page.goto(`${server.url}#/s/${encodeURIComponent(CHAT)}`);
    await page.locator(".chat-transcript").getByText("Per token, the cache holds").waitFor();
    await page.waitForTimeout(400);

    // This transcript fits, so nothing continues in either direction and neither fade was ever entitled to draw.
    const fades = await page.evaluate(() => globalThis.__fades);
    expect(fades.length).toBeGreaterThan(5);   // the sampler really ran
    expect(Math.max(...fades.map((f) => f[0]))).toBe(0);
    expect(Math.max(...fades.map((f) => f[1]))).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
});

// The back button used to be positioned absolutely over the corner while this bar carried 60px of padding to dodge
// it — two mechanisms placing two things that belong together, and it read as exactly that: a chevron adrift above a
// pill that had drifted the other way. A session's own header already reads `‹ <model>`; a new one should too.
test("starting a session on a phone leads with one row: the way back, then the model @mobile", async () => {
    const { page, errors } = await open(PHONE);
    await page.getByRole("button", { name: "New session" }).click();
    const bar = page.locator(".chat-start-top");
    await expect(bar).toBeVisible();
    const back = bar.locator(".chat-sheet-back");
    const model = bar.locator(".tp-pill-model");
    await expect(back).toBeVisible();
    await expect(model).toBeVisible();

    // ONE ROW: same line, back first, and the model does not begin a third of the way across the screen.
    const [b, m] = [await back.boundingBox(), await model.boundingBox()];
    expect(Math.abs((b.y + b.height / 2) - (m.y + m.height / 2))).toBeLessThan(4);
    expect(b.x).toBeLessThan(m.x);
    expect(m.x - (b.x + b.width)).toBeLessThan(24);
    expect(errors).toEqual([]);
    await page.close();
});

// Every other row on this panel is a short string that right-aligns into a tidy column; a wrapping SET of chips is
// not that kind of value, and squeezed into 60% at the right it came out centre-ragged. And the storage bars each
// sized their own value column, so a row of bars ended in three different places — the one thing bars are for.
test("the runtime panel's lists read as lists: chips left and full width, bars ending together", async () => {
    const { page, errors } = await open(DESKTOP, "#/settings/runtimes");
    const caps = page.locator(".rt-caps");
    await expect(caps).toBeVisible();

    // The chips start at the row's left edge and every wrapped line starts there too.
    const xs = await caps.locator(".chat-chip").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)));
    expect(new Set(xs.filter((x, i) => i === 0 || x < xs[i - 1])).size).toBe(1);
    // And the label above them is a label, not a 240px column turned on its side.
    const label = await caps.locator("xpath=../div[@class='chat-set-label']").boundingBox();
    expect(label.height).toBeLessThan(60);

    // Every bar ends at the same place, whatever its figure reads.
    const rights = await page.locator(".stor-tools .stor-toolbar").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
    expect(rights.length).toBeGreaterThan(1);
    expect(new Set(rights).size, `bars ended at ${rights.join(", ")}`).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
});

// The list and the phone's list are the same list. Four things had drifted: the status sat LAST, after a hostname of
// a different width on every row; the agent marker was a panel badge at 0.75em inside a .86em line, so it read at
// about two-thirds of the words beside it; the meta line wrapped; and what needs you was only findable by knowing
// which machine it was on.
test("the session list reads as the phone's: status first, one line, and what needs you at the top", async () => {
    const { page, errors } = await open(DESKTOP);
    const row = page.locator(`.chat-list .chat-row[data-session="${WAITING}"]`).last();
    const meta = row.locator(".chat-row-meta");
    const x = async (sel) => (await meta.locator(sel).boundingBox()).x;

    // WHERE IT STANDS, then WHAT IT IS, then WHERE IT LIVES.
    expect(await x(".chat-appr-badge")).toBeLessThan(await x(".agent-badge"));
    expect(await x(".agent-badge")).toBeLessThan(await x(".chat-page, .chat-row-rt"));

    // One line, whatever is on it — a status that drops to a second row is in a different place on every row.
    for (const h of await page.locator(".chat-list .chat-row-meta").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) {
        expect(h).toBeLessThan(20);
    }

    // The agent marker is the line's own size, and it carries the glyph the phone has always drawn.
    const sizes = await meta.evaluate((m) => {
        const px = (s) => parseFloat(getComputedStyle(m.querySelector(s)).fontSize);
        return { agent: px(".agent-badge"), host: px(".chat-page, .chat-row-rt") };
    });
    expect(sizes.agent).toBeCloseTo(sizes.host, 1);
    await expect(meta.locator(".agent-badge svg")).toHaveCount(1);

    // And what is waiting on you is the first group, however many machines there are — and it LEAVES its own group
    // while it is up there: the same row twice within one screen reads as a bug.
    const groups = page.locator(".chat-list .chat-group");
    await expect(groups.first()).toHaveClass(/chat-needs-you/);
    await expect(groups.first().locator(".chat-row")).toHaveCount(1);
    await expect(page.locator(`.chat-list .chat-row[data-session="${WAITING}"]`)).toHaveCount(1);

    // Pinning from up here cannot move the row, so it says so instead: the press did something.
    await expect(groups.first().locator(".chat-row-pin")).toHaveCount(0);
    await page.locator(".chat-needs-you .chat-row-wrap").getByRole("button", { name: /options/i }).click();
    await page.getByRole("menuitem", { name: /^Pin to the top/ }).click();
    await expect(groups.first().locator(".chat-row-pin")).toHaveCount(1);
    expect(errors).toEqual([]);
    await page.close();
});

// A capped run was offering BOTH ways forward at once, and only one of them could work: Continue is delivered
// through the page that still holds the run, so on a run whose tab has closed the runtime answers "the page no
// longer holds this run" and the press does nothing. The bolder of the two buttons was the one that could not.
test("a capped run offers the one way forward that works, not both", async () => {
    const { page, errors } = await open(DESKTOP, `#/s/${encodeURIComponent(CAPPED_HERE)}`);
    // Its tab is open, so it carries on in place — and there is nothing to resume onto.
    await expect(page.locator(".continue-wrap")).toBeVisible();
    await expect(page.locator(".chat-resume")).toHaveCount(0);

    // Its page has gone, so the offer is to put it back on one. Continue would reach nothing.
    await page.goto(`${server.url}#/s/${encodeURIComponent(CAPPED)}`);
    await expect(page.locator(".chat-resume")).toBeVisible();
    await expect(page.locator(".continue-wrap")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.close();
});

// And resuming ASKS HOW FAR, because a resume that re-homes a run and leaves it stopped is two presses for one
// intention: you opened this to make it go.
test("resuming a run picks its budget and carries it on in one press", async () => {
    const { page, errors } = await open(DESKTOP, `#/s/${encodeURIComponent(CAPPED)}`);
    await page.getByRole("button", { name: "Resume on a page" }).click();
    const dialog = page.locator(".chat-dialog");
    await expect(dialog.locator("h2")).toHaveText("Resume this run");
    await expect(dialog.locator(".chat-seg-opt")).toHaveCount(3);
    await dialog.getByRole("radio", { name: "50 steps" }).click();
    await dialog.getByRole("button", { name: "Resume and go" }).click();

    // The command carried the budget, and the run is going rather than sitting on a page waiting to be pressed again.
    await expect.poll(async () => (await commands(page)).filter((c) => c.type === "session.resume").at(-1)?.maxSteps).toBe(50);
    await expect(page.locator(".chat-resume")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.close();
});

// A step that CANNOT close has nothing to animate, and the guard for that said `awaiting` — but a gated step in calm
// closes like any other, because the intent line above it says what is being asked. So the one step you are most
// likely to be poking at snapped shut while every step beside it eased.
test("a gated step closes the way every other step closes", async () => {
    const { page, errors } = await open(DESKTOP, `#/s/${encodeURIComponent(WAITING)}`);
    const heights = async (name) => page.evaluate(async (tool) => {
        const step = [...document.querySelectorAll(".astep")].find((e) => e.textContent.includes(tool));
        const head = step.querySelector("button");
        head.click();
        await new Promise((r) => setTimeout(r, 400));
        const opened = step.getBoundingClientRect().height;
        head.click();
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
        return { opened, afterTwoFrames: step.getBoundingClientRect().height };
    }, name);

    // Two frames in, a step that is easing shut has barely moved. One that snapped has already lost most of itself.
    for (const tool of ["exec", "fetch_url"]) {
        const { opened, afterTwoFrames } = await heights(tool);
        expect(opened).toBeGreaterThan(80);
        expect(afterTwoFrames, `${tool} snapped instead of easing`).toBeGreaterThan(opened * 0.9);
    }
    expect(errors).toEqual([]);
    await page.close();
});

// Continuing has to CARRY ON. The demo set the summary to `running` and emitted nothing else, but the transcript is
// built from EVENTS, not from the summary — so the run still read as stopped at its cap, the button stayed, and
// pressing it again was refused with "only a run stopped at its step cap can continue".
test("continuing a capped run carries it on, and the offer goes with it", async () => {
    const { page, errors } = await open(DESKTOP, `#/s/${encodeURIComponent(CAPPED_HERE)}`);
    const steps = () => page.locator(".astep").count();
    const before = await steps();
    await expect(page.locator(".continue-wrap")).toBeVisible();

    await page.locator(".continue-run").click();
    await expect.poll(steps).toBeGreaterThan(before);
    await expect(page.locator(".continue-wrap")).toHaveCount(0);
    // And it is not still asking: pressing again is what produced the refusal.
    await expect(page.locator(".chat-notice")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.close();
});
