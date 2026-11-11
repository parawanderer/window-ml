// redteam-gh-credential.test.mjs — what no script, page, stored manifest or model draft may get of the person's GitHub
// token (window-ml#1545): the credential the process host injects into a `gh` call. Written as the adversarial half of
// the design's own rows (tests/ml-sh.test.mjs, tests/sh-call.test.mjs, tests/stored-manifests.test.mjs): those pin what
// the happy path sends, these pin what a hostile caller cannot make it send, and what no surface may carry once it did.
//
// The HOST half — which argv0, which resolved binary, which pinned manifest bytes, which ports a grant is honoured for
// — is window-ml-host's own (src/credential.rs `honour`, measured in its tests/stdio.rs); a row here cannot measure it.
// What it can measure is the WORKER's half of a refusal: a host that answers CredentialRefused must end the call with
// no start (the token is read at start, after the verdict), no retry without the credential, no card, and no token
// anywhere. Each row was re-run against the weakened guard its comment names, so none of them can pass vacuously.
//
// Not repeated here: planSpawn's identity check (a deep-equal copy of gh.json is not the SHIPPED_MANIFESTS object and so
// gets no credential, tests/sh-call.test.mjs) — no hostile path reaches a copy the unit row misses, since a page writes
// no manifest and a model-proposed one goes through draftRequest, which has its own row. The validateManifest wire
// shapes and the store-time refusal are rows of their own in tests/program-manifest.test.mjs and
// tests/stored-manifests.test.mjs; the one thing they do not cover, an entry READ back from storage, is a row below.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runOn } from "./isolated-harness.mjs";
import { fakeNativeHost } from "./fake-native-host.mjs";

const T = { timeout: Number(process.env.ML_SH_T) || 60000 };
const ON = { shellEnabled: true, shellRoots: ["/w/proj"] };
const NO_FETCH = { fetches: [] };
const TOKEN = `gho_${"A1b2".repeat(9)}`;            // a gh OAuth token: 40 characters after the prefix
const PAT = `github_pat_${"x_Y1".repeat(20)}`;      // a fine-grained token: a different documented shape
const TOKEN_SHAPED = /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/;

/** The value an exec returned, parsed from the result the model read (`value: <json>`). */
function valueOf(result) {
    const m = /^value: (.*)$/m.exec(result) ?? /^(\{.*\})$/m.exec(result);
    assert.ok(m, `no value in: ${result}`);
    return JSON.parse(m[1]);
}

/** A script that runs `argv` through ml.sh and returns what it got, or what it threw. */
const runs = (argv) => () => `(async () => { try { return JSON.stringify(await ml.sh.run(${JSON.stringify(argv)})); } catch (e) { return JSON.stringify({ threw: e.message, code: e.code }); } })()`;

/** Answer every nested ask this way, recording each one asked. */
function answering(decision) {
    const asked = [];
    return {
        asked,
        onStep: async (bg, ev) => {
            for (const a of ev.asks ?? []) {
                if (a.state !== "pending" || asked.some((x) => x.id === a.id)) continue;
                asked.push(a);
                if (decision !== null) void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, ask: a.id, decision } });
            }
        },
    };
}

/**
 * A fake host that refuses, as window-ml-host's `honour` does, every spawn carrying a credential it would not grant,
 * answering `CredentialRefused` at the spawn (the real host's refusal point: session.rs `honour`, before the facts).
 * Every other call goes to the fake unchanged, so the version probe and an uncredentialed call behave normally.
 * @param host a fakeNativeHost
 * @param grants whether this host would honour the spawn's credential
 */
function credentialRefusing(host, grants = () => false) {
    const refused = [], seen = [];
    return {
        refused,
        /** Every spawn the worker sent, refused or forwarded: `{ arg0, credential, probe }`. */
        seen,
        onNative: (name, port) => {
            const forward = host.onNative(name, port);
            if (!forward) return null;
            return (msg) => {
                if (msg.call === "spawn") seen.push({ arg0: msg.args.argv[0], credential: !!msg.args.credential, probe: msg.args.argv.includes("--version") });
                if (msg.call === "spawn" && msg.args?.credential && !grants(msg.args)) {
                    refused.push(msg.args.argv[0]);
                    port.send({ seq: msg.seq, error: { code: "CredentialRefused", message: "the github credential is gh's alone, named bare and found on PATH" } });
                    return;
                }
                forward(msg);
            };
        },
    };
}

