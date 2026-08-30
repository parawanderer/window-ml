// The TRUSTED-WORLD auto-approve decision for a PRIVILEGED agent tool: may this call skip the human
// gate? `python_exec` is the one privileged tool (full mode = CORS-bypass network via the offscreen
// doc; a sheet source = credentialed Google read), so in design A this decision MUST run where the
// page can't forge it — the background — or a hostile page fakes "it's safe, skip the gate" and gets
// network/credentialed access with no consent. It is deliberately PURE (mode + suspicious-char +
// external-sheet only) so it runs anywhere and is unit-tested standalone (dist/auto-approve.js).
//
// (`exec` is NOT here on purpose: it runs page-context JS, so forging its readonly auto-approve gains
// a hostile page nothing — its readonly-dialect check can stay page-side/delegated.)

import { suspiciousChars } from "./security";
import { externalSheetIds } from "./dom";
import { outputCapEscalated } from "./contract";

export interface AutoApproveConfig { autoApprovePython?: boolean }

/** Decide whether a `python_exec` call may auto-approve (skip the gate). Returns "sandbox" for a
 *  readonly-mode run that's isolated by construction, else null (→ require approval). `isSheetApproved`
 *  is a per-session predicate — a spreadsheet the user already consented to this session. */
export function autoApprovePython(
    args: Record<string, unknown>,
    cfg: AutoApproveConfig,
    isSheetApproved: (spreadsheetId: string) => boolean = () => false,
): "sandbox" | null {
    if (!cfg.autoApprovePython) return null;                                          // feature off
    if ((args as { mode?: unknown }).mode === "full") return null;                    // network → always ask
    if (outputCapEscalated("python_exec", args)) return null;                         // a raised output cap → ask (context spend)
    if (suspiciousChars(String((args as { code?: unknown }).code ?? "")).length) return null;   // hidden/bidi chars → ask
    if (externalSheetIds(args).some(id => !isSheetApproved(id))) return null;         // an un-approved external sheet → ask
    return "sandbox";
}
