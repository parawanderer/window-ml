// The off-mode card's Spotlight composer: the model-picker chip (ComposerModelBar) and the task-input
// card (ComposerCard) that starts/steers a run from the HUD. Extracted from hud-card.tsx; reads the shared
// composer signals from ./card-state and the shared attach/thumb bits from ./composer.
import { useState, useEffect, useRef } from "preact/hooks";
import { models, config, ollamaIds, rev, sessionMap, backendError } from "./store";
import { IconChevron, IconEye, IconEyeOff } from "./icons";
import { useImageAttach, ThumbStrip, ElementPill } from "./composer";
import {
    composerModel, composerModelOpen, composerVision, composerStream, composerMaxSteps, composerResolvedModel,
    composerOpen, composerElement, composerTarget, composerStarting, setDefaultModel, STEP_BUDGETS,
    isOllamaModel, isCloudModel,
} from "./card-state";

// The composer's model control: a chip showing the run's model (the per-call pick, else the default) that
// opens a dropdown of the allowed models. Picking a row overrides the model FOR THIS RUN; the ★ persists it
// as the new default (SET_MODEL) — a testing shortcut so you rarely open Settings. A non-Ollama pick also
// gets an eye toggle for per-call native vision. Mirrors the Settings vision lock: Ollama auto-detects, so
// no toggle there.
export function ComposerModelBar() {
    const open = composerModelOpen.value;
    const sel = composerResolvedModel();
    const def = config.value.model || "";
    // The allowed set (LIST_MODELS already applied modelFilter) — but ALWAYS include the configured default:
    // a cloud default often isn't in the server's model list, and it'd be absurd to omit the model you're on.
    // Sorted A→Z so a long local list is scannable.
    const list = [...new Set(def ? [def, ...models.value] : models.value)].sort((a, b) => a.localeCompare(b));
    // Offer the native-vision toggle ONLY for an AFFIRMATIVELY non-Ollama model — provenance is unknown until
    // LIST_MODELS lands, and treating unknown as cloud made the eye flash in then out once the list loaded,
    // shoving the chip sideways (the "snap" on open). Unknown → no eye, no flash.
    const cloud = !!sel && isCloudModel(sel);
    const wrapRef = useRef<HTMLDivElement>(null);
    // Type-to-filter (contains-anywhere, case-insensitive) — a long local model list is a pain to scan.
    const [filter, setFilter] = useState("");
    const filterRef = useRef<HTMLInputElement>(null);
    const q = filter.trim().toLowerCase();
    const shown = q ? list.filter(m => m.toLowerCase().includes(q)) : list;
    // Close on any pointer-down outside the control (the iframe's own document — the menu floats over the body).
    useEffect(() => {
        if (!open) return;
        const onDown = (e: PointerEvent) => { if (!wrapRef.current?.contains(e.target as Node)) composerModelOpen.value = false; };
        document.addEventListener("pointerdown", onDown, true);
        return () => document.removeEventListener("pointerdown", onDown, true);
    }, [open]);
    // Reset the filter + focus the box each time the menu opens, so you can just type.
    useEffect(() => { if (open) { setFilter(""); const id = requestAnimationFrame(() => filterRef.current?.focus()); return () => cancelAnimationFrame(id); } }, [open]);
    const pick = (m: string) => { composerModel.value = m === def ? "" : m; composerModelOpen.value = false; };
    return (
        <div class="cmp-model" ref={wrapRef}>
            <button class="cmp-model-btn" type="button" aria-haspopup="listbox" aria-expanded={open}
                title="Model for this run — click to switch (★ sets your default)"
                onClick={() => (composerModelOpen.value = !open)}>
                <span class="cmp-model-name">{sel || "no model"}</span>
                <IconChevron />
            </button>
            {cloud ? (
                <button class={`cmp-vis${composerVision.value ? " on" : ""}`} type="button" aria-pressed={composerVision.value}
                    aria-label={composerVision.value ? "Native vision on for this run" : "Native vision off for this run"}
                    title={composerVision.value
                        ? "This run: the model sees images itself (native vision) — click to turn off"
                        : "This run: no native vision — delegates to the reader model. Click to turn on for a cloud model that can see (e.g. GPT-4o)."}
                    onClick={() => (composerVision.value = !composerVision.value)}>{composerVision.value ? <IconEye /> : <IconEyeOff />}</button>
            ) : null}
            {open ? (
                <div class="cmp-model-menu" role="listbox">
                    <input ref={filterRef} class="cmp-model-filter" type="text" value={filter} placeholder="Filter models…"
                        aria-label="Filter models"
                        onInput={e => setFilter((e.target as HTMLInputElement).value)}
                        onKeyDown={e => {
                            if (e.key === "Enter" && shown.length) { e.preventDefault(); pick(shown[0]); }
                            else if (e.key === "Escape") { e.preventDefault(); composerModelOpen.value = false; }
                        }} />
                    {list.length === 0
                        ? <div class="cmp-model-empty">No models loaded — check the server URL / API key in Settings.</div>
                        : shown.length === 0
                            ? <div class="cmp-model-empty">No models match "{filter.trim()}".</div>
                            : shown.map(m => {
                                const isSel = m === sel, isDef = m === def, tag = isOllamaModel(m) ? "ollama" : (ollamaIds.value ? "cloud" : "");
                                return (
                                    <div key={m} class={`cmp-model-row${isSel ? " sel" : ""}`} role="option" aria-selected={isSel}
                                        onClick={() => pick(m)}>
                                        <span class="cmp-model-row-name">{m}</span>
                                        {tag ? <span class={`cmp-model-tag ${tag}`}>{tag}</span> : null}
                                        <button class={`cmp-model-star${isDef ? " on" : ""}`} type="button"
                                            title={isDef ? "Your default model" : "Set as default model"}
                                            onClick={e => { e.stopPropagation(); setDefaultModel(m); }}>{isDef ? "★" : "☆"}</button>
                                    </div>
                                );
                            })}
                </div>
            ) : null}
        </div>
    );
}

