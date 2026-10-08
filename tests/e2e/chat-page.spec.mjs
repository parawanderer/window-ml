// THE CHAT PAGE AS AN EXTENSION TAB, over the REAL local runtime: `chat.html` talking to the background's session
// index through the `ml-sessions` port (docs/spec/CHAT_PAGE.md slice 3). The web spec beside this one drives the same
// app against a fake host; this one proves the wiring that only a real browser has — the port, the worker's index,
// and a command that reaches another tab's page.
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

/** The chat page, open in its own tab, with page errors failing the test. */
async function openChatPage(ext) {
    const page = await ext.context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`chrome-extension://${ext.extensionId}/chat.html`);
    await page.locator(".chat").waitFor();
    return { page, errors };
}

test("a page's own chat appears in the extension's chat page, and can be answered from it", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
        fake.setScript([{ content: "the first answer" }, { content: "the second answer" }]);

        const { page: chat, errors } = await openChatPage(ext);
        // This browser is a runtime like any other, named and reported by the worker rather than assumed by the page.
        await expect(chat.locator(".chat-rt", { hasText: "This browser" })).toBeVisible();

        // A chat started on an ordinary page, the way a person would from the console.
        const site1 = await ext.context.newPage();
        await site1.goto(site.url + "/");
        await waitForMl(site1);
        const hash = await site1.evaluate(async () => {
            const c = window.ml.createChat({});
            await c.chat("what is a service worker?");
            return c.hash;
        });

        const row = chat.locator(`.chat-row[data-session="local:${hash}"]`);
        await expect(row).toBeVisible();
        await row.click();
        await expect(chat.locator(".chat-main")).toContainText("the first answer");

        // Answering from the chat page: the command crosses the worker to the page that holds the session, and the
        // transcript changes because the runtime reported the turn, not because the composer assumed it.
        await chat.locator(".composer .cinput").fill("and a shared worker?");
        await chat.locator(".composer .cinput").press("Enter");
        await expect(chat.locator(".chat-main")).toContainText("the second answer");
        await expect.poll(() => fake.calls().length).toBe(2);
        expect(fake.calls()[1].messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);

        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});

test("the popup opens the chat page, and opening it again focuses the one that is already there", async () => {
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: "http://127.0.0.1:1/", apiKey: "", apiFormat: "openai", model: "m" });
        const url = `chrome-extension://${ext.extensionId}/chat.html`;
        const popup = await ext.context.newPage();
        await popup.goto(`chrome-extension://${ext.extensionId}/popup.html`);

        await popup.locator("#openChat").click();
        await expect.poll(() => ext.context.pages().filter((p) => p.url() === url).length).toBe(1);

        // A second click focuses the open one: two chat pages would each hold their own port and scroll position.
        // The popup closes itself on success, so the wait is on the context rather than on that page.
        const popup2 = await ext.context.newPage();
        await popup2.goto(`chrome-extension://${ext.extensionId}/popup.html`);
        await popup2.locator("#openChat").click();
        await expect.poll(() => ext.context.pages().filter((p) => p.url().endsWith("popup.html")).length).toBe(0);
        expect(ext.context.pages().filter((p) => p.url() === url).length).toBe(1);
    } finally { await ext.context.close(); }
});

test("starting a chat from the page: the worker hosts it, with no tab behind it", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        fake.setScript([{ content: "a service worker is a background script" }]);
        const { page: chat, errors } = await openChatPage(ext);

        // With nothing open the page is the start box; this browser can start both kinds, so Chat is one click.
        await chat.getByRole("button", { name: /^Kind:/ }).click();
        await chat.getByRole("listbox", { name: "Kind" }).getByRole("option", { name: /^Chat/ }).click();
        await chat.locator(".chat-start-box textarea").fill("what is a service worker?");
        await chat.locator(".chat-start-box textarea").press("Enter");

        // The page opens the session the worker answered with, and the answer arrives through the stream.
        await expect(chat).toHaveURL(/#\/s\/local%3A/);
        await expect(chat.locator(".chat-main")).toContainText("a service worker is a background script");
        // No tab was opened for it: the chat page and the popup-less context are all there is.
        expect(ext.context.pages().filter((p) => p.url().startsWith("http")).length).toBe(0);
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await fake.stop(); }
});

/** A two-card box for the fake backend to report, so the resource panel has something to draw. */
const GiB = 1024 ** 3;
const card = (id, free) => ({ gpu_id: String(id), name: `CUDA${id}`, runner: "CUDA", compute: "12.0", driver: "13.2", total_memory: 101972967424, physical_memory: 102641958912, free_memory: free });
const BOX = { compute: { system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: 12.3 * GiB }, supported_gpus: [card(0, 90 * GiB), card(1, 94 * GiB)] } };

test("panels dock to an edge, share one as tabs, resize from their edge, and zoom until Escape", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    fake.setCapacity(BOX);
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        const { page: chat, errors } = await openChatPage(ext);
        await expect(chat.locator(".chat-rt", { hasText: "This browser" })).toBeVisible();
        const gear = chat.locator(".chat-gear-btn");
        // Both docked panels hang off one "Panels" row, which has to be opened first: they are a different kind of
        // thing from the rows around them (a surface opened ONTO a runtime), and each says which runtime that is.
        const openPanel = async (name) => {
            await gear.click();
            await chat.getByRole("menuitem", { name: "Panels" }).click();
            await chat.getByRole("menuitemcheckbox", { name }).click();
        };
        await openPanel(/Models and memory/);
        await openPanel(/Python bench/);
        const top = chat.locator(".chat-dock.chat-dock-top"), bottom = chat.locator(".chat-dock.chat-dock-bottom");
        await expect(top.getByRole("tab", { name: "Resources" })).toBeVisible();
        // Docked panels read at the DevTools panel's base size, not the page's 15px reading size.
        const panelFs = () => top.locator(".vram").evaluate((el) => getComputedStyle(el).getPropertyValue("--fs").trim());
        expect(await panelFs()).toBe("12px");
        await expect(bottom.getByRole("tab", { name: "Python bench" })).toBeVisible();

        // The docked panels live in the reading column, so the rail keeps its whole height: its gear is never under
        // (or over) a bottom panel, which is what happened while the bench was a full-width row.
        await chat.getByRole("button", { name: "Sessions" }).first().click();
        await expect(chat.locator(".chat-rail")).toBeVisible();
        await expect.poll(async () => (await bottom.boundingBox()).x).toBeGreaterThanOrEqual((await chat.locator(".chat-rail").boundingBox()).width - 1);
        const gearBox = await chat.locator(".chat-rail .chat-gear-btn").boundingBox();
        expect(gearBox.x + gearBox.width).toBeLessThanOrEqual((await bottom.boundingBox()).x + 1);
        await chat.locator(".chat-rail").getByRole("button", { name: "Show the session list" }).click();

        // Moving the bench to the top makes the two tabs of one region, the moved one showing.
        await bottom.getByRole("button", { name: "Python bench options" }).click();
        await chat.getByRole("menuitemradio", { name: "Dock to the top" }).click();
        await expect(bottom).toHaveCount(0);
        await expect(top.getByRole("tab")).toHaveCount(2);
        await expect(top.getByRole("tab", { name: "Python bench" })).toHaveAttribute("aria-selected", "true");
        await expect(top.locator(".bench")).toBeVisible();
        await expect(top.locator(".vram")).toBeHidden();
        await top.getByRole("tab", { name: "Resources" }).click();
        await expect(top.locator(".vram")).toBeVisible();
        // A tab closes from its own ✕, which arrives with the pointer.
        const x = top.getByRole("button", { name: "Close Python bench" });
        await chat.mouse.move(0, 0);
        await expect(x).toHaveCSS("opacity", "0");
        await top.getByRole("tab", { name: "Python bench" }).hover();
        await expect(x).toHaveCSS("opacity", "1");
        await x.click();
        await expect(top.getByRole("tab")).toHaveCount(1);
        await expect(chat.locator(".bench")).toHaveCount(0);

        // The region resizes from its inner edge, and keeps the size across a reload.
        const h0 = (await top.boundingBox()).height;
        const edge = await top.locator(".dock-edge").boundingBox();
        await chat.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
        await chat.mouse.down();
        await chat.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2 + 80, { steps: 4 });
        await chat.mouse.up();
        const h1 = (await top.boundingBox()).height;
        expect(Math.round(h1 - h0)).toBe(80);
        // …down to a strip: the tab bar and a sliver, much smaller than the resource panel's own floor elsewhere.
        const e2 = await top.locator(".dock-edge").boundingBox();
        await chat.mouse.move(e2.x + e2.width / 2, e2.y + e2.height / 2);
        await chat.mouse.down();
        await chat.mouse.move(e2.x + e2.width / 2, 0, { steps: 4 });
        await chat.mouse.up();
        expect(Math.round((await top.boundingBox()).height)).toBe(64);
        // In a dock the graphs give way to the region: a plot keeps no 72px height and no 44px floor there, as it
        // does in the DevTools panel. (Checked on the rule, since a chart needs a box report the fake does not reach.)
        const plotRule = await top.locator(".dock-pane").first().evaluate((pane) => {
            const p = document.createElement("div"); p.className = "rc-plot"; pane.appendChild(p);
            const cs = getComputedStyle(p); const r = { h: cs.height, min: cs.minHeight }; p.remove(); return r;
        });
        expect(plotRule.min).toBe("14px");
        expect(plotRule.h).not.toBe("72px");
        await chat.mouse.move(e2.x + e2.width / 2, 64 - 1);
        await chat.mouse.down();
        await chat.mouse.move(e2.x + e2.width / 2, 64 - 1 + (h1 - 64), { steps: 4 });
        await chat.mouse.up();
        expect(Math.round((await top.boundingBox()).height)).toBe(Math.round(h1));
        await chat.reload();
        await expect(chat.locator(".chat-dock.chat-dock-top .vram")).toBeVisible();
        expect(Math.round((await chat.locator(".chat-dock.chat-dock-top").boundingBox()).height)).toBe(Math.round(h1));

        // Maximize covers the column; Escape comes back.
        await chat.getByRole("button", { name: "Resources options" }).click();
        await chat.getByRole("menuitem", { name: "Maximize" }).click();
        await expect(chat.locator(".chat-dock.max")).toBeVisible();
        // Off the chart first: over it, the panel's own Escape takes the chart's tooltip down before anything else.
        await chat.mouse.move(2, 2);
        await chat.keyboard.press("Escape");
        await expect(chat.locator(".chat-dock.max")).toHaveCount(0);
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await fake.stop(); }
});

