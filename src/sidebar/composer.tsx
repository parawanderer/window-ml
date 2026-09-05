// The session composer + its shared bits — drive a live createAgent session from the sidebar/HUD: a
// message routes to the page (via the parent shell/panel) → the handle by hash (STEER a running loop, or
// start a new turn). Includes the shared image-attach hook (file/paste → data URLs) and the thumb-strip /
// element-pill chips, reused by the HUD Spotlight composer. Extracted from app.tsx.
import { useState, useRef, useEffect } from "preact/hooks";
import type { ElementContext } from "../contract";
import { config, rev } from "./store";
import type { Session } from "./store";
import { truncate } from "./format";
import { IconSend, IconStop } from "./icons";
import { clearHighlight, highlightEl } from "./ui-kit";
import { UsageBar } from "./usage";
import { RunStatsBar } from "./agent-detail";

// The session composer: drive a live createAgent session from the sidebar. Sending routes to the page
// (via the parent shell/panel) → the handle by hash: STEER a running loop (say) or start a new turn (run),
// the page deciding from the handle's live state. Claude-Code touch: while a run is IN FLIGHT and the box
// is EMPTY, the submit button becomes a STOP that cancels; type anything and it's a send again.
// Shared image-attach state for BOTH composers (session + Spotlight): a file upload or a clipboard paste
// becomes data URLs, with a `loading` count so the thumb strip can show spinners while FileReader decodes.
export function useImageAttach() {
    const [imgs, setImgs] = useState<string[]>([]);
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

/** THE COMPOSER — where you send the next message into a session: the text box, pasted images, an
 *  element you picked off the page, the model/vision toggles and the run controls. Sending INTO a run is
 *  the one thing that needs a reverse channel, so the DevTools panel routes it through the background. */
export function Composer({ s }: { s: Session }) {
    const r = rev.value;   // subscribe: `s.status` is mutated in place (same ref), so without a signal read this
                           // stateful child won't re-render when the run goes pending/idle → the Stop button.
    const [text, setText] = useState("");
    const att = useImageAttach();
    // Every session is continuable: an AGENT session has a steerable handle in the page's registry
    // (say/run/cancel); a plain CHAT session continues via its history in the session registry (a fresh turn,
    // or the in-flight fetch aborted). The page routes `sessionSend`/`sessionCancel` to whichever it is.
    const agent = s.kind === "agent";
    const running = s.status === "pending";
    const empty = !text.trim() && !att.imgs.length;   // an IMAGE-only send is allowed
    const stop = running && empty;   // in-flight + empty box → the button cancels the run/turn (Claude-Code style)
    const cancel = () => window.parent.postMessage({ __mlSidebarApp: "sessionCancel", hash: s.hash }, "*");
    const send = () => {
        const t = text.trim();
        if (!t && !att.imgs.length) return;
        window.parent.postMessage({ __mlSidebarApp: "sessionSend", hash: s.hash, text: t, images: att.imgs }, "*");
        setText(""); att.clear();
    };
    const act = () => (stop ? cancel() : send());
    // Enter SENDS only — it must NEVER cancel a run (pressing Enter with an empty box while a run is in
    // flight used to hit the Stop path and kill the run out of nowhere). Cancelling is the Stop BUTTON only.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey && !empty) { e.preventDefault(); send(); } };
    const placeholder = running ? (agent ? "Steer this run, or send to queue a follow-up…" : "Sending… or stop this turn")
        : "Send a message (or paste a screenshot) to continue…";
    return (
        <div class="composer" data-rev={r}>
            <ThumbStrip imgs={att.imgs} loading={att.loading} onRemove={att.remove} />
            <div class="composer-row">
                <input ref={att.fileRef} type="file" accept="image/*" multiple style="display:none"
                    onChange={e => { att.addFiles((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ""; }} />
                <button class="tt cbtn" onClick={() => att.fileRef.current?.click()} aria-label="Attach an image">＋<span class="tt-pop left above" role="tooltip">Attach an image (or paste a screenshot into the box)</span></button>
                <input class="cinput" type="text" value={text} onInput={e => setText((e.target as HTMLInputElement).value)} onKeyDown={onKey} onPaste={att.onPaste}
                    placeholder={placeholder} />
                <button class={`tt cbtn ${stop ? "cstop" : "csend"}`} onClick={act} disabled={!stop && empty} aria-label={stop ? "Stop the run" : "Send"}>
                    {stop ? <IconStop /> : <IconSend />}<span class="tt-pop above" role="tooltip">{stop ? "Stop (cancel)" : running ? "Steer the run" : "Send"}</span>
                </button>
            </div>
            <div class="composer-foot">
                <RunStatsBar s={s} />
                <span class="sp" />
                <UsageBar s={s} />
            </div>
        </div>
    );
}
