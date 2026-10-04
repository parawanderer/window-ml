// grant-profiles.test.mjs — the NAMED GRANTS the pairing screens offer (src/pairing/api.ts): what each profile grants,
// which one a set of scopes is, and what a delegate may offer. Pure, and shared by the chat page and the phone app, so
// both surfaces are held to the same answer rather than to two copies of it.
import test from "node:test";
import assert from "node:assert/strict";
import { GRANT_PROFILES, DEFAULT_PROFILE, SCOPES, profileOf, profilesFor } from "../src/pairing/api.ts";

const byId = (id) => GRANT_PROFILES.find((p) => p.id === id);

// --- what each named grant is, and which one a set of scopes already is ---

test("each profile grants scopes the screens have words for, and says what it costs", () => {
    // A profile naming a scope `SCOPES` cannot describe would render as a bare identifier in the one place a person is
    // deciding how much to trust a device, which is the worst place to be terse.
    for (const p of GRANT_PROFILES) {
        assert.ok(p.label && p.detail, `${p.id} says what it is`);
        for (const s of p.scopes ?? []) assert.ok(SCOPES.some((k) => k.id === s), `${p.id} grants "${s}", which has words`);
    }
    assert.deepEqual(byId("watch").scopes, ["view"], "watching is reading and nothing else");
    assert.deepEqual(byId("use").scopes, ["view", "drive"]);
    assert.equal(byId("custom").scopes, null, "custom grants whatever the editor is showing");
    assert.ok(byId(DEFAULT_PROFILE), "the default names a profile that exists");
});

test("a profile names SCOPES only: pairing and revoking are not part of one", () => {
    // Exactly one principal may sign revocations, and two signers race with the loser refused as stale. A profile that
    // could carry it would be a tick box that manufactures that. Pairing is left out for a weaker reason: it is a
    // decision about growing the account rather than about this device.
    for (const p of GRANT_PROFILES) {
        assert.equal("mayRevoke" in p, false, `${p.id}`);
        assert.equal("mayPair" in p, false, `${p.id}`);
    }
});

test("profileOf names what a grant already is, in any order, and falls back to custom", () => {
    assert.equal(profileOf(["view"]), "watch");
    assert.equal(profileOf(["drive", "view"]), "use", "a grant's scopes are a SET, so the order it arrived in is nothing");
    assert.equal(profileOf(["view", "view", "drive"]), "use", "and a repeat is still that set");
    assert.equal(profileOf([]), "custom", "granting nothing is not a profile anyone would pick, but it is expressible");
    assert.equal(profileOf(["view", "drive", "approve"]), "custom");
    assert.equal(profileOf(["look"]), "custom", "a scope this build has never heard of still lands somewhere");
});

test("a delegate offers only the profiles it can grant in full, and always custom", () => {
    // The hub refuses a delegate granting what it does not hold, and that refusal arrives as an error about a
    // certificate, long after the tick. Dropping the profile is how the screen stays honest about what it can do.
    assert.deepEqual(profilesFor(["view", "drive"]).map((p) => p.id), ["watch", "use", "custom"]);
    assert.deepEqual(profilesFor(["view"]).map((p) => p.id), ["watch", "custom"], "it cannot pass on `drive`, so it does not offer it");
    assert.deepEqual(profilesFor([]).map((p) => p.id), ["custom"], "nothing to pass on: the editor is all that is left");
    assert.deepEqual(profilesFor(undefined).map((p) => p.id), ["watch", "use", "custom"], "no limit known (the root): every profile");
    assert.deepEqual(profilesFor(null).map((p) => p.id), ["watch", "use", "custom"], "and null is how an offer spells that");
    assert.notEqual(profilesFor(["view"]), GRANT_PROFILES, "the caller gets its own array to sort or filter");
});

// --- the same grants on both surfaces ---

test("both screens read the profiles from the shared module, by a path the phone's bundler can follow", async () => {
    // The page and the phone app are one product on two screens, and a grant worded one way here and another way there
    // is a person being asked two different questions about the same decision. The guard is structural because the
    // phone's screens cannot be rendered in this runner: what it can check is that there is only one copy to word.
    const { readFileSync } = await import("node:fs");
    const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
    const surfaces = {
        "the chat page": "src/pairing/pairing-ui.tsx",
        "the phone app": "mobile/src/screens/DeviceScreens.tsx",
    };
    for (const [what, file] of Object.entries(surfaces)) {
        const src = read(file);
        assert.match(src, /\bprofilesFor\s*\(/, `${what} (${file}) offers the named grants`);
        assert.match(src, /\bprofileOf\s*\(/, `${what} derives which one is selected rather than holding it`);
        assert.match(src, /import \{[^}]*\bprofilesFor\b[^}]*\} from "(\.\/api|(\.\.\/)+src\/pairing\/api)"/,
            `${what} must take them from the shared module, not keep its own list`);
        // The words live in one place. A label spelled out on a surface is a second copy by another name.
        for (const p of GRANT_PROFILES) {
            if (p.scopes) assert.equal(src.includes(p.detail), false, `${what} must not restate "${p.id}"'s words`);
        }
    }
    // A value import from outside Metro's watched folders typechecks, runs in debug, and breaks the RELEASE bundle,
    // so the phone's half of this rests on `src/pairing` staying watched (the same rule blank-start.test.mjs guards).
    assert.match(read("mobile/metro.config.js"), /watchFolders[\s\S]*"pairing"/,
        "src/pairing must stay watched, or the phone's import of the profiles cannot ship");
});
