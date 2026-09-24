// session-actions.tsx — WHAT CAN BE DONE WITH ONE SESSION, as a bottom sheet: stop its run, look at its page, pin,
// rename, copy its id, delete. The open session's ⋮ (layer.tsx) and a long press on a list row (ListScreen.tsx) show
// this same sheet, each with the page's `SessionChrome` for that session, so what is offered follows the page's rules
// and never the app's guess.

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import type { SessionChrome } from "../../src/native/bridge";
import { useEmbed } from "./embed";
import { SIZE, usePalette } from "./theme";
import { Sheet, SheetFilter, SheetRow } from "./ui";

/** The sheet's handle: show it. */
export interface SessionActionsHandle { present(): void }

/**
 * The session's actions sheet. `chrome` is the page's word on what this device may do with it; `onOpen` adds "Open"
 * (the list's sheet: the session is not open yet); `onDeleted` runs once the runtime has deleted it; `onResume` adds
 * "Resume on a page" where the page says the run can be.
 */
export const SessionActions = forwardRef<SessionActionsHandle, { chrome: SessionChrome | null; onOpen?: () => void; onDeleted?: () => void; onResume?: () => void }>(
    function SessionActions({ chrome: c, onOpen, onDeleted, onResume }, ref) {
        const e = useEmbed();
        const p = usePalette();
        const sheet = useRef<BottomSheetModal>(null);
        // Renaming happens IN the sheet, not in an alert: Alert.prompt is iOS-only, and a sheet keeps the title in view.
        const [naming, setNaming] = useState<string | null>(null);
        const [busy, setBusy] = useState(false);
        const [peeking, setPeeking] = useState(false);
        // Choosing an export format swaps the sheet's contents, like renaming does: a second sheet over the first is
        // two dismissals deep for one decision.
        const [picking, setPicking] = useState(false);
        useImperativeHandle(ref, () => ({ present: () => { setNaming(null); setPicking(false); sheet.current?.present(); } }), []);
        const close = () => { sheet.current?.dismiss(); setNaming(null); setPicking(false); };

        const pin = async () => {
            if (!c) return;
            close();
            void Haptics.selectionAsync();
            await e.pin(c.key, !c.pinned);   // a refusal arrives as a notice from the page, in its words
        };
        const rename = async () => {
            if (!c || naming == null || !naming.trim()) return;
            setBusy(true);
            const r = await e.rename(c.key, naming.trim());
            setBusy(false);
            if (r.ok) close();
        };
        // Deleting is asked first, in the platform's own confirmation, because it cannot be taken back from here.
        const remove = () => {
            if (!c) return;
            Alert.alert("Delete this session?", `“${c.title}” is deleted on ${c.runtimeName}, for every device.`, [
                { text: "Keep it", style: "cancel" },
                { text: "Delete", style: "destructive", onPress: () => { close(); void e.remove(c.key).then((r) => { if (r.ok) onDeleted?.(); }); } },
            ]);
        };
        // The capture opens full size when it arrives; a refusal (the tab is in the background, say) is the page's notice.
        const peek = async () => {
            if (!c) return;
            setPeeking(true);
            const r = await e.peek(c.key);
            setPeeking(false);
            if (r.ok) close();
        };
        // The file is written by the PAGE, with the same code every other surface exports with, and arrives back as a
        // share sheet. No PDF: that format is really a print dialog, and a WebView has none.
        const exportAs = (format: "md" | "json") => {
            if (!c) return;
            close();
            void Haptics.selectionAsync();
            void e.exportSession(c.key, format);
        };
        // THE HASH, not the key. `key` is `runtime:hash`, which names the session to THIS client and to nothing else:
        // pasted into `ml.resumeChat` or a `#/s/` link on the machine itself, the runtime prefix is wrong. The whole
        // hash, too, never the eight characters a row shows — shown short, copied whole, as the page's `Hash` has it.
        // Split on the LAST colon, because a runtime id may contain one.
        const copyId = () => {
            if (!c) return;
            close();
            void Clipboard.setStringAsync(c.key.slice(c.key.lastIndexOf(":") + 1)).then(() => Haptics.selectionAsync());
        };

        return (
            <Sheet ref={sheet}>
                {c && naming != null ? <>
                    <Text style={[s.title, { color: p.fg }]}>Rename this session</Text>
                    <Text style={[s.sub, { color: p.fgDim }]}>Every device shows the new title: the runtime keeps it.</Text>
                    <View style={s.renameBox}>
                        <SheetFilter plain value={naming} onChangeText={setNaming} placeholder="Session title" />
                    </View>
                    <SheetRow title={busy ? "Saving…" : "Save"} disabled={busy || !naming.trim() || naming.trim() === c.title} onPress={() => void rename()} />
                    <SheetRow title="Cancel" onPress={() => setNaming(null)} />
                </> : c && picking ? <>
                    <Text style={[s.title, { color: p.fg }]}>Export this chat</Text>
                    <Text style={[s.sub, { color: p.fgDim }]}>The file opens in the share sheet, to send or keep.</Text>
                    <SheetRow title="Markdown" detail="readable, screenshots as files" onPress={() => exportAs("md")} />
                    <SheetRow title="JSON" detail="every field, for a program" onPress={() => exportAs("json")} />
                    <SheetRow title="Cancel" onPress={() => setPicking(false)} />
                </> : c ? <>
                    <Text style={[s.title, { color: p.fg }]}>{c.title}</Text>
                    <Text style={[s.sub, { color: p.fgDim }]}>{c.kind === "agent" ? "Agent" : "Chat"} on {c.runtimeName}{c.pinned ? " · pinned" : ""}</Text>
                    {onOpen ? <SheetRow title="Open" onPress={() => { close(); onOpen(); }} /> : null}
                    {c.running && c.canSend ? <SheetRow title="Stop this run" danger onPress={() => { close(); e.cancel(c.key); }} /> : null}
                    {c.canResume && onResume ? <SheetRow title="Resume on a page" detail="Its tab has closed: pick the run back up on another" onPress={() => { close(); onResume(); }} /> : null}
                    {c.canPeek ? <SheetRow title={peeking ? "Capturing…" : "Look at the page"} detail="The page this run is on, as it is now" disabled={peeking} onPress={() => void peek()} /> : null}
                    {c.canPin ? <SheetRow title={c.pinned ? "Unpin" : "Pin"} detail={c.pinned ? undefined : "Kept on the runtime, never expired or evicted"} onPress={() => void pin()} /> : null}
                    {c.canRename ? <SheetRow title="Rename" onPress={() => setNaming(c.title)} /> : null}
                    {/* Only for the session that is OPEN: the file is written from the transcript the page holds, and
                        the list's sheet is about one it has not loaded. `onOpen` is what tells the two sheets apart. */}
                    {onOpen ? null : <SheetRow title="Export chat" detail="Markdown or JSON, to the share sheet" onPress={() => setPicking(true)} />}
                    <SheetRow title="Copy session id" onPress={copyId} />
                    {c.canDelete ? <SheetRow title="Delete" danger onPress={remove} /> : null}
                </> : null}
            </Sheet>
        );
    },
);

const s = StyleSheet.create({
    // The sheet's first line: the session's title in full.
    title: { fontSize: SIZE.heading, fontWeight: "700", paddingHorizontal: 12, paddingTop: 4 },
    // Under it: what kind of session, on which runtime.
    sub: { fontSize: SIZE.small, paddingHorizontal: 12, paddingTop: 4, paddingBottom: 12 },
    // The rename field, inset like the sheet's rows.
    renameBox: { paddingTop: 12 },
});
