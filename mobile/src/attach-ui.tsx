// attach-ui.tsx — THE IMAGES ATTACHED TO A BOX, on screen: the hook that holds them per box, the thumbnail strip above
// it (tap to see one full size, × to take it off), and the sheet that picks more (attach.ts does the picking and the
// shrinking). The session composer (layer.tsx) and the new-chat screen use the same three.

import { useRef, useState, type RefObject } from "react";
import { ActivityIndicator, Image, Keyboard, Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { ImagePlus, X } from "lucide-react-native";
import { MAX_IMAGES, pickImages } from "./attach";
import { useEmbed } from "./embed";
import { usePalette } from "./theme";
import { IconButton, Sheet, SheetRow } from "./ui";

/** Images attached to a box and not yet sent, by box, kept while the app runs (attach.ts says why not longer). */
const attached = new Map<string, string[]>();

/** A box's attachments: what is attached, whether a pick is still shrinking, and the ways to change them. */
export interface Attachments {
    imgs: string[];
    picking: boolean;
    /** full: no room for another image, or a pick is under way */
    full: boolean;
    sheet: RefObject<BottomSheetModal | null>;
    /** Take them all off, returning what was attached (a send hands them to the runtime). */
    take(): string[];
    /** Put images back in front of any attached since (a send that failed). */
    restore(sent: string[]): void;
    remove(i: number): void;
    pick(from: "library" | "camera"): Promise<void>;
}

/** The attachments of the box `key` (a session key, or "start" for the new-chat box). */
export function useAttachments(key: string): Attachments {
    const e = useEmbed();
    const [imgs, setState] = useState<string[]>(() => attached.get(key) ?? []);
    const [picking, setPicking] = useState(false);
    const sheet = useRef<BottomSheetModal>(null);
    const set = (f: (a: string[]) => string[]) => setState((a) => {
        const n = f(a).slice(0, MAX_IMAGES);
        if (n.length) attached.set(key, n); else attached.delete(key);
        return n;
    });
    return {
        imgs, picking, sheet,
        full: imgs.length >= MAX_IMAGES || picking,
        take: () => { const t = imgs; set(() => []); return t; },
        restore: (sent) => { if (sent.length) set((a) => [...sent, ...a]); },
        remove: (i) => set((a) => a.filter((_, j) => j !== i)),
        pick: async (from) => {
            sheet.current?.dismiss();
            setPicking(true);
            try {
                const r = await pickImages(from, imgs);
                if (r.images.length) set((a) => [...a, ...r.images]);
                if (r.problem) e.say(r.problem);
            } catch {
                e.say("That image could not be read.");
            } finally {
                setPicking(false);
            }
        },
    };
}

/** The attach button, for a box's left end: it opens the attach sheet. */
export function AttachButton({ att, style }: { att: Attachments; style?: object }) {
    return (
        <IconButton label="Attach an image" disabled={att.full} icon={(col) => <ImagePlus size={20} color={col} />}
            onPress={() => { Keyboard.dismiss(); att.sheet.current?.present(); }} style={style} />
    );
}

/** The attached images, in a strip above the box; nothing while there are none. */
export function AttachedStrip({ att }: { att: Attachments }) {
    const e = useEmbed();
    const p = usePalette();
    if (!att.imgs.length && !att.picking) return null;
    return (
        <ScrollView horizontal style={s.strip} contentContainerStyle={s.row} keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false}>
            {att.imgs.map((src, i) => (
                <View key={i}>
                    <Pressable accessibilityRole="imagebutton" accessibilityLabel={`Attached image ${i + 1}`} onPress={() => e.openImage(src)}>
                        <Image source={{ uri: src }} style={[s.img, { borderColor: p.border }]} />
                    </Pressable>
                    <Pressable accessibilityRole="button" accessibilityLabel={`Remove image ${i + 1}`} hitSlop={8}
                        onPress={() => att.remove(i)} style={[s.x, { backgroundColor: p.fg }]}>
                        <X size={12} color={p.bg} strokeWidth={3} />
                    </Pressable>
                </View>
            ))}
            {att.picking ? <View style={[s.img, s.wait, { borderColor: p.border, backgroundColor: p.panel }]}><ActivityIndicator color={p.fgDim} /></View> : null}
        </ScrollView>
    );
}

/** Where an image comes from: the library or the camera. */
export function AttachSheet({ att }: { att: Attachments }) {
    return (
        <Sheet ref={att.sheet} title="Attach an image" note={`Up to ${MAX_IMAGES} per message, made smaller to travel over the hub.`}>
            <SheetRow title="Photo library" onPress={() => void att.pick("library")} />
            <SheetRow title="Take a photo" onPress={() => void att.pick("camera")} />
        </Sheet>
    );
}

const s = StyleSheet.create({
    // The strip of attached images, above the box.
    strip: { flexGrow: 0, marginBottom: 8 },
    // Its row, with room for each image's remove button to overhang.
    row: { gap: 10, paddingTop: 6, paddingRight: 6, paddingLeft: 4 },
    // One attached image, a small rounded square.
    img: { width: 64, height: 64, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
    // A photo still being made smaller: a spinner where it will be.
    wait: { alignItems: "center", justifyContent: "center" },
    // The ×, over the image's top-right corner.
    x: { position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center" },
});
