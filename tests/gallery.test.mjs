// gallery.test.mjs — the component gallery's generator (scripts/gallery-gen.mjs): which components it finds, how it
// reads props from the checker (enum-like unions resolved to their members), the `@group` / `@gallery` tags, the
// placeholder values; and the page's URL state (src/gallery/gallery-url.ts). docs/spec/COMPONENT_GALLERY.md.
import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { galleryManifest, parseTags, placeholder, customEntryFiles } from "../scripts/gallery-gen.mjs";
import { parseHash, formatHash, encodeJson, decodeJson, DEFAULT_STATE } from "../src/gallery/gallery-url.ts";

// One manifest for the file: building the checker is the slow part (~2 s).
const manifest = galleryManifest({ only: /^(ReplyBubble|PointerChip|CopyBtn|FilterChips|Stepper|ComponentTile|SessionList)$/ });
const byName = (n) => manifest.components.find((c) => c.name === n);

const ROOT = path.resolve(import.meta.dirname, "..");

// --- discovery ------------------------------------------------------------------------------------------------------

test("components are found through the code index, and the gallery's own are not listed", () => {
    for (const n of ["ReplyBubble", "PointerChip", "CopyBtn", "Stepper"]) assert.ok(byName(n), `${n} missing`);
    assert.strictEqual(byName("ComponentTile"), undefined);
});

test("custom entry modules are found by their file name, the gradient's among them", () => {
    assert.ok(customEntryFiles().includes("src/gallery/gradient.gallery.ts"));
});

test("an untagged component is grouped by its folder; a tagged one by its @group", () => {
    const c = byName("SessionList");
    assert.strictEqual(c.tagged, false);
    assert.deepStrictEqual(c.groups, ["chat"]);
    const t = byName("CopyBtn");
    assert.strictEqual(t.tagged, true);
    assert.deepStrictEqual(t.groups, ["primitives", "controls"]);
    assert.deepStrictEqual(t.variants.map((v) => v.source), ["example"]);
});

// --- props, from the checker ---------------------------------------------------------------------------------------

test("an enum-like union resolves to its members, through an imported alias, and becomes one variant per member", () => {
    const c = byName("ReplyBubble");
    const status = c.props.fields.find((f) => f.name === "status");
    assert.strictEqual(status.schema.kind, "enum");
    assert.deepStrictEqual([...status.schema.members].sort(), ["err", "ok", "pending"]);
    assert.deepStrictEqual(c.variants.map((v) => v.name).sort(), ["status: err", "status: ok", "status: pending"]);
    assert.ok(c.variants.every((v) => v.source === "inferred"));
});

test("an object type naming ComponentChildren is still an object; the children-typed props are nodes", () => {
    const c = byName("PointerChip");
    assert.strictEqual(c.props.kind, "object");
    const kinds = Object.fromEntries(c.props.fields.map((f) => [f.name, f.schema.kind]));
    assert.deepStrictEqual(kinds, { label: "node", tip: "node", onClick: "function", cls: "string", trailing: "node" });
    // Required props only, functions left to the page.
    assert.deepStrictEqual(c.inferred, { label: "label", tip: "tip" });
});

test("a ReadonlySet prop is a set, which the page builds from an array", () => {
    const hidden = byName("FilterChips").props.fields.find((f) => f.name === "hidden");
    assert.strictEqual(hidden.schema.kind, "set");
    assert.deepStrictEqual(placeholder(hidden.schema), []);
});

test("placeholders: a string is its name, a number 1, an enum its first member, optional fields left out", () => {
    assert.strictEqual(placeholder({ kind: "string" }, "label"), "label");
    assert.strictEqual(placeholder({ kind: "number" }), 1);
    assert.strictEqual(placeholder({ kind: "enum", members: ["a", "b"] }), "a");
    assert.deepStrictEqual(placeholder({ kind: "array", of: { kind: "boolean" } }), [false]);
    assert.deepStrictEqual(placeholder({ kind: "object", fields: [
        { name: "a", optional: false, schema: { kind: "string" } },
        { name: "b", optional: true, schema: { kind: "string" } },
        { name: "f", optional: false, schema: { kind: "function" } },
    ] }), { a: "a" });
});

