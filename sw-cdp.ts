// CDP / chrome.debugger layer for the service worker — the ONE path that reaches surfaces page-world JS
// structurally can't: strict-CSP/Trusted-Types exec, trusted (isTrusted) clicks/keystrokes into canvas /
// cross-origin iframes / declarative-closed shadow roots, and a host-grant-free screenshot. Extracted from
// background.ts verbatim; it owns its own attach lifecycle and shares no state with the rest of the worker.
// Gated at the call sites behind the off-by-default `cdp` setting + the `debugger` permission (checked here).
import { clipOut } from "./dom";

/** Is the `debugger` permission held? It's declared at INSTALL time (in `permissions`, not optional) —
 *  Chrome forbids `debugger` as a runtime-optional grant (`permissions.request` rejects it: "Only permissions
 *  specified in the manifest may be requested"). So this always holds once the extension is loaded + its
 *  permissions accepted; the defensive check just degrades gracefully (actionable error) if it's somehow
 *  absent (e.g. an update pending re-approval). The `cdpClick` config flag is the actual on/off. */
async function hasDebuggerPermission(): Promise<boolean> {
    try { return await chrome.permissions.contains({ permissions: ["debugger"] }); } catch { return false; }
}

// CDP debugger attach lifecycle. On a strict-CSP page EVERY exec (and every reserved-element click) runs
// through the debugger — and attach/detach is the dominant per-call cost (the eval/click itself is instant;
// the page work + content-script relay are sub-millisecond, measured). Attaching/detaching per call also
// flickers the "being debugged" infobar each time. So we attach ONCE per tab on first CDP use and REUSE it
// across the run, detaching when the run ends, the tab closes, or the tab goes idle. Chrome auto-detaches if
// the SW is evicted, so a lost cleanup can't strand the infobar.
const attachedDebuggees = new Set<number>();          // tabIds we currently hold the debugger on
const debuggerIdleTimers = new Map<number, ReturnType<typeof setTimeout>>();
const DEBUGGER_IDLE_MS = 20_000;   // detach a tab's debugger after this long with no CDP use (covers a standalone CDP_CLICK with no run to clean up)

/** Attach the debugger to `tabId` if we don't already hold it (idempotent), reusing a live attachment across
 *  calls. Returns ok, or an actionable error (missing permission / another debugger already attached). */
export async function ensureDebuggerAttached(tabId: number): Promise<{ ok: true } | { error: string; needsPermission?: true }> {
    if (!(await hasDebuggerPermission())) return { error: "The `debugger` permission isn't granted — enable \"Debugger-based actions (CDP)\" in window.ml Settings → Advanced.", needsPermission: true };
    if (attachedDebuggees.has(tabId)) return { ok: true };
    try {
        await chrome.debugger.attach({ tabId }, "1.3");
        attachedDebuggees.add(tabId);
        return { ok: true };
    } catch (e) {
        const msg = (e as Error)?.message || String(e);
        if (/already attached/i.test(msg)) { attachedDebuggees.add(tabId); return { ok: true }; }   // a prior attach we didn't track / a race
        return { error: msg };
    }
}
/** Detach the debugger from `tabId` (if held) and clear its idle timer. Idempotent. */
export function releaseDebugger(tabId: number): void {
    const timer = debuggerIdleTimers.get(tabId);
    if (timer) { clearTimeout(timer); debuggerIdleTimers.delete(tabId); }
    if (!attachedDebuggees.has(tabId)) return;
    attachedDebuggees.delete(tabId);
    try { void chrome.debugger.detach({ tabId }).catch(() => {}); } catch { /* already gone / tab closed */ }
}
/** Reset the idle-detach timer after a CDP op — a run detaches eagerly in its finally, but a standalone
 *  CDP_CLICK (no run) relies on this so the debugger doesn't stay attached forever. */
