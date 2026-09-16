// The JSON TREE (DevTools-console style), in its own module so the tool renderers (render-panel.tsx) can draw a value
// as a tree without importing agent-detail.tsx, which imports them. Moved here from agent-detail.tsx, which
// re-exports it.
import { useState } from "preact/hooks";
import { IconChevron } from "./icons";
import { TipText } from "./ui-kit";

/** Marks where a CUT-OFF value ended: a JSON value whose text was clipped is drawn as the part that arrived, and this
 *  sentinel, placed as the last member of the innermost container open at the cut, draws a "truncated" row there. */
export const JT_CUT: object = Object.freeze({});

/** How many members an open container draws before a "show more" row, so a returned array of 50,000 rows does not
 *  mount 50,000 rows the moment you expand it. */
export const JT_PAGE = 200;

/** Does the cut marker sit anywhere under `v`? It is always a LAST member, so only the chain of last members is walked,
 *  and a folded container can say "cut" in its preview without drawing its children. */
function holdsCut(v: unknown): boolean {
    for (let n = v, i = 0; n && typeof n === "object" && i < 256; i++) {
        const vals = Array.isArray(n) ? n : Object.values(n);
        const last = vals[vals.length - 1];
        if (last === JT_CUT) return true;
        n = last;
    }
    return false;
}

// A zero-dep collapsible JSON tree (DevTools-console style): objects/arrays fold with a one-line
// preview, primitives render inline + typed. Used to inspect the agent's full tool definitions.
export function jtPreview(v: object): string {
    const cut = holdsCut(v) ? ", cut" : "";
    if (Array.isArray(v)) {
        const n = v.length - (v[v.length - 1] === JT_CUT ? 1 : 0);
        return v.length ? `[ ${n} item${n === 1 ? "" : "s"}${cut} ]` : "[ ]";
    }
    const all = Object.keys(v), keys = all.filter(k => (v as Record<string, unknown>)[k] !== JT_CUT);
    if (!all.length) return "{ }";
    const names = [...keys.slice(0, 4), ...(keys.length > 4 ? ["…"] : []), ...(cut ? ["cut"] : [])];
    return `{ ${names.join(", ")} }`;
}
// A JSON-schema node (as much as we read of it): its own `description`, and children by `properties`
// (object) or `items` (array). Passed alongside a value so JsonNode can annotate keys with their schema
// description — at ANY depth, not just the top level (nested-object args get tooltips too).
export interface JsonSchemaNode { description?: string; properties?: Record<string, JsonSchemaNode>; items?: JsonSchemaNode; }
// A JSON key. When the schema gives it a description, it becomes a hoverable tooltip (same .tt/.tt-pop as
// elsewhere) + a dotted underline so you can tell which keys carry docs — a debugging affordance over raw args.
export function JtKey({ name, desc, unknown }: { name: string; desc?: string; unknown?: boolean }) {
    if (unknown) return <span class="tt jt-key jt-key-unknown" tabIndex={0}>{name}:<span class="tt-pop left" role="tooltip">Not in this tool's parameter schema — likely a hallucinated argument, so the tool will ignore it or error.</span></span>;
    // The description comes from the tool's own JSON Schema, which is written in markdown — backticked
    // identifiers, mostly. Printed raw it showed the backticks, which reads as a rendering that gave up.
    if (desc) return <span class="tt jt-key jt-key-doc" tabIndex={0}>{name}:<span class="tt-pop left" role="tooltip"><TipText md={desc} /></span></span>;
    return <span class="jt-key">{name}:</span>;
}
/** A JSON TREE — the raw args, a tool's parameter schema. Collapsible by default; `allOpen` makes it
 *  non-collapsible at EVERY depth, which is what the raw In view passes so nothing can be folded away
 *  from a Ctrl+F. Keys carry their schema `description` as a tooltip, and one not in the schema is
 *  flagged as a likely hallucinated argument. */
export function JsonNode({ k, v, depth = 0, defaultOpen, schema, desc, unknown, allOpen, cut }: { k?: string; v: unknown; depth?: number; defaultOpen?: boolean; schema?: JsonSchemaNode; desc?: string; unknown?: boolean; allOpen?: boolean; cut?: string }) {
    const branch = !!v && typeof v === "object";
    const [open, setOpen] = useState(allOpen || (defaultOpen ?? depth < 1));   // allOpen → expanded at EVERY depth (the raw In view)
    const [shown, setShown] = useState(JT_PAGE);
    const pad = { paddingLeft: `${depth * 13}px` };
    // Where the text was cut. Its own row, in the container that was still open, so the reader sees exactly
    // which member is the last one that arrived. `cut` is the sentence; the tree's caller writes it.
    if (v === JT_CUT) return <div class="jt-row jt-cut" style={pad}>{cut ?? "… truncated here"}</div>;
    if (!branch) {
        const t = v === null ? "null" : typeof v;
        return <div class="jt-row" style={pad}>
            {k != null ? <JtKey name={k} desc={desc} unknown={unknown} /> : null}
            <span class={`jt-val jt-${t}`}>{typeof v === "string" ? JSON.stringify(v) : String(v)}</span>
        </div>;
    }
    const arr = Array.isArray(v);
    const entries: [string, unknown][] = arr
        ? (v as unknown[]).map((x, i) => [String(i), x])
        : Object.entries(v as Record<string, unknown>);
    // Resolve each child's schema node: an array's elements share `items`; an object's are `properties[key]`.
    const childOf = (ck: string): JsonSchemaNode | undefined => arr ? schema?.items : schema?.properties?.[ck];
    // Only flag "not in schema" when this node's schema actually DEFINES its keys (a real `properties` map) —
    // otherwise we don't know the allowed shape and mustn't false-flag. Arrays have no per-key schema.
    const props = !arr && schema?.properties && typeof schema.properties === "object" ? schema.properties as Record<string, unknown> : null;
    // allOpen (the raw In view) is non-collapsible → drop the chevron, so the opening brace isn't pushed
    // right of the closing one and keys indent cleanly under it.
    const collapsible = !allOpen;
    return <div class="jt-node">
        <div class={`jt-row jt-branch${collapsible ? " jt-clickable" : ""}`} style={pad} role={collapsible ? "button" : undefined} onClick={collapsible ? () => setOpen(o => !o) : undefined}>
            {collapsible ? <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span> : null}
            {k != null ? <JtKey name={k} desc={desc} unknown={unknown} /> : null}
            {open ? <span class="jt-brace">{arr ? "[" : "{"}</span> : <span class="jt-preview">{jtPreview(v as object)}</span>}
        </div>
        {open ? <>
            {/* allOpen (the raw In view) draws every member: it exists so Ctrl+F can reach all of them. */}
            {(allOpen ? entries : entries.slice(0, shown)).map(([ek, ev]) => <JsonNode key={ek} k={arr || ev === JT_CUT ? undefined : ek} v={ev} depth={depth + 1} schema={childOf(ek)} desc={arr ? undefined : childOf(ek)?.description} unknown={!!props && ev !== JT_CUT && !(ek in props)} allOpen={allOpen} cut={cut} />)}
            {!allOpen && entries.length > shown
                ? <div class="jt-row" style={{ paddingLeft: `${(depth + 1) * 13}px` }}><button class="jt-more" onClick={() => setShown(n => n + JT_PAGE)}>show {Math.min(JT_PAGE, entries.length - shown)} more of {entries.length - shown}</button></div>
                : null}
            <div class="jt-row" style={pad}><span class="jt-brace">{arr ? "]" : "}"}</span></div>
        </> : null}
    </div>;
}
