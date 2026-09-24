// resume.tsx — PICKING A SAVED RUN BACK UP ON A PAGE, when the tab it ran on has closed (`SessionChrome.canResume`, the
// page's `resumableHere`). The runtime's tabs in the new-agent screen's own sheet (tab-sheet.tsx), led by what a resume
// does NOT carry over, said before it happens as the page's resume form says it. Picking a tab, or a new one at the
// runtime's start page, resumes: the same run, keeping its hash and its history.

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import * as Haptics from "expo-haptics";
import type { SessionChrome } from "../../src/native/bridge";
import { useEmbed } from "./embed";
import { TabSheet, type TabList } from "./tab-sheet";
// The SAME reading the chat page makes of the runtime's answer (src/chat/blank-start.ts): a resume lands on a page
// like any other run, so a machine that may not open the blank one cannot resume onto it either.
import { blankBlockedReason, blankStartState } from "../../src/chat/blank-start";

/** The sheet's handle: show it for a session. */
export interface ResumeHandle { present(): void }

/** What a resume loses, as the page's resume form words it. */
const LOST = "It carries on from what it had said, on the page you pick. It does not carry over live references to elements on the old page, that page's state, cached fetches, tools a page script defined, or approval grants: those are asked again.";

/** The resume sheet for `chrome`'s session. */
export const ResumeSheet = forwardRef<ResumeHandle, { chrome: SessionChrome | null }>(function ResumeSheet({ chrome: c }, ref) {
    const e = useEmbed();
    const sheet = useRef<BottomSheetModal>(null);
    const [list, setList] = useState<TabList>({ tabs: null, groups: [], withheld: 0 });
    const [busy, setBusy] = useState(false);
    useImperativeHandle(ref, () => ({
        present: () => {
            if (!c) return;
            setList({ tabs: null, groups: [], withheld: 0 });
            sheet.current?.present();
            void e.tabs(c.runtime).then(setList);
        },
    }), [c?.runtime]);
    const pick = async (where: number | "blank") => {
        if (!c || busy) return;
        setBusy(true);
        // A refusal is the page's notice, in its words; the sheet stays so another page can be picked.
        const r = await e.resumeRun(c.key, where === "blank" ? { kind: "blank" } : { kind: "tab", tabId: where });
        setBusy(false);
        if (r.ok) { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); sheet.current?.dismiss(); }
    };
    // A phone can never grant a permission on the machine the run would go to, so `canGrant` is false by construction.
    // This is the case with nowhere left to go: a run whose tab has closed, on a runtime with no tabs and no site
    // access. Saying so on the row beats taking the tap and failing after it.
    const rt = e.runtimes.find((r) => r.id === c?.runtime);
    const why = blankBlockedReason(blankStartState(rt, false));
    return <TabSheet ref={sheet} list={list} value={null} title={busy ? "Resuming…" : "Resume this run on…"} lede={LOST}
        blankDetail="At the runtime's start page" blankBlocked={why} onPick={(w) => void pick(w)} />;
});
