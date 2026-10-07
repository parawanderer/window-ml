// dock-layout.test.mjs — the chat page's dock as data (src/chat/dock-layout.ts): moving a panel to a tab, a split or an
// edge, the depth limit, what closing and reopening a panel does, and reading a stored layout, including the FIRST
// format, from before a region could hold more than one group.
import { test } from "node:test";
import assert from "node:assert/strict";

const D = await import("../src/chat/dock-layout.ts");

const base = (regions) => ({ regions, size: { ...D.DOCK_DEFAULT.size }, home: {} });
const g = (...tabs) => ({ kind: "group", tabs, active: tabs[0] });

// --- moving a panel ---

test("a panel dropped as a tab joins that group and becomes its visible tab; its old region goes", () => {
    const l = base({ top: g("resource"), bottom: g("bench") });
    const out = D.moveTo(l, "bench", { kind: "tab", side: "top", path: [] });
    assert.deepEqual(out.regions, { top: { kind: "group", tabs: ["resource", "bench"], active: "bench" } });
    assert.deepEqual(out.home.bench, { side: "bottom" }, "the edge it left is remembered");
    assert.deepEqual(l.regions.bottom, g("bench"), "the layout passed in is not changed");
});

test("a split puts the panel on the named side of the group, half each", () => {
    const l = base({ right: g("runlog"), bottom: g("bench") });
    const below = D.moveTo(l, "bench", { kind: "split", side: "right", path: [], at: "bottom" });
    assert.deepEqual(below.regions.right, { kind: "split", dir: "col", children: [g("runlog"), g("bench")], fracs: [0.5, 0.5] });
    assert.equal(below.regions.bottom, undefined);
    const left = D.moveTo(l, "bench", { kind: "split", side: "right", path: [], at: "left" });
    assert.deepEqual(left.regions.right, { kind: "split", dir: "row", children: [g("bench"), g("runlog")], fracs: [0.5, 0.5] });
});

test("splitting along the split a group is already in adds a sibling, which takes half of that group's room", () => {
    const l = base({ right: { kind: "split", dir: "col", children: [g("runlog"), g("resource")], fracs: [0.6, 0.4] }, top: g("bench") });
    const out = D.moveTo(l, "bench", { kind: "split", side: "right", path: [1], at: "bottom" });
    assert.deepEqual(out.regions.right, { kind: "split", dir: "col", children: [g("runlog"), g("resource"), g("bench")], fracs: [0.6, 0.2, 0.2] });
});

test("a split ACROSS a split's direction is refused at depth 1, and allowed when the limit is 2", () => {
    const l = base({ right: { kind: "split", dir: "col", children: [g("runlog"), g("resource")], fracs: [0.5, 0.5] }, top: g("bench") });
    const across = { kind: "split", side: "right", path: [0], at: "left" };
    assert.equal(D.MAX_SPLIT_DEPTH, 1);
    assert.equal(D.canDrop(l, "bench", across), false);
    assert.equal(D.moveTo(l, "bench", across), l, "a refused move returns the layout unchanged");
    // The operations are general: raising the limit is the whole change for a deeper layout.
    const deep = D.moveTo(l, "bench", across, 2);
    assert.deepEqual(deep.regions.right, {
        kind: "split", dir: "col", fracs: [0.5, 0.5],
        children: [{ kind: "split", dir: "row", children: [g("bench"), g("runlog")], fracs: [0.5, 0.5] }, g("resource")],
    });
});

test("taking the last tab out of a group removes the group, and a split left with one child becomes that child", () => {
    const l = base({ right: { kind: "split", dir: "col", children: [g("runlog"), g("bench")], fracs: [0.5, 0.5] } });
    const out = D.moveTo(l, "bench", { kind: "edge", side: "bottom" });
    assert.deepEqual(out.regions, { right: g("runlog"), bottom: g("bench") });
});

