// UpdateScreen.tsx — THIS APP'S BUILD AGAINST THE NEWEST ONE: how far behind it is (commits and days), what changed in
// between, grouped the way the commits were landed (`feat`, `fix`, the rest), and a button that downloads the new APK and
// hands it to Android's installer (src/app-update.ts). Reached from the inbox item a newer build earns, and from
// Settings → App updates.

import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { behindWords, groupChanges, type UpdateCheck } from "../../../src/native/app-update";
import { checkNow, downloadAndInstall, useAppUpdate, type Download } from "../app-update";
import { when } from "../format";
import { BUILD } from "../generated/build";
import { SIZE, usePalette } from "../theme";
import { Button, Card } from "../ui";
import { Bar } from "./AccountScreens";

/** A commit as the screen names it: the first seven of its hash. */
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "unknown");
/** A date as a day: "9 Oct". */
const day = (iso: string | null | undefined) => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : null);

/** The headline for a check: what a person needs to know before anything else on the screen. */
function headline(last: UpdateCheck | null, off: string | null): { title: string; detail: string } {
    if (off === "disabled") return { title: "Checking is off", detail: "Turn it on in Settings → App updates to hear about new builds." };
    if (off === "no-repo") return { title: "This build cannot check", detail: "It was built outside CI, so it does not name the repository its updates come from." };
    if (off) return { title: "This build cannot check", detail: "It does not know which commit it was built from." };
    if (!last) return { title: "Not checked yet", detail: "Checking GitHub for the newest build." };
    switch (last.state) {
        case "current": return { title: "This is the newest build", detail: "Nothing on main since it was built." };
        case "behind": return { title: "A newer build is out", detail: `This build is ${behindWords(last)}.` };
        case "elsewhere": return { title: "This build is not from main", detail: "Its commit is not on main (a local build, or one from a branch), so how far behind it is cannot be counted. The newest build from main is below." };
        case "failed": return { title: "Could not check", detail: last.error };
    }
}

/** The install button's words for where a download stands. */
function installTitle(d: Download): string {
    if (d.state === "downloading") return d.fraction === null ? "Downloading…" : `Downloading… ${Math.round(d.fraction * 100)}%`;
    if (d.state === "installing") return "Opening the installer…";
    return "Download and install";
}

