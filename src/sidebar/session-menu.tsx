// session-menu.tsx — the sidebar detail view's per-session "⋮": the chat page's `SessionActions`, over a ChatStore this frame leases.
//
// docs/spec/SESSION_SUMMARY.md, "Where it opens". The sidebar works off `sessionMap`, which has no index row and sends
// no session commands; the actions (pin, rename, look, delete, summary) are the chat page's, over a `ChatStore`. One
// list of actions is the point, so this frame opens the same store the chat page does, through `services()` (a view
// never calls `chrome.*`), and closes it when the last detail header that holds it goes.

import { useEffect, useRef, useState } from "preact/hooks";
import { ChatStore } from "../chat/chat-store";
import { LocalHost } from "../chat/local-host";
import { DeleteConfirm, RenameDialog, SessionActions } from "../chat/row-menu";
import { SessionSummaryDialog } from "../chat/session-summary";
import { IconMore } from "./icons";
import { bareHash, services } from "./services";
import { useDismissAt } from "./use-dismiss";

// state: plumbing — the frame's one leased store over the sessions port, and how many headers hold it
let lease: { store: ChatStore; host: LocalHost; holders: number } | null = null;

/** Take the frame's session store, opening its port on the first holder; null where the surface opens none. */
export function acquireSessionStore(): ChatStore | null {
    if (lease) { lease.holders++; return lease.store; }
    const connect = services().connectSessions;
    if (!connect) return null;
    const host = new LocalHost(connect);
    const store = new ChatStore(host);
    store.start();
    lease = { store, host, holders: 1 };
    return store;
}

/** Give the store back; the last holder closes the port, so an idle sidebar keeps no sessions port open. */
export function releaseSessionStore(): void {
    if (!lease || --lease.holders > 0) return;
    lease.store.dispose();
    lease.host.dispose();
    lease = null;
}

/** How many headers hold the leased store, and whether its port is open: for a test. */
export function sessionLease(): { holders: number } | null {
    return lease ? { holders: lease.holders } : null;
}

/** The leased store for as long as the calling component is mounted. */
function useSessionStore(): ChatStore | null {
    const [store] = useState(acquireSessionStore);
    useEffect(() => () => { if (store) releaseSessionStore(); }, []);
    return store;
}

/**
 * The detail header's `⋮`: what can be done to the session open in the view, the same rows as a chat-page row's menu,
 * and the dialogs those rows open. Draws NOTHING until the index has this session on this browser's runtime: a
 * session the worker no longer lists has nothing to act on.
 * @param hash the detail view's session (bare, or `runtime:hash`)
 * @gallery none needs the worker's sessions port; the rows are `SessionActions`, drawn in the chat page's gallery entries
 */
export function DetailSessionMenu({ hash }: { hash: string }) {
    const store = useSessionStore();
    const [open, setOpen] = useState(false);
    const wrap = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: Event) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
    }, [open]);
    const { at: shown, closing } = useDismissAt(open ? true : null);
    if (!store) return null;
    const bare = bareHash(hash);
    const s = [...store.index.value.values()].find((x) => x.id.hash === bare && store.isLocal(x.id.runtime));
    const rt = s ? store.runtime(s.id.runtime) : undefined;
    return (
        <>
            {s && rt ? (
                <span class="menuwrap" ref={wrap}>
                    <button class={`tt hbtn${open ? " on" : ""}`} aria-label="Session options" aria-haspopup="menu" aria-expanded={open}
                        onClick={() => setOpen((o) => !o)}>
                        <IconMore />
                        {open ? null : <span class="tt-pop" role="tooltip">This session: summary, pin, rename, delete</span>}
                    </button>
                    {shown ? (
                        <div class={`chat-menu sb-session-menu${closing ? " leaving" : ""}`} role="menu" aria-label="Session options">
                            <SessionActions store={store} s={s} rt={rt} title={s.title || s.task || "Session"} onPicked={() => setOpen(false)} />
                        </div>
                    ) : null}
                </span>
            ) : null}
            <SessionSummaryDialog store={store} />
            <RenameDialog store={store} />
            <DeleteConfirm store={store} />
        </>
    );
}