test("a panel can be split out of its own group when the group has other tabs, and paths that move are followed", () => {
    // The target's path changes when the panel leaves (the split collapses), so the target is held by identity.
    const l = base({ right: { kind: "split", dir: "row", children: [g("bench"), g("runlog", "resource")], fracs: [0.5, 0.5] } });
    const out = D.moveTo(l, "resource", { kind: "split", side: "right", path: [1], at: "right" });
    assert.deepEqual(out.regions.right, { kind: "split", dir: "row", children: [g("bench"), g("runlog"), g("resource")], fracs: [0.5, 0.25, 0.25] });
    const moved = D.moveTo(base({ right: { kind: "split", dir: "row", children: [g("bench"), g("runlog")], fracs: [0.5, 0.5] } }),
        "bench", { kind: "tab", side: "right", path: [1] });
    assert.deepEqual(moved.regions.right, { kind: "group", tabs: ["runlog", "bench"], active: "bench" }, "path [1] became the root");
});

test("a drop that would change nothing is not offered: back into its own group, or split beside itself alone", () => {
    const l = base({ top: g("resource", "bench"), right: g("runlog") });
    assert.equal(D.canDrop(l, "bench", { kind: "tab", side: "top", path: [] }), false);
    assert.equal(D.canDrop(l, "runlog", { kind: "split", side: "right", path: [], at: "left" }), false);
    assert.equal(D.canDrop(l, "runlog", { kind: "edge", side: "right" }), false);
    assert.equal(D.canDrop(l, "bench", { kind: "split", side: "top", path: [], at: "left" }), true, "out of a group of two");
});

test("an edge with a region already there takes the panel as a tab of its first group", () => {
    const l = base({ right: { kind: "split", dir: "col", children: [g("runlog"), g("resource")], fracs: [0.5, 0.5] }, top: g("bench") });
    const out = D.moveTo(l, "bench", { kind: "edge", side: "right" });
    assert.deepEqual(D.nodeAt(out.regions.right, [0]), { kind: "group", tabs: ["runlog", "bench"], active: "bench" });
});

// --- open and closed panels ---

// The bench is not kept open across a reload, so without this a split holding it came undone on every reload.
test("a closed panel leaves the tree, and reopens where it was: beside the same panel, on the same side", () => {
    const l = base({ right: { kind: "split", dir: "col", children: [g("runlog"), g("bench")], fracs: [0.5, 0.5] } });
    const closed = D.reconcile(l, ["runlog"]);
    assert.deepEqual(closed.regions, { right: g("runlog") });
    assert.deepEqual(closed.home.bench, { side: "right", near: "runlog", at: "bottom", frac: 0.5 });
    const back = D.reconcile(closed, ["runlog", "bench"]);
    assert.deepEqual(back.regions.right, l.regions.right, "split below the log again");
    // Before its neighbour: it goes back on that side.
    const first = D.reconcile(base({ top: { kind: "split", dir: "row", children: [g("bench"), g("resource")], fracs: [0.5, 0.5] } }), ["resource"]);
    assert.deepEqual(first.home.bench, { side: "top", near: "resource", at: "left", frac: 0.5 });
    // A divider someone dragged comes back where they left it.
    const dragged = base({ top: { kind: "split", dir: "row", children: [g("resource"), g("bench")], fracs: [0.7, 0.3] } });
    assert.deepEqual(D.reconcile(D.reconcile(dragged, ["resource"]), ["resource", "bench"]).regions.top, dragged.regions.top);
    assert.deepEqual(D.reconcile(first, ["resource", "bench"]).regions.top.children, [g("bench"), g("resource")]);
    // A tab beside another: a tab beside it again.
    const tabbed = D.reconcile(base({ top: { kind: "group", tabs: ["resource", "bench"], active: "resource" } }), ["resource"]);
    assert.deepEqual(tabbed.home.bench, { side: "top", near: "resource", at: "tab" });
    assert.deepEqual(D.reconcile(tabbed, ["resource", "bench"]).regions.top, { kind: "group", tabs: ["resource", "bench"], active: "bench" });
    // Both closed in ONE pass (a reload's first render has no panel open), then reopened one at a time: each was
    // remembered beside the other, so the second to come back restores the split.
    const all = D.reconcile(l, []);
    assert.deepEqual(all.regions, {});
    assert.deepEqual(D.reconcile(D.reconcile(all, ["runlog"]), ["runlog", "bench"]).regions.right, l.regions.right);
    // Its neighbour gone too: back to its edge.
    const both = D.reconcile(D.reconcile(l, ["runlog"]), []);
    assert.deepEqual(D.reconcile(both, ["bench"]).regions, { right: g("bench") });
    assert.equal(D.reconcile(back, ["runlog", "bench"]), back, "nothing to change returns the same layout");
    assert.deepEqual(D.reconcile(base({}), ["resource"]).regions, { top: g("resource") }, "never placed: its default edge");
});

