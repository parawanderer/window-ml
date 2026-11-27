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
    let out;
    try {
        out = JSON.parse(content.split("\n")[0]);
    } catch {
        throw new Error(`the cell did not return its JSON object: ${content.slice(0, 600)}`);
    }
    // The tool result says when a construct put the cell outside the read-only dialect; a row measuring what the
    // dialect leaves must know it ran inside, and which construct did it when it did not.
    return { ...out, inside: !content.includes("asked because"), outsideWhy: (content.match(/outside the read-only Python dialect \(([^)]*)\)/) || [])[1] || "" };
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

// --- the ROUTE BACK from the strip: what a READONLY cell can recover (RED_TEAM_WORKER_BOUNDARY.md, section 3) ------
// Section 3's table is an UPPER BOUND: it was measured from a FULL worker, so it says what a bypass gains, not what
// the strip leaves. These rows measure the other direction (ruling 118): a cell that runs inside the properly stripped
// READONLY worker, as the agent's own `python_exec` does, trying to recover a "yes" through (1) a reference Pyodide or
// Emscripten keeps, (2) the files mount's channel, or (3) a wasm import table. Every row carries a live control in the
// same cell, and the FULL realm runs the same probe where a "no" would otherwise be indistinguishable from a probe
// that cannot see anything.

/** The net/IO names section 3's table records as reachable from a FULL worker; all of them are true there. */
const NET_IO = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "BroadcastChannel", "MessageChannel", "MessagePort", "postMessage", "onmessage", "addEventListener", "importScripts", "indexedDB", "caches", "navigator", "Response", "Request", "Headers", "FileReader", "Blob", "File"];

test("a READONLY cell reads NONE of the net/IO names, and the same probe finds every one in a FULL worker", async () => {
    test.skip(!HAS_FORK, NEED_FORK);
    const ro = await runCell(`import js
_g = js.globalThis
fam = ${JSON.stringify(NET_IO)}
{"control": str(_g.Math.max(1, 2)), "URL": _g.URL is not None, "present": ",".join(n for n in fam if getattr(_g, n, None) is not None)}`, "route-back net/IO probe");
    expect(ro.control, "the cell must run in the stripped worker realm").toBe("2");
    expect(ro.URL, "positive control: an allow-listed constructor is readable, so the probe sees a realm").toBe(true);
    expect(ro.present, `the strip must leave no net/IO name readable, found ${ro.present}`).toBe("");
    // The control that makes the "no" mean something: the identical probe, in the realm section 3 measured.
    const full = await runFullCell(`_fam = ${JSON.stringify(NET_IO)}\n_result = ",".join(n for n in _fam if getattr(_g, n, None) is not None)`);
    expect(full.control, "the control cell must run in the real worker realm").toBe("2");
    expect(full.value, "every net/IO name must be present in the FULL realm, or this probe cannot see them").toBe(NET_IO.join(","));
});

test("a READONLY cell cannot recover the Emscripten module through Pyodide's own exports (route 1)", async () => {
    test.skip(!HAS_FORK, NEED_FORK);
    // Route 1: the strip deletes names from the realm's global, so only a CAPTURED value survives it. Pyodide is the
    // thing that captured most of them (its module object holds `fetch`, `indexedDB`, the FS, the wasm exports), so
    // `pyodide_js` — a JS module a Python cell can import, which would carry the module object as `_module` — is the
    // first place a recovery would come from. The probe lists what it finds; the control is a name the same probe
    // MUST find (`Math`, kept), so an empty answer is the module's absence rather than the getattr never working.
    const ro = await runCell(`import js, pyodide_js
_g = js.globalThis
names = ["_module", "FS", "API", "loadPackage", "version"]
{"control": str(_g.Math.max(1, 2)), "Math": _g.Math is not None, "URL": _g.URL is not None,
 "present": ",".join(n for n in names if getattr(pyodide_js, n, None) is not None)}`, "route-back pyodide_js probe");
    expect(ro.control, "the cell must run in the stripped worker realm").toBe("2");
    expect(ro.Math, "positive control: a kept name is readable through the same call").toBe(true);
    expect(ro.present, `pyodide_js must carry no Emscripten reference, found ${ro.present}`).toBe("");
    // The control that makes the "no" mean something: the identical probe in a FULL realm hands back the module, its
    // FS and the API's own names, so the READONLY answer is the seal's doing, not a probe that cannot see anything.
    const full = await runFullCell(`_pj = __import__("pyodide_js")\n_names = ["_module", "FS", "API", "loadPackage", "version"]\n_result = ",".join(n for n in _names if getattr(_pj, n, None) is not None)`);
    expect(full.control, "the control cell must run in the real worker realm").toBe("2");
    expect(full.value, `the FULL realm must reach the Emscripten module and its FS, got ${full.value}`).toBe("_module,FS,loadPackage,version");
});