function touchDebugger(tabId: number): void {
    const prev = debuggerIdleTimers.get(tabId);
    if (prev) clearTimeout(prev);
    debuggerIdleTimers.set(tabId, setTimeout(() => { debuggerIdleTimers.delete(tabId); releaseDebugger(tabId); }, DEBUGGER_IDLE_MS));
}
// Chrome detached the debugger out from under us (DevTools opened on the tab, the target crashed/closed, or
// the user clicked "cancel" on the infobar) → forget the tab so the next CDP use re-attaches cleanly.
try { chrome.debugger.onDetach.addListener((source) => { if (source.tabId != null) { attachedDebuggees.delete(source.tabId); const t = debuggerIdleTimers.get(source.tabId); if (t) { clearTimeout(t); debuggerIdleTimers.delete(source.tabId); } } }); } catch { /* no debugger API in this context */ }

/** Click at a VIEWPORT coordinate via CDP — the ONLY way to reach a "reserved" surface (a cross-origin
 *  iframe, or a declarative/native closed shadow root): the BROWSER hit-tests the point, so the click
 *  retargets INTO the frame / closed tree and is a TRUSTED, user-activated event (a synthetic dispatch is
 *  neither — it fires on the named element and can't cross those boundaries). Attaches the debugger (its
 *  unsuppressible banner is the honest "input-level control" signal — and it's shown ONLY for these reserved
 *  clicks, so the flash marks the risk), sends press+release, and ALWAYS detaches. See docs/spec/CDP_CLICK.md. */
export async function cdpClick(tabId: number, x: number, y: number): Promise<{ ok: true } | { error: string; needsPermission?: true }> {
    const at = await ensureDebuggerAttached(tabId);   // reuses a live attachment; attaches once per run (see the lifecycle above)
    if ("error" in at) return { error: `Couldn't attach the debugger to click a reserved element (${at.error}). Another debugger (DevTools?) may be attached to this tab.`, ...(at.needsPermission ? { needsPermission: true } : {}) };
    const target: chrome.debugger.Debuggee = { tabId };
    const send = (type: string, buttons: number) =>
        chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });
    try {
        await send("mousePressed", 1);
        await send("mouseReleased", 0);
        return { ok: true };
    } catch (e) {
        return { error: `The CDP click failed (${(e as Error)?.message || e}).` };
    } finally {
        touchDebugger(tabId);   // keep the attachment warm; the run's finally (or the idle timer) detaches
    }
}

/** Run `source` via CDP `Runtime.evaluate` in the tab's MAIN world — the ONLY way to execute imperative JS on
 *  a page whose CSP omits 'unsafe-eval' or enforces Trusted Types (the debugger is exempt). `source` is the
 *  ALREADY-APPROVED exec code (main-world eval was blocked at COMPILE → nothing ran). window.ml, page globals,
 *  and the live DOM are all reachable (it runs in the page's own main world). Attaches the debugger (its
 *  banner is the honest "the browser is being driven" signal), evaluates, ALWAYS detaches. Two shapes, like
 *  the main-world exec: a trailing-expression first (REPL value), then a statement body (the model `return`s).
 *  See docs/spec/EXEC_STRICT_CSP.md. */
