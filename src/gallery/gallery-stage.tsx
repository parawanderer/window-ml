// gallery-stage.tsx — the component gallery's stage: one tile per variant, each component inside its own error boundary,
// props built from the JSON plus what JSON cannot say (a recorder for every function prop, a signal where one is
// wanted, the demo world's store), a custom entry mounted with its log and timing API, and the render status every tile
// reports (what `gallery.mjs check` and `shot` read). docs/spec/COMPONENT_GALLERY.md.

import { Component, h, type ComponentChildren, type FunctionComponent } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import type { EntryApi, GalleryEntry, GalleryVariant, ManifestComponent, MountedEntry, PropSchema } from "./gallery-entry";
import type { TimePoint } from "../sidebar/settings/time-chart";

/** One row of the gallery: a generated component or a custom entry, with its variants. */
export interface GalleryItem {
    id: string; title: string; summary: string; groups: string[]; kind: "component" | "custom";
    component?: ManifestComponent; entry?: GalleryEntry; variants: GalleryVariant[];
}

/** How a tile's render went. `empty` is a render that put nothing on the page. */
export interface RenderStatus { state: "pending" | "ok" | "error" | "empty"; error?: string }

/** Every tile's status, keyed `id::variant`: the left list's marks, and what the CLI reads. */
export const statuses = signal<Record<string, RenderStatus>>({});   // state: ui
/** The calls the shown component made to its function props, newest last. */
export const calls = signal<string[]>([]);   // state: ui
/** The custom entry's log lines and timing points. */
export const entryLog = signal<{ t: number; text: string }[]>([]);   // state: ui
export const entryPoints = signal<TimePoint[]>([]);   // state: ui

/** The key a tile's render status is stored under: the entry and the variant. */
export const statusKey = (id: string, variant: string) => `${id}::${variant}`;
function report(key: string, s: RenderStatus): void {
    if (statuses.peek()[key]?.state === s.state && statuses.peek()[key]?.error === s.error) return;
    statuses.value = { ...statuses.peek(), [key]: s };
}

/** What a JSON value cannot carry and the page fills in: the demo world's objects, named by a `$` string. */
export interface StageContext { refs: Record<string, unknown> }

/** A short, single-line rendering of a call's arguments for the calls list. */
function argText(args: unknown[]): string {
    return args.map((a) => {
        if (a instanceof Event) return a.type;
        try { const s = JSON.stringify(a); return s && s.length > 40 ? `${s.slice(0, 40)}…` : String(s); } catch { return typeof a; }
    }).join(", ");
}

/** Props for a component from its JSON: `$name` strings resolved from the context, a recorder for each function prop
 *  the JSON leaves out, and a signal around each value whose type is a signal. */
export function buildProps(schema: PropSchema, json: unknown, ctx: StageContext): Record<string, unknown> {
    const resolve = (v: unknown): unknown => {
        if (typeof v === "string" && v.startsWith("$") && v.slice(1) in ctx.refs) return ctx.refs[v.slice(1)];
        // `{"$h": [tag, props?, ...children]}`: ELEMENTS from JSON, for a node prop that needs more than text.
        if (v && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as { $h?: unknown }).$h)) {
            const [tag, ...rest] = (v as { $h: unknown[] }).$h;
            const attrs = rest[0] && typeof rest[0] === "object" && !Array.isArray(rest[0]) && !("$h" in (rest[0] as object)) ? rest.shift() as Record<string, unknown> : {};
            return h(String(tag), attrs, ...(rest.map(resolve) as ComponentChildren[]));
        }
        if (Array.isArray(v)) return v.map(resolve);
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
        return v;
    };
    const out = (resolve(json && typeof json === "object" ? json : {}) ?? {}) as Record<string, unknown>;
    for (const f of schema.fields ?? []) {
        if (f.schema.kind === "function" && out[f.name] == null) {
            out[f.name] = (...args: unknown[]) => { calls.value = [...calls.peek().slice(-49), `${f.name}(${argText(args)})`]; };
        }
        if (f.schema.kind === "signal" && f.name in out) out[f.name] = signal(out[f.name]);
        if (f.schema.kind === "set" && Array.isArray(out[f.name])) out[f.name] = new Set(out[f.name] as unknown[]);
        if (f.schema.kind === "map" && out[f.name] && typeof out[f.name] === "object") out[f.name] = new Map(Object.entries(out[f.name] as object));
    }
    return out;
}

/** Catches a render error in one tile, so one broken component leaves the page and its neighbours alone. */
class Boundary extends Component<{ onError: (e: unknown) => void; children: ComponentChildren }, { error: unknown }> {
    override state = { error: null as unknown };
    override componentDidCatch(error: unknown) { this.setState({ error }); this.props.onError(error); }
    override render() {
        const e = this.state.error;
        if (e) return <pre class="gl-err">{e instanceof Error ? `${e.name}: ${e.message}` : String(e)}</pre>;
        return this.props.children;
    }
}

