// RuntimeScreen.tsx — ONE RUNTIME, read-only: what it is and what it can do, the models it offers, and where its saved
// sessions' bytes go. The chat page's Settings → Runtimes (src/chat/runtime-sheet.tsx) as a phone screen.
//
// READ-ONLY by design, as there: changing a runtime's settings (its backend, its key, which models it may use) happens
// on that machine, in its own Settings, and is never a remote command. Everything here needs only `view`.
//
// The sizes arrive already in words (`RuntimeStorageView`, computed page-side by `runtimeStorage`): bytes are binary and
// the page owns how one reads, so the app never converts a number a second way.

import { useEffect, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRoute, type RouteProp } from "@react-navigation/native";
import { Cloud, Cpu } from "lucide-react-native";
import type { ModelChoice, RuntimeCapabilities } from "../../../src/session-host";
import type { RuntimeStorageView } from "../../../src/native/bridge";
import { useEmbed } from "../embed";
import { seen, when } from "../format";
import type { Routes } from "../routes";
import { SIZE, usePalette } from "../theme";
import { SheetFilter } from "../ui";
import { Bar } from "./AccountScreens";

/** What each capability means to a person, in the order worth reading (the page's own list and words). */
const CAPS: [keyof RuntimeCapabilities, string][] = [
    ["chat", "Chats"], ["agent", "Agent runs"], ["tabs", "Its tabs"], ["screenshots", "Screenshots"],
    ["highlight", "Highlight on the page"], ["persistence", "Saved sessions"], ["sideCalls", "Titles and summaries"],
    ["resourcePanel", "Resource graphs"], ["pythonBench", "Python bench"], ["headless", "Headless runs"],
];

/** Past this many models the list gets a filter: a cloud gateway lists dozens. */
const MODEL_FILTER_AT = 8;