test("a READONLY cell can compile its OWN wasm, but no host module, memory or import table is reachable (route 3)", async () => {
    test.skip(!HAS_FORK, NEED_FORK);
    // Route 3: Emscripten's module object is where the FS's IDBFS and the socket syscalls bind their imports to. A cell
    // that can compile wasm is not the problem — compiling its own module only gives it the imports it PASSES. The
    // problem would be reaching the host's Module, its memory or its exports table; the row compiles an empty module
    // (the 8-byte header is a valid module) as the control that WebAssembly works at all, then lists those objects.
    const r = await runCell(`import js
_g = js.globalThis
out = {"control": str(_g.Math.max(1, 2)), "URL": _g.URL is not None, "wasm": _g.WebAssembly is not None}
try:
    _m = js.WebAssembly.Module.new(js.Uint8Array.new([0, 97, 115, 109, 1, 0, 0, 0]))
    out["compiled"] = _m is not None
except BaseException as e:
    out["compiled"] = type(e).__name__ + ": " + str(e)[:120]
out["host"] = ",".join(n for n in ["Module", "wasmModule", "wasmExports", "wasmMemory"] if getattr(_g, n, None) is not None)
out`, "route-back wasm probe");
    expect(r.control, "the cell must run in the stripped worker realm").toBe("2");
    expect(r.URL, "positive control: an allow-listed name is readable").toBe(true);
    expect(r.wasm, "the WebAssembly constructor is kept, so a cell can compile its own module").toBe(true);
    expect(r.compiled, `the cell's own module must compile (an empty module is valid), got ${r.compiled}`).toBe(true);
    expect(r.host, `no host module, memory or exports table may be reachable, found ${r.host}`).toBe("");
});

test("no Pyodide module holds a JS object a READONLY cell can call (route 1, swept)", async () => {
    test.skip(!HAS_FORK, NEED_FORK);
    // The seal pops `pyodide_js` from `sys.modules`, but Pyodide's own modules bound things from it at THEIR import
    // time (`webloop`'s scheduleCallback, the package loader). Route 1 survives only if one of those bindings still
    // holds a JsProxy — a JS object the cell could call. So the row sweeps every attribute of every `pyodide*` module
    // and asserts none is one; the control is that the SAME test answers yes for the global object itself, so an empty
    // result is an empty realm, not an isinstance that never matches.
    const SWEEP = `import sys
from pyodide.ffi import JsProxy
_g = __import__("js").globalThis
_hits = []
for _mname, _m in list(sys.modules.items()):
    if _m is None or not (_mname.startswith("pyodide") or _mname.startswith("_pyodide")):
        continue
    for _n in dir(_m):
        try:
            _v = getattr(_m, _n)
        except BaseException:
            continue
        if isinstance(_v, JsProxy):
            _hits.append(_mname + "." + _n)
_result = ",".join(sorted(_hits))
_isProxy = isinstance(_g, JsProxy)`;
    const r = await runCell(`${SWEEP}
{"control": str(_g.Math.max(1, 2)), "URL": _g.URL is not None, "isProxy": _isProxy, "hits": _result}`, "route-back jsproxy sweep");
    expect(r.control, "the cell must run in the stripped worker realm").toBe("2");
    expect(r.isProxy, "positive control: the global object itself is a JsProxy, so the sweep's test can match").toBe(true);
    expect(r.hits, `a Pyodide module kept a JS object a cell can call: ${r.hits}`).toBe("");
    // The control in the other realm: the SAME sweep finds the module the seal took away.
    const full = await runFullCell(SWEEP);
    expect(full.control, "the control cell must run in the real worker realm").toBe("2");
    expect(full.value, `the FULL realm's sweep must find the module's bindings, got ${full.value}`).toContain("pyodide_js._module");
});

