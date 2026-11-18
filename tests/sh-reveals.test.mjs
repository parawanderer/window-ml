// sh-reveals.test.mjs — programs that reveal other processes (PROGRAM_MANIFEST.md, "Programs that reveal other
// processes", ruling 31): the manifest's `reveals` marker, the facts a call carries from it and `shellRevealsAllow`,
// the card's line, and the gate key's class. The judging is tests/sw-policies.test.mjs; the card's third answer is
// tests/sidebar-asks.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { manifestsFor, planSpawn, shFacts, shCardLines, SHIPPED_MANIFESTS } from "../src/shell/sh-call.ts";
import { REVEALING_PROGRAMS, validateManifest } from "../src/shell/program-manifest.ts";
import { storeRefusal, validStored } from "../src/shell/stored-manifests.ts";
import { draftNote, draftRequest } from "../src/shell/manifest-proposal.ts";
import { DEFAULT_CONFIG, publicConfig } from "../src/contract/contract-config.ts";
import { modelWritable, settingDecl } from "../src/setting-class.ts";

const ANY = { range: "*", args: [], pattern: "" };
/** A person's `ps`, marked: it reads nothing in a workspace and shows every process. */
const PS = { program: "ps", version: ANY, reveals: "processes", command: { effects: [], paths: "none", flags: { "-e": {}, "-f": {} } } };
const LSOF = { ...PS, program: "lsof" };
const pin = (program) => ({ path: `/bin/${program}`, fingerprint: `1:2:3:${program.length}`, inRoot: false });
const entry = (m) => ({ id: `man-${m.program}`, scope: "global", manifest: m, origin: "person", created: 1, pin: pin(m.program) });
/** The host's facts for `<program> -e -f` in /w. */
const facts = (program = "ps") => ({
    id: "c1", argv: [program, "-e", "-f"], program: { ...pin(program) }, cwd: { path: "/w", inRoot: true }, env: { set: [], secrets: [], free: true },
    repo: null, repoConfigRunsCode: false, paths: [], effects: "unknown", mode: "host", sandboxed: true, placement: "host-sandbox",
});
const place = (revealsAllow) => ({ roots: ["/w"], stored: [entry(PS), entry(LSOF)], ...(revealsAllow ? { revealsAllow } : {}) });

// --- the marker ---

test("reveals is one value, and it only narrows: a stored manifest may carry it", () => {
    assert.deepEqual(validateManifest(PS), []);
    assert.deepEqual(validateManifest({ ...PS, reveals: "files" }), ['$.reveals: "processes"']);
    assert.equal(storeRefusal({ scope: "global", manifest: PS, origin: "proposed", pin: pin("ps") }, [], SHIPPED_MANIFESTS), undefined);
});

test("upgrade: no shipped manifest carries the marker, so every shipped call's facts say reveals null", () => {
    for (const [name, m] of Object.entries(SHIPPED_MANIFESTS)) assert.equal(m.reveals, undefined, name);
    const cat = shFacts({ ...facts("cat"), argv: ["cat", "a.txt"], program: { path: "/bin/cat", inRoot: false },
        paths: [{ arg: 1, given: "a.txt", path: "/w/a.txt", inRoot: true, secret: false, exists: true }] }, null, { roots: ["/w"] });
    assert.equal(cat.reveals, null);
    assert.equal(shCardLines(cat).some((l) => l.label === "Shows"), false);
});

// --- a stored or proposed manifest never drops the marker ---

test("a shipped program cannot be shadowed, and a stored manifest for a revealing program without the marker is refused, dropped on load and skipped at call time", () => {
    const bare = { ...PS }; delete bare.reveals;
    assert.deepEqual(validateManifest(bare), [], "valid as a manifest: the refusal is the store's");
    const refused = 'ps shows other processes, so its manifest carries reveals: "processes"';
    for (const origin of ["person", "proposed"]) assert.equal(storeRefusal({ scope: "global", manifest: bare, origin, pin: pin("ps") }, [], SHIPPED_MANIFESTS), refused, origin);
    for (const program of REVEALING_PROGRAMS) assert.match(storeRefusal({ scope: "global", manifest: { ...bare, program }, origin: "person", pin: pin(program) }, [], SHIPPED_MANIFESTS), /shows other processes/, program);
    assert.equal(storeRefusal({ scope: "global", manifest: { ...bare, program: "mytool" }, origin: "person", pin: pin("mytool") }, [], SHIPPED_MANIFESTS), undefined, "an unlisted program is not marked");
    // The upgrade: an entry stored before this rule is dropped on read, and one that arrives another way never describes a call.
    assert.equal(validStored(entry(bare), "global", SHIPPED_MANIFESTS), false);
    assert.equal(validStored(entry(PS), "global", SHIPPED_MANIFESTS), true);
    assert.deepEqual(manifestsFor([entry(bare)], ["/w"]).list.filter((m) => m.program === "ps"), []);
    const f = shFacts(facts(), null, { roots: ["/w"], stored: [entry(bare)] });
    assert.equal(f.described, false, "undescribed, so it asks");
    // B2, which this rule leans on once ps ships: a shipped program's stored entry is refused whatever it says.
    const cat = { ...SHIPPED_MANIFESTS.cat, reveals: "processes" };
    assert.match(storeRefusal({ scope: "global", manifest: cat, origin: "person", pin: pin("cat") }, [], SHIPPED_MANIFESTS), /described by the shipped manifest/);
});

