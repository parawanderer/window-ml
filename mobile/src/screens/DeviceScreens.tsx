// DeviceScreens.tsx — THE ACCOUNT'S DEVICES, from this phone: who is on it, what each may do, removing one (Devices),
// and pairing a new one by the code it shows (Pair: look the code up, compare fingerprints, choose what it may do,
// confirm). The chat page's Devices tab (src/pairing/devices-ui.tsx, pairing-ui.tsx `PairDevice`) as phone screens; the
// calls go to the page's `PairingApi` over the bridge, and its sentences are the page's.

import { useCallback, useEffect, useState } from "react";
import { Alert, Keyboard, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Plus } from "lucide-react-native";
import { groupFour, profileOf, profilesFor, removalWarning, roleName, SCOPES, type Grant, type Membership } from "../../../src/pairing/api";
import type { DeviceInfo } from "../../../src/session/session-host";
import { useEmbed } from "../embed";
import { seen } from "../format";
import type { Routes } from "../routes";
import { SIZE, usePalette } from "../theme";
import { Button, Card, Field } from "../ui";
import { Bar } from "./AccountScreens";
import { QrScanner } from "../scanner";

/** The chosen named grant's fill: the palette's accent at a tenth, as the page tints it (`.pair-profile.on`). A neutral
 *  grey read as DISABLED rather than as chosen, which is the opposite of what a selected row is for. Alpha rather than
 *  a mixed colour, because it has to sit on whichever theme's surface is under it. */
const selectedTint = (accent: string) => `${accent}1a`;

/** A scope's name in words, or the id itself for one this app does not know. */
const scopeLabel = (id: string) => SCOPES.find((x) => x.id === id)?.label ?? id;

/** The account's devices. */
export function DevicesScreen() {
    const p = usePalette();
    const insets = useSafeAreaInsets();
    const nav = useNavigation<NativeStackNavigationProp<Routes>>();
    const e = useEmbed();
    const [me, setMe] = useState<Membership | null>(null);
    const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const load = useCallback(async () => {
        const [m, d] = await Promise.all([e.pairing<Membership | null>("load"), e.pairing<DeviceInfo[]>("devices")]);
        if (m.ok) setMe(m.value);
        if (d.ok) { setDevices(d.value); setError(null); } else setError(d.error);
    }, [e]);
    useEffect(() => { void load(); }, [load]);
    const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

    const remove = (d: DeviceInfo) => {
        // The page's own sentence (`removalWarning`), not a second telling of it: this is the last thing read before
        // something that cannot be undone from here, and the holder of `may_revoke` is the case worth getting right.
        Alert.alert(`Remove ${d.label}?`, removalWarning(d),
            [{ text: "Keep it", style: "cancel" }, { text: d.mayRevoke ? "Remove it anyway" : "Remove", style: "destructive", onPress: async () => {
                const r = await e.pairing<string>("revoke", { principal: d.principal });
                if (!r.ok) setError(r.error); else void load();
            } }]);
    };

    return (
        <View style={[s.flex, { backgroundColor: p.scheme === "dark" ? p.bg : p.panel, paddingTop: insets.top }]}>
            <Bar title="Devices" />
            <ScrollView contentContainerStyle={[s.content, { paddingBottom: insets.bottom + 32 }]}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={p.fgFaint} />}>
                {me?.mayPair ? (
                    <Pressable accessibilityRole="button" onPress={() => nav.navigate("Pair")} style={({ pressed }) => [s.pairRow, { backgroundColor: p.scheme === "dark" ? p.panel : p.bg }, pressed && { opacity: 0.8 }]}>
                        <View style={[s.plus, { backgroundColor: p.fg }]}><Plus size={18} color={p.bg} /></View>
                        <Text style={[s.pairText, { color: p.fg }]}>Pair a device</Text>
                    </Pressable>
                ) : null}
                {error ? <Text style={[s.error, { color: p.err }]}>{error}</Text> : null}
                {devices?.map((d) => {
                    const self = !!me?.principal && d.principal === me.principal;
                    const expired = d.notAfterMs != null && d.notAfterMs < Date.now();
                    return (
                        <Card key={d.principal} style={s.device}>
                            <View style={s.deviceHead}>
                                <Text style={[s.deviceName, { color: p.fg }]} numberOfLines={1}>{d.label}</Text>
                                {self ? <Text style={[s.tag, { color: p.accent, borderColor: p.accent }]}>this phone</Text> : null}
                            </View>
                            <Text style={[s.meta, { color: p.fgDim }]}>
                                {roleName(d.role).replace(/^a /, "")} · {expired ? "expired" : d.lastSeenMs ? seen(d.lastSeenMs) : "not seen yet"}
                            </Text>
                            {d.scopes.length || d.mayPair || d.mayRevoke ? (
                                <View style={s.pills}>
                                    {d.scopes.map((sc) => <Text key={sc} style={[s.scope, { color: p.fgDim, backgroundColor: p.panel2 }]}>{scopeLabel(sc)}</Text>)}
                                    {d.mayPair ? <Text style={[s.scope, { color: p.fgDim, backgroundColor: p.panel2 }]}>Pairs devices</Text> : null}
                                    {/* WHICH ROW SIGNS REVOCATIONS is the thing a person needs before acting, which is why
                                        it is on the row and not only in the warning: exactly one device holds it, and
                                        removing that one is the removal that cannot be undone by pairing again. */}
                                    {d.mayRevoke ? <Text style={[s.scope, { color: p.fgDim, backgroundColor: p.panel2 }]}>Signs revocations</Text> : null}
                                </View>
                            ) : null}
                            {/* Offered on every device but this phone: the page refuses, in its words, one this phone may not remove. */}
                            {!self ? <View style={s.removeRow}><Button small danger title="Remove" onPress={() => remove(d)} /></View> : null}
                        </Card>
                    );
                })}
            </ScrollView>
        </View>
    );
}