// --- the JSDoc tags ------------------------------------------------------------------------------------------------

test("@group takes a comma list; @gallery takes an optional name and JSON, over several lines", () => {
    const doc = `A status dot.\n@group status, chips\n@gallery {"status": "ok"}\n@gallery stopped short {\n  "status": "ok",\n  "warn": "stopped"\n}\n@param x ignored`;
    const { groups, examples } = parseTags(doc);
    assert.deepStrictEqual(groups, ["status", "chips"]);
    assert.deepStrictEqual(examples, [
        { name: "example 1", props: { status: "ok" } },
        { name: "stopped short", props: { status: "ok", warn: "stopped" } },
    ]);
});

test("a malformed @gallery is kept as an error, not dropped", () => {
    const { examples } = parseTags(`@gallery broken {"status": ok}`);
    assert.strictEqual(examples.length, 1);
    assert.strictEqual(examples[0].name, "broken");
    assert.match(examples[0].error, /not JSON/);
});

test("@gallery-flow names a committed flow file, with optional JSON; @gallery none carries its reason", () => {
    const { examples, none } = parseTags(`@gallery-flow open tests/gallery-flows/ContextMenu.mjs\n@gallery-flow with items tests/gallery-flows/X.mjs {"n": 2}\n@gallery none a line over a chart: nothing to read alone`);
    assert.deepStrictEqual(examples, [
        { name: "open", flow: "tests/gallery-flows/ContextMenu.mjs" },
        { name: "with items", flow: "tests/gallery-flows/X.mjs", props: { n: 2 } },
    ]);
    assert.strictEqual(none, "a line over a chart: nothing to read alone");
    assert.match(parseTags("@gallery-flow just-a-name").examples[0].error, /wants: <name> <file\.mjs>/);
});

test("the tagged layers carry their flows, the crosshair its reason, and every flow file exists", () => {
    const m = galleryManifest({ only: /^(ContextMenu|CursorTipLayer|Crosshair)$/ });
    const get = (n) => m.components.find((c) => c.name === n);
    for (const n of ["ContextMenu", "CursorTipLayer"]) {
        const [v] = get(n).variants;
        assert.strictEqual(v.source, "example");
        assert.ok(existsSync(new URL(`../${v.flow}`, import.meta.url)), `${n}'s flow ${v.flow} is missing`);
    }
    const [v] = get("Crosshair").variants;
    assert.strictEqual(v.source, "none");
    assert.match(v.reason, /one-pixel line/);
});

// --- the URL state ------------------------------------------------------------------------------------------------

test("every toggle round-trips through the hash, and defaults are left out of it", () => {
    const s = { ...DEFAULT_STATE, id: "Stepper", variant: "status: ok", props: { label: "ünïcode ✓", n: [1, 2] }, theme: "light", view: "calm", width: "phone", tokens: { "--bg": "#fff" }, tab: "tokens", q: "chip|pill" };
    assert.deepStrictEqual(parseHash(formatHash(s)), s);
    assert.strictEqual(formatHash({ ...DEFAULT_STATE, id: "CopyBtn" }), "#/CopyBtn");
});

test("a malformed hash falls back to the defaults, toggle by toggle", () => {
    const s = parseHash("#/X?theme=purple&props=!!!&width=phone");
    assert.strictEqual(s.theme, DEFAULT_STATE.theme);
    assert.strictEqual(s.props, null);
    assert.strictEqual(s.width, "phone");
    assert.deepStrictEqual(parseHash(""), DEFAULT_STATE);
    assert.strictEqual(decodeJson(encodeJson({ a: "é" })).a, "é");
});

// --- the CLI's shot ------------------------------------------------------------------------------------------------

test("shot --variant screenshots the named variant's tile, not the first", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gallery-variant-"));
    try {
        const shot = (variant) => {
            const out = path.join(dir, `${variant}.png`);
            execFileSync("node", ["scripts/gallery.mjs", "shot", "Disclosure", "--variant", variant, "--out", out], { cwd: ROOT, stdio: "pipe", timeout: 180_000 });
            return readFileSync(out);
        };
        const closed = shot("closed"), open = shot("open");
        assert.ok(!closed.equals(open), "the closed and open variants of Disclosure rendered the same PNG");
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
