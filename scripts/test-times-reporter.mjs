// test-times-reporter.mjs — a node:test reporter that writes one JSON line per finished test and per test file, for scripts/test-times.mjs.
//
// It runs ALONGSIDE the spec reporter (scripts/test.mjs passes both), so what the person reads is unchanged. A file is
// reported by node:test as a top-level `test:complete` whose name is the file's own name; its duration is the child
// process's whole life (start-up included), which is what makes a file that outlives its tests visible.
//
// node:test charges a file's top-level `before()` hooks to its FIRST top-level test (a `describe`'s to the suite), so
// that row is marked `first`: a Pyodide boot in `before()` makes it look slow beside its peers.

import path from "node:path";

/** Whether a top-level event is the FILE's own (named as the runner was given it: `a.test.mjs`, `tests/a.test.mjs` or absolute). */
const isFileEvent = (d) => d.nesting === 0 && path.basename(d.name) === path.basename(d.file);

/**
 * Turn node:test's event stream into JSON lines: `{k:"file", file, ms}` for a file, `{k:"test", file, name, ms, ok, nesting, suite, first}`
 * for a test or suite that passed or failed (a skipped or todo one has no time worth recording). `first` marks the file's first
 * top-level row, whose time includes the file's top-level `before()` hooks.
 *
 * @param {AsyncIterable<{type: string, data: any}>} source
 */
export default async function* reporter(source) {
    const seenTop = new Set(); // files whose first top-level row has been seen
    for await (const e of source) {
        const d = e.data;
        if (!d || !d.file) continue;
        if (e.type === "test:complete" && isFileEvent(d)) {
            yield JSON.stringify({ k: "file", file: d.file, ms: d.details?.duration_ms ?? 0 }) + "\n";
        } else if ((e.type === "test:pass" || e.type === "test:fail")) {
            if (isFileEvent(d)) continue;
            const first = d.nesting === 0 && !seenTop.has(d.file);
            if (d.nesting === 0) seenTop.add(d.file);
            if (d.skip || d.todo) continue;
            yield JSON.stringify({
                k: "test", file: d.file, name: d.name, ms: d.details?.duration_ms ?? 0, ok: e.type === "test:pass",
                nesting: d.nesting, suite: d.details?.type === "suite", first,
            }) + "\n";
        }
    }
}
