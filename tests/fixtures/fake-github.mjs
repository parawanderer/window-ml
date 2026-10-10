// fake-github.mjs — A STAND-IN FOR THE TWO GITHUB ENDPOINTS the phone app's update check reads (src/native/app-update.ts):
// a release by tag and a comparison between two commits, plus the APK download, answered from a scripted history of main
// in the same JSON shape GitHub gives (tests/fixtures/github-release.json and github-compare.json are real captures).
// Used by tests/app-update.test.mjs, and runnable on its own for the app on an emulator, which reaches the host at
// 10.0.2.2:
//
//   node tests/fixtures/fake-github.mjs [--port 8787] [--behind 5]   # main is 5 commits past the APK's build
//
// and build the app against it: WML_UPDATE_REPO=parawanderer/window-ml WML_UPDATE_API=http://10.0.2.2:8787 \
//   node scripts/android.mjs install

import { createServer } from "node:http";
import { createHash } from "node:crypto";

/** A deterministic 40-hex commit id for a name, so a test can say "the build is c3" and know the hash. */
export const shaOf = (name) => createHash("sha1").update(String(name)).digest("hex");

/**
 * Start a fake GitHub. `history` is main, oldest first, as `{ name, message, date }`; the release points at
 * `releaseAt` (a name in it, default the last). Everything a test may change later is on the returned `state`:
 *   release: false        → 404 for the tag
 *   releaseTarget: "main" → a release made from a branch name, not a commit
 *   noAsset: true         → a release with no APK on it
 *   rateLimited: <epoch s> → every call 403s with the rate-limit headers, resetting then
 *   malformed: true       → a comparison in a shape the app does not read
 *   apk: Buffer           → what the download serves
 * `calls` lists every path asked for, in order.
 */
export async function startFakeGitHub(o = {}) {
    const repo = o.repo ?? "parawanderer/window-ml";
    const tag = o.tag ?? "android-latest";
    const state = {
        history: o.history ?? [],
        releaseAt: o.releaseAt ?? null,
        release: true, releaseTarget: null, noAsset: false, rateLimited: 0, malformed: false,
        apk: o.apk ?? Buffer.from("PK\u0003\u0004 not really an apk"),
        /** commits on a side branch, which compare treats as diverged from main */
        branch: o.branch ?? [],
    };
    const calls = [];
    let base = "";
    const head = () => state.releaseAt ?? state.history.at(-1)?.name;
    const index = (sha) => state.history.findIndex((c) => shaOf(c.name) === sha || shaOf(c.name).startsWith(sha));
    const commitJson = (c) => ({
        sha: shaOf(c.name), html_url: `https://github.com/${repo}/commit/${shaOf(c.name)}`,
        commit: { author: { name: "A", email: "a@example.com", date: c.date }, committer: { name: "GitHub", email: "noreply@github.com", date: c.date }, message: c.message },
    });

    const server = createServer((req, res) => {
        const url = new URL(req.url, "http://x");
        calls.push(url.pathname);
        const send = (status, body, headers = {}) => {
            res.writeHead(status, { "content-type": "application/json", ...headers });
            res.end(typeof body === "string" ? body : JSON.stringify(body));
        };
        if (state.rateLimited) return send(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(state.rateLimited) });
        const notFound = () => send(404, { message: "Not Found", status: "404" });

        if (url.pathname === `/download/${tag}/window-ml.apk`) {
            res.writeHead(200, { "content-type": "application/vnd.android.package-archive", "content-length": state.apk.length });
            return res.end(state.apk);
        }
        if (url.pathname === `/repos/${repo}/releases/tags/${tag}`) {
            if (!state.release || !head()) return notFound();
            const at = state.history.find((c) => c.name === head());
            return send(200, {
                tag_name: tag, html_url: `https://github.com/${repo}/releases/tag/${tag}`, prerelease: true, draft: false,
                target_commitish: state.releaseTarget ?? shaOf(head()), published_at: at?.date ?? null,
                assets: state.noAsset ? [] : [{
                    name: "window-ml.apk", size: state.apk.length, content_type: "application/vnd.android.package-archive", state: "uploaded",
                    digest: `sha256:${createHash("sha256").update(state.apk).digest("hex")}`,
                    browser_download_url: `${base}/download/${tag}/window-ml.apk`,
                }],
            });
        }
        const cmp = new RegExp(`^/repos/${repo}/compare/([0-9a-f]+)\\.\\.\\.([0-9a-f]+)$`).exec(url.pathname);
        if (cmp) {
            if (state.malformed) return send(200, { commits: "nope" });
            const [from, to] = [index(cmp[1]), index(cmp[2])];
            const onBranch = state.branch.some((c) => shaOf(c.name).startsWith(cmp[1]));
            if (onBranch && to >= 0) return send(200, { status: "diverged", ahead_by: to + 1, behind_by: 1, total_commits: to + 1, commits: [] });
            if (from < 0 || to < 0) return notFound();
            const status = to > from ? "ahead" : to < from ? "behind" : "identical";
            const commits = to > from ? state.history.slice(from + 1, to + 1).map(commitJson) : [];
            return send(200, { status, ahead_by: Math.max(0, to - from), behind_by: Math.max(0, from - to), total_commits: commits.length, commits });
        }
        notFound();
    });
    await new Promise((r) => server.listen(o.port ?? 0, o.host ?? "127.0.0.1", r));
    base = `http://${o.host === "0.0.0.0" ? "10.0.2.2" : "127.0.0.1"}:${server.address().port}`;
    return {
        url: `http://127.0.0.1:${server.address().port}`, repo, tag, state, calls,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    };
}

/** A main of `n` commits, a day apart, ending today, mixing the kinds the screen groups by. */
export function historyOf(n, endMs = Date.now()) {
    const kinds = ["feat(mobile): a thing you can now do", "fix(chat): a thing that no longer breaks", "docs: words", "refactor: moved"];
    return Array.from({ length: n }, (_, i) => ({ name: `c${i}`, message: `${kinds[i % kinds.length]} ${i}\n\nbody`, date: new Date(endMs - (n - 1 - i) * 86_400_000).toISOString() }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
    const behind = Number(arg("--behind", "5"));
    const history = historyOf(behind + 10);
    const gh = await startFakeGitHub({ port: Number(arg("--port", "8787")), host: "0.0.0.0", history });
    const built = history[history.length - 1 - behind];
    console.log(`fake GitHub on ${gh.url} (the emulator: http://10.0.2.2:${new URL(gh.url).port})`);
    console.log(`build the app as commit ${built.name}: WML_UPDATE_SHA=${shaOf(built.name)} WML_UPDATE_COMMITTED_AT=${built.date}`);
}
