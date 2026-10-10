// app-update.ts — IS THERE A NEWER BUILD OF THE PHONE APP, and how far behind is this one: the rolling `android-latest`
// release on GitHub against the commit this app was built from. Pure apart from the `fetch` it is handed, so the rule
// is tested against a fake GitHub (tests/app-update.test.mjs) and the app (mobile/src/app-update.ts) only stores and
// draws what it says.
//
// There is one release, deleted and remade on every push to main (`.github/workflows/tests.yml`, "Publish it as the
// rolling Android build"), so "behind" is counted in COMMITS on main between the two builds, from GitHub's compare API.

import type { AttentionRow } from "./bridge";

/** What the app knows about itself, written into its bundle at build time (mobile/scripts/sync-embed.mjs). */
export interface BuildInfo {
    /** `owner/name` to check, or null when the build did not say (a local build): the check is then OFF */
    repo: string | null;
    /** the full commit hash the app was built from; null when it could not tell */
    sha: string | null;
    /** that commit's date, ISO 8601 */
    committedAt: string | null;
    /** the API's base URL: GitHub's, or a fake one a test points it at */
    api: string;
    /** the rolling release's tag */
    tag: string;
}

/** The newest build, as its release says. */
export interface Release {
    /** the commit it was built from */
    sha: string;
    publishedAt: string | null;
    /** the APK's download URL; null when the release carries none (a half-published one) */
    apkUrl: string | null;
    apkSize: number | null;
    /** the asset's `sha256:<hex>`, when GitHub gives one */
    apkDigest: string | null;
    /** the release's page, for reading it in a browser */
    pageUrl: string | null;
}

/** One commit between the two builds, as a line on the update screen. */
export interface Change {
    sha: string;
    /** the conventional-commit type it was landed under: what the screen groups by */
    kind: "feat" | "fix" | "other";
    scope: string | null;
    /** the subject line without its `type(scope):` prefix */
    subject: string;
    at: string | null;
    url: string | null;
}

/** What a check found. Every state but `behind` and `current` is "we do not know", never "up to date". */
export type UpdateCheck =
    | { state: "current"; checkedAt: number; release: Release }
    | {
        state: "behind"; checkedAt: number; release: Release;
        /** commits on main this build is missing */
        commits: number;
        /** days between this build's commit and the newest one's; null when either date is unknown */
        days: number | null;
        /** newest first; GitHub lists at most 250, so `commits` can exceed its length */
        changes: Change[];
    }
    /** the installed commit is not an ancestor of the release's: a build from a branch, or main was rewritten */
    | { state: "elsewhere"; checkedAt: number; release: Release }
    /** the request failed; `retryAt` is when GitHub said to come back, for a rate limit */
    | { state: "failed"; checkedAt: number; error: string; retryAt?: number };

/** Why there is no check at all. */
export type UpdateOff = "no-repo" | "no-build" | "disabled";

/** How often the app asks on its own: a few times a day is plenty for a build that lands a few times a day, and stays
 *  far under the 60 requests an hour GitHub allows an address without a token. */
export const CHECK_EVERY_MS = 6 * 3600_000;

/** Why this build cannot check, or null when it can. */
export function updateOff(build: BuildInfo, enabled: boolean): UpdateOff | null {
    if (!enabled) return "disabled";
    if (!build.repo || !/^[\w.-]+\/[\w.-]+$/.test(build.repo)) return "no-repo";
    if (!build.sha || !/^[0-9a-f]{7,40}$/i.test(build.sha)) return "no-build";
    return null;
}

/** Whether to ask now: never before a rate limit's reset, and otherwise once the last answer is `everyMs` old. A manual
 *  check passes `force`, which waits for nothing but a rate limit (asking again then only spends the next hour's). */
export function dueForCheck(last: UpdateCheck | null, nowMs: number, o: { force?: boolean; everyMs?: number } = {}): boolean {
    if (last?.state === "failed" && last.retryAt && nowMs < last.retryAt) return false;
    if (o.force || !last) return true;
    // A failure is retried sooner: the next launch, give or take, rather than six hours of a stale "could not check".
    const every = last.state === "failed" ? Math.min(o.everyMs ?? CHECK_EVERY_MS, 15 * 60_000) : (o.everyMs ?? CHECK_EVERY_MS);
    return nowMs - last.checkedAt >= every;
}

