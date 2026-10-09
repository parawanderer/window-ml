// fold-card.tsx — a section of a standalone page that folds: a bordered card with a chevron in its top-right corner that
// collapses it to its header line. Folded is remembered per card in this browser (the storage key is the bench's, where
// it started, so a card folded before the move stays folded). Its rules are page-kit.css's `.card`/`.foldbtn`.

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { IconChevron } from "./icons";

const FOLD_KEY = "benchFolded";   // state: ui

/** Guarded, since a saved report opened from file:// can throw on storage. */
const readFolded = (): string[] => { try { return JSON.parse(localStorage.getItem(FOLD_KEY) || "[]"); } catch { return []; } };

/**
 * A card whose content can be folded away under its header. `id` names it for the remembered state (and is its anchor
 * when `anchor` is set); `label` is what the fold button's tooltip calls it. The content stays mounted while folded, so
 * what it holds (a hover, a scroll position) is still there when it opens.
 */
export function Card({ id, label, anchor, class: cls = "", children }: { id: string; label: string; anchor?: boolean; class?: string; children: ComponentChildren }) {
    const [folded, setFolded] = useState(() => readFolded().includes(id));
    const toggle = () => {
        const next = !folded;
        setFolded(next);
        try { localStorage.setItem(FOLD_KEY, JSON.stringify([...readFolded().filter((x) => x !== id), ...(next ? [id] : [])])); } catch { /* storage off */ }
    };
    return (
        <section class={`card fold${folded ? " folded" : ""}${cls ? ` ${cls}` : ""}`} {...(anchor ? { id } : {})}>
            <button class="foldbtn tt" aria-expanded={!folded} aria-label={`${folded ? "Show" : "Hide"} ${label}`}
                data-tip={folded ? `Show ${label}` : `Hide ${label}: folds it to its title, remembered in this browser`} onClick={toggle}>
                <IconChevron />
            </button>
            {children}
        </section>
    );
}
