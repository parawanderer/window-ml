// dock-layout.ts — WHERE each docked panel sits, as data: every edge region holds a tree of tab groups and splits, and
// every way a person rearranges it (a drag, the ⋮ menu) is one pure operation here, so dock.tsx only draws and hit-tests.
//
// - A GROUP is panels shown as tabs, one at a time. A SPLIT lays its children side by side (`row`) or stacked (`col`),
//   each taking a fraction of the room.
// - How deep splits may nest is ONE number, `MAX_SPLIT_DEPTH`, passed to every operation that could deepen the tree.
//   Today it is 1 (a region is a row or a column of groups). The tree, the operations and the renderer are general, so
//   raising it is the whole change for deeper layouts; a test runs the operations at depth 2 to keep that true.
// - The tree holds OPEN panels only. A panel that closes leaves it, and `home` keeps where it was: its edge, and the
//   panel it sat next to and on which side (or that it was a tab beside it). Reopening puts it back there while that
//   neighbour is still docked, and on the edge otherwise. A panel the page does not keep open across a reload (the
//   bench) would otherwise lose its split on every reload.

/** An edge of the reading column a panel can be docked to. */
export type DockSide = "top" | "right" | "bottom" | "left";
/** The panels the page can dock: the box's resource panel, the Python bench, and the open run's execution log. */
export type DockPanelId = "resource" | "bench" | "runlog";

/** Panels shown as tabs, one at a time. */
export interface DockGroup { kind: "group"; tabs: DockPanelId[]; active?: DockPanelId }
/** Children side by side (`row`) or stacked (`col`), child `i` taking `fracs[i]` of the room (they sum to 1). */
export interface DockSplit { kind: "split"; dir: "row" | "col"; children: DockNode[]; fracs: number[] }
/** One node of a region's tree. */
export type DockNode = DockGroup | DockSplit;
/** Child indices from a region's root to a node: `[]` is the root, `[1]` its second child. */
export type DockPath = number[];

/** Where every panel is docked, how big each edge's region is, and which edge a closed panel goes back to. */
export interface DockLayout {
    regions: Partial<Record<DockSide, DockNode>>;
    /** px: a height for top and bottom, a width for left and right */
    size: Record<DockSide, number>;
    home: Partial<Record<DockPanelId, DockHome>>;
}

/** Where a closed panel goes back to: its edge, and the panel it was beside (`near`), on which side or as a tab. */
export interface DockHome { side: DockSide; near?: DockPanelId; at?: DockSide | "tab";
    /** the share of its split it had, so a divider someone dragged is where they left it */
    frac?: number }

/** Where a dragged (or menu-moved) panel lands. */
export type DockTarget =
    /** the region on that edge: a new region if there is none, else a tab of its first group */
    | { kind: "edge"; side: DockSide }
    /** a tab of the group at `path` */
    | { kind: "tab"; side: DockSide; path: DockPath }
    /** a new group on the `at` side of the group at `path` */
    | { kind: "split"; side: DockSide; path: DockPath; at: DockSide };

/** How many splits deep a region may nest. See the header: raising this is the whole change. */
export const MAX_SPLIT_DEPTH = 1;

/** Every edge, in the order a region is looked for when one is needed. */
export const SIDES: readonly DockSide[] = ["top", "right", "bottom", "left"];
/** The graphs across the top, because a timeline is wide and short; the bench underneath, where a drawer is; the
 *  execution log to the RIGHT, because it is read line by line beside the steps it explains. */
export const DEFAULT_HOME: Record<DockPanelId, DockSide> = { resource: "top", bench: "bottom", runlog: "right" };
/** Every panel there is, from the defaults — so a stored layout is validated against the panels that EXIST rather
 *  than against a list written out a second time, which is how the third panel once went unrecognised. */
export const PANEL_IDS = Object.keys(DEFAULT_HOME) as DockPanelId[];

