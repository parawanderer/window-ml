// Outbound-fetch layer for the service worker — the credentialed/uncredentialed GETs behind ml.fetch, the
// rendered (JS-executing) fetch, and the Google Sheets CSV pull for python_exec. Extracted from background.ts
// verbatim. This is where the security-sensitive fetch guards live co-located: SHEET_URL_OK hard-locks the
// CREDENTIALED sheet fetch to the docs.google.com export endpoint (the raw FETCH_SHEET message is page-
// reachable, so without it it's a cookie-authenticated read-any-URL exfil primitive), and only a safelisted,
// non-auth subset of response headers is ever surfaced. Callers gate approval upstream (injected.ts); these
// functions assume the decision was already made.
import type { FetchResult } from "./contract";
import { acceptLanguageFrom } from "./contract";
import { classifyContent, jsonShape } from "./dom";
import { ensureDebuggerAttached, releaseDebugger } from "./sw-cdp";
import { incognitoEnableSteps } from "./util";

// ---- Google Sheets CSV fetch (python_exec `sheet`) ----
// Fetch the sheet's CSV export with the user's own cookies (credentials:"include"), so a
// PRIVATE sheet they can see works — the page DOM can't (Sheets renders to canvas). If they
// aren't signed in / lack access, Google redirects the export to an HTML login page instead
// of CSV; detect that and return an actionable error the model relays to the user.
// Only a Google Sheets CSV-export URL may be fetched here. This is the ONLY defense against a
// hostile page: the approval gate lives client-side (injected.ts), but the raw FETCH_SHEET message
// is reachable by any page via the content-script relay, and this fetch is CREDENTIALED — without
// this check it's a cookie-authenticated "read any URL" (SSRF/exfil) primitive. Confine it to the
// docs.google.com export endpoint; Google's own redirects (login/large-file) are still followed.
export const SHEET_URL_OK = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+\/export\?/;

// The sheet's TITLE from the export's Content-Disposition ("Name - Tab.csv" → "Name"). Shared by the
// full CSV fetch and the title-only HEAD (approval chip). A background fetch with host permission reads
// all headers (no CORS limit). null on a missing/garbled header.
export function sheetNameFromDisposition(cd: string | null): string | null {
    try {
        // PREFER filename* (RFC 5987, UTF-8 %-encoded → keeps spaces) over the ASCII `filename=`
        // fallback, which Google SPACE-STRIPS ("quarterly sales" → "quarterlysales"). Google sends both;
        // the plain one appears first, so a naive left-to-right match picks the wrong (stripped) one.
        const star = /filename\*=(?:[^']*'')?([^;]+)/i.exec(cd || "");
        const plain = /filename="?([^";]+)"?/i.exec(cd || "");
        const enc = star ? star[1].trim() : (plain ? plain[1].trim() : "");
        if (!enc) return null;
        const fn = star ? decodeURIComponent(enc) : enc;   // only filename* is %-encoded
        // "<Spreadsheet> - <Tab>.csv" → the SPREADSHEET name. Strip the LAST "-<tab>" segment (spaces
        // around the dash optional — Google's filename separator varies), keeping earlier dashes.
        return fn.replace(/\.csv$/i, "").replace(/\s*-\s*[^-]*$/, "").trim() || null;
    } catch { return null; }
}

// The largest body ml.fetch keeps. `ml.fetch()` is meant to feed CODE (parse a whole JSON/CSV/source file
// in `exec`/`python_exec`), so it must NOT truncate at a small context-sized cap — the model-facing DISPLAY
// is clipped separately (the fetch_url tool's clipOut, and exec/python's own output clip), so this bound is
// only a memory/message-channel safety net for a pathologically huge response, set well above realistic files.
const FETCH_URL_MAX = 8_000_000;
/** Browser-IDENTITY request headers for ml.fetch, so a fetch acts like the user's own browser rather than a
 *  bare programmatic request — many sites (GitHub's "Whoa there!" abuse page) block the latter's tell-tale
 *  missing headers. This sends the browser's PUBLIC identity (its real User-Agent + Accept-Language), NOT the
 *  user's private data: no cookies here (those ride only the gated `credentials:"include"` path). We set only
 *  headers `fetch` actually lets us override — `Sec-Fetch-*`/`Origin`/`Referer`/`Cookie` are browser-controlled
 *  (forbidden header names) and left untouched; `Accept`/`Accept-Language` are CORS-safelisted, and modern
 *  Chrome allows overriding `User-Agent`. */
