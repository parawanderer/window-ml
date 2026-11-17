// upload-progress.spec.mjs — the bar under a file's chip while it goes to the runtime in `file.put` chunks
// (docs/spec/FILE_ATTACHMENTS.md, "Tests for the panel and the progress bar"): the standalone chat page, paired to this
// browser through a real hub, starts a chat with a PDF larger than one chunk. On a local hub the upload ends in a blink,
// so the test does not wait to SEE the bar: every figure the bar is given is recorded as it lands in `data-progress`, and
// the test asserts that series rose through the chunks to the whole, that the file reached the runtime, and that the bar
// is gone.
//
// Needs the pinned `wmlhub` binary (tests/fixtures/hub-harness.mjs); skipped with the reason when there is none.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { serveStatic } from "./static-server.mjs";
import { HAVE_HUB, NO_HUB, startHub } from "../fixtures/hub-harness.mjs";

test.skip(!HAVE_HUB, NO_HUB);

const MARKER = "upload progress marker";

/**
 * A one-page PDF whose page says {@link MARKER}, made `pad` bytes larger by a stream nothing references, of bytes no
 * compressor shrinks: large enough to go in several chunks, and still a PDF pdf.js reads with a correct xref.
 */
function bigPdf(pad) {
    const enc = new TextEncoder();
    const content = `BT /F1 18 Tf 72 720 Td (${MARKER}) Tj ET`;
    const noise = new Uint8Array(pad);
    let x = 9;
    for (let i = 0; i < pad; i++) { x = (x * 1103515245 + 12345) >>> 0; noise[i] = x >>> 24; }
    const parts = [];
    const offsets = [];
    let at = 0;
    const push = (b) => { parts.push(b); at += b.length; };
    push(enc.encode("%PDF-1.4\n"));
    const obj = (n, body) => { offsets[n] = at; push(enc.encode(`${n} 0 obj\n`)); for (const b of body) push(typeof b === "string" ? enc.encode(b) : b); push(enc.encode("\nendobj\n")); };
    obj(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
    obj(2, ["<< /Type /Pages /Kids [3 0 R] /Count 1 >>"]);
    obj(3, ["<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"]);
    obj(4, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
    obj(5, ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]);
    obj(6, [`<< /Length ${pad} >>\nstream\n`, noise, "\nendstream"]);
    const xref = at;
    const rows = offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
    push(enc.encode(`xref\n0 7\n0000000000 65535 f \n${rows}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
    return Buffer.concat(parts.map((b) => Buffer.from(b)));
}

/** The client makes an account on the hub, and this browser joins it as a runtime (remote-stream.spec.mjs). Returns
 *  the client page, on its start page. */
async function pairClient(ext, hub, web) {
    const client = await ext.context.newPage();
    await client.goto(`${web.url}client.html`);
    await client.getByRole("button", { name: "Create an account" }).click();
    await client.getByLabel("Hub", { exact: true }).fill(hub.url);
    await client.getByRole("button", { name: "Create it" }).click();
    await expect(client.locator(".chat")).toBeVisible({ timeout: 20_000 });
    const page = await ext.context.newPage();
    await page.goto(`chrome-extension://${ext.extensionId}/chat.html#/settings/devices`);
    await page.getByRole("button", { name: "Join an account" }).click();
    await page.getByLabel("Call this device").fill("Test laptop");
    await page.getByLabel("Hub", { exact: true }).fill(hub.url);
    await page.getByRole("button", { name: "Get a code" }).click();
    const code = (await page.locator(".pair-code").textContent()).trim();
    await client.goto(`${web.url}client.html#/settings/devices`);
    await client.getByRole("button", { name: "Pair a device" }).click();
    await client.getByLabel("Its code").fill(code);
    await client.getByRole("button", { name: "Find it" }).click();
    await client.getByRole("button", { name: "They match: pair it" }).click();
    await expect(page.locator(".pair-conn")).toContainText("Connected", { timeout: 20_000 });
    await page.close();
    await client.goto(`${web.url}client.html`);
    return client;
}

// --- a PDF larger than one chunk, started from a paired client: the bar rises to the whole and goes ---

test("starting a chat with a PDF larger than one chunk records a bar that rises through each chunk to the whole, then goes", async () => {
    test.setTimeout(120_000);
    const fake = await startFakeLlm({ model: "fake-model" });
    const hub = await startHub();
    const web = await serveStatic("dist-web");
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        fake.setScript([{ content: "Read it." }]);
        const client = await pairClient(ext, hub, web);
        // Every figure the bar is given, as it lands: the page records them, so a blink-fast upload is still measured.
        await client.evaluate(() => {
            window.__progress = [];
            new MutationObserver((records) => {
                for (const r of records) {
                    const nodes = r.type === "attributes" ? [r.target] : [...r.addedNodes].flatMap((n) => (n.nodeType === 1 ? [n, ...n.querySelectorAll("[data-progress]")] : []));
                    for (const n of nodes) if (n.getAttribute?.("data-progress") != null) window.__progress.push(Number(n.getAttribute("data-progress")));
                }
            }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-progress"] });
        });
        await client.getByRole("button", { name: /^Kind:/ }).click();
        await client.getByRole("listbox", { name: "Kind" }).getByRole("option", { name: /^Chat/ }).click();
        await client.locator('.chat-start-box input[type="file"]').setInputFiles({ name: "big.pdf", mimeType: "application/pdf", buffer: bigPdf(3_000_000) });
        await expect(client.locator(".chat-start-box .file-pill")).toContainText("big.pdf");
        await client.locator(".chat-start-box textarea").fill("What does it say?");
        await client.locator(".chat-start-box textarea").press("Enter");

        await expect(client.locator(".chat-main")).toContainText("Read it.", { timeout: 60_000 });
        const series = await client.evaluate(() => window.__progress);
        expect(series.length, `figures recorded: ${series.join(", ")}`).toBeGreaterThanOrEqual(3);
        expect(series[0]).toBe(0);
        expect(series.at(-1)).toBe(1);
        for (let i = 1; i < series.length; i++) expect(series[i], `rises at ${i}: ${series.join(", ")}`).toBeGreaterThanOrEqual(series[i - 1]);
        // The file reached the runtime: the model was sent its page.
        expect(JSON.stringify(fake.calls().at(-1))).toContain(MARKER);
        // And the bar is gone.
        await expect(client.locator(".upbar")).toHaveCount(0);
    } finally {
        await ext.context.close();
        await web.close();
        hub.stop();
        await fake.stop();
    }
});