/** A device that has never arranged anything: nothing docked yet, and each region's first size. */
export const DOCK_DEFAULT: DockLayout = { regions: {}, size: { top: 300, bottom: 320, left: 380, right: 420 }, home: {} };

const copy = (l: DockLayout): DockLayout => JSON.parse(JSON.stringify(l));
const group = (id: DockPanelId): DockGroup => ({ kind: "group", tabs: [id], active: id });
const dirOf = (at: DockSide): DockSplit["dir"] => (at === "left" || at === "right" ? "row" : "col");

/** The node at `path`, or null when the path leads nowhere. */
export function nodeAt(root: DockNode | undefined, path: DockPath): DockNode | null {
    let n: DockNode | undefined = root;
    for (const i of path) n = n?.kind === "split" ? n.children[i] : undefined;
    return n ?? null;
}

/** Every group in a tree, in reading order, with its path. */
export function groupsOf(root: DockNode | undefined, path: DockPath = []): { group: DockGroup; path: DockPath }[] {
    if (!root) return [];
    if (root.kind === "group") return [{ group: root, path }];
    return root.children.flatMap((c, i) => groupsOf(c, [...path, i]));
}

/** Which edge and group a panel is in, or null when it is not docked (closed). */
export function findPanel(l: DockLayout, id: DockPanelId): { side: DockSide; path: DockPath; group: DockGroup } | null {
    for (const side of SIDES) {
        for (const g of groupsOf(l.regions[side])) if (g.group.tabs.includes(id)) return { side, ...g };
    }
    return null;
}

/** The visible tab of a group: its `active` when that is one of its tabs, else its first. */
export const activeOf = (g: DockGroup): DockPanelId => (g.active && g.tabs.includes(g.active) ? g.active : g.tabs[0]);

/** A tree with empty groups dropped, a split of one child replaced by that child, a split inside a split of the same
 *  direction merged into it, and fractions summing to 1. Null when nothing is left. */
function prune(n: DockNode): DockNode | null {
    if (n.kind === "group") return n.tabs.length ? n : null;
    const kids: DockNode[] = [], fracs: number[] = [];
    n.children.forEach((c, i) => {
        const p = prune(c);
        if (!p) return;
        const f = n.fracs[i] > 0 ? n.fracs[i] : 1 / n.children.length;
        if (p.kind === "split" && p.dir === n.dir) { p.children.forEach((g, j) => { kids.push(g); fracs.push(f * p.fracs[j]); }); }
        else { kids.push(p); fracs.push(f); }
    });
    if (!kids.length) return null;
    if (kids.length === 1) return kids[0];
    const sum = fracs.reduce((a, b) => a + b, 0);
    return { kind: "split", dir: n.dir, children: kids, fracs: fracs.map((f) => f / sum) };
}

/** Where a panel is now, as a `DockHome`: beside another tab of its group, else beside the group next to it. */
function homeOf(l: DockLayout, at: { side: DockSide; path: DockPath; group: DockGroup }, id: DockPanelId): DockHome {
    const other = at.group.tabs.find((t) => t !== id);
    if (other) return { side: at.side, near: activeOf(at.group) !== id ? activeOf(at.group) : other, at: "tab" };
    if (!at.path.length) return { side: at.side };
    const parent = nodeAt(l.regions[at.side], at.path.slice(0, -1)) as DockSplit, i = at.path[at.path.length - 1];
    const after = i + 1 < parent.children.length, sib = parent.children[after ? i + 1 : i - 1];
    const near = groupsOf(sib)[0]?.group;
    if (!near) return { side: at.side };
    const row = parent.dir === "row";
    return { side: at.side, near: activeOf(near), at: after ? (row ? "left" : "top") : (row ? "right" : "bottom"), frac: parent.fracs[i] };
}