test("a READONLY cell's prototype WALKS find none of the net/IO names, and the same walk in FULL finds them (route 0)", async () => {
    test.skip(!HAS_FORK, NEED_FORK);
    // A worker's `fetch`, `postMessage`, `importScripts`, `indexedDB`, `caches` and `navigator` are Web IDL members on
    // WorkerGlobalScope.prototype / DedicatedWorkerGlobalScope.prototype / EventTarget.prototype, not own properties of
    // the global — so deleting the global's own names would leave them readable by `Object.getPrototypeOf`. The strip
    // walks that chain too (`lockdown.ts` step 3's loop), and this row measures it in the real worker: every prototype
    // up to null, the NET_IO names among its own properties, and the count of names each still has. (The cell is an
    // approved OUTSIDE cell, because `import js` is not in the dialect's allow list — the strip is the worker's boot
    // step, not the dialect's, so every cell in this worker shares the realm this walks.) A name found on ANY
    // prototype is a finding — the walk failing to see any is the defended outcome — so no getter is invoked and no
    // method is called (`close`, `postMessage` would act on the worker). The FULL realm runs the identical walk as the
    // control that a walk can see these members at all. The constructors a walk reaches are the next row's subject.
    const WALK = `import js
_g = js.globalThis
_o = js.Object
_fam = ${JSON.stringify(NET_IO)}
_chain = []
_p = _o.getPrototypeOf(_g)
for _i in range(12):
    if _p:
        _own = _o.getOwnPropertyNames(_p).to_py()
        _names = [n for n in _fam if n in _own]
        _chain.append(str(_i) + ":" + ",".join(_names) + "|" + str(len(_own)))
        _p = _o.getPrototypeOf(_p)
{"control": str(_g.Math.max(1, 2)), "URL": _g.URL is not None, "chain": ";".join(_chain)}`;
    const r = await runCell(WALK, "route-back prototype walk");
    // The cell asked for the JS bridge (nothing in the dialect holds `js`), so it ran as an approved outside cell in
    // this same stripped worker — which is the realm the row is about.
    expect(r.outsideWhy, "the cell must have asked for the JS bridge, or it is not touching the realm this row measures").toMatch(/import 'js'/);
    expect(r.control, "the cell must run in the stripped worker realm").toBe("2");
    expect(r.URL, "positive control: an allow-listed constructor is readable, so the cell holds JS objects").toBe(true);
    // The walk itself ran: the global's chain was entered, not an empty loop.
    expect(r.chain, `the prototype walk did not reach a second prototype: ${r.chain}`).toMatch(/(^|;)1:/);
    for (const entry of r.chain.split(";")) {
        const [, idx, names, count] = entry.match(/^(\d+):([^|]*)\|(\d+)$/) || [];
        expect(idx, `an unreadable walk entry: ${JSON.stringify(entry)} (${r.chain})`).toBeDefined();
        expect(names, `prototype ${idx} carries a net/IO name: ${names} (${r.chain})`).toBe("");
        expect(Number(count), `prototype ${idx} has no own name at all, so the walk saw nothing there`).toBeGreaterThan(0);
    }
    // The control: the identical walk in the realm a bypass gives finds the members on the prototypes.
    const full = await runFullCell(`${WALK}\n_result = json.dumps({"control": str(_g.Math.max(1, 2)), "chain": ";".join(_chain)})`);
    expect(full.control, "the control cell must run in the real worker realm").toBe("2");
    const f = JSON.parse(full.value);
    expect(f.chain, `the FULL realm's walk must find the net/IO members, got ${f.chain}`).toMatch(/fetch|postMessage|importScripts/);
});

