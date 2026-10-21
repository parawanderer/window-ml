// builtin-texts.test.mjs — a page-built run's builtin tools given the extension's texts (src/sw/builtin-texts.ts): the
// descriptions change, the schema's parameters never do, whatever a parameter is named.
import { test } from "node:test";
import assert from "node:assert/strict";

const { builtinTexts, withOurTexts } = await import("../src/sw/builtin-texts.ts");

// --- the schema keeps its parameters ---

test("every builtin keeps every parameter, its title included, and every required name is a parameter", () => {
    const texts = builtinTexts("https://example.com/", { docs: true, toolTokens: true, crossOrigin: true });
    assert.ok(texts.has("locate"), "locate is built here");
    const page = [...texts].map(([name, t]) => ({ name, description: "the page's words", parameters: t.parameters }));
    for (const t of withOurTexts(page, texts)) {
        const ours = Object.keys(texts.get(t.name).parameters?.properties ?? {});
        const props = Object.keys(t.parameters?.properties ?? {});
        assert.deepEqual(props, ours, `${t.name}: parameters`);
        for (const r of t.parameters?.required ?? []) assert.ok(props.includes(r), `${t.name}: required ${r} is not a parameter`);
    }
});

test("a parameter NAMED description or title stays, with the extension's description; the keyword is replaced", () => {
    const schema = (d) => ({
        type: "object", description: d,
        properties: { description: { type: "string", description: d }, title: { type: "string", description: d }, n: { type: "integer" } },
        required: ["description"],
    });
    const texts = new Map([["locate", { description: "ours", parameters: schema("ours") }]]);
    const [t] = withOurTexts([{ name: "locate", description: "page", parameters: schema("page") }], texts);
    assert.deepEqual(t.parameters, schema("ours"));
});

test("a parameter only the page's schema has loses its description, and keeps its place", () => {
    const texts = new Map([["locate", { description: "ours", parameters: { type: "object", properties: { a: { type: "string", description: "ours" } } } }]]);
    const page = { type: "object", properties: { a: { type: "string", description: "page" }, extra: { type: "string", description: "page" } } };
    const [t] = withOurTexts([{ name: "locate", description: "page", parameters: page }], texts);
    assert.deepEqual(t.parameters, { type: "object", properties: { a: { type: "string", description: "ours" }, extra: { type: "string" } } });
});