// --- reading a stored layout ---

// The UPGRADE: the first format placed every panel on an edge, open or not, and remembered one tab per edge. Read by
// this build, each edge is one group, its remembered tab is the visible one, and closed panels leave with their edge.
test("a layout stored in the first format opens as one group per edge, with the tab it was showing", () => {
    const v1 = { side: { resource: "top", bench: "top", runlog: "right" }, size: { top: 250, bottom: 320, left: 380, right: 500 }, active: { top: "resource" } };
    const l = D.reconcile(D.readDock(v1), ["resource", "bench"]);
    assert.deepEqual(l.regions, { top: { kind: "group", tabs: ["resource", "bench"], active: "resource" } });
    assert.equal(l.size.top, 250);
    assert.equal(l.size.right, 500);
    assert.deepEqual(l.home.runlog, { side: "right" }, "the closed log keeps its edge");
    assert.deepEqual(D.reconcile(l, ["resource", "bench", "runlog"]).regions.right, g("runlog"));
});

test("a stored layout is read leniently: unknown panels, duplicates, bad fractions and junk are dropped, not fatal", () => {
    const l = D.readDock({
        regions: {
            right: { kind: "split", dir: "col", children: [g("runlog", "nope"), { kind: "group", tabs: ["runlog", "bench"] }, 7], fracs: [-1, "x"] },
            top: { kind: "group", tabs: [] }, left: "garbage",
        },
        size: { top: 10, right: Infinity }, home: { bench: "middle" },
    });
    assert.deepEqual(l.regions, { right: { kind: "split", dir: "col", children: [g("runlog"), g("bench")], fracs: [0.5, 0.5] } });
    assert.deepEqual(l.size, D.DOCK_DEFAULT.size);
    assert.deepEqual(l.home, {});
    assert.deepEqual(D.readDock(null), D.DOCK_DEFAULT);
});

test("a layout saved deeper than this build allows folds the too-deep split into one group", () => {
    const deep = { regions: { right: { kind: "split", dir: "col", fracs: [0.5, 0.5],
        children: [{ kind: "split", dir: "row", children: [g("bench"), g("runlog")], fracs: [0.5, 0.5] }, g("resource")] } } };
    assert.deepEqual(D.readDock(deep).regions.right, {
        kind: "split", dir: "col", children: [{ kind: "group", tabs: ["bench", "runlog"], active: "bench" }, g("resource")], fracs: [0.5, 0.5],
    });
    assert.deepEqual(D.readDock(deep, 2).regions.right, deep.regions.right, "kept whole where the limit allows it");
});

test("setFracs normalises, and refuses a list that does not fit the split", () => {
    const l = base({ right: { kind: "split", dir: "row", children: [g("runlog"), g("bench")], fracs: [0.5, 0.5] } });
    assert.deepEqual(D.setFracs(l, "right", [], [3, 1]).regions.right.fracs, [0.75, 0.25]);
    assert.equal(D.setFracs(l, "right", [], [1, 0]), l);
    assert.equal(D.setFracs(l, "right", [], [1]), l);
});
