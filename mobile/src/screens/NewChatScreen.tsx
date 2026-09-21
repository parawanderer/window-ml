// NewChatScreen.tsx — STARTING A CHAT: which runtime, which model, and the first message. The chat page's start page
// (src/chat/start-page.tsx) as a phone screen: the runtime and the model as pills at the top, the box filling the rest,
// and what was typed kept until a start succeeds (drafts.ts, under `start`). An agent run needs the tab picker and
// arrives with it.

import { useEffect, useRef, useState } from "react";
import { Keyboard, StyleSheet, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { ArrowUp, ChevronLeft } from "lucide-react-native";
import type { ModelChoice } from "../../../src/session-host";
import { draftOf, saveDraft } from "../drafts";
import { useEmbed } from "../embed";
import { useSessionLayer } from "../layer";
import { SIZE, usePalette } from "../theme";
import { IconButton, Pill, Sheet, SheetRow } from "../ui";
import { AttachButton, AttachedStrip, AttachSheet, useAttachments } from "../attach-ui";

/** The new-chat screen. */
export function NewChatScreen() {
    const p = usePalette();
    const insets = useSafeAreaInsets();
    const nav = useNavigation();
    const e = useEmbed();
    const layer = useSessionLayer();
    const startable = e.runtimes.filter((r) => r.online && r.capabilities.chat && r.grants.some((g) => g.scope !== "view"));
    const [runtimeId, setRuntimeId] = useState(startable[0]?.id ?? "");
    const rt = startable.find((r) => r.id === runtimeId) ?? startable[0];
    const [models, setModels] = useState<ModelChoice[] | null | undefined>(undefined);
    const [model, setModel] = useState("");
    const [text, setText] = useState(() => draftOf("start"));
    const [busy, setBusy] = useState(false);
    const att = useAttachments("start");
    const rtSheet = useRef<BottomSheetModal>(null);
    const modelSheet = useRef<BottomSheetModal>(null);

    useEffect(() => {
        if (!rt) return;
        setModels(undefined);
        void e.models(rt.id).then((m) => {
            setModels(m);
            const usable = (m ?? []).filter((x) => !x.kinds?.includes("embedding"));
            setModel((usable.find((x) => x.default) ?? usable[0])?.id ?? "");
        });
    }, [rt?.id]);

    const start = async () => {
        if (!rt || !text.trim() || busy) return;
        setBusy(true);
        // The images leave the box only once the chat has started: a refusal leaves everything where it was.
        const r = await e.start(rt.id, text.trim(), model || undefined, att.imgs);
        setBusy(false);
        if (r.ok && r.session) { saveDraft("start", ""); setText(""); att.take(); Keyboard.dismiss(); nav.goBack(); layer.open(r.session); }
    };
    const usable = (models ?? []).filter((x) => !x.kinds?.includes("embedding")).sort((a, b) => a.id.localeCompare(b.id));

    return (
        <KeyboardAvoidingView behavior="padding" style={[s.screen, { backgroundColor: p.bg, paddingTop: insets.top }]}>
            <View style={s.bar}>
                <IconButton label="Back" icon={(c) => <ChevronLeft size={26} color={c} />} onPress={() => nav.goBack()} />
                <Text style={[s.barTitle, { color: p.fg }]}>New chat</Text>
            </View>
            {rt ? (
                <>
                    <View style={s.pills}>
                        <Pill text={rt.name} label={`Runtime: ${rt.name}`} onPress={startable.length > 1 ? () => rtSheet.current?.present() : undefined} />
                        {model ? <Pill text={model} mono label={`Model: ${model}`} onPress={() => modelSheet.current?.present()} /> : models === undefined ? <Pill text="…" label="Loading models" /> : null}
                    </View>
                    <TextInput
                        value={text}
                        onChangeText={(t) => { setText(t); saveDraft("start", t); }}
                        placeholder="Start a chat"
                        placeholderTextColor={p.fgFaint}
                        multiline
                        autoFocus
                        style={[s.input, { color: p.fg }]}
                        accessibilityLabel="Message"
                    />
                    <View style={s.strip}><AttachedStrip att={att} /></View>
                    <View style={[s.foot, { paddingBottom: Math.max(insets.bottom, 12) }]}>
                        <AttachButton att={att} style={s.attach} />
                        <IconButton label="Start" filled disabled={!text.trim() || busy || att.picking} onPress={start}
                            icon={(c) => <ArrowUp size={20} color={c} strokeWidth={2.5} />} style={s.send} />
                    </View>
                </>
            ) : (
                <Text style={[s.none, { color: p.fgDim }]}>No runtime this device may start a chat on is online.</Text>
            )}
            <AttachSheet att={att} />
            <Sheet ref={rtSheet} title="Runtime">
                {startable.map((r) => <SheetRow key={r.id} title={r.name} chosen={r.id === rt?.id} onPress={() => { setRuntimeId(r.id); rtSheet.current?.dismiss(); }} />)}
            </Sheet>
            <Sheet ref={modelSheet} title="Model">
                {usable.map((m) => (
                    <SheetRow key={m.id} title={m.id} mono chosen={m.id === model}
                        detail={[m.where === "cloud" ? "cloud" : null, m.kinds?.includes("vision") ? "sees images" : null, m.kinds?.includes("thinking") ? "thinks" : null].filter(Boolean).join(" · ") || undefined}
                        onPress={() => { setModel(m.id); modelSheet.current?.dismiss(); }} />
                ))}
            </Sheet>
        </KeyboardAvoidingView>
    );
}

const s = StyleSheet.create({
    // The screen, under the status bar, shrinking above the keyboard.
    screen: { flex: 1 },
    // Back and the screen's name.
    bar: { flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 6, height: 52 },
    // "New chat".
    barTitle: { fontSize: SIZE.heading, fontWeight: "600" },
    // The runtime and model pills, in a row under the bar.
    pills: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: SIZE.gutter, paddingVertical: 8 },
    // The first message: the rest of the screen, large.
    input: { flex: 1, fontSize: 20, lineHeight: 28, paddingHorizontal: SIZE.gutter, paddingTop: 12, textAlignVertical: "top" },
    // The attached images, above the buttons.
    strip: { paddingHorizontal: 12 },
    // The attach button at the left, the start button at the right.
    foot: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 12, paddingTop: 8 },
    // The attach button: a plain circle.
    attach: { width: 48, height: 48, borderRadius: 24 },
    // The start button: a filled circle.
    send: { width: 48, height: 48, borderRadius: 24 },
    // Nothing to start on: why.
    none: { padding: SIZE.gutter, fontSize: SIZE.text, lineHeight: 22 },
});