export async function cdpEval(tabId: number, source: string): Promise<{ ok: true; value: string } | { error: string; needsPermission?: true }> {
    const at = await ensureDebuggerAttached(tabId);   // reuses a live attachment; attach/detach is the dominant per-exec cost on a strict page
    if ("error" in at) return { error: `Couldn't attach the debugger to run exec (${at.error}). Another debugger (DevTools?) may be attached to this tab.`, ...(at.needsPermission ? { needsPermission: true } : {}) };
    const target: chrome.debugger.Debuggee = { tabId };
    type WrapVal = { __mlWrapped: true; v: string; logs: string[] };
    type EvalResult = { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
    const evaluate = (expression: string) => chrome.debugger.sendCommand(target, "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true, userGesture: true }) as Promise<EvalResult>;
    const syntaxErr = (r: EvalResult) => /SyntaxError/.test(r?.exceptionDetails?.exception?.description || r?.exceptionDetails?.text || "");
    // Capture console output the SAME way the main-world exec path does — the model can't see the page's real
    // console, and a `Runtime.evaluate` that only returns the completion value silently drops every console.log
    // (the reported "logs got lost in CDP"). Patch console INSIDE the page (via the wrapper), collect the lines,
    // stringify the completion value there too (so returnByValue always gets a clean string[]+string), restore.
    const wrap = (inner: string) => `(async () => {
        const __logs = [], __M = ['log','info','warn','error','debug'], __S = {};
        for (const m of __M) { __S[m] = console[m]; console[m] = (...a) => __logs.push(a.map(x => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } }).join(' ')); }
        try {
            const __v = await (${inner});
            const __vs = __v === undefined ? '(undefined)' : typeof __v === 'string' ? __v : (() => { try { return JSON.stringify(__v); } catch { return String(__v); } })();
            return { __mlWrapped: true, v: __vs, logs: __logs };
        } finally { for (const m of __M) console[m] = __S[m]; }
    })()`;
    try {
        const CAP = 500;   // match exec's default per-slot output cap (the tool's resolveOutputCap default)
        const expr = source.trim().replace(/;\s*$/, "");
        // Trailing-expression form first (REPL value, like the main-world fast path); a statement body isn't a
        // valid parenthesised expression → SyntaxError → retry as a body where the model `return`s its value.
        let r = await evaluate(wrap(`(${expr})`));
        if (syntaxErr(r)) r = await evaluate(wrap(`(async () => { ${source} })()`));
        if (r?.exceptionDetails) return { error: `The exec threw (via CDP): ${r.exceptionDetails.exception?.description || r.exceptionDetails.text || "error"}` };
        const out = r?.result?.value as WrapVal | undefined;
        const value = out && out.__mlWrapped ? out.v : "(undefined)";
        const logs = out && Array.isArray(out.logs) ? out.logs : [];
        // Prefix captured console output onto the value, exactly like the main-world path's `withLogs`.
        const combined = logs.length ? `console:\n${clipOut(logs.join("\n"), CAP)}\n\nvalue: ${value}` : value;
        return { ok: true, value: combined };
    } catch (e) {
        return { error: `The CDP exec failed (${(e as Error)?.message || e}).` };
    } finally {
        touchDebugger(tabId);   // keep the attachment for the next exec; the run's finally (or the idle timer) detaches
    }
}

/** Screenshot the tab's viewport via CDP `Page.captureScreenshot`. The point of this over
 *  `chrome.tabs.captureVisibleTab`: captureVisibleTab specifically needs the `activeTab` OR `<all_urls>`
 *  permission (Chromium's kActiveTabOrAllUrls) — a per-HOST grant does NOT satisfy it, and "On click" site
 *  access withholds <all_urls> — so look/locate/screenshot fail on e.g. GitHub. The DEBUGGER is exempt (same
 *  as exec/click), so when CDP is enabled we capture through it instead, no host grant needed. Returns a PNG
 *  data URL matching captureVisibleTab's shape. Reuses the run's live attachment (attach once, see the
 *  lifecycle above). */
export async function cdpScreenshot(tabId: number): Promise<{ ok: true; dataUrl: string } | { error: string; needsPermission?: true }> {
    const at = await ensureDebuggerAttached(tabId);
    if ("error" in at) return { error: at.error, ...(at.needsPermission ? { needsPermission: true } : {}) };
    try {
        const r = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false }) as { data?: string };
        if (!r?.data) return { error: "the CDP screenshot returned no data." };
        return { ok: true, dataUrl: `data:image/png;base64,${r.data}` };
    } catch (e) {
        return { error: `the CDP screenshot failed (${(e as Error)?.message || e}).` };
    } finally {
        touchDebugger(tabId);
    }
}