// A docked panel MOVES BY ITS TAB, with a real mouse: a translucent block shows where it would land before anything
// moves (the whole group for a tab, the half for a split, a strip for an empty edge), Escape abandons the drag, and the
// drop splits the region. The ⋮ menu does the same moves in two steps, and a split across a split is not offered at
// the depth this build allows.
test("a panel's tab drags to a split or an empty edge, showing where it lands, and the menu makes the same moves", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    fake.setCapacity(BOX);
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        const { page: chat, errors } = await openChatPage(ext);
        await chat.setViewportSize({ width: 1400, height: 900 });
        await expect(chat.locator(".chat-rt", { hasText: "This browser" })).toBeVisible();
        const gear = chat.locator(".chat-gear-btn");
        const openPanel = async (name) => {
            await gear.click();
            await chat.getByRole("menuitem", { name: "Panels" }).click();
            await chat.getByRole("menuitemcheckbox", { name }).click();
        };
        await openPanel(/Models and memory/);
        await openPanel(/Python bench/);
        const top = chat.locator(".chat-dock.chat-dock-top"), bottom = chat.locator(".chat-dock.chat-dock-bottom");
        await expect(bottom.getByRole("tab", { name: "Python bench" })).toBeVisible();
        const ghost = chat.locator(".dock-ghost");
        const rect = async (loc) => { const b = await loc.boundingBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
        const near = (a, b, what) => {
            for (const k of ["x", "y", "w", "h"]) expect(Math.abs(a[k] - b[k]), `${what}: ${k} ${a[k]} vs ${b[k]}`).toBeLessThan(3);
        };
        // The ghost eases between targets (80ms); wait for it to settle before measuring.
        const settled = async () => { await chat.waitForTimeout(150); return rect(ghost); };
        const tab = bottom.getByRole("tab", { name: "Python bench" });
        const t = await rect(tab);
        await chat.mouse.move(t.x + t.w / 2, t.y + t.h / 2);
        await chat.mouse.down();
        // A press that has not moved far is still a click: no block yet.
        await chat.mouse.move(t.x + t.w / 2 + 2, t.y + t.h / 2, { steps: 2 });
        await expect(ghost).toHaveCount(0);

        // Over the right quarter of the top group's body: the block is that group's RIGHT HALF.
        const grp = await rect(top.locator(".dock-group"));
        await chat.mouse.move(grp.x + grp.w * 0.92, grp.y + grp.h * 0.6, { steps: 8 });
        await expect(ghost).toBeVisible();
        near(await settled(), { x: grp.x + grp.w / 2, y: grp.y, w: grp.w / 2, h: grp.h }, "split right");
        await expect(bottom.locator(".dock-tabwrap.dragging"), "the dragged tab is dimmed while it travels").toHaveCount(1);
        // Over the group's middle: the WHOLE group, because it would join as a tab.
        await chat.mouse.move(grp.x + grp.w / 2, grp.y + grp.h * 0.6, { steps: 4 });
        near(await settled(), grp, "as a tab");
        // Over the top group's own tab bar: a tab as well.
        const bar = await rect(top.locator(".dock-bar"));
        await chat.mouse.move(bar.x + bar.w * 0.6, bar.y + bar.h / 2, { steps: 4 });
        near(await settled(), grp, "on the bar");
        // Near the EMPTY left edge of the column: a strip as wide as a left region would be.
        const work = await rect(chat.locator(".chat-work"));
        const main = await rect(chat.locator(".chat-work-mid > .chat-main"));
        await chat.mouse.move(work.x + 10, main.y + main.h / 2, { steps: 6 });
        near(await settled(), { x: work.x, y: work.y, w: Math.min(380, work.w * 0.4), h: work.h }, "a new left region");
        // Escape abandons it: no block, and nothing moved.
        await chat.keyboard.press("Escape");
        await expect(ghost).toHaveCount(0);
        await chat.mouse.up();
        await expect(bottom.getByRole("tab", { name: "Python bench" })).toBeVisible();
        await expect(chat.locator(".dock-split")).toHaveCount(0);

        // Again, and released over the right quarter: the top region is now two groups side by side.
        const t2 = await rect(tab);
        await chat.mouse.move(t2.x + t2.w / 2, t2.y + t2.h / 2);
        await chat.mouse.down();
        await chat.mouse.move(grp.x + grp.w * 0.92, grp.y + grp.h * 0.6, { steps: 10 });
        await expect(ghost).toBeVisible();
        await chat.mouse.up();
        await expect(ghost).toHaveCount(0);
        await expect(bottom).toHaveCount(0);
        await expect(top.locator(".dock-split.dock-row > .dock-cell > .dock-group")).toHaveCount(2);
        const [left, right] = [await rect(top.locator(".dock-group").nth(0)), await rect(top.locator(".dock-group").nth(1))];
        await expect(top.locator(".dock-group").nth(1).getByRole("tab", { name: "Python bench" })).toBeVisible();
        expect(right.x).toBeGreaterThan(left.x + left.w - 2);
        expect(Math.abs(left.w - right.w)).toBeLessThan(3);
        await expect(top.locator(".bench")).toBeVisible();
        await expect(top.locator(".vram")).toBeVisible();

        // The divider shares the room, and the layout survives a reload.
        const div = await rect(top.locator(".dock-divider"));
        await chat.mouse.move(div.x + div.w / 2, div.y + div.h / 2);
        await chat.mouse.down();
        await chat.mouse.move(div.x + div.w / 2 - 120, div.y + div.h / 2, { steps: 5 });
        await chat.mouse.up();
        const shrunk = await rect(top.locator(".dock-group").nth(0));
        expect(Math.round(left.w - shrunk.w)).toBeGreaterThan(110);
        // The page does not keep the bench open across a reload, so this is also the CLOSE-AND-REOPEN case: it comes
        // back beside the same panel, on the same side, at the share it was dragged to.
        await chat.reload();
        await expect(chat.locator(".chat-dock-top .vram")).toBeVisible();
        if (!(await chat.locator(".chat-dock .bench").count())) await openPanel(/Python bench/);
        await expect(chat.locator(".chat-dock-top .dock-split.dock-row > .dock-cell > .dock-group")).toHaveCount(2);
        expect(Math.abs((await rect(chat.locator(".chat-dock-top .dock-group").nth(0))).w - shrunk.w)).toBeLessThan(3);

        // THE MENU, in two steps: "Move next to…", then a row per group with what it allows.
        await chat.getByRole("button", { name: "Python bench options" }).click();
        await chat.getByRole("menuitem", { name: "Move next to…" }).click();
        await chat.getByRole("menuitem", { name: "As a tab beside Resources" }).click();
        await expect(chat.locator(".chat-dock-top .dock-split")).toHaveCount(0);
        await expect(chat.locator(".chat-dock-top").getByRole("tab")).toHaveCount(2);
        // …split out of its own group, below…
        await chat.getByRole("button", { name: "Python bench options" }).click();
        await chat.getByRole("menuitem", { name: "Move next to…" }).click();
        await chat.getByRole("menuitem", { name: "Split to the bottom of Resources · Python bench" }).click();
        await expect(chat.locator(".chat-dock-top .dock-split.dock-col > .dock-cell > .dock-group")).toHaveCount(2);
        // …and a split ACROSS that column is one level too deep: shown, and refused.
        await chat.getByRole("button", { name: "Python bench options" }).click();
        await chat.getByRole("menuitem", { name: "Move next to…" }).click();
        const across = chat.getByRole("menuitem", { name: "Split to the left of Resources" });
        await expect(across).toHaveAttribute("aria-disabled", "true");
        await chat.keyboard.press("Escape");
        // Dragging toward a group's side where that split is refused shows the TAB block instead of a half.
        const res = await rect(chat.locator(".chat-dock-top .dock-group").nth(0));
        const bt = await rect(chat.locator(".chat-dock-top").getByRole("tab", { name: "Python bench" }));
        await chat.mouse.move(bt.x + bt.w / 2, bt.y + bt.h / 2);
        await chat.mouse.down();
        await chat.mouse.move(res.x + res.w * 0.05, res.y + res.h * 0.6, { steps: 8 });
        near(await settled(), res, "a refused split falls back to a tab");
        await chat.keyboard.press("Escape");
        await chat.mouse.up();
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await fake.stop(); }
});

