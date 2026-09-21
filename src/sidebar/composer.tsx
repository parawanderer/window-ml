// The session composer + its shared bits — drive a live createAgent session from the sidebar/HUD: a
// message routes to the page (via the parent shell/panel) → the handle by hash (STEER a running loop, or
// start a new turn). Includes the shared image-attach hook (file/paste → data URLs) and the thumb-strip /
// element-pill chips, reused by the HUD Spotlight composer. Extracted from app.tsx.
import { useState, useRef, useEffect } from "preact/hooks";
import { services } from "./services";
import { loadDraft, loadDraftImages, onDraftRestored, saveDraft, saveDraftImages, sendHeld } from "./drafts";
import type { ElementContext } from "../contract-run";
import { config, rev } from "./store";
import type { Session } from "./store";
import { truncate } from "./format";
import { IconSend, IconStop } from "./icons";
import { clearHighlight, highlightEl } from "./ui-kit";
import { UsageBar } from "./usage";
import { RunStatsBar } from "./agent-detail";

/** How tall a multiline composer may grow before it scrolls instead: a box that can take the whole
 *  viewport is one you cannot send from. */
const COMPOSER_MAX_H = 180;

// The session composer: drive a live createAgent session from the sidebar. Sending routes to the page
// (via the parent shell/panel) → the handle by hash: STEER a running loop (say) or start a new turn (run),
// the page deciding from the handle's live state. Claude-Code touch: while a run is IN FLIGHT and the box
// is EMPTY, the submit button becomes a STOP that cancels; type anything and it's a send again.
// Shared image-attach state for BOTH composers (session + Spotlight): a file upload or a clipboard paste
// becomes data URLs, with a `loading` count so the thumb strip can show spinners while FileReader decodes.
export function useImageAttach(initial?: () => string[]) {
    const [imgs, setImgs] = useState<string[]>(initial ?? []);
    const [loading, setLoading] = useState(0);
    const fileRef = useRef<HTMLInputElement>(null);
    const addFiles = (files: FileList | File[] | null | undefined) => {
        const list = [...(files || [])].filter(f => f && f.type.startsWith("image/"));
        if (!list.length) return;
        setLoading(n => n + list.length);
        for (const f of list) {
            const rd = new FileReader();
            rd.onload = () => { const url = String(rd.result || ""); if (url.startsWith("data:image/")) setImgs(a => [...a, url]); setLoading(n => Math.max(0, n - 1)); };
            rd.onerror = () => setLoading(n => Math.max(0, n - 1));
            rd.readAsDataURL(f);
        }
    };
    // Paste a screenshot straight into the box (the common flow). Returns true when it consumed an image
    // (so the caller can preventDefault); false lets a normal text paste through.
    const onPaste = (e: ClipboardEvent): void => {
        const files = [...(e.clipboardData?.items || [])].filter(it => it.kind === "file" && it.type.startsWith("image/")).map(it => it.getAsFile()).filter(Boolean) as File[];
        if (!files.length) return;
        e.preventDefault();
        addFiles(files);
    };
    return { imgs, setImgs, loading, addFiles, onPaste, fileRef, remove: (i: number) => setImgs(a => a.filter((_, j) => j !== i)), clear: () => setImgs([]) };
}

// The attached-image thumbnail strip: previews with an × to remove, plus spinner placeholders for
// in-flight decodes. Renders nothing when there are no images and nothing decoding.
export function ThumbStrip({ imgs, loading, onRemove }: { imgs: string[]; loading: number; onRemove: (i: number) => void }) {
    if (!imgs.length && !loading) return null;
    return (
        <div class="cthumbs">
            {imgs.map((src, i) => (
                <div class="cthumb" key={i}>
                    <img src={src} alt="attachment" />
                    <button class="cthumb-x" onClick={() => onRemove(i)} aria-label="Remove image" title="Remove">×</button>
                </div>
            ))}
            {Array.from({ length: loading }, (_, i) => <div class="cthumb cthumb-load" key={`l${i}`}><span class="cspin" /></div>)}
        </div>
    );
}

// The right-click "ask about this" reference pill: a removable chip naming the resolved container (role +
// the leaf you clicked). Hovering it BOXES that container on the live page (reuses the hover-highlight),
// so you see exactly what context is captured before sending.
export function ElementPill({ ctx, onRemove }: { ctx: ElementContext; onRemove: () => void }) {
    const label = ctx.anchorText ? `${ctx.role || "element"} · "${truncate(ctx.anchorText, 30)}"` : (ctx.role || "element");
    return (
        <div class="el-pill" onPointerEnter={() => highlightEl(ctx.selector)} onPointerLeave={clearHighlight} title={ctx.selector}>
            <span class="el-pill-ic" aria-hidden="true">📌</span>
            <span class="el-pill-txt">{label}</span>
            <button class="el-pill-x" onClick={onRemove} aria-label="Remove element context" title="Remove">×</button>
        </div>
    );
}

/** Is the screen phone-narrow (560px or less)? Follows the window, so rotating a phone changes it. */
function useNarrowScreen(): boolean {
    const q = typeof matchMedia === "function" ? matchMedia("(max-width: 560px)") : null;
    const [narrow, setNarrow] = useState(!!q?.matches);
    useEffect(() => {
        if (!q) return;
        const on = () => setNarrow(q.matches);
        q.addEventListener?.("change", on);
        return () => q.removeEventListener?.("change", on);
    }, []);
    return narrow;
}

/** THE COMPOSER — where you send the next message into a session: the text box, pasted images, an
 *  element you picked off the page, the model/vision toggles and the run controls. Sending INTO a run is
 *  the one thing that needs a reverse channel, so the DevTools panel routes it through the background. */