/** The update screen. */
export function UpdateScreen() {
    const p = usePalette();
    const insets = useSafeAreaInsets();
    const u = useAppUpdate();
    const last = u.off ? null : u.last;
    const h = headline(last, u.off);
    const release = last && last.state !== "failed" ? last.release : null;
    // The newest build's day: its newest commit's when there is a list, else when the release was published.
    const newestDay = day(last?.state === "behind" ? last.changes[0]?.at ?? release?.publishedAt : release?.publishedAt);
    const installable = (last?.state === "behind" || last?.state === "elsewhere") && !!release?.apkUrl;

    return (
        <View style={[s.screen, { backgroundColor: p.scheme === "dark" ? p.bg : p.panel, paddingTop: insets.top }]}>
            <Bar title="App updates" />
            <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
                <Card style={s.card}>
                    <Text testID="update-headline" style={[s.title, { color: last?.state === "behind" ? p.accent : p.fg }]}>{h.title}</Text>
                    <Text style={[s.detail, { color: p.fgDim }]}>{h.detail}</Text>
                    <View style={[s.builds, { borderTopColor: p.border }]}>
                        <View style={s.buildRow}>
                            <Text style={[s.buildLabel, { color: p.fgDim }]}>This phone</Text>
                            <Text style={[s.buildValue, { color: p.fg }]}>{short(BUILD.sha)}{day(BUILD.committedAt) ? ` · ${day(BUILD.committedAt)}` : ""}</Text>
                        </View>
                        {release ? (
                            <View style={s.buildRow}>
                                <Text style={[s.buildLabel, { color: p.fgDim }]}>Newest</Text>
                                <Text style={[s.buildValue, { color: p.fg }]}>{short(release.sha)}{newestDay ? ` · ${newestDay}` : ""}</Text>
                            </View>
                        ) : null}
                    </View>
                    {installable ? (
                        <View style={s.actions}>
                            <Button primary title={installTitle(u.download)} busy={u.download.state === "installing"} disabled={u.download.state === "downloading"} onPress={() => void downloadAndInstall()} />
                            {u.download.state === "downloading" && u.download.fraction !== null ? (
                                <View style={[s.track, { backgroundColor: p.panel2 }]}><View style={[s.fill, { backgroundColor: p.accent, width: `${Math.round(u.download.fraction * 100)}%` }]} /></View>
                            ) : null}
                            {u.download.state === "failed" ? <Text style={[s.detail, { color: p.err }]}>{u.download.error}</Text> : null}
                            <Text style={[s.note, { color: p.fgFaint }]}>
                                {release?.apkSize ? `${(release.apkSize / 1e6).toFixed(0)} MB. ` : ""}The first time, Android asks whether this app may install apps; after that it only asks you to confirm.
                            </Text>
                        </View>
                    ) : null}
                    {!u.off ? (
                        <View style={s.actions}>
                            <Button small title="Check now" busy={u.checking} onPress={() => void checkNow(true)} />
                            {u.last ? <Text style={[s.note, { color: p.fgFaint }]}>Last checked {when(u.last.checkedAt)}.</Text> : null}
                        </View>
                    ) : null}
                </Card>

                {last?.state === "behind" ? groupChanges(last.changes).map((g) => (
                    <View key={g.kind}>
                        <Text style={[s.group, { color: p.fgDim }]}>{g.title}</Text>
                        <Card style={s.list}>
                            {g.changes.map((c, i) => (
                                <Pressable key={c.sha} accessibilityRole={c.url ? "link" : undefined} disabled={!c.url} onPress={() => c.url && void Linking.openURL(c.url)}
                                    style={({ pressed }) => [s.change, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border }, pressed && { backgroundColor: p.panel2 }]}>
                                    <Text style={[s.changeText, { color: p.fg }]}>
                                        {c.scope ? <Text style={{ color: p.fgFaint }}>{c.scope} · </Text> : null}{c.subject}
                                    </Text>
                                    {c.at ? <Text style={[s.note, { color: p.fgFaint }]}>{day(c.at)}</Text> : null}
                                </Pressable>
                            ))}
                        </Card>
                    </View>
                )) : null}
                {last?.state === "behind" && last.commits > last.changes.length ? (
                    <Text style={[s.foot, { color: p.fgFaint }]}>GitHub lists the newest {last.changes.length} of {last.commits}.</Text>
                ) : null}
                {release?.pageUrl ? (
                    <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(release.pageUrl!)}>
                        <Text style={[s.foot, { color: p.accent }]}>Open the release on GitHub</Text>
                    </Pressable>
                ) : null}
            </ScrollView>
        </View>
    );
}

const s = StyleSheet.create({
    // The screen, on the grouped-list ground like Settings.
    screen: { flex: 1 },
    // The status card at the top.
    card: { marginHorizontal: SIZE.gutter, marginTop: 8, padding: 16, gap: 6 },
    // "A newer build is out".
    title: { fontSize: SIZE.heading + 2, fontWeight: "600" },
    // The sentence under a headline, and a failure's words.
    detail: { fontSize: 14.5, lineHeight: 20 },
    // The two builds, under a rule.
    builds: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 10, paddingTop: 10, gap: 6 },
    // One build: its label and its commit and day.
    buildRow: { flexDirection: "row", justifyContent: "space-between" },
    // "This phone", "Newest".
    buildLabel: { fontSize: SIZE.small },
    // The commit and the day, in the code face so hashes line up.
    buildValue: { fontSize: SIZE.small, fontFamily: "monospace" },
    // The install and check buttons, with their notes.
    actions: { marginTop: 12, gap: 8 },
    // The download's progress bar.
    track: { height: 4, borderRadius: 2, overflow: "hidden" },
    // How much of it is done.
    fill: { height: 4 },
    // A small line under a button.
    note: { fontSize: 12.5, lineHeight: 17 },
    // A group's label ("New", "Fixed") above its card.
    group: { fontSize: 13, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase", paddingHorizontal: SIZE.gutter + 12, paddingTop: 22, paddingBottom: 8 },
    // A group's card of commits: its rows carry their own padding, so the card's is taken off.
    list: { marginHorizontal: SIZE.gutter, overflow: "hidden", padding: 0, gap: 0 },
    // One commit: its subject, and the day it landed.
    change: { paddingHorizontal: 16, paddingVertical: 12, gap: 2 },
    // A commit's subject, its scope dimmed in front.
    changeText: { fontSize: 15, lineHeight: 21 },
    // Lines under everything: a truncated list, the release link.
    foot: { fontSize: 13, lineHeight: 18, paddingHorizontal: SIZE.gutter + 12, paddingTop: 16 },
});
