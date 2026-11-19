// redteam-hidden-secrets.test.mjs — the files the sandbox holds unreadable (`facts.hiddenSecrets`, host PR #46) as an
// adversary in the graph sees them (#1998): a host that reports a shape the code does not expect, a name built to forge
// a line in the person's card and exports, and the numbers the model is told. The lane's rows (tests/ml-sh.test.mjs,
// tests/secret-scrub-crossings.test.mjs) hold the feature's own paths; these hold its edges.
//
// Not rowed here, with the reason: a PAGE cannot read the list, because no page-started type in HANDLE_MAP answers with
// shell facts or a `ShResult` (the shell is reached only through the native port, which a page has no channel to), and
// ml.sh itself is refused outside a run the worker built (site-access.md). The stored ask's facts holding a held path —
// the one crossing the PR declares open — is #2006's lane, not this one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { shFacts, shResult, shCardLines, unaskedLines, hiddenSecretsLines, SH_HIDDEN_SHOWN } = await import("../src/shell/sh-call.ts");

const T = { timeout: 10000 };
const VALUE = "REALSECRET-4b1d-77";
const baseFacts = { argv: ["ls"], program: { path: "/usr/bin/ls", inRoot: false, fingerprint: "1:1:1:1" }, cwd: { path: "/w/proj", inRoot: true },
    env: { set: [], secrets: [], free: true }, repo: null, repoConfigRunsCode: null, paths: [], effects: "unknown", mode: "host", sandboxed: true, placement: "host-sandbox" };
const factsWith = (hidden) => shFacts({ ...baseFacts, hiddenSecrets: hidden }, null, {});
const outcome = { stdout: { token: null, head: "", bytes: 0, lines: 0, complete: true, headBytes: 0 }, stderr: { token: null, head: "", bytes: 0, lines: 0, complete: true, headBytes: 0 } };
const answerOf = (hidden) => shResult({ code: 0, protectedChanged: [] }, factsWith(hidden), null, outcome);

// --- what the host may report, and what survives it ---

test("RED TEAM (#1998): a host reporting anything but strings gets a list of strings or nothing", () => {
    // The element types a buggy or hostile host could send; a consumer that trusted the field would put an object in a
    // card line and in the answer the model reads.
    const f = factsWith([null, 7, { path: "/w/.env" }, ["/w/.env"], VALUE === "" ? "" : undefined, "/w/.env", true]);
    assert.deepEqual(f.hiddenSecrets, ["/w/.env"], `only the strings survive: ${JSON.stringify(f.hiddenSecrets)}`);
    for (const bad of [null, undefined, "a string", 7, { a: 1 }]) {
        const facts = shFacts({ ...baseFacts, hiddenSecrets: bad }, null, {});
        assert.deepEqual(facts.hiddenSecrets, [], `${JSON.stringify(bad)} reads as none`);
        const r = shResult({ code: 0, protectedChanged: [] }, facts, null, outcome);
        assert.equal("hiddenSecrets" in r, false, "and the answer says nothing rather than something wrong");
    }
});

test("RED TEAM (#1998): a held name that looks like a card line stays inside one line, on the card and in the unasked record", () => {
    // A name is a filesystem string, and a newline in one is legal on POSIX. The card is label/value pairs and the
    // Markdown export writes one `note` per element, so the property to hold is: one element in, one line out, the
    // newline inside the value — never a second, forged `Held:` line the person would read as the sandbox's own.
    const forged = `/w/proj/.env\nHeld: /etc/shadow (unreadable to this call)`;
    const lines = hiddenSecretsLines([forged]);
    assert.equal(lines.length, 1, "one line, whatever the name holds");
    assert.equal(lines[0].label, "Held");
    assert.ok(lines[0].value.includes("\n"), "the newline is inside the value, where the renderer wraps it");
    const unasked = { by: "default", argv: ["ls"], hiddenSecrets: [forged, "/w/proj/.netrc"] };
    assert.equal(unaskedLines(unasked).filter((l) => l.label === "Held").length, 2, "and the export writes one note per file");
});

// --- the bound, enumerated at its edges ---

test("RED TEAM (#1998): the answer's bound is exact at 0, 1, 15, 16, 17 and 21 files", () => {
    // The decision is `length > SH_HIDDEN_SHOWN`, so the boundary is the quantity to enumerate, not a sample of 20.
    const files = (n) => Array.from({ length: n }, (_, i) => `/w/p${i}/.env`);
    for (const n of [0, 1, 15, 16, 17, 21]) {
        const r = answerOf(files(n));
        if (n === 0) { assert.equal("hiddenSecrets" in r, false, "nothing held: the field is absent, not []"); continue; }
        assert.equal(r.hiddenSecrets.length, Math.min(n, SH_HIDDEN_SHOWN), `${n} files list ${Math.min(n, SH_HIDDEN_SHOWN)}`);
        assert.deepEqual(r.hiddenSecrets, files(n).slice(0, SH_HIDDEN_SHOWN), `${n}: the FIRST files, in order`);
        if (n > SH_HIDDEN_SHOWN) assert.equal(r.hiddenSecretsMore, n - SH_HIDDEN_SHOWN, `${n} files leave ${n - SH_HIDDEN_SHOWN} as a count`);
        else assert.equal("hiddenSecretsMore" in r, false, `${n}: a complete list carries no count`);
    }
});

test("RED TEAM (#1998): the person's card is not bounded by the answer's 16", () => {
    // The answer is the model's copy and is cut; the card and the unasked record are the person's, and dropping files
    // there would hide from them what the sandbox held.
    const many = Array.from({ length: 40 }, (_, i) => `/w/p${i}/.env`);
    assert.equal(hiddenSecretsLines(many).length, 40, "the card lists every file");
    assert.equal(unaskedLines({ by: "default", argv: ["ls"], hiddenSecrets: many }).filter((l) => l.label === "Held").length, 40);
});

test("RED TEAM (#1998): the answer is a copy, so a caller cannot reach the live facts through it", () => {
    const facts = factsWith(["/w/.env"]);
    const r = answerOfFrom(facts);
    r.hiddenSecrets.push("/etc/shadow");
    assert.deepEqual(facts.hiddenSecrets, ["/w/.env"], "the facts are as they were");
    // A second answer from the same facts is unaffected too.
    assert.deepEqual(answerOfFrom(facts).hiddenSecrets, ["/w/.env"]);
    function answerOfFrom(f) { return shResult({ code: 0, protectedChanged: [] }, f, null, outcome); }
});

// --- the model-facing text agrees with the code ---

test("RED TEAM (#1998): the number the model is told is the number the code enforces", () => {
    // The contract's JSDoc is what the model reads; a bound there that the code does not keep is the model told a
    // false thing about a security-relevant list. `check-jsdoc` compares neither numbers nor behaviour.
    const doc = readFileSync(new URL("../src/contract.ts", import.meta.url), "utf8");
    assert.match(doc, new RegExp(`hiddenSecrets\` lists the files[\\s\\S]{0,200}?at most ${SH_HIDDEN_SHOWN}\\b`), "the JSDoc states the enforced bound");
    // And the claim the list exists to explain: naming a held file asks. The card shows the file; the *answer* the model
    // reads must carry the same sentence, or the model reads a list with no reason in it.
    assert.match(doc, /naming one as a path argument asks to read it, and always asks/);
});