// A match the CDP shadow resolver returns: one element reached across a closed/declarative shadow boundary —
// its describe line (tag#id.classes "own text") + its viewport CENTRE (for a coordinate click) + its box size.
export interface CdpShadowMatch { line: string; cx: number; cy: number; w: number; h: number; }
// Runs IN THE PAGE (via callFunctionOn) on a resolved node — the node lives in a closed shadow root a page
// selector can't reach, but it IS a real Element in the page's realm, so getBoundingClientRect/textContent work.
// Returns the same one-line shape elLine builds, plus the click centre. Self-contained (no closure deps).
const CDP_SHADOW_DESC_FN = `function () {
    var el = this;
    if (!el || el.nodeType !== 1) return null;
    var tag = (el.tagName || '').toLowerCase();
    var id = el.id ? '#' + el.id : '';
    var cls = (el.classList && el.classList.length) ? '.' + Array.prototype.slice.call(el.classList, 0, 4).join('.') : '';
    var own = '';
    try { own = Array.prototype.filter.call(el.childNodes, function (n) { return n.nodeType === 3; }).map(function (n) { return n.textContent; }).join(' ').trim().slice(0, 60); } catch (e) {}
    var r = { left: 0, top: 0, width: 0, height: 0 };
    try { r = el.getBoundingClientRect(); } catch (e) {}
    return { line: tag + id + cls + (own ? (' "' + own + '"') : ''), cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
}`;

/** Resolve a `>>>` selector across ALL shadow boundaries — OPEN, closed-programmatic, AND the declarative/native
 *  CLOSED roots the page's own JS (and our attachShadow capture) can NOT enter — using the CDP DOM domain, which
 *  pierces every boundary. This is the ONE thing page-world JS structurally can't do, and it's used ONLY when
 *  `firstHopSealed` confirmed a genuinely sealed host is in the path (never as a general query path). Walks the
 *  hops server-side: querySelectorAll each hop in its scope, and at a boundary descend into the host's shadow
 *  roots (describeNode `pierce` → the closed root's node → push it to the frontend so the next hop can query it).
 *  Each final match is resolved to a live JS handle (resolveNode) and callFunctionOn runs the describe fn ON it —
 *  so we get the element's real describe line + viewport centre for a coordinate click. Read-only: it never
 *  mutates; clicking is a SEPARATE cdpClick the caller makes with the returned centre. */
