"use strict";
// The GENERATED JSON Schema: the export contract in a form a Python or Go consumer can use.
//
// Two jobs. First, the checked-in `docs/spec/export.schema.json` must match what the generator produces
// right now — it is a published file people link to and generate models from, so an edit to
// export-schema.ts that leaves it stale is worse than no spec at all. Second, and less obviously: the
// schema must actually describe the documents we really emit. A generated schema can be perfectly
// self-consistent and still not match reality, which is the failure that would send a consumer chasing
// their own parser for our bug.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildSchema } from "../scripts/gen-export-schema.mjs";
const { sessionToJson } = await import("../src/sidebar/export-json.ts");
const { schemaUrl } = await import("../src/export-schema.ts");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = join(ROOT, "docs/spec/export.schema.json");

/**
 * A DELIBERATELY SMALL subset validator: `$ref`, `required`, `type`, `enum`, `const`, `items`,
 * `prefixItems`, `anyOf`. Not a JSON Schema implementation, and not trying to be — a consumer should use
 * a real one. Its job here is to catch the generated schema drifting from the documents we emit, and
 * those are the keywords the generator actually produces.
 *
 * @returns {string[]} paths that failed, empty when the document conforms
 */
function validate(doc, schema, root = schema, path = "$") {
    const errs = [];
    if (schema.$ref) {
        const name = schema.$ref.replace("#/$defs/", "");
        const target = root.$defs?.[name];
        if (!target) return [`${path}: dangling $ref ${schema.$ref}`];
        return validate(doc, target, root, path);
    }
    if (schema.anyOf) {
        return schema.anyOf.some((s) => validate(doc, s, root, path).length === 0)
            ? [] : [`${path}: matched none of anyOf`];
    }
    const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null;
    if (types) {
        const actual = doc === null ? "null" : Array.isArray(doc) ? "array" : typeof doc;
        const ok = types.some((t) => t === actual || (t === "number" && actual === "number") || (t === "integer" && Number.isInteger(doc)));
        if (!ok) return [`${path}: expected ${types.join("|")}, got ${actual}`];
    }
    if (schema.enum && !schema.enum.includes(doc)) errs.push(`${path}: ${JSON.stringify(doc)} not in enum`);
    if ("const" in schema && doc !== schema.const) errs.push(`${path}: expected const ${schema.const}`);

    if (types?.includes("object") && doc && typeof doc === "object" && !Array.isArray(doc)) {
        for (const r of schema.required || []) {
            if (!(r in doc)) errs.push(`${path}.${r}: required but missing`);
        }
        for (const [k, v] of Object.entries(doc)) {
            const sub = schema.properties?.[k];
            if (sub) errs.push(...validate(v, sub, root, `${path}.${k}`));
        }
    }
    if (types?.includes("array") && Array.isArray(doc)) {
        if (schema.prefixItems) {
            schema.prefixItems.forEach((s, i) => errs.push(...validate(doc[i], s, root, `${path}[${i}]`)));
        } else if (schema.items) {
            doc.forEach((v, i) => errs.push(...validate(v, schema.items, root, `${path}[${i}]`)));
        }
    }
    return errs;
}

const usage = (p, c) => ({ promptTokens: p, completionTokens: c, totalTokens: p + c, genMs: 40, evalMs: 12, loadMs: 3 });

const agentSession = (over = {}) => ({
    hash: "abc12345", kind: "agent", model: "gemma4:31b", tag: "session",
    createdTs: 1_700_000_000_000, lastTs: 1_700_000_009_000, status: "ok",
    config: {}, turns: [], task: "count the rows",
    pageUrl: "https://example.com/sales?q=1", pageTitle: "Sales",
    maxSteps: 20,
    steps: [
        { step: 1, seq: 1, ts: 1_700_000_001_000, thought: "I should look", usage: usage(100, 20) },
        { step: 1, seq: 2, ts: 1_700_000_002_000, toolMs: 812, tool: "exec",
          arguments: { js: "document.querySelectorAll('tr').length" }, result: "42",
          modelResult: "42 (clipped)", token: "a39f599", elements: 3,
          renderOut: { type: "elements", count: 3 }, argIssues: ["unknown property `foo`"] },
        { step: 2, seq: 3, ts: 1_700_000_003_000, tool: "answer", arguments: { text: "42" }, result: "ok" },
    ],
    answers: [{ text: "42 rows", ts: 1_700_000_009_000, atStep: 3, status: "ok" }],
    summary: "42 rows",
    ...over,
});

test("the checked-in spec is what the generator produces (regenerate it, do not hand-edit)", () => {
    const generated = JSON.stringify(buildSchema(), null, 2) + "\n";
    const onDisk = readFileSync(SCHEMA_PATH, "utf8");
    assert.equal(generated, onDisk,
        "docs/spec/export.schema.json is stale — run `node scripts/gen-export-schema.mjs`");
});

test("a real export validates against the generated schema", () => {
    const doc = sessionToJson(agentSession(), {
        version: "1.4.0",
        build: { commit: "a".repeat(40), shortCommit: "aaaaaaa", dirty: true, dirtyFiles: ["contract.ts"], dirtyDiff: "diff --git …", commitDate: "2026-09-03T13:06:07+02:00", repoUrl: "https://example.invalid/r", buildTime: "2026-09-03T11:46:52.846Z" },
        includeDirtyDiff: true,
    });
    const errs = validate(doc, buildSchema());
    assert.deepEqual(errs, [], `export does not conform:\n${errs.join("\n")}`);
});

