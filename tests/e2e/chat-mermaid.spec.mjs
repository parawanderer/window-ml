// chat-mermaid.spec.mjs — a ```mermaid fence in model text becomes its diagram on the chat page (web build, fake host):
// drawn in a sandboxed frame and shown as an <img>, with the agreed states while it streams, a note when it cannot be
// drawn, a source toggle and copy, and nothing in the diagram able to run or to be forged by another window.
import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./static-server.mjs";

const ROOT = path.resolve(process.env.E2E_DIST_WEB || "dist-web");
const DESKTOP = { width: 1280, height: 800 };
const CHAT = "laptop:7b21d4e8";
const FLOW = "```mermaid\ngraph TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]\n  B -->|no| A\n```";

let server, browser;
test.beforeAll(async () => {
    test.skip(!fs.existsSync(path.join(ROOT, "mermaid-frame.js")), `no web build with the diagram frame at ${ROOT} (npm run build)`);
    server = await serveStatic(ROOT);
    browser = await chromium.launch({ channel: "chromium" });
});
test.afterAll(async () => { await browser?.close(); server?.close(); });

/** The demo's chat session, open, at desktop size; `stream` (ms per tick) makes the fake host stream its reply. */
async function openChat({ stream = 0 } = {}) {
    const context = await browser.newContext({ viewport: DESKTOP });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.url });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${server.url}${stream ? `?stream=${stream}` : ""}#/s/${CHAT}`);
    await page.locator(".chat").waitFor();
    await page.locator(`.chat-row[data-session="${CHAT}"]`).last().click();
    return { page, errors, close: () => context.close() };
}
/** Send `text` from the composer. */
async function send(page, text) {
    await page.locator(".composer .cinput").fill(text);
    await page.locator(".composer .cinput").press("Enter");
}
const lastReply = (page) => page.locator(".chat-transcript .md").last();

// --- a finished reply: the diagram, with no states ---

test("a ```mermaid fence in a reply is drawn as an image of its diagram, with its source kept and no placeholder", async () => {
    const { page, errors, close } = await openChat();
    await send(page, FLOW);
    const block = lastReply(page).locator(".mmd");
    await expect(block).toHaveAttribute("data-mmd", "done");
    const img = block.locator("img.mmd-img");
    await expect(img).toHaveAttribute("alt", "Diagram");
    await expect(img).toHaveJSProperty("complete", true);
    expect(await img.evaluate((i) => i.naturalWidth > 50 && i.naturalHeight > 50)).toBe(true);
    // Its source is still in the page, for the toggle and copy, but not shown.
    await expect(block.locator("pre.mmd-src")).toBeHidden();
    await expect(block.locator("pre.mmd-src")).toContainText("A[Start] --> B{Ok?}");
    expect(errors).toEqual([]);
    await close();
});

test("a fence Mermaid cannot parse stays its code, with a one-line note saying it could not be drawn", async () => {
    const { page, errors, close } = await openChat();
    await send(page, "```mermaid\ngraph TD\n  A -->\n```");
    const block = lastReply(page).locator(".mmd");
    await expect(block).toHaveAttribute("data-mmd", "error");
    await expect(block.locator(".mmd-note")).toContainText("Couldn't draw this diagram:");
    await expect(block.locator("pre.mmd-src")).toBeVisible();
    await expect(block.locator("img")).toHaveCount(0);
    expect(errors).toEqual([]);
    await close();
});

