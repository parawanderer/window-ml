// NewChatScreen.tsx — STARTING A SESSION: a chat or an agent run, on which runtime, with which model, and (an agent) on
// which tab. The chat page's start page (src/chat/start-page.tsx) as a phone screen: Chat / Agent at the top where both
// can start somewhere, the runtime, model and tab as pills, the box filling the rest, and what was typed kept until a
// start succeeds (drafts.ts, under `start`). Which runtimes can start what is the PAGE's answer (`startable`), never a
// grant this app reads for itself.

import { useEffect, useRef, useState } from "react";
import { Image, Keyboard, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { AppWindow, ArrowUp, Bot, ChevronLeft, Cpu, Globe, MessageCircle, MonitorSmartphone, Plus, TriangleAlert } from "lucide-react-native";
import type { ModelChoice } from "../../../src/session-host";
import type { Routes } from "../routes";
import { draftOf, saveDraft } from "../drafts";
import { useEmbed } from "../embed";
import { useSessionLayer } from "../layer";
import { SIZE, usePalette } from "../theme";
import { IconButton, MODEL_FILTER_AT, Pill, Sheet, SheetFilter, SheetRow } from "../ui";
import { byPinned } from "../format";
import { togglePinnedModel, usePinnedModels } from "../pinned-models";
import { AttachButton, AttachedStrip, AttachSheet, useAttachments } from "../attach-ui";
import { TabSheet, type TabChoice, type TabList } from "../tab-sheet";
import { faviconSrc, tabHost } from "../../../src/chat/tab-tree";
// The SAME reading the chat page makes (src/chat/blank-start.ts), not a second copy of the rules: which state the
// choice is in is a fact about the runtime's answer, and two surfaces disagreeing about it is the drift AGENTS.md's
// one-design-language rule exists to stop. Only the drawing below is this screen's.
import { blankBlockedReason, blankStartState } from "../../../src/chat/blank-start";

/** The new-session screen. */
export function NewChatScreen() {
    const p = usePalette();
    const insets = useSafeAreaInsets();
    const nav = useNavigation();
    const e = useEmbed();
    const layer = useSessionLayer();
    const kinds = (["chat", "agent"] as const).filter((k) => e.startable[k].length > 0);
    const [kindPick, setKind] = useState<"chat" | "agent">("chat");
    const kind = kinds.includes(kindPick) ? kindPick : kinds[0] ?? "chat";
    const startable = e.runtimes.filter((r) => e.startable[kind].includes(r.id));
    // The device the start BEGAN at, where it began at one (a runtime's `+` in the list). Honoured only while that
    // machine can start this kind: falling back beats arriving on a device that cannot take the run.
    const askedRuntime = useRoute<RouteProp<Routes, "NewChat">>().params?.runtime;
    const [runtimeId, setRuntimeId] = useState((askedRuntime && startable.some((r) => r.id === askedRuntime) ? askedRuntime : startable[0]?.id) ?? "");
    const rt = startable.find((r) => r.id === runtimeId) ?? startable[0];
    const [models, setModels] = useState<ModelChoice[] | null | undefined>(undefined);
    const [model, setModel] = useState("");
    /** What has been typed into the model sheet's filter. */
    const [mq, setMq] = useState("");
    const pins = usePinnedModels();
    const [text, setText] = useState(() => draftOf("start"));
    const [busy, setBusy] = useState(false);
    const att = useAttachments("start");
    const rtSheet = useRef<BottomSheetModal>(null);
    const modelSheet = useRef<BottomSheetModal>(null);
    const tabSheet = useRef<BottomSheetModal>(null);
    const blankSheet = useRef<BottomSheetModal>(null);
    // An agent's tab: the runtime's own list, asked when the runtime changes and again when the picker opens.
    const [tabs, setTabs] = useState<TabList>({ tabs: null, groups: [], withheld: 0 });
    const [where, setWhere] = useState<TabChoice | null>(null);
    const [url, setUrl] = useState("");
    const asked = useRef(0);
    const loadTabs = (fresh: boolean) => {
        if (!rt || kind !== "agent") return;
        const n = ++asked.current;
        if (fresh) setTabs({ tabs: null, groups: [], withheld: 0 });
        void e.tabs(rt.id).then((r) => {
            if (n !== asked.current || (!fresh && !r.tabs)) return;   // a refresh that failed keeps the list on screen
            setTabs(r);
            // A NEW TAB, never whichever tab that browser happens to be on. An agent run DRIVES the page it is given,
            // and the active tab is the one the person is reading — defaulting to it (this picked the active tab, then
            // the first) means a careless start takes over their work. A new tab costs nothing and picking a real one
            // is one tap away. A refresh never moves a choice either, so a chosen tab that closed stays chosen and
            // says so, rather than a run starting somewhere nobody picked.
            setWhere((w) => (w != null && !fresh ? w : "blank"));
        });
    };
    useEffect(() => { setWhere(null); loadTabs(true); }, [rt?.id, kind]);

    useEffect(() => {
        if (!rt) return;
        setModels(undefined);
        void e.models(rt.id).then((m) => {
            setModels(m);
            const usable = (m ?? []).filter((x) => !x.kinds?.includes("embedding"));
            setModel((usable.find((x) => x.default) ?? usable[0])?.id ?? "");
        });
    }, [rt?.id]);

    const chosenTab = typeof where === "number" ? tabs.tabs?.find((t) => t.tabId === where) : undefined;
    const closed = typeof where === "number" && !!tabs.tabs && !chosenTab;
    // A PHONE IS ALWAYS A REMOTE CLIENT: it can never raise a permission prompt on the machine the run would go to,
    // so `canGrant` is false here by construction and the states this screen can meet are "propose" and "elsewhere".
    // That makes this the surface that needs it MOST — a new tab is this screen's default (above), so without it the
    // ordinary path is the one that fails, on the one device that can do nothing about it.
    const blocked = kind === "agent" && where === "blank" && !url.trim() ? blankStartState(rt, false) : { kind: "ok" as const };
    const ready = (kind === "chat" || where === "blank" || (typeof where === "number" && !closed)) && blocked.kind === "ok";
    const start = async () => {
        if (!rt || !text.trim() || busy || !ready) return;
        setBusy(true);
        // The images leave the box only once the session has started: a refusal leaves everything where it was.
        const target = kind === "agent" ? (where === "blank" ? { kind: "blank" as const, ...(url.trim() ? { url: url.trim() } : {}) } : { kind: "tab" as const, tabId: where as number }) : undefined;
        const r = await e.start({ runtime: rt.id, kind, text: text.trim(), model: model || undefined, images: att.imgs, target });
        setBusy(false);
        if (r.ok && r.session) { saveDraft("start", ""); setText(""); att.take(); Keyboard.dismiss(); nav.goBack(); layer.open(r.session); }
    };
    // The box has the keyboard from the start: a sheet opened over it would sit under the keys, taking the taps meant for it.
    const show = (ref: { current: BottomSheetModal | null }) => { Keyboard.dismiss(); ref.current?.present(); };
    // Same order as every other model list on this device: what is pinned, then the rest, each alphabetical.
    const usable = byPinned((models ?? []).filter((x) => !x.kinds?.includes("embedding")), (x) => x.id, pins);
    const shownModels = mq.trim() ? usable.filter((m) => m.id.toLowerCase().includes(mq.trim().toLowerCase())) : usable;
    const whereText = where === "blank" ? "A new tab" : closed ? "That tab has closed" : chosenTab ? chosenTab.title || tabHost(chosenTab.url) : tabs.tabs === null ? "…" : "Pick a tab";
    // The site's icon, as the sheet draws it: an SVG becomes the plus, because React Native's Image draws no SVG.
    const chosenFav = chosenTab ? faviconSrc(chosenTab) : null;
    const whereIcon = chosenFav && !chosenFav.startsWith("data:image/svg")
        ? <Image source={{ uri: chosenFav }} style={s.pillFav} />
        : <Plus size={14} color={p.fgDim} />;

    return (
        <KeyboardAvoidingView behavior="padding" style={[s.screen, { backgroundColor: p.bg, paddingTop: insets.top }]}>
            <View style={s.bar}>
                <IconButton label="Back" icon={(c) => <ChevronLeft size={26} color={c} />} onPress={() => nav.goBack()} />
                <Text style={[s.barTitle, { color: p.fg }]}>{kind === "agent" ? "New agent run" : "New chat"}</Text>
                <View style={{ flex: 1 }} />
                {kinds.length > 1 ? (
                    <View style={[s.kinds, { backgroundColor: p.panel }]} accessibilityRole="tablist">
                        {kinds.map((k) => (
                            <Pressable key={k} accessibilityRole="tab" accessibilityState={{ selected: k === kind }} onPress={() => setKind(k)}
                                style={[s.kind, k === kind && { backgroundColor: p.bg }]}>
                                {/* The same pair the page draws (kind-picker.tsx): a robot and a speech bubble, so the
                                    two kinds are told apart at a glance and mean the same thing on both surfaces. */}
                                {k === "chat" ? <MessageCircle size={14} color={k === kind ? p.fg : p.fgDim} />
                                    : <Bot size={14} color={k === kind ? p.fg : p.fgDim} />}
                                <Text style={[s.kindText, { color: k === kind ? p.fg : p.fgDim }]}>{k === "chat" ? "Chat" : "Agent"}</Text>
                            </Pressable>
                        ))}
                    </View>
                ) : null}
            </View>
            {rt ? (
                <>
                    <View style={s.pills}>
                        {/* Each pill carries the KIND of thing it names. Three of them side by side, differing only in
                            their words, read as one control with three settings; a device, a model and a page are
                            three different questions. The tab's glyph is the site's own icon, which is how a tab is
                            recognised everywhere else. */}
                        <Pill text={rt.name} label={`Runtime: ${rt.name}`} icon={<MonitorSmartphone size={14} color={p.fgDim} />}
                            onPress={startable.length > 1 ? () => show(rtSheet) : undefined} />
                        {model ? <Pill text={model} mono label={`Model: ${model}`} icon={<Cpu size={14} color={p.fgDim} />} onPress={() => show(modelSheet)} />
                            : models === undefined ? <Pill text="…" label="Loading models" /> : null}
                        {kind === "agent" ? <Pill text={whereText} label={`Runs on: ${whereText}`} icon={whereIcon} onPress={() => { loadTabs(false); show(tabSheet); }} /> : null}
                    </View>
                    {blocked.kind !== "ok" ? (
                        <Pressable onPress={() => show(blankSheet)} accessibilityRole="button"
                            accessibilityLabel="A new tab needs permission" style={[s.blocked, { backgroundColor: p.panel }]}>
                            <TriangleAlert size={14} color={p.warn} />
                            <Text style={[s.blockedText, { color: p.warn }]}>A new tab needs permission</Text>
                        </Pressable>
                    ) : null}
                    {kind === "agent" && where === "blank" ? (
                        <TextInput value={url} onChangeText={setUrl} placeholder="https://… (optional: the runtime's start page)" placeholderTextColor={p.fgFaint}
                            autoCapitalize="none" autoCorrect={false} keyboardType="url" style={[s.url, { color: p.fg, borderColor: p.border }]} accessibilityLabel="Page to open" />
                    ) : null}
                    <TextInput
                        value={text}
                        onChangeText={(t) => { setText(t); saveDraft("start", t); }}
                        placeholder={kind === "agent" ? "What should the agent do?" : "Start a chat"}
                        placeholderTextColor={p.fgFaint}
                        multiline
                        autoFocus
                        style={[s.input, { color: p.fg }]}
                        accessibilityLabel="Message"
                        testID="start-field"
                    />
                    <View style={s.strip}><AttachedStrip att={att} /></View>
                    <View style={[s.foot, { paddingBottom: Math.max(insets.bottom, 12) }]}>
                        <AttachButton att={att} style={s.attach} />
                        <IconButton label="Start" filled disabled={!text.trim() || busy || att.picking || !ready} onPress={start}
                            icon={(c) => <ArrowUp size={20} color={c} strokeWidth={2.5} />} style={s.send} />
                    </View>
                </>
            ) : (
                <Text style={[s.none, { color: p.fgDim }]}>No runtime this device may start a session on is online.</Text>
            )}
            <AttachSheet att={att} />
            {/* The same answer the chip above carries, on the row it is about: a new tab that cannot be opened is not
                a choice, and the picker should not take a tap it cannot honour. */}
            <TabSheet ref={tabSheet} list={tabs} value={where ?? "blank"}
                blankBlocked={blankBlockedReason(blocked)}
                onPick={(c) => { setWhere(c); tabSheet.current?.dismiss(); }} />
            {/* The ways out, as a sheet: this is a picker (which page shall it be?) wearing an explanation, and a
                picker is the one thing that stays a sheet on this device. There is no "grant" row — a phone cannot
                raise a permission prompt on another machine, which is the whole shape of the remote case. */}
            <Sheet ref={blankSheet} title="A new tab needs permission">
                {blocked.kind !== "ok" ? (
                    <Text style={[s.note, { color: p.fgDim }]}>
                        {"A run on a new tab opens "}
                        {/* The address is a THING, not prose: set apart the way the page sets it apart (`.chat-bs-url`),
                            so it can be read character by character instead of scanned as part of a sentence. */}
                        <Text style={[s.code, { color: p.fg, backgroundColor: p.panel }]}>{blocked.url}</Text>
                        {`, and ${blocked.kind === "grantable" ? "this device" : blocked.runtime} is not allowed to run there.`}
                    </Text>
                ) : null}
                {blocked.kind === "propose" ? (
                    <>
                        <Text style={[s.note, { color: p.fgDim }]}>{`${blocked.runtime} can already open these:`}</Text>
                        {/* Rows with a GLYPH, which is what a sheet of actions looks like here (ui.tsx): a picker's
                            rows take none, and without one these read as more of the paragraph above them. */}
                        {/* GROUPED, on their own ground, with a chevron each. Left as bare rows they sat at the same
                            left edge, size and background as the paragraphs above and read as more prose — there was
                            nothing on them that said they could be pressed. */}
                        <View style={[s.actions, { backgroundColor: p.panel }]}>
                            {blocked.choices.map((c) => (
                                <SheetRow key={c.origin} title={c.url} mono go icon={(col) => <Globe size={17} color={col} />}
                                    onPress={() => { setUrl(c.url); blankSheet.current?.dismiss(); }} />
                            ))}
                        </View>
                    </>
                ) : null}
                {blocked.kind === "elsewhere" ? <Text style={[s.note, { color: p.fgDim }]}>{blocked.steps}</Text> : null}
                {blocked.kind !== "ok" ? (
                    <View style={[s.actions, { backgroundColor: p.panel }]}>
                        <SheetRow title="Use one of its tabs" go icon={(col) => <AppWindow size={17} color={col} />}
                            detail="A page it already has open needs no permission"
                            onPress={() => { blankSheet.current?.dismiss(); loadTabs(false); show(tabSheet); }} />
                    </View>
                ) : null}
            </Sheet>
            <Sheet ref={rtSheet} title="Runtime">
                {startable.map((r) => <SheetRow key={r.id} title={r.name} chosen={r.id === rt?.id} onPress={() => { setRuntimeId(r.id); rtSheet.current?.dismiss(); }} />)}
            </Sheet>
            {/* A box with fifty models is a scroll, not a choice. The threshold is the Runtimes screen's, and `tall`
                keeps the sheet a fixed height so the results stay on screen while the keyboard is up. */}
            <Sheet ref={modelSheet} title="Model" tall={usable.length > MODEL_FILTER_AT}
                header={usable.length > MODEL_FILTER_AT ? <SheetFilter value={mq} onChangeText={setMq} placeholder="Filter models" /> : undefined}>
                {shownModels.map((m) => (
                    <SheetRow key={m.id} title={m.id} mono chosen={m.id === model}
                        detail={[m.where === "cloud" ? "cloud" : null, m.kinds?.includes("vision") ? "sees images" : null, m.kinds?.includes("thinking") ? "thinks" : null].filter(Boolean).join(" · ") || undefined}
                        pin={{ on: pins.has(m.id), toggle: () => togglePinnedModel(m.id) }}
                        onPress={() => { setModel(m.id); modelSheet.current?.dismiss(); }} />
                ))}
                {usable.length && !shownModels.length ? <Text style={[s.note, { color: p.fgDim }]}>{`No model matches “${mq.trim()}”.`}</Text> : null}
            </Sheet>
        </KeyboardAvoidingView>
    );
}

const s = StyleSheet.create({
    // A new tab that cannot be opened, said in the row where the choice was made rather than after the start fails.
    // The web draws the same thing as a chip in its start row (`.chat-start-blocked`).
    blocked: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", marginHorizontal: 12, marginTop: 4, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 999 },
    // Its words, in the warning colour: the chip is the whole warning, and the sheet behind it carries the ways out.
    blockedText: { fontSize: SIZE.text },
    // The tappable rows in the permission sheet, grouped away from the prose they sit among.
    actions: { marginHorizontal: 12, marginTop: 6, marginBottom: 4, borderRadius: 12, overflow: "hidden" },
    // An address inside a sentence, set apart the way the chat page sets it apart: monospace, on its own ground.
    code: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: SIZE.text - 1 },
    // What the sheet says when a filter matches nothing.
    note: { paddingHorizontal: 12, paddingVertical: 14, fontSize: SIZE.text },
    // The site's icon inside the tab pill: the size of the glyphs beside it, with the same rounding as the sheet's.
    pillFav: { width: 14, height: 14, borderRadius: 3 },
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
    // Chat / Agent, a small segmented control at the bar's right.
    kinds: { flexDirection: "row", borderRadius: 18, padding: 3, marginRight: 8 },
    // One of the two.
    // ROW, explicitly: React Native lays a view out as a COLUMN by default, so the glyph stacked above its word and
    // the two tabs grew a line taller than the bar they sit in. The web's segmented control says the same thing.
    kind: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 15 },
    // Its word.
    kindText: { fontSize: SIZE.small, fontWeight: "600" },
    // The page a new tab opens at, under the pills.
    url: { marginHorizontal: SIZE.gutter, marginTop: 4, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, fontSize: SIZE.small },
    // Nothing to start on: why.
    none: { padding: SIZE.gutter, fontSize: SIZE.text, lineHeight: 22 },
});
