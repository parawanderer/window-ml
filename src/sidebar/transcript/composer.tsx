// The session composer + its shared bits — drive a live createAgent session from the sidebar/HUD: a
// message routes to the page (via the parent shell/panel) → the handle by hash (STEER a running loop, or
// start a new turn). Includes the shared image-attach hook (file/paste → data URLs) and the thumb-strip /
// element-pill chips, reused by the HUD Spotlight composer. Extracted from app.tsx.
import { useState, useRef, useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { services } from "../services";
import { loadDraft, loadDraftFiles, loadDraftImages, onDraftRestored, saveDraft, saveDraftFiles, saveDraftImages, sendHeld } from "../drafts";
import { config, rev } from "../store";
import type { Session } from "../store";
import { IconSend, IconStop } from "../icons";
import { ClickableImg } from "../ui-kit";
import { FilePill } from "./user-text";
import { FILE_READ_MAX_BYTES, TEXT_FILE_ACCEPT, decodeTextFile, fileInfo, fileSummary, pendingRefusals, tooLarge, type FileTarget } from "../../attached-files";
import type { AttachedFile } from "../../contract/contract-run";
import { UsageBar } from "./usage";
import { SpendChip } from "./spend";
import { RunStatsBar } from "./agent-detail";

/** How tall a multiline composer may grow before it scrolls instead: a box that can take the whole
 *  viewport is one you cannot send from. */
const COMPOSER_MAX_H = 180;

// The session composer: drive a live createAgent session from the sidebar. Sending routes to the page
// (via the parent shell/panel) → the handle by hash: STEER a running loop (say) or start a new turn (run),
// the page deciding from the handle's live state. Claude-Code touch: while a run is IN FLIGHT and the box
// is EMPTY, the submit button becomes a STOP that cancels; type anything and it's a send again.
/** A file waiting in a box. `text` is its decoded text; a refused file has none, or has `why`/`tooBig` instead. */
export interface PendingFile { name: string; type: string; text?: string; /** refused: not a text file, or this runtime takes no files */ why?: string; /** refused unread: its size in bytes */ tooBig?: number }
/** What a box needs to take text files: where the message goes, whether the runtime takes them, what the draft held. */
export interface FileAttachOpts { target: () => FileTarget; accepts: () => boolean; initial?: () => AttachedFile[] }

/**
 * THE ATTACH STATE of a box, shared by BOTH composers (session and Spotlight) and the start page: a file upload, a
 * clipboard paste or a drop becomes data URLs for images, with a `loading` count so the thumb strip can show spinners
 * while FileReader decodes.
 *
 * With `opts.files` it also takes TEXT FILES (docs/spec/FILE_ATTACHMENTS.md, slice 1): read as UTF-8 one after another,
 * and kept as `docs` beside the images, each with the reason it will not be sent when it is refused. The composer sends
 * `sendable`; a refused file stays in the box with its reason until it is removed.
 * @param initial the images the box starts with (a draft)
 * @param opts `files`: where the message goes, whether the runtime takes files, and the files the draft held
 */
export function useImageAttach(initial?: () => string[], opts?: { files: FileAttachOpts }) {
    const [imgs, setImgs] = useState<string[]>(initial ?? []);
    const [docs, setDocs] = useState<PendingFile[]>(() => opts?.files.initial?.() ?? []);
    const [loading, setLoading] = useState(0);
    const fileRef = useRef<HTMLInputElement>(null);
    const fileOpts = opts?.files;
    const addDoc = async (f: File): Promise<void> => {
        if (!fileOpts?.accepts()) { setDocs(a => [...a, { name: f.name, type: f.type, why: `${f.name} cannot be sent: this runtime does not take files yet` }]); return; }
        if (f.size >= FILE_READ_MAX_BYTES) { setDocs(a => [...a, { name: f.name, type: f.type, tooBig: f.size }]); return; }
        try {
            const r = decodeTextFile(f.name, f.type, new Uint8Array(await f.arrayBuffer()));
            setDocs(a => [...a, r.ok ? { name: r.file.name, type: r.file.type, text: r.file.text } : { name: f.name, type: f.type, why: r.reason }]);
        } catch { setDocs(a => [...a, { name: f.name, type: f.type, why: `${f.name} could not be read` }]); }
    };
    const addFiles = (files: FileList | File[] | null | undefined) => {
        const all = [...(files || [])].filter(f => !!f);
        const list = all.filter(f => f.type.startsWith("image/"));
        const other = fileOpts ? all.filter(f => !f.type.startsWith("image/")) : [];
        if (!list.length && !other.length) return;
        setLoading(n => n + list.length + other.length);
        for (const f of list) {
            const rd = new FileReader();
            rd.onload = () => { const url = String(rd.result || ""); if (url.startsWith("data:image/")) setImgs(a => [...a, url]); setLoading(n => Math.max(0, n - 1)); };
            rd.onerror = () => setLoading(n => Math.max(0, n - 1));
            rd.readAsDataURL(f);
        }
        // One after another, so the pills come in the order the files were attached.
        void (async () => { for (const f of other) { await addDoc(f); setLoading(n => Math.max(0, n - 1)); } })();
    };
    // Paste a screenshot straight into the box (the common flow). Returns true when it consumed an image
    // (so the caller can preventDefault); false lets a normal text paste through.
    const onPaste = (e: ClipboardEvent): void => {
        const files = [...(e.clipboardData?.items || [])].filter(it => it.kind === "file" && (fileOpts || it.type.startsWith("image/"))).map(it => it.getAsFile()).filter(Boolean) as File[];
        if (!files.length) return;
        e.preventDefault();
        addFiles(files);
    };
    // Files dragged onto the box. Anything else dragged (text, a link) keeps the browser's own behaviour.
    const onDragOver = (e: DragEvent): void => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); };
    const onDrop = (e: DragEvent): void => {
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        addFiles(e.dataTransfer.files);
    };
    // Why each pending file is refused (null: it will be sent). Derived on every render, so switching a start page from
    // a chat to an agent run changes the wording, and removing a file frees the room it took.
    const target = fileOpts?.target() ?? "chat";
    const fits = pendingRefusals(docs.filter(d => d.text !== undefined) as AttachedFile[], target);
    let k = 0;
    const reasons = docs.map((d): string | null => d.why ?? (d.tooBig != null ? tooLarge(d.name, d.tooBig, false, target) : fits[k++] ?? null));
    const sendable: AttachedFile[] = docs.filter((d, i) => d.text !== undefined && !reasons[i]).map(d => ({ name: d.name, type: d.type, text: d.text! }));
    return {
        imgs, setImgs, loading, addFiles, onPaste, onDragOver, onDrop, fileRef,
        docs, setDocs, reasons, sendable, canFiles: !!fileOpts, acceptsFiles: !!fileOpts?.accepts(), fileAccept: fileOpts?.accepts() ? `image/*,${TEXT_FILE_ACCEPT}` : "image/*",
        remove: (i: number) => setImgs(a => a.filter((_, j) => j !== i)),
        removeDoc: (i: number) => setDocs(a => a.filter((_, j) => j !== i)),
        clear: () => { setImgs([]); setDocs([]); },
    };
}

