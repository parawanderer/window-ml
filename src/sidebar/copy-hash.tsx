// copy-hash.tsx — click-to-copy: the clipboard helpers and the short `Hash` chip, apart from ui-kit so a page with no panel
// (the bench's) renders the same chip.

import { useState } from "preact/hooks";
import { HASH_SHOWN } from "../contract/contract-run";

// Copy to clipboard. Falls back to execCommand when the async Clipboard API is
// unavailable (http pages) OR blocked — a host page's Permissions-Policy can
// withhold clipboard-write from our iframe even though the API exists, so we
// also catch a rejection, not just an absent API.
export function execCopy(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
        try {
            const ta = document.createElement("textarea");
            ta.value = text; ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
            document.body.appendChild(ta); ta.focus(); ta.select();
            const ok = document.execCommand("copy"); ta.remove();
            ok ? resolve() : reject(new Error("execCommand copy failed"));
        } catch (e) { reject(e); }
    });
}

/** Copy to the clipboard, tolerantly — see execCopy for why a rejection matters as much as a missing API. */
export function copyText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => execCopy(text));
    return execCopy(text);
}

// "copied!" feedback that reverts after a moment.
export function useCopy(): { copied: boolean; copy: (text: string) => void } {
    const [copied, setCopied] = useState(false);
    const copy = (text: string) =>
        copyText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
    return { copied, copy };
}

// A short hash rendered as click-to-copy, with a tooltip. `stop` swallows the
// click so copying a hash inside a session row doesn't also open the session.
export function Hash({ hash, stop }: { hash: string; stop?: boolean }) {
    const { copied, copy } = useCopy();
    // SHOWN short, COPIED whole — git's arrangement, and for git's reason: the identifier is long enough not to
    // collide over an archive's lifetime, and a name you might read out is short. What the click puts on the
    // clipboard is the real one, so a copied hash always resumes.
    const shown = hash.slice(0, HASH_SHOWN);
    return (
        <span class="tt">
            <code class="hash copyable" onClick={(e) => { if (stop) e.stopPropagation(); copy(hash); }}>{shown}</code>
            <span class="tt-pop" role="tooltip">{copied ? "copied!" : hash.length > shown.length ? `click to copy ${hash}` : "click to copy"}</span>
        </span>
    );
}