function browserFetchHeaders(): Record<string, string> {
    // HTML/XML first like a browser, but welcome JSON/anything — ml.fetch reads APIs too.
    const h: Record<string, string> = { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8" };
    try { if (typeof navigator !== "undefined" && navigator.userAgent) h["User-Agent"] = navigator.userAgent; } catch { /* no navigator → skip */ }
    try {
        const langs = typeof navigator !== "undefined"
            ? (navigator.languages && navigator.languages.length ? [...navigator.languages] : [navigator.language])
            : [];
        const al = acceptLanguageFrom(langs.filter(Boolean) as string[]);
        if (al) h["Accept-Language"] = al;
    } catch { /* skip */ }
    return h;
}
/** Perform the actual GET for ml.fetch (host permissions bypass CORS). Uncredentialed (no cookies) unless
 *  `credentials` is set — then it sends the user's cookies (the gated as-you path). Classifies the body by
 *  header AND content (a server can mislabel), pre-parses JSON, and caps the size. Throws on a
 *  network/permission failure (the handler turns that into an actionable message). */
// Pull ONLY the safelisted, non-sensitive response headers into FetchResult.headers. A SAFELIST (not a
// denylist) is definitive: an auth-bearing header (Cookie/Set-Cookie/Authorization/WWW-Authenticate/CSRF/API-
// key/…) is simply never read, so a fetch can never surface the user's session. Absent headers are omitted.
function safeResponseHeaders(h: Headers): NonNullable<FetchResult["headers"]> | undefined {
    const map: [keyof NonNullable<FetchResult["headers"]>, string][] = [
        ["link", "link"], ["etag", "etag"], ["lastModified", "last-modified"], ["retryAfter", "retry-after"],
        ["contentLength", "content-length"], ["contentDisposition", "content-disposition"],
        ["cacheControl", "cache-control"], ["date", "date"],
    ];
    const out: NonNullable<FetchResult["headers"]> = {};
    let any = false;
    for (const [field, name] of map) { const v = h.get(name); if (v != null) { out[field] = v; any = true; } }
    return any ? out : undefined;
}
export async function fetchUrlContent(url: string, credentials = false): Promise<FetchResult> {
    // `credentials:"include"` sends the user's cookies (authenticated fetch — gated + one-time upstream);
    // default `"omit"` reads only public bytes. Browser-identity headers either way (see browserFetchHeaders).
    const res = await fetch(url, { method: "GET", credentials: credentials ? "include" : "omit", redirect: "follow", headers: browserFetchHeaders() });
    const contentType = res.headers.get("content-type") || "";
    let text = await res.text();
    const truncated = text.length > FETCH_URL_MAX;
    if (truncated) text = text.slice(0, FETCH_URL_MAX);
    const { type, language, byHeader, byContent, byExtension } = classifyContent(contentType, text, url);
    const out: FetchResult = {
        url: res.url || url, status: res.status, ok: res.ok, type, language,
        typeByHeader: byHeader, typeByContent: byContent, typeByExtension: byExtension, contentType, text,
        truncated: truncated || undefined, redirected: res.redirected || undefined,
        headers: safeResponseHeaders(res.headers),
    };
    // Pre-parse JSON only when it's whole — a truncated body can't parse. (type stays "json" so the agent knows.)
    // A parsed value also gets a compact TS-like `schema` (jsonShape) so the model can see the structure
    // without the whole payload — on the return object, and the tool can prefer it.
    if (type === "json" && !truncated) {
        try { out.json = JSON.parse(text); out.schema = jsonShape(out.json); } catch { /* mislabelled → leave as text */ }
    }
    return out;
}

const RENDER_LOAD_TIMEOUT_MS = 15_000;   // max wait for the background tab to reach "complete" before snapshotting anyway
const RENDER_QUIET_MS = 700;             // the DOM must be UNCHANGED this long to count as "settled" (network-idle proxy)
const RENDER_SETTLE_MAX_MS = 7_000;      // …but never wait longer than this for quiet (a page that never stops mutating)
const RENDER_POLL_MS = 250;              // how often to re-measure the DOM while waiting for quiet
/** Poll the rendered page until its DOM stops growing (a network-idle proxy: deferred fetches / lazy widgets
 *  land, THEN the size holds), bounded by `RENDER_SETTLE_MAX_MS`. First scrolls to the bottom to trip
 *  viewport-lazy loads (IntersectionObserver `<include-fragment loading="lazy">` etc.), then back to the top so
 *  the snapshot reads naturally. Best-effort; a broken poll just ends the wait. Beats a fixed delay for a slow
 *  SPA (waits as long as it needs) AND a fast page (stops early once quiet). */
async function settleRender(tabId: number): Promise<void> {
    const measure = async (): Promise<number> => {
        try { const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.body?.innerHTML.length || 0 }); return (r?.result as number) || 0; }
        catch { return -1; }   // page gone / not scriptable → signal "stop"
    };
    // Scroll pass — trip anything that lazy-loads on entering the viewport, then return to the top.
    try { await chrome.scripting.executeScript({ target: { tabId }, func: () => { try { window.scrollTo(0, document.body?.scrollHeight || 0); } catch { /* ignore */ } } }); } catch { /* ignore */ }
    const start = Date.now();
    let last = -1, quietSince = 0;
    while (Date.now() - start < RENDER_SETTLE_MAX_MS) {
        await new Promise((r) => setTimeout(r, RENDER_POLL_MS));
        const len = await measure();
        if (len < 0) break;                                   // page unscriptable → snapshot whatever's there
        if (len === last) { if (!quietSince) quietSince = Date.now(); if (Date.now() - quietSince >= RENDER_QUIET_MS) break; }
        else { last = len; quietSince = 0; }
    }
    try { await chrome.scripting.executeScript({ target: { tabId }, func: () => { try { window.scrollTo(0, 0); } catch { /* ignore */ } } }); } catch { /* ignore */ }
}
/** Make a backgrounded/minimized render tab BELIEVE it's foregrounded, via CDP — so focus/visibility-gated
 *  deferred loads (a background tab reports `document.hidden`, `hasFocus()===false`, and throttles timers;
 *  GitHub's release widgets and many SPAs skip work then) still fire, WITHOUT stealing the user's real focus.
 *  Gated on the `cdp` setting + the debugger permission; best-effort (any failure leaves the render as-is).
 *  Returns whether the debugger was attached, so the caller detaches it. */