test("the box's panel and the Python bench are on this page, because THIS browser is the runtime", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        const { page: chat, errors } = await openChatPage(ext);
        await expect(chat.locator(".chat-rt", { hasText: "This browser" })).toBeVisible();

        // Offered because the RUNTIME reports it can be drawn and this DEVICE holds something to draw it with.
        // Neither question is "is this local", and a phone reaching the same runtime would answer the second one no.
        // The page's tools live in the gear's menu at the bottom-left, with the settings beside them.
        const gear = chat.locator(".chat-gear-btn");
        // Both panels hang off one "Panels" row: they are a surface opened ONTO a runtime rather than a setting of
        // the page, and each names the runtime it would open on.
        const panels = async () => { await gear.click(); await chat.getByRole("menuitem", { name: "Panels" }).click(); };
        await panels();
        const box = chat.getByRole("menuitemcheckbox", { name: /Models and memory/ });
        await expect(box).toBeVisible();
        await expect(box).toHaveAccessibleName(/This browser/);
        await box.click();
        // Docked across the top by default, with its header row in the dock's tab bar rather than under it.
        await expect(chat.locator(".chat-dock.chat-dock-top .vram")).toBeVisible();
        await expect(chat.locator(".chat-dock.chat-dock-top .dock-bar .vram-head")).toBeVisible();
        await panels();
        await chat.getByRole("menuitemcheckbox", { name: /Models and memory/ }).click();
        await expect(chat.locator(".chat-dock")).toHaveCount(0);

        // Settings are this browser's own, offered because the runtime reports `localSettings` and this page can
        // draw them: the same settings view the DevTools panel has, in the main pane.
        await gear.click();
        await chat.getByRole("menuitem", { name: "Settings" }).click();
        await expect(chat.locator(".chat-settings")).toBeVisible();
        await chat.getByRole("button", { name: "Close settings" }).click();
        await expect(chat.locator(".chat-settings")).toHaveCount(0);
        // A sheet like the search page: Escape takes you back from anywhere on it.
        await gear.click();
        await chat.getByRole("menuitem", { name: "Settings" }).click();
        await expect(chat.locator(".chat-settings h1")).toHaveText("Settings");
        await chat.locator(".chat-settings h1").click();
        await chat.keyboard.press("Escape");
        await expect(chat.locator(".chat-settings")).toHaveCount(0);

        // The bench is not a picture of one: it runs, through this browser's own offscreen sandbox, from a page
        // that is not the panel. A drawer that opened and could not run would be worse than no drawer.
        await panels();
        await chat.getByRole("menuitemcheckbox", { name: /Python bench/ }).click();
        await expect(chat.locator(".chat-dock.chat-dock-bottom .bench")).toBeVisible();
        // One bar: the bench's own controls are in the dock's tab bar.
        await expect(chat.locator(".chat-dock.chat-dock-bottom .dock-bar .bench-play")).toBeVisible();
        await chat.locator('.dock-bar [aria-label="Run"]').click();
        await expect(chat.locator(".bench-outbody")).toContainText("45", { timeout: 120_000 });
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await fake.stop(); }
});

