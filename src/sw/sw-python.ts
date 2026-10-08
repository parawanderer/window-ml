// sw-python.ts — the worker's side of python_exec: the offscreen Pyodide host (the service worker cannot run
// WASM), the choke point that decides whether a caller may run `full` mode, and the live stdout relay back to
// whoever is awaiting the run. Created lazily on first use and reused after.

import { senderTrust, pendingGrants, isExtensionSender } from "./sw-consent";
import { recordHousekeeping } from "./sw-housekeeping";
import { ensureOffscreen, forgetOffscreen } from "./sw-offscreen";
import { activeRuns, pageValueSession } from "./sw-runs";
import { valueHolders, budgetBytes as valueBudgetBytes, claimValue } from "./sw-values";
import { PY_PACKAGE_LOADS } from "../python/python-env";

// LIVE python_exec stdout streaming: maps a run's streamId (the page requestId) → its tabId, so a PY_STDOUT
// chunk the offscreen doc forwards can be relayed to the RIGHT page. Set when a streaming PYTHON_EXEC starts,
// deleted when it resolves. Only populated for opt-in streaming runs (a bounded, short-lived map).
/** streamId → where its live stdout goes. A TAB id relays through that tab's content script (a page's
 *  `ml.pythonExec`, i.e. the agent's tool); NULL means the caller was one of our OWN surfaces — the sidebar's
 *  Python bench — which is not reachable that way and is broadcast to instead. Both callers ask for the same
 *  worker tee; only the last hop differs. */
const pyStreamTabs = new Map<string, number | null | ((chunk: string, ts?: number) => void)>();

/** PYTHON_PREWARM: boot the offscreen Pyodide host ahead of a run that will need it. `sendResponse` reports
 *  whether this call is what actually started it. */
export function pythonPrewarm(message: any, sendResponse: (r: any) => void): void {
    // Start Pyodide ahead of a run likely to need it: a run whose tools include python_exec starting, or the
    // Commander opening (its runs always have it). Only those two — booting the runtime and its packages
    // costs real memory, so a mere ml.* read never pays it. Idempotent in the worker, and logged only when it
    // actually started something. A page can send this, and could already start the runtime by running code.
    const trigger = (message.payload as { trigger?: string } | undefined)?.trigger;
    if (trigger !== "run-start" && trigger !== "commander") { sendResponse({ error: "PYTHON_PREWARM needs a trigger: run-start or commander." }); return; }
    ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({ type: "PY_PREWARM" }))
        .then((r: { prewarm?: string } | undefined) => {
            if (r?.prewarm === "started") recordHousekeeping({ subsystem: "pyodide", kind: "prewarm", reason: trigger });
            sendResponse({ data: r?.prewarm ?? null });
        })
        .catch((e) => sendResponse({ error: String((e as Error)?.message || e) }));
}

/** Who a `PYTHON_EXEC` is for: a page or one of our surfaces through the router, or a run's tool answered in the worker. */
export interface PythonCaller {
    /** One of the extension's own surfaces (the bench): trusted with everything here. */
    ownSurface: boolean;
    /** The tab it is for, when it has one. */
    tabId?: number;
    /** Not a trusted surface or a whitelisted domain: `full` mode needs a grant. Asked only when it matters. */
    untrusted: () => Promise<boolean>;
    /** Whether `full` mode is approved for exactly this code. Absent: the tab's call grant (`pendingGrants.pyCode`). */
    pyCodeOk?: (code: string) => boolean;
    /** Whether this caller may read a stored table held by `holders`. Absent: a run hosted on its tab, or the tab the
     *  key was disclosed to. */
    valueOk?: (holders: string[]) => boolean;
    /** Where live stdout goes: a tab, one of our surfaces (null), or a function (a run's own output, in the worker). */
    stream?: number | null | ((chunk: string, ts?: number) => void);
    /** Record a returned frame's key as disclosed to the tab (`pageValueSession`). False for a run in the worker, whose
     *  loop claims it under the run's own session. */
    disclose: boolean;
}

/** PYTHON_EXEC through the router: the caller is read off the sender, which the browser sets. */
export function pythonExec(message: any, sender: chrome.runtime.MessageSender, sendResponse: (r: any) => void): void {
    const ownSurface = isExtensionSender(sender);
    void runPython(message.payload, message.requestId, {
        ownSurface, tabId: sender.tab?.id, untrusted: async () => (await senderTrust(sender)) === "untrusted",
        // The discriminator is the sending FRAME's own url, not `sender.tab`: the overlay sidebar is an extension
        // iframe INSIDE a tab, and relaying its chunks through that tab's content script would post them to the page
        // instead of to the bench that asked. `sender.url` is set by Chrome and a page cannot forge it.
        stream: ownSurface ? null : sender.tab?.id, disclose: true,
    }).then(sendResponse);
}

