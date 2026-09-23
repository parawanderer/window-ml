// vram-bench.tsx — the Python bench's own UI: the drawer it lives in, and the environment it runs against.
//
// It sat in vram.tsx because the bench opens from the resource panel, which is an accident of where the button
// is rather than anything the two share. Nothing here reads a sample, a capacity or a device; the bench is a
// workspace for running Python against the same Pyodide sandbox a run uses, and it is here so the panel does
// not have to be opened to find it.
//
// `benchEnvOpen`/`benchEnvErr` are module-scope signals rather than component state because the environment
// editor is opened from two places and must not lose what it is showing when one of them unmounts. Assign to
// `.value`; never rebuild the signal, which is the mutate-in-place trap the sidebar has hit before.

import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useState, useEffect, useRef, useMemo } from "preact/hooks";
import type { RenderDescriptor } from "../contract-render";
import { mapLine } from "../diff";
import { deepestUserLine } from "../py-format";
import { pyValueParts } from "../py-render";
import { CodeEditor } from "./code-editor";
import type { RemoteCompletion, CodeEditorHandle } from "./code-editor-api";
import { IconExpand, IconClose, IconChevron, IconTimer, IconPlay, IconSendToModel } from "./icons";
import { type BenchJumpDetail, BENCH_JUMP_EVENT, PyBenchOut } from "./render-panel";
import { benchH, BENCH_H_KEY, benchDock, BENCH_DOCK_KEY, view, viewReturn, benchOpen, BENCH_OPEN_KEY, benchEnv, benchMode, benchKept, noteBenchEnv, benchLost, benchCode, lsSet, BENCH_CODE_KEY, benchRunning, benchResult, type BenchRun, benchLive, benchTimeout, noteBenchKept, benchSplit, BENCH_SPLIT_KEY, codeLineNumbers } from "./store";
import { cursorTipOn, TipText } from "./ui-kit";
import { followDrag } from "./drag";
import { PanelHead, useDocked } from "./panel-head";

// Shape a raw PYTHON_EXEC response into a `python-out` descriptor for RenderPanel.
export function pyBenchDescriptor(r: { ok: boolean; value?: unknown; stdout: string; error?: string; table?: { columns: string[]; rows: (string | number | null)[][] }; render?: "latex" | "img" }): Extract<RenderDescriptor, { type: "python-out" }> {
    const stdout = r.stdout || undefined;
    if (!r.ok) return { type: "python-out", stdout, error: r.error || "error" };
    // The SAME decision the model's python_exec step makes (py-render.ts), so a return draws identically on
    // both surfaces. Only the text differs: pretty-printed here, and no value section for a script that
    // returned nothing (the tool writes "null" because the model must be told).
    return { type: "python-out", stdout, ...pyValueParts(r.value, { render: r.render, table: r.table },
        (v) => (v == null ? undefined : typeof v === "string" ? v : JSON.stringify(v, null, 2))) };
}

/** The bench as a bottom DRAWER — the default. It used to REPLACE the session view, so trying a snippet cost
 *  you your place in the run you opened it from, which is exactly the trip you would be making: copy this
 *  step's code, poke at it, look back at the step. Draggable, because how much of it you want depends on
 *  the script; ✕ closes without discarding the draft (the code is persisted either way); ⇄ hands it to the
 *  full-page mode, which is the right shape for a long script and the wrong one for cross-referencing. */