const spawns = (host) => host.calls.filter((c) => c.call === "spawn");
/** The spawn of a call (not the worker's own `--version` probe, which spawns the same program). */
const spawnOf = (host, arg0) => spawns(host).find((c) => c.args.argv[0] === arg0 && !c.args.argv.includes("--version"));
/** The starts that are not the worker's version probe's: the only ones a credentialed call could add one to. */
const startsOfCalls = (host) => {
    const probes = new Set(spawns(host).filter((s) => s.args.argv.includes("--version")).map((s) => s.id));
    return host.calls.filter((c) => c.call === "start" && !probes.has(c.args.id));
};

// --- the spawn carries no token, and only the shipped manifest's hash ---

test("RED TEAM: the spawn's credential is {provider, manifest} and nothing else, and the probe never carries one", T, async () => {
    // Mutation each half: a `value`/`token` field beside `provider` reds the first; planning a credential for the
    // version probe (which the person never approves, and which runs `gh --version`) reds the second.
    const host = fakeNativeHost({ landlockAbi: null, credentials: ["github"] });
    const ask = answering(true);
    await runOn("userScripts", [runs(["gh", "pr", "view", "12"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    const credentialed = spawns(host).filter((c) => c.args.credential);
    assert.equal(credentialed.length, 1, "exactly one spawn asks for the token");
    const c = credentialed[0].args.credential;
    assert.deepEqual(Object.keys(c).sort(), ["manifest", "provider"], "the provider and the manifest's hash: no value, no ports, no env");
    assert.equal(c.provider, "github");
    assert.match(c.manifest, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(c), TOKEN_SHAPED, "nothing token-shaped rides the spawn");
    const probe = spawns(host).find((s) => s.args.argv.includes("--version"));
    assert.ok(probe, "the version probe ran");
    assert.equal(probe.args.credential, undefined, "a probe runs unapproved: it must not ask for the person's token");
});

// --- no token on any surface a program's output reaches ---

test("RED TEAM: a token gh prints to stdout, to stderr and in a failure reaches the model as a placeholder, never itself", T, async () => {
    // Mutation: drop the GITHUB_TOKEN replace from scrubSecrets and all three assertions red; drop it from the stderr
    // path alone and the third reds on its own.
    const host = fakeNativeHost({ landlockAbi: null, credentials: ["github"], done: () => ({ out: `${TOKEN}\n`, err: `error: bad credentials (token ${PAT} rejected)\n`, code: 1 }) });
    const ask = answering(true);
    const { results } = await runOn("userScripts", [runs(["gh", "auth", "status", "-t"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    assert.equal(ask.asked.length, 1, "the call the token rides is always asked");
    assert.doesNotMatch(JSON.stringify(ask.asked[0]), TOKEN_SHAPED, "the facts on the card carry no token");
    assert.doesNotMatch(JSON.stringify(results[0]), TOKEN_SHAPED, `a token reached the model: ${results[0]}`);
    const r = valueOf(results[0]);
    assert.equal(r.stdout.text, "[a GitHub token]\n");
    assert.equal(r.ok, false, "the exit code is still the program's");
    assert.match(r.stderr.text, /\[a GitHub token\]/, "the stderr gh printed is scrubbed too");
    assert.doesNotMatch(r.stderr.text, /github_pat_/, "no part of the fine-grained token survives");
});

// --- a host that pins other bytes refuses: the worker's hash is the whole of what it can check ---

test("RED TEAM: a host that pinned older gh.json bytes refuses the spawn, and the worker ends the call there", T, async () => {
    // Mutation: retry the spawn with no credential (or start it anyway) reds the refusal count and the start line. The
    // hash is the manifest bytes' — any edit to src/shell/manifests/gh.json must re-pin a host release (credential-pins.json).
    const host = fakeNativeHost({ landlockAbi: null, credentials: ["github"] });
    const gate = credentialRefusing(host, () => false);   // this host pins some other bytes: no hash it is sent matches
    const ask = answering(true);
    const { results } = await runOn("userScripts", [runs(["gh", "pr", "view", "12"])], { ...NO_FETCH, onNative: gate.onNative, configExtra: ON, onStep: ask.onStep });
    const r = valueOf(results[0]);
    assert.equal(gate.refused.length, 1);
    assert.equal(r.code, "Refused");
    assert.equal(ask.asked.length, 0, "an ask the host would refuse anyway is not put to the person");
    assert.ok(!host.names().includes("start"));
    // The same host grants only the bytes this build ships.
    const pinned = fakeNativeHost({ landlockAbi: null, credentials: ["github"] });
    const { createHash } = await import("node:crypto");
    const fs = await import("node:fs");
    const sha = createHash("sha256").update(fs.readFileSync(new URL("../src/shell/manifests/gh.json", import.meta.url))).digest("hex");
    const granting = credentialRefusing(pinned, (args) => args.credential.manifest === sha);
    const ask2 = answering(true);
    const { results: again } = await runOn("userScripts", [runs(["gh", "pr", "view", "12"])], { ...NO_FETCH, onNative: granting.onNative, configExtra: ON, onStep: ask2.onStep });
    assert.equal(granting.refused.length, 0, "the shipped bytes' hash is the one the host pins");
    assert.equal(ask2.asked.length, 1);
    assert.equal(valueOf(again[0]).ok, true);
});

// --- the upgrade: a host that cannot hold it is sent none, and the card says so ---

test("RED TEAM: a host whose hello.credentials omits github is sent no credential, and the card says nothing is sent", T, async () => {
    // The four shapes a host answers with, enumerated: absent (an older host), [] (Linux, or over the hub), another
    // provider, and a host that lists it. Mutation: gate on the list being present instead of naming the provider reds
    // the third shape; drop either the hello or the sandboxed clause and one more reds.
    for (const [credentials, sent] of [[undefined, false], [[], false], [["gitlab"], false], [["github"], true]]) {
        const host = fakeNativeHost({ landlockAbi: null, ...(credentials === undefined ? {} : { credentials }) });
        const ask = answering(true);
        await runOn("userScripts", [runs(["gh", "pr", "view", "12"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
        const spawn = spawnOf(host, "gh");
        assert.equal(spawn.args.credential !== undefined, sent, `hello.credentials ${JSON.stringify(credentials)}`);
        assert.equal(ask.asked.length, 1, "gh's reads are never free (net(*)), so every shape is asked");
        const facts = ask.asked[0].facts.credential;
        assert.equal(facts.held, sent, `hello.credentials ${JSON.stringify(credentials)}: held`);
        assert.doesNotMatch(JSON.stringify(ask.asked[0]), TOKEN_SHAPED);
    }
    // And the same four shapes unsandboxed: a plain host runs gh as the person, never with a host-injected token.
    const host = fakeNativeHost({ landlockAbi: null, sandbox: false, credentials: ["github"] });
    const ask = answering(true);
    await runOn("userScripts", [runs(["gh", "pr", "view", "12"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    assert.equal(spawnOf(host, "gh").args.credential, undefined, "unsandboxed: never sent, whatever the host lists");
    assert.equal(ask.asked[0].facts.credential.held, false);
});

// --- the hosts a credentialed call's proxy admits: the validator is the whole gate on the worker's side ---

test("RED TEAM: a manifest asking for a host the provider does not list is refused in every confusable spelling, so only an exact provider name passes", async () => {
    // Mutation: match by suffix or substring, or on a lowercased or trimmed copy (`provider.hosts.some((h) =>
    // asked.toLowerCase().endsWith(h))`), and github.com.evil.test, evil-github.com, "api.github.com:443" and
    // " api.github.com" validate: a host that pinned those bytes would then admit a proxy table of their choosing.
    // Exact equality against the provider's own names is the whole rule, so every shape is enumerated here, not sampled.
    const fs = await import("node:fs");
    const { validateManifest, CREDENTIAL_PROVIDERS } = await import("../src/shell/program-manifest.ts");
    const gh = JSON.parse(fs.readFileSync(new URL("../src/shell/manifests/gh.json", import.meta.url), "utf8"));
    const v = (hosts) => validateManifest({ ...gh, network: { ports: [443], hosts } }).join("\n");
    // A non-empty list of strings that holds anything else is refused for its CONTENT...
    for (const list of [["github.com.evil.test"], ["evil-github.com"], ["notgithub.com"], ["api.github.com.evil.test"],
        ["api.github.com:443"], ["https://api.github.com"], ["api.github.com/"], [" api.github.com"], ["api.github.com "],
        ["*.github.com"], [".github.com"], ["api.github.com", "evil.test"], ["API.github.com"], ["api.github.com."], [""], ["127.0.0.1"]])
        assert.match(v(list), /\$\.network\.hosts: a subset of /, JSON.stringify(list));
    // ...and a value that is not one is refused for its FORM, the two errors being what a caller is told.
    for (const hosts of [{ 0: "api.github.com", length: 1 }, "api.github.com", [443], [null], [["api.github.com"]], [], new String("api.github.com")])
        assert.match(v(hosts), /\$\.network\.hosts: a non-empty list of host names/, JSON.stringify(hosts));
    // The positive control: every host the provider lists, alone and all together, is the only thing that passes.
    for (const h of CREDENTIAL_PROVIDERS.github.hosts) assert.equal(v([h]), "", h);
    assert.equal(v(CREDENTIAL_PROVIDERS.github.hosts), "", "the provider's whole list");
    assert.equal(v([...CREDENTIAL_PROVIDERS.github.hosts, ...CREDENTIAL_PROVIDERS.github.hosts]), "", "a repeat is still a subset");
    assert.equal(v(undefined), "", "no hosts at all: a manifest from before the field");
});

test("RED TEAM: the card names the hosts the host's grant admits and its ports, and no line says any host while a host named some", T, async () => {
    // Mutation: print the manifest's hosts (or nothing) in place of the fact's, or say "any host" on a null-or-empty
    // check that cannot tell the two apart, and one of the assertions below reds. This is the person's consent card,
    // read from the same `facts` object the ask carries.
    const { shCardLines } = await import("../src/shell/sh-call.ts");
    const sandboxOf = async (host) => {
        const ask = answering(true);
        await runOn("userScripts", [runs(["gh", "pr", "view", "12"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
        assert.equal(ask.asked.length, 1, "gh's reads are never free, so the card is put to the person");
        return shCardLines(ask.asked[0].facts).find((l) => l.label === "Sandbox").value;
    };
    // The fake host's grant names api.github.com and github.com on 443: the card says exactly that.
    const held = await sandboxOf(fakeNativeHost({ landlockAbi: null, credentials: ["github"] }));
    assert.match(held, /network to api\.github\.com, github\.com on port 443 only$/, held);
    assert.doesNotMatch(held, /any host/, `the grant named hosts, so no line may say any host: ${held}`);
    // A host that lists no credentials grants nothing: the line is today's, never "network to  on … only".
    const plain = await sandboxOf(fakeNativeHost({ landlockAbi: null }));
    assert.match(plain, /no network$/, plain);
});

test("RED TEAM: a host holding the token but naming no hosts is carded as reaching any host, never as the shipped list", async () => {
    // The upgrade: a host built before the proxy holds the token and bounds by port alone, and its `facts.credential`
    // carries no `hosts`. Mutation: fall back to the manifest's `network.hosts` when the fact is absent (`hosts: facts.
    // credential.hosts ?? m?.network?.hosts …`) and the card reads as scoped to six GitHub hosts while the host admits
    // any 443 host: the card understates what the person is approving, which is the one thing it exists to state.
    const { shFacts, shCardLines, SHIPPED_MANIFESTS } = await import("../src/shell/sh-call.ts");
    const { CREDENTIAL_PROVIDERS } = await import("../src/shell/program-manifest.ts");
    const facts = (over) => ({ id: "c1", argv: ["gh", "api", "/user"], program: { path: "/opt/homebrew/bin/gh", inRoot: false }, cwd: { path: "/w", inRoot: true }, env: { set: [], secrets: [], free: true }, repo: null, repoConfigRunsCode: null, paths: [], effects: "unknown", mode: "host", sandboxed: true, placement: "host-sandbox", expiresInMs: 1, ...over });
    const sandbox = (f) => shCardLines(f).find((l) => l.label === "Sandbox").value;
    const unscoped = shFacts(facts({ credential: { provider: "github", ports: [443], profile: "credentialed:github" } }));
    assert.equal(unscoped.credential.hosts, null, "a grant that names no hosts is null, never the manifest's list");
    assert.match(sandbox(unscoped), /network to any host on port 443 only$/, sandbox(unscoped));
    // The shipped list is the provider's whole, so a host pinned to these bytes advertises exactly it, and the card of
    // that grant prints it rather than any host.
    assert.deepEqual([...SHIPPED_MANIFESTS.gh.network.hosts].sort(), [...CREDENTIAL_PROVIDERS.github.hosts].sort(), "the shipped gh.json names every host the provider lists, and none besides");
    const scoped = shFacts(facts({ credential: { provider: "github", ports: [443], hosts: SHIPPED_MANIFESTS.gh.network.hosts, profile: "credentialed:github" } }));
    assert.ok(sandbox(scoped).endsWith(`network to ${SHIPPED_MANIFESTS.gh.network.hosts.join(", ")} on port 443 only`), sandbox(scoped));
});

// --- an entry a store should not hold is dropped before a call can meet it ---

test("RED TEAM: a stored entry claiming a credential is dropped on READ, so a build that wrote one is not believed", async () => {
    // The one hostile path the store-time rows do not cover: an entry already in storage, written by an older build or
    // edited in place, read back by this one. The wire shapes are tests/program-manifest.test.mjs's and the store's
    // refusal tests/stored-manifests.test.mjs's; this is `validStored`'s read. Mutation: remove shippedOnlyRefusal from
    // storeRefusal and both entries below validate and are kept.
    const { validStored } = await import("../src/shell/stored-manifests.ts");
    const { SHIPPED_MANIFESTS } = await import("../src/shell/sh-call.ts");
    const pin = { path: "/opt/bin/mytool", fingerprint: "1:2:3:4", inRoot: false };
    const tool = { program: "mytool", version: { range: "*", args: [], pattern: "" }, command: { effects: ["read"], paths: "none", flags: {} } };
    const entry = (manifest) => ({ id: "man-x", scope: "global", origin: "person", created: 1, manifest, pin });
    // Read with `{}` as the shipped set, as the drop does it: the gh-shaped entry is a stored program there, and its
    // manifest validates, so the shipped-only rule is all that stands between it and the call path.
    for (const manifest of [{ ...structuredClone(SHIPPED_MANIFESTS.gh) }, { ...structuredClone(tool), credential: { provider: "github" }, network: { ports: [443] } }]) {
        assert.equal(validStored(entry(manifest), "global", {}), false, manifest.program);
    }
    assert.equal(validStored(entry(tool), "global", {}), true, "the control: the same entry without them is valid");
});

// --- a declined credentialed call never starts, so the host never reads the token ---

test("RED TEAM: declined, a credentialed call is discarded and never started: the host reads the token only at start", T, async () => {
    // Mutation: start before the ask (or start on a denied verdict) reds this. That ordering is what keeps the token in
    // the person's gh until they have said yes.
    const host = fakeNativeHost({ landlockAbi: null, credentials: ["github"] });
    const ask = answering(false);
    const { results } = await runOn("userScripts", [runs(["gh", "pr", "view", "12"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    assert.equal(spawnOf(host, "gh").args.credential.provider, "github", "the control: this host holds it, so the spawn asked");
    assert.equal(ask.asked.length, 1);
    assert.equal(valueOf(results[0]).code, "Denied");
    assert.equal(startsOfCalls(host).length, 0, "nothing started, so no token was fetched (the version probe's start is not the call's)");
    assert.doesNotMatch(JSON.stringify(results[0]), TOKEN_SHAPED);
});

// --- a host that refuses the credential ends the call: no start, no retry, no card ---

test("RED TEAM: a host that answers CredentialRefused ends the call with no start, no retry and no card, whatever argv0 was", T, async () => {
    // Mutation: retry the spawn without the credential (a `gh` that runs anonymously by surprise, and a program the
    // person's card named by a path it did not approve) reds the "exactly one spawn" line for the refused shapes.
    for (const argv of [["gh", "pr", "view", "12"], ["./gh", "pr", "view", "12"], ["/usr/local/bin/gh", "pr", "view", "12"]]) {
        const host = fakeNativeHost({ landlockAbi: null, credentials: ["github"] });
        const gate = credentialRefusing(host);
        const ask = answering(true);
        const { results } = await runOn("userScripts", [runs(argv)], { ...NO_FETCH, onNative: gate.onNative, configExtra: ON, onStep: ask.onStep });
        const r = valueOf(results[0]);
        assert.equal(gate.refused.length, 1, `${argv[0]}: the host refused the credential`);
        assert.equal(r.code, "Refused", `${argv[0]}: ${JSON.stringify(r)}`);
        assert.match(r.threw, /credential/, `${argv[0]}: the script is told what was refused`);
        assert.equal(ask.asked.length, 0, `${argv[0]}: nobody is asked to approve a call that will not run`);
        const call = gate.seen.filter((s) => !s.probe);
        assert.equal(call.length, 1, `${argv[0]}: it was not retried without the credential`);
        assert.equal(call[0].credential, true, `${argv[0]}: the one spawn attempted carried the credential`);
        assert.equal(startsOfCalls(host).length, 0, `${argv[0]}: nothing started`);
        assert.doesNotMatch(JSON.stringify(results[0]), TOKEN_SHAPED);
    }
    // The control: the same host, granting it, asks once and runs.
    const host = fakeNativeHost({ landlockAbi: null, credentials: ["github"] });
    const gate = credentialRefusing(host, (args) => args.argv[0] === "gh");
    const ask = answering(true);
    const { results } = await runOn("userScripts", [runs(["gh", "pr", "view", "12"])], { ...NO_FETCH, onNative: gate.onNative, configExtra: ON, onStep: ask.onStep });
    assert.equal(gate.refused.length, 0);
    assert.equal(ask.asked.length, 1, "a granted one is asked");
    assert.ok(host.names().includes("start"), "a granted one runs");
    assert.doesNotMatch(JSON.stringify(results[0]), TOKEN_SHAPED);
});
