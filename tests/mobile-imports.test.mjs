// mobile-imports.test.mjs — the phone app may only take VALUES from the folders Metro watches.
//
// This exists because the failure is silent in every cheap place it could be caught. A value imported from, say,
// `src/text-size.ts` typechecks (tsc resolves the whole repo), runs in the simulator's debug bundle, and then fails
// the RELEASE build with "Unable to resolve module" — which `xcodebuild` reports as exit 65 and the install script
// prints as three lines of notes and `** BUILD FAILED **`. It shipped once, on a green PR.
//
// TYPE-ONLY imports are exempt and deliberately so: they are erased before Metro sees them, which is why the app can
// name `SessionSummary` from `src/session/session-host.ts` without that file having to move.

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

// --- and nothing it reaches may need a package the phone does not have ---
// The test above checks ONE HOP: that the app's own files take values only from the watched folders. That
// argument was sound and then stopped covering the thing it was built for, because a watched folder can
// acquire a dependency of its own. `src/pairing/api.ts` gained `import { signal } from "@preact/signals"` for
// three signals no phone screen reads; the file is in a watched folder, so the hop check passed, and Metro
// resolves a module-scope import whether or not anything uses what it binds. Every PR stayed green while the
// release bundle failed on main for two days, because `mobile-android` is skipped on a PR that touches none of
// the watched paths. So: walk the graph the phone actually reaches, and demand every package it lands on be one
// `mobile/` declares.
test("nothing the phone reaches imports a package mobile/ does not depend on", () => {
    const ok = watched().map((d) => join(ROOT, "src", d));
    const mobilePkg = JSON.parse(readFileSync(join(ROOT, "mobile/package.json"), "utf8"));
    const have = new Set([...Object.keys(mobilePkg.dependencies ?? {}), ...Object.keys(mobilePkg.devDependencies ?? {})]);

    /** Resolve a relative specifier the way Metro does: the file itself, a `.ts`/`.tsx` extension, or its index. */
    const resolve = (fromFile, spec) => {
        const base = join(fromFile, "..", spec);
        for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
            try { if (statSync(c).isFile()) return c; } catch { /* not this one */ }
        }
        return null;
    };

    // Seeded with the app's own files; the walk then follows only into shared `src/` modules, which is where a
    // dependency the phone has never heard of can hide.
    const seen = new Set();
    const queue = [join(ROOT, "mobile/App.tsx"), ...sources(join(ROOT, "mobile/src"))];
    const bad = [];
    while (queue.length) {
        const file = queue.pop();
        if (seen.has(file)) continue;
        seen.add(file);
        const text = readFileSync(file, "utf8");
        // `export … from` pulls a module in exactly as an import does, so both forms are walked.
        for (const m of text.matchAll(/^(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s*"([^"]+)"|^import\s+"([^"]+)"/gm)) {
            const [, typeOnly, clause, spec, bareSideEffect] = m;
            const target = spec ?? bareSideEffect;
            if (typeOnly) continue;
            if (clause && /^\s*\{\s*(type\s+[^,}]+,?\s*)+\}$/.test(clause)) continue;   // every member marked `type`
            if (target.startsWith(".")) {
                const next = resolve(file, target);
                // Only shared `src/` modules are followed: the app's own tree is already fully seeded above.
                if (next && (next.startsWith(join(ROOT, "src")) || next.startsWith(join(ROOT, "mobile")))) queue.push(next);
                continue;
            }
            // A bare specifier: `@scope/name` or `name`, with any subpath dropped.
            const pkg = target.startsWith("@") ? target.split("/").slice(0, 2).join("/") : target.split("/")[0];
            if (have.has(pkg) || pkg.startsWith("node:")) continue;
            // Only a SHARED module is a finding here; the app's own files are the first test's business, and a
            // missing dep of its own would fail its build loudly rather than silently.
            if (ok.some((d) => file.startsWith(d))) bad.push(`${file.slice(ROOT.length + 1)} → ${pkg}`);
        }
    }
    assert.deepEqual(bad, [], "Metro resolves a module-scope import whether or not the phone uses what it binds; move this out of the shared module, or add it to mobile/package.json");
});
