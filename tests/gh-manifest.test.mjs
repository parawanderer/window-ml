// gh-manifest.test.mjs — what the program manifest for `gh` (src/shell/manifests/gh.json) must say, written BEFORE the manifest (adversarial rows failing first). The free tier is the READ-ONLY subcommands; everything that writes on GitHub or on disk is an effect; the two calls that print the token, and every call that writes gh's own config, are `unknown` (they ask, whatever the placement's bound). Run: node --import tsx --test tests/gh-manifest.test.mjs
//
// Why a new file and not tests/program-manifest.test.mjs: that file's fixtures (tests/fixtures/program-calls/gh.json) are
// the recorded vectors shared with window-ml-host; these are the stricter, hand-written properties of one program.
//
// What "free" means here. describeCall only DESCRIBES; src/effects.ts `free()` decides against a placement's bound. A
// gh call carries `read(net(*))` (the manifest cannot name the host, only a direction), and a bound covers `net(*)` only
// when a network allowlist holds "*". So by default NO gh call is free, on any placement; the rows below pin the
// description (`readOnly`) and, separately, the finding about the "*" allowlist.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { describeCall, validateManifest } = await import("../src/shell/program-manifest.ts");
const { effectKey, free, boundFor } = await import("../src/effects.ts");

const FILE = new URL("../src/shell/manifests/gh.json", import.meta.url);
const gh = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : null;
const V = { version: "2.103.0" };
const inRoot = ({ arg, given }) => ({ kind: "fs", path: arg === "cwd" || arg === "repo" ? "/r" : `/r/${given}`, inRoot: true, secret: false, exists: true, isRoot: arg === "cwd" || arg === "repo", topLevel: false });
const need = () => { assert.ok(gh, "src/shell/manifests/gh.json exists"); return gh; };
const desc = (argv, opts = {}) => describeCall(argv, need(), { ...V, resolve: inRoot, ...opts });
const keys = (d) => d.effects === "unknown" ? "unknown" : d.effects.map(effectKey).sort();

/** Described, nothing but reads, no runner: the shape the free tier may run. */
const readOnly = (d) => d.described && d.effects !== "unknown" && d.effects.every((e) => e.op === "read") && !d.runner;
const writesNet = (d) => d.effects !== "unknown" && d.effects.some((e) => e.op === "write" && e.res.kind === "net");
const writesFs = (d) => d.effects !== "unknown" && d.effects.some((e) => e.op === "write" && e.res.kind === "fs");
const execs = (d) => d.effects !== "unknown" && d.effects.some((e) => e.op === "exec");
const sandboxAny = boundFor("host-sandbox", { netAllowlist: ["*"] });
const sandbox = boundFor("host-sandbox");

const argvOf = (s) => ["gh", ...s.split(/\s+/).filter(Boolean)];

// --- the manifest ---

test("gh.json validates and names gh with a version probe", () => {
    assert.deepEqual(validateManifest(need()), []);
    assert.equal(gh.program, "gh");
    assert.deepEqual(gh.version.args, ["--version"]);
    assert.equal(new RegExp(gh.version.pattern).exec("gh version 2.103.0 (2026-10-21)")?.[1], "2.103.0");
});

// --- the free tier: read-only subcommands (every one described as reads only) ---

const READS = [
    "pr view 12", "pr view 12 --json title,state --jq .title", "pr view --comments", "pr list --state open --limit 5 --json number",
    "pr diff 12", "pr diff 12 --name-only", "pr checks 12", "pr checks 12 --required", "pr status",
    "issue view 7", "issue list --label bug --json number,title", "run view 99 --log", "run list --limit 3 --json status",
    "release view v1.2.3", "release list --limit 3", "repo view", "repo view cli/cli --json description",
    "label list", "search prs fix --repo cli/cli", "search issues crash --json number", "search repos window.ml", "search code foo", "search commits bar",
    "api repos/cli/cli/pulls", "api repos/cli/cli/issues --paginate --jq .[].number", "api repos/cli/cli --template {{.name}}", "api repos/cli/cli -i",
    "pr list -R cli/cli --template {{.number}}", "auth status",
];

