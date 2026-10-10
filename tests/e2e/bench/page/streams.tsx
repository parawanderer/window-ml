// streams.tsx — the Watch card: a held run's screen, live on the page, in tiles a person opens, drags and resizes.
//
// The runs held open after the sweep (bench/hold.mjs) are listed from the server's `/held`, polled while the page is live.
// Opening one makes a tile that reads its screen from `/held/<pid>/stream` (bench/stream.mjs): frames, drawn as they come.
// Its process captures only while a tile is open, so closing the tile stops the capture. When the stream ends (the run let
// go, or its process died) the tile keeps the last frame, in grey, under "stream ended". A saved report.html has no
// server behind it, so there is no card there.

import { useEffect, useRef, useState } from "preact/hooks";
import { Tip } from "../../../../src/sidebar/help-tip";
import { Card } from "../../../../src/sidebar/fold-card";
import { followDrag } from "../../../../src/sidebar/drag";
import { readScreenFrames } from "./frames";

/** A held run as `/held` lists it: its process, its cell, its directory in the sweep, and whether it serves a screen. */
export interface HeldRun { pid: number; cell: string; dir: string; expiresAt: string; stream: boolean }

/** How often the list of held runs is read again while the page is live. */
const POLL_MS = 3000;
/** A new tile's width, and the narrowest a resize leaves one. */
const TILE_W = 480, MIN_W = 220;

/** The Watch card: the held runs, a button to watch each, and the tiles open now. Only on a live page. */
export function Watch({ live }: { live: boolean }) {
    const [held, setHeld] = useState<HeldRun[]>([]);
    const [tiles, setTiles] = useState<{ pid: number; cell: string; w: number }[]>([]);
    useEffect(() => {
        if (!live) return;
        let alive = true;
        const read = () => fetch("/held").then((r) => (r.ok ? r.json() : [])).then((l) => { if (alive) setHeld(l); }).catch(() => {});
        read();
        const t = setInterval(read, POLL_MS);
        return () => { alive = false; clearInterval(t); };
    }, [live]);
    if (!live || (!held.length && !tiles.length)) return null;
    const open = (h: HeldRun) => setTiles((ts) => (ts.some((t) => t.pid === h.pid) ? ts : [...ts, { pid: h.pid, cell: h.cell, w: TILE_W }]));
    const close = (pid: number) => setTiles((ts) => ts.filter((t) => t.pid !== pid));
    const resize = (pid: number, w: number) => setTiles((ts) => ts.map((t) => (t.pid === pid ? { ...t, w } : t)));
    // Dragged over another tile: take its place, the rest moving along, as a hand rearranging cards expects.
    const moveTo = (pid: number, over: number) => setTiles((ts) => {
        const from = ts.findIndex((t) => t.pid === pid), to = ts.findIndex((t) => t.pid === over);
        if (from < 0 || to < 0 || from === to) return ts;
        const next = ts.slice();
        next.splice(to, 0, next.splice(from, 1)[0]);
        return next;
    });
    return (
        <Card id="watch" label="the held runs' screens">
            <header>
                <h2><Tip tip="What each run held open after the sweep (`--hold`) is showing, streamed from its own browser while a tile is open. Drag a tile by its title to move it, by its corner to resize it.">Watch</Tip></h2>
                <span class="sub">held runs, live</span>
            </header>
            <div class="watch-list">
                {held.map((h) => {
                    const on = tiles.some((t) => t.pid === h.pid);
                    return (
                        <button key={h.pid} class={`btn small${on ? " on" : ""}`} disabled={!h.stream || on} onClick={() => open(h)}
                            aria-label={`watch ${h.cell}`}>
                            {h.cell}
                        </button>
                    );
                })}
                {!held.length ? <span class="dim">no run is held open now</span> : null}
            </div>
            {tiles.length ? (
                <div class="watch-tiles">
                    {tiles.map((t) => <ScreenTile key={t.pid} {...t} onClose={() => close(t.pid)} onResize={(w) => resize(t.pid, w)} onMove={(over) => moveTo(t.pid, over)} />)}
                </div>
            ) : null}
        </Card>
    );
}

/** One held run's screen: frames as they come, and, once the stream is over, the last of them greyed under a label. */
function ScreenTile({ pid, cell, w, onClose, onResize, onMove }: { pid: number; cell: string; w: number; onClose: () => void; onResize: (w: number) => void; onMove: (over: number) => void }) {
    const [src, setSrc] = useState<string | null>(null);
    const [ended, setEnded] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);
    const ref = useRef<HTMLElement>(null);
    useEffect(() => {
        const ctl = new AbortController();
        let url: string | null = null;
        (async () => {
            const res = await fetch(`/held/${pid}/stream`, { signal: ctl.signal });
            if (!res.ok || !res.body) throw new Error("no stream");
            await readScreenFrames(res.body, (jpeg) => {
                const next = URL.createObjectURL(new Blob([jpeg], { type: "image/jpeg" }));
                if (url) URL.revokeObjectURL(url);
                url = next;
                setSrc(next);
            });
        })().then(() => setEnded("stream ended"), () => { if (!ctl.signal.aborted) setEnded("stream ended"); });
        return () => { ctl.abort(); if (url) URL.revokeObjectURL(url); };
    }, [pid]);
    // Move: follow the pointer and take the place of whichever tile it is over.
    const grab = (e: PointerEvent) => {
        if ((e.target as HTMLElement).closest("button")) return;
        setDragging(true);
        followDrag(e, (ev) => {
            const over = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>(".watch-tile");
            const id = Number(over?.dataset.pid);
            if (over && id !== pid) onMove(id);
        }, () => setDragging(false));
    };
    // Resize: the corner follows the pointer; the height follows the screen's own shape.
    const stretch = (e: PointerEvent) => {
        const x0 = e.clientX, w0 = ref.current?.getBoundingClientRect().width ?? w;
        const most = ref.current?.parentElement?.getBoundingClientRect().width ?? Infinity;
        followDrag(e, (ev) => onResize(Math.round(Math.min(most, Math.max(MIN_W, w0 + ev.clientX - x0)))));
    };
    return (
        <figure ref={ref} class={`watch-tile${ended ? " ended" : ""}${dragging ? " dragging" : ""}`} data-pid={pid} style={{ width: `${w}px` }}>
            <figcaption onPointerDown={grab}>
                <code>{cell}</code>
                <span class="watch-state">{ended ? "ended" : src ? "live" : "connecting…"}</span>
                <button class="btn small" onClick={onClose} aria-label={`close ${cell}`}>✕</button>
            </figcaption>
            <div class="watch-screen">
                {src ? <img src={src} alt={`what ${cell} shows`} draggable={false} /> : <div class="watch-wait">{ended ?? "waiting for the first frame…"}</div>}
                {ended && src ? <div class="watch-ended">{ended}</div> : null}
            </div>
            <i class="watch-grip" onPointerDown={stretch} aria-hidden="true" />
        </figure>
    );
}
