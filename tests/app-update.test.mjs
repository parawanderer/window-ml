// app-update.test.mjs — the phone app's update check (src/native/app-update.ts) against a FAKE GitHub
// (tests/fixtures/fake-github.mjs) over real HTTP: how far behind a build is, every way the answer can be "we do not
// know", the inbox item it earns, and the two real GitHub responses it was written against. The release it reads is
// made by CI, so the workflow's side of that contract is checked here too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const U = await import("../src/native/app-update.ts");
const { startFakeGitHub, historyOf, shaOf } = await import("./fixtures/fake-github.mjs");

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-10T12:00:00Z");

/** A build as the app would carry it, pointed at the fake. */
const buildAt = (gh, name, history, extra = {}) => ({
    repo: gh.repo, tag: gh.tag, api: gh.url, sha: shaOf(name),
    committedAt: history.find((c) => c.name === name)?.date ?? null, ...extra,
});

/** Run one check against a fresh fake, and close it. */
async function check(history, built, setup = () => {}, extra = {}) {
    const gh = await startFakeGitHub({ history });
    try {
        setup(gh.state);
        const r = await U.checkForUpdate(buildAt(gh, built, history, extra), fetch, NOW);
        return { r, calls: gh.calls };
    } finally { await gh.close(); }
}

// --- how far behind: the answer a person reads ---

