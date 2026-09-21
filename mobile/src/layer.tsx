// layer.tsx — THE OPEN SESSION, as a layer that slides over the navigation stack instead of a screen pushed onto it. It
// holds the app's ONE WebView (embed.tsx), which must never remount: a pushed screen would create a new one on every
// open, reloading the page and reconnecting to the hub. The layer is mounted once and slides in and out; the edge swipe
// and Android's back close it, as they would a pushed screen.
//
// Around the transcript it draws the native chrome the page reports (`SessionChrome`): a header with the way back, the
// model as a pill (a sheet of the runtime's models to switch to), and a menu; the "waiting on you" bar; and the composer,
// whose drafts survive a failed send (drafts.ts).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, BackHandler, Keyboard, Platform, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { ArrowUp, ChevronDown, ChevronLeft, EllipsisVertical, Square } from "lucide-react-native";
import type { ModelChoice } from "../../src/session-host";
import { draftOf, onDraftRestored, saveDraft, sendHeld } from "./drafts";
import { EmbedWebView, useEmbed } from "./embed";
import { SIZE, usePalette } from "./theme";
import { IconButton, Sheet, SheetFilter, SheetRow } from "./ui";

/** Opening and closing the session layer, from any screen. */
interface LayerApi { key: string | null; open(key: string, approval?: boolean): void; close(): void }
const LayerContext = createContext<LayerApi>({ key: null, open: () => {}, close: () => {} });

/** The layer's controls, for a screen that opens a session. */
export const useSessionLayer = (): LayerApi => useContext(LayerContext);

/** Provides the layer's state; render `<SessionLayer />` once inside it, above the navigation stack. */
export function SessionLayerProvider({ children }: { children: ReactNode }) {
    const [key, setKey] = useState<string | null>(null);
    const e = useEmbed();
    const api = useMemo<LayerApi>(() => ({
        key,
        open: (k, approval) => { setKey(k); e.open(k, approval); },
        close: () => { setKey(null); Keyboard.dismiss(); },
    }), [key, e]);
    return <LayerContext.Provider value={api}>{children}</LayerContext.Provider>;
}

/** How far a swipe must travel, as a share of the width, to close the layer. */
const CLOSE_AT = 0.35;