/** A device waiting under a code, as the page found it: what it is, the fingerprint to compare, the grant to give. */
interface Found { token: string; label: string; role: string; fingerprint: string; grant: Grant; grantable: string[] | null; checked?: boolean }

/** Pairing a new device: its code, then the comparison and the grant, then confirm. */
export function PairScreen() {
    const p = usePalette();
    const insets = useSafeAreaInsets();
    const nav = useNavigation();
    const e = useEmbed();
    const [code, setCode] = useState("");
    const [found, setFound] = useState<Found | null>(null);
    const [scopes, setScopes] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [paired, setPaired] = useState<string | null>(null);

    // A scanned code is checked by the page against the fingerprint it carries; a typed one is compared by eye below.
    const [scanning, setScanning] = useState(false);
    const scanned = async (text: string) => {
        setScanning(false);
        setError(null);
        setBusy(true);
        const r = await e.pairing<Found>("lookupScanned", { text });
        setBusy(false);
        if (!r.ok) { setError(r.error); return; }
        setFound(r.value);
        setScopes(r.value.grant.scopes);
    };
    const lookup = async () => {
        setError(null);
        setBusy(true);
        const r = await e.pairing<Found>("lookupOffer", { code });
        setBusy(false);
        if (!r.ok) { setError(r.error); return; }
        setFound(r.value);
        setScopes(r.value.grant.scopes);
    };
    const confirm = async () => {
        if (!found) return;
        setError(null);
        setBusy(true);
        const r = await e.pairing("confirmOffer", { token: found.token, grant: { ...found.grant, scopes } });
        setBusy(false);
        if (r.ok) setPaired(found.label); else setError(r.error);
    };
    const may = (id: string) => found?.grantable == null || found.grantable.includes(id);

    return (
        <KeyboardAvoidingView behavior="padding" style={[s.flex, { backgroundColor: p.bg, paddingTop: insets.top }]}>
            <Bar title="Pair a device" />
            <ScrollView contentContainerStyle={[s.content, { paddingBottom: insets.bottom + 32 }]} keyboardShouldPersistTaps="handled">
                {paired ? (
                    <Card>
                        <Text style={[s.title, { color: p.fg }]}>Paired</Text>
                        <Text style={[s.body, { color: p.fgDim }]}>{paired} is in the account now.</Text>
                        <Button primary title="Done" onPress={() => nav.goBack()} />
                    </Card>
                ) : found ? (
                    <Card>
                        <Text style={[s.title, { color: p.fg }]}>{found.label}</Text>
                        <Text style={[s.body, { color: p.fgDim }]}>{roleName(found.role)[0].toUpperCase() + roleName(found.role).slice(1)} waiting to join.</Text>
                        {found.checked ? (
                            <Text style={[s.body, { color: p.ok }]}>Scanned: the QR code named this device's keys, and they match.</Text>
                        ) : (
                            <View style={[s.compare, { backgroundColor: p.scheme === "dark" ? p.panel2 : p.panel }]}>
                                <Text style={[s.small, { color: p.fgDim }]}>Its fingerprint, as this phone computes it</Text>
                                <Text selectable style={[s.fp, { color: p.fg }]}>{groupFour(found.fingerprint)}</Text>
                                <Text style={[s.hint, { color: p.fgDim }]}>The new device shows its own. Pair only if the two match exactly.</Text>
                            </View>
                        )}
                        <Text style={[s.small, { color: p.fgDim }]}>What it may do</Text>
                        {/* THE NAMED GRANTS, the same ones and the same words as the page's (src/pairing/api.ts): one
                            tap for the answer a person can actually give while holding the phone up to a QR code. The
                            switches stay below, and which profile is lit is DERIVED from them, so a switch flicked by
                            hand moves it to Custom by itself and the two can never disagree. `custom` is a label here,
                            not a row to tap: choosing it would do nothing, since the scopes already are what they are. */}
                        {profilesFor(found.grantable).filter((pr) => pr.scopes).map((pr) => {
                            const on = profileOf(scopes) === pr.id;
                            return (
                                <Pressable key={pr.id} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={pr.label}
                                    onPress={() => setScopes([...pr.scopes!])}
                                    style={[s.profile, { borderColor: on ? p.accent : p.border, backgroundColor: on ? selectedTint(p.accent) : "transparent" }]}>
                                    <Text style={[s.body, { color: p.fg, fontWeight: "600" }]}>{pr.label}</Text>
                                    <Text style={[s.hint, { color: p.fgFaint }]}>{pr.detail}</Text>
                                </Pressable>
                            );
                        })}
                        {profileOf(scopes) === "custom" ? (
                            <View style={[s.profile, { borderColor: p.accent, backgroundColor: selectedTint(p.accent) }]}>
                                <Text style={[s.body, { color: p.fg, fontWeight: "600" }]}>Custom</Text>
                                <Text style={[s.hint, { color: p.fgFaint }]}>Chosen one by one, below.</Text>
                            </View>
                        ) : null}
                        {SCOPES.filter((sc) => may(sc.id)).map((sc) => (
                            <View key={sc.id} style={s.scopeRow}>
                                <View style={{ flex: 1 }}>
                                    <Text style={[s.body, { color: p.fg }]}>{sc.label}</Text>
                                    <Text style={[s.hint, { color: p.fgFaint }]}>{sc.detail}</Text>
                                </View>
                                {/* `testID` so a flow taps the SWITCH: its accessibility label is the scope's name, which the
                                    Text beside it also carries, and the first match is the label, where a tap does nothing. */}
                                <Switch testID={`scope-${sc.id}`} value={scopes.includes(sc.id)} onValueChange={(on) => setScopes((x) => on ? [...x, sc.id] : x.filter((y) => y !== sc.id))}
                                    trackColor={{ true: p.accent, false: p.panel2 }} thumbColor="#ffffff" ios_backgroundColor={p.panel2} accessibilityLabel={sc.label} />
                            </View>
                        ))}
                        {error ? <Text style={[s.error, { color: p.err }]}>{error}</Text> : null}
                        <Button primary title={found.checked ? "Pair it" : "They match: pair it"} busy={busy} onPress={confirm} />
                        <Button title="Cancel" onPress={() => { setFound(null); setCode(""); }} />
                    </Card>
                ) : (
                    <Card>
                        <Text style={[s.body, { color: p.fgDim }]}>{e.pairingInfo?.canScan ? "On the new device, choose Join an account. It shows a QR code and a typed code: scan the first, or type the second here." : "On the new device, choose Join an account. It shows a code: type it here."}</Text>
                        {e.pairingInfo?.canScan ? <Button primary title="Scan its QR code" busy={busy && scanning} onPress={() => { Keyboard.dismiss(); setScanning(true); }} /> : null}
                        <Field testID="code-field" label="Its code" value={code} onChangeText={setCode} placeholder="7K3M Q9XD" autoCapitalize="characters" mono autoFocus={!e.pairingInfo?.canScan} />
                        {error ? <Text style={[s.error, { color: p.err }]}>{error}</Text> : null}
                        <Button primary={!e.pairingInfo?.canScan} title="Find it" busy={busy} disabled={code.replace(/[\s-]/g, "").length < 4} onPress={lookup} />
                    </Card>
                )}
            </ScrollView>
            <QrScanner open={scanning} onScanned={(t) => void scanned(t)} onClose={() => setScanning(false)} />
        </KeyboardAvoidingView>
    );
}