test("the execution log is what the machinery did under the open run, which its steps never say", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        fake.setScript([{ content: "nothing to do" }]);

        // A real run on a real tab, started the way a person would. It needs no tools: the mechanics this log is
        // for happen AROUND a run — the browser is asked not to discard the tab the moment one is hosted there,
        // and let go of it again when the run ends, and neither is visible anywhere else on the page.
        const site1 = await ext.context.newPage();
        await site1.goto(site.url + "/");
        await waitForMl(site1);
        const hash = await site1.evaluate(() => window.ml.agent("do nothing", { env: false }).then((r) => r.hash));

        const { page: chat, errors } = await openChatPage(ext);
        await chat.locator(".chat-row", { hasText: "do nothing" }).click();
        await expect(chat).toHaveURL(new RegExp(`#/s/local%3A${hash}`));

        // Offered beside the other panels, named for what it IS: it follows whichever session is open, so a title
        // naming one run would go stale on the next click.
        await chat.locator(".chat-gear-btn").click();
        await chat.getByRole("menuitem", { name: "Panels" }).click();
        const row = chat.getByRole("menuitemcheckbox", { name: /Execution log/ });
        await expect(row).toHaveAccessibleName(/This browser/);
        await row.click();

        // Docked to the RIGHT by default: it is read line by line beside the steps it explains.
        const panel = chat.locator(".chat-dock.chat-dock-right");
        await expect(panel.locator(".runlog")).toBeVisible();
        await expect(panel.locator(".r-outcell")).toContainText("pinned (hosting)");
        await expect(panel.locator(".r-outcell")).toContainText("released");
        // One tab hosted the whole run, so its id is the same on every line and is left off them: in a region
        // this narrow that width is what turns a one-record line into two. It is still in the records.
        await expect(panel.locator(".r-outcell")).not.toContainText("tab=");

        // Escape closes the menu, but the key can land in the frame between the menu appearing and the effect
        // that listens for it registering — invisible to a hand, reachable by a driver — so press until it takes
        // rather than once and hope, or with a sleep long enough to hide the question.
        const dismiss = () => expect.poll(async () => {
            await chat.keyboard.press("Escape");
            return panel.locator(".runlog-menu .menu").count();
        }, { timeout: 5000 }).toBe(0);

        // THE PANEL IS THE LOG. Its controls are in the DOCK'S bar, not in a row above the records — a toolbar
        // and a paragraph were competing for the one width this region does not have.
        await expect(panel.locator(".dock-bar .runlog-menu")).toBeVisible();
        await expect(panel.locator(".runlog .hk-bar")).toHaveCount(0);
        await panel.locator(".runlog-menu button").first().click();
        await expect(panel.locator(".runlog-menu .menu")).toBeVisible();
        // Exactly one subsystem is in play here, and every record is routine, so there is nothing to filter between:
        // no subsystem group and no level choice. The only checkable row left is the colouring toggle.
        await expect(panel.locator(".menu-head")).toHaveCount(0);
        await expect(panel.getByRole("menuitemcheckbox")).toHaveCount(1);
        // The two exports this panel owes: the records themselves, and the run's WHOLE timeline, which is
        // `run.json` rather than a fifth artifact that is almost it.
        await expect(panel.getByRole("menuitem", { name: /Download the log/ })).toBeEnabled();
        await expect(panel.getByRole("menuitem", { name: /Export all events/ })).toBeEnabled();

        // COLOUR BY GROUP, on by default: the colour is what the group column is for. Nothing else is affected
        // — colouring is asked for per CALLER (`TimedOutput`'s `groups`), and the housekeeping log does not ask.
        await expect(panel.locator(".r-ts-g").first()).toBeVisible();
        await panel.getByRole("menuitemcheckbox", { name: /Colour by group/ }).click();
        await expect(panel.locator(".r-ts-g")).toHaveCount(0, { timeout: 5000 });
        await panel.getByRole("menuitemcheckbox", { name: /Colour by group/ }).click();
        await expect(panel.locator(".r-ts-g").first()).toBeVisible();
        await dismiss();

        // THE TEXT FILTER, in the dock's bar beside the menu: it hides the lines that do not match (Ctrl+F inside
        // the log is the find), and clearing it brings them back.
        const filter = panel.locator(".dock-bar .runlog-find");
        await filter.fill("released");
        await expect(panel.locator(".r-outcell")).toContainText("released");
        await expect(panel.locator(".r-outcell")).not.toContainText("pinned");
        await filter.fill("no such mechanic");
        await expect(panel.locator(".runlog .hint")).toContainText("No record matches the filters");
        await filter.fill("");
        await expect(panel.locator(".r-outcell")).toContainText("pinned (hosting)");

        // THE TIMESTAMP GUTTER IS AS WIDE AS THE STAMP, in `ch` — a fixed pixel width clipped the leading digit
        // the moment the zoom below scaled the text, and was already a shade under `mm:ss` at the default size.
        const stamp = panel.locator(".r-ts", { hasText: /\d/ }).first();
        const fits = () => stamp.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
        expect(await fits(), "the stamp fits its gutter").toBe(true);

        // A ZOOM over the size the log already reads at, by the keys a hand reaches for. Pressed over the LOG,
        // which is focusable because the output cell owns Ctrl+F — and prevented, so the browser does not zoom
        // the whole page instead.
        const size = () => panel.locator("pre.code").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        const before = await size();
        await panel.locator(".r-outscroll").click();
        await chat.keyboard.press("Control+=");
        await expect.poll(size).toBeGreaterThan(before);
        expect(await fits(), "and still fits it once the log is zoomed").toBe(true);
        await chat.keyboard.press("Control+0");
        await expect.poll(size).toBe(before);

        // It is the OPEN run's, not the ring's: going back to the list leaves it with no run to describe rather
        // than showing some other run's mechanics under nothing.
        await chat.evaluate(() => { location.hash = "#/"; });
        await expect(panel.locator(".runlog .hint")).toContainText("Open a session to read what happened underneath it");
        await panel.locator(".runlog-menu button").first().click();
        await expect(panel.locator(".runlog-menu .menu")).toBeVisible();
        await expect(panel.getByRole("menuitem", { name: /Export all events/ })).toBeDisabled();
        await dismiss();

        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await site.stop(); await fake.stop(); }
});

test("the run state panel lists every declared member of the open run, what each holds, and which the model never sees", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        fake.setScript([{ content: "nothing to do" }]);
        const site1 = await ext.context.newPage();
        await site1.goto(site.url + "/");
        await waitForMl(site1);
        const hash = await site1.evaluate(() => window.ml.agent("count the widgets", { env: false }).then((r) => r.hash));

        const { page: chat, errors } = await openChatPage(ext);
        await chat.locator(".chat-row", { hasText: "count the widgets" }).click();
        await expect(chat).toHaveURL(new RegExp(`#/s/local%3A${hash}`));
        await chat.locator(".chat-gear-btn").click();
        await chat.getByRole("menuitem", { name: "Panels" }).click();
        const row = chat.getByRole("menuitemcheckbox", { name: /Run state/ });
        await expect(row).toHaveAccessibleName(/This browser/);
        await row.click();

        const panel = chat.locator(".chat-dock.chat-dock-right .rstate");
        await expect(panel).toBeVisible();
        await expect(chat.locator(".dock-bar .rstate-asof")).toContainText("as of");
        // What the run was started with, read from the worker's registry and expanded on a click.
        const init = panel.locator('[data-member="run.init"]');
        await expect(init).not.toHaveClass(/empty/);
        await init.locator(".jt-clickable").first().click();
        await expect(init).toContainText("count the widgets");
        // The context, between turns: the history the run kept for a follow-up, one row per message.
        const messages = panel.locator('[data-member="run.messages"]');
        await expect(messages).not.toHaveClass(/empty/);
        await expect(messages.locator(".jt-preview")).toContainText(/\[ [2-9] items \]/);
        // A member holding nothing for this run is still LISTED, so "none" is told apart from "no such thing".
        await expect(panel.locator('[data-member="run.approvals"]')).toHaveClass(/empty/);
        await expect(panel.locator('[data-member="run.approvals"]')).toContainText("none");
        // ONE LINE per member until it is opened, like a debug console's variables: the name, the value folded to a
        // preview, and the chips, on one row.
        const firstRow = (id) => panel.locator(`[data-member="${id}"] .jt-row`).first();
        expect((await panel.locator('[data-member="run.messages"] .jt-row').count())).toBe(1);
        // Every member is the height of one row, empty ones included (a global `.empty` once padded those to three),
        // and its chip sits on that row.
        // (`run.init` was opened above to read its task; an opened member is as tall as its value, so it is not counted.)
        const heights = await panel.locator(".rstate-member").evaluateAll((els) => els.filter((el) => !el.querySelector(".tri.open"))
            .map((el) => [el.dataset.member, el.getBoundingClientRect().height, el.querySelector(".jt-row").getBoundingClientRect().height]));
        expect(heights.length, "most members are folded").toBeGreaterThan(10);
        for (const [id, h, row] of heights) expect(h, `${id} is one line`).toBeLessThan(row * 1.6);
        const line = await firstRow("run.mailbox").boundingBox();
        const chipBox = await panel.locator('[data-member="run.mailbox"] .rstate-aud').boundingBox();
        expect(Math.abs(chipBox.y + chipBox.height / 2 - (line.y + line.height / 2)), "the chip is on the member's own line").toBeLessThan(line.height / 2);
        // Named by the expression that reaches them: what the model reads, by its `ml.current` path; the rest under
        // `inspector.`, the person's own marked "you only".
        await expect(firstRow("run.mailbox").locator(".rstate-key")).toHaveText("inspector.run.mailbox:");
        await expect(firstRow("run.messages").locator(".rstate-key")).toHaveText("ml.current.messages:");
        await expect(firstRow("run.log").locator(".rstate-key")).toHaveText("ml.current.log:");
        await expect(panel.locator('[data-member="run.log"] .rstate-aud')).toHaveCount(0);
        // A message row has ml.current's own field names, so a copied path names what the model reads.
        await messages.locator(".jt-clickable").first().click();
        await messages.locator(".jt-clickable").nth(1).click();
        await expect(messages.locator(".jt-row", { hasText: "content:" }).first()).toBeVisible();
        await messages.locator(".jt-clickable").first().click();
        await expect(panel.locator('[data-member="run.mailbox"] .rstate-aud')).toHaveText("you only");
        await expect(panel.locator('[data-member="grants.fetch"] .rstate-aud')).toHaveText("you only");
        // The name's tooltip: the sentence, then one fact per row, the path among them.
        // Two moves: the tip follows the pointer, so it opens on a movement over the name, not on arriving there.
        const keyBox = await firstRow("run.mailbox").locator(".rstate-key").boundingBox();
        await chat.mouse.move(keyBox.x + 4, keyBox.y + keyBox.height / 2);
        await chat.mouse.move(keyBox.x + 6, keyBox.y + keyBox.height / 2);
        const tip = chat.locator(".cursor-tip .rstate-tip");
        await expect(tip.locator(".rc-tip-line", { hasText: "read by" })).toContainText("only you");
        await expect(tip.locator(".rc-tip-line", { hasText: "lost when" })).toContainText("the turn ends");
        await expect(tip.locator(".rc-tip-line", { hasText: "path" }).locator("code")).toHaveText("inspector.run.mailbox");
        expect(await tip.locator("code").evaluate((el) => getComputedStyle(el).fontFamily), "the path reads as code").toMatch(/mono|Menlo|Courier/i);
        // At the docked panels' tip size, as the resource panel's tips are, not the page's reading size.
        const [tipPx, panelPx] = await chat.evaluate(() => [parseFloat(getComputedStyle(document.querySelector(".cursor-tip")).fontSize),
            parseFloat(getComputedStyle(document.querySelector(".chat")).getPropertyValue("--panel-fs")) || 12]);
        expect(tipPx).toBeCloseTo(panelPx * 0.83, 0);
        await chat.mouse.move(0, 0);
        await expect(panel.locator('[data-member="run.pointers"] .rstate-aud')).toHaveCount(0);
        // The title is the session's, read from the one place that owns it (the worker's index): no utility model
        // is set here, so it holds no title yet, but the member is filled, not empty, and the model may read it.
        const title = panel.locator('[data-member="session.title"]');
        await expect(title).not.toHaveClass(/empty/);
        await expect(title.locator(".rstate-aud")).toHaveCount(0);
        // The page's members come from the run's tab. Finished, the run's answer has been handed over, but the page is
        // still there to say so; closed, the panel says why the page's members are missing instead of dropping them.
        await expect(panel.locator('[data-member="run.answer"]')).toHaveClass(/empty/);
        await site1.close();
        await expect(panel.locator(".hint")).toContainText("the run's tab is closed", { timeout: 10_000 });
        await expect(panel.locator('[data-member="run.answer"]')).toHaveCount(0);

        // It is the OPEN run's: with nothing open there is nothing to describe.
        await chat.evaluate(() => { location.hash = "#/"; });
        await expect(panel.locator(".hint")).toContainText("Open a session to see what its run holds");
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await site.stop(); await fake.stop(); }
});

