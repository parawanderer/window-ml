// pkg-card-view.tsx — python_install's card: every file the install would fetch, as rows with the full sha256, or why the package cannot be installed.

// The rows are the ones the worker froze (src/python/pkg-card.ts), and an approval carries them back to be compared
// field by field. Every string came from an index or the lock: each is drawn as a text node, with a control, bidi or
// invisible character replaced by U+FFFD and listed beside its field (`shownText`), so a name cannot pose as another.

import type { PkgCard, PkgRow } from "../../contract/contract-render";
import { shownText } from "../../python/pkg-card";
import { formatBytes } from "../../resource/resource-model";

/** One field of a row: the text with hidden characters replaced, and those characters listed beside it. */
function Field({ cls, text }: { cls: string; text: string }) {
    const s = shownText(text);
    return <span class={cls}>{s.text}{s.hidden.length ? <span class="pkg-escaped">{s.hidden.join(" ")}</span> : null}</span>;
}

/** One file of the closure. */
function Row({ r }: { r: PkgRow }) {
    return (
        <div class="pkg-row" data-source={r.source}>
            <Field cls="pkg-name" text={r.name} />
            <Field cls="pkg-version" text={r.version} />
            <Field cls="pkg-file" text={r.filename} />
            <span class="pkg-size">{r.size === null ? "in the core" : formatBytes(r.size)}</span>
            <span class="pkg-source">{r.source === "lock" ? "Pyodide" : r.source === "mirror" ? "PyPI, held" : "PyPI"}</span>
            <span class="pkg-sha">{r.sha256}</span>
        </div>
    );
}

/** What a refusal reason means, in the card's words. */
const REFUSED: Record<string, string> = {
    "no-build": "has no build this sandbox can run",
    "python-version": "does not support this sandbox's Python",
    "lock-too-old": "needs a newer version of a package the sandbox ships",
    "not-on-index": "is not available to install here",
    "too-large": "is too large to install",
    "malformed": "has metadata that does not check out",
    "no-metadata": "does not say what it depends on",
    "index-error": "could not be looked up on PyPI",
    "lookup-cap": "was not looked up: this run has made all the PyPI lookups it may",
};

/**
 * python_install's card: the files with their hashes and the download total, or the refusal.
 * @group card
 * @gallery {"request": {"name": "attrs"}, "verdict": {"ok": true, "files": [{"name": "attrs", "version": "26.1.0", "filename": "attrs-26.1.0-py3-none-any.whl", "source": "lock", "size": null, "sha256": "b5f2e20d25fbeb55950af8cda6b5ef71d47e60872587d11ab6b6425b0d7c2c92"}, {"name": "six", "version": "1.17.0", "filename": "six-1.17.0-py2.py3-none-any.whl", "source": "lock", "size": null, "sha256": "c6681057bd87fdec57e811b8e4007bad38deea284052817fa400d542c6423e2d"}], "loaded": [], "totalBytes": 0}}
 */
export function PkgCardRender({ request, verdict }: { request: { name: string; version?: string }; verdict: PkgCard }) {
    const asked = request.version ? `${request.name} ${request.version}` : request.name;
    if (!verdict.ok) {
        return (
            <div class="pkg-card pkg-refused">
                <div class="pkg-head"><Field cls="pkg-asked" text={asked} /> cannot be installed: <Field cls="pkg-at" text={verdict.at} /> {REFUSED[verdict.reason] ?? verdict.reason}.</div>
                <div class="pkg-reason">{verdict.reason}</div>
            </div>
        );
    }
    const held = verdict.files.filter((r) => r.source === "mirror").length;
    return (
        <div class="pkg-card">
            <div class="pkg-head">Install <Field cls="pkg-asked" text={asked} />: {verdict.files.length} {verdict.files.length === 1 ? "file" : "files"}, each checked against its hash.</div>
            <div class="pkg-rows">{verdict.files.map((r, i) => <Row key={i} r={r} />)}</div>
            <div class="pkg-total">{verdict.totalBytes ? `${formatBytes(verdict.totalBytes)} to download` : held ? "Nothing to download: every file is in the core or already held" : "Nothing to download: every file is in the core"}{held ? `; ${held} already held, not downloaded again` : ""}</div>
            {verdict.loaded.length ? <div class="pkg-loaded">Already loaded: {verdict.loaded.map((n, i) => <>{i ? ", " : ""}<Field cls="pkg-loaded-name" text={n} /></>)}</div> : null}
        </div>
    );
}

/**
 * Whether a step's card is a refused python_install card, whose footer offers Dismiss alone.
 * @param d the step's renderIn
 * @returns true for a `packages` descriptor whose verdict is a refusal
 */
export function isRefusedPkgCard(d: unknown): boolean {
    return typeof d === "object" && d !== null && (d as { type?: unknown }).type === "packages" && (d as { verdict?: { ok?: unknown } }).verdict?.ok === false;
}

/**
 * The rows a python_install card shows, which its approval carries back; undefined for any other card.
 * @param d the step's renderIn
 * @returns the rows, or undefined
 */
export function pkgCardRows(d: unknown): PkgRow[] | undefined {
    if (typeof d !== "object" || d === null || (d as { type?: unknown }).type !== "packages") return undefined;
    const v = (d as { verdict?: PkgCard }).verdict;
    return v && v.ok ? v.files : undefined;
}