async function emulateForeground(tabId: number): Promise<boolean> {
    const at = await ensureDebuggerAttached(tabId);
    if (!("ok" in at)) return false;
    try {
        await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });   // hasFocus()=true, focus events fire
        try { await chrome.debugger.sendCommand({ tabId }, "Page.setWebLifecycleState", { state: "active" }); } catch { /* not on every build */ }   // visibilityState=visible, not throttled
    } catch { /* best-effort */ }
    return true;
}
/** Resolve when tab `tabId` finishes loading (status "complete"), or after `timeoutMs` — whichever first, so a
 *  page that never fully settles still gets snapshotted. Best-effort; never rejects. */
function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (): void => { if (done) return; done = true; try { chrome.tabs.onUpdated.removeListener(onUpd); } catch { /* ignore */ } clearTimeout(timer); resolve(); };
        const onUpd = (id: number, info: { status?: string }): void => { if (id === tabId && info.status === "complete") finish(); };
        chrome.tabs.onUpdated.addListener(onUpd);
        const timer = setTimeout(finish, timeoutMs);
        chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") finish(); }).catch(() => finish());
    });
}
/** Runs IN the rendered page (serialized by executeScript — MUST be self-contained, no outer refs). Strips the
 *  junk overlays a live SPA renders — cookie/consent banners, ad interstitials, newsletter/paywall modals —
 *  BEFORE snapshotting, so the returned DOM (→ Markdown) is the real content, not the popup slop. Conservative:
 *  only removes fixed/sticky/absolute-positioned nodes that either match a cookie/ad keyword or are a
 *  high-z-index viewport-covering backdrop, and NEVER a node that holds the bulk of the page's text (so it
 *  can't nuke a full-screen app shell). Best-effort; a failure just leaves the DOM untouched. */
