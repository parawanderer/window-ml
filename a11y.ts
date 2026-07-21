// The accessibility surface (the "screen reader" view) used by the `interactives`
// tool. The agent is in a blind user's position — it needs a controls list by
// ROLE + ACCESSIBLE NAME, exactly what NVDA's Elements List / VoiceOver's Rotor
// read. These are pragmatic subsets of the WAI-ARIA accname/role algorithms —
// enough for real controls, not spec-complete. Pure functions of an element +
// browser globals; bundled into injected.js.

export const INTERACTIVE_SEL = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, ' +
    '[role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], ' +
    '[role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="combobox"], ' +
    '[role="slider"], [role="textbox"], [role="searchbox"], [contenteditable="true"], [onclick], ' +
    '[tabindex]:not([tabindex="-1"])';

export const roleOf = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "summary") return "button";
    if (tag === "input") {
        const t = (el.getAttribute("type") || "text").toLowerCase();
        return ({ checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", image: "button", range: "slider", search: "searchbox" } as Record<string, string>)[t] || "textbox";
    }
    if ((el as HTMLElement).isContentEditable) return "textbox";
    return tag;
};

// Accessible name: aria-labelledby → aria-label → alt/label/placeholder/value →
// visible text → title → a nested img alt / svg <title> (icon buttons).
export const accessibleName = (el: Element): string => {
    const norm = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim();
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
        const txt = lb.split(/\s+/).map(id => norm(document.getElementById(id)?.textContent)).filter(Boolean).join(" ");
        if (txt) return txt;
    }
    const al = norm(el.getAttribute("aria-label"));
    if (al) return al;
    const tag = el.tagName.toLowerCase();
    if (tag === "img" || tag === "area") { const alt = norm(el.getAttribute("alt")); if (alt) return alt; }
    if (tag === "input" || tag === "textarea" || tag === "select") {
        if (el.id && typeof CSS !== "undefined") { const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (lab && norm(lab.textContent)) return norm(lab.textContent); }
        const wrap = el.closest("label"); if (wrap && norm(wrap.textContent)) return norm(wrap.textContent);
        const ph = norm(el.getAttribute("placeholder")); if (ph) return ph;
        const val = norm((el as HTMLInputElement).value); if (val) return val;
    }
    const own = norm(el.textContent);
    if (own) return own;
    const title = norm(el.getAttribute("title")); if (title) return title;
    const img = el.querySelector("img[alt]"); if (img && norm(img.getAttribute("alt"))) return norm(img.getAttribute("alt"));
    const svgT = el.querySelector("svg title"); if (svgT && norm(svgT.textContent)) return norm(svgT.textContent);
    return "";
};

// ARIA state suffix a screen reader would announce (disabled/checked/…).
export const ariaState = (el: Element): string => {
    const s: string[] = [];
    if ((el as HTMLInputElement).disabled || el.getAttribute("aria-disabled") === "true") s.push("disabled");
    const checked = el.getAttribute("aria-checked") ?? ((el as HTMLInputElement).type === "checkbox" || (el as HTMLInputElement).type === "radio" ? String((el as HTMLInputElement).checked) : null);
    if (checked === "true") s.push("checked"); else if (checked === "false") s.push("unchecked");
    if (el.getAttribute("aria-pressed") === "true") s.push("pressed");
    if (el.getAttribute("aria-expanded")) s.push(el.getAttribute("aria-expanded") === "true" ? "expanded" : "collapsed");
    if (el.getAttribute("aria-selected") === "true") s.push("selected");
    return s.join(", ");
};

// Visible enough to announce. Rect checks only when layout exists (jsdom has
// none), so the tool still enumerates under test.
export const hasLayout = (): boolean => { try { return document.documentElement.getBoundingClientRect().height > 0; } catch { return false; } };
// "Not there" = display:none / hidden / aria-hidden. Deliberately NOT
// visibility:hidden or opacity:0 — those are how row actions (edit/delete) are
// revealed on hover, and they're still programmatically clickable, so they're
// exactly the controls the agent can't otherwise find. `faded` flags them.
export const styleHidden = (el: Element): boolean => {
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return true;
    try { if (getComputedStyle(el).display === "none") return true; } catch { /* jsdom */ }
    return false;
};
export const isFaded = (el: Element): boolean => {
    try { const cs = getComputedStyle(el); return cs.visibility === "hidden" || +cs.opacity === 0; } catch { return false; }
};
