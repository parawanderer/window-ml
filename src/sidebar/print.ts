// Standalone print tab for PDF export. The sidebar app can't print its own doc reliably: window.print()
// is SUPPRESSED for a frame inside DOCKED DevTools (the panel surface), so exporting a PDF there did
// nothing. A normal top-level browser tab prints fine, so `printSession` routes the rendered doc through
// the background (works from BOTH the overlay and the DevTools panel), which opens THIS page in a tab keyed
// by `?k=`. We fetch the doc from the background, drop it into an iframe, print THAT iframe (its <title>
// seeds the "Save as PDF" filename, matching the .md base name), and close the tab afterwards.
const k = new URLSearchParams(location.search).get("k") || "";
const frame = document.getElementById("doc") as HTMLIFrameElement | null;

// Close our own tab once printing is done. The background removes it by sender.tab.id (reliable);
// window.close() is a belt-and-suspenders that also works for an extension-origin tab.
function closeSelf(): void {
    try { chrome.runtime.sendMessage({ type: "CLOSE_PRINT_TAB" }); } catch { /* SW asleep — the tab just lingers, harmless */ }
    try { window.close(); } catch { /* blocked in some contexts — the CLOSE_PRINT_TAB above covers it */ }
}

if (!frame || !k) {
    document.title = "Nothing to print";
} else {
    chrome.runtime.sendMessage({ type: "GET_PRINT_DOC", k }, (resp: { html?: string | null } | undefined) => {
        const html = resp && resp.html;
        if (!html) { document.title = "Nothing to print"; return; }
        frame.onload = () => {
            const w = frame.contentWindow;
            if (!w) { closeSelf(); return; }
            w.addEventListener("afterprint", closeSelf);   // fires on Save AND Cancel
            // A tick after load so layout (images are inline data: URIs) settles before the preview snapshots.
            setTimeout(() => { try { w.focus(); w.print(); } catch { closeSelf(); } }, 50);
        };
        frame.srcdoc = html;
    });
}