/** The screen. */
export function RuntimeScreen() {
    const p = usePalette();
    const insets = useSafeAreaInsets();
    const e = useEmbed();
    const { id } = useRoute<RouteProp<Routes, "Runtime">>().params;
    const rt = e.runtimes.find((r) => r.id === id);
    const [models, setModels] = useState<ModelChoice[] | null | undefined>(undefined);
    const [store, setStore] = useState<{ storage: RuntimeStorageView | null; error?: string } | undefined>(undefined);
    const [q, setQ] = useState("");
    useEffect(() => {
        if (!rt?.online) return;
        void e.models(id).then(setModels);
        void e.storage(id).then(setStore);
    }, [id, rt?.online]);
    if (!rt) return <View style={[s.screen, { backgroundColor: p.bg, paddingTop: insets.top }]}><Bar title="Runtime" /><Text style={[s.note, { color: p.fgDim }]}>This runtime is no longer listed.</Text></View>;

    const can = CAPS.filter(([k]) => rt.capabilities[k]).map(([, label]) => label);
    const list = (models ?? []).filter((m) => !m.kinds?.includes("embedding"));
    const needle = q.trim().toLowerCase();
    // The default first, then A→Z: a long list is scannable and the one a new session uses is where the eye lands.
    const shown = list.filter((m) => !needle || m.id.toLowerCase().includes(needle))
        .sort((a, b) => Number(!!b.default) - Number(!!a.default) || a.id.localeCompare(b.id));

    return (
        // The model filter sits mid-screen, so the keyboard would cover it (and its clear button) as soon as it opens.
        // `height` on Android: padding there left the filtered list under the keyboard, where iOS lifts it clear.
        <KeyboardAvoidingView behavior={Platform.select({ ios: "padding", default: "height" })} style={[s.screen, { backgroundColor: p.bg, paddingTop: insets.top }]}>
            <Bar title={rt.name} />
            <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }} keyboardShouldPersistTaps="handled">
                <Text style={[s.group, { color: p.fgDim }]}>About</Text>
                <View style={[s.card, { backgroundColor: p.scheme === "dark" ? p.panel : p.bg, borderColor: p.border }]}>
                    <Fact label="Status" value={rt.online ? "Online" : rt.lastSeen ? `Offline, seen ${seen(rt.lastSeen)}` : "Offline"} />
                    <Fact label="Kind" value={rt.kind} />
                    <Fact label="Contract" value={`v${rt.contractVersion}`} hint="The session contract version it speaks." />
                    {rt.capabilities.archive ? <Fact label="Archive folder" value={folderText(rt.capabilities.archive)} hint="Where old sessions are copied, so they outlive the browser's profile." /> : null}
                    <Fact label="Offers" value={can.length ? can.join(" · ") : "Nothing this client knows"} last />
                </View>

                <Text style={[s.group, { color: p.fgDim }]}>Models{list.length ? ` (${list.length})` : ""}</Text>
                {list.length > MODEL_FILTER_AT ? <View style={s.filter}><SheetFilter onScreen value={q} onChangeText={setQ} placeholder="Filter models" /></View> : null}
                <View style={[s.card, { backgroundColor: p.scheme === "dark" ? p.panel : p.bg, borderColor: p.border }]}>
                    {!rt.online ? <Note text="Offline: its models are listed when it is back." />
                        : models === undefined ? <Note text="Asking…" />
                        : models === null ? <Note text={`${rt.name} did not list its models.`} />
                        : !list.length ? <Note text="No models: its backend did not answer, or offers none." />
                        : !shown.length ? <Note text={`No model matches “${q.trim()}”.`} />
                        : shown.map((m, i) => (
                            <View key={m.id} style={[s.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border }]}>
                                <View style={{ flex: 1 }}>
                                    <Text style={[s.mono, { color: p.fg }]}>{m.id}</Text>
                                    <Text style={[s.sub, { color: p.fgFaint }]}>
                                        {[m.default ? "default" : null, ...(m.kinds ?? [])].filter(Boolean).join(" · ") || " "}
                                    </Text>
                                </View>
                                {/* Where it runs, as the page's lists mark it: a cloud model sends what you write to its provider. */}
                                {m.where === "cloud" ? <Cloud size={15} color={p.fgDim} accessibilityLabel="cloud model" />
                                    : m.where === "local" ? <Cpu size={15} color={p.fgFaint} accessibilityLabel="local model" /> : null}
                            </View>
                        ))}
                </View>
                <Text style={[s.foot, { color: p.fgFaint }]}>Which models it may use is set on that machine, in its own Settings.</Text>

                <Text style={[s.group, { color: p.fgDim }]}>Storage</Text>
                <View style={[s.card, { backgroundColor: p.scheme === "dark" ? p.panel : p.bg, borderColor: p.border }]}>
                    {!rt.online ? <Note text="Offline." />
                        : store === undefined ? <Note text="Reading…" />
                        : !store.storage ? <Note text={store.error ?? "It did not say."} />
                        : <>
                            <View style={s.row}><Text style={[s.rowText, { color: p.fg }]}>{store.storage.summary}</Text></View>
                            {store.storage.parts.map((part) => (
                                <View key={part.label} style={[s.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border }]}>
                                    <Text style={[s.rowText, { color: p.fgDim }]}>{part.label}</Text>
                                    <Text style={[s.value, { color: p.fg }]}>{part.size}</Text>
                                </View>
                            ))}
                            {store.storage.largest.length ? <Text style={[s.sectionSub, { color: p.fgDim }]}>Largest sessions</Text> : null}
                            {store.storage.largest.map((big, i) => (
                                <View key={`${big.title}-${i}`} style={[s.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border }]}>
                                    <Text numberOfLines={1} style={[s.rowText, { color: p.fgDim }]}>{big.title}{big.pinned ? " (pinned)" : ""}</Text>
                                    <Text style={[s.value, { color: p.fg }]}>{big.size}</Text>
                                </View>
                            ))}
                        </>}
                </View>
                {store?.storage?.archive ? <Text style={[s.foot, { color: p.fgFaint }]}>{store.storage.archive}</Text> : null}
                {store?.storage?.note ? <Text style={[s.foot, { color: p.fgFaint }]}>{store.storage.note}</Text> : null}
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

