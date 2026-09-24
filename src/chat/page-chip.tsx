// page-chip.tsx — THE PAGE A RUN IS WORKING ON, as a chip: its host, and a click that brings that tab forward.
//
// Its own module because both halves of the page draw it — a row in the session list and the header of the session
// itself — and having it live in one of them made the other import from its sibling, which is how the list and the
// pane came to depend on each other in a circle.

import type { SessionSummary } from "../session-host";
import { cursorTipOn } from "../sidebar/ui-kit";

/** A page's host, which is what tells two of someone's tabs apart in one line. Falls back to the whole string,
 *  because a runtime's `page.url` is untrusted input and may not parse. */
function hostOf(url: string): string {
    try { return new URL(url).host || url; } catch { return url; }
}

/**
 * THE TAB A RUN IS DRIVING, said wherever that run is listed or opened.
 *
 * A session on this page can be one of several the agent owns at once, and until now nothing said which: the header
 * read `Work laptop · qwen3:32b`, which names the machine and the model and not the document being acted on. The
 * host is the part that identifies it; the title and the full URL ride the tip, because a URL is long and this sits
 * in a row that already ellipsizes.
 *
 * It is NOT a link. Opening the URL would make a second tab showing the same document, which is precisely not the
 * tab the run holds, and there is no command in the contract for putting an existing one in front.
 */
export function PageChip({ page, onShow }: { page: NonNullable<SessionSummary["page"]>; onShow?: () => void }) {
    const tip = <span><b>{page.title || "the page this run is on"}</b><br />{page.url}{onShow ? <><br /><i>Click to bring that tab to the front.</i></> : null}</span>;
    // WHERE THIS DEVICE CAN ACT ON IT, the chip is the way to the tab. Where it cannot — a runtime on somebody
    // else's machine — it stays what it was: the name of the document, and nothing that pretends to reach it.
    return onShow
        ? <button class="chat-page chat-page-go" data-inline-target {...cursorTipOn(tip)} onClick={onShow}>{hostOf(page.url)}</button>
        : <span class="chat-page" {...cursorTipOn(tip)}>{hostOf(page.url)}</span>;
}