test("a CHAT export validates too — it takes a different branch (messages, no steps)", () => {
    const chat = {
        hash: "def45678", kind: "chat", tag: "session", model: "gemma4:31b",
        createdTs: 1_700_000_000_000, lastTs: 1_700_000_005_000, status: "ok",
        config: {}, steps: [],
        turns: [{ user: "hi", assistant: "hello", ts: 1_700_000_001_000, status: "ok", usage: usage(5, 3) }],
    };
    const errs = validate(sessionToJson(chat), buildSchema());
    assert.deepEqual(errs, [], `chat export does not conform:\n${errs.join("\n")}`);
});

test("the validator can actually fail — a wrong type is caught, not waved through", () => {
    // Without this, all three tests above would pass just as happily against a validator that returns [].
    const doc = sessionToJson(agentSession());
    doc.schema = "one";
    const errs = validate(doc, buildSchema());
    assert.ok(errs.some((e) => e.includes("$.schema")), `expected a complaint about $.schema, got: ${errs.join(", ")}`);
});

test("the open payloads stay open — a new render descriptor type must not invalidate old parsers", () => {
    const schema = buildSchema();
    const renderOut = schema.$defs.ExportStep.properties.renderOut;
    // Resolved in full — a consumer gets real types for the known variants — but with a trailing branch
    // that accepts anything, so a variant added later does not fail an old consumer's validator.
    assert.ok(renderOut.anyOf.length > 3, "the known descriptor variants must be described, not hidden behind an opaque object");
    assert.ok(renderOut.anyOf.some((b) => b.properties?.type?.const === "image"), "a known variant should be usable for codegen");
    assert.ok(/UNSTABLE/i.test(renderOut.anyOf.at(-1).description), "the last branch is the permissive one, and must say why");
    assert.equal(schema.$defs.DebugAgentConfig["x-unstable"], true, "an @unstable type is machine-identifiable, not just prose");

    const doc = sessionToJson(agentSession({
        steps: [{ step: 1, seq: 1, ts: 1, tool: "x", result: "y", renderOut: { type: "a-format-invented-later", whatever: { deeply: [1, 2] } } }],
    }));
    assert.deepEqual(validate(doc, schema), [], "an unknown descriptor type must still validate");
});

test("the borrowed types INSIDE the promise are resolved, not left as anything", () => {
    const schema = buildSchema();
    // TokenUsage is imported from contract.ts; a consumer needs its real shape, not an opaque object.
    assert.ok(schema.$defs.TokenUsage?.properties?.promptTokens, "TokenUsage must be inlined with its fields");
    assert.equal(schema.$defs.ExportStep.properties.usage.$ref, "#/$defs/TokenUsage");
});

test("$schema pins the COMMIT, so a document says exactly what described it", () => {
    // Not `main`: main drifts away from what this file actually is, and a URL that describes a later
    // format is worse than no URL. raw.githubusercontent, not the github.com blob page, so it is
    // fetchable JSON.
    const url = schemaUrl({ repoUrl: "https://github.com/parawanderer/window-ml", commit: "a".repeat(40) });
    assert.equal(url, `https://raw.githubusercontent.com/parawanderer/window-ml/${"a".repeat(40)}/docs/spec/export.schema.json`);

    const doc = sessionToJson(agentSession(), { build: { repoUrl: "https://github.com/parawanderer/window-ml", commit: "b".repeat(40) } });
    assert.ok(doc.$schema.includes("b".repeat(40)));
    assert.equal(Object.keys(doc)[0], "$schema", "it goes first — an editor looks at the head of the file");
});

test("$schema is omitted rather than guessed when there is nothing to pin to", () => {
    // A wrong URL gets validated against and quietly misleads, which is worse than its absence.
    assert.equal(schemaUrl(undefined), undefined);
    assert.equal(schemaUrl({ commit: "a".repeat(40) }), undefined, "no remote");
    assert.equal(schemaUrl({ repoUrl: "https://github.com/o/r" }), undefined, "no commit");
    assert.equal(schemaUrl({ repoUrl: "https://gitlab.com/o/r", commit: "a" }), undefined, "not GitHub");
    assert.equal(schemaUrl({ repoUrl: "git@github.com:o/r.git", commit: "a" }), undefined, "an unnormalised ssh remote is not a https URL");
    assert.ok(!("$schema" in sessionToJson(agentSession())), "no build stamp, no claim");
});

test("$schema is still emitted for a DIRTY build — best effort, flagged beside it", () => {
    // The commit's schema is the nearest published thing rather than an exact match. Suppressing the URL
    // would lose a mostly-right answer; `generator.build.dirty` is how a consumer knows to be careful.
    const doc = sessionToJson(agentSession(), { build: { repoUrl: "https://github.com/o/r", commit: "c".repeat(40), dirty: true } });
    assert.ok(doc.$schema.includes("c".repeat(40)));
    assert.equal(doc.generator.build.dirty, true);
});
