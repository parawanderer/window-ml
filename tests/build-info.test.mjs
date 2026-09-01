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
});