/** The layer itself: always mounted, off-screen to the right while no session is open. */
export function SessionLayer() {
    const p = usePalette();
    const e = useEmbed();
    const layer = useSessionLayer();
    const insets = useSafeAreaInsets();
    const { width } = useWindowDimensions();
    const x = useSharedValue(width);
    const open = layer.key != null;
    const finishClose = useCallback(() => e.close(), [e]);

    useEffect(() => {
        x.value = withTiming(open ? 0 : width, { duration: open ? 320 : 260, easing: Easing.bezier(0.2, 0.9, 0.25, 1) }, (done) => {
            if (done && !open) runOnJS(finishClose)();
        });
    }, [open, width]);
    useEffect(() => {
        if (!open) return;
        const sub = BackHandler.addEventListener("hardwareBackPress", () => { layer.close(); return true; });
        return () => sub.remove();
    }, [open, layer]);

    // The edge swipe: a pan that starts at the left edge drags the layer; let go past `CLOSE_AT` and it closes.
    const pan = Gesture.Pan()
        .activeOffsetX(12)
        .failOffsetY([-14, 14])
        .hitSlop({ left: 0, width: 28 })
        .onUpdate((g) => { x.value = Math.max(0, g.translationX); })
        .onEnd((g) => {
            if (g.translationX > width * CLOSE_AT || g.velocityX > 800) runOnJS(layer.close)();
            else x.value = withTiming(0, { duration: 200 });
        });
    const slide = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
    const shade = useAnimatedStyle(() => ({ opacity: 0.18 * (1 - x.value / width) }));

    const chrome = e.chrome && e.chrome.key === layer.key ? e.chrome : null;
    return (
        <>
            <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: "#000" }, shade]} />
            <GestureDetector gesture={pan}>
                <Animated.View pointerEvents={open ? "auto" : "none"} style={[StyleSheet.absoluteFill, { backgroundColor: p.bg }, slide]}>
                    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
                        <View style={[s.header, { paddingTop: insets.top, backgroundColor: p.bg }]}>
                            <IconButton label="Back to sessions" icon={(c) => <ChevronLeft size={26} color={c} />} onPress={layer.close} />
                            {/* The model, or nothing: the title leads the transcript right under this bar. */}
                            {chrome?.model ? <ModelPill key={chrome.key} /> : null}
                            <View style={{ flex: 1 }} />
                            <SessionMenu />
                        </View>
                        {/* The bar is for a gate several screens down: while the card is on screen it says, louder,
                            what the card right there already says with buttons. */}
                        {chrome && chrome.pendingApprovals > 0 && chrome.approvalOffscreen ? (
                            <Pressable accessibilityRole="button" accessibilityLabel="Show what is waiting on your approval" onPress={() => e.showApproval()}
                                style={({ pressed }) => [s.waiting, { backgroundColor: p.scheme === "dark" ? "#0c2a3a" : "#e0f2fe", opacity: pressed ? 0.7 : 1 }]}>
                                <Text style={[s.waitingText, { color: p.fg }]} numberOfLines={1}>
                                    {chrome.pendingApprovals > 1 ? `${chrome.pendingApprovals} things are waiting on you` : "Waiting on your approval"}
                                </Text>
                                <Text style={[s.waitingGo, { color: p.accent }]}>Show me</Text>
                            </Pressable>
                        ) : null}
                        <View style={{ flex: 1 }}>
                            <EmbedWebView backgroundColor={p.bg} />
                        </View>
                        {chrome ? <Composer key={chrome.key} bottom={insets.bottom} /> : null}
                    </KeyboardAvoidingView>
                </Animated.View>
            </GestureDetector>
        </>
    );
}

/**
 * The session's model in the header: the name itself, bold, with a provider prefix (`litellm.google/`) dimmed in front
 * of it, because the part that says which model this is comes last. No pill: the name IS the heading of this screen.
 */
function ModelName({ id, onPress }: { id: string; onPress?: () => void }) {
    const p = usePalette();
    const cut = id.lastIndexOf("/");
    return (
        <Pressable accessibilityRole="button" accessibilityLabel={`Model: ${id}`} onPress={onPress} disabled={!onPress} hitSlop={8}
            style={({ pressed }) => [s.model, pressed && { opacity: 0.55 }]}>
            <Text numberOfLines={1} style={[s.modelText, { color: p.fg }]}>
                {cut > 0 ? <Text style={[s.modelPrefix, { color: p.fgFaint }]}>{id.slice(0, cut + 1)}</Text> : null}{cut > 0 ? id.slice(cut + 1) : id}
            </Text>
            {onPress ? <ChevronDown size={16} color={p.fgDim} /> : null}
        </Pressable>
    );
}

/** The session's model, as a pill: tap for the runtime's models, and switch to one. */
function ModelPill() {
    const e = useEmbed();
    const sheet = useRef<BottomSheetModal>(null);
    const [models, setModels] = useState<ModelChoice[] | null | undefined>(undefined);
    const [q, setQ] = useState("");
    const c = e.chrome!;
    const show = () => {
        sheet.current?.present();
        if (models === undefined) void e.models(c.runtime).then((m) => setModels(m));
    };
    const pick = (id: string) => {
        sheet.current?.dismiss();
        if (id !== c.model && c.canSwitchModel) { void Haptics.selectionAsync(); e.switchModel(c.key, id); }
    };
    const all = (models ?? []).filter((m) => !m.kinds?.includes("embedding")).sort((a, b) => a.id.localeCompare(b.id));
    // A box can offer fifty models, which is a lot of thumb: filter once there are more than a screenful.
    const filtered = q.trim() ? all.filter((m) => m.id.toLowerCase().includes(q.trim().toLowerCase())) : all;
    return (
        <>
            <ModelName id={c.model ?? ""} onPress={show} />
            <Sheet ref={sheet} title="Model" note={c.switchNote} tall={all.length > 8}
                header={all.length > 8 ? <SheetFilter value={q} onChangeText={setQ} placeholder="Filter models" /> : undefined}>
                {models === undefined ? <SheetRow title="Asking…" disabled />
                    : models === null ? <SheetRow title="The runtime did not list its models." disabled />
                    : filtered.length === 0 ? <SheetRow title={`No model here matches “${q.trim()}”.`} disabled />
                    : filtered.map((m) => (
                        <SheetRow key={m.id} title={m.id} mono chosen={m.id === c.model} disabled={!c.canSwitchModel}
                            detail={[m.where === "cloud" ? "cloud" : null, m.kinds?.includes("vision") ? "sees images" : null, m.kinds?.includes("thinking") ? "thinks" : null].filter(Boolean).join(" · ") || undefined}
                            onPress={() => pick(m.id)} />
                    ))}
            </Sheet>
        </>
    );
}

