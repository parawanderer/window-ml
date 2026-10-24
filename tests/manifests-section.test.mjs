// manifests-section.test.mjs — the Settings "Program manifests" page (src/sidebar/settings/manifests-section.tsx,
// PROGRAM_MANIFEST.md, "Registering a program"): each stored entry with whose it is, where it describes calls and the
// evidence for that, and its pin; an add sends the manifest and where it applies and never a pin; a remove sends the id.
// The worker's side of `MANIFESTS` is tests/manifests-message.test.mjs.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, M, doc;
const sent = [];
let answer = () => ({ data: VIEW });
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://extension.test/" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    globalThis.chrome = {
        runtime: { lastError: undefined, sendMessage: (msg, cb) => { sent.push(structuredClone(msg)); cb(answer(msg.payload)); } },
        storage: { onChanged: { addListener() {}, removeListener() {} } },
    };
    doc = dom.window.document;
    ({ h, render } = require_("preact"));
    M = await import("../src/sidebar/settings/manifests-section.tsx");
});

const ANY = { range: "*", args: [], pattern: "" };
const READER = { effects: ["read"], paths: "operands", flags: {} };
const AT = Date.UTC(2026, 9, 23);
const PERSON = { id: "man-1", scope: "global", manifest: { program: "mytool", version: ANY, command: READER }, origin: "person", created: AT, pin: { path: "/opt/bin/mytool", fingerprint: "1:2:3:4", inRoot: false } };
const PASSED = { ...PERSON, id: "man-2", manifest: { ...PERSON.manifest, program: "file" }, origin: "proposed", pin: { path: "/usr/bin/file", fingerprint: "5:6:7:8", inRoot: false }, evidence: { calls: 2, at: AT } };
const FAILED = { ...PASSED, id: "man-3", manifest: { ...PERSON.manifest, program: "touch" }, evidence: undefined, evidenceFailure: { argv: ["touch", "b.txt"], why: "it exited 1, not one of 0", at: AT } };
const SCRIPT = { id: "man-4", scope: "workspace", root: "/w/proj", manifest: { program: "node", entrypoint: { path: "scripts/gen.mjs", sha256: "c".repeat(64) }, command: READER }, origin: "proposed", created: AT };
const VIEW = { global: [PERSON, PASSED, FAILED], workspace: [{ root: "/w/proj", manifests: [SCRIPT] }], shipped: ["cat", "git"] };

// Hooks run their effects after paint (requestAnimationFrame under jsdom), so a tick is a frame.
const tick = () => new Promise((r) => setTimeout(r, 40));
/** Poll until `fn` returns truthy or `ms` elapses. Returns the last value of `fn`. */
async function waitFor(fn, ms = 2000) {
    const deadline = Date.now() + ms;
    for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() >= deadline) return v;
        await new Promise((r) => setTimeout(r, 25));
    }
}
async function show(roots = ["/w/proj"]) {
    const host = doc.getElementById("root");
    render(null, host);
    sent.length = 0;
    render(h(M.ManifestsSectionBody, { roots }), host);
    // The component shows "Reading…" until the effect's setView lands. Under CI load one 40ms
    // tick is not enough, so wait for the add form (always rendered once view is set).
    await waitFor(() => host.querySelector(".man-source"));
    return host;
}
const row = (host, id) => host.querySelector(`[data-manifest-id="${id}"]`);
const type = (el, value, ev = "input") => { el.value = value; el.dispatchEvent(new window.Event(ev, { bubbles: true })); };
const button = (host, text) => [...host.querySelectorAll("button")].find((b) => b.textContent === text);

// --- each entry: whose, where it describes calls, its evidence, its pin ---

test("the person's entry and a proposed one whose evidence passed describe calls on both placements; the evidence is counted", async () => {
    const host = await show();
    assert.deepEqual(sent.map((m) => [m.type, m.payload]), [["MANIFESTS", {}]], "it reads the store once on open");
    const mine = row(host, "man-1");
    assert.match(mine.textContent, /with or without the sandbox/);
    assert.match(mine.textContent, /yours/);
    assert.match(mine.textContent, /pinned to \/opt\/bin\/mytool \(fingerprint 1:2:3:4\)/);
    assert.doesNotMatch(mine.textContent, /Evidence/);
    const passed = row(host, "man-2");
    assert.ok(passed.querySelector(".pol-effect.pol-allow"));
    assert.match(passed.textContent, /proposed by the model/);
    assert.match(passed.textContent, /Evidence: 2 calls re-run under the sandbox with writes refused; none changed a file it names/);
});