const DAY_MS = 86_400_000;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** A conventional-commit subject, split: `feat(chat)!: words` → feat, chat, words. Any other type is `other` and keeps
 *  it in front (`refactor: words`), since "other" alone does not say what kind of change it was; a line with no prefix
 *  is `other` as it stands. */
export function parseSubject(message: string): Pick<Change, "kind" | "scope" | "subject"> {
    const line = message.split("\n", 1)[0].trim();
    const m = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/.exec(line);
    if (!m) return { kind: "other", scope: null, subject: line };
    const kind = m[1].toLowerCase() === "feat" ? "feat" : m[1].toLowerCase() === "fix" ? "fix" : "other";
    return { kind, scope: m[2] || null, subject: kind === "other" ? `${m[1]}: ${m[3]}` : m[3] };
}

/** The release JSON GitHub returns for a tag, read defensively: null when it is not a release built from a commit. */
export function readRelease(json: unknown): Release | null {
    if (!json || typeof json !== "object") return null;
    const r = json as Record<string, unknown>;
    // `--target "$GITHUB_SHA"` makes this the commit. A release made from a branch NAME would carry "main" here, which
    // is not a build we can compare against, so it is refused rather than guessed at.
    const sha = str(r.target_commitish);
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) return null;
    const assets = Array.isArray(r.assets) ? r.assets as Record<string, unknown>[] : [];
    const apk = assets.find((a) => typeof a?.name === "string" && (a.name as string).endsWith(".apk"));
    return {
        sha: sha.toLowerCase(),
        publishedAt: str(r.published_at),
        apkUrl: str(apk?.browser_download_url),
        apkSize: typeof apk?.size === "number" ? apk.size : null,
        apkDigest: str(apk?.digest),
        pageUrl: str(r.html_url),
    };
}

/** The compare JSON (`base...head`, base = this build), as the commits this build is missing; null when malformed. */
export function readCompare(json: unknown): { status: string; aheadBy: number; changes: Change[] } | null {
    if (!json || typeof json !== "object") return null;
    const c = json as Record<string, unknown>;
    const status = str(c.status);
    if (!status || typeof c.ahead_by !== "number") return null;
    const list = Array.isArray(c.commits) ? c.commits as Record<string, unknown>[] : [];
    const changes: Change[] = [];
    for (const x of list) {
        const sha = str(x?.sha);
        const commit = x?.commit as Record<string, unknown> | undefined;
        const message = str(commit?.message);
        if (!sha || !message) continue;
        const at = str((commit?.committer as Record<string, unknown> | undefined)?.date) ?? str((commit?.author as Record<string, unknown> | undefined)?.date);
        changes.push({ sha, ...parseSubject(message), at, url: str(x.html_url) });
    }
    // GitHub lists them oldest first; the screen reads newest first.
    return { status, aheadBy: c.ahead_by, changes: changes.reverse() };
}

/** Whole days from one date to another, rounded down; null when either is missing or unreadable. */
export function daysBetween(from: string | null, to: string | null): number | null {
    const a = from ? Date.parse(from) : NaN, b = to ? Date.parse(to) : NaN;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.max(0, Math.floor((b - a) / DAY_MS));
}

type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
    ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>;
}>;

/** The words a failed response earns, and when to come back for a rate limit. */
function failure(res: { status: number; headers: { get(name: string): string | null } }, what: string, nowMs: number): UpdateCheck {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
        const retryAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : nowMs + 3600_000;
        return { state: "failed", checkedAt: nowMs, error: "GitHub's limit for this network is used up for the hour.", retryAt };
    }
    if (res.status === 404) return { state: "failed", checkedAt: nowMs, error: `GitHub has no ${what}.` };
    return { state: "failed", checkedAt: nowMs, error: `GitHub answered ${res.status} for the ${what}.` };
}

/**
 * Ask GitHub whether a newer build is out. Two requests at most: the release (which commit is newest) and, only when that
 * is not this build, the compare (how many commits and which). Never throws: a network error is a `failed` check.
 */
