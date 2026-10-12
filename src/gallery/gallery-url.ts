// gallery-url.ts — the component gallery's whole state in its URL (`#/<id>?variant=…&props=…&theme=…&view=…&width=…&tokens=…`),
// so a link reproduces what was on screen and `gallery.mjs shot` can set every toggle from the command line.

/** Every toggle the page has. `props` and `tokens` are null until edited: the variant's own props, no overrides. */
export interface GalleryState {
    id: string;
    variant: string;
    props: unknown | null;
    theme: "light" | "dark" | "system";
    view: "dev" | "calm";
    width: "phone" | "panel" | "desktop" | "full";
    tokens: Record<string, string> | null;
    tab: "props" | "tokens";
    q: string;
}

/** The stage widths, in CSS pixels; `full` is the stage's own width. */
export const WIDTHS: Record<GalleryState["width"], number | null> = { phone: 390, panel: 420, desktop: 1100, full: null };

/** The state a bare URL means: dark, the dev view, full width, no edits. A hash leaves out what equals it. */
export const DEFAULT_STATE: GalleryState = { id: "", variant: "", props: null, theme: "dark", view: "dev", width: "full", tokens: null, tab: "props", q: "" };

/** JSON → base64url, UTF-8 safe. */
export function encodeJson(v: unknown): string {
    const bytes = new TextEncoder().encode(JSON.stringify(v));
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url → JSON, or undefined when it is not. */
export function decodeJson(s: string): unknown {
    try {
        const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
        return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    } catch { return undefined; }
}

const pick = <T extends string>(v: string | null, allowed: readonly T[], fallback: T): T => (allowed as readonly string[]).includes(v ?? "") ? v as T : fallback;

/** Read the state from a location hash. Anything missing or malformed is its default. */
export function parseHash(hash: string): GalleryState {
    const m = /^#\/([^?]*)(?:\?(.*))?$/.exec(hash);
    if (!m) return { ...DEFAULT_STATE };
    const q = new URLSearchParams(m[2] ?? "");
    const props = q.get("props"), tokens = q.get("tokens");
    const decodedTokens = tokens ? decodeJson(tokens) : null;
    return {
        id: decodeURIComponent(m[1]),
        variant: q.get("variant") ?? "",
        props: props ? decodeJson(props) ?? null : null,
        theme: pick(q.get("theme"), ["light", "dark", "system"] as const, DEFAULT_STATE.theme),
        view: pick(q.get("view"), ["dev", "calm"] as const, DEFAULT_STATE.view),
        width: pick(q.get("width"), ["phone", "panel", "desktop", "full"] as const, DEFAULT_STATE.width),
        tokens: decodedTokens && typeof decodedTokens === "object" ? decodedTokens as Record<string, string> : null,
        tab: pick(q.get("tab"), ["props", "tokens"] as const, DEFAULT_STATE.tab),
        q: q.get("q") ?? "",
    };
}

/** Write the state as a hash, leaving out what is at its default so a link stays short. */
export function formatHash(s: GalleryState): string {
    const q = new URLSearchParams();
    if (s.variant) q.set("variant", s.variant);
    if (s.props != null) q.set("props", encodeJson(s.props));
    if (s.theme !== DEFAULT_STATE.theme) q.set("theme", s.theme);
    if (s.view !== DEFAULT_STATE.view) q.set("view", s.view);
    if (s.width !== DEFAULT_STATE.width) q.set("width", s.width);
    if (s.tokens && Object.keys(s.tokens).length) q.set("tokens", encodeJson(s.tokens));
    if (s.tab !== DEFAULT_STATE.tab) q.set("tab", s.tab);
    if (s.q) q.set("q", s.q);
    const qs = q.toString();
    return `#/${encodeURIComponent(s.id)}${qs ? `?${qs}` : ""}`;
}
