// print-frame.ts — printing a self-contained document from an offscreen iframe, for the surfaces that can.

// Print the session → the user chooses "Save as PDF" (or a real printer). We
// render into an offscreen iframe rather than printing the sidebar itself: the
// panel is a narrow dark scroll-box with collapsed disclosures, none of which
// belongs on paper. The doc is loaded from a Blob URL (a multi-megabyte srcdoc
// attribute of inlined screenshots is wasteful) — same-origin, so we can reach
// contentWindow.print(). Chrome's print() blocks until the dialog closes, but we
// clean up on `afterprint` (plus a long fallback) so a dismissed dialog can't
// leak the frame either way.
const PRINT_CLEANUP_MS = 120_000;

// The legacy in-frame print — render the doc into an offscreen iframe and print it. Works in the in-page
// overlay and an UNDOCKED DevTools window; kept as a fallback for when the background channel is absent.
export function printInFrame(html: string): void {
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const frame = document.createElement("iframe");
    frame.className = "printframe";
    frame.setAttribute("aria-hidden", "true");
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        frame.remove();
        URL.revokeObjectURL(url);
    };
    frame.onload = () => {
        const w = frame.contentWindow;
        if (!w) { cleanup(); return; }
        setTimeout(cleanup, PRINT_CLEANUP_MS);
        w.addEventListener("afterprint", cleanup);
        try { w.focus(); w.print(); } catch { cleanup(); }
    };
    frame.src = url;
    document.body.append(frame);
}