test("the run state panel shows the LIVE turn: what it was asked, the gate it waits on, what it may do without asking", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off", autoApproveReadonly: false });
        fake.setScript([{ tool: "exec", args: { js: "document.title = 'held'; 'ok'" } }, { content: "done" }]);
        const site1 = await ext.context.newPage();
        await site1.goto(site.url + "/");
        await waitForMl(site1);
        // Held at its exec gate, so the turn is live while the panel reads it.
        void site1.evaluate(() => window.ml.agent("rename the page", { env: false, approvalRouting: "both" })).catch(() => {});
        await expect.poll(async () => (await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 15000 }).toBe(1);

        const { page: chat, errors } = await openChatPage(ext);
        await chat.locator(".chat-row", { hasText: "rename the page" }).click();
        await chat.locator(".chat-gear-btn").click();
        await chat.getByRole("menuitem", { name: "Panels" }).click();
        await chat.getByRole("menuitemcheckbox", { name: /Run state/ }).click();
        const panel = chat.locator(".chat-dock.chat-dock-right .rstate");
        const open = async (id) => { const m = panel.locator(`[data-member="${id}"]`); await m.locator(".jt-clickable").first().click(); return m; };

        await expect(await open("run.input")).toContainText("rename the page");
        const gates = await open("run.approvals");
        await gates.locator(".jt-clickable").nth(1).click();   // the one gate, folded inside the list
        await expect(gates).toContainText('"exec"');
        // The start origin is consented from the first step: navigating and fetching there never asks.
        const turn = await open("grants.turn");
        await turn.getByRole("button", { name: /origins:/ }).click();
        await expect(turn).toContainText(new URL(site.url).origin);
        await expect(turn.locator(".rstate-aud")).toHaveText("you only");
        // THE PAGE'S OWN STATE, asked of the tab the run is on: its answer set is held there while the turn runs (empty
        // so far, but held), and what the page says is marked as the page's word. Its @pt/@box registries are the
        // page's, shared by every run in the tab, and listed even with nothing minted.
        const answer = panel.locator('[data-member="run.answer"]');
        await expect(answer).not.toHaveClass(/empty/);
        await expect(answer.locator(".rstate-page")).toHaveText("from the page");
        await expect(panel.locator('[data-member="page.points"]')).toHaveClass(/empty/);
        await expect(panel.locator('[data-member="page.boxes"]')).toHaveClass(/empty/);

        // IT FOLLOWS THE RUN: a message sent while the turn waits is queued for its next step, and the panel's next
        // read shows it in the mailbox without anything being reopened.
        const mailbox = panel.locator('[data-member="run.mailbox"]');
        await expect(mailbox.locator(".jt-preview")).toHaveText("[ ]");
        // A WATCH over the same thing, typed as JSONPath: nothing to match yet, and it fills in on its own below.
        const watchInput = panel.locator(".rstate-watch-input");
        await watchInput.fill("$.inspector.run.mailbox[*].text");
        await watchInput.press("Enter");
        const watch = panel.locator('[data-watch="$.inspector.run.mailbox[*].text"]');
        await expect(watch).toContainText("no match");
        // A JS watch: any read-only expression, with ml.current the model's own live snapshot.
        for (const expr of ["ml.current.messages.length > 0", "inspector.grants.turn.origins.length"]) {
            await watchInput.fill(expr);
            await watchInput.press("Enter");
        }
        await expect(panel.locator('[data-watch="ml.current.messages.length > 0"]')).toContainText("true");
        await expect(panel.locator('[data-watch="inspector.grants.turn.origins.length"]')).toContainText("1");
        // COMPLETION, from the shape the worker sent with this read: the live context's keys, taken with Tab.
        await watchInput.pressSequentially("ml.current.mes");
        await expect(panel.locator(".rstate-complete-row")).toHaveText([/^messages\[\d+\]$/]);
        await watchInput.press("Tab");
        await expect(watchInput).toHaveValue("ml.current.messages");
        await watchInput.press("Escape");
        // THE CONSOLE: the same language as a program, run once by the worker over this read's snapshot. It prints, it
        // answers, and it cannot write.
        const consoleInput = panel.locator(".rstate-console-input");
        await consoleInput.fill("let n = 0; for (const m of ml.current.messages) { console.log(m.role); n++ } n === ml.current.messages.length");
        await consoleInput.press("Enter");
        const ran = panel.locator(".rstate-console-entry").last();
        await expect(ran.locator(".rstate-console-log").first()).toHaveText(/system|user/);
        await expect(ran).toContainText("true");
        await consoleInput.fill("inspector.grants.turn.origins.push('https://evil.test')");
        await consoleInput.press("Enter");
        await expect(panel.locator(".rstate-console-entry").last().locator(".rstate-watch-err")).toContainText(/push/);
        await chat.getByPlaceholder(/Steer this run/).fill("also check the totals");
        await chat.getByPlaceholder(/Steer this run/).press("Enter");
        await expect(mailbox.locator(".jt-preview")).toHaveText("[ 1 item ]", { timeout: 10_000 });
        await mailbox.locator(".jt-clickable").first().click();
        await mailbox.locator(".jt-clickable").nth(1).click();
        await expect(mailbox).toContainText("also check the totals");
        await expect(watch).toContainText('"also check the totals"');

        // Approved out of band: the turn finishes, and what lived only in it goes with it.
        const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
        await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), gate.key);
        await expect(panel.locator('[data-member="run.input"]')).toHaveClass(/empty/, { timeout: 10_000 });
        await expect(panel.locator('[data-member="grants.turn"]')).toHaveClass(/empty/);
        await expect(panel.locator('[data-member="run.approvals"]')).toHaveClass(/empty/);
        await expect(answer).toHaveClass(/empty/, { timeout: 10_000 });
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await site.stop(); await fake.stop(); }
});