/** The text files waiting in a box, as pills with their reasons: a refused one says why and is not sent. */
export function FileStrip({ docs, reasons, onRemove }: { docs: PendingFile[]; reasons: (string | null)[]; onRemove: (i: number) => void }) {
    if (!docs.length) return null;
    return (
        <div class="cfiles">
            {docs.map((d, i) => (
                <FilePill key={`${i}${d.name}`} summary={d.text !== undefined ? fileSummary(fileInfo({ name: d.name, type: d.type, text: d.text })) : d.name}
                    refusal={reasons[i]} onRemove={() => onRemove(i)} />
            ))}
        </div>
    );
}

// The attached-image thumbnail strip: previews with an × to remove, plus spinner placeholders for
// in-flight decodes. Renders nothing when there are no images and nothing decoding. A thumbnail opens full size
// on click, as a sent image does (`ClickableImg`), so what is about to be sent can be checked before sending.
export function ThumbStrip({ imgs, loading, onRemove }: { imgs: string[]; loading: number; onRemove: (i: number) => void }) {
    if (!imgs.length && !loading) return null;
    return (
        <div class="cthumbs">
            {imgs.map((src, i) => (
                <div class="cthumb" key={i}>
                    <ClickableImg src={src} alt="attachment" />
                    <button class="cthumb-x" onClick={() => onRemove(i)} aria-label="Remove image" title="Remove">×</button>
                </div>
            ))}
            {Array.from({ length: loading }, (_, i) => <div class="cthumb cthumb-load" key={`l${i}`}><span class="cspin" /></div>)}
        </div>
    );
}

/** Slack before a stacked box goes back to one row: the text must fit the inline width with this much to spare, so a
 *  line right at the edge does not flip the layout on every keystroke. */
const UNSTACK_SLACK_PX = 12;