test("a draft for a revealing program gets the marker whatever it said, and the card says so", () => {
    const bare = { ...PS }; delete bare.reveals;
    const r = draftRequest({ manifest: bare, scope: "global" }, { ...facts(), program: pin("ps") }, "/w", ["/w"]);
    assert.equal(r.request.manifest.reveals, "processes");
    assert.equal(bare.reveals, undefined, "the model's object is not changed");
    assert.equal(storeRefusal(r.request, [], SHIPPED_MANIFESTS), undefined);
    assert.match(draftNote(r.request, undefined, [], true), / It declares reveals: "processes", added whatever the draft said: ps shows other processes: their arguments, users and open files, so a call that would be free still asks until ps is in Programs that may show other processes\./);
    const mine = draftRequest({ manifest: { ...PS, program: "procs" }, scope: "global" }, { ...facts("procs"), program: pin("procs") }, "/w", ["/w"]);
    assert.match(draftNote(mine.request, undefined, [], true), /It declares reveals: "processes": procs shows/, "declared by the draft, so nothing was added");
    const none = draftRequest({ manifest: { ...bare, program: "mytool" }, scope: "global" }, { ...facts("mytool"), program: pin("mytool") }, "/w", ["/w"]);
    assert.equal(none.request.manifest.reveals, undefined);
    assert.doesNotMatch(draftNote(none.request, undefined, [], true), /reveals/);
});

test("a stored manifest never reaches the process host: the spawn names no manifest, so a marked one cannot fail its reader", () => {
    const plan = planSpawn({ argv: ["ps", "-e", "-f"], cwd: "/w", env: {} }, { cwd: "/w", roots: ["/w"], stored: [entry(PS)] });
    assert.equal(plan.description.program, "ps", "described by the stored entry");
    assert.equal(plan.credential, undefined);
    assert.doesNotMatch(JSON.stringify(plan.spawn), /reveals|processes/);
});

// --- the facts: the list decides `allowed`, by the manifest's program ---

test("a revealing call is listed only when its program is in shellRevealsAllow; one program listed frees no other", () => {
    const off = shFacts(facts(), null, place());
    assert.equal(off.described, true, off.why.join("; "));
    assert.deepEqual(off.reveals, { what: "processes", program: "ps", allowed: false }, "no list given is nothing listed");
    assert.deepEqual(shFacts(facts(), null, place([])).reveals?.allowed, false);
    assert.deepEqual(shFacts(facts(), null, place(["ps"])).reveals, { what: "processes", program: "ps", allowed: true });
    assert.equal(shFacts(facts("lsof"), null, place(["ps"])).reveals?.allowed, false, "ps in the list leaves lsof asking");
    assert.equal(shFacts(facts(), null, place(["PS", "ps "])).reveals?.allowed, false, "matched exactly, never loosely");
});

test("the card says what a revealing program shows, flagged while it is not listed", () => {
    const line = (allow) => shCardLines(shFacts(facts(), null, place(allow))).find((l) => l.label === "Shows");
    assert.deepEqual(line([]), { label: "Shows", value: "ps shows other processes: their arguments, users and open files", warn: true });
    assert.equal(line(["ps"]).warn, undefined);
});

// --- the gate key ---

test("shellRevealsAllow is a gate key: default empty, never writable by the model, and not in ml.config()", () => {
    assert.deepEqual(DEFAULT_CONFIG.shellRevealsAllow, []);
    assert.equal(settingDecl("shellRevealsAllow")?.class, "gate");
    assert.equal(modelWritable("shellRevealsAllow"), false, "change_setting refuses it");
    assert.equal("shellRevealsAllow" in publicConfig({ ...DEFAULT_CONFIG, shellRevealsAllow: ["ps"] }, false), false);
});