test("a watch shared from the Run state panel reaches the model: its survey of ml.current.debug.userWatches reads the value", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off", autoApproveReadonly: true });
        // What the panel writes when its eye is clicked (tests/run-state-view.test.mjs): the watches, and the shared subset.
        // The inspector watch is in the shared list as a forged storage write would put it, and is still refused.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_runstate_watches: ["ml.current.run.step", "inspector.grants.turn"],
            ml_runstate_shared: ["ml.current.run.step", "inspector.grants.turn"],
            ml_runstate_watch_notes: { "ml.current.run.step": "is it moving?" } }));
        fake.setScript([{ tool: "exec", args: { js: "JSON.stringify(ml.current.debug.userWatches.map(w => [w.expression, w.value ?? w.error, w.note ?? null]))" } },
            { content: "done" }]);
        const site1 = await ext.context.newPage();
        await site1.goto(site.url + "/");
        await waitForMl(site1);
        void site1.evaluate(() => window.ml.agent("what am I watching?", { env: false, approvalRouting: "both" })).catch(() => {});
        // Answered without a gate (a read-only survey of the run's own context, in the worker), so the second call comes.
        await expect.poll(() => fake.calls().length, { timeout: 15000 }).toBe(2);
        const sent = fake.calls()[1].messages.find((m) => m.role === "tool").content;
        expect(sent).toContain('["ml.current.run.step",1,"is it moving?"]');
        expect(sent).toContain("model does not have");
        expect(sent).not.toMatch(/origins/);
    } finally { await ext.context.close(); await site.stop(); await fake.stop(); }
});

test("the run state panel joins the run's pointers to the stored values behind them, and says which the context still mentions", async () => {
    // A table past the parse cap: the pointer holds a preview, and the whole body goes to the value store.
    const big = ["order_id,region,revenue"];
    for (let i = 0; i < 300_000; i++) big.push(`${i},${["north", "south"][i % 2]},${i % 97}`);
    const srv = createServer((q, r) => {
        if (q.url === "/big.csv") { r.writeHead(200, { "content-type": "text/csv" }); r.end(big.join("\n")); return; }
        r.writeHead(200, { "content-type": "text/html" }); r.end("<title>orders</title><p>orders");
    });
    await new Promise((res) => srv.listen(0, "127.0.0.1", res));
    const origin = `http://127.0.0.1:${srv.address().port}`;
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        fake.setScript([{ tool: "fetch_url", args: { url: `${origin}/big.csv`, token: "the orders" } }, { content: "fetched" }]);
        const site1 = await ext.context.newPage();
        await site1.goto(origin + "/");
        await waitForMl(site1);
        // Same origin as the page, so the fetch is free and nothing waits on a gate.
        await site1.evaluate(() => window.ml.agent("fetch the orders", { env: false, toolTokens: true }));

        const { page: chat, errors } = await openChatPage(ext);
        await chat.locator(".chat-row", { hasText: "fetch the orders" }).click();
        await chat.locator(".chat-gear-btn").click();
        await chat.getByRole("menuitem", { name: "Panels" }).click();
        await chat.getByRole("menuitemcheckbox", { name: /Run state/ }).click();
        const panel = chat.locator(".chat-dock.chat-dock-right .rstate");

        const pointers = panel.locator('[data-member="run.pointers"]');
        await expect(pointers).not.toHaveClass(/empty/);
        await pointers.locator(".jt-clickable").first().click();
        await pointers.locator(".jt-clickable").nth(1).click();
        await expect(pointers).toContainText('"fetch_url"');
        await expect(pointers).toContainText('"the orders"');
        // The tool result the model was handed names it, so the context still MENTIONS it.
        await expect(pointers.locator(".jt-row", { hasText: "linked:" })).toContainText("true");
        const stored = (await pointers.locator(".jt-row", { hasText: "stored:" }).textContent()).match(/"([^"]+)"/)?.[1];
        expect(stored, "the pointer names the stored body it previews").toBeTruthy();

        // The stored body, joined by its key: the same key, with where it came from.
        const values = panel.locator('[data-member="run.values"]');
        await expect(values).not.toHaveClass(/empty/);
        await values.locator(".jt-clickable").first().click();
        await values.locator(".jt-clickable").nth(1).click();
        await expect(values).toContainText(stored);
        await expect(values).toContainText("/big.csv");
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await fake.stop(); await new Promise((r) => srv.close(r)); }
});

test("a PAGE-hosted run's state comes from the page it runs in: its context and its answer, marked as the page's word", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        // A site on the page-approval list runs its agent IN THE PAGE: the worker holds no start payload, no history and
        // no pointer store for it. Its sessions reach the index from the page's own bus (`listPageSessions`).
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off",
            autoApproveReadonly: false, listPageSessions: true, pageApprovalDomains: [new URL(site.url).hostname] });
        fake.setScript([{ tool: "exec", args: { js: "document.title = 'held'; 'ok'" } }, { content: "done" }]);
        const site1 = await ext.context.newPage();
        await site1.goto(site.url + "/");
        await waitForMl(site1);
        // Held at the page's OWN approval callback, so the turn is live while the panel reads it.
        await site1.evaluate(() => {
            window.__held = new Promise((go) => { window.__go = go; });
            window.__run = window.ml.agent("count in the page", { env: false, approve: () => window.__held }).catch(() => {});
        });
        await expect.poll(() => fake.calls().length, { timeout: 15000 }).toBe(1);

        const { page: chat, errors } = await openChatPage(ext);
        await chat.locator(".chat-row", { hasText: "count in the page" }).click();
        await chat.locator(".chat-gear-btn").click();
        await chat.getByRole("menuitem", { name: "Panels" }).click();
        await chat.getByRole("menuitemcheckbox", { name: /Run state/ }).click();
        const panel = chat.locator(".chat-dock.chat-dock-right .rstate");

        // The context is the PAGE loop's, live: the task is in it, and the row says whose word it is.
        const messages = panel.locator('[data-member="run.messages"]');
        await expect(messages).not.toHaveClass(/empty/, { timeout: 10_000 });
        await expect(messages.locator(".rstate-page")).toHaveText("from the page");
        await messages.locator(".jt-clickable").first().click();
        await messages.locator(".jt-clickable").nth(2).click();   // the system prompt, then the task: open the task
        await expect(messages).toContainText("count in the page");
        await expect(panel.locator('[data-member="run.answer"] .rstate-page')).toHaveText("from the page");
        // The worker never held this run's start payload, and the page may not answer for it either: it stays empty.
        await expect(panel.locator('[data-member="run.init"]')).toHaveClass(/empty/);

        await site1.evaluate(() => window.__go(true));
        await site1.evaluate(() => window.__run);
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await site.stop(); await fake.stop(); }
});

test("the run state panel folds a group to a count, and copies a member's value, or any row's value or path", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        fake.setScript([{ content: "nothing to do" }]);
        const site1 = await ext.context.newPage();
        await site1.goto(site.url + "/");
        await waitForMl(site1);
        await site1.evaluate(() => window.ml.agent("count the widgets", { env: false }));

        const { page: chat, errors } = await openChatPage(ext);
        await chat.locator(".chat-row", { hasText: "count the widgets" }).click();
        await chat.locator(".chat-gear-btn").click();
        await chat.getByRole("menuitem", { name: "Panels" }).click();
        await chat.getByRole("menuitemcheckbox", { name: /Run state/ }).click();
        const panel = chat.locator(".chat-dock.chat-dock-right .rstate");
        // What was copied, recorded at the clipboard call: an extension page cannot be granted clipboard READ here.
        const recordCopies = () => chat.evaluate(() => { window.__clip = null; navigator.clipboard.writeText = async (t) => { window.__clip = t; }; });
        const clip = () => chat.evaluate(() => window.__clip);
        await recordCopies();

        // FOLDED, a group says how many members it has and how many hold something, so it still answers "is anything
        // here". The turn is over, so its grants hold nothing.
        const grants = panel.locator('[data-group="grants"]');
        await grants.locator(".rstate-group-head").click();
        await expect(grants.locator(".rstate-group-head")).toHaveAttribute("aria-expanded", "false");
        await expect(grants.locator(".rstate-count")).toHaveText("4 members · 0 holding something");
        await expect(grants.locator(".rstate-member")).toHaveCount(0);
        // Remembered on this device: a reload leaves it folded.
        await chat.reload();
        await expect(panel.locator('[data-group="grants"] .rstate-count')).toBeVisible({ timeout: 10_000 });
        await panel.locator('[data-group="grants"] .rstate-group-head').click();
        await expect(panel.locator('[data-group="grants"] .rstate-member')).toHaveCount(4);
        await recordCopies();

        // COPY: the whole value from the button on the member's line (shown on hover)...
        const init = panel.locator('[data-member="run.init"]');
        await init.hover();
        await init.getByRole("button", { name: "Copy the value", exact: true }).click();
        await expect.poll(clip).toContain('"task": "count the widgets"');
        // ...and any row's value or PATH from a right-click. The path is the expression that reaches it, rooted where
        // the member lives, so it pastes into a watch or the console as is.
        await init.locator(".jt-clickable").first().click();
        const task = init.locator(".jt-row", { hasText: "task:" });
        await task.click({ button: "right" });
        // The row the menu is about is marked while the menu is open, and only then.
        await expect(task).toHaveClass(/ctx-target/);
        await chat.getByRole("button", { name: "Copy path" }).click();
        await expect(task).not.toHaveClass(/ctx-target/);
        await expect.poll(clip).toBe("inspector.run.init.task");
        await task.click({ button: "right" });
        await chat.getByRole("button", { name: "Copy value" }).click();
        await expect.poll(clip).toBe("count the widgets");
        // ...and "Watch this", which pins the row's path in the watch group at the top.
        await task.click({ button: "right" });
        await chat.getByRole("button", { name: "Watch this" }).click();
        await expect(panel.locator('[data-watch="inspector.run.init.task"]')).toContainText('"count the widgets"');
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await site.stop(); await fake.stop(); }
});

