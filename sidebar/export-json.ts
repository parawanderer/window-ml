/**
 * @file JSON export — the machine-readable run format.
 *
 * Unlike the markdown and PDF exports, this does NOT walk the session through a `Sink`.
 * The sink vocabulary is presentational, so a sink-shaped JSON would encode our layout
 * decisions rather than the run. This serializes the `Session` directly.
 *
 * The shape is specified in `export-schema.ts`; the reasoning is in
 * `docs/spec/PROGRAMMATIC_EXPORT.md`.
 */

import type { Session, Turn, AgentStep } from "./store";
import { turnsRun } from "./store";
import type { TokenUsage } from "../contract";
import type {
    ExportDocument, ExportSession, ExportStep, ExportMessage,
    ExportOutcome, ExportTotals, ExportModelUsage, ExportStatus, IsoTimestamp,
} from "./export-schema";
import { EXPORT_SCHEMA_VERSION } from "./export-schema";

/** Epoch ms → ISO 8601. Invalid/absent stamps are dropped rather than exported as an
 *  epoch-zero date, which would read as a real 1970 timestamp to a consumer. */
function iso(ts: number | undefined | null): IsoTimestamp | undefined {
    if (!ts || !Number.isFinite(ts)) return undefined;
    return new Date(ts).toISOString();
}

/** Drop keys whose value is undefined, so an absent field is absent rather than `null`
 *  or `undefined` (which `JSON.stringify` would omit anyway — this keeps the object
 *  itself honest for tests and for anything that inspects it before stringifying).
 *  Insertion order is preserved, which is what makes two exports of one session diff
 *  cleanly. */
function compact<T extends object>(obj: T): T {
    const out = {} as T;
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
    return out;
}

/** A step that never completed (still pending, or waiting at an approval gate) is live
 *  UI state, not a record of what happened. */
function isRecorded(st: AgentStep): boolean {
    return !st.pending && !st.awaitingApproval;
}

function stepToJson(st: AgentStep): ExportStep {
    return compact<ExportStep>({
        step: st.step,
        localStep: st.localStep,
        seq: st.seq ?? st.step,
        at: iso(st.ts),
        durationMs: st.toolMs,
        thought: st.thought,
        reasoning: st.reasoning ?? undefined,

        tool: st.tool,
        arguments: st.arguments,
        argIssues: st.argIssues?.length ? st.argIssues : undefined,

        result: st.result,
        // Only when it differs: identical copies would double an export's size for no
        // information. The raw-view rule is satisfied either way — when this is absent,
        // `result` IS what the model saw.
        modelResult: st.modelResult && st.modelResult !== st.result ? st.modelResult : undefined,
        streamOutput: st.streamOutput,
        streamMarks: st.streamMarks,
        token: st.token,

        approval: st.approval,
        grants: st.grants?.length ? st.grants : undefined,
        reused: st.reused?.length ? st.reused : undefined,

        elements: st.elements,
        renderIn: st.renderIn,
        renderOut: st.renderOut,
        feedback: st.feedback,

        usage: st.usage ?? undefined,
        subUsage: st.subUsage,
    });
}

/** A chat turn becomes two messages, so `messages` reads uniformly for both kinds. */
function turnToMessages(t: Turn): ExportMessage[] {
    const out: ExportMessage[] = [compact<ExportMessage>({
        role: "user",
        text: t.user,
        at: iso(t.ts) || new Date(0).toISOString(),
        images: t.images?.length ? t.images : undefined,
    })];

    // A turn with no reply yet (in flight, or it errored before answering) contributes
    // only the user half — an empty assistant message would read as "it said nothing".
    if (t.assistant !== undefined || t.error) {
        out.push(compact<ExportMessage>({
            role: "assistant",
            text: t.assistant ?? "",
            at: iso(t.ts) || new Date(0).toISOString(),
            model: t.model ?? undefined,
            extend: t.extend ?? undefined,
            reasoning: t.reasoning ?? undefined,
            sources: t.sources?.length ? t.sources : undefined,
            usage: t.usage ?? undefined,
            error: t.error,
            status: t.status as ExportStatus,
        }));
    }
    return out;
}

/**
 * An agent session's conversation: the initial task, follow-up `say`s, and each turn's
 * answer, in the order they happened.
 *
 * Ordering mirrors the markdown walker: by step position, then timestamp. At the same
 * step (a turn that ran no tools keeps the prior count) time is authoritative, and only
 * an exact tie falls back to answer-before-say.
 */