for (const s of READS) {
    test(`free-tier shape: gh ${s} is described as reads only`, () => {
        const d = desc(argvOf(s));
        assert.equal(d.described, true, d.why.join("; "));
        assert.equal(readOnly(d), true, JSON.stringify(keys(d)));
        assert.ok(keys(d).includes("read:net:*"), "a read is still a credentialed request to the network: read(net(*)), never an empty effect");
        assert.equal(d.runner, false);
    });
}

test("--version and help describe with no effect at all", () => {
    for (const s of ["--version", "--help", "help environment", "help formatting", "pr --help"]) {
        const d = desc(argvOf(s));
        assert.equal(d.described, true, `${s}: ${d.why.join("; ")}`);
        assert.deepEqual(keys(d), [], s);
    }
});

test("a read-only gh call is covered only where the person allowlisted every host", () => {
    for (const s of READS) {
        const d = desc(argvOf(s));
        assert.equal(free(d.effects, sandbox), false, `${s}: net(*) is outside the default sandbox bound`);
        assert.equal(free(d.effects, sandboxAny), true, `${s}: free with a "*" allowlist`);
        assert.equal(free(d.effects, boundFor("host-plain")), false, `${s}: the plain host bounds nothing`);
    }
});

test("pr checks answers 8 (pending) without failing; nothing else of gh does", () => {
    assert.deepEqual(desc(argvOf("pr checks 12")).okCodes, [8]);
    assert.deepEqual(desc(argvOf("pr view 12")).okCodes, [0]);
    assert.ok(!desc(argvOf("pr checks 12")).okCodes.includes(1), "1 is a failing check, still a failure");
});

// --- enumerate, do not sample: the set of read-only leaves is exactly this ---

function leaves(cmd, at = []) {
    const subs = Object.entries(cmd.subcommands ?? {});
    return subs.length ? subs.flatMap(([n, s]) => leaves(s, [...at, n])) : [[at, cmd]];
}

const FREE_LEAVES = ["api", "auth status", "help", "label list", "pr checks", "pr diff", "pr list", "pr status", "pr view", "issue list", "issue view",
    "release list", "release view", "repo view", "run list", "run view", "search code", "search commits", "search issues", "search prs", "search repos"].sort();

test("exactly these subcommands of the manifest carry only read effects; every other leaf writes, runs code or is unknown", () => {
    const readish = (cmd) => cmd.effects.every((e) => e === "read" || (typeof e === "object" && e.network?.direction === "read"));
    const got = leaves(need().command).filter(([, c]) => readish(c)).map(([at]) => at.join(" ")).sort();
    assert.deepEqual(got, FREE_LEAVES);
});

test("no flag of a read-only subcommand adds a write, a runner or a path write; the ones that add anything add `unknown`", () => {
    const bad = [];
    for (const [at, cmd] of leaves(need().command)) {
        if (!FREE_LEAVES.includes(at.join(" ")) || at.join(" ") === "api") continue;
        for (const [flag, f] of Object.entries(cmd.flags)) {
            const onlyUnknown = (f.effects ?? []).every((e) => e === "unknown");
            if (!onlyUnknown || f.runner || f.valueIsPath === "write" || f.valueIsDir) bad.push(`${at.join(" ")} ${flag}`);
        }
    }
    assert.deepEqual(bad, []);
});

test("gh api: the flags that add anything are exactly the ones that can write, send a file or change the host", () => {
    const api = need().command.subcommands.api;
    const adds = Object.entries(api.flags).filter(([, f]) => (f.effects?.length ?? 0) || f.valueIsPath || f.echoes).map(([k]) => k).sort();
    assert.deepEqual(adds, ["--field", "--header", "--hostname", "--input", "--method", "--raw-field", "--verbose", "-F", "-H", "-X", "-f"].sort());
    assert.equal(api.maxOperands, 1);
});

// --- everything that writes is an effect ---