test("a session this browser holds nothing live for says so: a plain chat, and a finished run after the worker restarted", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off", listPageSessions: true });
        fake.setScript([{ content: "hello back" }, { content: "nothing to do" }]);
        const site1 = await ext.context.newPage();
        await site1.goto(site.url + "/");
        await waitForMl(site1);

        // A CHAT is not a run: nothing in the worker or the page holds state for it, and the panel says that in a
        // sentence instead of a column of "none".
        await site1.evaluate(() => window.ml.createChat().chat("say hello"));
        const { page: chat, errors } = await openChatPage(ext);
        await chat.locator(".chat-row", { hasText: "say hello" }).click();
        await chat.locator(".chat-gear-btn").click();
        await chat.getByRole("menuitem", { name: "Panels" }).click();
        await chat.getByRole("menuitemcheckbox", { name: /Run state/ }).click();
        const panel = chat.locator(".chat-dock.chat-dock-right .rstate");
        await expect(panel.locator(".rstate-idle")).toContainText("holds nothing live for this session", { timeout: 10_000 });

        // A finished RUN is live until the worker is stopped (the browser does that after ~30 s idle): then nothing it
        // held in memory is left, and the panel, still open on the session, says so on its next read.
        await site1.evaluate(() => window.ml.agent("count the widgets", { env: false }));
        await chat.locator(".chat-row", { hasText: "count the widgets" }).click();
        await expect(panel.locator('[data-member="run.init"]')).not.toHaveClass(/empty/, { timeout: 10_000 });
        await expect(panel.locator(".rstate-idle")).toHaveCount(0);
        const cdp = await ext.context.newCDPSession(chat);
        await cdp.send("ServiceWorker.enable");
        await cdp.send("ServiceWorker.stopAllWorkers");
        await expect(panel.locator(".rstate-idle")).toBeVisible({ timeout: 15_000 });
        await expect(panel.locator('[data-member="run.init"]')).toHaveClass(/empty/);
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await site.stop(); await fake.stop(); }
});

test("the start page holds through a worker restart, and its tab list is fresh and has the sites' icons", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    // Pages with an icon: a tab's icon is what the runtime fetches and hands the picker as a data URL.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const srv = createServer((q, r) => {
        if (q.url === "/fav.png") { r.writeHead(200, { "content-type": "image/png" }); r.end(png); return; }
        r.writeHead(200, { "content-type": "text/html" }); r.end(`<title>Page ${q.url}</title><link rel="icon" href="/fav.png"><p>hi`);
    });
    await new Promise((res) => srv.listen(0, "127.0.0.1", res));
    const site = { url: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((res) => srv.close(res)) };
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
        const first = await ext.context.newPage();
        await first.goto(site.url + "/");
        const { page: chat, errors } = await openChatPage(ext);
        const box = chat.locator(".chat-start-box textarea");
        await box.fill("half a thought");

        // The browser stops an idle worker about every 30 seconds and the page reconnects. The form, and what was
        // typed, stay on screen throughout: it used to be traded for an empty page and drawn again.
        await chat.evaluate(() => {
            window.__gone = 0;
            new MutationObserver(() => { if (!document.querySelector(".chat-start-box")) window.__gone++; }).observe(document.body, { subtree: true, childList: true });
        });
        const cdp = await ext.context.newCDPSession(chat);
        await cdp.send("ServiceWorker.enable");
        await cdp.send("ServiceWorker.stopAllWorkers");
        await expect.poll(() => chat.evaluate(() => document.querySelector(".chat-start-wait") == null), { timeout: 10_000 }).toBe(true);
        expect(await chat.evaluate(() => window.__gone)).toBe(0);
        await expect(box).toHaveValue("half a thought");

        // A tab opened after the page is in the list the next time it opens, with the icon the runtime fetched.
        const later = await ext.context.newPage();
        await later.goto(site.url + "/?later");
        await chat.bringToFront();
        await chat.getByRole("button", { name: /^Where it runs/ }).click();
        const list = chat.getByRole("listbox", { name: "Where it runs" });
        await expect(list.locator(".tp-row", { hasText: "127.0.0.1" })).toHaveCount(2);
        await expect(list.getByRole("searchbox", { name: "Filter tabs" })).toBeVisible();
        await chat.keyboard.press("Escape");
        await chat.getByRole("button", { name: /^Where it runs/ }).click();
        await expect.poll(() => list.locator("img.tp-fav").count(), { timeout: 10_000 }).toBeGreaterThan(0);
        await chat.keyboard.press("Escape");

        // Settings has the housekeeping log, the one the DevTools panel shows.
        await chat.locator(".chat-gear-btn").click();
        await chat.getByRole("menuitem", { name: "Settings" }).click();
        await chat.getByRole("tab", { name: "Housekeeping" }).click();
        await expect(chat.locator(".chat-set-hk .hk-view")).toBeVisible();
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});

test("a worker restart does not redraw Settings: Runtimes keeps its scroll and never says offline", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
        const { page: chat, errors } = await openChatPage(ext);
        await chat.setViewportSize({ width: 1200, height: 520 });
        await chat.locator(".chat-gear-btn").first().click();
        await chat.getByRole("menuitem", { name: "Settings" }).click();
        await chat.getByRole("tab", { name: "Runtimes" }).click();
        await expect(chat.locator("section[aria-label=Storage]")).toBeVisible();
        const scroller = chat.locator(".chat-settings .chat-sheet-scroll");
        await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        const at = await scroller.evaluate((el) => el.scrollTop);
        expect(at).toBeGreaterThan(0);
        await chat.evaluate(() => {
            window.__saidOffline = false;
            new MutationObserver(() => { if (/Offline/.test(document.querySelector(".rt-sheet")?.textContent ?? "")) window.__saidOffline = true; })
                .observe(document.body, { subtree: true, childList: true, characterData: true });
        });
        const cdp = await ext.context.newCDPSession(chat);
        await cdp.send("ServiceWorker.enable");
        await cdp.send("ServiceWorker.stopAllWorkers");
        // Back well inside the grace; the page reconnected without showing anything.
        await chat.waitForTimeout(1500);
        expect(await chat.evaluate(() => window.__saidOffline)).toBe(false);
        expect(await scroller.evaluate((el) => el.scrollTop)).toBe(at);
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await fake.stop(); }
});

test("the page follows the extension's Theme from the start, and offers to keep following it or choose its own", async () => {
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { theme: "dark" });
        const { page: chat, errors } = await openChatPage(ext);
        await chat.emulateMedia({ colorScheme: "light" });
        const theme = () => chat.evaluate(() => document.documentElement.getAttribute("data-theme"));
        // Without opening Settings: the extension's config is loaded at the page's start (it used to wait for Settings).
        await expect.poll(theme).toBe("dark");
        await chat.locator(".chat-gear-btn").first().click();
        await chat.getByRole("menuitem", { name: /Theme for this page/ }).click();
        const menu = chat.getByRole("menu", { name: "Page menu" });
        await expect(menu.getByRole("menuitemradio")).toHaveText(["Like the extension (Dark)", "System", "Light", "Dark"]);
        await menu.getByRole("menuitemradio", { name: "Light" }).click();
        expect(await theme()).toBe("light");
        // Its own choice holds when the extension's changes; following the extension tracks it.
        await configureExtension(ext.sw, { theme: "dark" });
        expect(await theme()).toBe("light");
        await menu.getByRole("menuitemradio", { name: /Like the extension/ }).click();
        expect(await theme()).toBe("dark");
        await ext.sw.evaluate(() => chrome.storage.sync.set({ theme: "light" }));
        await expect.poll(theme).toBe("light");
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); }
});