export function BenchDrawer() {
    const onGrab = (e: PointerEvent) => {
        // The WHOLE strip drags, so the target is as generous as a drawer edge should be — except the
        // CONTROLS sitting in it, where a drag would fight the click you meant. Every interactive kind, not
        // just `button`: the row gained a <select> and a <label>, and `preventDefault` on a pointerdown over
        // a select stops the menu from opening at all — the control looked dead rather than busy.
        if ((e.target as HTMLElement).closest("button, select, input, textarea, label, a")) return;
        const startY = e.clientY, startH = benchH.value;
        // Dragging UP grows it. Floored so the editor and its bar still fit, and capped so the drawer can
        // never take the whole panel — at which point it is not a drawer and full mode is what you wanted.
        const cap = Math.max(200, Math.round((typeof window !== "undefined" ? window.innerHeight : 800) * 0.75));
        followDrag(e, (ev) => { benchH.value = Math.max(150, Math.min(cap, startH + (startY - ev.clientY))); },
            () => { try { chrome.storage.local.set({ [BENCH_H_KEY]: benchH.value }); } catch { /* no extension storage */ } });
    };
    // The drawer owns the DRAG and the SHAPE, and hands both to the bench's own header row — one row doing
    // every job, rather than a title strip here and a control bar at the far end of the panel.
    const shape = <>
        <button class="tt hbtn" aria-label="Expand the Python bench" onClick={() => {
            benchDock.value = "full"; chrome.storage.local.set({ [BENCH_DOCK_KEY]: "full" });
            // Remember EXACTLY where we were, so "back" is a return and not a trip to the list.
            if (view.value.name === "list" || view.value.name === "detail") viewReturn.value = view.value;
            view.value = { name: "bench" };
        }}><IconExpand /><span class="tt-pop left" role="tooltip">Open it full-page — better for a long script, worse for looking at a step while you work.</span></button>
        <button class="tt hbtn" aria-label="Close the Python bench" onClick={() => {
            benchOpen.value = false; chrome.storage.local.set({ [BENCH_OPEN_KEY]: false });
        }}><IconClose /><span class="tt-pop left" role="tooltip">Close it. Your script is kept.</span></button>
    </>;
    return (
        <div class="bench-drawer" style={{ height: `${benchH.value}px` }}>
            <PythonBench drag={onGrab} shape={shape} />
        </div>
    );
}

/** The sandbox's Python version, beside the bench's name. ABSENT until we know it rather than guessed from
 *  our own package manifest — the manifest says what we asked for, and this says what will import. Learned
 *  on the first env read or the first run and cached, so it is missing only before the sandbox has ever
 *  started. Clicking it is the same as opening the environment panel, which is where the rest of it is. */
export function BenchVer() {
    const env = benchEnv.value;
    if (!env) return null;
    return <span class="bench-ver" {...cursorTipOn(`Python ${env.python} on Pyodide ${env.pyodide}. Open **environment** for the packages.`)}>py {env.python}</span>;
}

/** The variables the bench is KEEPING between runs, for the mode it is in, and the one control that clears
 *  them. Beside the packages because both answer "what is in this sandbox", and a person who reaches for a
 *  name that is not there looks here first. Reset clears BOTH modes; it is offered only when there is
 *  something to clear, because a button that visibly does nothing reads as broken. */
function BenchVars() {
    const mode = benchMode.value;
    const vars = benchKept.value[mode]?.vars ?? [];
    const any = Object.values(benchKept.value).some((k) => k?.vars.length);
    return (
        <div class="bench-env-vars">
            <div class="bench-env-vars-head">
                <span>Variables <span class="dim">· {mode}, kept between runs</span></span>
                <button class="tt bench-env-reset" disabled={!any} onClick={resetBenchState} aria-label="Reset the variables">
                    Reset
                    <span class="tt-pop wrap left" role="tooltip"><TipText md="Forget every variable the bench is keeping, in **both** modes. Your script is untouched; the next run starts from an empty namespace." /></span>
                </button>
            </div>
            {vars.length
                ? <ul class="bench-env-list">{vars.map((v) => <li key={v.name}><code>{v.name}</code><span class="bench-env-pv">{v.type}</span></li>)}</ul>
                : <div class="dim bench-env-vars-none">None yet. Anything a script defines at its top level is kept for the next run.</div>}
        </div>
    );
}

/** Ask the sandbox what it is. Costs a Pyodide start when it is cold, so callers pick their moment:
 *  the environment panel on open (you asked), or a bench run's completion (it is already warm). */
function loadBenchEnv(onErr?: (m: string) => void) {
    if (benchEnv.value) return;
    chrome.runtime.sendMessage({ type: "PYTHON_EXEC", payload: { code: "", hardened: true, env: true } }, (resp: any) => {
        const r = resp?.data ?? resp;
        if (r?.env) noteBenchEnv(r.env);
        else onErr?.(r?.error || resp?.error || "The sandbox did not answer.");
    });
}

