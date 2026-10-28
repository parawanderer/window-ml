// redteam-hard-python-realm.spec.mjs — independent real-browser-worker measurements of the readonly lockdown's post-strip global surface.
// A worker-hosted run names the JS bridge and its sidebar card is approved by clicking Allow as the person; an external
// approval intentionally would not lift that refusal. The URL constructor is every row's same-cell live-global control.
// The location row is expected to fail on core 2e41d920; SHOW_PENDING=1 removes the marker to expose the exact assertion.

import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STDLIB = join(HERE, "../../dist/pyodide/python_stdlib.zip");
const HAS_FORK = existsSync(join(HERE, "../../dist/pyodide/pyodide.mjs")) && existsSync(STDLIB) && readFileSync(STDLIB).includes("restricted.py");
const NEED_FORK = "needs the restricted-mode fork core in dist/pyodide (npm run fetch-pyodide, then build)";

/** Mark the measured open row; SHOW_PENDING=1 runs it unmarked so a setup failure cannot masquerade as the finding. */
const pending = (why) => test.fail(!process.env.SHOW_PENDING, why);

let fake = null;
let ext = null;
let page = null;
let tabId = null;

test.describe.configure({ mode: "default" });

test.beforeAll(async () => {
    if (!HAS_FORK) return;
    fake = await startFakeLlm({ model: "fake-model" });
    ext = await launchExtension();
    await configureExtension(ext.sw, {
        chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
        debugMode: "overlay", autoApprovePython: true,
    });
});

test.beforeEach(async () => {
    if (!HAS_FORK) return;
    // A fresh document starts on the sessions list; reusing one page can leave the next row looking at the prior run.
    page = await ext.context.newPage();
    await page.goto(fake.url + "/api/version");
    await waitForMl(page);
    tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, page.url());
});

test.afterEach(async () => {
    await page?.close();
    page = null;
});

test.afterAll(async () => {
    await ext?.close();
    await fake?.stop();
});

/** Return one named global's presence, with location's measured href and the allow-listed URL control. */
function probeCode(name) {
    const href = name === "location" ? `, "href": str(_value.href) if _present else None` : "";
    return `import js
_g = js.globalThis
try:
    _value = getattr(_g, ${JSON.stringify(name)})
    _present = _value is not None
except Exception:
    _value = None
    _present = False
{"present": _present, "URL": _g.URL is not None${href}}`;
}

/** Run one cell with its bridge approval granted through the sidebar card and decode its returned object. */
async function runCell(code, task) {
    const beforeCalls = fake.calls().length;
    fake.setScript([
        { tool: "python_exec", args: { code } },
        { content: "Done." },
    ]);
    await ext.sw.evaluate(({ id, task: name }) => globalThis.__mlStartUserRunForTest(id, { task: name, hud: "quiet", surface: "overlay" }, { approvalRouting: "both" }), { id: tabId, task });
    await expect.poll(async () => (await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).some((g) => g.tool === "python_exec"), { timeout: 90000 }).toBe(true);
    const frame = await openRunInSidebar(page, { task });
    await frame.locator(".appr-btn.yes:not(.remember)").click({ timeout: 20000 });
    await expect.poll(() => fake.calls().length, { timeout: 90000 }).toBe(beforeCalls + 2);
    const content = fake.calls().flatMap((c) => c.messages || []).filter((m) => m.role === "tool").at(-1)?.content;
    expect(typeof content, `the cell must return a tool result: ${JSON.stringify(fake.calls().at(-1)?.messages?.slice(-2))}`).toBe("string");
    expect(content, "the person-approved cell must actually reach the JS bridge").not.toContain("js is refused");
    return JSON.parse(content.split("\n")[0]);
}

// --- under CI a fetched fork core must be the one shipped --------------------------------------------

test("under CI, a job that fetched the fork core ships it in dist/pyodide", () => {
    test.skip(!process.env.CI || !existsSync(join(HERE, "../../pyodide-core/.pin")), "only under CI, in a job that ran npm run fetch-pyodide with an artefact pinned");
    expect(HAS_FORK, "the browser-worker rows below would be skipped").toBe(true);
});

// --- step 3: the real WorkerGlobalScope prototype obeys the same allow list --------------------------

test("a lifted cell cannot read location on the real worker global after the strip", async () => {
    test.skip(!HAS_FORK, NEED_FORK);
    pending("measured on core 2e41d920: the real browser worker returned location.present=true and href=chrome-extension://<id>/python-worker.js");
    const r = await runCell(probeCode("location"), "realm location probe");
    expect(r.URL, "positive control: the allow-listed URL constructor must remain readable").toBe(true);
    expect(r.present, `the worker location must be unreadable after lockdown, got ${r.href}`).toBe(false);
});

for (const name of ["postMessage", "close", "fetch"]) {
    test(`a lifted cell cannot read ${name} on the real worker global after the strip`, async () => {
        test.skip(!HAS_FORK, NEED_FORK);
        const r = await runCell(probeCode(name), `realm ${name} probe`);
        expect(r.URL, "positive control: the allow-listed URL constructor must remain readable").toBe(true);
        expect(r.present, `${name} must remain stripped from the real worker global`).toBe(false);
    });
}