const WRITES = {
    "pr create --title t --body b": { net: true, fs: true, exec: true },
    "pr merge 12 --squash": { net: true, fs: true, exec: true },
    "pr close 12": { net: true }, "pr edit 12 --add-label x": { net: true }, "pr comment 12 --body hi": { net: true },
    "pr review 12 --approve": { net: true }, "pr checkout 12": { net: true, fs: true, exec: true },
    "issue create --title t --body b": { net: true }, "issue edit 7 --title t": { net: true }, "issue comment 7 --body hi": { net: true }, "issue close 7": { net: true },
    "repo clone cli/cli": { fs: true, exec: true }, "repo fork cli/cli": { net: true, fs: true, exec: true }, "repo create x --private": { net: true, fs: true, exec: true }, "repo delete cli/cli --yes": { net: true },
    "run download 99": { fs: true }, "run rerun 99": { net: true }, "run cancel 99": { net: true },
    "release create v1 a.zip": { net: true }, "release upload v1 a.zip": { net: true }, "release download v1": { fs: true },
    "gist create a.txt": { net: true }, "gist delete abc": { net: true },
    "secret set X --body v": { net: true }, "ssh-key add k.pub": { net: true }, "gpg-key add k.asc": { net: true },
    "api -X POST repos/x/y/issues": { net: true }, "api repos/x/y/issues -f title=t": { net: true },
    "api repos/x/y --input body.json": { net: true }, "api -X DELETE repos/x/y": { net: true },
};

for (const [s, want] of Object.entries(WRITES)) {
    test(`writes are declared: gh ${s}`, () => {
        const d = desc(argvOf(s));
        assert.equal(d.described, true, d.why.join("; "));
        assert.equal(readOnly(d), false, JSON.stringify(keys(d)));
        assert.equal(writesNet(d), !!want.net, `network write: ${JSON.stringify(keys(d))}`);
        assert.equal(writesFs(d), !!want.fs, `filesystem write: ${JSON.stringify(keys(d))}`);
        assert.equal(execs(d), !!want.exec, `exec: ${JSON.stringify(keys(d))}`);
    });
}

test("a body or notes file is a path the host can resolve, read from disk", () => {
    for (const s of ["pr comment 12 --body-file notes.md", "issue create --title t --body-file b.md", "release create v1 --notes-file n.md", "api x --input b.json"]) {
        const d = desc(argvOf(s));
        assert.equal(d.described, true, `${s}: ${d.why.join("; ")}`);
        assert.ok(d.pathArgs.some((p) => p.role === "read"), s);
    }
});

test("release upload's assets and gist create's files are read paths; the tag and the repo are not", () => {
    assert.deepEqual(desc(argvOf("release upload v1 a.zip b.zip")).pathArgs.map((p) => p.arg), [4, 5]);
    assert.deepEqual(desc(argvOf("gist create a.txt")).pathArgs.map((p) => p.arg), [3]);
});

// --- the adversarial rows: NOT free ---

const NOT_READONLY = [
    "auth token", "auth token --hostname github.com", "auth status --show-token", "auth status -t", "auth status -ta",
    "api -X DELETE repos/x/y", "api --method DELETE repos/x/y", "api -XDELETE repos/x/y", "api --method=DELETE repos/x/y", "api -X=DELETE repos/x/y", "api -iX DELETE repos/x/y",
    "api repos/x/y/issues -f title=t", "api repos/x/y/issues --raw-field title=t", "api repos/x/y/issues -F body=@/etc/passwd", "api repos/x/y/issues --field body=@/etc/passwd",
    "api graphql -f query={viewer{login}}", "api repos/x/y --input -", "api repos/x/y -H X-HTTP-Method-Override:DELETE",
    "api -X GET repos/x/y", "api --hostname evil.example repos/x/y", "api --hostname=evil.example repos/x/y",
    "pr merge 12", "pr merge", "pr create", "pr close 12", "pr checkout 12",
    "alias set x pr merge", "alias set --shell x id", "extension install owner/gh-x", "config set pager sh",
    "repo clone cli/cli", "repo clone cli/cli x -- --upload-pack=sh", "repo fork cli/cli", "repo delete cli/cli",
    "run download 99", "run rerun 99", "release create v1", "release download v1", "release upload v1 x",
    "gist create x", "secret set X", "ssh-key add k.pub", "gpg-key add k.asc", "auth login", "auth logout", "auth refresh", "auth setup-git",
    "pr view --web", "repo view --web", "issue view 7 --web", "pr comment 12 --editor",
];

for (const s of NOT_READONLY) {
    test(`adversarial: gh ${s} is not a read-only call`, () => {
        const d = desc(argvOf(s));
        assert.equal(readOnly(d), false, JSON.stringify(keys(d)));
        assert.equal(free(d.effects, sandbox), false);
        assert.equal(free(d.effects, boundFor("host-plain")), false);
    });
}

