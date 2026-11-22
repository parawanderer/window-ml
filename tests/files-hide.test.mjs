// files-hide.test.mjs — the rule for hiding files (src/files-hide.ts, docs/spec/POLICIES.md, "Hiding files"): the glob matcher,
// which patterns are refused, the built-in defaults, and which entry wins across layers.

import { test } from "node:test";
import assert from "node:assert/strict";

const { HIDE_PATTERN_MAX, HIDE_ENTRIES_MAX, globMatch, patternRefusal, specificity, moreSpecific, DEFAULT_HOLDS, DOTENV_TEMPLATES, defaultHold, resolveHidden, patternsOverlap, overlapsDefault, beats } = await import("../src/files-hide.ts");

let n = 0;
/** An entry with a fresh id. */
const E = (layer, effect, source) => ({ id: `${layer}-${effect}-${n++}`, layer, effect, source });

// --- the limits ---

test("the limits are the spec's", () => {
    assert.equal(HIDE_PATTERN_MAX, 512);
    assert.equal(HIDE_ENTRIES_MAX, 256);
});

// --- globMatch ---

test("globMatch table", () => {
    const rows = [
        ["/files/agent/.env", "/files/agent/.env", true],
        ["/files/agent/.env", "/files/agent/.ENV", false],
        ["/files/agent/*.env", "/files/agent/prod.env", true],
        ["/files/agent/*.env", "/files/agent/.env", true],
        ["/files/agent/*.env", "/files/agent/sub/prod.env", false],
        ["/files/agent/*", "/files/agent/a/b", false],
        ["/files/*/x", "/files/agent/x", true],
        ["/files/agent/*", "/files/agent", false],
        ["/files/agent", "/files/agent/x", false],
        ["/files/agent/a?c", "/files/agent/abc", true],
        ["/files/agent/a?c", "/files/agent/ac", false],
        ["/files/agent/a?c", "/files/agent/abbc", false],
        ["/files/agent/[abc].txt", "/files/agent/b.txt", true],
        ["/files/agent/[abc].txt", "/files/agent/d.txt", false],
        ["/files/agent/[a-c].txt", "/files/agent/b.txt", true],
        ["/files/agent/[a-c].txt", "/files/agent/z.txt", false],
        ["/files/agent/[!a-c].txt", "/files/agent/z.txt", true],
        ["/files/agent/[!a-c].txt", "/files/agent/b.txt", false],
        ["/files/agent/[^a-c].txt", "/files/agent/z.txt", true],
        ["/files/agent/[^a-c].txt", "/files/agent/a.txt", false],
        ["/files/agent/*a*b*", "/files/agent/xxaxxbxx", true],
        ["/files/agent/*a*b*", "/files/agent/xxbxxaxx", false],
        ["/files/agent/a*", "/files/agent/a", true],
    ];
    for (const [p, path, want] of rows) assert.equal(globMatch(p, path), want, `${p} vs ${path}`);
});

test("globMatch is not exponential on a pathological pattern", () => {
    const p = "/files/agent/" + "*a".repeat(40) + "b";
    const t0 = Date.now();
    assert.equal(globMatch(p, "/files/agent/" + "a".repeat(200)), false);
    assert.ok(Date.now() - t0 < 1000);
});

// --- patternRefusal ---

test("patternRefusal refuses each malformed shape and names a reason", () => {
    const bad = ["", "x".repeat(HIDE_PATTERN_MAX + 1), "files/agent/.env", "/files/**/x", "/files/agent/./x", "/files/agent/../x", "/files//x", "/files/agent/", "/files/agent/[abc", "/files/a\u0000b", "/files/a\nb", "/files/a\u007fb", "/"];
    for (const effect of ["hide", "show"])
        for (const s of bad) assert.equal(typeof patternRefusal(s, effect), "string", `${effect} ${JSON.stringify(s).slice(0, 40)}`);
});

test("patternRefusal accepts ordinary patterns and the exact maximum length", () => {
    const ok = ["/files/agent/.env", "/files/agent/*.env", "/files/attached/h1/[a-c]?.txt", "/files/agent/sub/x.txt", "/" + "a".repeat(HIDE_PATTERN_MAX - 1)];
    for (const effect of ["hide", "show"]) for (const s of ok) assert.equal(patternRefusal(s, effect), undefined, `${effect} ${s.slice(0, 40)}`);
});

