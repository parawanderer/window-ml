// status-words.ts — the words a session's status is said in, shared by the session list and the summary page.

import type { SessionStatus } from "../session/session-host";

/** What each status says in a list, where the dot alone would not tell a waiting run from a working one. */
export const STATUS_LABEL: Partial<Record<SessionStatus, string>> = { waiting: "waiting on you", capped: "stopped at its step cap", cancelled: "cancelled", interrupted: "interrupted", error: "failed" };

/** A session's pending approvals, as the one badge that replaces the `waiting` label. PENDING rather than a bare
 *  count, because "1" beside a title reads as a fact about the run rather than as something waiting on the reader —
 *  and without the word "approval", which the badge's colour and its place in a list of runs already say, and which
 *  a phone's row has no width for. The phone's list (mobile/src/screens/ListScreen.tsx) words it the same. */
export const approvalsPending = (n: number): string => `${n} pending`;