/** The session's menu (⋮): its title in full, where it runs, and stopping a run. */
function SessionMenu() {
    const e = useEmbed();
    const p = usePalette();
    const layer = useSessionLayer();
    const sheet = useRef<BottomSheetModal>(null);
    const c = e.chrome;
    // Renaming happens IN the sheet, not in an alert: Alert.prompt is iOS-only, and a sheet keeps the title in view.
    const [naming, setNaming] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const close = () => { sheet.current?.dismiss(); setNaming(null); };

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
            { text: "Delete", style: "destructive", onPress: () => { close(); void e.remove(c.key).then((r) => { if (r.ok) layer.close(); }); } },
        ]);
    };
    const copyId = () => {
        if (!c) return;
        close();
        void Clipboard.setStringAsync(c.key).then(() => Haptics.selectionAsync());
    };

    return (
        <>
            <IconButton label="Session menu" icon={(col) => <EllipsisVertical size={22} color={col} />} onPress={() => sheet.current?.present()} disabled={!c} />
            <Sheet ref={sheet}>
                {c && naming != null ? <>
                    <Text style={[s.menuTitle, { color: p.fg }]}>Rename this session</Text>
                    <Text style={[s.menuSub, { color: p.fgDim }]}>Every device shows the new title: the runtime keeps it.</Text>
                    <View style={s.renameBox}>
                        <SheetFilter plain value={naming} onChangeText={setNaming} placeholder="Session title" />
                    </View>
                    <SheetRow title={busy ? "Saving…" : "Save"} disabled={busy || !naming.trim() || naming.trim() === c.title} onPress={() => void rename()} />
                    <SheetRow title="Cancel" onPress={() => setNaming(null)} />
                </> : c ? <>
                    <Text style={[s.menuTitle, { color: p.fg }]}>{c.title}</Text>
                    <Text style={[s.menuSub, { color: p.fgDim }]}>{c.kind === "agent" ? "Agent" : "Chat"} on {c.runtimeName}{c.pinned ? " · pinned" : ""}</Text>
                    {c.running && c.canSend ? <SheetRow title="Stop this run" danger onPress={() => { close(); e.cancel(c.key); }} /> : null}
                    {c.canPin ? <SheetRow title={c.pinned ? "Unpin" : "Pin"} detail={c.pinned ? undefined : "Kept on the runtime, never expired or evicted"} onPress={() => void pin()} /> : null}
                    {c.canRename ? <SheetRow title="Rename" onPress={() => setNaming(c.title)} /> : null}
                    <SheetRow title="Copy session id" onPress={copyId} />
                    {c.canDelete ? <SheetRow title="Delete" danger onPress={remove} /> : null}
                </> : null}
            </Sheet>
        </>
    );
}

/** The composer: a box that grows to a cap, and the send button, which stops a run while the box is empty. What was typed
 *  is kept per session and survives a failed send (drafts.ts). A session this device may only watch says why instead. */
