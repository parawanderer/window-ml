// gallery.tsx — THE COMPONENT GALLERY's page: every component the repo has built, found by the code index and rendered
// live with its props as editable JSON, plus the custom entries (`*.gallery.ts(x)`); a toolbar for every axis the real
// surfaces have (theme, calm/dev view, width), a Tokens tab for theme overrides, and the whole state in the URL so a
// link or `gallery.mjs shot` reproduces it. docs/spec/COMPONENT_GALLERY.md.

import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { components, loaders, custom } from "gallery:manifest";
import type { GalleryVariant, PropSchema } from "./gallery-entry";
import { DEFAULT_STATE, WIDTHS, formatHash, parseHash, type GalleryState } from "./gallery-url";
import { ComponentTile, CustomTile, calls, entryLog, entryPoints, statusKey, statuses, type GalleryItem, type StageContext } from "./gallery-stage";
import { installServices } from "../sidebar/services";
import { installTooltipLayer } from "../sidebar/tooltip-layer";
import { initThemeStyle } from "../sidebar/prefs";
import { markdown } from "../sidebar/format";
import { Disclosure } from "../sidebar/disclosure";
import { TimeChart } from "../sidebar/settings/time-chart";
import { TimedOutput } from "../sidebar/transcript/render-panel";
import { ChatStore } from "../chat/chat-store";
import { demoHost } from "../chat/demo-world";
import { hostServices } from "../chat/host-services";
import { webPlatform } from "../chat/platform";
import { installViewPrefs, setCalm } from "../chat/view-mode";

// AN INERT `chrome`: a component that only runs inside the extension calls `chrome.runtime.sendMessage` and the like on
// render. Here no message is ever answered and storage is empty, so such a component draws its waiting or empty state
// instead of throwing. Never in the chat page's web build, which refuses `chrome.*` (scripts/build-web.mjs).
// A plain Chromium page HAS a `chrome` object (no `runtime`), so the members are filled in, not the object replaced.
const page = globalThis as { chrome?: Record<string, unknown> };
if (!(page.chrome?.runtime as { sendMessage?: unknown } | undefined)?.sendMessage) {
    const listeners = { addListener() { /* inert */ }, removeListener() { /* inert */ }, hasListener: () => false };
    const area = { get: (_k?: unknown, cb?: (v: object) => void) => { cb?.({}); return Promise.resolve({}); }, set: () => Promise.resolve(), remove: () => Promise.resolve(), onChanged: listeners };
    page.chrome = Object.assign(page.chrome ?? {}, {
        runtime: { id: "gallery", sendMessage: () => new Promise(() => { /* never answered */ }), connect: () => ({ postMessage() { /* inert */ }, disconnect() { /* inert */ }, onMessage: listeners, onDisconnect: listeners }), onMessage: listeners, getURL: (p: string) => p, lastError: undefined },
        storage: { local: area, sync: area, session: area, onChanged: listeners },
        tabs: { query: () => Promise.resolve([]), onUpdated: listeners, onActivated: listeners, onRemoved: listeners },
    });
}

// THE DEMO WORLD, as the chat page's web build runs it: components that read `services()` or a store get believable
// data from the same scripted host the chat specs use. `$store` and `$host` in a component's JSON name these.
const host = demoHost(Date.now());
const store = new ChatStore(host);
installServices(hostServices(store, webPlatform));
initThemeStyle();
/** Preferences kept in memory: the URL is this page's state, and a gallery visit must not change the chat page's. */
const memoryPrefs = (() => { const m = new Map<string, unknown>(); return { get: <T,>(k: string) => m.get(k) as T | undefined, set: (k: string, v: unknown) => { m.set(k, v); } }; })();
installViewPrefs(memoryPrefs);
try { installTooltipLayer(document); } catch { /* no DOM */ }
store.start();
const ctx: StageContext = { refs: { store, host } };

/** The page's state, mirrored from the hash. */
const state = signal<GalleryState>(parseHash(location.hash));   // state: ui
/** Set the state; `push` makes a history entry (a new entry picked), anything else replaces (typing in the JSON). */
function setState(patch: Partial<GalleryState>, push = false): void {
    const next = { ...state.peek(), ...patch };
    state.value = next;
    const h = formatHash(next);
    if (push) history.pushState(null, "", h); else history.replaceState(null, "", h);
}
addEventListener("hashchange", () => { state.value = parseHash(location.hash); });

