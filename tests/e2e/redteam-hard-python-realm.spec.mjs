// redteam-hard-python-realm.spec.mjs — independent real-browser-worker measurements of two realms: what the readonly
// lockdown leaves (the post-strip global surface of a READONLY cell), and what a bypass of it would reach (a FULL-mode
// worker at the extension's origin, section "what a BYPASS would reach"). For the first, a worker-hosted run names the
// JS bridge and its sidebar card is approved by clicking Allow as the person; an external approval intentionally would
// not lift that refusal. The URL constructor is every row's same-cell live-global control (Math.max in the FULL-mode
// rows). The location row runs unmarked against the owner correction; the three other names remain passing negative rows.

import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { createServer } from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const STDLIB = join(HERE, "../../dist/pyodide/python_stdlib.zip");
const HAS_FORK = existsSync(join(HERE, "../../dist/pyodide/pyodide.mjs")) && existsSync(STDLIB) && readFileSync(STDLIB).includes("restricted.py");
const NEED_FORK = "needs the restricted-mode fork core in dist/pyodide (npm run fetch-pyodide, then build)";

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


// --- what a BYPASS would reach: the realm a FULL-mode worker gives (RED_TEAM_WORKER_BOUNDARY.md, section 3) --------
// The rows above measure what the strip leaves a READONLY cell. These measure the other side of the one wall: a FULL
// (never locked down) worker, which is the realm a bypass of the strip would give. Each row is one cell recording what
// the API DID at the extension origin, so the document's table is measured, not reasoned. The cell's own Math.max is
// every row's live-global control, and each row's expectation pins the measurement so the table cannot drift silently.

/** The third-party origin the cells reach: CORS-open, a JS file for importScripts, and a JSON status route. */
let third = null;
let thirdUrl = "";
let thirdJsHits = 0;

/** The offscreen document, created if no earlier row needed it (the sandbox's worker lives there). */
async function ensureOffscreen() {
    await ext.sw.evaluate(async () => {
        if (await chrome.offscreen.hasDocument?.()) return;
        await chrome.offscreen.createDocument({
            url: "offscreen.html",
            reasons: ["WORKERS", "DOM_PARSER"],
            justification: "red-team full-worker reach probe (tests/e2e/redteam-hard-python-realm.spec.mjs)",
        });
    });
}

/** The probe server and the offscreen document, once. */
async function thirdParty() {
    if (third) return thirdUrl;
    third = createServer((req, res) => {
        if (req.url === "/probe.js") {
            thirdJsHits++;
            res.writeHead(200, { "content-type": "application/javascript", "access-control-allow-origin": "*" });
            res.end("globalThis.__rtProbeLoaded = true;\n");
            return;
        }
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        res.end('{"ok":true}');
    });
    await new Promise((r) => third.listen(0, "127.0.0.1", r));
    thirdUrl = `http://127.0.0.1:${third.address().port}`;
    return thirdUrl;
}

test.afterAll(async () => {
    if (third) await new Promise((r) => third.close(r));
    third = null;
});

/**
 * One FULL-mode cell: a raw PY_RUN from the service worker (the bench's own path, `hardened: false`), its RT_PROBE
 * line decoded. `body` is Python statements ending by setting `_result`; top-level await works (runPythonAsync).
 */
