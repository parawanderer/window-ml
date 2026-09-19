// sw-python.ts — the worker's side of python_exec: the offscreen Pyodide host (the service worker cannot run
// WASM), the choke point that decides whether a caller may run `full` mode, and the live stdout relay back to
// whoever is awaiting the run. Created lazily on first use and reused after.

import { senderTrust, pendingGrants } from "./sw-consent";
import { recordHousekeeping } from "./sw-housekeeping";
import { ensureOffscreen, forgetOffscreen } from "./sw-offscreen";
import { activeRuns, pageValueSession } from "./sw-runs";
import { valueHolders, budgetBytes as valueBudgetBytes, claimValue } from "./sw-values";

// LIVE python_exec stdout streaming: maps a run's streamId (the page requestId) → its tabId, so a PY_STDOUT
// chunk the offscreen doc forwards can be relayed to the RIGHT page. Set when a streaming PYTHON_EXEC starts,
// deleted when it resolves. Only populated for opt-in streaming runs (a bounded, short-lived map).
/** streamId → where its live stdout goes. A TAB id relays through that tab's content script (a page's
 *  `ml.pythonExec`, i.e. the agent's tool); NULL means the caller was one of our OWN surfaces — the sidebar's
 *  Python bench — which is not reachable that way and is broadcast to instead. Both callers ask for the same
 *  worker tee; only the last hop differs. */
const pyStreamTabs = new Map<string, number | null>();

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

/** PYTHON_EXEC: run one sandboxed-Python call in the offscreen host. THE choke point for `full` mode, which is
 *  network at the extension origin: readonly is safe for any caller, full needs a trusted surface, a
 *  whitelisted domain, or a per-call grant for exactly this code. */
