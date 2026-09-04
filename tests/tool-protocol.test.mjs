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

/* --------------------------- reading a stream --------------------------- */
// Folding NDJSON frames into output, marks, events and a result. The interesting cases are all about
// streams that do not arrive tidily: split across reads, ending without a newline, ending without a
// result at all.

const T0 = 1_700_000_000_000;
const frames = (...objs) => objs.map(o => JSON.stringify(o)).join("\n") + "\n";

test("output deltas append, and each stamped chunk marks its position in the text", () => {
    const s = P.createToolStream();
    s.push(frames(
        { type: "output", text: "resolving deps\n", atMs: 0 },
        { type: "output", text: "building\n", atMs: 800 },
    ), T0);
    const st = s.state();
    assert.equal(st.output, "resolving deps\nbuilding\n");
    // The first stamped frame anchors the stream; the second is placed 800ms after it, NOT at its arrival.
    assert.deepEqual(st.marks, [[0, T0], [15, T0 + 800]]);
});

test("a frame split across two network reads is not lost", () => {
    // The failure that only shows up under load or on a slow link: a chunk boundary mid-JSON.
    const whole = JSON.stringify({ type: "output", text: "hello", atMs: 5 }) + "\n";
    const s = P.createToolStream();
    const cut = whole.slice(0, 20);
    assert.deepEqual(s.push(cut, T0), [], "half a line is not yet a frame");
    assert.equal(s.push(whole.slice(20), T0).length, 1);
    assert.equal(s.state().output, "hello");
});

test("a result frame ends the stream successfully, carrying its timing", () => {
    const s = P.createToolStream();
    s.push(frames(
        { type: "output", text: "working", atMs: 10 },
        { type: "result", result: { rows: 4 }, durationMs: 9400, queuedMs: 120 },
    ), T0);
    const end = s.end(T0 + 9500);
    assert.equal(end.ok, true);
    assert.deepEqual(end.result.result, { rows: 4 });
    assert.equal(end.result.durationMs, 9400, "the number the client subtracts its own wall clock from");
    assert.equal(end.state.output, "working");
});

test("a trailing line with no newline is still a frame", () => {
    // A server that ends without a final newline is not malformed, and dropping its result frame would
    // turn a completed call into a transport failure.
    const s = P.createToolStream();
    s.push(JSON.stringify({ type: "result", result: "done", durationMs: 5 }), T0);
    const end = s.end(T0 + 5);
    assert.equal(end.ok, true);
    assert.equal(end.result.result, "done");
});

test("a stream that ends with NO result frame is a transport failure, not an empty result", () => {
    // The distinction the model cannot make for itself: partial output reported as a tool that returned
    // nothing is a wrong answer dressed as an empty one.
    const s = P.createToolStream();
    s.push(frames({ type: "output", text: "half the log", atMs: 0 }), T0);
    const end = s.end(T0 + 100);
    assert.equal(end.ok, false);
    assert.match(end.transportError, /without a result frame/);
    assert.equal(end.state.output, "half the log", "…and what did arrive is still there for a human");
});

test("an error frame is a normal ending — the model reads it and reacts", () => {
    const s = P.createToolStream();
    s.push(frames(
        { type: "output", text: "connecting\n", atMs: 0 },
        { type: "result", error: "TypeError: q must be a string", durationMs: 12 },
    ), T0);
    const end = s.end(T0 + 12);
    assert.equal(end.ok, true, "the TOOL failed; the stream did not");
    assert.equal(end.result.error, "TypeError: q must be a string");
    assert.equal(end.state.output, "connecting\n", "output before the failure is never retracted");
});

test("event frames stay out of the output text", () => {
    // Folding them in is how UI plumbing ends up in something a model reads.
    const s = P.createToolStream();
    s.push(frames(
        { type: "output", text: "a", atMs: 0 },
        { type: "event", event: { type: "mcp:progress", progress: 1, total: 3 }, atMs: 50 },
        { type: "output", text: "b", atMs: 100 },
    ), T0);
    const st = s.state();
    assert.equal(st.output, "ab");
    assert.equal(st.events.length, 1);
    assert.equal(st.events[0].event.progress, 1);
    assert.deepEqual(st.marks, [[0, T0], [1, T0 + 100]], "and out of the marks, which index the text");
});

test("an unreadable line does not abandon the lines after it", () => {
    // A stream is a sequence of independent lines: a keep-alive, a proxy's insertion or one corrupt line
    // is not a reason to lose the rest.
    const s = P.createToolStream();
    s.push("not json\n\n" + frames({ type: "output", text: "survived", atMs: 0 }), T0);
    assert.equal(s.state().output, "survived");
});

test("an UNKNOWN frame kind is ignored, not fatal — the union grows", () => {
    const s = P.createToolStream();
    s.push(frames(
        { type: "checkpoint", note: "from a later version" },
        { type: "output", text: "still here", atMs: 0 },
    ), T0);
    assert.equal(s.state().output, "still here");
});

test("an unstamped stream falls back to arrival, and never marks what it was not told", () => {
    const s = P.createToolStream();
    s.push(frames({ type: "output", text: "no offsets here" }), T0 + 500);
    assert.deepEqual(s.state().marks, [], "an offset nobody reported is not a time");
    assert.equal(s.state().output, "no offsets here");
});

test("onFrame sees each frame live, with the time it was PRODUCED", () => {
    // What a caller streams to ctx.stream: the producer's moment, not ours.
    const seen = [];
    const s = P.createToolStream((f, at) => seen.push([f.type, at]));
    s.push(frames(
        { type: "output", text: "a", atMs: 0 },
        { type: "output", text: "b", atMs: 2000 },
    ), T0);
    s.push(frames({ type: "result", result: 1, durationMs: 2100 }), T0 + 2200);
    assert.deepEqual(seen, [["output", T0], ["output", T0 + 2000], ["result", T0 + 2200]]);
});