/**
 * Run one sandboxed-Python call in the offscreen host. THE choke point for `full` mode, which is network at the
 * extension origin: readonly is safe for any caller, full needs a trusted surface, a whitelisted domain, or a grant for
 * exactly this code. Rejected with a clear error, never silently downgraded to readonly.
 * @param payload what `PYTHON_EXEC` carries
 * @param requestId the caller's request id, which keys its live stdout
 * @param caller who it is for
 * @returns the run's result, or the refusal or failure
 */
export async function runPython(payload: any, requestId: string | undefined, caller: PythonCaller): Promise<{ data?: unknown; error?: string }> {
    const { ownSurface } = caller;
    // A COMPLETION is the bench EDITOR's, and only ours. It never runs the code, but it does load a package and read
    // the interpreter, so a page gains nothing by reaching it and is refused rather than handed a new kind of request
    // to the single sandbox. Always HARDENED, whatever it asked for.
    const rawComplete = payload?.complete;
    if (rawComplete && !ownSurface) return { error: "Refused: code completion is a workbench feature." };
    const benchMode = rawComplete?.bench === "full" ? "full" : rawComplete?.bench === "readonly" ? "readonly" : undefined;
    const complete = rawComplete
        ? { line: Math.max(1, Number(rawComplete.line) | 0), column: Math.max(0, Number(rawComplete.column) | 0), ...(benchMode ? { bench: benchMode } : {}) }
        : null;
    // The bench's KEPT STATE is ours alone: a page's run always executes in the namespace every run resets, and a page
    // cannot clear a person's variables.
    if (payload?.benchReset && !ownSurface) return { error: "Refused: the workbench's state is not a page's to reset." };
    // A STORED table is read only for a caller entitled to it. The key reaches the page (the loop hands the table down
    // through the delegated tool), so a page may pass one, but only while a run hosted on its own tab holds that value
    // (or it was disclosed to this tab: a page-hosted run, whose loop we cannot vouch for). A key no longer stored is
    // let through, so the offscreen read fails with the store's own reason. Our own surfaces are trusted.
    const stored = (Array.isArray(payload?.tables) ? payload.tables as { data?: { kind?: string; key?: unknown } }[] : [])
        .filter((t) => t?.data?.kind === "value");
    if (stored.length && !ownSurface) {
        const tid = caller.tabId;
        const running = tid != null ? activeRuns.get(tid) : undefined;
        const ok = caller.valueOk ?? ((holders: string[]) => holders.some((h) => running?.has(h) || (tid != null && h === pageValueSession(tid))));
        for (const t of stored) {
            const holders = await valueHolders(String(t.data?.key));
            if (holders && !ok(holders)) return { error: "Refused: that stored table belongs to a run that is not running on this page." };
        }
    }
    const persist = !!payload?.persist && ownSurface;
    const benchReset = !!payload?.benchReset;
    const wantsFull = !complete && payload?.hardened === false;
    if (wantsFull && await caller.untrusted()) {
        const code = String(payload?.code ?? "");
        const approved = caller.pyCodeOk ? caller.pyCodeOk(code) : caller.tabId != null && !!pendingGrants.get(caller.tabId)?.pyCode.has(code);
        if (!approved) return { error: "Refused: network-enabled (full) Python needs approval on this page — run it through an agent and approve it, or add this site to the approval whitelist." };
    }
    // LIVE stdout streaming (opt-in): record where this run's chunks go.
    const streamId: string | undefined = payload?.stream ? requestId : undefined;
    if (streamId && caller.stream !== undefined) pyStreamTabs.set(streamId, caller.stream);
    // NO WATCHDOG is a WORKBENCH-ONLY favour: only one of OUR OWN surfaces can ask. A page-invoked tool keeps the 15s
    // cap whatever it sends — a run that never ends holds the single Pyodide instance against every later call.
    const noTimeout = !!payload?.noTimeout && ownSurface;
    // A run whose returned frame may become a pointer carries the store's budget; the bench's and a completion's never do.
    const valueBudget = persist || complete ? 0 : await valueBudgetBytes().catch(() => 0);
    const run = { type: "PY_RUN", ...(valueBudget ? { valueBudget } : {}), code: payload?.code, image: payload?.image ?? null, hardened: complete ? true : payload?.hardened !== false, tables: payload?.tables ?? null, stream: !!streamId, streamId, ...(noTimeout ? { noTimeout: true } : {}), ...(payload?.env ? { env: true } : {}), ...(complete ? { complete } : {}), ...(persist ? { persist: true } : {}), ...(benchReset ? { benchReset: true } : {}) };
    const attempt = () => ensureOffscreen().then(() => chrome.runtime.sendMessage(run));
    try {
        const res = await attempt().catch((err) => {
            // The offscreen doc can be gone (SW slept and the doc was torn down, or a stale cached-ready) → "Receiving
            // end does not exist." Drop the cache, recreate, retry ONCE.
            if (!/Receiving end does not exist|Could not establish connection/.test(String(err?.message || err))) throw err;
            forgetOffscreen();
            return attempt();
        });
        // A returned DataFrame past its preview was stored by the offscreen document, and its key is about to reach the
        // caller. Same rule as a fetched body: disclosing the key to a tab entitles that tab's page-hosted run to it.
        const key = (res as { valueKey?: string } | undefined)?.valueKey;
        if (key && caller.disclose && caller.tabId != null) claimValue(key, pageValueSession(caller.tabId));
        return { data: res };
    } catch (err) {
        return { error: (err as Error)?.message || String(err) };
    } finally {
        if (streamId) pyStreamTabs.delete(streamId);
    }
}

