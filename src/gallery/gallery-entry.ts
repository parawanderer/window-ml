// gallery-entry.ts — the component gallery's two contracts: what the generator (scripts/gallery-gen.mjs) says about each
// component, and what a CUSTOM entry module (`*.gallery.ts(x)`) exports. docs/spec/COMPONENT_GALLERY.md.

/** A prop's type as the generator read it from the checker: enough to build placeholder values and to say what is
 *  allowed. `members` is the resolved list of an enum-like type (a literal union, an enum, `keyof typeof`). */
export interface PropSchema {
    kind: "string" | "number" | "boolean" | "enum" | "node" | "function" | "array" | "object" | "signal" | "set" | "map" | "unknown";
    text: string;
    members?: (string | number | boolean)[];
    of?: PropSchema;
    fields?: { name: string; optional: boolean; doc: string; schema: PropSchema }[];
}

/** One way to show an entry: a name and its props. `source` says who wrote them; `error` is a malformed example. */
export interface GalleryVariant { name: string; props: unknown; source: "example" | "inferred" | "custom"; error?: string }

/** A Preact component as the generator lists it. */
export interface ManifestComponent {
    id: string; kind: "component"; name: string; file: string; line: number; summary: string;
    groups: string[]; tagged: boolean; props: PropSchema; inferred: unknown; variants: GalleryVariant[];
}

/** What an entry can report while it runs: a log line, a timing sample by phase, and props it changed itself. */
export interface EntryApi {
    /** Write back new props (dragging a point on a canvas updates the JSON). */
    setProps(next: unknown): void;
    /** A time-stamped line in the entry's log. */
    log(text: string): void;
    /** One timing sample, in milliseconds, for one phase; samples taken in one frame share a point on the chart. */
    metric(phase: string, ms: number): void;
}

/** A mounted custom entry. */
export interface MountedEntry { update(props: unknown): void; destroy(): void }

/** A custom entry: what is not a Preact component, or needs a harness around it. A `*.gallery.ts(x)` module exports an
 *  array of these as `gallery`, and must not touch the DOM at import (the CLI imports it to list it). */
export interface GalleryEntry {
    id: string;
    title: string;
    summary: string;
    groups?: string[];
    /** The default props, shown as JSON in the sidebar. */
    props: unknown;
    variants?: Record<string, unknown>;
    /** Markdown, shown folded under the stage: what a reader should know before relying on it. */
    notes?: string;
    /** The phases `metric` reports, bottom of the chart first, with a label each. */
    phases?: { key: string; label: string }[];
    mount(el: HTMLElement, props: unknown, api: EntryApi): MountedEntry;
}
