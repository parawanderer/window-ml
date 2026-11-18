// test-times-reporter.mjs — a node:test reporter that writes one JSON line per finished test and per test file, for scripts/test-times.mjs.
//
// It runs ALONGSIDE the spec reporter (scripts/test.mjs passes both), so what the person reads is unchanged. A file is
// reported by node:test as a top-level `test:complete` whose name is the file's own name; its duration is the child
// process's whole life (start-up included), which is what makes a file that outlives its tests visible.

import path from "node:path";

/** Whether a top-level event is the FILE's own (named as the runner was given it: `a.test.mjs`, `tests/a.test.mjs` or absolute). */
const isFileEvent = (d) => d.nesting === 0 && path.basename(d.name) === path.basename(d.file);

/**
 * Turn node:test's event stream into JSON lines: `{k:"file", file, ms}` for a file, `{k:"test", file, name, ms, ok, nesting, suite}`
 * for a test or suite that passed or failed (a skipped or todo one has no time worth recording).
 *
 * @param {AsyncIterable<{type: string, data: any}>} source
 */
export default async function* reporter(source) {
    for await (const e of source) {
        const d = e.data;
        if (!d || !d.file) continue;
        if (e.type === "test:complete" && isFileEvent(d)) {
            yield JSON.stringify({ k: "file", file: d.file, ms: d.details?.duration_ms ?? 0 }) + "\n";
        } else if ((e.type === "test:pass" || e.type === "test:fail") && !d.skip && !d.todo) {
            if (isFileEvent(d)) continue;
            yield JSON.stringify({
                k: "test", file: d.file, name: d.name, ms: d.details?.duration_ms ?? 0, ok: e.type === "test:pass",
                nesting: d.nesting, suite: d.details?.type === "suite",
            }) + "\n";
        }
    }
}
