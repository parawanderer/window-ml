// mobile-imports.test.mjs — the phone app may only take VALUES from the folders Metro watches.
//
// This exists because the failure is silent in every cheap place it could be caught. A value imported from, say,
// `src/text-size.ts` typechecks (tsc resolves the whole repo), runs in the simulator's debug bundle, and then fails
// the RELEASE build with "Unable to resolve module" — which `xcodebuild` reports as exit 65 and the install script
// prints as three lines of notes and `** BUILD FAILED **`. It shipped once, on a green PR.
//
// TYPE-ONLY imports are exempt and deliberately so: they are erased before Metro sees them, which is why the app can
// name `SessionSummary` from `src/session-host.ts` without that file having to move.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/** The folders `mobile/metro.config.js` adds to Metro's watch list, read from it rather than repeated here. */
function watched() {
    const cfg = readFileSync(join(ROOT, "mobile/metro.config.js"), "utf8");
    const m = cfg.match(/config\.watchFolders\s*=\s*\[([^\]]*)\]/);
    assert.ok(m, "metro.config.js still sets watchFolders as a literal list");
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** Every `.ts`/`.tsx` under a directory, recursively. */
function sources(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) sources(p, out);
        else if (/\.tsx?$/.test(name)) out.push(p);
    }
    return out;
}

test("the phone app imports values only from the folders Metro watches", () => {
    const ok = watched();
    const files = [join(ROOT, "mobile/App.tsx"), ...sources(join(ROOT, "mobile/src"))];
    const bad = [];
    for (const file of files) {
        const text = readFileSync(file, "utf8");
        // `import type …` and `import { type X }` are erased; anything else brings the module into the bundle.
        for (const m of text.matchAll(/^import\s+(type\s+)?([^;]*?)\s*from\s*"((?:\.\.\/)+src\/[^"]+)"/gm)) {
            const [, typeOnly, clause, spec] = m;
            if (typeOnly) continue;
            if (/^\s*\{\s*(type\s+[^,}]+,?\s*)+\}$/.test(clause)) continue;   // every member marked `type`
            const rest = spec.replace(/^(\.\.\/)+src\//, "");
            if (!ok.some((d) => rest.startsWith(`${d}/`))) bad.push(`${file.slice(ROOT.length + 1)} → ${spec}`);
        }
    }
    assert.deepEqual(bad, [], `these would fail the RELEASE bundle; move them under ${ok.join(", ")}`);
});
