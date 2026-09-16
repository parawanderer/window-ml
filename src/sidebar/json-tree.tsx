// The JSON TREE (DevTools-console style), in its own module so the tool renderers (render-panel.tsx) can draw a value
// as a tree without importing agent-detail.tsx, which imports them. Moved here from agent-detail.tsx, which
// re-exports it.
import { useState } from "preact/hooks";
import { IconChevron } from "./icons";
import { TipText, cursorTipOn } from "./ui-kit";

/** Marks where a CUT-OFF value ended: a JSON value whose text was clipped is drawn as the part that arrived, and this
 *  sentinel, placed as the last member of the innermost container open at the cut, draws a "truncated" row there. */
export const JT_CUT: object = Object.freeze({});

/** Marks where the MODEL's copy of a value ended: the panel keeps more of a value than the model received, and this
 *  sentinel, placed in the container open at that point, draws a "not sent to the model" row there. Members after it
 *  (at every depth up to the root) are drawn dimmed, through the `unsent` map passed to the tree. */
export const JT_SEEN: object = Object.freeze({});

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
export function jtPreview(v: object, unsent = false): string {
    const cut = (holdsCut(v) ? ", cut" : "") + (unsent ? ", partly not sent" : "");
    if (Array.isArray(v)) {
        const n = v.filter(x => x !== JT_CUT && x !== JT_SEEN).length;
        return v.length ? `[ ${n} item${n === 1 ? "" : "s"}${cut} ]` : "[ ]";
    }
    const all = Object.keys(v), keys = all.filter(k => (v as Record<string, unknown>)[k] !== JT_CUT && (v as Record<string, unknown>)[k] !== JT_SEEN);
    if (!all.length) return "{ }";
    const names = [...keys.slice(0, 4), ...(keys.length > 4 ? ["…"] : []), ...(cut ? [cut.slice(2)] : [])];
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
export function JsonNode({ k, v, depth = 0, defaultOpen, schema, desc, unknown, allOpen, cut, unsent, dim }: { k?: string; v: unknown; depth?: number; defaultOpen?: boolean; schema?: JsonSchemaNode; desc?: string; unknown?: boolean; allOpen?: boolean; cut?: string;
    /** Container → index of its first member the model was NOT sent (see JT_SEEN). */ unsent?: WeakMap<object, number>;
    /** This member was not sent to the model: drawn dimmed. */ dim?: boolean }) {
    const branch = !!v && typeof v === "object";
    const [open, setOpen] = useState(allOpen || (defaultOpen ?? depth < 1));   // allOpen → expanded at EVERY depth (the raw In view)
    const [shown, setShown] = useState(JT_PAGE);
    const pad = { paddingLeft: `${depth * 13}px` };
    // Where the text was cut. Its own row, in the container that was still open, so the reader sees exactly
    // which member is the last one that arrived. `cut` is the sentence; the tree's caller writes it.
    const dimCls = dim ? " jt-unsent" : "";
    if (v === JT_CUT) return <div class={`jt-row jt-cut${dimCls}`} style={pad}>{cut ?? "… truncated here"}</div>;
    // Where the MODEL's copy ended. Everything after this row, here and in every enclosing container, it never read.
    if (v === JT_SEEN) return <div class="jt-row jt-seen-end" style={pad}
        {...cursorTipOn("The panel kept more of this value than the tool's output cap let through. The model read up to here, and none of what follows.")}>
        ↓ not sent to the model</div>;
    if (!branch) {
        const t = v === null ? "null" : typeof v;
        return <div class={`jt-row${dimCls}`} style={pad}>
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
    const from = unsent?.get(v as object);
    return <div class={`jt-node${dimCls}`}>
        <div class={`jt-row jt-branch${collapsible ? " jt-clickable" : ""}`} style={pad} role={collapsible ? "button" : undefined} onClick={collapsible ? () => setOpen(o => !o) : undefined}>
            {collapsible ? <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span> : null}
            {k != null ? <JtKey name={k} desc={desc} unknown={unknown} /> : null}
            {open ? <span class="jt-brace">{arr ? "[" : "{"}</span> : <span class="jt-preview">{jtPreview(v as object, from != null)}</span>}
        </div>
        {open ? <>
            {/* allOpen (the raw In view) draws every member: it exists so Ctrl+F can reach all of them. */}
            {(allOpen ? entries : entries.slice(0, shown)).map(([ek, ev], i) => {
                const mark = ev === JT_CUT || ev === JT_SEEN;
                return <JsonNode key={ek} k={arr || mark ? undefined : ek} v={ev} depth={depth + 1} schema={childOf(ek)} desc={arr ? undefined : childOf(ek)?.description} unknown={!!props && !mark && !(ek in props)} allOpen={allOpen} cut={cut}
                    // Only at the boundary: opacity compounds, so a dimmed container's own members are not dimmed again.
                    unsent={unsent} dim={from != null && i >= from} />;
            })}
            {!allOpen && entries.length > shown
                ? <div class="jt-row" style={{ paddingLeft: `${(depth + 1) * 13}px` }}><button class="jt-more" onClick={() => setShown(n => n + JT_PAGE)}>show {Math.min(JT_PAGE, entries.length - shown)} more of {entries.length - shown}</button></div>
                : null}
            <div class="jt-row" style={pad}><span class="jt-brace">{arr ? "]" : "}"}</span></div>
        </> : null}
    </div>;
}