test("a proposed entry whose evidence failed, or that has none, says it describes sandboxed calls only, and why", async () => {
    const host = await show();
    const failed = row(host, "man-3");
    assert.ok(failed.querySelector(".pol-effect.pol-deny"));
    assert.match(failed.textContent, /under the sandbox only/);
    assert.match(failed.querySelector(".set-err").textContent, /Evidence failed on touch b\.txt: it exited 1, not one of 0/);
    const none = row(host, "man-4");
    assert.ok(none.querySelector(".pol-effect.pol-ask"));
    assert.match(none.textContent, /No evidence: no call of it was re-run\./);
    assert.match(none.textContent, /node scripts\/gen\.mjs/);
    assert.match(none.textContent, /pinned to the script's sha256 cccccccccccc/);
    assert.match(host.querySelector('[data-root="/w/proj"]').textContent, /Workspace \/w\/proj/);
    assert.match(host.textContent, /Shipped with the extension, not replaceable here: cat, git\./);
});

test("evidenceOf branches on kind, origin and evidence: a program the person added reads as unsandboxed, a script never does", () => {
    const BIN = PERSON.manifest, SCR = SCRIPT.manifest;
    const ANYWHERE = "with or without the sandbox", SANDBOX = "under the sandbox only";
    const cases = [
        [{ manifest: BIN, origin: "person" }, "allow", ANYWHERE],
        [{ manifest: BIN, origin: "person", evidenceFailure: FAILED.evidenceFailure }, "allow", ANYWHERE],
        [{ manifest: BIN, origin: "proposed" }, "ask", SANDBOX],
        [{ manifest: BIN, origin: "proposed", evidence: PASSED.evidence }, "allow", ANYWHERE],
        [{ manifest: BIN, origin: "proposed", evidenceFailure: FAILED.evidenceFailure }, "deny", SANDBOX],
        // A script is sandbox-only for good (entrypointMisses, sh-call.ts): its imports are unbounded on the plain host.
        [{ manifest: SCR, origin: "person" }, "ask", SANDBOX],
        [{ manifest: SCR, origin: "proposed", evidence: PASSED.evidence }, "ask", SANDBOX],
        [{ manifest: SCR, origin: "proposed" }, "ask", SANDBOX],
        [{ manifest: SCR, origin: "proposed", evidenceFailure: FAILED.evidenceFailure }, "deny", SANDBOX],
    ];
    for (const [s, tone, label] of cases) {
        const got = M.evidenceOf(s);
        assert.deepEqual([got.tone, got.label], [tone, label], JSON.stringify(s));
        if (s.manifest.entrypoint) assert.match(got.detail, /under the sandbox only, whoever added it: outside it nothing bounds what the script imports/);
    }
    assert.match(M.evidenceOf({ manifest: SCR, origin: "proposed", evidence: PASSED.evidence }).detail, /^Evidence: 2 calls re-run/, "a script keeps its evidence line");
    assert.equal(M.pinText({ manifest: { program: "x" } }), "not pinned");
    assert.match(M.pinText({ manifest: { program: "x" }, pin: { ...PERSON.pin, version: "1.2.3" } }), /, version 1\.2\.3\)/);
});

// --- add and remove ---

test("Add sends the manifest and where it applies, never a pin; a workspace is named by its root", async () => {
    const host = await show(["/w/proj", "/w/other"]);
    const draft = { program: "jq", version: ANY, command: READER };
    type(host.querySelector(".man-source"), JSON.stringify(draft));
    await tick();
    button(host, "Add").click();
    await tick();
    assert.deepEqual(sent.at(-1).payload, { op: "add", scope: "global", manifest: draft });
    type(host.querySelector(".man-add select"), "/w/other", "change");
    await tick();
    type(host.querySelector(".man-source"), JSON.stringify(draft));
    await tick();
    button(host, "Add").click();
    await tick();
    assert.deepEqual(sent.at(-1).payload, { op: "add", scope: "workspace", root: "/w/other", manifest: draft });
});

test("text that is not JSON is refused on the page, the worker's refusal is shown, and a forced scope is said", async () => {
    const host = await show();
    type(host.querySelector(".man-source"), "{ program: jq");
    await tick();
    button(host, "Add").click();
    await tick();
    assert.equal(sent.length, 1, "nothing was sent");
    assert.match(host.querySelector(".man-err").textContent, /^Not JSON: /);

    answer = () => ({ error: "git is described by the shipped manifest src/shell/manifests/git.json, which a stored one does not replace" });
    type(host.querySelector(".man-source"), JSON.stringify({ program: "git" }));
    await tick();
    button(host, "Add").click();
    await tick();
    assert.match(host.querySelector(".man-err").textContent, /shipped manifest/);

    answer = () => ({ data: { ...VIEW, forced: "/w/proj/bin/mytool is inside the workspace /w/proj, so only that workspace may describe it" } });
    button(host, "Add").click();
    await tick();
    assert.equal(host.querySelector(".man-err"), null);
    assert.match(host.querySelector(".man-note").textContent, /^Stored for its workspace: \/w\/proj\/bin\/mytool is inside the workspace/);
    answer = () => ({ data: VIEW });
});

test("the remove button sends the entry's id", async () => {
    const host = await show();
    row(host, "man-3").querySelector('button[aria-label="Remove the manifest for touch"]').click();
    await tick();
    assert.deepEqual(sent.at(-1).payload, { op: "remove", id: "man-3" });
});
