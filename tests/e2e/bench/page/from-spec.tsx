// from-spec.tsx — text the page did not write: a spec's name and description, an interview's questions, a model's
// answers. Each is wrapped so a reader can tell it from the page's own labels: the panel's tooltip (the layer app.tsx
// installs reads `data-tip` as plain text, never markup) says where it came from, and a faint tint on hover marks its extent.

import type { ComponentChildren } from "preact";
import type { BenchState } from "./state";

/** Where the sweep's own text came from, for a tip: the spec file when the sweep recorded it. */
export const specSource = (s: BenchState) => (s.spec?.spec ?? "the spec");

/** `children` as text from outside the page, with a tip saying whose. `as` keeps the element the layout needs. */
export function FromSpec({ tip, as: Tag = "span", class: cls = "", children }: { tip: string; as?: "span" | "div" | "p" | "h1"; class?: string; children: ComponentChildren }) {
    return <Tag class={`tt from ${cls}`.trim()} data-tip={tip}>{children}</Tag>;
}