function renderSnapshot(): { html: string; href: string } {
    try {
        // STRONG cues → remove on sight; WEAK cues (broader, more false-positive-prone) → only when the node is
        // small (a banner/modal, not a content region). Matched against id/class/aria/data of positioned nodes.
        const STRONG = /cookie|consent|gdpr|ccpa|onetrust|cookiebot|truste|didomi|usercentric|paywall|newsletter|subscribe|interstitial|advert|sponsor|\bad[-_]/i;
        const WEAK = /modal|popup|pop-up|overlay|backdrop|banner|lightbox|dialog|notice|gate|promo/i;
        const vw = window.innerWidth || 1024, vh = window.innerHeight || 768, area = vw * vh || 1;
        const bodyLen = ((document.body && document.body.textContent) || "").trim().length || 1;
        const kill: Element[] = [];
        const all = document.body ? document.body.getElementsByTagName("*") : ([] as unknown as HTMLCollectionOf<Element>);
        for (const el of Array.from(all)) {
            let cs: CSSStyleDeclaration;
            try { cs = getComputedStyle(el); } catch { continue; }
            const pos = cs.position;
            if (pos !== "fixed" && pos !== "sticky" && pos !== "absolute") continue;
            if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
            const cnRaw = (el as HTMLElement).className;
            const cn = typeof cnRaw === "string" ? cnRaw : ((cnRaw as unknown as { baseVal?: string })?.baseVal || "");
            const tag = `${el.id} ${cn} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-testid") || ""}`.toLowerCase();
            const txtLen = (el.textContent || "").trim().length;
            if (txtLen > bodyLen * 0.6) continue;   // this node IS most of the page → it's content, never an overlay
            const r = el.getBoundingClientRect();
            const covers = r.width * r.height > area * 0.5;
            const z = parseInt(cs.zIndex) || 0;
            const strong = STRONG.test(tag);
            const weakSmall = WEAK.test(tag) && txtLen < 1500;
            const backdrop = pos === "fixed" && covers && z >= 100 && txtLen < 2000;
            if (strong || weakSmall || backdrop) kill.push(el);
        }
        for (const el of kill) { try { el.remove(); } catch { /* already gone */ } }
        // Overlays often lock body scroll — irrelevant to the text grab, but tidy up so nothing looks frozen.
        try { document.documentElement.style.overflow = ""; if (document.body) document.body.style.overflow = ""; } catch { /* ignore */ }
    } catch { /* leave the DOM as-is on any failure */ }
    // Prune NON-VISIBLE elements so the markdown reflects what the page actually SHOWS. Rendered runs in a live
    // tab WITH LAYOUT, so `checkVisibility()` is real here (a raw fetch has no layout). This kills the hidden
    // fallback slots frameworks SSR but never reveal — e.g. GitHub's `<div data-show-on-forbidden-error hidden>`
    // "Uh oh!"/"Sorry, something went wrong" blocks that otherwise pollute the output. Off-screen / below-the-fold
    // content STAYS (checkVisibility is about display/visibility/hidden/content-visibility, not viewport position),
    // so a scrolled-past widget isn't lost. Top-down: a hidden node is removed WITHOUT descending (its subtree is
    // hidden too), which also bounds the cost. Best-effort per node.
    try {
        const isVisible = (el: Element): boolean => {
            try {
                const cv = (el as unknown as { checkVisibility?: (o?: unknown) => boolean }).checkVisibility;
                if (typeof cv === "function") return cv.call(el, { contentVisibilityAuto: true, visibilityProperty: true });
            } catch { /* fall through to the manual check */ }
            try {
                if ((el as HTMLElement).hidden) return false;
                const cs = getComputedStyle(el);
                return cs.display !== "none" && cs.visibility !== "hidden";
            } catch { return true; }   // can't tell → keep it
        };
        const prune = (root: Element): void => {
            for (const el of Array.from(root.children)) {
                if (!isVisible(el)) { try { el.remove(); } catch { /* gone */ } continue; }
                prune(el);
            }
        };
        if (document.body) prune(document.body);
    } catch { /* leave the DOM as-is on any failure */ }
    return { html: (document.documentElement && document.documentElement.outerHTML) || "", href: location.href };
}
/** True iff the extension is allowed to run in Incognito (the user's "Allow in Incognito" toggle). Off by
 *  default — an uncredentialed rendered fetch needs it, so we check and give an actionable error when it's off. */
