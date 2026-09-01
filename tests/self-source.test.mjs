// The self-source auto-approve gate (self-source.ts) — pure + SECURITY-CRITICAL (no human in the loop), so
// this pins exactly what auto-approves and hammers the escapes: wrong repo/owner, spoofed hosts, prose
// endpoints (the prompt-injection surface), userinfo/traversal tricks, non-https.
import { test } from "node:test";
import assert from "node:assert";
import { isSelfSourceUrl, parseRepo } from "../self-source.ts";

const REPO = "https://github.com/parawanderer/window-ml";
const ok = (url, repo = REPO) => assert.equal(isSelfSourceUrl(url, repo), true, `should AUTO-APPROVE: ${url}`);
const no = (url, repo = REPO) => assert.equal(isSelfSourceUrl(url, repo), false, `should GATE: ${url}`);

test("parseRepo: owner/repo from the common repo-url shapes; null otherwise", () => {
    assert.deepEqual(parseRepo("https://github.com/parawanderer/window-ml"), { owner: "parawanderer", repo: "window-ml" });
    assert.deepEqual(parseRepo("https://github.com/parawanderer/window-ml.git"), { owner: "parawanderer", repo: "window-ml" });
    assert.deepEqual(parseRepo("https://www.github.com/o/r/"), { owner: "o", repo: "r" });
    assert.equal(parseRepo("https://gitlab.com/o/r"), null);
    assert.equal(parseRepo(""), null);
});

test("ALLOW: raw file content + structural/code API endpoints of THIS repo", () => {
    ok("https://raw.githubusercontent.com/parawanderer/window-ml/main/injected.ts");
    ok("https://raw.githubusercontent.com/parawanderer/window-ml/abc123/sidebar/app.tsx");
    ok("https://api.github.com/repos/parawanderer/window-ml/contents/injected.ts");
    ok("https://api.github.com/repos/parawanderer/window-ml/commits");
    ok("https://api.github.com/repos/parawanderer/window-ml/git/trees/main");
    ok("https://api.github.com/repos/parawanderer/window-ml/git/blobs/deadbeef");
    ok("https://api.github.com/repos/parawanderer/window-ml/tags");
    ok("https://api.github.com/repos/parawanderer/window-ml/branches/main");
    // case-insensitive host + owner/repo
    ok("https://RAW.GITHUBUSERCONTENT.COM/ParaWanderer/Window-ML/main/README.md");
    // a query naming a prose word is fine — the gate reads PATH segments, not the query (this is file content)
    ok("https://api.github.com/repos/parawanderer/window-ml/contents/x?ref=issues");
});

test("GATE: user-generated PROSE endpoints (the prompt-injection surface) never auto-approve", () => {
    no("https://api.github.com/repos/parawanderer/window-ml/issues");
    no("https://api.github.com/repos/parawanderer/window-ml/issues/1");
    no("https://api.github.com/repos/parawanderer/window-ml/issues/comments");
    no("https://api.github.com/repos/parawanderer/window-ml/pulls/2");
    no("https://api.github.com/repos/parawanderer/window-ml/pulls/2/comments");
    no("https://api.github.com/repos/parawanderer/window-ml/pulls/2/reviews");
    no("https://api.github.com/repos/parawanderer/window-ml/comments/9");
    no("https://api.github.com/repos/parawanderer/window-ml/discussions/3");
    no("https://api.github.com/repos/parawanderer/window-ml/releases");   // release BODIES are free prose too
});

test("GATE: a DIFFERENT repo / owner / an unresolvable repo url", () => {
    no("https://raw.githubusercontent.com/attacker/window-ml/main/x.ts");          // wrong owner
    no("https://raw.githubusercontent.com/parawanderer/other-repo/main/x.ts");     // wrong repo
    no("https://api.github.com/repos/attacker/window-ml/contents/x");
    no("https://api.github.com/repos/parawanderer/window-ml-evil/contents/x");     // repo must match EXACTLY
    no("https://raw.githubusercontent.com/parawanderer/window-ml/main/x.ts", "");  // no repo url → nothing self
    no("https://api.github.com/repos/parawanderer/window-ml/contents/x", "https://gitlab.com/o/r");
});

test("GATE: spoofed / non-github hosts, userinfo + traversal tricks, non-https", () => {
    no("https://raw.githubusercontent.com.evil.com/parawanderer/window-ml/main/x.ts");  // suffix-spoofed host
    no("https://evil.com/raw.githubusercontent.com/parawanderer/window-ml/main/x.ts");  // host is evil.com
    no("https://api.github.com.evil.com/repos/parawanderer/window-ml/contents/x");
    no("https://api.github.com@evil.com/repos/parawanderer/window-ml/contents/x");       // userinfo → host is evil.com
    no("http://raw.githubusercontent.com/parawanderer/window-ml/main/x.ts");             // not https
    no("https://api.github.com/repos/parawanderer/window-ml/../../attacker/repo/issues"); // normalizes to attacker/repo/issues
    no("https://gist.githubusercontent.com/parawanderer/deadbeef/raw/x.ts");             // gist host, not raw
    no("not a url");
});