/** Every item: the generated components, then the custom entries once their modules have loaded. */
const items = signal<GalleryItem[]>(components.map((c) => ({   // state: ui
    id: c.id, title: c.name, summary: c.summary, groups: c.groups, kind: "component", component: c, variants: c.variants,
})));
const ready = Promise.all(Object.entries(custom).map(async ([file, load]) => {
    try {
        const mod = await load();
        return mod.gallery.map((e): GalleryItem => ({
            id: e.id, title: e.title, summary: e.summary, groups: e.groups ?? ["custom"], kind: "custom", entry: e,
            variants: e.variants ? Object.entries(e.variants).map(([name, props]) => ({ name, props, source: "custom" as const })) : [{ name: "default", props: e.props, source: "custom" as const }],
        }));
    } catch (e) {
        console.error(`gallery: ${file} failed to load`, e);
        return [{ id: file, title: file, summary: `failed to load: ${e instanceof Error ? e.message : e}`, groups: ["custom"], kind: "custom" as const, variants: [{ name: "default", props: {}, source: "custom" as const, error: String(e) }] }];
    }
})).then((lists) => { items.value = [...lists.flat(), ...items.peek()]; });

/** The variant a state shows: the named one, else the first. */
function currentVariant(item: GalleryItem, s: GalleryState): GalleryVariant {
    return item.variants.find((v) => v.name === s.variant) ?? item.variants[0];
}

/** The theme on `<html>`, and the calm view through the chat page's own switch. */
function useSurface(s: GalleryState): void {
    useEffect(() => {
        const apply = () => {
            const dark = s.theme === "dark" || (s.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
            document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
        };
        apply();
        const mq = matchMedia("(prefers-color-scheme: dark)");
        mq.addEventListener("change", apply);
        return () => mq.removeEventListener("change", apply);
    }, [s.theme]);
    useEffect(() => { setCalm(s.view === "calm"); }, [s.view]);
}

/** Every CSS custom property the stylesheets define on `:root`, in order of first appearance. */
function rootTokens(): string[] {
    const names = new Set<string>();
    for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try { rules = sheet.cssRules; } catch { continue; }
        for (const r of Array.from(rules)) {
            if (!(r instanceof CSSStyleRule) || !/:root|html/.test(r.selectorText)) continue;
            for (let i = 0; i < r.style.length; i++) if (r.style[i].startsWith("--")) names.add(r.style[i]);
        }
    }
    return [...names];
}

/** A segmented control, for the toolbar. */
function Seg<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: readonly T[]; onPick: (v: T) => void }) {
    return (
        <div class="gl-seg" role="group" aria-label={label}>
            <span class="gl-seg-label">{label}</span>
            {options.map((o) => <button key={o} class={o === value ? "on" : ""} aria-pressed={o === value} data-toggle={`${label}:${o}`} onClick={() => onPick(o)}>{o}</button>)}
        </div>
    );
}

/** The left column: search, then the groups with their counts, each entry marked when a variant failed. */
function Nav({ s }: { s: GalleryState }) {
    const st = statuses.value;
    const re = useMemo(() => { try { return new RegExp(s.q, "i"); } catch { return null; } }, [s.q]);
    const shown = items.value.filter((it) => !re || re.test(`${it.title} ${it.summary} ${it.groups.join(" ")}`));
    const groups = new Map<string, GalleryItem[]>();
    for (const it of shown) for (const g of it.groups) groups.set(g, [...(groups.get(g) ?? []), it]);
    return (
        <nav class="gl-nav">
            <input class="gl-search" type="search" placeholder="search name, summary, group (regex)" value={s.q} onInput={(e) => setState({ q: (e.target as HTMLInputElement).value })} />
            <div class="gl-count">{shown.length} of {items.value.length} entries · {groups.size} groups</div>
            {[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([g, list]) => (
                <section key={g} class="gl-group">
                    <h3>{g} <span class="gl-n">{list.length}</span></h3>
                    {list.map((it) => {
                        const bad = it.variants.some((v) => ["error", "empty"].includes(st[statusKey(it.id, v.name)]?.state ?? ""));
                        return (
                            <a key={it.id} href={formatHash({ ...s, id: it.id, variant: "", props: null })} class={`gl-item${it.id === s.id ? " sel" : ""}${bad ? " bad" : ""}`}
                                onClick={(e) => { e.preventDefault(); calls.value = []; setState({ id: it.id, variant: "", props: null }, true); }}>
                                {it.title}{it.kind === "custom" ? <span class="gl-tag">custom</span> : null}{bad ? <span class="gl-tag bad">fails</span> : null}
                            </a>
                        );
                    })}
                </section>
            ))}
        </nav>
    );
}