/** A generated component, loaded from its module and rendered with built props. */
export function ComponentTile({ item, variant, json, loader, ctx }: {
    item: GalleryItem; variant: GalleryVariant; json: unknown;
    loader: (() => Promise<Record<string, unknown>>) | undefined; ctx: StageContext;
}) {
    const key = statusKey(item.id, variant.name), c = item.component!;
    const [mod, setMod] = useState<{ comp?: FunctionComponent<Record<string, unknown>>; error?: string } | null>(null);
    const host = useRef<HTMLDivElement>(null);
    useEffect(() => {
        let live = true;
        report(key, { state: "pending" });
        if (variant.error) { setMod({ error: variant.error }); return; }
        if (!loader) { setMod({ error: `no loader for ${c.file}` }); return; }
        loader().then((m) => {
            if (!live) return;
            const comp = m[c.name];
            setMod(typeof comp === "function" ? { comp: comp as FunctionComponent<Record<string, unknown>> } : { error: `${c.file} does not export ${c.name}` });
        }, (e: unknown) => live && setMod({ error: `import failed: ${e instanceof Error ? e.message : e}` }));
        return () => { live = false; };
    }, [c.file, c.name]);
    // After each render settles: did it throw, put nothing on the page, or work?
    useEffect(() => {
        if (!mod) return;
        if (mod.error) { report(key, { state: "error", error: mod.error }); return; }
        if (variant.error) { report(key, { state: "error", error: variant.error }); return; }
        const t = setTimeout(() => {
            const el = host.current;
            if (!el || el.querySelector(".gl-err")) return;
            const blank = !el.textContent?.trim() && !el.querySelector("svg, canvas, img, input, button, textarea, select, [style*=background], [class]");
            // Blank is EXPECTED of a `none` variant and of a flow variant before its flow has run.
            report(key, blank && variant.source !== "none" && !variant.flow ? { state: "empty", error: "rendered nothing" } : { state: "ok" });
        }, 50);
        return () => clearTimeout(t);
    });
    if (!mod) return <div class="gl-pending">loading…</div>;
    if (mod.error || variant.error) return <pre class="gl-err">{mod.error ?? variant.error}</pre>;
    const Comp = mod.comp!;
    return (
        <div ref={host} class="gl-host">
            <Boundary key={JSON.stringify(json)} onError={(e) => report(key, { state: "error", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) })}>
                <Comp {...buildProps(c.props, json, ctx)} />
            </Boundary>
        </div>
    );
}

/** The API a mounted custom entry reports through: log lines, and timing samples gathered per animation frame. */
export function entryApi(onProps: (next: unknown) => void): EntryApi {
    let point: TimePoint | null = null;
    const flush = () => {
        if (!point) return;
        entryPoints.value = [...entryPoints.peek().slice(-239), point];
        point = null;
    };
    return {
        setProps: onProps,
        log: (text) => { entryLog.value = [...entryLog.peek().slice(-499), { t: Date.now(), text }]; },
        metric: (phase, ms) => {
            if (!point) { point = { t: Date.now(), values: {} }; requestAnimationFrame(flush); }
            point.values[phase] = (point.values[phase] ?? 0) + ms;
        },
    };
}

/** A custom entry, mounted into a plain element: mounted once per entry, updated in place as its props change. */
export function CustomTile({ item, variant, json, onProps }: { item: GalleryItem; variant: GalleryVariant; json: unknown; onProps: (next: unknown) => void }) {
    const el = useRef<HTMLDivElement>(null);
    const mounted = useRef<MountedEntry | null>(null);
    const latest = useRef(onProps);
    latest.current = onProps;
    const key = statusKey(item.id, variant.name);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        entryLog.value = []; entryPoints.value = [];
        report(key, { state: "pending" });
        try {
            mounted.current = item.entry!.mount(el.current!, json, entryApi((next) => latest.current(next)));
            report(key, { state: "ok" });
        } catch (e) {
            const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
            setError(msg);
            report(key, { state: "error", error: msg });
        }
        return () => { mounted.current?.destroy(); mounted.current = null; };
    }, [item.id, variant.name]);
    useEffect(() => {
        try { mounted.current?.update(json); } catch (e) { report(key, { state: "error", error: e instanceof Error ? e.message : String(e) }); }
    }, [JSON.stringify(json)]);
    return <div class="gl-host gl-custom" ref={el}>{error ? <pre class="gl-err">{error}</pre> : null}</div>;
}