/** Jedi in the sandbox, as the bench editor's completion backend — module attributes, pandas frames, the
 *  script's own names, and (once the bench keeps state) live objects. ONLY ONCE THE SANDBOX IS WARM: a
 *  completion starts Pyodide when it is cold, and a keystroke must not be what pays that start, nor push your
 *  first Run behind it — the same reason the environment is not read on mount. Until something has started
 *  the sandbox, the editor keeps its static list. Resolves null rather than rejecting, so the editor's
 *  fallback is the only failure path. */
function completeInSandbox(code: string, line: number, column: number): Promise<RemoteCompletion[] | null> {
    if (!benchEnv.value) return Promise.resolve(null);
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ type: "PYTHON_EXEC", payload: { code, hardened: true, complete: { line, column, bench: benchMode.value } } }, (resp: any) => {
                void chrome.runtime.lastError;   // a torn-down sandbox is a fallback, not a console error
                const r = resp?.data;
                resolve(r?.ok && Array.isArray(r.completions) ? r.completions : null);
            });
        } catch { resolve(null); }
    });
}

/** Throw away the bench's kept variables, in both modes. The worker drops its namespaces; the next run starts
 *  from an empty one, and — because the bench cleared its own record first — without a "restarted" notice. */
function resetBenchState() {
    try {
        chrome.runtime.sendMessage({ type: "PYTHON_EXEC", payload: { code: "", benchReset: true } }, (resp: any) => {
            void chrome.runtime.lastError;
            if (resp?.data?.ok) { benchKept.value = {}; benchLost.value = false; }
        });
    } catch { /* no live channel: nothing kept to reset */ }
}

/** WHAT THE SANDBOX IS — the Python and Pyodide versions and the packages you can import, read from the
 *  running interpreter rather than from our manifest (the manifest says what we ASKED for; the wheel that
 *  installed is what the code will import, and a panel reporting the first while the second differs is
 *  worse than one reporting nothing).
 *
 *  A PANEL, not a tooltip: this is a thing you read while writing, and it is about to become a thing you
 *  SEARCH and then act on (install a package; choose which of them the model gets). A tooltip that vanishes
 *  when you move the pointer is the wrong container for any of that.
 *
 *  Fetched on OPEN, once: it starts the sandbox, which is exactly what a first `python_exec` pays for, so
 *  doing it on mount would make every glance at the bench cost a cold start. */
// Open state and the last error live OUTSIDE the components, because the disclosure is now split in two:
// the BUTTON sits in the bench's header row beside the mode picker, and the BODY is a row of its own under
// it. A flex header cannot contain a panel that pushes the editor down, and an absolutely-positioned
// dropdown would be the wrong shape for something you filter and read while typing.
const benchEnvOpen = signal(false);
/** The environment button itself, so its panel can be placed UNDER it wherever the bench is: a drawer at the bottom,
 *  full-page at the top, or a panel someone has dragged narrow. */
let benchEnvBtn: HTMLElement | null = null;

const benchEnvErr = signal("");

/** The `environment` disclosure's BUTTON — what the sandbox is, on demand. In the header row. */
function BenchEnvButton() {
    const open = benchEnvOpen.value;
    return (
        <button ref={(el) => { benchEnvBtn = el; }} class={`bench-env-btn${open ? " on" : ""}`} aria-expanded={open}
            onClick={() => { benchEnvOpen.value = !open; if (!benchEnvErr.value) loadBenchEnv((m) => (benchEnvErr.value = m)); }}>
            <span class="tri" aria-hidden="true"><IconChevron /></span>
            {/* In its own element because an ellipsis needs one. It carried the Python version too, which
                the `py` chip beside it already shows (and the app header in full-page mode), so a tight row paid
                ~35px to say the same thing twice. */}
            <span class="bench-env-label">environment</span>
        </button>
    );
}

/** …and its BODY: the versions and every package that actually installed, filterable. Its own row under the
 *  header, so opening it pushes the editor down rather than covering the code you were reading. */