function isIncognitoAllowed(): Promise<boolean> {
    return new Promise((res) => { try { chrome.extension.isAllowedIncognitoAccess((a) => res(!!a)); } catch { res(false); } });
}
/** RENDERED fetch: open the URL in a background tab/window so the page's JavaScript runs (client-rendered / SPA
 *  content a raw GET can't see), let it settle, snapshot the LIVE DOM (overlays stripped — see renderSnapshot),
 *  then ALWAYS close it. Two modes, chosen upstream by whether the caller asked for the user's session:
 *   · incognito=TRUE  → an INCOGNITO window: NO session (fresh, cookie-less). Less risky (no reused auth) → the
 *                       gate is the rememberable uncredentialed consent. Needs "Allow in Incognito".
 *   · incognito=FALSE → a normal background tab: carries the user's session (cookies). Credentialed-weight
 *                       (one-time grant, always-prompt). The snapshot HTML flows through the same
 *                       classify + HTML→Markdown path as a raw fetch either way. */
export async function fetchRenderedContent(url: string, incognito: boolean, cdp: boolean): Promise<FetchResult> {
    let tabId: number | undefined;
    let windowId: number | undefined;   // set on the incognito path — we remove the whole (minimized) window
    let emulated = false;               // did we attach the debugger for focus/visibility emulation?
    if (incognito) {
        if (!(await isIncognitoAllowed())) {
            throw new Error(`A private (no-session) rendered fetch needs the extension enabled in Incognito, which is OFF — the browser won't let the extension flip it, so TELL THE USER exactly how: ${incognitoEnableSteps(undefined, chrome.runtime.id)} The toolbar popup's Permissions → "Incognito rendering" also opens that page for them. OR pass credentials:true to render with the user's NORMAL session instead (no Incognito needed).`);
        }
        let win: chrome.windows.Window | undefined;
        try { win = await chrome.windows.create({ url, incognito: true, focused: false, state: "minimized" }); }
        catch (e) { throw new Error(`Couldn't open a private window to render "${url}" (${(e as Error)?.message || e}). Incognito may be disabled by policy.`); }
        windowId = win?.id;
        tabId = win?.tabs?.[0]?.id;
    } else {
        let tab: chrome.tabs.Tab;
        try { tab = await chrome.tabs.create({ url, active: false }); }
        catch (e) { throw new Error(`Couldn't open a background tab to render "${url}" (${(e as Error)?.message || e}).`); }
        tabId = tab.id;
    }
    if (tabId == null) throw new Error(`Couldn't open a ${incognito ? "private " : ""}tab to render "${url}".`);
    try {
        // Before the deferred/lazy widgets fire, make the (backgrounded/minimized) tab believe it's foregrounded
        // so focus/visibility-gated loads run — only when the user enabled CDP (it attaches the debugger).
        if (cdp) { try { emulated = await emulateForeground(tabId); } catch { /* best-effort */ } }
        await waitForTabComplete(tabId, RENDER_LOAD_TIMEOUT_MS);
        await settleRender(tabId);   // scroll pass + wait for the DOM to go quiet (network-idle proxy)
        let injected: chrome.scripting.InjectionResult[] | undefined;
        try {
            injected = await chrome.scripting.executeScript({ target: { tabId }, func: renderSnapshot });
        } catch (e) {
            throw new Error(`Rendered fetch couldn't read "${url}" (${(e as Error)?.message || e}). The extension may lack access to this site (grant "On all sites" in site access), or the page blocked extension scripting.`);
        }
        const r = injected?.[0]?.result as { html?: string; href?: string } | undefined;
        let text = r?.html || "";
        const finalUrl = r?.href || url;
        const truncated = text.length > FETCH_URL_MAX;
        if (truncated) text = text.slice(0, FETCH_URL_MAX);
        const { type, language, byHeader, byContent, byExtension } = classifyContent("text/html", text, finalUrl);
        return {
            url: finalUrl, status: 200, ok: true, type, language,
            typeByHeader: byHeader, typeByContent: byContent, typeByExtension: byExtension,
            contentType: "text/html", text,
            truncated: truncated || undefined, redirected: (finalUrl !== url) || undefined, rendered: true,
        };
    } finally {
        if (emulated && tabId != null) releaseDebugger(tabId);   // detach the render-tab debugger before we close it
        if (windowId != null) { try { await chrome.windows.remove(windowId); } catch { /* already closed */ } }
        else if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch { /* already closed */ } }
    }
}