test("the attention list proposes the archive: Keep them turns it on from the click, then offers a folder", async () => {
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { sessionArchive: false });
        const { page: chat, errors } = await openChatPage(ext);
        // Suggestions only: there may be no count, but the list is there to open.
        await chat.locator(".chat-list-foot .chat-att-btn").click();
        const sheet = chat.getByRole("main", { name: "Needs attention" });
        const off = sheet.locator(".chat-att-item", { hasText: "Old sessions are deleted, not kept" });
        await expect(off).toBeVisible();
        await off.getByRole("button", { name: "Keep them" }).click();
        // The setting is written, the worker follows it, and the runtime's codes move on to the next step.
        await expect.poll(() => ext.sw.evaluate(() => chrome.storage.sync.get("sessionArchive").then((c) => c.sessionArchive))).toBe(true);
        await expect(off).toHaveCount(0);
        const folder = sheet.locator(".chat-att-item", { hasText: "Keep a copy of the archive on disk" });
        await expect(folder).toBeVisible();
        await expect(folder.getByRole("button", { name: "Pick a folder" })).toBeVisible();

        // In Settings the folder sits under the switch it depends on, and only while that is on.
        await chat.locator(".chat-gear-btn").first().click();
        await chat.getByRole("menuitem", { name: "Settings" }).click();
        await chat.getByRole("tab", { name: "Extension" }).click();
        await chat.getByRole("tab", { name: "Appearance" }).click();
        const group = chat.getByRole("group", { name: "Archive folder" });
        await expect(group).toBeVisible();
        await chat.getByRole("checkbox", { name: "Archive sessions instead of deleting them" }).uncheck();
        await expect(group).toHaveCount(0);
        await expect(chat.getByText("(above)")).toHaveCount(0);
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); }
});

// A CONTENT SCRIPT LIVES AS LONG AS THE EXTENSION THAT INJECTED IT. Reload or update the extension and every tab
// already open keeps its page and loses its listener, so the next message to it rejects with Chrome's "Could not
// establish connection. Receiving end does not exist." That rejection escaped `agent.start` and reached the person
// as Chrome's own string, which names no cause and no remedy — and it skipped the sentence written for exactly this
// in `session-commands.ts`, because a THROW never reaches the branch that reads the outcome.
//
// The condition is built here by loading a bundle whose content scripts match nothing, rather than by reloading the
// extension: `chrome.runtime.reload()` leaves a Playwright persistent context without a usable extension at all.
// What matters is reproduced exactly either way — a tab the extension MAY script, with no listener in it — and the
// test asserts both halves of that before driving anything, because a tab that could not be scripted would make
// this pass for the wrong reason.

/** A copy of `dist/` whose content scripts match nothing, so a tab gets none. */
function distWithoutContentScripts() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wml-nocs-"));
    // The same bundle the harness would have loaded, including an `E2E_DIST` someone built elsewhere on purpose.
    fs.cpSync(path.resolve(process.env.E2E_DIST || "dist"), dir, { recursive: true });
    const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    for (const cs of m.content_scripts) cs.matches = ["https://nothing.invalid/*"];
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m, null, 2));
    return dir;
}

test("a run starts on a tab whose content script is gone, by putting it back", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const dist = distWithoutContentScripts();
    const ext = await launchExtension({ dist });
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
        fake.setScript([{ content: "the page is a demo" }]);

        const target = await ext.context.newPage();
        await target.goto(site.url + "/");
        expect(await target.evaluate(() => !!window.ml), "no content script ran in the target tab").toBe(false);

        const { page: chat, errors } = await openChatPage(ext);
        // THE PRECONDITION, both halves. Scriptable and unanswering is the state an extension reload leaves behind;
        // either half alone would make the rest of this test prove something else.
        const before = await chat.evaluate(async () => {
            const t = (await chrome.tabs.query({})).find((x) => x.url?.startsWith("http"));
            const out = { id: t.id };
            const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => 1 });
            out.scriptable = r.result === 1;
            try { await chrome.tabs.sendMessage(t.id, { type: "ML_PING" }); out.answered = true; }
            catch (e) { out.answered = false; out.why = String((e && e.message) || e); }
            return out;
        });
        expect(before.scriptable, "the extension may script the tab").toBe(true);
        expect(before.answered, "but nothing in it is listening").toBe(false);
        expect(before.why).toMatch(/Receiving end does not exist|Could not establish connection/);

        await chat.locator(".chat-start-box textarea").fill("what do you make of this page?");
        await chat.getByRole("button", { name: /^Where it runs/ }).click();
        await chat.getByRole("listbox", { name: "Where it runs" }).getByRole("option")
            .filter({ hasText: /127\.0\.0\.1|localhost/ }).first().click();
        await chat.getByRole("button", { name: "Start the run" }).click();

        // It runs. Before the fix this was Chrome's string in a red notice and no session at all.
        // It RUNS. Wait on the run reaching the model first: that is the thing this test is about, and it separates
        // "the start was refused" from "the transcript is still catching up", which on a loaded machine running
        // several browsers at once is a real difference of seconds.
        await expect.poll(() => fake.calls().length, { timeout: 30000 }).toBe(1);
        await expect(chat.locator(".chat-main")).toContainText("the page is a demo", { timeout: 30000 });
        await expect(chat.getByText(/Receiving end does not exist/)).toHaveCount(0);
        // And the tab really got its content script back, rather than the run going somewhere else.
        expect(await target.evaluate(() => !!window.ml)).toBe(true);
        expect(errors).toEqual([]);
    } finally {
        await ext.context.close();
        fake.close?.(); site.close?.();
        fs.rmSync(dist, { recursive: true, force: true });
    }
});

// THE EXTENSION'S SETTINGS ON THE CHAT PAGE. The page has its own pill tabs above the view, so the view's five groups
// take the page's style (settings.tsx `layout`): a secondary pill row on a wide screen, and on a phone no inner tabs at
// all, every group under its heading, which is the layout a search already uses. The search must still land on the
// section a match is in, which on a phone is the only way to reach a setting without scrolling for it.
test("the extension's settings on the chat page: pills on a wide screen, one page on a phone, and search finds a setting in either", async () => {
    const ext = await launchExtension();
    try {
        for (const [width, phone] of [[1300, false], [390, true]]) {
            const page = await ext.context.newPage();
            await page.setViewportSize({ width, height: 820 });
            await page.goto(`chrome-extension://${ext.extensionId}/chat.html#/settings/extension`);
            await page.locator(".settings .set-search").waitFor();
            expect(await page.locator(".settings .set-tabs").count(), "never the DevTools underline tabs on the chat page").toBe(0);
            if (phone) {
                expect(await page.locator(".set-pills").count(), "no inner tabs on a phone").toBe(0);
                expect(await page.locator(".set-search-tab").allTextContents()).toEqual(["Connection", "Models", "Appearance", "Advanced", "Permissions"]);
            } else {
                expect(await page.locator(".set-pills [role=tab]").allTextContents()).toEqual(["Connection", "Models", "Appearance", "Advanced", "Permissions"]);
                await page.locator(".set-pills [role=tab]", { hasText: "Permissions" }).click();
                await expect(page.getByText("Self-approval whitelist", { exact: true })).toBeVisible();   // exact: the Site access note also names it
            }
            // "has done nothing" is in a help text on the Appearance group, not in any label.
            await page.locator(".settings .set-search").fill("has done nothing");
            const headings = page.locator(".set-search-tab:not(.set-miss)");
            await expect(headings).toHaveText(["Appearance"]);
            await expect(page.locator(".set-field:not(.set-miss)", { hasText: "Keep unpinned sessions for" })).toBeVisible();
            await page.close();
        }
    } finally { await ext.close(); }
});
