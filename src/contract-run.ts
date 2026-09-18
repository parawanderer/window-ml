// contract-run.ts — a RUN's identity and provenance: its hash, who is waiting on it, and what it can resume.
//
// shortHash is the single definition of the session hash format -- the thing HASH_RE validates and the
// `ml_session_<hash>` storage key is built from, so it is session identity rather than a string helper.
// RequestHint and wireHint are the other half: what the patched Ollama is told about WHO waits for each
// generation and which session it belongs to, so placement and keep-alive can later be learned from real
// use. An absent `use` means unknown, and wireHint never invents one for a caller that did not say.
//
// pushReplay and bgRunResumable are about a background run outliving the worker that started it, which is
// why STALE_BGRUN_MS is here and not a magic number at a call site.

/** WHO WAITS FOR THE OUTPUT of a request, which is the rule the server's hints are built on: a person reading it
 *  (`interactive`), a program that cannot continue without it (`agent`), nothing urgent (`utility`), throughput
 *  with nobody waiting (`batch`). */
export type RequestUse = "interactive" | "agent" | "utility" | "batch";

/**
 * WHAT A REQUEST IS FOR, told to a patched ollama (`ollama-slop:hints`, docs/FORKED-BACKENDS.md). It is recorded
 * on the server's `gen.end` beside that request's measured timings, so placement and keep-alive can be learned
 * from real usage; it never changes an answer, and a server that does not know it ignores it. Every field is
 * optional, and an ABSENT `use` means unknown — nothing is guessed on the caller's behalf.
 */
export interface RequestHint {
    use?: RequestUse;
    /** Shared by every request of one conversation or agent run: `wml-` + the session hash ({@link hintSession}).
     *  Never per message, which would make every request its own session. */
    session?: string;
    /** What this session waited on since its previous request: a person deciding (an approval gate, a follow-up
     *  turn) or a tool running. Labels the gap before this request, so "a person is deciding" is not read as "the
     *  model is no longer wanted". */
    after?: "human" | "tool";
}

/** The `session` for a window.ml session hash. The prefix tells our traffic apart from Open WebUI's own `owui-`. */
export const hintSession = (hash: string): string => `wml-${hash}`;

/**
 * The `hint` object a request carries on the wire, from what the caller said plus what only the service worker
 * knows (our per-request `request` id, and whether this browser's traffic is synthetic). Pure; the one place the
 * server's limits are applied (`use`/`after` 32 characters, `session` 128, `request` 64), so a
 * page cannot send more than the spec allows. `extend: "utility"` is a side task by construction, so it defaults
 * `use` to `utility`; anything else without a `use` stays unknown. `synthetic` marks generated traffic (benchmark
 * sweeps): served exactly like real traffic, kept out of what the server learns from.
 */
export function wireHint(hint: RequestHint | null | undefined, opts: { extend?: string | null; synthetic?: boolean; request?: string } = {}): Record<string, unknown> | null {
    const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
    const use = str(hint?.use, 32) ?? (opts.extend === "utility" ? "utility" : undefined);
    const session = str(hint?.session, 128);
    const after = hint?.after === "human" || hint?.after === "tool" ? hint.after : undefined;
    const request = str(opts.request, 64);
    const out: Record<string, unknown> = {
        ...(use ? { use } : {}), ...(session ? { session } : {}), ...(request ? { request } : {}), ...(after ? { after } : {}),
        ...(opts.synthetic ? { synthetic: true } : {}),
    };
    return Object.keys(out).length ? out : null;
}

/** Append a debug event to a per-tab HUD replay ring, dropping the oldest past `cap` — but NEVER dropping a
 *  run's `agent` START event. A re-adopting page (cross-page / cross-DOMAIN nav) rebuilds its corner card from
 *  this replay; without the start the reducer can't CREATE the session, so every replayed step orphans and the
 *  card renders EMPTY ("the HUD never appears after a navigate"). This bit the cross-domain case because a LONG
 *  prior session overflowed the ring and evicted the start. Re-pin any dropped start at the head (usually 0-1).
 *  Mutates `buf`. Pure — unit-tested in tests/replay.test.mjs. */
export function pushReplay(buf: unknown[], event: unknown, cap: number): void {
    buf.push(event);
    if (buf.length <= cap) return;
    const dropped = buf.splice(0, buf.length - cap);
    const lostStarts = dropped.filter(e => (e as { kind?: string })?.kind === "agent");
    if (lostStarts.length) buf.unshift(...lostStarts);   // the session-creating events survive the cap
}

/** How stale a persisted background-run snapshot may be and still auto-resume. A real MV3 eviction respawns
 *  within seconds and each step re-stamps the snapshot, so a live run's snapshot is always fresh; anything
 *  older than this is a zombie (the SW died and never came back for it) and must NOT be silently resumed. */
export const STALE_BGRUN_MS = 5 * 60 * 1000;

/** Decide whether a persisted background-run snapshot may be RESUMED on SW startup, or must be invalidated.
 *  A snapshot from a DIFFERENT extension version (a reload/update happened between writing and reading it —
 *  its code may be incompatible, and a reload is often how you kill a runaway) or a STALE one (older than a
 *  live eviction-respawn would ever be) is dropped, never resumed. An un-stamped legacy snapshot (no version)
 *  fails the version check and is purged — the self-heal for zombies written before this guard shipped.
 *  Pure — unit-tested (`tests/bgrun.test.mjs`); the SW deletes the storage key when this returns false. */
export function bgRunResumable(snap: { version?: string; ts?: number }, currentVersion: string, now: number): boolean {
    if ((snap.version || "") !== currentVersion) return false;              // cross-version → a reload/update invalidates it
    if (snap.ts != null && now - snap.ts > STALE_BGRUN_MS) return false;    // stale → no live respawn is ever this old
    return true;
}

/** Sanitize composer image attachments relayed from the sidebar app (a pasted/uploaded screenshot):
 *  keep only `data:image/*` strings, size-capped so a runaway paste can't bloat a postMessage, max 8 per
 *  turn. Returns undefined when there's nothing valid (keeps the relayed message clean). Pure; shared by
 *  the overlay shell and the DevTools panel relays so both validate identically. */
export function cleanImages(v: unknown): string[] | undefined {
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((x): x is string => typeof x === "string" && /^data:image\//.test(x) && x.length <= 8_000_000).slice(0, 8);
    return out.length ? out : undefined;
}

/** The clean, token-efficient context payload for a right-click "ask about this" — what it sends instead
 *  of a screenshot or raw HTML. Block-structured visible TEXT + the media/links the model would otherwise
 *  miss + a `selector` scope handle so the agent's DOM tools (click/read/findByText) keep working inside
 *  the resolved container. Built page-side by domToContext; travels the bus to the Commander pill. */
export interface ElementContext {
    selector: string;                              // the container's scope handle (clickSelector)
    role: string;                                  // ARIA role (roleOf) — "article", "listitem", …
    text: string;                                  // clean block-structured visible text (capped)
    anchorText?: string;                           // the leaf the user actually right-clicked
    media: { src: string; alt: string }[];
    links: { text: string; href: string }[];
}

/** Stable short hex id per session (crypto.getRandomValues, Math.random fallback).
 *  Shown in the sidebar and used to resume a conversation. */
export const shortHash = (): string => {
    try {
        const b = new Uint8Array(4); crypto.getRandomValues(b);
        return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
    } catch { return Math.random().toString(16).slice(2, 10); }
};
