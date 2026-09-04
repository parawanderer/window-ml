"use strict";
// The tool-execution protocol: the published MCP `_meta` timing extension, and the normalized frame model
// every source of remote tool execution is adapted into.
//
// Two properties are worth more than the field-by-field checks. The generated schemas must not go stale,
// which is what makes the TypeScript normative rather than one of two copies; and the frame union must stay
// OPEN, because it is a normalization over sources that do not all exist yet and the next one will bring a
// shape these three do not express.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { buildSchema } from "../scripts/gen-export-schema.mjs";
import { validate } from "./helpers-validate.mjs";

const P = await import("../src/tool-protocol.ts");

const checkedIn = (f) => JSON.parse(readFileSync(new URL(`../docs/spec/${f}`, import.meta.url), "utf8"));

test("the checked-in schemas are what the generator produces (regenerate, do not hand-edit)", () => {
    for (const [key, file] of [["tool-protocol", "tool-protocol.schema.json"], ["tool-timing", "tool-timing.schema.json"]]) {
        assert.deepEqual(checkedIn(file), buildSchema(key),
            `docs/spec/${file} is stale — run \`node scripts/gen-export-schema.mjs\``);
    }
});

test("a real frame of each kind validates", () => {
    const schema = buildSchema("tool-protocol");
    for (const frame of [
        { type: "output", text: "resolving deps\n", atMs: 12 },
        { type: "event", event: { type: "mcp:progress", progress: 3, total: 10, message: "step 3" }, atMs: 840 },
        { type: "result", result: { rows: 4 }, name: "search_web", durationMs: 9400, queuedMs: 120 },
        { type: "result", error: "TypeError: q must be a string", name: "search_web", durationMs: 12 },
    ]) {
        assert.deepEqual(validate(frame, schema), [], `should validate: ${JSON.stringify(frame)}`);
    }
});

test("the frame union stays OPEN — a kind added later must not fail an older validator", () => {
    // The union is `@unstable` deliberately: this normalizes over sources that do not all exist yet. A
    // client switching on `type` ignores what it does not recognise, and its validator must agree.
    const schema = buildSchema("tool-protocol");
    assert.deepEqual(validate({ type: "checkpoint", at: 3, note: "a frame from a later version" }, schema), [],
        "an unrecognised frame kind must validate");
    assert.ok(/UNSTABLE/i.test(schema.anyOf.at(-1).description), "…via a permissive branch that says why");
});

test("the timing extension validates, and requires the number it exists for", () => {
    const schema = buildSchema("tool-timing");
    assert.deepEqual(validate({ durationMs: 9400, queuedMs: 120 }, schema), []);
    assert.deepEqual(validate({ durationMs: 9400 }, schema), [], "queuedMs is optional — absent means unknown");
    assert.ok(validate({ queuedMs: 120 }, schema).length > 0,
        "durationMs is the whole point; a payload without it attributes nothing");
});

test("the _meta key follows MCP's own naming rules", () => {
    // An optional reverse-DNS prefix then a name, with any prefix whose SECOND label is
    // `modelcontextprotocol` or `mcp` reserved for MCP itself. Asserted rather than assumed, because a key
    // that breaks the rules is one a conforming server is entitled to reject.
    const key = P.TOOL_TIMING_META_KEY;
    const m = key.match(/^([a-zA-Z](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*)\/([a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]|[a-zA-Z0-9]?)$/);
    assert.ok(m, `${key} is not a valid _meta key`);
    const second = m[1].split(".")[1];
    assert.ok(second && !["modelcontextprotocol", "mcp"].includes(second),
        `the second label (${second}) is reserved for MCP`);
});

/* --------------------------- offsets to local time --------------------------- */
// The one place the local design does not transfer: a remote host's clock is not the user's, so frames
// carry offsets and the client anchors them. Shared, because two adapters each inventing an anchoring rule
// is the drift a normalized model exists to prevent.

test("anchoring places every frame against the FIRST one, not against its own arrival", () => {
    // A stream produced at +0/+800/+9300 by the executor, arriving 250ms later and jittered by the network.
    const anchor = P.anchorFor(0, 1_000_250);
    assert.equal(anchor, 1_000_250, "the first frame IS the anchor");
    assert.equal(P.anchorOffset(anchor, 800, 1_001_400), 1_001_050, "…so a jittered arrival does not move it");
    assert.equal(P.anchorOffset(anchor, 9300, 1_009_400), 1_009_550);
});

test("a stream that opens unstamped fixes no anchor on a guess", () => {
    assert.equal(P.anchorFor(undefined, 5000), null);
    // …and until one arrives, arrival is the only honest answer.
    assert.equal(P.anchorOffset(null, 800, 5900), 5900);
});

test("a frame with no offset falls back to its arrival, even once an anchor exists", () => {
    const anchor = P.anchorFor(10, 1000);
    assert.equal(P.anchorOffset(anchor, undefined, 4321), 4321);
    assert.equal(P.anchorOffset(anchor, NaN, 4321), 4321, "a non-finite offset is not an offset");
});

test("a remote clock AHEAD of ours does not produce output from the future", () => {
    // The failure this design exists to prevent: stamping with the producer's own epoch would place these
    // lines an hour early. Anchoring is relative, so the skew cancels.
    const skewedFirstArrival = 1_000_000;
    const anchor = P.anchorFor(0, skewedFirstArrival);
    const t = P.anchorOffset(anchor, 5000, 1_005_100);
    assert.equal(t, 1_005_000);
    assert.ok(t >= skewedFirstArrival, "no line lands before the stream began");
});