function BenchEnv() {
    const [q, setQ] = useState("");
    const open = benchEnvOpen.value, err = benchEnvErr.value;
    // WHERE IT SITS: under its own button, clamped to the window, flipped above where there is more room there. It was
    // absolute at a fixed offset from the bench, so it stood to the LEFT of the button, and with the bench at the top
    // of the screen it ran off the edge and was cut off.
    const [at, setAt] = useState<{ left: number; top?: number; bottom?: number; maxH: number } | null>(null);
    useEffect(() => {
        if (!open) return;
        const place = () => {
            const b = benchEnvBtn?.getBoundingClientRect();
            if (!b) return;
            const GAP = 6, EDGE = 8, width = Math.min(420, innerWidth - EDGE * 2);
            const below = innerHeight - b.bottom - GAP - EDGE, above = b.top - GAP - EDGE;
            const down = below >= 260 || below >= above;
            setAt({
                left: Math.max(EDGE, Math.min(b.left, innerWidth - width - EDGE)),
                ...(down ? { top: b.bottom + GAP } : { bottom: innerHeight - b.top + GAP }),
                maxH: Math.max(140, Math.min(360, down ? below : above)),
            });
        };
        place();
        addEventListener("resize", place);
        // A scroll anywhere moves the button: the drawer's own, the page's, a panel's.
        addEventListener("scroll", place, true);
        return () => { removeEventListener("resize", place); removeEventListener("scroll", place, true); };
    }, [open]);
    // A panel that opens over the editor has to close the way every other one does: click off it, or Escape.
    // Without this it could only be dismissed by finding the button again — and since it covers the code you
    // opened it to compare against, "click off it" is the FIRST thing anyone tries.
    useEffect(() => {
        if (!open) return;
        const off = (e: Event) => {
            const t = e.target as HTMLElement | null;
            // Not a click INSIDE the panel (you are reading and filtering it), and not the button itself —
            // that toggles, and closing here too would re-open it on the same press.
            if (t?.closest?.(".bench-env, .bench-env-btn")) return;
            benchEnvOpen.value = false;
        };
        const esc = (e: KeyboardEvent) => { if (e.key === "Escape") benchEnvOpen.value = false; };
        // CAPTURE, so a control that stops propagation cannot leave the panel stranded open.
        document.addEventListener("pointerdown", off, true);
        document.addEventListener("keydown", esc, true);
        return () => {
            document.removeEventListener("pointerdown", off, true);
            document.removeEventListener("keydown", esc, true);
        };
    }, [open]);
    const env = benchEnv.value;
    const hits = (env?.packages || []).filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()));
    // Nothing at all when closed, rather than an empty wrapper: the button lives in the header now, so this
    // component IS the panel and a zero-height div is just something for a selector to trip over.
    if (!open) return null;
    return (
        // Hidden until it has been placed, so it never paints for a frame where it used to sit.
        <div class="bench-env open" style={at ? `left:${at.left}px;${at.top != null ? `top:${at.top}px` : `bottom:${at.bottom}px`};max-height:${at.maxH}px` : "visibility:hidden"}>
            {<div class="bench-env-body">
                {err ? <div class="bench-env-err">{err}</div>
                    : !env ? <div class="dim">reading the sandbox…</div>
                        : <>
                            <div class="bench-env-head">
                                <span>Python <b>{env.python}</b> · Pyodide <b>{env.pyodide}</b></span>
                                <input class="bench-env-q" placeholder="Filter packages" spellcheck={false}
                                    value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
                            </div>
                            <BenchVars />
                            <ul class="bench-env-list">
                                {hits.map((p) => (
                                    <li key={p.name}><code>{p.name}</code>{p.version ? <span class="bench-env-pv">{p.version}</span> : <span class="dim">not installed</span>}</li>
                                ))}
                                {!hits.length ? <li class="dim">Nothing matches "{q}".</li> : null}
                            </ul>
                            {/* Said plainly rather than shown as a control that does nothing. An affordance
                                that silently no-ops is worse than an absent one: you cannot tell it from a
                                bug, and you try it twice. */}
                            <div class="bench-env-soon">
                                Installing another package, and choosing which of these the model may import,
                                are not built yet — these are the ones the sandbox ships with.
                            </div>
                        </>}
            </div>}
        </div>
    );
}

/** THE PYTHON BENCH — an editor over the SAME offscreen Pyodide sandbox `python_exec` uses, so a
 *  snippet you try here behaves as it will in a run. Code-only (no page image or tables). Rendered
 *  inside `BenchDrawer` at the bottom, or full-page as its own view. */