test("a READONLY cell's walk reaches the global chain's CONSTRUCTORS but no live net/IO member or evaluator (route 0b)", async () => {
    test.skip(!HAS_FORK, NEED_FORK);
    // What a walk reaches CONSTRUCTORS, in the same stripped worker. MEASURED, and not what the first draft assumed:
    // the strip deletes net/IO NAMES from each prototype, but `constructor` is not one of those names, so each
    // prototype's `.constructor` still reads (`DedicatedWorkerGlobalScope`, `WorkerGlobalScope`, `EventTarget`,
    // `Object`). The row therefore measures what those constructors can be made to YIELD: an instance's own/prototype
    // names for the `NET_IO` family (a name counts as live only if its descriptor has a real value or getter — the
    // strip's shadow is a `value: undefined`), the global-scope constructor's refusal to construct, a kept instance's
    // `.constructor` (Module, kept with WebAssembly), and `Function` through `Object.constructor`, whose string call
    // the extension origin's CSP must refuse. Needs `try`, which also leaves the dialect outside; the realm is the
    // same worker's.
    const CTOR_PROBE = `import js
_g = js.globalThis
_o = js.Object
_undef = js.undefined
_fam = ${JSON.stringify(NET_IO)}

def _live(_obj):
    _out_names = []
    for _n in _fam:
        _d = _o.getOwnPropertyDescriptor(_obj, _n)
        if _d is not _undef and (_d.value is not _undef or _d.get is not _undef):
            _out_names.append(_n)
    return _out_names

def _chain_live(_root):
    _found = []
    _p = _root
    for _i in range(12):
        if _p:
            _here = _live(_p)
            if _here:
                _found.append(str(_i) + ":" + ",".join(_here))
            _p = _o.getPrototypeOf(_p)
    return ";".join(_found)

_ctors, _et_ctor, _fn, _err = [], _undef, "", ""
try:
    _p = _o.getPrototypeOf(_g)
    for _i in range(12):
        if _p:
            try:
                _name = str(_p.constructor.name)
                _ctors.append(str(_i) + ":" + _name)
                if _name == "EventTarget":
                    _et_ctor = _p.constructor
            except BaseException as _e:
                _ctors.append(str(_i) + "!" + type(_e).__name__)
            _p = _o.getPrototypeOf(_p)
    try:
        _et_live = _chain_live(_et_ctor.new())
        _et_ok = str(_et_live == "")
    except BaseException as _e:
        _et_ok, _et_live = "construct!" + type(_e).__name__, ""
    try:
        _o.getPrototypeOf(_g).constructor.new()
        _scope = "constructed!"
    except BaseException as _e:
        _scope = type(_e).__name__
    try:
        _m = js.WebAssembly.Module.new(js.Uint8Array.new([0, 97, 115, 109, 1, 0, 0, 0]))
        _ctors.append("instance:" + str(_m.constructor.name))
    except BaseException as _e:
        _ctors.append("instance!" + type(_e).__name__)
    try:
        _fn = "called:" + str(js.Object.constructor("return 1"))
    except BaseException as _e:
        _fn = type(_e).__name__ + ": " + str(_e)[:200]
except BaseException as _e:
    _err = type(_e).__name__ + ": " + str(_e)[:200]
{"control": str(_g.Math.max(1, 2)), "ctors": ",".join(_ctors), "et_ok": _et_ok, "et_live": _et_live, "scope": _scope, "fn": _fn, "err": _err}`;
    const c = await runCell(CTOR_PROBE, "route-back constructor walk");
    expect(c.control, "the constructor cell must run in the stripped worker realm").toBe("2");
    expect(c.err, `the constructor walk raised: ${c.err}`).toBe("");
    // The chain's constructors ARE readable (the measured fact this row exists to keep honest), and none of them is a
    // net/IO capability's constructor: those names were deleted, so no reference to them survives to read `.constructor` off.
    expect(c.ctors, `the walk did not reach the global chain's constructors: ${c.ctors}`).toContain("EventTarget");
    expect(c.ctors, `a net/IO capability's constructor is readable off the chain: ${c.ctors}`).not.toMatch(/MessagePort|BroadcastChannel|XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection|:Worker\b/);
    // The constructible members of that chain yield inert objects: no live NET_IO name on an EventTarget or its chain.
    expect(c.et_ok, `the EventTarget constructor did not construct for the probe: ${c.et_ok}`).toBe("True");
    expect(c.et_live, `an EventTarget built off the walk carries a live net/IO name: ${c.et_live}`).toBe("");
    // The chain's top constructor is the worker's own global scope, and it cannot be constructed into another one.
    expect(c.scope, `the global-scope constructor made an object: ${c.scope}`).not.toBe("constructed!");
    expect(c.ctors, `a kept instance's .constructor does not read: ${c.ctors}`).toContain("instance:Module");
    // `Function` is kept (Pyodide needs it) and tamed: the string call is refused by the extension origin's CSP, so a
    // walk reaches no evaluator. The refusal is asserted by KIND, not only by the absence of a result.
    expect(c.fn, `Function reached through .constructor evaluated a string: ${c.fn}`).not.toMatch(/^called:/);
    expect(c.fn, `Function through .constructor refused with something other than the CSP's EvalError: ${c.fn}`).toMatch(/EvalError/);
    expect(c.fn, `the CSP refusal must be the eval directive, not a generic error: ${c.fn}`).toMatch(/unsafe-eval/);
    // The control: the identical probe in the realm a bypass gives sees the members it looks for on the same instance.
    const full = await runFullCell(`${CTOR_PROBE}\n_result = json.dumps({"control": str(_g.Math.max(1, 2)), "et_live": _et_live})`);
    expect(full.control, "the control cell must run in the real worker realm").toBe("2");
    const f = JSON.parse(full.value);
    expect(f.et_live, `the FULL realm's EventTarget must carry the net/IO members, got ${JSON.stringify(f)}`).toMatch(/addEventListener/);
});