/** The archive folder's state in words, as the page says it. An unknown state reads as none. */
function folderText(a: NonNullable<RuntimeCapabilities["archive"]>): string {
    const written = a.lastSync ? `, last written ${when(a.lastSync)}` : "";
    const waiting = a.pending ? `, ${a.pending} month${a.pending === 1 ? "" : "s"} ${a.folder === "connected" ? "to write" : "waiting"}` : "";
    switch (a.folder) {
        case "connected": return `Connected${waiting}${written}`;
        case "needs-grant": return `Needs reconnecting in that browser's Settings${waiting}${written}`;
        case "unsupported": return "This browser cannot keep one";
        default: return "None picked: the archive stays inside the browser";
    }
}

/** How long a value may be before it goes UNDER its label: beside one, a long value squeezed the label to nothing. */
const VALUE_INLINE_MAX = 26;

/** One fact about the runtime: its name, its value, and a line saying what it means where that is not obvious. */
function Fact({ label, value, hint, last }: { label: string; value: string; hint?: string; last?: boolean }) {
    const p = usePalette();
    const stacked = value.length > VALUE_INLINE_MAX;
    return (
        <View style={[stacked ? s.factStacked : s.fact, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border }]}>
            <View style={{ flex: stacked ? undefined : 1 }}>
                <Text style={[s.rowText, { color: p.fg }]}>{label}</Text>
                {hint ? <Text style={[s.sub, { color: p.fgFaint }]}>{hint}</Text> : null}
            </View>
            <Text style={[stacked ? s.valueUnder : s.value, { color: p.fgDim }]}>{value}</Text>
        </View>
    );
}

/** A card holding one sentence instead of rows: asking, offline, nothing to show. */
function Note({ text }: { text: string }) {
    const p = usePalette();
    return <View style={s.row}><Text style={[s.rowText, { color: p.fgDim }]}>{text}</Text></View>;
}

const s = StyleSheet.create({
    // The screen, under the status bar.
    screen: { flex: 1 },
    // A group's label above its card.
    group: { fontSize: 13, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase", paddingHorizontal: SIZE.gutter + 12, paddingTop: 22, paddingBottom: 8 },
    // A rounded card holding a group's rows.
    card: { marginHorizontal: SIZE.gutter, borderRadius: SIZE.radius, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
    // A row inside a card.
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
    // A fact's row: its name (and hint) against its value.
    fact: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
    // A long value goes under its name instead, where there is room to read it.
    factStacked: { paddingHorizontal: 16, paddingVertical: 12 },
    // …and reads left to right there, like the sentence it is.
    valueUnder: { fontSize: SIZE.small, lineHeight: 19, marginTop: 4 },
    // A row's main text.
    rowText: { fontSize: SIZE.text, flex: 1 },
    // The value at a row's right.
    value: { fontSize: SIZE.small, textAlign: "right", flexShrink: 1 },
    // A model's id, in the code face an id belongs in.
    mono: { fontSize: SIZE.small, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) },
    // Under a row: what a fact means, or what a model is.
    sub: { fontSize: 12.5, marginTop: 3 },
    // A heading inside the storage card.
    sectionSub: { fontSize: 12.5, fontWeight: "600", paddingHorizontal: 16, paddingTop: 14, paddingBottom: 2 },
    // The filter above a long model list.
    filter: { paddingHorizontal: SIZE.gutter, paddingBottom: 8 },
    // A sentence under a card: where something is changed, what the archive holds.
    foot: { fontSize: 12.5, lineHeight: 18, paddingHorizontal: SIZE.gutter + 12, paddingTop: 10 },
    // The screen with no runtime to show.
    note: { padding: SIZE.gutter + 4, fontSize: SIZE.text, lineHeight: 22 },
});