/** PY_STDOUT: relay one live stdout chunk from the offscreen host to whoever is awaiting that stream — a page
 *  through its content script, one of our own surfaces over the runtime channel. */
export function relayPyStdout(message: any): void {
    // A live stdout chunk from the offscreen Pyodide host → relay to the run's page (keyed by streamId), which
    // resolves it as a PYTHON_EXEC_RESPONSE progress event to the awaiting ml.pythonExec (→ the tool's ctx.stream).
    if (!pyStreamTabs.has(message.streamId)) return;
    const tabId = pyStreamTabs.get(message.streamId);
    // A run's tool answered in the worker: straight to its output, never through a tab.
    if (typeof tabId === "function") { try { tabId(String(message.chunk ?? ""), message.ts); } catch { /* a bad sink must not break the relay */ } return; }
    const chunk = { type: "PYTHON_STREAM", requestId: message.streamId, chunk: message.chunk, ts: message.ts };
    // A SURFACE (the bench) is an extension context, so the chunk goes out on the runtime channel every
    // such context hears; it is filtered by requestId at the other end, which is unique per run. A PAGE
    // is reached the long way, through its content script.
    if (tabId == null) chrome.runtime.sendMessage(chunk).catch(() => { /* nobody listening → drop */ });
    else chrome.tabs.sendMessage(tabId, chunk).catch(() => { /* page gone → drop */ });
}

let bundleChecked: Promise<boolean> | null = null;

/**
 * Can this build run Python at all: an offscreen document to host it, the Pyodide core, and the wheel of every package
 * the sandbox loads at start. The wheels are gitignored (`pyodide-wheels/`) and the build only warns when they are
 * missing, so a fresh checkout ships a bundle whose first run dies on `ModuleNotFoundError: No module named 'numpy'`.
 * This is what the runtime's `pythonBench` capability reports, so a client never offers a bench that fails like that.
 *
 * Read from the bundle's own files (the lock names each wheel's file), once per worker life: the bundle cannot change
 * under a running worker. A lazy package (the bench editor's completion) is not required — the bench runs without it.
 */
export function pythonBundlePresent(): Promise<boolean> {
    return bundleChecked ??= (async () => {
        if (typeof chrome.offscreen?.createDocument !== "function") return false;
        const at = (f: string) => chrome.runtime.getURL(`pyodide/${f}`);
        // A missing extension resource REJECTS rather than answering 404, hence the catch. The body is cancelled
        // unread: a wheel is megabytes, and whether it opens is the whole question.
        const exists = async (f: string) => {
            try { const r = await fetch(at(f)); void r.body?.cancel().catch(() => {}); return r.ok; } catch { return false; }
        };
        try {
            const lock = await (await fetch(at("pyodide-lock.json"))).json() as { packages?: Record<string, { file_name?: string }> };
            const pk = lock.packages ?? {};
            const files = PY_PACKAGE_LOADS.map((n) => (pk[n] ?? pk[Object.keys(pk).find((k) => k.toLowerCase() === n.toLowerCase()) ?? ""])?.file_name);
            if (files.some((f) => !f)) return false;
            return (await Promise.all([exists("pyodide.asm.wasm"), ...files.map((f) => exists(f!))])).every(Boolean);
        } catch { return false; }
    })();
}