function Composer({ bottom }: { bottom: number }) {
    const e = useEmbed();
    const p = usePalette();
    const c = e.chrome!;
    const [text, setText] = useState(() => draftOf(c.key));
    const [sending, setSending] = useState(0);
    useEffect(() => onDraftRestored((k) => { if (k === c.key) setText(draftOf(k)); }), [c.key]);
    if (!c.canSend) {
        return <Text style={[s.readOnly, { color: p.fgDim, paddingBottom: bottom + 12, borderTopColor: p.border }]}>{c.readOnly}</Text>;
    }
    const empty = !text.trim();
    const stop = c.running && empty;
    const act = () => {
        if (stop) { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); e.cancel(c.key); return; }
        if (empty) return;
        const t = text.trim();
        setText("");
        setSending((n) => n + 1);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        void sendHeld(c.key, t, () => e.send(c.key, t)).finally(() => setSending((n) => n - 1));
    };
    return (
        <View style={[s.composer, { paddingBottom: Math.max(bottom, 10) }]}>
            <View style={[s.box, { backgroundColor: p.panel, borderColor: p.border }]}>
                <TextInput
                    value={text}
                    onChangeText={(t) => { setText(t); saveDraft(c.key, t); }}
                    placeholder={c.running ? (c.kind === "agent" ? "Steer, or queue a follow-up…" : "Sending…") : "Send a message…"}
                    placeholderTextColor={p.fgFaint}
                    multiline
                    style={[s.input, { color: p.fg }]}
                    accessibilityLabel="Message"
                />
                <IconButton label={stop ? "Stop the run" : "Send"} filled disabled={!stop && (empty || sending > 3)}
                    icon={(col) => stop ? <Square size={16} color={col} fill={col} /> : <ArrowUp size={20} color={col} strokeWidth={2.5} />}
                    onPress={act} style={s.send} />
            </View>
        </View>
    );
}

const s = StyleSheet.create({
    // The header: back, the model pill (or the title), the menu; the status bar's inset above it.
    header: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, paddingBottom: 6 },
    // "Waiting on your approval": a band under the header in the notice colour's tint.
    waiting: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: SIZE.gutter, paddingVertical: 10 },
    // What waits on you, in the bar under the header.
    waitingText: { fontSize: SIZE.small, flexShrink: 1 },
    // "Show me": the way to the card that answers it.
    waitingGo: { fontSize: SIZE.small, fontWeight: "700" },
    // The menu's first line: the session's title in full.
    // The model in the header: the name and its chevron, no box around them.
    model: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, paddingVertical: 6, paddingHorizontal: 4 },
    // The model's name: bold, in the code face an id belongs in.
    modelText: { fontSize: 17, fontWeight: "700", fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), flexShrink: 1 },
    // A provider prefix in front of it, quieter and not bold.
    modelPrefix: { fontWeight: "400" },
    // The rename field, inset like the sheet's rows.
    renameBox: { paddingTop: 12 },
    menuTitle: { fontSize: SIZE.heading, fontWeight: "700", paddingHorizontal: 12, paddingTop: 4 },
    // Under it: what kind of session, on which runtime.
    menuSub: { fontSize: SIZE.small, paddingHorizontal: 12, paddingTop: 4, paddingBottom: 12 },
    // Why there is no composer: a line of text where it would be.
    readOnly: { fontSize: SIZE.small, lineHeight: 19, paddingHorizontal: SIZE.gutter, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
    // The composer's strip, above the home bar.
    composer: { paddingHorizontal: 10, paddingTop: 6 },
    // The rounded box holding the text and the button, raised out of the canvas.
    box: { flexDirection: "row", alignItems: "flex-end", borderRadius: 24, borderWidth: StyleSheet.hairlineWidth, paddingLeft: 16, paddingRight: 4, paddingVertical: 4, minHeight: 52 },
    // The text: grows with what is typed, to a cap, then scrolls.
    input: { flex: 1, fontSize: SIZE.text, lineHeight: 22, maxHeight: 140, paddingTop: 11, paddingBottom: 11 },
    // The send button, a filled circle at the box's end.
    send: { width: 40, height: 40, borderRadius: 20, marginBottom: 2 },
});
