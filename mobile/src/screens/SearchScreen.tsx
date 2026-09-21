// SearchScreen.tsx — FINDING A SESSION: a field, then every session any runtime has, newest first, a page at a time as
// it scrolls. The chat page's search (src/chat/search-page.tsx) as a screen of its own; the page does the asking and the
// paging (src/native/search-bridge.ts), so the two find a session by the same rules.
//
// The list screen reaches back a month; this is where everything older lives, which is why its "N older on this
// runtime" opens this with nothing typed.

import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { Bot, ChevronLeft, Search as SearchIcon, X } from "lucide-react-native";
import type { ListedSession } from "../../../src/session-host";
import { useEmbed } from "../embed";
import { STATUS_LABEL, STATUS_TONE } from "../format";
import { useSessionLayer } from "../layer";
import { SIZE, usePalette } from "../theme";
import { Chip, IconButton } from "../ui";

/** A session's date, as a list of them wants it: the time for today, the day this year, the year otherwise. */
export function shortDate(ts: number, now = Date.now()): string {
    const d = new Date(ts), n = new Date(now);
    if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString(undefined, d.getFullYear() === n.getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

/** A runtime's search snippet, whose match the runtime marked in «guillemets»: its own words, never markup. */
function Snippet({ text, color, mark }: { text: string; color: string; mark: string }) {
    return (
        <Text numberOfLines={2} style={[s.snippet, { color }]}>
            {text.split(/«|»/).map((part, i) => (i % 2 ? <Text key={i} style={{ color: mark, fontWeight: "700" }}>{part}</Text> : part))}
        </Text>
    );
}

/** The search screen. */
export function SearchScreen() {
    const p = usePalette();
    const insets = useSafeAreaInsets();
    const nav = useNavigation();
    const e = useEmbed();
    const layer = useSessionLayer();
    const [query, setQuery] = useState("");
    const [device, setDevice] = useState<string | null>(null);
    const [rows, setRows] = useState<ListedSession[]>([]);
    const [more, setMore] = useState(false);
    const [busy, setBusy] = useState(true);
    const search = useRef<{ more(): void; stop(): void } | null>(null);
    const names = new Map(e.runtimes.map((r) => [r.id, r.name]));

    // Typing waits for a pause: every keystroke would otherwise be a round trip to every runtime.
    useEffect(() => {
        const t = setTimeout(() => {
            search.current?.stop();
            setRows([]);
            setBusy(true);
            search.current = e.search(query.trim(), device, (page, hasMore) => {
                setRows((was) => [...was, ...page].sort((a, b) => b.lastTs - a.lastTs));
                setMore(hasMore);
                setBusy(false);
            });
        }, query.trim() ? 250 : 0);
        return () => clearTimeout(t);
    }, [query, device, e]);
    useEffect(() => () => search.current?.stop(), []);

    const end = useCallback(() => { if (more && !busy) { setBusy(true); search.current?.more(); } }, [more, busy]);
    const open = (x: ListedSession) => { layer.open(`${x.id.runtime}:${x.id.hash}`); nav.goBack(); };

    return (
        <View style={[s.screen, { backgroundColor: p.bg, paddingTop: insets.top }]}>
            <View style={s.bar}>
                <IconButton label="Back to sessions" icon={(c) => <ChevronLeft size={26} color={c} />} onPress={() => nav.goBack()} />
                <View style={[s.box, { backgroundColor: p.panel }]}>
                    <SearchIcon size={17} color={p.fgFaint} />
                    <TextField value={query} onChangeText={setQuery} color={p.fg} placeholder="Search sessions" placeholderColor={p.fgFaint} />
                    {query ? (
                        <Pressable accessibilityRole="button" accessibilityLabel="Clear the search" hitSlop={10} onPress={() => setQuery("")}>
                            <X size={17} color={p.fgDim} />
                        </Pressable>
                    ) : null}
                </View>
            </View>
            {/* Which device to look on. One runtime needs no choosing, so the row appears only past that. */}
            {e.runtimes.length > 1 ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={s.chips}>
                    <Chip text="All devices" on={device === null} onPress={() => setDevice(null)} />
                    {e.runtimes.map((rt) => <Chip key={rt.id} text={rt.name} on={device === rt.id} onPress={() => setDevice(rt.id)} />)}
                </ScrollView>
            ) : null}
            <FlatList
                data={rows}
                keyExtractor={(x) => `${x.id.runtime}:${x.id.hash}`}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
                onEndReached={end}
                onEndReachedThreshold={0.6}
                ListEmptyComponent={busy ? null : (
                    <Text style={[s.empty, { color: p.fgDim }]}>
                        {query.trim() ? `Nothing on ${device ? names.get(device) ?? "that device" : "any device"} matches “${query.trim()}”.` : "No sessions yet."}
                    </Text>
                )}
                ListFooterComponent={busy ? <ActivityIndicator style={s.spin} color={p.fgFaint} /> : null}
                renderItem={({ item }) => {
                    const label = STATUS_LABEL[item.status];
                    const tone = STATUS_TONE[item.status];
                    return (
                        <Pressable accessibilityRole="button" accessibilityLabel={item.title || item.task || "(untitled)"} onPress={() => open(item)}
                            style={({ pressed }) => [s.row, pressed && { backgroundColor: p.panel }]}>
                            <View style={{ flex: 1, minWidth: 0 }}>
                                <Text numberOfLines={1} style={[s.title, { color: p.fg }]}>{item.title || item.task || "(untitled)"}</Text>
                                <View style={s.meta}>
                                    {label ? <Text style={[s.state, { color: item.status === "waiting" ? p.notice : tone === "err" ? p.err : p.fgDim }]}>{label}</Text> : null}
                                    {item.kind === "agent" ? <Bot size={13} color={p.fgFaint} /> : null}
                                    <Text numberOfLines={1} style={[s.metaText, { color: p.fgFaint, flexShrink: 1 }]}>{names.get(item.id.runtime) ?? item.id.runtime}</Text>
                                    {/* An archived session is brought back by the page when it is opened; saying so here
                                        is why opening one takes a moment. */}
                                    {item.archived ? <Text style={[s.metaText, { color: p.fgFaint }]}>archived</Text> : null}
                                </View>
                                {item.match ? <Snippet text={item.match.snippet} color={p.fgDim} mark={p.fg} /> : null}
                            </View>
                            <Text style={[s.metaText, { color: p.fgFaint, marginLeft: 10 }]}>{shortDate(item.lastTs)}</Text>
                        </Pressable>
                    );
                }}
            />
        </View>
    );
}

/** The search field itself: focused a moment after the screen arrives, so the push animation is not fought by the
 *  keyboard. Split out so the screen above reads as its layout. */
function TextField({ value, onChangeText, color, placeholder, placeholderColor }: {
    value: string; onChangeText: (t: string) => void; color: string; placeholder: string; placeholderColor: string;
}) {
    const ref = useRef<TextInput>(null);
    useEffect(() => { const t = setTimeout(() => ref.current?.focus(), 250); return () => clearTimeout(t); }, []);
    return (
        <TextInput ref={ref} value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={placeholderColor}
            autoCapitalize="none" autoCorrect={false} returnKeyType="search" accessibilityLabel={placeholder} testID="search-field"
            style={[s.input, { color }]} />
    );
}

const s = StyleSheet.create({
    // The whole screen, under the status bar.
    screen: { flex: 1 },
    // Back, then the search box filling the rest of the row.
    bar: { flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 6, paddingRight: SIZE.gutter, height: 56 },
    // The rounded search box.
    box: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, borderRadius: 12 },
    // The field inside it, tall enough to tap.
    input: { flex: 1, fontSize: SIZE.text, paddingVertical: 10 },
    // The row of device chips under the field.
    chips: { gap: 8, paddingHorizontal: SIZE.gutter, paddingBottom: 10 },
    // One result: the session on the left, its date on the right.
    row: { flexDirection: "row", alignItems: "flex-start", paddingVertical: 12, paddingHorizontal: SIZE.gutter, gap: 6 },
    // The session's title.
    title: { fontSize: SIZE.text, fontWeight: "600" },
    // Where it stands, what kind it is, whose machine it is on.
    meta: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 3 },
    // Where the session stands, first on the meta line as in the list.
    state: { fontSize: 13, fontWeight: "600" },
    // Every small grey word in a result.
    metaText: { fontSize: 13 },
    // The runtime's own words around the match.
    snippet: { fontSize: 13, lineHeight: 18, marginTop: 4 },
    // Nothing found, or nothing yet.
    empty: { padding: SIZE.gutter, fontSize: SIZE.text, lineHeight: 22 },
    // Waiting for the next page.
    spin: { paddingVertical: 20 },
});