export async function cdpShadowResolve(tabId: number, selector: string, cap = 25): Promise<{ ok: true; matches: CdpShadowMatch[] } | { error: string; needsPermission?: true }> {
    const at = await ensureDebuggerAttached(tabId);
    if ("error" in at) return { error: at.error, ...(at.needsPermission ? { needsPermission: true } : {}) };
    const target: chrome.debugger.Debuggee = { tabId };
    const send = <T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> =>
        chrome.debugger.sendCommand(target, method, params) as Promise<T>;
    try {
        // getDocument (depth 0 — cheap) establishes the root node; querySelectorAll then resolves server-side
        // against the LIVE DOM (not the returned tree), so depth 0 is enough and we avoid shipping a huge tree.
        const doc = await send<{ root?: { nodeId?: number } }>("DOM.getDocument", { depth: 0 });
        const rootId = doc?.root?.nodeId;
        if (!rootId) return { error: "CDP couldn't read the document root." };
        const hops = String(selector).split(">>>").map(s => s.trim()).filter(Boolean);
        if (hops.length < 2) return { ok: true, matches: [] };   // no boundary to cross — not this resolver's job
        let scopes: number[] = [rootId];
        for (let i = 0; i < hops.length; i++) {
            const isLast = i === hops.length - 1;
            const next: number[] = [];
            for (const scope of scopes) {
                let nodeIds: number[] = [];
                try { ({ nodeIds = [] } = await send<{ nodeIds?: number[] }>("DOM.querySelectorAll", { nodeId: scope, selector: hops[i] })); } catch { /* hop invalid in this scope */ }
                if (isLast) { next.push(...nodeIds); continue; }
                // Not the last hop → each match is a HOST; descend into its shadow roots (open + closed).
                for (const hostId of nodeIds) {
                    let node: { shadowRoots?: { nodeId?: number; backendNodeId?: number }[] } | undefined;
                    try { ({ node } = await send<{ node?: typeof node }>("DOM.describeNode", { nodeId: hostId, depth: 0, pierce: true })); } catch { continue; }
                    for (const sr of node?.shadowRoots || []) {
                        let srId = sr.nodeId;
                        if (!srId && sr.backendNodeId != null) {
                            try { const pushed = await send<{ nodeIds?: number[] }>("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [sr.backendNodeId] }); srId = pushed?.nodeIds?.[0]; } catch { /* couldn't map → skip this root */ }
                        }
                        if (srId) next.push(srId);
                    }
                }
            }
            scopes = next;
            if (!scopes.length) break;
        }
        const matches: CdpShadowMatch[] = [];
        for (const nodeId of scopes.slice(0, cap)) {
            try {
                const { object } = await send<{ object?: { objectId?: string } }>("DOM.resolveNode", { nodeId });
                if (!object?.objectId) continue;
                const { result } = await send<{ result?: { value?: CdpShadowMatch } }>("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: CDP_SHADOW_DESC_FN, returnByValue: true });
                await send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => { /* best-effort */ });
                if (result?.value && typeof result.value.line === "string") matches.push(result.value);
            } catch { /* one node failed to resolve → skip it */ }
        }
        return { ok: true, matches };
    } catch (e) {
        return { error: `the CDP shadow resolve failed (${(e as Error)?.message || e}).` };
    } finally {
        touchDebugger(tabId);
    }
}

// A "virtual key code" for a character — good enough for letters/digits/space (games/streams read
// `key`/`keyCode`); punctuation falls back to the char code. Not a full keymap (that's `press`, later).
const vkFor = (ch: string): number => {
    if (/[a-z]/i.test(ch)) return ch.toUpperCase().charCodeAt(0);
    if (/[0-9]/.test(ch)) return ch.charCodeAt(0);
    if (ch === " ") return 32;
    return ch.charCodeAt(0) || 0;
};

/** Type `text` into the tab's CURRENT focus via CDP `Input.dispatchKeyEvent` — REAL (isTrusted) key events a
 *  canvas / WebGL / remote-desktop surface actually honours (synthetic KeyboardEvents don't fire their input
 *  paths / are dropped on `isTrusted`). One keyDown (carrying `text`, so the character is produced) + keyUp per
 *  char; a printable char also reaches a keydown-forwarding remote-desktop listener via `key`/`windowsVirtualKeyCode`.
 *  `submit` presses Enter after. The caller establishes focus first (a CDP click at an @pt, a resolved sealed
 *  field, or the ambient focus). Reuses the run's live attachment. */
export async function cdpKeyType(tabId: number, text: string, submit = false): Promise<{ ok: true } | { error: string; needsPermission?: true }> {
    const at = await ensureDebuggerAttached(tabId);
    if ("error" in at) return { error: at.error, ...(at.needsPermission ? { needsPermission: true } : {}) };
    const target: chrome.debugger.Debuggee = { tabId };
    const key = (params: Record<string, unknown>) => chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", params);
    try {
        for (const ch of String(text)) {
            const vk = vkFor(ch);
            // keyDown WITH `text` = the character is inserted (like a real keypress); keyUp completes the stroke.
            await key({ type: "keyDown", text: ch, key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
            await key({ type: "keyUp", key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        }
        if (submit) {
            await key({ type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
            await key({ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        }
        return { ok: true };
    } catch (e) {
        return { error: `the CDP type failed (${(e as Error)?.message || e}).` };
    } finally {
        touchDebugger(tabId);
    }
}