test("source shows the diagram's text and diagram brings the picture back; copy puts the source on the clipboard", async () => {
    const { page, close } = await openChat();
    await send(page, FLOW);
    const block = lastReply(page).locator(".mmd[data-mmd='done']");
    await block.hover();
    await page.getByRole("button", { name: "Show the diagram's source" }).click();
    const again = lastReply(page).locator(".mmd");
    await expect(again.locator("pre.mmd-src")).toBeVisible();
    await expect(again.locator("img.mmd-img")).toBeHidden();
    await page.getByRole("button", { name: "Show the diagram", exact: true }).click();
    await expect(lastReply(page).locator("img.mmd-img")).toBeVisible();
    await page.getByRole("button", { name: "Copy the diagram's source" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(FLOW.replace(/^```mermaid\n|\n```$/g, ""));
    await close();
});

// --- streaming: code while the fence is open, then the diagram ---

test("while its fence is still open a diagram is plain code, never sent to be drawn; once it closes it is drawn", async () => {
    const { page, errors, close } = await openChat({ stream: 40 });
    // Long enough, at the demo's pace, that the open fence is on screen for several ticks.
    const src = "```mermaid\nsequenceDiagram\n  participant A as Alice\n  participant B as Bob\n  A->>B: Hello Bob\n  B-->>A: Hi Alice\n  A->>B: How are you?\n  B-->>A: Fine\n```\n\nThat is the exchange.";
    await send(page, src);
    // While it streams: the half-written diagram is code and no `.mmd` block exists yet.
    await expect(lastReply(page).locator("pre.code")).toContainText("participant A");
    expect(await lastReply(page).locator(".mmd").count()).toBe(0);
    // Closed: drawn.
    await expect(lastReply(page).locator(".mmd[data-mmd='done'] img.mmd-img")).toBeVisible({ timeout: 15_000 });
    expect(errors).toEqual([]);
    await close();
});

// --- red team: nothing in a diagram runs, and no other window can supply one ---

test("a diagram written to run script draws as inert text: no handler, no javascript: link, nothing executed", async () => {
    const { page, errors, close } = await openChat();
    await page.evaluate(() => { window.__pwned = 0; });
    await send(page, "```mermaid\ngraph TD\n  A[\"<img src=x onerror=top.__pwned=1>\"] --> B[\"<script>top.__pwned=2</script>\"]\n  click A \"javascript:top.__pwned=3\"\n  click B call alert(1)\n```");
    const img = lastReply(page).locator(".mmd[data-mmd='done'] img.mmd-img");
    await expect(img).toBeVisible();
    const svg = await img.evaluate((i) => decodeURIComponent(i.src.replace(/^data:image\/svg\+xml;charset=utf-8,/, "")));
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/\son\w+\s*=/i);
    expect(svg).not.toMatch(/javascript:/i);
    expect(svg).not.toMatch(/<foreignObject/i);
    expect(await page.evaluate(() => window.__pwned)).toBe(0);
    expect(errors).toEqual([]);
    await close();
});

test("the drawing frame is sandboxed to scripts alone and cannot reach the page that framed it", async () => {
    const { page, close } = await openChat();
    await send(page, FLOW);
    await expect(lastReply(page).locator(".mmd[data-mmd='done']")).toBeVisible();
    const frameEl = page.locator("iframe.mmd-frame");
    await expect(frameEl).toHaveAttribute("sandbox", "allow-scripts");
    const frame = page.frames().find((f) => f.url().endsWith("/mermaid.html"));
    expect(frame, "the frame is loaded").toBeTruthy();
    const reach = await frame.evaluate(() => {
        const tries = {};
        try { tries.doc = !!parent.document.body; } catch { tries.doc = false; }
        try { tries.storage = !!localStorage; } catch { tries.storage = false; }
        tries.origin = origin;
        return tries;
    });
    expect(reach).toEqual({ doc: false, storage: false, origin: "null" });
    await close();
});

test("a 'finished drawing' posted by any window other than the frame is ignored", async () => {
    const { page, close } = await openChat();
    // Forge an answer for every id the client could be waiting on, from the page's own window, before and while it draws.
    await page.evaluate(() => {
        const forge = () => { for (let id = 1; id < 20; id++) window.postMessage({ mmd: "done", id, svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><text>FORGED</text></svg>", w: 10, h: 10 }, "*"); };
        forge();
        window.__forger = setInterval(forge, 5);
    });
    await send(page, FLOW);
    const img = lastReply(page).locator(".mmd[data-mmd='done'] img.mmd-img");
    await expect(img).toBeVisible();
    await page.evaluate(() => clearInterval(window.__forger));
    const svg = await img.evaluate((i) => decodeURIComponent(i.src));
    expect(svg).not.toContain("FORGED");
    expect(svg).toContain("Start");
    await close();
});

// --- the PDF: the drawing, in the light theme it prints in ---

test("the PDF carries each diagram as its light drawing, with nothing to click, though the page only ever drew it dark", async () => {
    const context = await browser.newContext({ viewport: DESKTOP, colorScheme: "dark" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // The document the export hands its print frame (print-frame.ts), and no print dialog.
    await page.addInitScript(() => {
        window.__printed = [];
        const make = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (b) => { if (b instanceof Blob && b.type === "text/html") b.text().then((t) => window.__printed.push(t)); return make(b); };
        window.print = () => {};
        const frameWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow").get;
        Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", { get() { const w = frameWindow.call(this); if (w && this.className === "printframe") w.print = () => {}; return w; } });
    });
    const DIAGRAM = "laptop:d1a6a4a5";   // demo-world.ts: "How a step is chosen"
    await page.goto(`${server.url}#/s/${DIAGRAM}`);
    await page.locator(`.chat-row[data-session="${DIAGRAM}"]`).last().click();
    await expect(page.locator(".chat-transcript .mmd[data-mmd='done'] img.mmd-img")).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).not.toBe("light");

    await page.locator(".chat-more-float").click();
    await page.locator(".chat-head-menu").getByRole("menuitem", { name: /Export chat/ }).click();
    const dialog = page.locator(".chat-dialog");
    await dialog.locator(".chat-export-opt", { hasText: "PDF" }).click();
    await dialog.getByRole("button", { name: "Export" }).click();
    await expect.poll(() => page.evaluate(() => window.__printed.length), { timeout: 15_000 }).toBe(1);
    const doc = await page.evaluate(() => window.__printed[0]);
    const img = doc.match(/<img class="mmd-img" alt="Diagram"[^>]*src="data:image\/svg\+xml;charset=utf-8,([^"]*)"/);
    expect(img, "the diagram is an image in the printed document, not its code").toBeTruthy();
    expect(doc).not.toMatch(/mmd-tools|<button|data-mmd="pending"/);
    // Drawn for the PDF in Mermaid's light theme: its default node fill, which the dark theme does not use.
    const svg = decodeURIComponent(img[1]);
    expect(svg.replace(/<[^>]+>/g, "")).toContain("Read the page");   // one <tspan> per word
    expect(svg).toMatch(/#ECECFF/i);
    expect(errors).toEqual([]);
    await context.close();
});