export async function checkForUpdate(build: BuildInfo, fetch: Fetch, nowMs: number, signal?: AbortSignal): Promise<UpdateCheck> {
    const off = updateOff(build, true);
    if (off) return { state: "failed", checkedAt: nowMs, error: off === "no-repo" ? "This build does not name a repository." : "This build does not know its commit." };
    const base = build.api.replace(/\/+$/, "");
    const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
    try {
        const r = await fetch(`${base}/repos/${build.repo}/releases/tags/${encodeURIComponent(build.tag)}`, { headers, signal });
        if (!r.ok) return failure(r, `"${build.tag}" release`, nowMs);
        const release = readRelease(await r.json());
        if (!release) return { state: "failed", checkedAt: nowMs, error: `The "${build.tag}" release does not name the commit it was built from.` };
        const mine = build.sha!.toLowerCase();
        if (release.sha.startsWith(mine) || mine.startsWith(release.sha)) return { state: "current", checkedAt: nowMs, release };
        const c = await fetch(`${base}/repos/${build.repo}/compare/${mine}...${release.sha}`, { headers, signal });
        // 404: GitHub does not know this build's commit (a local commit, or main was rewritten since).
        if (c.status === 404) return { state: "elsewhere", checkedAt: nowMs, release };
        if (!c.ok) return failure(c, "comparison", nowMs);
        const cmp = readCompare(await c.json());
        if (!cmp) return { state: "failed", checkedAt: nowMs, error: "GitHub's comparison came back in a shape this app does not read." };
        // "behind": the release is OLDER than this build (it is being rebuilt); "identical" cannot happen past the check
        // above but means the same thing. Either way there is nothing newer to install.
        if (cmp.status === "behind" || cmp.status === "identical" || cmp.aheadBy === 0) return { state: "current", checkedAt: nowMs, release };
        if (cmp.status !== "ahead") return { state: "elsewhere", checkedAt: nowMs, release };
        const newest = cmp.changes[0]?.at ?? release.publishedAt;
        return { state: "behind", checkedAt: nowMs, release, commits: cmp.aheadBy, days: daysBetween(build.committedAt, newest), changes: cmp.changes };
    } catch (e) {
        if ((e as Error)?.name === "AbortError") return { state: "failed", checkedAt: nowMs, error: "The check was cancelled." };
        return { state: "failed", checkedAt: nowMs, error: "Could not reach GitHub." };
    }
}

/** "23 changes behind, 7 days old": how far behind a build is, in the words every surface uses. It finishes a
 *  sentence about the build ("This phone's build is …"), and says nothing of days it does not know. */
export function behindWords(c: Extract<UpdateCheck, { state: "behind" }>): string {
    const n = `${c.commits} change${c.commits === 1 ? "" : "s"} behind`;
    if (c.days === null) return n;
    return `${n}, ${c.days === 0 ? "made today" : `${c.days} day${c.days === 1 ? "" : "s"} old`}`;
}

/** The changes grouped the way the screen lists them, features first. */
export function groupChanges(changes: readonly Change[]): { kind: Change["kind"]; title: string; changes: Change[] }[] {
    const titles = { feat: "New", fix: "Fixed", other: "Other changes" } as const;
    return (["feat", "fix", "other"] as const)
        .map((kind) => ({ kind, title: titles[kind], changes: changes.filter((c) => c.kind === kind) }))
        .filter((g) => g.changes.length);
}

/** The inbox item a newer build earns, keyed by the newest commit so putting it away lasts until the NEXT build. A
 *  suggestion: an old build still works, so it never claims to block anything. */
export function updateRow(c: UpdateCheck | null, hidden: ReadonlySet<string> = new Set()): AttentionRow | null {
    if (c?.state !== "behind") return null;
    const key = `app:update:${c.release.sha.slice(0, 12)}`;
    if (hidden.has(key)) return null;
    return {
        key, level: "suggests",
        title: "A newer build of this app is out",
        detail: `This phone's build is ${behindWords(c)}. Open this to see what changed and install the new one.`,
    };
}
