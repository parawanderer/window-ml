// sw-offscreen.ts — the extension's ONE offscreen document, created lazily and reused. A service worker cannot run
// WASM, start a dedicated worker or parse HTML, so what needs one of those lives there: the Python sandbox
// (python_exec), the session archive's SQLite, the WebP encoder that shrinks saved screenshots, and HTML→Markdown for a fetch the worker makes. Chrome allows one
// offscreen document per extension, so they share it rather than each creating its own.

let offscreenReady: Promise<void> | null = null;

/** Drop the cached "the offscreen document exists", so the next call creates it again: it was torn down. */
export function forgetOffscreen(): void {
    offscreenReady = null;
}

/** The one offscreen document, created once: it hosts the Python sandbox's worker and the session archive's. */
export function ensureOffscreen(): Promise<void> {
    if (offscreenReady) return offscreenReady;
    offscreenReady = (async () => {
        if (await chrome.offscreen.hasDocument?.()) return;
        try {
            await chrome.offscreen.createDocument({
                url: "offscreen.html",
                reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.DOM_PARSER],
                justification: "Runs the sandboxed Python (Pyodide/WASM) for python_exec, the SQLite session archive and the WebP compression of saved screenshots, and converts fetched HTML to Markdown.",
            });
        } catch (e) {
            if (!(await chrome.offscreen.hasDocument?.())) throw e;   // tolerate a concurrent create
        }
    })();
    offscreenReady.catch(() => { offscreenReady = null; });   // let a failed create be retried
    return offscreenReady;
}

/**
 * A fetched HTML body as Markdown, converted in the offscreen document (the converter needs a DOM, which a worker has
 * not). The same converter the page uses, so a fetch the worker makes reads like one the page made.
 * @param html the raw HTML
 * @returns the Markdown, or undefined when it could not be converted (callers fall back to the text)
 */
export async function htmlToMarkdownOffscreen(html: string): Promise<string | undefined> {
    // Any failure (no offscreen document, a converter error) leaves `.markdown` unset, as on the page.
    const r = await ensureOffscreen().then(() => chrome.runtime.sendMessage({ type: "HTML_TO_MD", html })).catch(() => null) as { markdown?: unknown } | null;
    return typeof r?.markdown === "string" ? r.markdown : undefined;
}
