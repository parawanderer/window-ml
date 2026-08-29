// The build-time provenance stamp (scripts/gen-build-info.mjs) that agent_api_docs reports so the agent can
// find + read its own source. The only edge-case logic is normalizing the git remote to a public HTTPS URL;
// the rest is git plumbing captured at build time. Also assert writeBuildInfo produces a well-formed module.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { normalizeRepoUrl, writeBuildInfo } from "../scripts/gen-build-info.mjs";

test("normalizeRepoUrl: scp-style, ssh, and https remotes all become a clean public HTTPS URL", () => {
    assert.equal(normalizeRepoUrl("git@github.com:parawanderer/window-ml.git"), "https://github.com/parawanderer/window-ml");
    assert.equal(normalizeRepoUrl("ssh://git@github.com/parawanderer/window-ml.git"), "https://github.com/parawanderer/window-ml");
    assert.equal(normalizeRepoUrl("https://github.com/parawanderer/window-ml.git"), "https://github.com/parawanderer/window-ml");
    assert.equal(normalizeRepoUrl("https://github.com/parawanderer/window-ml"), "https://github.com/parawanderer/window-ml");
    assert.equal(normalizeRepoUrl(""), "");
    assert.equal(normalizeRepoUrl(undefined), "");
});

test("writeBuildInfo stamps a BUILD_INFO module with the provenance fields", () => {
    const out = writeBuildInfo();
    const src = readFileSync(out, "utf8");
    assert.match(src, /export const BUILD_INFO =/);
    for (const key of ["commit", "shortCommit", "commitDate", "repoUrl", "commitUrl", "buildTime"])
        assert.match(src, new RegExp(`"${key}":`), `BUILD_INFO carries ${key}`);
    // buildTime is a real ISO timestamp.
    assert.match(src, /"buildTime": "\d{4}-\d{2}-\d{2}T[\d:.]+Z"/);
});