function agentMessages(s: Session): ExportMessage[] {
    const says = (s.says || []).map(x => ({
        pos: x.atStep || 0, ts: x.ts, isSay: true,
        msg: compact<ExportMessage>({
            role: "user" as const, text: x.text, at: iso(x.ts) || new Date(0).toISOString(),
            atStep: x.atStep, images: x.images?.length ? x.images : undefined,
        }),
    }));
    const answers = (s.answers || []).map(a => ({
        pos: a.atStep || 0, ts: a.ts, isSay: false,
        msg: compact<ExportMessage>({
            role: "assistant" as const, text: a.text, at: iso(a.ts) || new Date(0).toISOString(),
            atStep: a.atStep, status: a.status as ExportStatus, error: a.error,
        }),
    }));

    const inter = [...says, ...answers].sort((a, b) =>
        (a.pos - b.pos) || (a.ts - b.ts) || ((a.isSay ? 1 : 0) - (b.isSay ? 1 : 0)));

    // An older session (or one still in flight) recorded no per-turn answers; the task
    // and final summary are then the whole conversation.
    if (!says.length && s.task) {
        inter.unshift({
            pos: 0, ts: s.createdTs, isSay: true,
            msg: compact<ExportMessage>({
                role: "user", text: s.task, at: iso(s.createdTs) || new Date(0).toISOString(),
                atStep: 0, images: s.taskImages?.length ? s.taskImages : undefined,
            }),
        });
    }
    const msgs = inter.map(x => x.msg);
    if (!answers.length && (s.summary || s.answer)) {
        msgs.push(compact<ExportMessage>({
            role: "assistant", text: s.answer || s.summary || "",
            at: iso(s.lastTs) || new Date(0).toISOString(),
            status: s.status as ExportStatus, error: s.error,
        }));
    }
    return msgs;
}

/** Sum a run's own model calls, keeping a per-model breakdown so a sweep can attribute
 *  cost when a run used several (a driver plus a utility reader). */
function totals(s: Session, steps: ExportStep[], msgs: ExportMessage[]): ExportTotals {
    const byModel = new Map<string, ExportModelUsage>();
    let tokensIn = 0, tokensOut = 0, subcallTokens = 0;

    const add = (model: string | undefined, u: TokenUsage | undefined) => {
        if (!u) return;
        tokensIn += u.promptTokens || 0;
        tokensOut += u.completionTokens || 0;
        const key = model || "(unknown)";
        const e = byModel.get(key) || { model: key, calls: 0, tokensIn: 0, tokensOut: 0 };
        e.calls++;
        e.tokensIn += u.promptTokens || 0;
        e.tokensOut += u.completionTokens || 0;
        byModel.set(key, e);
    };

    for (const st of steps) {
        add(s.model ?? undefined, st.usage);
        if (st.subUsage) subcallTokens += (st.subUsage.prompt || 0) + (st.subUsage.completion || 0);
    }
    // A chat session has no steps; its usage rides the assistant messages.
    if (!steps.length) for (const m of msgs) if (m.role === "assistant") add(m.model, m.usage);

    return {
        steps: steps.length,
        tokensIn,
        tokensOut,
        subcallTokens,
        wallMs: Math.max(0, (s.lastTs || 0) - (s.createdTs || 0)),
        byModel: [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model)),
    };
}

function outcome(s: Session, isAgent: boolean): ExportOutcome {
    return compact<ExportOutcome>({
        status: s.status as ExportStatus,
        hitCap: !!s.hitCap,
        cancelled: !!s.cancelled,
        resumed: !!s.resumed,
        error: s.error ?? null,
        turnsRun: isAgent ? turnsRun(s.steps) : undefined,
        maxSteps: isAgent ? s.maxSteps : undefined,
    });
}

/**
 * Serialize a session to the published export shape.
 *
 * @param {Session} s The session to export, as the sidebar holds it.
 * @param {string} [version] The extension version, for provenance.
 * @returns {ExportDocument} The document; stringify it to produce the `.json` file.
 */
export function sessionToJson(s: Session, version?: string): ExportDocument {
    const isAgent = s.kind === "agent";

    const steps = (s.steps || []).filter(isRecorded).map(stepToJson)
        .sort((a, b) => a.seq - b.seq);
    const messages = isAgent
        ? agentMessages(s)
        : (s.turns || []).flatMap(turnToMessages);

    const session: ExportSession = compact<ExportSession>({
        hash: s.hash,
        kind: isAgent ? "agent" : "chat",
        title: s.title,
        createdAt: iso(s.createdTs) || new Date(0).toISOString(),
        lastAt: iso(s.lastTs) || new Date(0).toISOString(),
        model: s.model ?? undefined,
        config: isAgent ? s.agentConfig : s.config,
        task: s.task,
        taskImages: s.taskImages?.length ? s.taskImages : undefined,
        outcome: outcome(s, isAgent),
        totals: totals(s, steps, messages),
        messages,
        steps: isAgent ? steps : undefined,
    });

    return {
        schema: EXPORT_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        generator: compact({ name: "window.ml", version }),
        session,
    };
}

/** The document as a `.json` file body: 2-space indent, so a human can read a diff. */
export function serializeSessionJson(s: Session, version?: string): string {
    return JSON.stringify(sessionToJson(s, version), null, 2) + "\n";
}
