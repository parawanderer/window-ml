// Self-source fetch — the pure gate for auto-approving an UNCREDENTIALED read of the agent's OWN repo source.
//
// The agent can read the code it's running (to explain/debug itself) without a per-URL approval prompt, behind
// the default-on `autoApproveSelfSource` flag. Near-zero risk: PUBLIC, UNCREDENTIALED, READ-ONLY, and locked to
// the agent's own repo (owner/repo derived from BUILD_INFO.repoUrl).
//
// SECURITY BOUNDARY — this auto-approve has NO human in the loop, so it must never fetch **user-generated prose**
// (a prompt-injection surface: anyone can open an issue / PR comment / discussion on a public repo with
// "ignore your instructions…" text). So it whitelists ONLY maintainer-controlled content:
//   • raw.githubusercontent.com/<owner>/<repo>/…  — committed FILE content (only merges land here).
//   • api.github.com/repos/<owner>/<repo>/…       — the repo's structural/code endpoints, EXCEPT any path that
//     touches a PROSE endpoint (issues / pulls / comments / discussions / reviews / releases) — those stay GATED
//     (still fetchable, just with the normal approval prompt).
// A regex on the fetched BODY would be the wrong fix (a new prose field could slip through); this gates by the
// URL's host + path shape instead. Adjust PROSE_SEGMENTS if GitHub adds a prose endpoint.

/** Parse `owner`/`repo` from a public GitHub repo URL (e.g. BUILD_INFO.repoUrl). null if it isn't a github URL. */
export function parseRepo(repoUrl: string): { owner: string; repo: string } | null {
    const m = (repoUrl || "").match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    return m ? { owner: m[1], repo: m[2] } : null;
}

// Path segments that mean "user-generated / free prose" on the GitHub API — a prompt-injection surface, so a
// URL containing ANY of these is NOT auto-approved (it still works, just behind the normal approval prompt).
// `releases` is included because release BODIES are free prose too.
const PROSE_SEGMENTS = new Set(["issues", "pulls", "pull", "comments", "discussions", "reviews", "releases"]);

/**
 * Is `url` an uncredentialed-safe, NON-prose read of the agent's OWN repo source? (The caller has already ensured
 * the fetch is uncredentialed and the flag is on.) Case-insensitive owner/repo match; https only.
 */
export function isSelfSourceUrl(url: string, repoUrl: string): boolean {
    let u: URL;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== "https:") return false;
    const r = parseRepo(repoUrl);
    if (!r) return false;
    const owner = r.owner.toLowerCase(), repo = r.repo.toLowerCase();
    const segs = u.pathname.split("/").filter(Boolean).map(s => decodeURIComponent(s));
    const host = u.hostname.toLowerCase();

    if (host === "raw.githubusercontent.com") {
        // /<owner>/<repo>/<ref>/<path…> — committed file content, maintainer-controlled → always OK for this repo.
        return segs[0]?.toLowerCase() === owner && segs[1]?.toLowerCase() === repo;
    }
    if (host === "api.github.com") {
        // /repos/<owner>/<repo>/… — this repo only, and NOT a prose endpoint anywhere in the path.
        if (segs[0]?.toLowerCase() !== "repos" || segs[1]?.toLowerCase() !== owner || segs[2]?.toLowerCase() !== repo) return false;
        return !segs.some(s => PROSE_SEGMENTS.has(s.toLowerCase()));
    }
    return false;
}
