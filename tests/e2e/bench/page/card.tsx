// card.tsx — a section of the sweep page that folds: the page's card, with a chevron in its top-right corner that
// collapses it to its header line. Folded is remembered per card in this browser, so a long timeline someone folded
// stays folded on the next reload or sweep. The summary card at the top never folds; every card after it does.

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { IconChevron } from "../../../../src/sidebar/icons";

const FOLD_KEY = "benchFolded";
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