export function Composer({ s, multiline }: { s: Session; multiline?: boolean }) {
    const r = rev.value;   // subscribe: `s.status` is mutated in place (same ref), so without a signal read this
                           // stateful child won't re-render when the run goes pending/idle → the Stop button.
    // THE DRAFT (drafts.ts): what was typed is saved as it is typed and read back when the box is drawn again, and a
    // send that fails puts its text back. Keyed by the session, so each session keeps its own.
    const key = s.hash;
    const [text, setText] = useState(() => loadDraft(key));
    const att = useImageAttach(() => loadDraftImages(key));
    const type = (t: string) => { setText(t); saveDraft(key, t); };
    // Another session in the same box: its own draft. Not on mount, which `useState` already read: an effect runs after
    // paint, and a keystroke landing before it would be overwritten by what was saved before that keystroke.
    const shown = useRef(key);
    useEffect(() => {
        if (shown.current === key) return;
        shown.current = key;
        setText(loadDraft(key)); att.setImgs(loadDraftImages(key));
    }, [key]);
    useEffect(() => { saveDraftImages(key, att.imgs); }, [key, att.imgs]);
    useEffect(() => onDraftRestored((k) => { if (k === key) { setText(loadDraft(key)); att.setImgs(loadDraftImages(key)); } }), [key]);
    // Every session is continuable: an AGENT session has a steerable handle in the page's registry
    // (say/run/cancel); a plain CHAT session continues via its history in the session registry (a fresh turn,
    // or the in-flight fetch aborted). The page routes `sessionSend`/`sessionCancel` to whichever it is.
    const agent = s.kind === "agent";
    const running = s.status === "pending";
    const empty = !text.trim() && !att.imgs.length;   // an IMAGE-only send is allowed
    const stop = running && empty;   // in-flight + empty box → the button cancels the run/turn (Claude-Code style)
    const cancel = () => services().cancelSession(s.hash);
    const send = () => {
        const t = text.trim();
        if (!t && !att.imgs.length) return;
        const imgs = att.imgs;
        setText(""); att.clear();
        void sendHeld(key, t, imgs, () => services().sendToSession(key, t, imgs));
    };
    const act = () => (stop ? cancel() : send());
    // Grow to fit, to a cap — measured from `scrollHeight`, which needs the height reset first or it only ever
    // reports the height it already has.
    const area = useRef<HTMLTextAreaElement>(null);
    const grow = (el: HTMLTextAreaElement | null): void => {
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_H)}px`;
    };
    // Sending empties the box, and an emptied box has to come back to one line on its own.
    useEffect(() => { if (multiline) grow(area.current); }, [text, multiline]);
    // Enter SENDS only — it must NEVER cancel a run (pressing Enter with an empty box while a run is in
    // flight used to hit the Stop path and kill the run out of nowhere). Cancelling is the Stop BUTTON only.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey && !empty) { e.preventDefault(); send(); } };
    // On a NARROW screen the long placeholders wrapped onto a second line of an empty one-line box; the short ones say the
    // same thing a phone can fit.
    const narrow = useNarrowScreen();
    const placeholder = running
        ? (agent ? (narrow ? "Steer, or queue a follow-up…" : "Steer this run, or send to queue a follow-up…") : (narrow ? "Sending…" : "Sending… or stop this turn"))
        : narrow ? "Send a message…" : "Send a message (or paste an image) to continue…";
    return (
        <div class="composer" data-rev={r}>
            <ThumbStrip imgs={att.imgs} loading={att.loading} onRemove={att.remove} />
            <div class="composer-row">
                <input ref={att.fileRef} type="file" accept="image/*" multiple style="display:none"
                    onChange={e => { att.addFiles((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ""; }} />
                <button class="tt cbtn" onClick={() => att.fileRef.current?.click()} aria-label="Attach an image">＋<span class="tt-pop left above" role="tooltip">Attach an image (or paste one into the box)</span></button>
                {/* A PAGE's composer is a box you can write a paragraph in; a panel's is one line, because a
                    drawer beside a page has no room for more. Enter still sends and Shift+Enter still makes a
                    line — that was already true of the key handler, and the single-line `input` was simply
                    unable to show the second line it made. It grows with what is typed, to a cap, and then
                    scrolls: a composer that can take the whole viewport is one you cannot send from. */}
                {multiline
                    ? <textarea ref={area} class="cinput" rows={1} value={text} onKeyDown={onKey} onPaste={att.onPaste} placeholder={placeholder}
                        onInput={(e) => { type((e.target as HTMLTextAreaElement).value); grow(e.target as HTMLTextAreaElement); }} />
                    : <input class="cinput" type="text" value={text} onInput={e => type((e.target as HTMLInputElement).value)} onKeyDown={onKey} onPaste={att.onPaste}
                        placeholder={placeholder} />}
                <button class={`tt cbtn ${stop ? "cstop" : "csend"}`} onClick={act} disabled={!stop && empty} aria-label={stop ? "Stop the run" : "Send"}>
                    {stop ? <IconStop /> : <IconSend />}<span class="tt-pop above" role="tooltip">{stop ? "Stop (cancel)" : running ? "Steer the run" : "Send"}</span>
                </button>
            </div>
            <div class="composer-foot">
                {/* Said once, where it is needed: a box you can write a paragraph in has to say how to send it,
                    and it stops saying so the moment you start typing — by then you have either pressed Enter or
                    you have not. It FADES rather than leaving: the line it stands on holds the box above it up, and
                    removing it dropped the whole composer a line on the first keystroke. */}
                {multiline ? <span class={`chint${text ? " gone" : ""}`} aria-hidden={text ? true : undefined}>Enter to send · Shift+Enter for a new line</span> : null}
                <RunStatsBar s={s} />
                <span class="sp" />
                <UsageBar s={s} />
            </div>
        </div>
    );
}