async function runFullCell(body) {
    const code = `import json, js
_g = js.globalThis
out = {"href": str(_g.location.href)}
try:
    out["control"] = str(_g.Math.max(1, 2))
${body.split("\n").map((l) => `    ${l}`).join("\n")}
    out["value"] = str(_result)
except BaseException as e:
    out["error"] = type(e).__name__ + ": " + str(e)[:400]
print("RT_PROBE " + json.dumps(out))`;
    await ensureOffscreen();
    // The document's listener registers after createDocument resolves; a send before it answers "Receiving end does not exist".
    let r;
    for (let i = 0; ; i++) {
        try {
            r = await ext.sw.evaluate(async (code) => await chrome.runtime.sendMessage({ type: "PY_RUN", code, hardened: false, principal: "rt-e2e-full", noTimeout: true, tables: null }), code);
            break;
        } catch (e) {
            if (i >= 150 || !/Receiving end does not exist/.test(String(e))) throw e;
            await new Promise((res) => setTimeout(res, 100));
        }
    }
    if (!r) throw new Error("the offscreen document did not answer PY_RUN (is it created?)");
    if (r.ok === false) throw new Error(`the full cell failed: ${r.error}\n${r.stdout}`);
    const line = String(r.stdout || "").split("\n").reverse().find((l) => l.startsWith("RT_PROBE "));
    if (!line) throw new Error(`no RT_PROBE line; stdout=${JSON.stringify(r.stdout)} error=${r.error}`);
    return JSON.parse(line.slice("RT_PROBE ".length));
}

test("a FULL-mode cell does NOT get chrome.runtime: a dedicated worker has no chrome namespace", async () => {
    test.skip(!HAS_FORK, NEED_FORK);
    // MEASURED on this Chromium (Chrome for Testing, unpacked): `chrome` is not a global in an extension's dedicated
    // worker. The row pins the absence, so a future change that exposes it (or a move to an extension page as host)
    // cannot quietly hand a bypassed cell the runtime's messaging.
    const r = await runFullCell("_c = _g.chrome\n_result = _g.String(_c)");
    expect(r.control, "the cell must run in the real worker realm").toBe("2");
    expect(r.href, "the full worker is a dedicated worker at the extension's origin").toMatch(/^chrome-extension:\/\/[a-z]+\/python-worker\.js/);
    expect(r.error, "a dedicated worker must have no chrome namespace to read").toMatch(/AttributeError: chrome|chrome is not defined/);
    expect(r.value, "nothing was read").toBeUndefined();
});

test("a FULL-mode cell does NOT get chrome.storage either (the namespace, not a narrowed one, is absent)", async () => {
    test.skip(!HAS_FORK, NEED_FORK);
    // Same absence, probed through the API a bypass would want: if `chrome.storage` ever appears here, the config and
    // the sync store come with it. The importScripts control below is the second witness that `chrome` is undefined
    // rather than merely unreadable through the bridge.
    const r = await runFullCell('_s = _g.chrome.storage\n_result = _g.String(_s)');
    expect(r.control, "the cell must run in the real worker realm").toBe("2");
    expect(r.error, "chrome.storage must be absent in the full worker").toMatch(/AttributeError: chrome|chrome is not defined/);
    expect(r.value).toBeUndefined();
});

test("a FULL-mode cell DOES read the extension origin's IndexedDB, the extension's own stores included", async () => {
    test.skip(!HAS_FORK, NEED_FORK);
    // Reachable, and that is the finding section 3's table records: no chrome.* does not mean no extension data.
    // `indexedDB` is per ORIGIN, and the worker is at the extension's, so the document's stores are the worker's.
    const r = await runFullCell('_dbs = await _g.indexedDB.databases()\n_result = _g.JSON.stringify(_dbs)');
    expect(r.control, "the cell must run in the real worker realm").toBe("2");
    expect(r.error, "indexedDB at the extension origin must answer").toBeUndefined();
    const names = JSON.parse(r.value).map((d) => d.name);
    // The harness profile listed ml-drafts, ml-hub-keyring, ml-saved-sessions and ml-values; the row pins that at
    // least one of the extension's OWN stores is visible, not merely that the API answered.
    expect(names.some((n) => String(n).startsWith("ml-")), `the extension's own databases were listed: ${JSON.stringify(names)}`).toBe(true);
});

test("a FULL-mode cell opens the extension origin's OPFS (where the session archive's files live)", async () => {
    test.skip(!HAS_FORK, NEED_FORK);
    const r = await runFullCell("_root = await _g.navigator.storage.getDirectory()\n_result = _root.kind");
    expect(r.control, "the cell must run in the real worker realm").toBe("2");
    expect(r.error, "navigator.storage.getDirectory at the extension origin must answer").toBeUndefined();
    expect(r.value).toBe("directory");
});