export async function fetchSheetCsv(url: string): Promise<{ csv: string; name: string | null }> {
    if (!url) throw new Error("No sheet URL.");
    if (!SHEET_URL_OK.test(url)) throw new Error("Refused: only Google Sheets CSV-export URLs can be fetched here.");
    let res: Response;
    try { res = await fetch(url, { credentials: "include", redirect: "follow" }); }
    catch (e: any) {
        // A network throw here is usually the extension's SERVICE-WORKER host access being WITHHELD:
        // "On click" grants activeTab (content scripts on the tab) but NOT the background fetch's
        // host permission, so the CSV fetch is unauthorized even while you're ON the sheet. And the
        // export can REDIRECT (login → accounts.google.com; big files → *.googleusercontent.com), so
        // whitelisting only docs.google.com can still fail on the hop → recommend "On all sites".
        // The popup's "Enable Google Sheets access" button requests these persistently in one click.
        let granted = true;
        try { granted = await chrome.permissions.contains({ origins: ["https://docs.google.com/*"] }); } catch { /* older Chrome → assume granted, fall through to the generic error */ }
        if (!granted) {
            // Nudge the user straight to the one-click grant: pop the toolbar popup, where the
            // "Permissions → Enable" button lives. Best-effort — openPopup needs a focused window
            // and is Chrome 127+, so tolerate a throw; the message below still guides them.
            try { await (chrome.action as any).openPopup?.(); } catch { /* no gesture / unsupported → rely on the message */ }
            throw new Error(
                "Can't fetch this Google Sheet — the extension has no host access to docs.google.com (\"On click\" " +
                "site access lets it run on the page but NOT make the background request that pulls the CSV). " +
                "Tell the USER: I've opened this extension's toolbar popup — under \"Permissions\", click \"Enable " +
                "Google Sheets access\" (one click). If it didn't open, click the extension's icon in the browser " +
                "toolbar and do the same. (Or: the browser's Extensions manager → this extension → \"Site access\" " +
                "→ \"On all sites\", recommended since the export can redirect across Google domains.) Then have them " +
                "ask me to try again. It's a browser permission, not a Google login."
            );
        }
        throw new Error(`Couldn't reach the sheet (${e?.message || e}).`);
    }
    const body = await res.text();
    const ct = res.headers.get("content-type") || "";
    if (!res.ok || /text\/html/i.test(ct) || /^﻿?\s*<(!doctype|html)\b/i.test(body)) {
        throw new Error(
            "Not signed in to Google, or no access to this sheet. Tell the USER to open the " +
            "sheet's link in this browser, sign in (or request access), then ask you to try again."
        );
    }
    return { csv: body, name: sheetNameFromDisposition(res.headers.get("content-disposition")) };
}