test("a build five commits behind main says so, in commits and in days, newest change first", async () => {
    const history = historyOf(12, NOW);
    const { r, calls } = await check(history, "c6");
    assert.equal(r.state, "behind");
    assert.equal(r.commits, 5);
    assert.equal(r.days, 5, "c6 is five days older than c11");
    assert.deepEqual(r.changes.map((c) => c.sha), ["c11", "c10", "c9", "c8", "c7"].map(shaOf));
    assert.equal(r.release.sha, shaOf("c11"));
    assert.match(r.release.apkUrl, /\/download\/android-latest\/window-ml\.apk$/);
    assert.match(r.release.apkDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(U.behindWords(r), "5 changes behind, 5 days old");
    assert.equal(calls.length, 2, "the release, then the comparison");
});

test("the build the release was made from is current, and costs ONE request", async () => {
    const history = historyOf(4, NOW);
    const { r, calls } = await check(history, "c3");
    assert.equal(r.state, "current");
    assert.equal(calls.length, 1, "no comparison when the commits are the same");
});

test("a short hash in the build matches the release's full one", async () => {
    const history = historyOf(4, NOW);
    const { r } = await check(history, "c3", () => {}, { sha: shaOf("c3").slice(0, 7) });
    assert.equal(r.state, "current");
});

test("a build NEWER than the release (CI is still building it) is current, not behind", async () => {
    const history = historyOf(6, NOW);
    const { r } = await check(history, "c5", (s) => { s.releaseAt = "c3"; });
    assert.equal(r.state, "current");
});

test("one commit behind on the same day reads in the singular, and as made today", async () => {
    const history = historyOf(3, NOW).map((c) => ({ ...c, date: new Date(NOW).toISOString() }));
    const { r } = await check(history, "c1");
    assert.equal(U.behindWords(r), "1 change behind, made today");
});

test("a build that does not know its own date still counts commits, and says nothing about days", async () => {
    const history = historyOf(5, NOW);
    const { r } = await check(history, "c1", () => {}, { committedAt: null });
    assert.equal(r.days, null);
    assert.equal(U.behindWords(r), "3 changes behind");
});

// --- every way of not knowing: never "up to date" ---

test("a build from a commit main never had (a local or rewritten one) is ELSEWHERE, not current", async () => {
    const history = historyOf(5, NOW);
    const gh = await startFakeGitHub({ history });
    try {
        const r = await U.checkForUpdate({ ...buildAt(gh, "c1", history), sha: shaOf("not on main") }, fetch, NOW);
        assert.equal(r.state, "elsewhere");
    } finally { await gh.close(); }
});

test("a build from a branch that diverged from main is ELSEWHERE", async () => {
    const history = historyOf(5, NOW);
    const { r } = await check(history, "side", (s) => { s.branch = [{ name: "side" }]; });
    assert.equal(r.state, "elsewhere");
});

test("no release, a release made from a branch NAME, and a malformed comparison are each a failure with words", async () => {
    const history = historyOf(5, NOW);
    const cases = [
        [(s) => { s.release = false; }, /no "android-latest" release/],
        [(s) => { s.releaseTarget = "main"; }, /does not name the commit/],
        [(s) => { s.malformed = true; }, /shape this app does not read/],
    ];
    for (const [setup, words] of cases) {
        const { r } = await check(history, "c1", setup);
        assert.equal(r.state, "failed");
        assert.match(r.error, words);
    }
});

test("a release with no APK on it is still read: behind, with nothing to download", async () => {
    const history = historyOf(5, NOW);
    const { r } = await check(history, "c1", (s) => { s.noAsset = true; });
    assert.equal(r.state, "behind");
    assert.equal(r.release.apkUrl, null);
});

test("GitHub's rate limit is a failure that says when to come back, and even a forced check waits for it", async () => {
    const history = historyOf(5, NOW);
    const reset = Math.floor((NOW + 20 * 60_000) / 1000);
    const { r } = await check(history, "c1", (s) => { s.rateLimited = reset; });
    assert.equal(r.state, "failed");
    assert.match(r.error, /limit/);
    assert.equal(r.retryAt, reset * 1000);
    assert.equal(U.dueForCheck(r, NOW + 60_000, { force: true }), false);
    assert.equal(U.dueForCheck(r, reset * 1000 + 1), true);
});

test("an unreachable GitHub is a failure, never a throw", async () => {
    const gh = await startFakeGitHub({ history: historyOf(3, NOW) });
    const build = buildAt(gh, "c1", historyOf(3, NOW));
    await gh.close();
    const r = await U.checkForUpdate(build, fetch, NOW);
    assert.equal(r.state, "failed");
    assert.equal(r.error, "Could not reach GitHub.");
});

test("a build with no repository or no commit asks nothing", async () => {
    let asked = 0;
    const counting = async () => { asked++; throw new Error("should not be called"); };
    const base = { repo: "o/r", sha: shaOf("x"), committedAt: null, api: "http://127.0.0.1:1", tag: "android-latest" };
    for (const b of [{ ...base, repo: null }, { ...base, repo: "not a repo" }, { ...base, sha: null }, { ...base, sha: "main" }]) {
        assert.equal((await U.checkForUpdate(b, counting, NOW)).state, "failed");
    }
    assert.equal(asked, 0);
});

// --- when to ask, and whether at all ---

test("updateOff: the setting, then the repository, then the commit", () => {
    const ok = { repo: "o/r", sha: "abc1234", committedAt: null, api: "x", tag: "t" };
    assert.equal(U.updateOff(ok, true), null);
    assert.equal(U.updateOff(ok, false), "disabled");
    assert.equal(U.updateOff({ ...ok, repo: null }, true), "no-repo");
    assert.equal(U.updateOff({ ...ok, repo: "o/r/x" }, true), "no-repo");
    assert.equal(U.updateOff({ ...ok, sha: null }, true), "no-build");
    assert.equal(U.updateOff({ ...ok, sha: "dev" }, true), "no-build");
});

test("dueForCheck: first launch, every six hours, a failure sooner, a forced check at once", () => {
    const rel = { sha: "a".repeat(40), publishedAt: null, apkUrl: null, apkSize: null, apkDigest: null, pageUrl: null };
    const current = { state: "current", checkedAt: NOW, release: rel };
    const failed = { state: "failed", checkedAt: NOW, error: "x" };
    assert.equal(U.dueForCheck(null, NOW), true, "never checked");
    assert.equal(U.dueForCheck(current, NOW + 5 * 3600_000), false);
    assert.equal(U.dueForCheck(current, NOW + 6 * 3600_000), true);
    assert.equal(U.dueForCheck(current, NOW + 60_000, { force: true }), true);
    assert.equal(U.dueForCheck(failed, NOW + 14 * 60_000), false);
    assert.equal(U.dueForCheck(failed, NOW + 15 * 60_000), true);
});

// --- the inbox item and the screen's grouping ---

test("the inbox item: only when behind, a suggestion keyed by the newest build, and put away until the next one", async () => {
    const history = historyOf(8, NOW);
    const { r } = await check(history, "c2");
    const row = U.updateRow(r);
    assert.equal(row.level, "suggests");
    assert.equal(row.key, `app:update:${shaOf("c7").slice(0, 12)}`);
    assert.equal(row.runtime, undefined, "about this phone, not a runtime");
    assert.equal(row.detail, "This phone's build is 5 changes behind, 5 days old. Open this to see what changed and install the new one.");
    assert.equal(U.updateRow(r, new Set([row.key])), null, "put away");
    const next = { ...r, release: { ...r.release, sha: shaOf("c8") } };
    assert.ok(U.updateRow(next, new Set([row.key])), "a newer build brings it back");
    for (const s of [null, { state: "current" }, { state: "elsewhere" }, { state: "failed" }]) assert.equal(U.updateRow(s), null);
});

test("parseSubject: the conventional prefix, with scope and bang, and anything else as other", () => {
    assert.deepEqual(U.parseSubject("feat(chat): words (#12)\n\nbody"), { kind: "feat", scope: "chat", subject: "words (#12)" });
    assert.deepEqual(U.parseSubject("fix!: breaking"), { kind: "fix", scope: null, subject: "breaking" });
    assert.deepEqual(U.parseSubject("docs(x): y"), { kind: "other", scope: "x", subject: "docs: y" });
    assert.deepEqual(U.parseSubject("Merge branch 'a'"), { kind: "other", scope: null, subject: "Merge branch 'a'" });
});

test("groupChanges: new, then fixed, then the rest, empty groups left out", () => {
    const c = (kind) => ({ sha: kind, kind, scope: null, subject: kind, at: null, url: null });
    assert.deepEqual(U.groupChanges([c("other"), c("fix"), c("feat")]).map((g) => g.title), ["New", "Fixed", "Other changes"]);
    assert.deepEqual(U.groupChanges([c("fix")]).map((g) => g.kind), ["fix"]);
});

// --- the contract with GitHub and with CI ---

test("REAL GitHub responses (captured 2026-10-10) read as a release and three commits", () => {
    const rel = U.readRelease(JSON.parse(readFileSync(new URL("./fixtures/github-release.json", import.meta.url), "utf8")));
    assert.equal(rel.sha, "e2af705699aa7a6df586f753895ae41c476b2178");
    assert.equal(rel.apkUrl, "https://github.com/parawanderer/window-ml/releases/download/android-latest/window-ml.apk");
    assert.equal(rel.apkSize, 59624639);
    assert.match(rel.apkDigest, /^sha256:/);
    const cmp = U.readCompare(JSON.parse(readFileSync(new URL("./fixtures/github-compare.json", import.meta.url), "utf8")));
    assert.equal(cmp.status, "ahead");
    assert.equal(cmp.aheadBy, 3);
    assert.deepEqual(cmp.changes.map((c) => c.kind), ["feat", "other", "fix"], "newest first: GitHub lists oldest first, and the feat landed last");
    const at = cmp.changes.map((c) => Date.parse(c.at));
    assert.ok(at[0] >= at[1] && at[1] >= at[2], "descending by date");
    assert.ok(cmp.changes.every((c) => c.at && c.url));
});

test("CI publishes the release this reads: tag android-latest, targeted at the built commit, an .apk on it", () => {
    const wf = readFileSync(new URL("../.github/workflows/tests.yml", import.meta.url), "utf8");
    assert.match(wf, /gh release create android-latest window-ml\.apk [^\n]*--target "\$GITHUB_SHA"/,
        "the check compares against target_commitish, which is a commit only because of --target");
    const sync = readFileSync(new URL("../mobile/scripts/sync-embed.mjs", import.meta.url), "utf8");
    assert.match(sync, /tag: "android-latest"/, "the app asks for the tag CI publishes");
    assert.match(sync, /GITHUB_REPOSITORY/, "a CI build names its repository");
});