const s = StyleSheet.create({
    // A screen that fills what it is given.
    flex: { flex: 1 },
    // The scrolling body, cards stacked with room between them.
    content: { padding: SIZE.gutter, gap: 12 },
    // "Pair a device": a row at the top of the list, a filled plus and the words.
    pairRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: SIZE.radius + 2 },
    // The plus in its circle.
    plus: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
    // "Pair a device".
    pairText: { fontSize: SIZE.text, fontWeight: "600" },
    // A device's card, tighter than a form's.
    device: { gap: 8 },
    // The device's name and its "this phone" tag.
    deviceHead: { flexDirection: "row", alignItems: "center", gap: 8 },
    // The device's name.
    deviceName: { fontSize: SIZE.heading, fontWeight: "600", flexShrink: 1 },
    // "this phone": an outlined tag.
    tag: { fontSize: 12, fontWeight: "600", borderWidth: 1, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1, overflow: "hidden" },
    // What the device is and when it was seen.
    meta: { fontSize: 13.5 },
    // Its scopes, as pills that wrap.
    pills: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    // One scope: a small filled pill, as the page draws it.
    scope: { fontSize: 12.5, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 10, overflow: "hidden" },
    // A card's heading.
    title: { fontSize: SIZE.heading, fontWeight: "700" },
    // Running text.
    body: { fontSize: 15, lineHeight: 22 },
    // A small label.
    small: { fontSize: 13, fontWeight: "600" },
    // A small faint line.
    hint: { fontSize: 12.5, lineHeight: 18 },
    // The fingerprint to compare, in a raised box.
    compare: { borderRadius: 12, padding: 12, gap: 6 },
    // The fingerprint itself, in the code face.
    fp: { fontSize: 20, fontWeight: "600", letterSpacing: 1, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) },
    // Remove, small, at the card's end: an action on the device, not what the card is for.
    removeRow: { flexDirection: "row", justifyContent: "flex-end" },
    // A scope with its switch.
    scopeRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    // ONE NAMED GRANT: its name and what it means, on a surface that says whether it is the one chosen. Stacked rather
    // than a segmented strip, as on the page, because each carries a sentence a strip would have to drop.
    profile: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, gap: 1 },
    // Why it failed.
    error: { fontSize: 14, lineHeight: 20 },
});
