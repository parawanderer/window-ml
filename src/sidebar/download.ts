// Handing the user a FILE, and nothing else — so that anything which needs to can reach it.
//
// This lived in export.ts, which is the right home for the run exports and the wrong one for a four-line
// helper: export.ts pulls in the Markdown/PDF/zip machinery and a highlighter stylesheet, so importing it to
// save a CSV drags a CSS file into a module that only wanted a Blob. (The unit tests load .tsx through Node
// directly rather than through esbuild, so that stylesheet arrives as a syntax error rather than as a bundle
// asset — which is how this was found.)

/** Hand the user a file. Used by the run exports (Markdown/JSON/PDF) and by the table view's "save CSV",
 *  where a table too large for the clipboard is still something you want out of the panel.
 *
 *  `<a download>` rather than anything cleverer because it is what works from inside the panel's frame, and
 *  the object URL is revoked on the next turn of the event loop — the click has already been dispatched by
 *  then, and holding it would pin the blob in memory for the life of the document. */
export function downloadBlob(name: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}
