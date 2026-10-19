// pinned-rows.tsx — THE PINNED GROUP'S ROWS, which a long press lifts and a drag puts in a new order: the phone's
// half of the page's drag (src/chat/pin-reorder.ts), with the geometry shared (src/chat/pin-order.ts).
//
// A LONG PRESS ALREADY MEANT "this session's actions", so it still does: the row lifts under the thumb at the long
// press, and letting go without moving opens the sheet, as on a home screen. Moving drags. The list stops scrolling
// while a row is up, so the thumb moves the row and not the page under it.
//
// EVERY ROW IS PLACED BY A SHARED VALUE KEYED BY ITS SESSION, never by where React put it. The first version moved
// rows by transform and cleared the transforms when the new order was committed; the clear reached the screen in a
// frame and the list's re-render took about seven, so the old order flashed back between them (seen frame by frame
// on an emulator). Placed by key, a row is where its value says whatever order React draws the children in, so
// committing the order moves nothing and there is no race left to lose.
//
// The rows are one block inside one list cell rather than a cell each, so the lifted row can be drawn over its
// neighbours: a list cell cannot reliably rise above the next one.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { dropIndex, moved, shifts, type Slot } from "../../src/chat/pin-order";
import { keyOf } from "./format";
import type { SessionSummary } from "../../src/session/session-host";

/** How long a thumb rests on a row before it lifts: shorter than the system's long press, so the lift wins it. */
const LIFT_MS = 350;
/** How far a lifted row may move and still count as a long press that opens the sheet. */
const STILL_PX = 8;
/** The settle into a slot, on the page's curve and at the page's length. */
const SETTLE = { duration: 180, easing: Easing.bezier(0.2, 0.8, 0.2, 1) };
/** A row's height before it has been measured: a list row's (ListScreen `row`, 64pt and its padding). */
const ROW_GUESS = 72;

/**
 * The pinned sessions, in the order given, each drawn by `row`. `onOrder` receives every key in a new order after a
 * drag; `onActions` opens a session's sheet after a long press that did not move; `onLift` says when a row is up, so
 * the list can stop scrolling. `lift` is the background a lifted row takes, so it reads as raised on either theme.
 */
export function PinnedRows({ rows, row, onOrder, onActions, onLift, lift }: {
    rows: SessionSummary[];
    row: (s: SessionSummary, moveBy: (d: -1 | 1) => void) => ReactNode;
    onOrder: (keys: string[]) => void;
    onActions: (key: string) => void;
    onLift: (up: boolean) => void;
    lift: string;
}) {
    const keys = rows.map(keyOf);
    const heights = useRef(new Map<string, number>());
    const [measured, setMeasured] = useState(0);
    /** Each row's top, by session key. */
    const tops = useSharedValue<Record<string, number>>({});
    /** The lifted row's key, or "" when none is up. */
    const drag = useSharedValue("");
    /** The lifted row's top as the thumb holds it. */
    const held = useSharedValue(0);
    /** Off until the rows have their first places, so they do not slide in from the top on the first frame. */
    const eased = useSharedValue(false);
    const slotsOf = (order: readonly string[]): Slot[] => {
        let top = 0;
        return order.map((k) => { const height = heights.current.get(k) ?? ROW_GUESS; const s = { top, height }; top += height; return s; });
    };
    const place = (order: readonly string[]) => {
        const slots = slotsOf(order);
        tops.value = Object.fromEntries(order.map((k, i) => [k, slots[i].top]));
    };
    const total = slotsOf(keys).reduce((n, s) => n + s.height, 0);
    // The order or a height changed (a drag committed, a pin came or went, a title wrapped): every row to its slot. A
    // committed drag has already put them there, so this moves nothing then.
    const order = keys.join("\n");
    useEffect(() => {
        place(keys);
        const first = !eased.value;
        if (first) requestAnimationFrame(() => { eased.value = true; });
    }, [order, measured]);

    const move = (from: number, d: -1 | 1) => {
        const to = from + d;
        if (to < 0 || to >= keys.length) return;
        onOrder(moved(keys, from, to));
    };
    const gesture = (key: string) => Gesture.Pan()
        .runOnJS(true)
        .activateAfterLongPress(LIFT_MS)
        .onStart(() => {
            if (drag.value) return;
            held.value = tops.value[key] ?? 0;
            drag.value = key;
            onLift(true);
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        })
        .onUpdate((g) => {
            if (drag.value !== key) return;
            const i = keys.indexOf(key);
            const slots = slotsOf(keys);
            const last = slots[slots.length - 1];
            const dy = Math.max(-slots[i].top, Math.min(g.translationY, last.top + last.height - slots[i].top - slots[i].height));
            held.value = slots[i].top + dy;
            const at = shifts(slots, i, dropIndex(slots, i, dy));
            tops.value = Object.fromEntries(keys.map((k, j) => [k, slots[j].top + (j === i ? 0 : at[j])]));
        })
        .onEnd((g) => {
            if (drag.value !== key) return;
            onLift(false);
            const i = keys.indexOf(key);
            const slots = slotsOf(keys);
            const to = Math.hypot(g.translationX, g.translationY) < STILL_PX ? i : dropIndex(slots, i, held.value - slots[i].top);
            const next = moved(keys, i, to);
            // Every row to its slot in the NEW order, the lifted one easing down from where the thumb left it; then the
            // order is stored, which redraws nothing that moves.
            place(next);
            drag.value = "";
            if (to !== i) onOrder(next);
            else if (Math.hypot(g.translationX, g.translationY) < STILL_PX) onActions(key);
        })
        .onFinalize(() => { if (drag.value === key) { onLift(false); drag.value = ""; place(keys); } });

    return (
        <View style={{ height: total }}>
            {rows.map((s, i) => {
                const k = keyOf(s);
                return (
                    <GestureDetector key={k} gesture={gesture(k)}>
                        <Placed k={k} tops={tops} drag={drag} held={held} eased={eased} lift={lift}
                            onLayout={(e: LayoutChangeEvent) => {
                                const h = e.nativeEvent.layout.height;
                                if (heights.current.get(k) !== h) { heights.current.set(k, h); setMeasured((n) => n + 1); }
                            }}>
                            {row(s, (d) => move(i, d))}
                        </Placed>
                    </GestureDetector>
                );
            })}
        </View>
    );
}

/** One pinned row, at its session's place: under the thumb while it is the one up, easing to its slot otherwise. */
function Placed({ k, tops, drag, held, eased, lift, onLayout, children }: {
    k: string; tops: SharedValue<Record<string, number>>; drag: SharedValue<string>; held: SharedValue<number>; eased: SharedValue<boolean>;
    lift: string; onLayout: (e: LayoutChangeEvent) => void; children: ReactNode;
}) {
    const style = useAnimatedStyle(() => {
        const up = drag.value === k;
        const top = tops.value[k] ?? 0;
        return {
            transform: [{ translateY: up ? held.value : eased.value ? withTiming(top, SETTLE) : top }, { scale: withTiming(up ? 1.02 : 1, SETTLE) }],
            zIndex: up ? 2 : 0,
            elevation: up ? 8 : 0,
            shadowOpacity: withTiming(up ? 0.25 : 0, SETTLE),
            backgroundColor: up ? lift : "transparent",
        };
    });
    return (
        <Animated.View onLayout={onLayout}
            style={[{ position: "absolute", left: 0, right: 0, top: 0, borderRadius: 12, shadowColor: "#000", shadowRadius: 12, shadowOffset: { width: 0, height: 6 } }, style]}>
            {children}
        </Animated.View>
    );
}