export function pythonExec(message: any, sender: chrome.runtime.MessageSender, sendResponse: (r: any) => void): void {
    // Route the sandboxed-Python run to the offscreen Pyodide host (the service worker can't run WASM).
    // CHOKE-POINT: FULL (unhardened) mode is network at the extension origin — gate it. Readonly is a
    // network-nulled sandbox (safe for any caller); full is allowed only from a trusted surface, a
    // whitelisted domain, or with a per-call grant for THIS code. An untrusted page without one is
    // REJECTED (a clear error, not a silent readonly downgrade).
    (async () => {
        const ownSurface = (sender.url || "").startsWith(chrome.runtime.getURL(""));
        // A COMPLETION is the bench EDITOR's, and only ours. It never runs the code, but it does load a
        // package and read the interpreter, so a page gains nothing by reaching it and is refused rather
        // than handed a new kind of request to the single sandbox. Always HARDENED, whatever it asked for.
        const rawComplete = message.payload?.complete;
        if (rawComplete && !ownSurface) {
            sendResponse({ error: "Refused: code completion is a workbench feature." });
            return;
        }
        const benchMode = rawComplete?.bench === "full" ? "full" : rawComplete?.bench === "readonly" ? "readonly" : undefined;
        const complete = rawComplete
            ? { line: Math.max(1, Number(rawComplete.line) | 0), column: Math.max(0, Number(rawComplete.column) | 0), ...(benchMode ? { bench: benchMode } : {}) }
            : null;
        // The bench's KEPT STATE is ours alone, on the same unforgeable discriminator as the rest: a page's
        // run always executes in the namespace every run resets, and a page cannot clear a person's variables.
        if (message.payload?.benchReset && !ownSurface) {
            sendResponse({ error: "Refused: the workbench's state is not a page's to reset." });
            return;
        }
        // A STORED table is read only for a run that holds it. The key reaches the page (the loop hands the
        // table down through the delegated tool), so a page may pass one, but only while a run hosted on its own
        // tab holds that value: a key from somewhere else reads nothing. A key no longer stored is let through, so
        // the offscreen read fails with the store's own reason. Our own surfaces are trusted, as for everything here.
        const stored = (Array.isArray(message.payload?.tables) ? message.payload.tables as { data?: { kind?: string; key?: unknown } }[] : [])
            .filter((t) => t?.data?.kind === "value");
        if (stored.length && !ownSurface) {
            const tid = sender.tab?.id;
            const running = tid != null ? activeRuns.get(tid) : undefined;
            // Either the value is held by a run WE host on this tab, or it was disclosed to this tab in the first
            // place (a page-hosted run, whose loop we cannot vouch for — pageValueSession).
            const mine = (h: string) => running?.has(h) || (tid != null && h === pageValueSession(tid));
            for (const t of stored) {
                const holders = await valueHolders(String(t.data?.key));
                if (holders && !holders.some(mine)) {
                    sendResponse({ error: "Refused: that stored table belongs to a run that is not running on this page." });
                    return;
                }
            }
        }
        const persist = !!message.payload?.persist && ownSurface;
        const benchReset = !!message.payload?.benchReset;
        const wantsFull = !complete && message.payload?.hardened === false;
        if (wantsFull) {
            const trust = await senderTrust(sender);
            if (trust === "untrusted") {
                const code = String(message.payload?.code ?? "");
                if (!(sender.tab?.id != null && pendingGrants.get(sender.tab.id)?.pyCode.has(code))) {
                    sendResponse({ error: "Refused: network-enabled (full) Python needs approval on this page — run it through an agent and approve it, or add this site to the approval whitelist." });
                    return;
                }
            }
        }
        // LIVE stdout streaming (opt-in): record where this run's chunks go. The discriminator is the
        // sending FRAME's own url, not `sender.tab` — the overlay sidebar is an extension iframe INSIDE a
        // tab, so it has one, and relaying its chunks through that tab's content script would post them
        // to the page instead of to the bench that asked. `sender.url` is set by Chrome and a page cannot
        // forge it.
        const streamId: string | undefined = message.payload?.stream ? message.requestId : undefined;
        if (streamId) {
            const fromSurface = (sender.url || "").startsWith(chrome.runtime.getURL(""));
            if (fromSurface) pyStreamTabs.set(streamId, null);
            else if (sender.tab?.id != null) pyStreamTabs.set(streamId, sender.tab.id);
        }
        // NO WATCHDOG is a WORKBENCH-ONLY favour, gated at the same choke point and on the same
        // unforgeable discriminator as the stream routing above: `sender.url` is set by Chrome, so only
        // one of OUR OWN surfaces can ask. A page-invoked tool keeps the 15s cap whatever it sends — a
        // run that never ends holds the single Pyodide instance against every later call, with nobody
        // watching it; in the bench a person chose it, is sitting in front of it, and can close the panel.
        const noTimeout = !!message.payload?.noTimeout
            && (sender.url || "").startsWith(chrome.runtime.getURL(""));
        // A run whose returned frame may become a pointer carries the store's budget; the bench's and a completion's never do.
        const valueBudget = persist || complete ? 0 : await valueBudgetBytes().catch(() => 0);
        const payload = { type: "PY_RUN", ...(valueBudget ? { valueBudget } : {}), code: message.payload?.code, image: message.payload?.image ?? null, hardened: complete ? true : message.payload?.hardened !== false, tables: message.payload?.tables ?? null, stream: !!streamId, streamId, ...(noTimeout ? { noTimeout: true } : {}), ...(message.payload?.env ? { env: true } : {}), ...(complete ? { complete } : {}), ...(persist ? { persist: true } : {}), ...(benchReset ? { benchReset: true } : {}) };
        const attempt = () => ensureOffscreen().then(() => chrome.runtime.sendMessage(payload));
        attempt()
            .catch((err) => {
                // The offscreen doc can be gone (SW slept and the doc was torn down, or a stale cached-
                // ready) → "Receiving end does not exist." Drop the cache, recreate, retry ONCE.
                if (!/Receiving end does not exist|Could not establish connection/.test(String(err?.message || err))) throw err;
                forgetOffscreen();
                return attempt();
            })
            .then((res) => {
                // A returned DataFrame past its preview was stored by the offscreen document, and its key is about
                // to reach the page. Same rule as a fetched body: disclosing the key to a tab is what entitles that
                // tab's page-hosted run to read it back (pageValueSession).
                const key = (res as { valueKey?: string } | undefined)?.valueKey;
                if (key && sender.tab?.id != null) claimValue(key, pageValueSession(sender.tab.id));
                sendResponse({ data: res });
            })
            .catch((err) => sendResponse({ error: err?.message || String(err) }))
            .finally(() => { if (streamId) pyStreamTabs.delete(streamId); });
    })();
}

/** PY_STDOUT: relay one live stdout chunk from the offscreen host to whoever is awaiting that stream — a page
 *  through its content script, one of our own surfaces over the runtime channel. */
export function relayPyStdout(message: any): void {
    // A live stdout chunk from the offscreen Pyodide host → relay to the run's page (keyed by streamId), which
    // resolves it as a PYTHON_EXEC_RESPONSE progress event to the awaiting ml.pythonExec (→ the tool's ctx.stream).
    if (!pyStreamTabs.has(message.streamId)) return;
    const tabId = pyStreamTabs.get(message.streamId);
    const chunk = { type: "PYTHON_STREAM", requestId: message.streamId, chunk: message.chunk, ts: message.ts };
    // A SURFACE (the bench) is an extension context, so the chunk goes out on the runtime channel every
    // such context hears; it is filtered by requestId at the other end, which is unique per run. A PAGE
    // is reached the long way, through its content script.
    if (tabId == null) chrome.runtime.sendMessage(chunk).catch(() => { /* nobody listening → drop */ });
    else chrome.tabs.sendMessage(tabId, chunk).catch(() => { /* page gone → drop */ });
}