/** Take a panel out of the tree (mutating `l`), pruning what it leaves empty. Where it was is kept in `home`. */
function take(l: DockLayout, id: DockPanelId): void {
    const at = findPanel(l, id);
    if (!at) return;
    l.home[id] = homeOf(l, at, id);
    const i = at.group.tabs.indexOf(id);
    at.group.tabs.splice(i, 1);
    if (at.group.active === id) at.group.active = at.group.tabs[Math.max(0, i - 1)];
    const root = prune(l.regions[at.side]!);
    if (root) l.regions[at.side] = root; else delete l.regions[at.side];
}

/** Put a panel on an edge as a tab of its first group, or as a new region (mutating `l`). */
function putOnEdge(l: DockLayout, id: DockPanelId, side: DockSide): void {
    const first = groupsOf(l.regions[side])[0];
    if (first) { first.group.tabs.push(id); first.group.active = id; } else l.regions[side] = group(id);
}

/** May the group at `path` be split on its `at` side without nesting deeper than `maxDepth`? Splitting along its
 *  parent's direction only adds a sibling; across it, the group becomes a split one level down. */
export function canSplit(l: DockLayout, side: DockSide, path: DockPath, at: DockSide, maxDepth = MAX_SPLIT_DEPTH): boolean {
    const g = nodeAt(l.regions[side], path);
    if (g?.kind !== "group") return false;
    const parent = path.length ? nodeAt(l.regions[side], path.slice(0, -1)) : null;
    if (parent?.kind === "split" && parent.dir === dirOf(at)) return true;
    return path.length + 1 <= maxDepth;
}

/** Would dropping `id` on `t` change anything, and is it allowed? A panel dropped back as a tab of its own group, or
 *  split beside a group it is the only tab of, stays where it is; a split past the depth limit is not offered. */
export function canDrop(l: DockLayout, id: DockPanelId, t: DockTarget, maxDepth = MAX_SPLIT_DEPTH): boolean {
    const at = findPanel(l, id);
    if (t.kind === "edge") return !at || groupsOf(l.regions[t.side]).every((g) => !g.group.tabs.includes(id));
    const g = nodeAt(l.regions[t.side], t.path);
    if (g?.kind !== "group") return false;
    const own = g.tabs.includes(id);
    if (t.kind === "tab") return !own;
    if (own && g.tabs.length === 1) return false;
    return canSplit(l, t.side, t.path, t.at, maxDepth);
}

/** Put a panel that is NOT in the tree at a target (mutating `l`). `target` is the group named by the target's path,
 *  passed separately because the caller may have found it before the tree changed under it. */
function insert(l: DockLayout, id: DockPanelId, t: DockTarget, target?: DockGroup | null, frac = 0.5): void {
    if (t.kind === "edge") { putOnEdge(l, id, t.side); return; }
    const want = target ?? nodeAt(l.regions[t.side], t.path);
    // Found by IDENTITY: taking a panel out can collapse a split and change every path in it.
    const found = SIDES.flatMap((side) => groupsOf(l.regions[side]).map((g) => ({ side, ...g }))).find((g) => g.group === want);
    if (!found) { putOnEdge(l, id, t.side); return; }
    if (t.kind === "tab") { found.group.tabs.push(id); found.group.active = id; return; }
    const dir = dirOf(t.at), before = t.at === "left" || t.at === "top", fresh = group(id);
    const parent = found.path.length ? nodeAt(l.regions[found.side], found.path.slice(0, -1)) as DockSplit : null;
    const i = found.path[found.path.length - 1];
    if (parent && parent.dir === dir) {
        // A sibling in the same row or column: the new group takes half of the room the target had.
        const half = parent.fracs[i] / 2;
        parent.fracs[i] = half;
        parent.children.splice(before ? i : i + 1, 0, fresh);
        parent.fracs.splice(before ? i : i + 1, 0, half);
    } else {
        const split: DockSplit = { kind: "split", dir, children: before ? [fresh, found.group] : [found.group, fresh], fracs: before ? [frac, 1 - frac] : [1 - frac, frac] };
        if (parent) parent.children[i] = split; else l.regions[found.side] = split;
    }
}

