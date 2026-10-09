// viewer.tsx — a run's page, opened over the dashboard rather than in place of it, and kept current while it runs.
//
// An iframe rather than the run's HTML injected: the run page is a complete document with its own stylesheet and a
// hundred runs of highlighted code have no business sharing a style scope with the dashboard. Plain clicks on an
// `a.view` open it here; cmd/ctrl/middle-click fall through to the browser, so "open in a new tab" keeps working.
//
// LIVE IS TRANSPORT, NOT RENDERING. A run's page is one static file the harness rewrites on every event, so the open
// viewer only has to notice that its run moved and reload it: there is no second, live renderer to drift from the saved
// one. Driven by the pushed state, so a saved report.html (no stream) never reloads, and throttled to one reload per
// 1.5 s while a run emits several events a second.

import { useEffect, useRef, useState } from "preact/hooks";
import type { BenchState } from "./state";

type Open = { href: string; title: string };

/** The signature of what a run's page shows: when it changes, the page on disk has been rewritten. */
const sigOf = (s: BenchState, path: string, base: string): string | null => {
    const r = s.runs.find((x) => x.path && path.startsWith(base + encodeURI(x.path) + "/"));
    return r ? [r.state, r.steps, r.live?.step, r.live?.tool, r.live?.last, r.turns?.length].join("|") : null;
};

export function Viewer({ s, base, live }: { s: BenchState | null; base: string; live: boolean }) {
    const [open, setOpen] = useState<Open | null>(null);
    const frame = useRef<HTMLIFrameElement>(null);
    const seen = useRef<{ sig: string | null; at: number; timer?: ReturnType<typeof setTimeout> }>({ sig: null, at: 0 });

    useEffect(() => {
        const onClick = (e: MouseEvent) => {
            const a = (e.target as Element).closest?.("a.view") as HTMLAnchorElement | null;
            if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            seen.current = { sig: null, at: 0 };
            setOpen({ href: a.href, title: a.dataset.title || "run" });
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
        document.addEventListener("click", onClick);
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("click", onClick); document.removeEventListener("keydown", onKey); };
    }, []);

    // Reload the open page when its run moves, keeping the reader's place (or the bottom, if they were following it).
    useEffect(() => {
        if (!open || !live || !s) return;
        const sig = sigOf(s, new URL(open.href).pathname, base);
        const v = seen.current;
        if (sig == null) return;
        if (v.sig == null) { v.sig = sig; return; }   // the page just opened is already current
        if (sig === v.sig) return;
        v.sig = sig;
        clearTimeout(v.timer);
        v.timer = setTimeout(() => {
            const f = frame.current;
            if (!f) return;
            v.at = Date.now();
            let y = 0, atEnd = false;
            try { const w = f.contentWindow!, d = w.document.scrollingElement!; y = w.scrollY; atEnd = y + w.innerHeight >= d.scrollHeight - 4; } catch { /* not loaded */ }
            f.addEventListener("load", () => {
                try { const w = f.contentWindow!; w.scrollTo(0, atEnd ? w.document.scrollingElement!.scrollHeight : y); } catch { /* gone */ }
            }, { once: true });
            try { f.contentWindow!.location.reload(); } catch { f.src = open.href; }
        }, Math.max(0, v.at + 1500 - Date.now()));
    }, [s, open]);

    if (!open) return null;
    return (
        <div class="modal" onClick={(e) => { if (e.target === e.currentTarget) setOpen(null); }}>
            <div class="card sheet">
                <header>
                    <h3 class="otitle">{open.title}</h3><span class="sp" />
                    <a class="btn small" href={open.href} target="_blank" rel="noopener">open ↗</a>
                    <button class="btn small" aria-label="Close" onClick={() => setOpen(null)}>✕</button>
                </header>
                <iframe ref={frame} title="run" src={open.href} />
            </div>
        </div>
    );
}