const UNKNOWN = ["auth token", "auth token --hostname github.com", "auth status --show-token", "auth status -t", "auth status -ta", "auth status --hostname github.com",
    "api --hostname evil.example repos/x/y", "api --hostname=evil.example repos/x/y", "alias set x pr merge", "alias set --shell x id", "extension install owner/gh-x",
    "config set pager sh", "auth login", "auth logout", "auth refresh", "auth setup-git", "pr view --web", "pr comment 12 --editor",
    "api repos/x/y -F body=@/etc/passwd", "api repos/x/y --field body=@/etc/passwd", "repo clone cli/cli x -- --upload-pack=sh"];

for (const s of UNKNOWN) {
    test(`asks whatever the bound: gh ${s} is unknown even with every host allowlisted`, () => {
        const d = desc(argvOf(s));
        assert.equal(d.effects, "unknown", JSON.stringify(keys(d)));
        assert.equal(d.described, false);
        assert.equal(free(d.effects, sandboxAny), false);
    });
}

test("the two calls that print the token are `unknown` by their own subcommand and flag, not by an accident of omission", () => {
    const m = need().command.subcommands.auth;
    assert.deepEqual(m.subcommands.token.effects, ["unknown"]);
    for (const f of ["--show-token", "-t"]) assert.deepEqual(m.subcommands.status.flags[f].effects, ["unknown"], f);
    assert.deepEqual(m.subcommands.status.flags["--hostname"].effects, ["unknown"]);
});

test("an unlisted subcommand, an extension, an alias or a shortcut is unknown", () => {
    for (const s of ["co 12", "my-extension run", "workflow run ci.yml", "codespace ssh", "browse", "copilot", "pr not-a-command", "pr update-branch 12", "status", "preview", "project list", "cache delete --all"]) {
        assert.equal(desc(argvOf(s)).effects, "unknown", s);
    }
});

test("an unlisted flag on a read-only subcommand is unknown", () => {
    for (const s of ["pr view --wml-not-a-flag", "api repos/x/y --wml-not-a-flag", "search prs x --wml-not-a-flag"]) assert.equal(desc(argvOf(s)).described, false, s);
});

test("a changed environment is not described: token, host, config dir, editor, browser, pager, proxy", () => {
    for (const n of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST", "GH_REPO", "GH_CONFIG_DIR", "XDG_CONFIG_HOME", "GH_EDITOR", "GH_BROWSER", "BROWSER",
        "GH_PAGER", "PAGER", "GH_DEBUG", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "GIT_SSH_COMMAND", "GIT_DIR"]) {
        assert.equal(desc(argvOf("pr view 1"), { envSet: [n] }).described, false, n);
    }
    assert.equal(desc(argvOf("pr view 1"), { envSet: ["NO_COLOR"] }).described, true);
});

test("the version pin: unreported, below the range or at 3 is not described", () => {
    for (const version of [undefined, "1.0.0", "2.39.0", "3.0.0"]) assert.equal(describeCall(argvOf("pr view 1"), need(), { version }).described, false, String(version));
    assert.equal(describeCall(argvOf("pr view 1"), need(), { version: "2.40.0" }).described, true);
});

test("api --verbose echoes (the request headers are printed back)", () => {
    assert.equal(desc(argvOf("api repos/x/y --verbose")).echoes, true);
    assert.equal(desc(argvOf("api repos/x/y")).echoes, false);
});

// --- findings pinned (they flip when the spec grows the missing term) ---

test("FINDING: with a '*' network allowlist a write to GitHub is covered as well as a read, since the bound has no per-direction split", () => {
    const d = desc(argvOf("pr merge 12"));
    assert.equal(writesNet(d), true);
    // The net bound pairs every allowlisted host with BOTH ops (effects.ts boundFor), so the net write is covered; only the
    // filesystem and exec parts (here: the worktree write, git) are judged separately. gh api -X DELETE has no fs part:
    assert.equal(free(desc(argvOf("api -X DELETE repos/x/y")).effects, sandboxAny), true);
});

test("FINDING: the description carries no 'as the person' term: a read and a read of nothing credentialed have the same effects", () => {
    // PROGRAM_MANIFEST.md's effect vocabulary is read/write/write-names/runs-code/unknown/network{direction}; there is no use(secret) for a program.
    for (const s of READS) assert.ok(desc(argvOf(s)).effects.every((e) => e.res.kind !== "secret"), s);
});