/** Move a panel to a target, returning the new layout (the old one is left alone). Returns `l` itself when the move
 *  is not allowed (see `canDrop`). */
export function moveTo(l: DockLayout, id: DockPanelId, t: DockTarget, maxDepth = MAX_SPLIT_DEPTH): DockLayout {
    if (!canDrop(l, id, t, maxDepth)) return l;
    const out = copy(l);
    const target = t.kind === "edge" ? null : nodeAt(out.regions[t.side], t.path) as DockGroup;
    take(out, id);
    insert(out, id, t, target);
    return out;
}

/** Show a group's tab. */
export function setActive(l: DockLayout, side: DockSide, path: DockPath, id: DockPanelId): DockLayout {
    const out = copy(l);
    const g = nodeAt(out.regions[side], path);
    if (g?.kind === "group" && g.tabs.includes(id)) g.active = id;
    return out;
}

/** Set a split's fractions (normalised; a bad list leaves the layout alone). */
export function setFracs(l: DockLayout, side: DockSide, path: DockPath, fracs: number[]): DockLayout {
    const out = copy(l);
    const s = nodeAt(out.regions[side], path);
    const sum = fracs.reduce((a, b) => a + b, 0);
    if (s?.kind !== "split" || fracs.length !== s.children.length || !(sum > 0) || fracs.some((f) => !(f > 0))) return l;
    s.fracs = fracs.map((f) => f / sum);
    return out;
}

/** The layout as it should be DRAWN with these panels open: a closed panel leaves the tree (its edge kept in
 *  `home`), and an open one that is not in it joins its home edge. Returns `l` itself when nothing changes, so a
 *  caller can tell whether there is anything to store. */
export function reconcile(l: DockLayout, open: readonly DockPanelId[]): DockLayout {
    const docked = SIDES.flatMap((side) => groupsOf(l.regions[side]).flatMap((g) => g.group.tabs));
    const closing = docked.filter((id) => !open.includes(id)), opening = open.filter((id) => !docked.includes(id));
    if (!closing.length && !opening.length) return l;
    const out = copy(l);
    // Where each closing panel was is read BEFORE any of them leaves: the page's first render after a reload has no
    // panel open yet, and taking them out one at a time left each one's neighbour already gone when it was asked.
    const homes = closing.map((id) => [id, homeOf(out, findPanel(out, id)!, id)] as const);
    for (const id of closing) take(out, id);
    for (const [id, h] of homes) out.home[id] = h;
    for (const id of opening) {
        const h = out.home[id], near = h?.near ? findPanel(out, h.near) : null;
        const t: DockTarget | null = near && h?.at
            ? h.at === "tab" ? { kind: "tab", side: near.side, path: near.path } : { kind: "split", side: near.side, path: near.path, at: h.at }
            : null;
        if (t && canDrop(out, id, t)) insert(out, id, t, null, h?.frac);
        else putOnEdge(out, id, h?.side ?? DEFAULT_HOME[id]);
    }
    return out;
}

/** A stored node before it is checked: any field may be missing or the wrong type. */
type RawNode = { kind?: unknown; tabs?: unknown; active?: unknown; dir?: unknown; children?: unknown; fracs?: unknown };

/** Every panel id a stored subtree names, in reading order. */
function rawTabs(v: unknown): unknown[] {
    const o = (v && typeof v === "object" ? v : {}) as RawNode;
    if (Array.isArray(o.tabs)) return o.tabs;
    return Array.isArray(o.children) ? o.children.flatMap(rawTabs) : [];
}

/** Read a node from storage, keeping only what is well formed and each panel once (`seen`). A split at `maxDepth` is
 *  folded into one group, so a layout saved by a build that allowed deeper nesting still opens here. */