/**
 * Should this box STACK: the text across the full width, the controls on a row under it? As Gemini's does, once what
 * is typed no longer fits on one line beside the controls, so a paragraph is written in a wide box rather than a
 * narrow column. It goes back to one row when the text would fit there again (one line, no newline), measured
 * against the width the text had before it stacked, with {@link UNSTACK_SLACK_PX} to spare.
 *
 * @param area the textarea
 * @param text what is in it (the hook re-measures when it changes)
 * @param on off where the box is a one-line input, so nothing is measured
 */
export function useStackOnWrap(area: { current: HTMLTextAreaElement | null }, text: string, on: boolean): boolean {
    const [stacked, setStacked] = useState(false);
    // The text's width when it last sat in the row, which is the room it gets back by unstacking.
    const inlineW = useRef(0);
    useEffect(() => {
        const el = area.current;
        if (!on || !el) return;
        const cs = getComputedStyle(el);
        const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
        if (!stacked) {
            const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
            const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
            // Only TEXT stacks. An empty textarea's `scrollHeight` counts its wrapped PLACEHOLDER, and an empty stacked box
            // unstacks below, so the two flipped every render (the composer jumped up and down at the widths where the
            // placeholder wraps, as when a window is narrowed towards the phone layout).
            if (text && (text.includes("\n") || el.scrollHeight > padY + line * 1.5)) { inlineW.current = el.clientWidth - padX; setStacked(true); }
            return;
        }
        if (!text || (!text.includes("\n") && textWidth(text, cs) <= inlineW.current - UNSTACK_SLACK_PX)) setStacked(false);
    }, [text, on, stacked]);
    return on && stacked;
}