test("a FULL-mode cell fetches a third-party host", async () => {
    test.skip(!HAS_FORK, NEED_FORK);
    const base = await thirdParty();
    const r = await runFullCell(`_resp = await _g.fetch(${JSON.stringify(base + "/status")})\n_result = str(_resp.status)`);
    expect(r.control, "the cell must run in the real worker realm").toBe("2");
    expect(r.error, "fetch from the full worker must reach the third-party host").toBeUndefined();
    expect(r.value).toBe("200");
});

test("a FULL-mode cell's importScripts of a third-party URL is refused BEFORE the network", async () => {
    test.skip(!HAS_FORK, NEED_FORK);
    // The exception is a bare "failed to load" (the CSP violation goes to the console, which a worker's cell cannot
    // read), so the row does not assert on its wording: it asserts the two things the refusal must produce — the
    // script's side effect never happens, and the server never sees the request. A block that happens after the
    // fetch would still have leaked the extension origin (and a cacheable URL) to the third party.
    const base = await thirdParty();
    const before = thirdJsHits;
    const r = await runFullCell(`_g.importScripts(${JSON.stringify(base + "/probe.js")})\n_result = str(_g.__rtProbeLoaded)`);
    expect(r.control, "the cell must run in the real worker realm").toBe("2");
    expect(r.error, "a remote importScripts must fail, not run").toMatch(/failed to load/);
    expect(r.value, "the refused script's body must not have executed").toBeUndefined();
    expect(thirdJsHits - before, "the third-party server saw a request despite the refusal").toBe(0);
});

test("control: importScripts of the extension's own origin DOES load and execute (only the host is refused)", async () => {
    test.skip(!HAS_FORK, NEED_FORK);
    // The control for the row above: dist/devtools.js is real extension JS whose body reads `chrome` — which the
    // worker does not have. A ReferenceError from inside it proves the script was fetched, parsed and RUN, so the
    // remote refusal is about the URL, not about importScripts being unavailable; and it is the second witness for
    // the chrome rows: no namespace, from a script that asks for it.
    const r = await runFullCell('_g.importScripts(_g.location.origin + "/devtools.js")\n_result = "loaded"');
    expect(r.control, "the cell must run in the real worker realm").toBe("2");
    expect(r.error, "the same-origin script must run its body").toMatch(/ReferenceError: chrome is not defined/);
    expect(r.error, "the script must not have been refused as a URL").not.toMatch(/failed to load/);
});

test("a FULL-mode cell cannot evaluate a string at the extension origin: eval and Function are CSP-refused", async () => {
    test.skip(!HAS_FORK, NEED_FORK);
    // What bounds a bypass that CAN fetch: remote code arrives as a string, and the extension's script-src lists no
    // 'unsafe-eval', so both routes to compiling a string are refused. The control is the same realm running the
    // cell's own code (Math.max), which is compiled by Pyodide's bridge, not by eval.
    const r = await runFullCell('_result = _g.String(_g.eval("1+1"))');
    expect(r.control, "the cell must run in the real worker realm").toBe("2");
    expect(r.error, "eval of a string must be refused by script-src").toMatch(/Content Security Policy|unsafe-eval|EvalError/);
    const f = await runFullCell('_result = _g.String(_g.Function("return 1")())');
    expect(f.control, "the cell must run in the real worker realm").toBe("2");
    expect(f.error, "Function must be refused like eval").toMatch(/Content Security Policy|unsafe-eval|EvalError/);
});

test("a FULL-mode cell posts on a BroadcastChannel", async () => {
    test.skip(!HAS_FORK, NEED_FORK);
    const r = await runFullCell('_bc = _g.BroadcastChannel.new("rt-e2e")\n_bc.postMessage("x")\n_bc.close()\n_result = "ok"');
    expect(r.control, "the cell must run in the real worker realm").toBe("2");
    expect(r.error, "a BroadcastChannel must be available in the full worker").toBeUndefined();
    expect(r.value).toBe("ok");
});