// The Spotlight composer — the HUD morphed into a task input. Reuses the card's head/body/foot anatomy
// (same 🤖 in the same top-left spot as every other state) so it reads as the SAME blob reshaping, not a
// new panel. On send it posts `startRun` to the shell → the page runs a real ml.agent() (hash, resumable).
export function ComposerCard() {
    const [text, setText] = useState("");
    const [err, setErr] = useState("");   // pre-flight complaint (e.g. no model configured) — blocks the send
    const att = useImageAttach();
    const budget = composerMaxSteps.value;   // the step budget (persists across opens)
    const ref = useRef<HTMLTextAreaElement>(null);
    // Focus after a frame so the container's morph (and the shell's frame.focus) has landed.
    useEffect(() => { const id = requestAnimationFrame(() => ref.current?.focus()); return () => cancelAnimationFrame(id); }, []);
    const el = composerElement.value;   // right-click "ask about this" context, if any
    const target = composerTarget.value;   // NEW run (default) vs APPEND to the open run
    const appendRun = target.mode === "append" ? sessionMap.get(target.hash) : undefined;
    const close = () => { composerOpen.value = false; composerElement.value = null; composerTarget.value = { mode: "new" }; };
    const send = () => {
        const t = text.trim();
        if (!t && !att.imgs.length && !el) return;   // allow an image-only OR element-only task
        // APPEND mode ("add to current run"): route to the open session — the page steers a running loop
        // (say) or starts a follow-up turn (run), and folds any element context into the message. No model
        // pre-flight (the run already resolved one). Optimistically flip it to working so the card morphs now.
        if (target.mode === "append") {
            window.parent.postMessage({ __mlSidebarApp: "sessionSend", hash: target.hash, text: t, images: att.imgs, elementContext: el || undefined }, "*");
            const s = sessionMap.get(target.hash);
            if (s) { s.status = "pending"; s.ended = false; s.lastTs = Date.now(); rev.value++; }
            close();
            return;
        }
        // Pre-flight: a HUD run with no model at all would flash the orb, then fail at the background's
        // prepareRequest with "No model configured". Catch it HERE instead — an inline nudge, so a fresh
        // install that hasn't picked a model gets an actionable message, not a cryptic failure. A per-call
        // pick counts, so this only fires when there's neither an override nor a configured default.
        // Backend down: block a NEW run — it would only fail (or retry fruitlessly). The health probe clears
        // `backendError` the instant the box answers again, re-enabling submission. (Steering/appending an
        // EXISTING run above is allowed — its next model call rides out the outage via the background's
        // network retry, so an ongoing run recovers.)
        if (backendError.value) { setErr("Backend unreachable — can't start a new run until the server is back (it re-enables automatically)."); return; }
        const model = composerModel.value.trim();   // "" = follow the configured default
        const resolved = composerResolvedModel();
        if (!resolved) { setErr("No model set. Pick one from the model menu above, or set a default in the extension settings."); return; }
        // Native-vision override only rides along for a non-Ollama pick with the eye toggled on (Ollama
        // vision is auto-detected, so we never send it there — the background resolves it). undefined ⇒
        // omitted ⇒ ml.agent's default routing (delegate to the reader model if one sees).
        const vision = (isCloudModel(resolved) && composerVision.value) ? true : undefined;
        // Bridge the round-trip: show a "Starting…" pill until the run's first event arrives (the composer
        // flies back to the corner and is instantly working). Safety-cleared if the run never surfaces.
        const t0 = Date.now();
        composerStarting.value = t0;
        setTimeout(() => { if (composerStarting.value === t0) composerStarting.value = 0; }, 10000);
        window.parent.postMessage({ __mlSidebarApp: "startRun", task: t, maxSteps: composerMaxSteps.value, model: model || undefined, vision, stream: composerStream.value || undefined, images: att.imgs, elementContext: el || undefined }, "*");
        close();
    };
    return (
        <div class="card-app" data-rev={rev.value}>
            <div class="card-head">
                <span class="card-bot" aria-hidden="true">🤖</span>
                <span class="card-head-txt" title={appendRun ? (appendRun.title || appendRun.task || "") : undefined}>
                    {target.mode === "append" ? (appendRun?.status === "pending" ? "Steer this run" : "Add to run") : "New task"}
                </span>
                <span class="sp" />
                {target.mode === "append" ? null : <ComposerModelBar />}
                <button class="card-x" aria-label="Cancel" title="Cancel" onClick={close}>✕</button>
            </div>
            <div class="card-body">
                {el ? <ElementPill ctx={el} onRemove={() => (composerElement.value = null)} /> : null}
                <ThumbStrip imgs={att.imgs} loading={att.loading} onRemove={att.remove} />
                <textarea ref={ref} class="card-cmp-input" rows={3}
                    placeholder={el ? "Ask about the selected element…" : "Ask window.ml to do something on this page… (paste a screenshot to attach)"}
                    value={text}
                    onInput={e => { setText((e.target as HTMLTextAreaElement).value); if (err) setErr(""); }}
                    onPaste={att.onPaste}
                    onKeyDown={e => {
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
                        else if (e.key === "Escape") { e.preventDefault(); close(); }
                    }} />
                {err ? <div class="card-cmp-err">{err}</div>
                    : (backendError.value && target.mode !== "append") ? <div class="card-cmp-err">⚠ Backend unreachable — new runs are paused until the server is back.</div>
                        : null}
            </div>
            <div class="card-foot card-cmp-foot">
                <input ref={att.fileRef} type="file" accept="image/*" multiple style="display:none"
                    onChange={e => { att.addFiles((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ""; }} />
                <button class="tt cbtn" onClick={() => att.fileRef.current?.click()} aria-label="Attach an image">＋<span class="tt-pop left above" role="tooltip">Attach an image (or paste a screenshot)</span></button>
                <span class="card-cmp-hint"><kbd class="kb">↵</kbd> send · <kbd class="kb">esc</kbd> cancel</span>
                <span class="sp" />
                {/* No `live` toggle. Streaming is what the Commander IS — a run you watch — so it was a
                    control whose only useful setting was the one it already had, sitting in a bar that has
                    too many. The signal stays (it is what the run is started with, and it is the seam a
                    control would return through); the button is gone. */}
                {/* Step budget — a pretty segmented control (not a bare <select>); caps the agent loop. */}
                <div class="card-cmp-budget" title="How many tool steps the agent may take">
                    <span class="card-cmp-budget-label">Steps</span>
                    <div class="seg" role="group" aria-label="Step budget">
                        {STEP_BUDGETS.map(n => (
                            <button key={n} class={`seg-opt${budget === n ? " on" : ""}`}
                                aria-pressed={budget === n} onClick={() => (composerMaxSteps.value = n)}>{n}</button>
                        ))}
                    </div>
                </div>
                <button class="appr-btn yes" onClick={send} disabled={!text.trim() && !att.imgs.length && !el}>Send</button>
            </div>
        </div>
    );
}