/** One field of the props schema: its name, type, and the members of an enum-like type as chips that set it. */
function SchemaRow({ name, schema, optional, doc, props }: { name: string; schema: PropSchema; optional: boolean; doc: string; props: Record<string, unknown> }) {
    return (
        <li class="gl-field">
            <code>{name}{optional ? "?" : ""}</code> <span class="gl-kind">{schema.kind}</span>
            <div class="gl-type">{schema.text}</div>
            {doc ? <div class="gl-doc">{doc}</div> : null}
            {schema.members && schema.members.length > 1 ? (
                <div class="gl-members">{schema.members.map((m) => (
                    <button key={String(m)} class={props[name] === m ? "on" : ""} onClick={() => setState({ props: { ...props, [name]: m } })}>{JSON.stringify(m)}</button>
                ))}</div>
            ) : null}
        </li>
    );
}

/** The right column: the props as JSON with the schema under it, or the theme tokens. */
function Side({ s, item, json }: { s: GalleryState; item: GalleryItem; json: unknown }) {
    const [draft, setDraft] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => { setDraft(null); setError(null); }, [s.id, s.variant]);
    const text = draft ?? JSON.stringify(json, null, 2);
    const onJson = (v: string, apply: (parsed: unknown) => void) => {
        setDraft(v);
        try { apply(JSON.parse(v)); setError(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    };
    const tokens = s.tab === "tokens" ? rootTokens() : [];
    const css = getComputedStyle(document.documentElement);
    return (
        <aside class="gl-side">
            <div class="gl-tabs">
                {(["props", "tokens"] as const).map((t) => <button key={t} class={s.tab === t ? "on" : ""} onClick={() => { setDraft(null); setState({ tab: t }); }}>{t === "props" ? "Props" : "Tokens"}</button>)}
            </div>
            {s.tab === "props" ? (
                <>
                    <textarea class="gl-json" spellcheck={false} value={text} onInput={(e) => onJson((e.target as HTMLTextAreaElement).value, (p) => setState({ props: p }))} />
                    {error ? <div class="gl-json-err">{error}</div> : null}
                    <div class="gl-row"><button onClick={() => { setDraft(null); setState({ props: null }); }}>Reset to the variant</button></div>
                    {item.component?.props.fields?.length ? (
                        <Disclosure label="Schema" note={`${item.component.props.fields.length} props`} defaultOpen>
                            <ul class="gl-schema">{item.component.props.fields.map((f) => <SchemaRow key={f.name} {...f} props={(json ?? {}) as Record<string, unknown>} />)}</ul>
                        </Disclosure>
                    ) : null}
                    {calls.value.length ? (
                        <Disclosure label="Calls" note={String(calls.value.length)} defaultOpen>
                            <pre class="gl-calls">{calls.value.join("\n")}</pre>
                        </Disclosure>
                    ) : null}
                </>
            ) : (
                <>
                    <textarea class="gl-json" spellcheck={false} value={draft ?? JSON.stringify(s.tokens ?? {}, null, 2)}
                        onInput={(e) => onJson((e.target as HTMLTextAreaElement).value, (p) => { if (p && typeof p === "object") setState({ tokens: p as Record<string, string> }); })} />
                    {error ? <div class="gl-json-err">{error}</div> : null}
                    <div class="gl-row"><button onClick={() => { setDraft(null); setState({ tokens: null }); }}>Clear overrides</button></div>
                    <ul class="gl-tokens">{tokens.map((t) => {
                        const v = css.getPropertyValue(t).trim();
                        return (
                            <li key={t}><button title="override this token" onClick={() => { setDraft(null); setState({ tokens: { ...(s.tokens ?? {}), [t]: v } }); }}>
                                <span class="gl-swatch" style={{ background: `var(${t})` }} /><code>{t}</code> <span class="gl-tok-v">{v}</span>
                            </button></li>
                        );
                    })}</ul>
                </>
            )}
        </aside>
    );
}

/** The custom entry's log and timing chart. */
function EntryLog({ item }: { item: GalleryItem }) {
    const lines = entryLog.value, points = entryPoints.value;
    const phases = item.entry?.phases ?? [];
    let off = 0;
    const marks: [number, number][] = lines.map((l) => { const m: [number, number] = [off, l.t]; off += l.text.length + 1; return m; });
    const last = points.at(-1);
    return (
        <Disclosure label="Log & timings" note={last ? phases.map((p) => `${p.label} ${(last.values[p.key] ?? 0).toFixed(2)} ms`).join(" · ") : `${lines.length} lines`} defaultOpen>
            {points.length >= 2 ? (
                <TimeChart points={points} label="Per-frame time by phase" height={110}
                    series={phases.map((p, i) => ({ key: p.key, label: p.label, cls: `gl-series-${i % 6}` }))}
                    format={(v) => `${v.toFixed(2)} ms`}
                    formatTime={(t) => new Date(t).toLocaleTimeString()} />
            ) : null}
            {lines.length ? <TimedOutput text={lines.map((l) => l.text).join("\n")} marks={marks} /> : <div class="gl-dim">nothing logged yet</div>}
        </Disclosure>
    );
}

/** The centre: the entry's header, the toolbar, one tile per variant, then its notes and its log. */
function Stage({ s, item }: { s: GalleryState; item: GalleryItem }) {
    const v = currentVariant(item, s);
    const width = WIDTHS[s.width];
    // A custom entry shows only its chosen variant: a WebGL context per tile would run out, and a stress variant
    // redraws continuously.
    const tiles = item.kind === "custom" ? [v] : item.variants;
    return (
        <main class="gl-stage">
            <header class="gl-head">
                <h2>{item.title}</h2>
                <p class="gl-summary" dangerouslySetInnerHTML={{ __html: markdown(item.summary || "(no summary: the JSDoc has no first sentence)") }} />
                <div class="gl-meta">
                    {item.component ? <code>{item.component.file}:{item.component.line}</code> : <code>custom entry</code>}
                    {" · "}{item.groups.map((g) => <span key={g} class="gl-tag">{g}</span>)}
                    {item.component && !item.component.tagged ? <span class="gl-dim"> (group from its folder: add <code>@group</code> to set one)</span> : null}
                </div>
                <div class="gl-toolbar">
                    <Seg label="theme" value={s.theme} options={["light", "dark", "system"] as const} onPick={(t) => setState({ theme: t })} />
                    <Seg label="view" value={s.view} options={["dev", "calm"] as const} onPick={(t) => setState({ view: t })} />
                    <Seg label="width" value={s.width} options={["phone", "panel", "desktop", "full"] as const} onPick={(t) => setState({ width: t })} />
                </div>
                {item.kind === "custom" && item.variants.length > 1 ? (
                    <div class="gl-variants">{item.variants.map((x) => <button key={x.name} class={x.name === v.name ? "on" : ""} onClick={() => setState({ variant: x.name, props: null })}>{x.name}</button>)}</div>
                ) : null}
            </header>
            <div class="gl-tiles" style={s.tokens ?? undefined}>
                {tiles.map((t) => {
                    const sel = t.name === v.name;
                    const json = sel && s.props != null ? s.props : t.props;
                    const st = statuses.value[statusKey(item.id, t.name)];
                    return (
                        <figure key={`${item.id}::${t.name}`} class={`gl-tile${sel ? " sel" : ""}`} data-variant={t.name} data-status={st?.state ?? "pending"}
                            onClick={() => { if (!sel) setState({ variant: t.name, props: null }); }}>
                            <figcaption>{t.name} <span class="gl-dim">{t.source}</span>{st && st.state !== "ok" && st.state !== "pending" ? <span class="gl-tag bad">{st.state}</span> : null}</figcaption>
                            <div class={`gl-frame${s.view === "calm" ? " chat calm" : ""}`} style={width ? { maxWidth: `${width}px` } : undefined}>
                                {item.kind === "custom"
                                    ? <CustomTile item={item} variant={t} json={json} onProps={(p) => setState({ props: p })} />
                                    : <ComponentTile item={item} variant={t} json={json} loader={loaders[item.component!.file]} ctx={ctx} />}
                            </div>
                        </figure>
                    );
                })}
            </div>
            {item.entry?.notes ? <Disclosure label="Notes"><div class="md gl-notes" dangerouslySetInnerHTML={{ __html: markdown(item.entry.notes) }} /></Disclosure> : null}
            {item.kind === "custom" ? <EntryLog item={item} /> : null}
        </main>
    );
}

/** The page. */
function Gallery() {
    const s = state.value;
    useSurface(s);
    const all = items.value;
    const item = all.find((it) => it.id === s.id) ?? all[0];
    if (!item) return <div class="gl-empty">No components found.</div>;
    const v = currentVariant(item, s);
    const json = s.props ?? v.props;
    return (
        <div class="gl">
            <Nav s={s} />
            <Stage s={s} item={item} />
            <Side s={s} item={item} json={json} />
        </div>
    );
}

/** What `gallery.mjs` drives: the item list once custom entries loaded, and every tile's render status. */
(globalThis as { __gallery?: unknown }).__gallery = {
    ready,
    items: () => items.peek().map((it) => ({ id: it.id, title: it.title, kind: it.kind, groups: it.groups, variants: it.variants.map((v) => ({ name: v.name, source: v.source })) })),
    status: (id: string, variant: string) => statuses.peek()[statusKey(id, variant)] ?? null,
    statuses: () => statuses.peek(),
    log: () => entryLog.peek(),
    points: () => entryPoints.peek(),
    defaults: DEFAULT_STATE,
};

render(<Gallery />, document.getElementById("root")!);
