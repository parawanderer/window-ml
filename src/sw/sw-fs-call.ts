// sw-fs-call.ts — the worker's side of `ml.fs`: one isolated exec's reads, sent to the offscreen document's reader under the run's session (FILE_ATTACHMENTS.md, "`ml.fs`", "Who may call it").

// The session is the run's, from the worker's own record of the call (sw-run-host.ts), never anything the script says.
// Each exec gets its own channel in the offscreen document (fs-serve.ts), named by a key minted here, so a FileHandle
// lives as long as its exec and no longer. What comes back is the reader's answer or its errno code: an error's text is
// never the offscreen document's, so nothing it read can ride an error into the world.

import { ensureOffscreen } from "./sw-offscreen";
import type { IsoAnswer, IsoFsOp } from "./iso-channel";

/** The one text an `ml.fs` error carries from here; the world builds Node's message from the code (ml-fs.ts). */
export const FS_CALL_FAILED = "ml.fs: the session's files could not be read.";

/** How the worker reaches the offscreen document; replaced in tests. */
export interface FsCallDeps { send: (msg: unknown) => Promise<unknown> }

const defaultDeps: FsCallDeps = { send: async (msg) => { await ensureOffscreen(); return chrome.runtime.sendMessage(msg); } };

/**
 * `ml.fs`'s reads for one isolated exec of a run.
 * @param runId the run, whose session the reads are of
 * @param deps how to reach the offscreen document
 * @returns `fs`, the iso server's dependency, and `end`, which closes the exec's channel (call it when the exec ends)
 */
export function fsCallFor(runId: string, deps: FsCallDeps = defaultDeps): { fs: (op: IsoFsOp, args: unknown[]) => Promise<IsoAnswer>; end: () => void } {
    const key = crypto.randomUUID();
    let used = false;
    return {
        async fs(op, args) {
            used = true;
            let r: unknown;
            try { r = await deps.send({ type: "FS_CALL", key, session: runId, op, args }); } catch { return { error: FS_CALL_FAILED, code: "EIO" }; }
            if (r && typeof r === "object" && "ok" in r) return { ok: (r as { ok: unknown }).ok };
            const code = (r as { code?: unknown } | null)?.code;
            return { error: FS_CALL_FAILED, code: typeof code === "string" && /^E[A-Z]+$/.test(code) ? code : "EIO" };
        },
        end() {
            if (used) deps.send({ type: "FS_END", key }).catch(() => undefined);
        },
    };
}
