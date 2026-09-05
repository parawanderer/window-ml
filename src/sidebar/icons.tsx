/** A wrench — server-side tools. */
export const IconTools = () => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
        <path d="M9.6 3.4a2.6 2.6 0 0 1 3.5 3.3L7 12.8a1.7 1.7 0 0 1-2.4-2.4l5.6-5.6" />
        <path d="M3 3l2.2 2.2M2 6.2l2.2-2.2" stroke-linecap="round" />
    </svg>
);
// Shared inline SVG icons for the debug sidebar — crisp at any scale, and
// `currentColor` so they inherit the surrounding text color. Pure, no deps.

/** Copy to clipboard. */
export const IconCopy = () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4">
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
        <path d="M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" />
    </svg>
);
/** A tick — the confirmation a copy button swaps to. */
export const IconCheck = () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7">
        <path d="M3 8.5l3.5 3.5L13 4.5" />
    </svg>
);
// Warning triangle (an SVG — the native ⚠ emoji renders inconsistently and off-baseline).
export const IconWarn = () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 2 15 14H1z" />
        <path d="M8 6.3v3.4" />
        <path d="M8 12h0.01" />
    </svg>
);
// Disclosure chevron (the ▸ glyph renders tiny; an SVG is crisp and scalable).
export const IconChevron = () => (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.9">
        <path d="M6 3.5L10.5 8L6 12.5" />
    </svg>
);
/** Settings. */
export const IconGear = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
        <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
);
// Export — Heroicons "arrow-down-tray" (MIT, https://heroicons.com).
export const IconExport = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
    </svg>
);
/** A trace line — the VRAM / resource monitor. */
export const IconVram = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 12h4l2 5 4-13 3 8h5" />
    </svg>
);
// Send — Heroicons "paper-airplane" (MIT). For the composer's submit button.
export const IconSend = () => (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 12 3.27 4.36a.6.6 0 0 1 .82-.74l16.2 7.83a.6.6 0 0 1 0 1.08l-16.2 7.83a.6.6 0 0 1-.82-.74L6 12Zm0 0h6" />
    </svg>
);
// Stop — a filled rounded square. The composer's submit button becomes this while a run is in
// flight and the box is empty (Claude-Code style): clicking it cancels the run.
export const IconStop = () => (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" stroke="none">
        <rect x="5" y="5" width="14" height="14" rx="2.5" />
    </svg>
);
// Terminal `>_` — the python debug bench (run scripts against the model's sandbox).
export const IconBench = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="m5 8 4 4-4 4M12 16h7" />
    </svg>
);
// Usage gauge — a half-dial with a needle. Marks the context-usage bar.
export const IconUsage = () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2.5 12a5.5 5.5 0 1 1 11 0" />
        <path d="M8 12 11 7" />
    </svg>
);
// Eye / eye-off — the composer's per-call native-vision toggle (Heroicons "eye" / "eye-slash", MIT).
export const IconEye = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
        <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
);
/** Vision OFF — the composer's per-call native-vision toggle, struck through. */
export const IconEyeOff = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3.98 8.223A10.477 10.477 0 0 0 2.036 11.68a1.012 1.012 0 0 0 0 .639C3.423 16.49 7.36 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.243 4.243L9.88 9.88" />
    </svg>
);
// A brain — FOCUS MODE. The eye it replaces was borrowed from the composer's vision toggle and said the
// wrong thing here: this mode is not about seeing more or less, it is about reading. Same family as the rest
// (24-box stroke outline, 1.6 weight). A SIDE PROFILE with two folds and a stem: the symmetric
// two-lobe view read as a pair of brackets at 16px, where a profile still resolves as a brain.
export const IconBrain = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 11.6c0-4.4-3.6-8-8-8-3.7 0-6.9 2.6-7.7 6.1C3.1 10.4 2 11.9 2 13.7c0 1.8 1.2 3.4 2.9 3.9.4 2 2.2 3.5 4.3 3.5h1.6v2.4" />
        <path d="M20 11.6c1.2.6 2 1.9 2 3.3 0 2.1-1.7 3.8-3.8 3.8h-1.4" />
        <path d="M11.2 7.3c2.1.7 3 2.5 2.6 5.2" />
        <path d="M5.9 13.9c2.4-.8 4.2.1 5.2 2.6" />
    </svg>
);
// A spreadsheet grid — the smart-chip icon for a Google Sheet reference.
export const IconSheet = () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4">
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
        <path d="M2.5 6.5h11M2.5 10h11M6.5 6.5v7" stroke-width="1.2" />
    </svg>
);


// The bench's shape controls. Text glyphs (⤢ ⤡ ✕) sized off the FONT, so they sat wrong next to the 16px
// stroke icons beside them in the same button container — same family, same box, same weight fixes it.
/** Arrows OUT — take the bench full-page. */
export const IconExpand = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 4H4v5M4 4l6 6M15 4h5v5M20 4l-6 6M9 20H4v-5M4 20l6-6M15 20h5v-5M20 20l-6-6" />
    </svg>
);
/** Arrows IN — dock it back to the drawer. */
export const IconCollapse = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 9h5V4M4 4l5 5M20 9h-5V4M20 4l-5 5M4 15h5v5M4 20l5-5M20 15h-5v5M20 20l-5-5" />
    </svg>
);
/** Close. */
export const IconClose = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
        <path d="M6 6l12 12M18 6L6 18" />
    </svg>
);

// The token readout's two directions. A single ↕ said "tokens" and left which-way-is-which to the words
// beside it; two arrows say it at a glance, which is the whole job of a figure you read in passing. SVGs
// rather than the ↓/↑ glyphs for the reason IconWarn gives: a text arrow sizes off the font and sits off
// the baseline next to a number set in tabular figures.
/** Arrow down — tokens going IN to the model (the prompt). */
export const IconIn = () => (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 3v9M4.5 8.5 8 12l3.5-3.5" />
    </svg>
);
/** Arrow up — tokens coming OUT of the model (what it generated). */
export const IconOut = () => (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 13V4M4.5 7.5 8 4l3.5 3.5" />
    </svg>
);

/** SEND TO THE MODEL — an arrow leaving into a speech bubble: the script goes OUT of the bench and becomes a
 *  turn. Deliberately not a paper plane, which every compose box in the world already uses for "send this
 *  message" — this is handing work to the model, not posting what you typed. Same stroke family and box as
 *  the rest of the bench header. */
export const IconSendToModel = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12.5 20h5a2.5 2.5 0 0 0 2.5-2.5v-6A2.5 2.5 0 0 0 17.5 9H11" />
        <path d="M14 6 17 9l-3 3" />
        <path d="M4 20V6.5A2.5 2.5 0 0 1 6.5 4H9" />
    </svg>
);

/** RUN — an OUTLINE triangle, the shape every IDE uses for it (PyCharm's is the reference). A solid green
 *  block was the first attempt and read as a call-to-action button dropped into a row of quiet icons; the
 *  colour belongs on the GLYPH, which says "run" without shouting over the four controls beside it. Same
 *  stroke family and box as the rest of the row. */
export const IconPlay = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
        <path d="M8.5 5.6 18 12l-9.5 6.4V5.6Z" />
    </svg>
);