test("a show over each credential directory is refused naming it; a hide over it is allowed", () => {
    for (const d of [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store", "Keychains"]) {
        for (const s of [`/files/agent/${d}`, `/files/agent/${d}/id_rsa`, `/files/attached/h1/${d}/x`]) {
            const r = patternRefusal(s, "show");
            assert.ok(r && r.includes(d), `${s}: ${r}`);
            assert.equal(patternRefusal(s, "hide"), undefined, `hide ${s}`);
        }
    }
    for (const d of ["gcloud", "gh"]) {
        const r = patternRefusal(`/files/agent/.config/${d}/hosts.yml`, "show");
        assert.ok(r && r.includes(`.config/${d}`), r);
        assert.equal(patternRefusal(`/files/agent/.config/${d}/hosts.yml`, "hide"), undefined);
    }
    assert.equal(patternRefusal("/files/agent/.config/other/x", "show"), undefined);
    assert.equal(patternRefusal("/files/agent/gcloud/x", "show"), undefined, "gcloud without .config is fine");
});

test("a show whose glob could match a credential directory is refused", () => {
    for (const s of ["/files/agent/.s*/x", "/files/agent/.ss?/x", "/files/agent/[.]ssh/x", "/files/agent/.config/g*/x", "/files/agent/.c*/gcloud/x"])
        assert.equal(typeof patternRefusal(s, "show"), "string", s);
    assert.equal(patternRefusal("/files/agent/.s*/x", "hide"), undefined);
});

test("a show whose LAST segment is a glob names files, not a credential directory, and is allowed", () => {
    for (const s of ["/files/agent/*", "/files/agent/*.txt", "/files/agent/.s*", "/files/agent/.config/*"])
        assert.equal(patternRefusal(s, "show"), undefined, s);
    assert.equal(typeof patternRefusal("/files/agent/.ssh", "show"), "string", "the directory itself, named literally");
    assert.equal(typeof patternRefusal("/files/agent/.config/gh", "show"), "string");
});

// --- defaults ---

test("the defaults are the four ids, each with a label", () => {
    assert.deepEqual(DEFAULT_HOLDS.map((d) => d.id), ["default:dotenv", "default:credential-files", "default:link-target", "default:linked-template"]);
    for (const d of DEFAULT_HOLDS) assert.ok(d.label.length > 0);
    assert.deepEqual(DOTENV_TEMPLATES, [".env.example", ".env.sample", ".env.template"]);
});

test("defaultHold: dotenv names by last component, templates exempt", () => {
    for (const p of ["/files/agent/.env", "/files/agent/.env.local", "/files/agent/sub/.env.production", "/files/attached/h1/x/.env"])
        assert.equal(defaultHold(p), "default:dotenv", p);
    for (const t of DOTENV_TEMPLATES) {
        assert.equal(defaultHold(`/files/agent/${t}`), undefined, t);
        assert.equal(defaultHold(`/files/agent/sub/${t}`), undefined, t);
    }
    for (const p of ["/files/agent/.ENV", "/files/agent/.envrc", "/files/agent/env", "/files/agent/x.env", "/files/agent/.env/x"])
        assert.equal(defaultHold(p), undefined, p);
});

test("defaultHold: credential files only at a root's top", () => {
    for (const name of [".netrc", ".git-credentials", ".pgpass"]) {
        assert.equal(defaultHold(`/files/agent/${name}`), "default:credential-files", name);
        assert.equal(defaultHold(`/files/attached/h1/${name}`), "default:credential-files", name);
        assert.equal(defaultHold(`/files/agent/sub/${name}`), undefined, name);
        assert.equal(defaultHold(`/files/attached/h1/sub/${name}`), undefined, name);
        assert.equal(defaultHold(`/files/attached/${name}`), undefined, "no handle level");
        assert.equal(defaultHold(`/files/${name}`), undefined);
    }
});

test("defaultHold never answers with a link default", () => {
    for (const p of ["/files/agent/.env", "/files/agent/.netrc", "/files/agent/x", "/files/agent/.env.example"]) {
        const r = defaultHold(p);
        assert.ok(r === undefined || !r.startsWith("default:link") && r !== "default:linked-template");
    }
});

// --- resolveHidden ---

test("resolveHidden: nothing matches, nothing is hidden", () => {
    assert.deepEqual(resolveHidden("/files/agent/notes.txt", []), { hidden: false, by: undefined });
    assert.deepEqual(resolveHidden("/files/agent/notes.txt", [E("global", "show", "/files/agent/other")]), { hidden: false, by: undefined });
});

test("resolveHidden: defaults hold with no entries", () => {
    assert.deepEqual(resolveHidden("/files/agent/.env", []), { hidden: true, by: "default:dotenv" });
    assert.deepEqual(resolveHidden("/files/agent/.netrc", []), { hidden: true, by: "default:credential-files" });
    assert.equal(resolveHidden("/files/agent/.env.example", []).hidden, false);
});

test("resolveHidden: a show of .env releases it while .env.local stays held", () => {
    for (const layer of ["session", "global"]) {
        const show = E(layer, "show", "/files/agent/.env");
        assert.deepEqual(resolveHidden("/files/agent/.env", [show]), { hidden: false, by: show.id });
        assert.deepEqual(resolveHidden("/files/agent/.env.local", [show]), { hidden: true, by: "default:dotenv" });
    }
});

test("resolveHidden: a glob show releases only its matches", () => {
    const show = E("session", "show", "/files/agent/*.env");
    assert.equal(resolveHidden("/files/agent/prod.env", [show]).hidden, false);
    assert.equal(resolveHidden("/files/agent/.env", [show]).hidden, false);
    assert.equal(resolveHidden("/files/agent/.env.local", [show]).hidden, true);
    assert.equal(resolveHidden("/files/agent/sub/.env", [show]).hidden, true);
    assert.equal(resolveHidden("/files/agent/.netrc", [show]).hidden, true);
});

test("resolveHidden: a hide holds a non-default file", () => {
    const h = E("global", "hide", "/files/agent/secrets/*.txt");
    assert.deepEqual(resolveHidden("/files/agent/secrets/a.txt", [h]), { hidden: true, by: h.id });
    assert.equal(resolveHidden("/files/agent/other/a.txt", [h]).hidden, false);
});

test("resolveHidden: a session show beats a global hide, and the reverse does not", () => {
    const gh = E("global", "hide", "/files/agent/a.txt");
    const ss = E("session", "show", "/files/agent/*.txt");
    assert.deepEqual(resolveHidden("/files/agent/a.txt", [gh, ss]), { hidden: false, by: ss.id });
    const sh = E("session", "hide", "/files/agent/*.txt");
    const gs = E("global", "show", "/files/agent/a.txt");
    assert.deepEqual(resolveHidden("/files/agent/a.txt", [gs, sh]), { hidden: true, by: sh.id }, "the session layer decides even when less specific");
});

test("resolveHidden: within a layer the more specific wins, and a tie hides in either order", () => {
    const broad = E("global", "hide", "/files/agent/*.txt");
    const narrow = E("global", "show", "/files/agent/a.txt");
    assert.equal(resolveHidden("/files/agent/a.txt", [broad, narrow]).by, narrow.id);
    assert.equal(resolveHidden("/files/agent/a.txt", [narrow, broad]).by, narrow.id);
    assert.equal(resolveHidden("/files/agent/b.txt", [broad, narrow]).by, broad.id);
    const s = E("session", "show", "/files/agent/a.txt");
    const h = E("session", "hide", "/files/agent/a.txt");
    assert.deepEqual(resolveHidden("/files/agent/a.txt", [s, h]), { hidden: true, by: h.id });
    assert.deepEqual(resolveHidden("/files/agent/a.txt", [h, s]), { hidden: true, by: h.id });
});

test("resolveHidden: a refused entry is ignored", () => {
    const refused = E("session", "show", "/files/agent/.ssh/id_rsa");
    const hide = E("global", "hide", "/files/agent/.ssh/id_rsa");
    assert.deepEqual(resolveHidden("/files/agent/.ssh/id_rsa", [refused, hide]), { hidden: true, by: hide.id });
    const bad = E("session", "show", "/files/agent/**");
    assert.deepEqual(resolveHidden("/files/agent/.env", [bad]), { hidden: true, by: "default:dotenv" });
    const relative = E("session", "hide", "files/agent/a.txt");
    assert.equal(resolveHidden("/files/agent/a.txt", [relative]).hidden, false);
});

test("resolveHidden: every default id is reachable and every default is overridable by a show of the path", () => {
    const held = { "default:dotenv": "/files/agent/.env", "default:credential-files": "/files/attached/h1/.pgpass" };
    for (const [id, path] of Object.entries(held)) {
        assert.deepEqual(resolveHidden(path, []), { hidden: true, by: id });
        const show = E("global", "show", path);
        assert.deepEqual(resolveHidden(path, [show]), { hidden: false, by: show.id });
    }
    for (const t of DOTENV_TEMPLATES) assert.equal(resolveHidden(`/files/agent/${t}`, []).hidden, false, t);
    // a hide over a template holds it
    for (const t of DOTENV_TEMPLATES) assert.equal(resolveHidden(`/files/agent/${t}`, [E("global", "hide", `/files/agent/${t}`)]).hidden, true, t);
});

// --- specificity ---

test("specificity orders a literal over a glob, then segments, then literal characters", () => {
    assert.deepEqual(specificity("/files/agent/a.txt"), [1, 4, "files".length + "agent".length + "a.txt".length]);
    assert.equal(specificity("/files/agent/*")[0], 0);
    assert.ok(moreSpecific("/files/agent/a.txt", "/files/agent/*") > 0);
    assert.ok(moreSpecific("/files/agent/*", "/files/agent/a.txt") < 0);
    assert.ok(moreSpecific("/files/agent/sub/*", "/files/agent/*.txt") > 0, "more segments");
    assert.ok(moreSpecific("/files/agent/ab*", "/files/agent/a*") > 0, "more literal characters");
    assert.equal(moreSpecific("/files/agent/*.a", "/files/agent/*.b"), 0);
    assert.equal(moreSpecific("/files/agent/[ab].txt", "/files/agent/?.txt"), 0, "a class and a ? are both one wildcard");
});

// --- patternsOverlap ---

test("patternsOverlap", () => {
    const rows = [
        ["/files/agent/.env", "/files/agent/.env", true],
        ["/files/agent/.env", "/files/agent/*", true],
        ["/files/agent/*.env", "/files/agent/.env", true],
        ["/files/agent/*.env", "/files/agent/.env.*", true],
        ["/files/agent/a*", "/files/agent/b*", false],
        ["/files/agent/*.a", "/files/agent/*.b", false],
        ["/files/agent/a*z", "/files/agent/ab*", true],
        ["/files/agent/*", "/files/agent/x/y", false],
        ["/files/agent/a?c", "/files/agent/abc", true],
        ["/files/agent/a?c", "/files/agent/ac", false],
        ["/files/agent/[a-c]", "/files/agent/[d-f]", false],
        ["/files/agent/[a-c]", "/files/agent/[b-f]", true],
        ["/files/agent/[a-c]", "/files/agent/d", false],
        ["/files/agent/[a-c]", "/files/agent/b", true],
        ["/files/agent/[!a]", "/files/agent/[a-c]", true],
        ["/files/agent/*/x", "/files/*/y/x", true],
        ["/files/agent/x", "/files/attached/x", false],
        ["/files/agent/*x*", "/files/agent/*y*", true],
    ];
    for (const [a, b, want] of rows) {
        assert.equal(patternsOverlap(a, b), want, `${a} ~ ${b}`);
        assert.equal(patternsOverlap(b, a), want, `${b} ~ ${a}`);
    }
});

test("patternsOverlap agrees with globMatch: a path both match implies overlap", () => {
    const pats = ["/files/agent/*.env", "/files/agent/.env*", "/files/agent/[.]env", "/files/agent/?env", "/files/agent/a*", "/files/agent/*"];
    const paths = ["/files/agent/.env", "/files/agent/a.env", "/files/agent/.env.local", "/files/agent/aenv", "/files/agent/a"];
    for (const a of pats) for (const b of pats) for (const p of paths) if (globMatch(a, p) && globMatch(b, p)) assert.ok(patternsOverlap(a, b), `${a} ${b} ${p}`);
});

// --- overlapsDefault ---

test("overlapsDefault: dotenv", () => {
    for (const s of ["/files/agent/.env", "/files/agent/.env.local", "/files/agent/*", "/files/agent/*.env", "/files/agent/.env*", "/files/agent/.e?v", "/files/agent/sub/.env.*", "/files/agent/.env.[lp]*"])
        assert.equal(overlapsDefault(s, "default:dotenv"), true, s);
    for (const s of ["/files/agent/a.txt", "/files/agent/x*", "/files/agent/.envrc", "/files/agent/.netrc"])
        assert.equal(overlapsDefault(s, "default:dotenv"), false, s);
    for (const t of DOTENV_TEMPLATES) assert.equal(overlapsDefault(`/files/agent/${t}`, "default:dotenv"), false, t);
});

test("overlapsDefault: credential files, for both root forms", () => {
    for (const name of [".netrc", ".git-credentials", ".pgpass"]) {
        for (const s of [`/files/agent/${name}`, `/files/attached/h1/${name}`, `/files/attached/*/${name}`, `/files/agent/${name.slice(0, 3)}*`, "/files/agent/*", "/files/attached/h1/*"])
            assert.equal(overlapsDefault(s, "default:credential-files"), true, s);
        assert.equal(overlapsDefault(`/files/agent/sub/${name}`, "default:credential-files"), false, "not at a root's top");
        assert.equal(overlapsDefault(`/files/attached/h1/sub/${name}`, "default:credential-files"), false);
    }
    assert.equal(overlapsDefault("/files/agent/a.txt", "default:credential-files"), false);
});

test("overlapsDefault: the link defaults never overlap anything, and an unknown id is false", () => {
    for (const id of ["default:link-target", "default:linked-template", "default:nope"])
        for (const s of ["/files/agent/.env", "/files/agent/*", "/files/agent/.env.example"]) assert.equal(overlapsDefault(s, id), false, `${id} ${s}`);
});

test("overlapsDefault agrees with defaultHold over a sample of paths", () => {
    const pats = ["/files/agent/.env", "/files/agent/.env.*", "/files/agent/*", "/files/agent/.netrc", "/files/attached/h1/.pgpass"];
    const paths = ["/files/agent/.env", "/files/agent/.env.local", "/files/agent/.netrc", "/files/attached/h1/.pgpass", "/files/agent/.env.example"];
    for (const id of ["default:dotenv", "default:credential-files"])
        for (const s of pats) for (const p of paths) if (globMatch(s, p) && defaultHold(p) === id) assert.equal(overlapsDefault(s, id), true, `${s} ${p} ${id}`);
});

// --- beats ---

test("beats: layer order, then specificity, then hide over show", () => {
    const ss = E("session", "show", "/files/agent/*");
    const gh = E("global", "hide", "/files/agent/a.txt");
    assert.equal(beats(ss, gh), true);
    assert.equal(beats(gh, ss), false);
    const g1 = E("global", "hide", "/files/agent/*");
    const g2 = E("global", "show", "/files/agent/a.txt");
    assert.equal(beats(g2, g1), true);
    assert.equal(beats(g1, g2), false);
    const t1 = E("global", "hide", "/files/agent/*.a");
    const t2 = E("global", "show", "/files/agent/*.b");
    assert.equal(beats(t1, t2), true, "tie: hide beats show");
    assert.equal(beats(t2, t1), false);
    const t3 = E("global", "hide", "/files/agent/*.b");
    assert.equal(beats(t1, t3), false, "two hides tie: neither beats");
    assert.equal(beats(t1, { ...t1 }), false, "equal entries");
});

test("beats: a default never beats an entry, and an entry beats every default", () => {
    for (const d of DEFAULT_HOLDS) {
        const ref = { id: d.id, layer: "default" };
        for (const layer of ["session", "global"]) for (const effect of ["hide", "show"]) {
            const e = E(layer, effect, "/files/agent/*");
            assert.equal(beats(ref, e), false, `${d.id} vs ${layer} ${effect}`);
            assert.equal(beats(e, ref), true, `${layer} ${effect} vs ${d.id}`);
        }
        for (const d2 of DEFAULT_HOLDS) assert.equal(beats(ref, { id: d2.id, layer: "default" }), false);
    }
});