/** How wide `text` is on one line in an element's font: a canvas measure, so nothing is laid out to find out. */
let measureCtx: CanvasRenderingContext2D | null = null;   // state: cache
function textWidth(text: string, cs: CSSStyleDeclaration): number {
    measureCtx ??= typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
    if (!measureCtx) return Infinity;
    measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return measureCtx.measureText(text).width;
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
export function Composer({ s, multiline, tools, keys }: { s: Session; multiline?: boolean; tools?: ComponentChildren;
    /** the page's rule for the send hint: has this device shown it knows the keys, and a way to count each use */
    keys?: { learned: boolean; used: (key: "send" | "newline") => void } }) {
    const r = rev.value;   // subscribe: `s.status` is mutated in place (same ref), so without a signal read this
                           // stateful child won't re-render when the run goes pending/idle → the Stop button.
    // THE DRAFT (drafts.ts): what was typed is saved as it is typed and read back when the box is drawn again, and a
    // send that fails puts its text back. Keyed by the session, so each session keeps its own.
    const key = s.hash;
    const [text, setText] = useState(() => loadDraft(key));
    const att = useImageAttach(() => loadDraftImages(key), {
        files: { target: () => (s.kind === "agent" ? "agent" : "chat"), accepts: () => services().acceptsFiles(key), initial: () => loadDraftFiles(key) },
    });
    const type = (t: string) => { setText(t); saveDraft(key, t); };
    // Another session in the same box: its own draft. Not on mount, which `useState` already read: an effect runs after
    // paint, and a keystroke landing before it would be overwritten by what was saved before that keystroke.
    const shown = useRef(key);
    useEffect(() => {
        if (shown.current === key) return;
        shown.current = key;
        setText(loadDraft(key)); att.setImgs(loadDraftImages(key)); att.setDocs(loadDraftFiles(key));
    }, [key]);
    useEffect(() => { saveDraftImages(key, att.imgs); }, [key, att.imgs]);
    // Only files that were READ are a draft: a refused one (not text, too big unread) has no text to keep.
    useEffect(() => { saveDraftFiles(key, att.docs.filter(d => d.text !== undefined).map(d => ({ name: d.name, type: d.type, text: d.text! }))); }, [key, att.docs]);
    useEffect(() => onDraftRestored((k) => { if (k === key) { setText(loadDraft(key)); att.setImgs(loadDraftImages(key)); att.setDocs(loadDraftFiles(key)); } }), [key]);
    // Every session is continuable: an AGENT session has a steerable handle in the page's registry
    // (say/run/cancel); a plain CHAT session continues via its history in the session registry (a fresh turn,
    // or the in-flight fetch aborted). The page routes `sessionSend`/`sessionCancel` to whichever it is.
    const agent = s.kind === "agent";
    // `pending` is THIS client's reduction of the event stream; `stillLive` is the runtime's own reading, and the
    // two disagree whenever a run dies without emitting a terminal event — the client shows pending for ever while
    // the index has moved on, so the stop button stayed and answered "the session is not running" when pressed.
    const running = s.status === "pending" && services().stillLive(s.hash);
    const empty = !text.trim() && !att.imgs.length && !att.sendable.length;   // an IMAGE-only or FILE-only send is allowed
    const stop = running && empty;   // in-flight + empty box → the button cancels the run/turn (Claude-Code style)
    const cancel = () => services().cancelSession(s.hash);
    const send = () => {
        const t = text.trim();
        if (!t && !att.imgs.length && !att.sendable.length) return;
        const imgs = att.imgs, files = att.sendable;
        setText(""); att.clear();
        void sendHeld(key, t, imgs, () => services().sendToSession(key, t, imgs, files), files);
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
    // STACKED once a line would wrap beside the controls (`useStackOnWrap`), and grown again after, since the box is
    // a different width on each side of the switch.
    const stacked = useStackOnWrap(area, text, !!multiline);
    useEffect(() => { if (multiline) grow(area.current); }, [text, multiline, stacked]);
    // Enter SENDS only — it must NEVER cancel a run (pressing Enter with an empty box while a run is in
    // flight used to hit the Stop path and kill the run out of nowhere). Cancelling is the Stop BUTTON only.
    const onKey = (e: KeyboardEvent) => {
        if (e.key !== "Enter") return;
        if (e.shiftKey) { if (multiline) keys?.used("newline"); return; }
        if (!empty) { e.preventDefault(); if (multiline) keys?.used("send"); send(); }
    };
    // Drawn only while the device has not shown it knows the keys; one that learns them here keeps it folded away
    // (`gone`) rather than having it come back each time the box empties.
    const [hintDrawn] = useState(() => !keys?.learned);
    const hintGone = !!text || !!keys?.learned;
    // On a NARROW screen the long placeholders wrapped onto a second line of an empty one-line box; the short ones say the
    // same thing a phone can fit.
    const narrow = useNarrowScreen();
    const placeholder = running
        ? (agent ? (narrow ? "Steer, or queue a follow-up…" : "Steer this run, or send to queue a follow-up…") : (narrow ? "Sending…" : "Sending… or stop this turn"))
        : narrow ? "Send a message…" : `Send a message (or paste ${att.canFiles && att.acceptsFiles ? "an image or a file" : "an image"}) to continue…`;
    return (
        <div class="composer" data-rev={r} onDragOver={att.onDragOver} onDrop={att.onDrop}>
            <ThumbStrip imgs={att.imgs} loading={att.loading} onRemove={att.remove} />
            <FileStrip docs={att.docs} reasons={att.reasons} onRemove={att.removeDoc} />
            <div class={`composer-row${stacked ? " stacked" : ""}`}>
                <input ref={att.fileRef} type="file" accept={att.fileAccept} multiple style="display:none"
                    onChange={e => { att.addFiles((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ""; }} />
                <button class="tt cbtn" onClick={() => att.fileRef.current?.click()} aria-label={att.canFiles ? "Attach a file" : "Attach an image"}>＋<span class="tt-pop left above" role="tooltip">{att.canFiles ? "Attach an image or a text file (or paste or drop one)" : "Attach an image (or paste one into the box)"}</span></button>
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
                {/* What the page puts beside send (the chat page's model picker): the composer draws it, never decides it. */}
                {tools ? <span class="composer-tools">{tools}</span> : null}
                <button class={`tt cbtn ${stop ? "cstop" : "csend"}`} onClick={act} disabled={!stop && empty} aria-label={stop ? "Stop the run" : "Send"}>
                    {stop ? <IconStop /> : <IconSend />}<span class="tt-pop above" role="tooltip">{stop ? "Stop (cancel)" : running ? "Steer the run" : "Send"}</span>
                </button>
            </div>
            <div class="composer-foot">
                {/* Said once, where it is needed: a box you can write a paragraph in has to say how to send it,
                    and it stops saying so the moment you start typing — by then you have either pressed Enter or
                    you have not. It FADES rather than leaving: the line it stands on holds the box above it up, and
                    removing it dropped the whole composer a line on the first keystroke. */}
                {multiline && hintDrawn ? <span class={`chint${hintGone ? " gone" : ""}`} aria-hidden={hintGone ? true : undefined}>Enter to send · Shift+Enter for a new line</span> : null}
                <RunStatsBar s={s} />
                <span class="sp" />
                <UsageBar s={s} />
                <SpendChip s={s} />
            </div>
        </div>
    );
}
