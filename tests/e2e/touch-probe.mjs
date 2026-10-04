// touch-probe.mjs — WHAT A FINGER CANNOT REACH. A sibling of the tap-target probe in chat-web.spec.mjs, which asks
// whether every button is on screen and big enough; this asks whether anything the page only SAYS on hover is still
// sayable on a screen that has no pointer.
//
// The failure it exists for has a shape: something is built on the web as a tooltip, the same component is drawn in
// the phone's WebView, and the words simply never appear there. Nothing errors, nothing looks broken, and the
// information is just gone. The chat page and the phone app are one product on two screens (mobile/AGENTS.md), so a
// web-only affordance is a defect rather than a difference.
//
// It is only checkable because the affordance MARKS ITSELF: `cursorTipOn` (ui-kit.tsx) stamps `data-tip`, so a tip
// is visible to a query instead of being a few pointer handlers nothing can see.

/**
 * Every visible element on the page whose explanation can only be got with a pointer.
 *
 * An element is reported when it carries a pointer-only explanation (`data-tip` from `cursorTipOn`, or a native
 * `title`) AND offers no other way in. "Another way in" is deliberately generous, because the point is to catch what
 * is UNREACHABLE rather than to litigate taste: being focusable at all counts (a button, a link, anything with a
 * `tabindex` or a role that implies activation), since a control can be tapped and can carry its own name; so does
 * `aria-expanded`, which says a tap opens something; and so does `data-tip-ok`, the explicit opt-out for a tip that
 * only repeats words already on screen.
 *
 * What is left is the real case: a plain `<span>` that holds its content in a tooltip and nothing else.
 */
export async function pointerOnlyInfo(page) {
    return await page.evaluate(() => {
        const REACHABLE = "a,button,summary,input,select,textarea,[role=button],[role=link],[role=menuitem],[role=option],[role=tab],[tabindex],[aria-expanded],[data-tip-ok]";
        const out = [];
        for (const el of document.querySelectorAll("[data-tip],[title]")) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;                 // not drawn here at all: nothing to reach
            if (el.closest(REACHABLE)) continue;
            out.push({
                tag: el.tagName.toLowerCase(),
                cls: typeof el.className === "string" ? el.className : "",
                text: (el.textContent || "").trim().slice(0, 40),
                via: el.hasAttribute("data-tip") ? "cursorTipOn" : "title",
            });
        }
        // `scanned` is what makes a green result MEAN something. Everything here is conditional on finding tips at
        // all, so a page drawn without any — a fixture that never reaches the state, a renamed attribute, a probe
        // run before the view settled — would report no findings and read exactly like a clean surface.
        return { unreachable: out, scanned: document.querySelectorAll("[data-tip],[title]").length };
    });
}

/**
 * The ones already there when this probe was written, each with why it is not fixed yet.
 *
 * A RATCHET rather than a rule, for the reason the repo's other ones are (AGENTS.md): a check that ships red is one
 * people learn to scroll past. New ones fail; these are a list to shorten.
 */
export const KNOWN_POINTER_ONLY = [
    // Empty, and that is a measured result rather than an assumption: the two states the probe reaches draw tips
    // (the test asserts `scanned > 0`, so a green run cannot mean "found nothing to look at") and none of them is
    // unreachable.
    //
    // ONE REAL CASE EXISTS THAT THIS DOES NOT REACH YET. `PageChip` (src/chat/page-chip.tsx), where the device
    // cannot bring that tab to the front, is a plain span naming the HOST while the document's title and full URL
    // ride the tip alone — so on a phone the row says "flights.example" and there is no way to learn which page
    // that is. It shows in the demo world at phone width; this spec's fixture has no page chip, so driving the
    // probe into a state that has one is the next thing to do here, and fixing it is a design question (show the
    // title on a narrow screen, or make the chip open something) rather than a rename.
];

/** A finding that is not already known: what a test asserts is empty. */
export function newPointerOnly(found) {
    return found.filter((f) => !KNOWN_POINTER_ONLY.some((k) => f.via === k.via && (f.cls || "").split(/\s+/).includes(k.cls)));
}