export function PythonBench({ drag, shape }: { drag?: (e: PointerEvent) => void; shape?: ComponentChildren } = {}) {
    // MODULE SIGNALS, not component state — see the note in store.ts. The drawer and the full page are two
    // mount sites, so `⤢` destroys this component and builds the other one; as `useState` that threw away
    // the script, the result you were reading and any run still in flight, which made changing the bench's
    // SHAPE also a way to lose your work in it.
    const docked = useDocked();
    const code = benchCode.value, setCode = (v: string) => { benchCode.value = v; lsSet(BENCH_CODE_KEY, v); };
    const mode = benchMode.value, setMode = (v: "readonly" | "full") => { benchMode.value = v; lsSet("ml_bench_mode", v); };
    const running = benchRunning.value, setRunning = (v: boolean) => { benchRunning.value = v; };
    const result = benchResult.value, setResult = (v: BenchRun | null) => { benchResult.value = v; };
    // LIVE stdout, and the produced-at marks that go with it — the same tee the model-invoked tool gets, just
    // painting a different widget. Accumulated here rather than in the pane, so a re-render cannot lose it.
    //
    // KEPT AFTER THE RUN SETTLES, which is the point rather than an accident: the marks are what draw the
    // produced-at gutter, so dropping them at the end swapped that gutter for line numbers at the exact
    // moment you stopped watching — the same output, redrawn as something else. They are cleared only when
    // the NEXT run starts. If the settled text ever disagrees with what streamed, `alignedMarks` drops the
    // whole set rather than mis-indexing it.
    const live = benchLive.value;
    const setLive = (f: { text: string; marks: [number, number][] } | null | ((p: { text: string; marks: [number, number][] } | null) => { text: string; marks: [number, number][] })) => {
        benchLive.value = typeof f === "function" ? f(benchLive.value) : f;
    };
    const run = () => {
        if (running || !code.trim()) return;
        const started = Date.now();
        // The id the SW keys this run's stdout by, and the id the listener below filters on.
        const requestId = `bench-${started.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        setRunning(true); setResult(null); setLive(null); benchLost.value = false;
        // Each chunk carries the instant the WORKER produced it — Pyodide stamps it there, because anything
        // downstream would be measuring the message bus. `marks` is [offset in the accumulated text, epoch].
        const onChunk = (msg: { type?: string; requestId?: string; chunk?: string; ts?: number }) => {
            if (msg?.type !== "PYTHON_STREAM" || msg.requestId !== requestId) return;
            const text = String(msg.chunk ?? "");
            if (!text) return;
            setLive((prev) => {
                const at = prev?.text.length ?? 0;
                return { text: (prev?.text ?? "") + text, marks: [...(prev?.marks ?? []), [at, msg.ts ?? Date.now()]] };
            });
        };
        // GUARDED both ways. A surface without a live runtime channel (a test world, a torn-down context)
        // must lose the STREAMING, not the run: attaching threw here, which left the bench wedged on
        // "running…" with no result and no error — the script had not even been sent yet.
        let streaming = false;
        try { chrome.runtime.onMessage.addListener(onChunk); streaming = true; } catch { /* no live channel */ }
        const stop = () => { if (streaming) try { chrome.runtime.onMessage.removeListener(onChunk); } catch { /* torn down */ } };
                try {
            chrome.runtime.sendMessage({ type: "PYTHON_EXEC", requestId, payload: { code, hardened: mode === "readonly", image: null, tables: null, stream: streaming, persist: true, ...(benchTimeout.value ? {} : { noTimeout: true }) } },
                (resp: any) => {
                    stop();
                    // The background wraps the offscreen result: { data: PyResult } | { error }.
                    const r = resp?.data ?? (resp?.error ? { ok: false, stdout: "", error: resp.error } : null);
                    setResult({ ...(r || { ok: false, stdout: "", error: "No response from the sandbox." }), code });
                    setRunning(false);
                    if (r?.bench) noteBenchKept(mode, r.bench);
                    // The sandbox is up NOW, so the version chip is free. Doing this on mount instead would
                    // make every glance at the bench pay the cold start the env panel exists to defer.
                    loadBenchEnv();
                });
        } catch (e) { stop(); setResult({ ok: false, stdout: "", error: String(e), code }); setRunning(false); }
    };
    // ⌘/Ctrl+Enter runs, from ANYWHERE in the bench — not just the textarea. It used to be bound to the
    // field alone, so clicking the mode picker or the environment list silently disarmed the only shortcut
    // for the thing this panel is for; with the Run button moved into the header there is even less to
    // click your way back to.
    const onBenchKey = (e: KeyboardEvent) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); }
    };
    const splitRef = useRef<HTMLDivElement>(null);
    /** DRAG THE DIVIDER — a RATIO, not a pixel height. The bench is itself resizable (the drawer's edge, and
     *  the panel it lives in), so pinning the editor to pixels would let a shorter drawer eat the whole
     *  output pane. Clamped so neither pane can be dragged out of existence: a pane you cannot get back is
     *  not a smaller pane, it is a lost one. */
    const onSplit = (e: PointerEvent) => {
        const host = (e.currentTarget as HTMLElement).parentElement;
        if (!host) return;
        followDrag(e, (ev) => {
            const b = host.getBoundingClientRect();
            if (b.height <= 0) return;
            benchSplit.value = Math.max(0.15, Math.min(0.85, (ev.clientY - b.top) / b.height));
        }, () => { try { chrome.storage.local.set({ [BENCH_SPLIT_KEY]: benchSplit.value }); } catch { /* no extension storage */ } });
    };
    // MEMOED on the result, not rebuilt each render: the output pane keeps your chosen tab across runs, and
    // it decides that from this object's identity — a fresh one every render would re-pick on every keypress.
    // WHILE IT RUNS, the streamed stdout IS the result — the same descriptor shape, so the pane draws it with
    // the same renderer and the settled result simply supersedes it. Nothing about the pane knows the
    // difference, which is what keeps one output renderer rather than a live one and a finished one.
    const outD = useMemo(() => (
        result ? pyBenchDescriptor(result)
            : running && live?.text ? { type: "python-out" as const, stdout: live.text }
                : null
    ), [result, running, live]);
    // Has this bench produced anything yet? Sticky — `result` is cleared at the start of every run, and a
    // pane that vanished and came back between runs would throw the editor's height around each time.
    const hasOut = running || result != null;
    // WHERE THE LAST RUN FAILED, in the code as it is NOW. The traceback's numbers are about the script that
    // ran (kept on the result), and you usually go on typing after a failure — so the line is followed through
    // lines added or removed above it, and dropped once the line itself is edited, rather than left marking
    // whatever text has since slid under that number. The same mapping answers a traceback frame's click.
    const failRan = result && !result.ok && result.error ? deepestUserLine(result.error) : null;
    const markAt = useMemo(() => (failRan != null && result?.code != null ? mapLine(result.code, code, failRan) : null), [failRan, result, code]);
    const editorRef = useRef<CodeEditorHandle | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    // A frame in the output was clicked (render-panel's jumpToLine, which cannot import this file). Reads the
    // SIGNALS rather than this render's closure: the listener is bound once and the script moves under it.
    useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        const onJump = (e: Event) => {
            const d = (e as CustomEvent<BenchJumpDetail>).detail;
            const ran = benchResult.value?.code;
            const at = ran == null ? d.line : mapLine(ran, benchCode.value, d.line);
            if (at == null) { d.result = "changed"; return; }
            d.result = editorRef.current?.flashLine(at, d.fail) ? "shown" : "missing";
        };
        el.addEventListener(BENCH_JUMP_EVENT, onJump);
        return () => el.removeEventListener(BENCH_JUMP_EVENT, onJump);
    }, []);
    return (
        <div ref={rootRef} class={`bench${drag ? "" : " bench-full"}`} onKeyDown={onBenchKey}>
            {/* ONE HEADER, both shapes. It used to be two: the drawer drew a title strip and PythonBench drew
                a control bar at the BOTTOM — so the controls sat as far from the name of the thing as the
                layout allowed, and moving them up naively would have deleted them from full-page mode, where
                there is no drawer to draw a strip. So the row lives here and the drawer INJECTS its grip and
                shape controls into it. */}
            {/* DOCKED (the chat page), the row goes into the dock's tab bar: the tab is the bench's name, so the
                row starts at the version, and the dock draws the resize edge, maximize and close. */}
            <PanelHead><div class={`bench-top${drag ? " bench-grip" : ""}`}
                {...(drag ? { role: "separator", "aria-label": "Drag to resize the Python bench", onPointerDown: drag } : {})}>
                {/* Only in the drawer: full-page already has the name and version in the app header, and a
                    second copy an inch below it reads as two different things. */}
                {drag ? <><span class="bench-title">Python bench</span><BenchVer /></> : docked ? <BenchVer /> : null}
                <BenchEnvButton />
                <span class="tt bench-info" aria-label="about the bench">ⓘ<span class="tt-pop wrap left" role="tooltip">
                    <TipText md="Runs against the SAME sandbox `python_exec` uses (offscreen → worker → Pyodide), but in its own namespace: **variables are kept between runs**, like a notebook, separately for readonly and full. Reset them in **environment**. Code-only — no page image or tables. `return` a value (or end with a bare expression, Jupyter-style); `print()` is captured. 15s cap." />
                </span></span>
                {/* THE GRAB PILL is centred on the ROW, which is the only place a drawer handle reads as one —
                    centred in the leftover space instead, it sat visibly off to one side, because the name and
                    its controls are wider than the two icons opposite. What made that necessary was the pill
                    landing on the mode picker; the picker moves to the RIGHT group instead, which leaves the
                    row's middle genuinely empty. It is `pointer-events: none` besides, so even where the two
                    do meet in a narrow panel the pill can never swallow a click meant for a control. */}
                <span class="sp" />
                {/* ONLY WHERE THERE IS SOMETHING TO DRAG. Full-page has no drawer edge, so the pill sat in
                    the middle of the header as a handle for nothing — and it is the one control in the row
                    that says "grab me", which makes an inert one worse than absent. */}
                {drag ? <i class="bench-grip-pill" aria-hidden="true" /> : null}
                {/* No visible "mode" word: the options already say what they are ("readonly (sandboxed)",
                    "full (network)"), and the word cost 40px of a row that runs out of room. It stays the
                    control's accessible NAME, which is what a label is for. */}
                <label class="bench-mode">
                    <select aria-label="Sandbox mode" value={mode} onChange={e => setMode((e.target as HTMLSelectElement).value === "full" ? "full" : "readonly")}>
                        <option value="readonly">readonly (sandboxed)</option>
                        <option value="full">full (network)</option>
                    </select>
                </label>
                {/* The one ACTION in the row, so it is filled and coloured where everything else is a quiet
                    outline. Its tooltip carries the shortcut, which is where the bottom bar's hint went. */}
                {/* THE WATCHDOG, as a state you can see rather than a surprise you hit. A run is killed at 15s
                    and the message says to simplify the script — which is right advice for the model's tool,
                    where nobody is watching and a stuck run holds the one Pyodide instance against every
                    later call, and wrong here, where you deliberately wrote something slow and are sitting in
                    front of it. Struck through when off, because a slash reads as "disabled" with no colour
                    and no label. Only the bench can ask; the background refuses the flag from a page. */}
                <button class={`tt bench-timer${benchTimeout.value ? "" : " off"}`}
                    aria-pressed={!benchTimeout.value}
                    aria-label={benchTimeout.value ? "Stop runs after 15 seconds" : "Let runs go as long as they need"}
                    onClick={() => { benchTimeout.value = !benchTimeout.value; lsSet("ml_bench_timeout", benchTimeout.value ? "on" : "off"); }}>
                    <IconTimer off={!benchTimeout.value} />
                    <span class="tt-pop wrap left" role="tooltip"><TipText md={benchTimeout.value
                        ? "A run is stopped after **15s**. Click to let it run as long as it needs — for a script you know is slow. The model's own `python_exec` keeps the limit either way."
                        : "**No time limit** on runs here. A script that never finishes holds the sandbox until you close the bench, so put it back when you are done. The model's own `python_exec` is unaffected."} /></span>
                </button>
                <button class="tt bench-play" disabled={running || !code.trim()} onClick={run} aria-label="Run">
                    {running ? <span class="bench-play-spin" aria-hidden="true" /> : <IconPlay />}
                    <span class="tt-pop wrap left" role="tooltip"><TipText md={running
                        ? "Running in the sandbox…"
                        : "Run this script in the Pyodide sandbox. `⌘/Ctrl+↵` does the same, from anywhere in the bench."} /></span>
                </button>
                {/* PLACEHOLDER, and DISABLED so it says so. The bench is where you work a script out; handing
                    the finished thing to the model as a turn is the obvious next move and it is not built.
                    Drawn rather than omitted because the shape of the row is worth settling now — and
                    disabled rather than live-but-inert, because an affordance that silently does nothing
                    cannot be told from a bug, so you try it twice (the same rule the environment panel's
                    "not built yet" note follows). */}
                <button class="tt bench-send" disabled aria-label="Send to the model" aria-disabled="true">
                    <IconSendToModel />
                    <span class="tt-pop wrap left" role="tooltip"><TipText
                        md="Send this script, and what it printed, to the model as a new turn — so you can hand it a snippet you just got working. **Not built yet.**" /></span>
                </button>
                {shape}
            </div></PanelHead>
            <BenchEnv />
            {/* THE SANDBOX RESTARTED UNDER YOU — said where you are looking, once, instead of surfacing as a
                NameError on a variable you defined three runs ago. A runaway run being stopped is the usual
                cause (the watchdog kills the worker, and the kept namespace with it). */}
            {benchLost.value ? (
                <div class="bench-lost" role="status">
                    The sandbox restarted, so variables from earlier runs are gone.
                    <button class="bench-lost-x" aria-label="Dismiss" onClick={() => { benchLost.value = false; }}>✕</button>
                </div>
            ) : null}
            {/* THE SPLIT. Two panes and a divider, rather than the editor at a fixed height with the output
                pushing down from under it: how much of each you want depends entirely on what you are doing,
                and in a drawer they are competing for the same handful of pixels. The textarea's own corner
                grip is gone with it — three resize gestures in one drawer (the drawer's edge, the field's
                corner, and nothing at all for the output) is two too many. */}
            <div class="bench-split">
                <div class="bench-pane" style={{ flexGrow: hasOut ? benchSplit.value : 1 }}>
                    {/* NO `onRun`: the bench owns ⌘/Ctrl+↵ from anywhere in the panel (`onBenchKey`), so the
                        editor claims the chord — CodeMirror would otherwise read it as "insert a blank line" —
                        and lets it bubble up to that one handler. Handing it onRun too would run twice. */}
                    {/* Line numbers follow the log's own preference (Settings → Appearance), and come on regardless
                        while the last run's traceback is on screen, as a failing step's block does: a traceback
                        names a number, and you cannot find line 14 by counting. Keyed on the FAILURE, not on the
                        mark — the mark goes the moment you edit the failing line, and a gutter going with it would
                        shift every line sideways under the cursor you are fixing it with. */}
                    <CodeEditor class="bench-code" value={code} onChange={setCode} complete={completeInSandbox} placeholder="return 6 * 7"
                        lineNumbers={codeLineNumbers.value || failRan != null} markLine={markAt} handleRef={editorRef} />
                </div>
                {/* THE OUTPUT PANE ARRIVES WITH THE FIRST RUN and never leaves. Before that the editor has the
                    whole bench: an empty pane with a line of placeholder in it is chrome promising something
                    it does not have, and it takes half the room you came here to write in. It appears the
                    instant you press ▶ — carrying "running…", which is the feedback that moment needs — so
                    the layout shifts once, on a deliberate action, rather than on each result landing. */}
                {hasOut ? <>
                    <div class="bench-div" role="separator" aria-label="Drag to resize the script against its output"
                        aria-orientation="horizontal" onPointerDown={onSplit}><i class="bench-div-pill" aria-hidden="true" /></div>
                    <div class="bench-pane" style={{ flexGrow: 1 - benchSplit.value }}>
                        <PyBenchOut d={outD} running={running} marks={live?.marks} />
                    </div>
                </> : null}
            </div>
        </div>
    );
}
