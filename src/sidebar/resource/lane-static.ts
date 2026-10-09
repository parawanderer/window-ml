// lane-static.ts — what a page with no panel needs to draw the event lane: the panel's own stylesheet rules and theme
// colours, lifted out of sidebar.css, so the bench's pages style a bar with the rules the panel uses rather than a copy.
// The bars themselves are `LaneBars` (lane-bars.tsx), the same component the panel renders.

/** Every top-level rule of a stylesheet, `@media`/`@keyframes` blocks kept whole, comments dropped. */
function cssRules(text: string): string[] {
    const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
    const out: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) { out.push(src.slice(start, i + 1).trim()); start = i + 1; }
    }
    return out;
}

/** The custom properties declared in the first rule whose selector is exactly `selector`. */
function varsOf(rules: string[], selector: string): string {
    const r = rules.find((x) => x.slice(0, x.indexOf("{")).trim() === selector);
    if (!r) return "";
    return [...r.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)].map(([, k, v]) => `${k}:${v.trim()}`).join(";");
}

/** The sidebar's theme colours as declarations: `dark` (its default) and `light`. */
export function themeVars(sidebarCss: string): { dark: string; light: string } {
    const rules = cssRules(sidebarCss);
    return { dark: varsOf(rules, ":root"), light: varsOf(rules, ':root[data-theme="light"]') };
}

/**
 * The stylesheet rules a lane needs, from the sidebar's own (sidebar.css): every rule naming an `rc-ev` bar or an
 * `rc-lane` row and the keyframes they animate with.
 *
 * @param opts.scoped also set the theme colours on `.wml-lane`, dark and then light by `prefers-color-scheme`, for a page
 *   whose own colour variables are not the sidebar's (a run's page); a page built on the sidebar's tokens (the bench
 *   page) sets them itself and passes false
 */
export function laneCss(sidebarCss: string, { scoped = true }: { scoped?: boolean } = {}): string {
    const rules = cssRules(sidebarCss);
    const wanted = /\.rc-ev\b|\.rc-ev-|\.rc-lane-rows?\b/;
    const kept = rules.filter((r) => {
        if (r.startsWith("@keyframes")) return /rc-ev-live|rcEvPulse/.test(r.slice(0, r.indexOf("{")));
        return wanted.test(r.slice(0, r.startsWith("@") ? r.length : r.indexOf("{")));
    });
    const { dark, light } = themeVars(sidebarCss);
    return [
        ...(scoped ? [
            `.wml-lane{${dark};margin:10px 0 18px;font:11px/1.4 ui-sans-serif,system-ui,sans-serif}`,
            `@media (prefers-color-scheme: light){.wml-lane{${light}}}`,
            `.wml-lane .rc-lane-rows{overflow:visible;height:auto}`,
            `.wml-lane-axis{position:relative;height:16px;margin-top:3px;border-top:1px solid var(--border);color:var(--fg-dim)}`,
            `.wml-lane-axis span{position:absolute;top:2px;transform:translateX(-50%);white-space:nowrap}`,
            `.wml-lane-axis span:first-child{transform:none}`,
        ] : []),
        ...kept,
    ].join("\n");
}
