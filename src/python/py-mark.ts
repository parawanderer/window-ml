// py-mark.ts — the OUTSIDE MARK: once a cell has run outside the read-only Python dialect in a sandbox, no later cell
// there is tried inside it (docs/spec/PYTHON_DIALECT.md, "What an inside run may leave behind is data, never code").

// An approved cell is full Python in the interpreter a later inside cell runs in. It can rewrite a function the gate
// admits by identity (`pd.DataFrame.head.__code__`), or any Python callee such a function reaches
// (`_iLocIndexer.__getitem__`), and the gate's lifted call then runs that code ungated in a cell nobody was asked about.
// So the offscreen document marks the worker before it posts an outside cell, and answers every later inside post to
// that worker itself, with one of these refusals: the worker never sees the try. A fresh worker is unmarked.

/** The inside try's refusal from a marked worker, the first time it is answered in that worker: the model is told why. */
export const MARKED_FIRST = "marked: an earlier cell ran outside the dialect in this sandbox";
/** The same refusal on every later inside post to that worker: the card says it, the model was already told. */
export const MARKED_AGAIN = "marked again: an earlier cell ran outside the dialect in this sandbox";

/** The approval card's line for a cell that asks only because of the mark. */
export const MARKED_CARD_LINE = "Asks because an earlier approved cell could have changed what this one runs";
/** What the model reads with the result of the first such cell in a worker; later ones add nothing. */
export const MARKED_MODEL_LINE = "An earlier cell ran outside the read-only Python dialect in this sandbox, so every later cell asks until it restarts.";

/**
 * Whether a refusal is the mark's, and whether it is the first in its worker.
 * @param why the inside try's refusal
 * @returns "first", "again", or null for any other refusal
 */
export function markedRefusal(why: string | undefined): "first" | "again" | null {
    return why === MARKED_FIRST ? "first" : why === MARKED_AGAIN ? "again" : null;
}

/**
 * EVERY KIND OF MESSAGE the offscreen document posts to a Python worker, and whether it runs code a cell supplied, ungated:
 * the mark is set before posting each one that does (docs/dev/python-sandbox.md, "The outside mark"). An enumeration, not
 * an exclusion: a kind not listed here marks (`postMarks`), so a new message is safe before anyone classifies it.
 * Listed in the order the worker dispatches them (python-worker.ts `onMessage`), and a test holds both to each other.
 */
export const WORKER_POSTS = {
    /** an `ml` wire call's answer, data for a pending call */
    mlAnswer: false,
    /** the interrupt buffer, once, before the runtime starts */
    interruptBuffer: false,
    /** the `/files` mount's shared buffers, once, before the runtime starts */
    filesShared: false,
    /** the idle reap's hand-over of what fired since the last cell */
    takeDropped: false,
    /** drop a run's kept namespace */
    deleteRun: false,
    /** start the runtime early; runs no cell */
    prewarm: false,
    /** the harness's own reading of the interpreter (versions, packages) */
    env: false,
    /** a completion: the editor's analysis of a cell's source (jedi), which may import the modules it names */
    complete: true,
    /** a tier 3 library's shape or load: the person approved it, and its shape rule admits only data and gated imports */
    library: false,
    /** throw away the bench's kept namespace */
    benchReset: false,
    /** a cell INSIDE the dialect: the fork's gate runs it */
    inside: false,
    /** a cell outside the dialect (an approved one, the bench's, a page's, an install candidate's): full Python */
    run: true,
} as const satisfies Record<string, boolean>;

/** One of {@link WORKER_POSTS}' kinds, or "unknown" for a message the table does not describe. */
export type WorkerPostKind = keyof typeof WORKER_POSTS | "unknown";

/** Every field a worker message may carry: one outside this set makes the message "unknown", which marks. */
export const KNOWN_FIELDS: ReadonlySet<string> = new Set([
    "id", "mlAnswer", "interruptBuffer", "filesShared", "filesHome", "takeDropped", "deleteRun", "prewarm", "env", "complete", "library",
    "libraries", "benchReset", "inside", "code", "image", "hardened", "tables", "stream", "wire", "run", "persist", "bridges", "wheels",
]);

/**
 * Which kind of worker message this is, by the field the worker dispatches on, in the worker's own order.
 * @param msg the message about to be posted
 * @returns its kind
 */
export function workerPostKind(msg: Record<string, unknown>): WorkerPostKind {
    if (!msg || typeof msg !== "object" || Object.keys(msg).some((k) => !KNOWN_FIELDS.has(k))) return "unknown";
    // Each early return as the worker takes it: an answer only with a numeric seq, a buffer only with no id (with one, a
    // buffer the worker already holds falls through to the run below).
    const answer = msg.mlAnswer as { seq?: unknown } | undefined;
    if (answer && typeof answer === "object" && typeof answer.seq === "number") return "mlAnswer";
    const noId = typeof msg.id !== "number";
    if (msg.interruptBuffer && noId) return "interruptBuffer";
    if (msg.filesShared && noId) return "filesShared";
    if (noId) return "unknown";
    if (msg.takeDropped === true) return "takeDropped";
    if (typeof msg.deleteRun === "string" && msg.deleteRun) return "deleteRun";
    if (msg.prewarm) return "prewarm";
    if (msg.env) return "env";
    if (msg.complete) return "complete";
    if (msg.library) return "library";
    if (msg.benchReset) return "benchReset";
    return msg.inside === true ? "inside" : "run";
}

/**
 * Whether posting this message marks its worker: its kind runs cell-supplied code ungated, or the table does not know it.
 * @param msg the message about to be posted
 * @returns true when the worker is marked before the post
 */
export function postMarks(msg: Record<string, unknown>): boolean {
    const kind = workerPostKind(msg);
    return kind === "unknown" || WORKER_POSTS[kind];
}