function readNode(v: unknown, seen: Set<DockPanelId>, depth: number, maxDepth: number): DockNode | null {
    const o = (v && typeof v === "object" ? v : {}) as RawNode;
    if (o.kind === "group" || (o.kind === "split" && depth >= maxDepth)) {
        const tabs: DockPanelId[] = [];
        for (const id of rawTabs(o)) {
            if (PANEL_IDS.includes(id as DockPanelId) && !seen.has(id as DockPanelId)) { seen.add(id as DockPanelId); tabs.push(id as DockPanelId); }
        }
        if (!tabs.length) return null;
        return { kind: "group", tabs, active: tabs.includes(o.active as DockPanelId) ? o.active as DockPanelId : tabs[0] };
    }
    if (o.kind !== "split" || (o.dir !== "row" && o.dir !== "col") || !Array.isArray(o.children)) return null;
    const kids: DockNode[] = [], fracs: number[] = [];
    o.children.forEach((c, i) => {
        const n = readNode(c, seen, depth + 1, maxDepth);
        if (!n) return;
        kids.push(n);
        const f = Array.isArray(o.fracs) ? o.fracs[i] : NaN;
        fracs.push(typeof f === "number" && f > 0 && Number.isFinite(f) ? f : 1);
    });
    return kids.length ? prune({ kind: "split", dir: o.dir, children: kids, fracs }) : null;
}

/** Read a stored `home`: the object, or a bare edge (accepted for leniency). Null when neither is well formed. */
function readHome(v: unknown): DockHome | null {
    if (SIDES.includes(v as DockSide)) return { side: v as DockSide };
    const o = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof DockHome, unknown>>;
    if (!SIDES.includes(o.side as DockSide)) return null;
    const h: DockHome = { side: o.side as DockSide };
    if (PANEL_IDS.includes(o.near as DockPanelId) && (o.at === "tab" || SIDES.includes(o.at as DockSide))) {
        h.near = o.near as DockPanelId; h.at = o.at as DockHome["at"];
        if (typeof o.frac === "number" && o.frac > 0 && o.frac < 1) h.frac = o.frac;
    }
    return h;
}

/** Read a stored layout, keeping only what is well formed: a stored value from an older build is a hint, not a
 *  contract, and one bad field must not cost the rest. Reads the FIRST format too (`side` per panel, `active` per
 *  edge, before a region could hold more than one group): each edge becomes one group of the panels it held. */
export function readDock(v: unknown, maxDepth = MAX_SPLIT_DEPTH): DockLayout {
    const o = (v && typeof v === "object" ? v : {}) as Partial<DockLayout> & {
        side?: Partial<Record<DockPanelId, DockSide>>; active?: Partial<Record<DockSide, DockPanelId>>;
    };
    const out: DockLayout = { regions: {}, size: { ...DOCK_DEFAULT.size }, home: {} };
    for (const sd of SIDES) {
        const n = o.size?.[sd];
        if (typeof n === "number" && Number.isFinite(n) && n >= 64) out.size[sd] = n;
    }
    for (const id of PANEL_IDS) {
        const h = readHome(o.home?.[id]);
        if (h) out.home[id] = h;
    }
    if (o.regions && typeof o.regions === "object") {
        const seen = new Set<DockPanelId>();
        for (const sd of SIDES) {
            const n = readNode(o.regions[sd], seen, 0, maxDepth);
            if (n) out.regions[sd] = n;
        }
    } else if (o.side && typeof o.side === "object") {
        // The first format placed EVERY panel, open or not, so it is read the same way: each panel on its edge, then
        // each edge's remembered tab. `reconcile` then takes out whichever panels are closed, remembering their edge.
        for (const id of PANEL_IDS) if (SIDES.includes(o.side[id] as DockSide)) putOnEdge(out, id, o.side[id] as DockSide);
        for (const sd of SIDES) {
            const g = out.regions[sd], a = o.active?.[sd];
            if (g?.kind === "group") g.active = a && g.tabs.includes(a) ? a : g.tabs[0];
        }
    }
    return out;
}
