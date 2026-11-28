// The build-time provenance stamp (scripts/gen-build-info.mjs) that agent_api_docs reports so the agent can
// find + read its own source. The only edge-case logic is normalizing the git remote to a public HTTPS URL;
// the rest is git plumbing captured at build time. Also assert writeBuildInfo produces a well-formed module.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { normalizeRepoUrl, writeBuildInfo, dirtyPathsFromStatus } from "../scripts/gen-build-info.mjs";

test("normalizeRepoUrl: scp-style, ssh, and https remotes all become a clean public HTTPS URL", () => {
    assert.equal(normalizeRepoUrl("git@github.com:parawanderer/window-ml.git"), "https://github.com/parawanderer/window-ml");
    assert.equal(normalizeRepoUrl("ssh://git@github.com/parawanderer/window-ml.git"), "https://github.com/parawanderer/window-ml");
    assert.equal(normalizeRepoUrl("https://github.com/parawanderer/window-ml.git"), "https://github.com/parawanderer/window-ml");
    assert.equal(normalizeRepoUrl("https://github.com/parawanderer/window-ml"), "https://github.com/parawanderer/window-ml");
    assert.equal(normalizeRepoUrl(""), "");
    assert.equal(normalizeRepoUrl(undefined), "");
});

test("dirtyPathsFromStatus: parses porcelain paths, incl. the trim-eaten first line and renames", () => {
    // The `git()` helper trims the whole output → the FIRST line loses its leading status space, so a
    // fixed slice(3) mangled it (scripts→cripts). The regex parse must survive both forms.
    const status = "M scripts/gen-build-info.mjs\n M tools.ts\n?? new-file.ts\nR  old/path.ts -> new/path.ts";
    assert.deepEqual(dirtyPathsFromStatus(status), [
        "scripts/gen-build-info.mjs",   // first line, leading space already trimmed off — still parses whole
        "tools.ts",
        "new-file.ts",                  // untracked (??)
        "new/path.ts",                  // rename → the NEW path
    ]);
    assert.deepEqual(dirtyPathsFromStatus(""), [], "clean tree → no files");
    assert.equal(dirtyPathsFromStatus(Array.from({ length: 150 }, (_, i) => ` M f${i}.ts`).join("\n")).length, 100, "capped at 100");
});

test("writeBuildInfo stamps a BUILD_INFO module with the provenance fields", () => {
    const out = writeBuildInfo();
    const src = readFileSync(out, "utf8");
    assert.match(src, /export const BUILD_INFO =/);
    for (const key of ["commit", "shortCommit", "dirty", "dirtyFiles", "commitDate", "repoUrl", "commitUrl", "buildTime"])
        assert.match(src, new RegExp(`"${key}":`), `BUILD_INFO carries ${key}`);
    // buildTime is a real ISO timestamp; dirty is a boolean (uncommitted-changes flag).
    assert.match(src, /"buildTime": "\d{4}-\d{2}-\d{2}T[\d:.]+Z"/);
    assert.match(src, /"dirty": (true|false)/);
    // THE DIFF IS NOT ONE OF THEM. It is written beside it, because nothing tree-shakes a property off an object:
    // the day the chat page started importing BUILD_INFO for an export's provenance, a whole `git diff` went into
    // a bundle that never reads one.
    assert.doesNotMatch(src, /"dirtyDiff":/, "the diff is not a field on BUILD_INFO");
    const diff = readFileSync(out.replace("build-info.gen.ts", "build-diff.gen.ts"), "utf8");
    assert.match(diff, /export const BUILD_DIFF = "/);
});

// --- what Chrome will load: no source carries a character that makes a bundle "not UTF-8" ---

test("no file under src/ holds a literal U+FFFE or U+FFFF: Chrome refuses a content script that does, and any module can reach one", async () => {
    // A literal U+FFFF in a regex range (py-format.ts) reached dist/injected.js once table-literals.ts imported it, and
    // Chrome then refused injected.js as "not UTF-8 encoded": every e2e spec that approves an origin failed. Write `￿`.
    const { readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = new URL("../src", import.meta.url).pathname;
    // build-diff.gen.ts is untracked and holds the working tree's own diff at build time (a removed line too), as
    // check-dist-fresh.mjs's NOT_SOURCES says; a clean tree's build, which is what ships, writes it empty.
    const bad = [];
    const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f !== "build-diff.gen.ts" && /\.(m?[jt]sx?|css|html)$/.test(f) && /[￾￿]/.test(readFileSync(p, "utf8"))) bad.push(p.slice(root.length + 1)); } };
    walk(root);
    assert.deepEqual(bad, []);
});
