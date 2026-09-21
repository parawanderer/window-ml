// viewer.tsx — AN IMAGE, FULL SCREEN: what the page's `openImage` opens (a transcript image, or "Look at the page"'s
// capture of a run's tab). Pinch and drag to read small print on a screenshot, double-tap to zoom in or back out,
// and a share button for keeping it. Over everything, including the session layer, because it is opened from there.

import { useEffect } from "react";
import { Image, Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import { Share2, X } from "lucide-react-native";

/** How far in a pinch or a double-tap goes. */
const MAX_ZOOM = 6;
const TAP_ZOOM = 2.5;

/** Keep an image for the share sheet: a `data:` URL is written to the cache first, since a share needs a file. */
function shareImage(src: string): void {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(src);
    if (!m) { void Sharing.shareAsync(src); return; }
    const ext = m[1].split("/")[1]?.replace("jpeg", "jpg") || "png";
    const f = new File(Paths.cache, `image-${Date.now().toString(36)}.${ext}`);
    f.create();
    f.write(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)));
    void Sharing.shareAsync(f.uri, { mimeType: m[1] });
}

/** The full-screen image, or nothing while `src` is null. */
export function ImageViewer({ src, onClose }: { src: string | null; onClose: () => void }) {
    const insets = useSafeAreaInsets();
    const scale = useSharedValue(1);
    const base = useSharedValue(1);
    const x = useSharedValue(0);
    const y = useSharedValue(0);
    const startX = useSharedValue(0);
    const startY = useSharedValue(0);
    // Each image opens at its fitted size.
    useEffect(() => { scale.value = 1; base.value = 1; x.value = 0; y.value = 0; }, [src]);

    const pinch = Gesture.Pinch()
        .onUpdate((e) => { scale.value = Math.min(MAX_ZOOM, Math.max(1, base.value * e.scale)); })
        .onEnd(() => {
            base.value = scale.value;
            if (scale.value === 1) { x.value = withTiming(0); y.value = withTiming(0); }
        });
    // Dragging moves a zoomed image; at its fitted size there is nothing to move.
    const pan = Gesture.Pan()
        .averageTouches(true)
        .onStart(() => { startX.value = x.value; startY.value = y.value; })
        .onUpdate((e) => { if (scale.value > 1) { x.value = startX.value + e.translationX; y.value = startY.value + e.translationY; } });
    const doubleTap = Gesture.Tap()
        .numberOfTaps(2)
        .onEnd(() => {
            const next = scale.value > 1 ? 1 : TAP_ZOOM;
            scale.value = withTiming(next);
            base.value = next;
            if (next === 1) { x.value = withTiming(0); y.value = withTiming(0); }
        });
    const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }] }));

    return (
        <Modal visible={!!src} animationType="fade" statusBarTranslucent onRequestClose={onClose} supportedOrientations={["portrait", "landscape"]}>
            {/* A Modal is its own native root on Android: gestures inside it need their own handler root. */}
            <GestureHandlerRootView style={s.root}>
                <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)}>
                    <Animated.View style={[s.fill, style]} accessible accessibilityRole="image" accessibilityLabel="Image, full size">
                        {src ? <Image source={{ uri: src }} style={s.fill} resizeMode="contain" /> : null}
                    </Animated.View>
                </GestureDetector>
                <View style={[s.bar, { top: insets.top + 8 }]} pointerEvents="box-none">
                    <Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={10} onPress={onClose} style={({ pressed }) => [s.btn, pressed && { opacity: 0.6 }]}>
                        <X size={22} color="#fff" />
                    </Pressable>
                    {src ? (
                        <Pressable accessibilityRole="button" accessibilityLabel="Share image" hitSlop={10} onPress={() => shareImage(src)} style={({ pressed }) => [s.btn, pressed && { opacity: 0.6 }]}>
                            <Share2 size={20} color="#fff" />
                        </Pressable>
                    ) : null}
                </View>
            </GestureHandlerRootView>
        </Modal>
    );
}

const s = StyleSheet.create({
    // Black behind the image, whatever the theme: a picture reads best on it.
    root: { flex: 1, backgroundColor: "#000" },
    // The image's box: the whole screen, the image fitted inside it.
    fill: { flex: 1, width: "100%" },
    // Close at the left, share at the right, under the status bar.
    bar: { position: "absolute", left: 12, right: 12, flexDirection: "row", justifyContent: "space-between" },
    // A round button that stays legible over any picture.
    btn: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.5)" },
});
