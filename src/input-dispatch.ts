// input-dispatch.ts — W3C pointer/keyboard event properties for input dispatch: the keyboard code
// table and the per-stage parameter builders that give CDP `Input.dispatch*Event` calls and synthetic
// DOM events the fields a hardware mouse/keyboard actually produces (pressure, `code`, button state).

/** One physical key press: the three naming systems a KeyboardEvent carries (`key` = the value it
 *  produces, `code` = the physical key, `keyCode`/`which` = the legacy Windows VK — the browser
 *  derives `which` from this on CDP dispatch), the text it inserts, the DOM `location` (0 standard,
 *  1 left, 2 right, 3 numpad), and whether the form is shifted (so the caller holds Shift). */
export interface KeySpec {
    key: string;
    code: string;
    keyCode: number;
    text: string;
    /** The text a press inserts with Shift released — `unmodifiedText` on the event. */
    unmodifiedText: string;
    location: number;
    shift: boolean;
}

/** A row of the US-layout keyboard code table: the physical key and the `key`/`text` it produces
 *  unshifted and shifted. `text` is what a press inserts ("" for a non-printing key). */
interface PhysicalKey {
    code: string;
    keyCode: number;
    key: string;
    text?: string;
    shiftKey?: string;
    shiftText?: string;
    location?: number;
}

const MOD_SHIFT = 8;   // CDP Input.modifiers bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8

// The standard US layout (the KeyboardEvent code table). Letters and digits are generated; the rest
// is the punctuation and named keys a `type` / submit can reach.
const LETTERS: PhysicalKey[] = "abcdefghijklmnopqrstuvwxyz".split("").map((ch) => {
    const up = ch.toUpperCase();
    return { code: `Key${up}`, keyCode: up.charCodeAt(0), key: ch, text: ch, shiftKey: up, shiftText: up };
});
const DIGIT_SHIFTS = [")", "!", "@", "#", "$", "%", "^", "&", "*", "("];
const DIGITS: PhysicalKey[] = "0123456789".split("").map((d, i) => ({
    code: `Digit${d}`, keyCode: d.charCodeAt(0), key: d, text: d, shiftKey: DIGIT_SHIFTS[i], shiftText: DIGIT_SHIFTS[i],
}));
const REST: PhysicalKey[] = [
    { code: "Space", keyCode: 32, key: " ", text: " ", shiftKey: " ", shiftText: " " },
    { code: "Enter", keyCode: 13, key: "Enter", text: "\r" },
    { code: "Tab", keyCode: 9, key: "Tab", text: "\t" },
    { code: "Escape", keyCode: 27, key: "Escape" },
    { code: "Backspace", keyCode: 8, key: "Backspace" },
    { code: "Delete", keyCode: 46, key: "Delete" },
    { code: "Insert", keyCode: 45, key: "Insert" },
    { code: "Home", keyCode: 36, key: "Home" },
    { code: "End", keyCode: 35, key: "End" },
    { code: "PageUp", keyCode: 33, key: "PageUp" },
    { code: "PageDown", keyCode: 34, key: "PageDown" },
    { code: "ArrowLeft", keyCode: 37, key: "ArrowLeft" },
    { code: "ArrowUp", keyCode: 38, key: "ArrowUp" },
    { code: "ArrowRight", keyCode: 39, key: "ArrowRight" },
    { code: "ArrowDown", keyCode: 40, key: "ArrowDown" },
    { code: "Minus", keyCode: 189, key: "-", text: "-", shiftKey: "_", shiftText: "_" },
    { code: "Equal", keyCode: 187, key: "=", text: "=", shiftKey: "+", shiftText: "+" },
    { code: "BracketLeft", keyCode: 219, key: "[", text: "[", shiftKey: "{", shiftText: "{" },
    { code: "BracketRight", keyCode: 221, key: "]", text: "]", shiftKey: "}", shiftText: "}" },
    { code: "Backslash", keyCode: 220, key: "\\", text: "\\", shiftKey: "|", shiftText: "|" },
    { code: "Semicolon", keyCode: 186, key: ";", text: ";", shiftKey: ":", shiftText: ":" },
    { code: "Quote", keyCode: 222, key: "'", text: "'", shiftKey: "\"", shiftText: "\"" },
    { code: "Backquote", keyCode: 192, key: "`", text: "`", shiftKey: "~", shiftText: "~" },
    { code: "Comma", keyCode: 188, key: ",", text: ",", shiftKey: "<", shiftText: "<" },
    { code: "Period", keyCode: 190, key: ".", text: ".", shiftKey: ">", shiftText: ">" },
    { code: "Slash", keyCode: 191, key: "/", text: "/", shiftKey: "?", shiftText: "?" },
    { code: "F1", keyCode: 112, key: "F1" }, { code: "F2", keyCode: 113, key: "F2" },
    { code: "F3", keyCode: 114, key: "F3" }, { code: "F4", keyCode: 115, key: "F4" },
    { code: "F5", keyCode: 116, key: "F5" }, { code: "F6", keyCode: 117, key: "F6" },
    { code: "F7", keyCode: 118, key: "F7" }, { code: "F8", keyCode: 119, key: "F8" },
    { code: "F9", keyCode: 120, key: "F9" }, { code: "F10", keyCode: 121, key: "F10" },
    { code: "F11", keyCode: 122, key: "F11" }, { code: "F12", keyCode: 123, key: "F12" },
    { code: "CapsLock", keyCode: 20, key: "CapsLock" },
    { code: "NumLock", keyCode: 144, key: "NumLock" },
    { code: "ScrollLock", keyCode: 145, key: "ScrollLock" },
    { code: "ContextMenu", keyCode: 93, key: "ContextMenu" },
    { code: "ShiftLeft", keyCode: 16, key: "Shift", location: 1 },
    { code: "ShiftRight", keyCode: 16, key: "Shift", location: 2 },
    { code: "ControlLeft", keyCode: 17, key: "Control", location: 1 },
    { code: "ControlRight", keyCode: 17, key: "Control", location: 2 },
    { code: "AltLeft", keyCode: 18, key: "Alt", location: 1 },
    { code: "AltRight", keyCode: 18, key: "Alt", location: 2 },
    { code: "MetaLeft", keyCode: 91, key: "Meta", location: 1 },
    { code: "MetaRight", keyCode: 92, key: "Meta", location: 2 },
];
const TABLE: PhysicalKey[] = [...LETTERS, ...DIGITS, ...REST];
const SHIFT_LEFT = TABLE.find(k => k.code === "ShiftLeft")!;
const ENTER = TABLE.find(k => k.code === "Enter")!;

const specOf = (k: PhysicalKey, shift: boolean): KeySpec => ({
    key: shift ? (k.shiftKey ?? k.key) : k.key,
    code: k.code,
    keyCode: k.keyCode,
    text: shift ? (k.shiftText ?? k.text ?? "") : (k.text ?? ""),
    unmodifiedText: k.text ?? "",
    location: k.location ?? 0,
    shift,
});

/** The hardware press that produces `ch` (a single character, "\n"/"\r", or a named key like
 *  `"Enter"` or `"ShiftLeft"`). Shifted forms report `shift: true` so the caller holds Shift. */
export function keyPress(ch: string): KeySpec | null {
    if (ch === "\n" || ch === "\r") return specOf(ENTER, false);
    for (const k of TABLE) {
        if (k.key === ch || k.code === ch) return specOf(k, false);
        if (k.shiftKey === ch || k.shiftText === ch) return specOf(k, true);
    }
    return null;
}

/** The press for a character the US layout does not name (an IME code point): `key` is the
 *  character, `code` "" (there is no physical key), keyCode its code point — what a driver sends
 *  when its layout has no row for the character. */
export function fallbackPress(ch: string): KeySpec {
    return { key: ch, code: "", keyCode: ch.toUpperCase().charCodeAt(0) || 0, text: ch, unmodifiedText: ch, location: 0, shift: false };
}

const shiftHold = (): KeySpec => specOf(SHIFT_LEFT, false);

/** One step of a typed sequence: a modifier hold/release, or a character press (the caller emits
 *  down+up around a press, down for a hold and up for a release). */
export type TypeStep =
    | { kind: "hold"; spec: KeySpec }
    | { kind: "release"; spec: KeySpec }
    | { kind: "press"; spec: KeySpec };

/** The steps that type `text` the way hardware does: a Shift hold around each shifted character,
 *  then Enter when `submit`. A character with no US-layout key uses {@link fallbackPress}. */
export function typeSteps(text: string, submit = false): TypeStep[] {
    const steps: TypeStep[] = [];
    for (const ch of String(text)) {
        const spec = keyPress(ch) ?? fallbackPress(ch);
        if (spec.shift) {
            steps.push({ kind: "hold", spec: shiftHold() });
            steps.push({ kind: "press", spec });
            steps.push({ kind: "release", spec: shiftHold() });
        } else {
            steps.push({ kind: "press", spec });
        }
    }
    if (submit) steps.push({ kind: "press", spec: specOf(ENTER, false) });
    return steps;
}

/** The `Input.dispatchMouseEvent` parameters for one stage of a left-button interaction at viewport
 *  (x, y): the values a hardware mouse produces (W3C Pointer Events: pressure 0.5 while a button is
 *  down on a device that does not report pressure, 0 otherwise; `buttons` is the depressed-button
 *  bitmask). The browser fills clientX/Y, pageX/Y (scroll-relative), screenX/Y (window-relative) and
 *  movementX/Y (delta from its prior coordinate state) from the viewport point — so a move is sent
 *  first, which is also what establishes that prior state. */
export function cdpMouseEvent(
    type: "mouseMoved" | "mousePressed" | "mouseReleased",
    x: number,
    y: number,
): Record<string, unknown> {
    const press = type === "mousePressed";
    const release = type === "mouseReleased";
    return {
        type,
        x,
        y,
        pointerType: "mouse",
        button: type === "mouseMoved" ? "none" : "left",
        buttons: press ? 1 : 0,
        ...(press || release ? { clickCount: 1 } : {}),
        force: press ? 0.5 : 0,
    };
}

/** A whole left-click at viewport (x, y) as the CDP calls to make, in order: move (establishes the
 *  prior coordinate state `movementX/Y` is measured from), press, release. */
export function cdpClickPlan(x: number, y: number): Record<string, unknown>[] {
    return [
        cdpMouseEvent("mouseMoved", x, y),
        cdpMouseEvent("mousePressed", x, y),
        cdpMouseEvent("mouseReleased", x, y),
    ];
}

/** The `Input.dispatchKeyEvent` parameters for one press or release of `spec`. A press carries
 *  `text` so the character is inserted (like a real keypress); both carry `code`, the virtual key
 *  codes (`keyCode`/`which`) and `location`. `modifiers` is the CDP bitmask of the modifier keys
 *  held (Shift=8) — the browser turns it into `shiftKey`/`altKey`/`ctrlKey`/`metaKey` on the event. */
export function cdpKeyEvent(
    kind: "down" | "up",
    spec: KeySpec,
    modifiers = 0,
): Record<string, unknown> {
    return {
        type: kind === "down" ? "keyDown" : "keyUp",
        key: spec.key,
        code: spec.code,
        windowsVirtualKeyCode: spec.keyCode,
        nativeVirtualKeyCode: spec.keyCode,
        location: spec.location,
        modifiers,
        ...(kind === "down" && spec.text ? { text: spec.text, unmodifiedText: spec.unmodifiedText } : {}),
    };
}

/** Every `Input.dispatchKeyEvent` call for `text` (and Enter when `submit`): per {@link typeSteps}
 *  entry a down and an up (a hold or release is one call), so `shiftKey`/`key`/`text` agree the way
 *  hardware leaves them. */
export function cdpTypePlan(text: string, submit = false): Record<string, unknown>[] {
    const calls: Record<string, unknown>[] = [];
    for (const step of typeSteps(text, submit)) {
        if (step.kind === "hold") calls.push(cdpKeyEvent("down", step.spec, MOD_SHIFT));
        else if (step.kind === "release") calls.push(cdpKeyEvent("up", step.spec, 0));
        else {
            calls.push(cdpKeyEvent("down", step.spec, step.spec.shift ? MOD_SHIFT : 0));
            calls.push(cdpKeyEvent("up", step.spec, step.spec.shift ? MOD_SHIFT : 0));
        }
    }
    return calls;
}

// --- the same stages as synthetic DOM event inits (the cdp-off path) ---

/** The PointerEvent init for one stage of a left click at (x, y). `pressure` is W3C's value for a
 *  mouse (0.5 down, 0 up — the hardware does not report pressure). */
export function pointerInit(
    type: "pointermove" | "pointerdown" | "pointerup",
    x: number,
    y: number,
    screenX: number,
    screenY: number,
    movementX = 0,
    movementY = 0,
): PointerEventInit {
    return {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        screenX,
        screenY,
        movementX,
        movementY,
        button: 0,
        buttons: type === "pointerdown" ? 1 : 0,
        detail: type === "pointermove" ? 0 : 1,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        width: 1,
        height: 1,
        pressure: type === "pointerdown" ? 0.5 : 0,
    };
}

/** The MouseEvent init for one stage of a left click at (x, y) — `button` 0 (primary), `buttons` the
 *  depressed bitmask, `detail` the click count, `bubbles`/`cancelable`/`composed` set explicitly. */
export function mouseInit(
    type: "mousemove" | "mousedown" | "mouseup" | "click",
    x: number,
    y: number,
    screenX: number,
    screenY: number,
    movementX = 0,
    movementY = 0,
): MouseEventInit {
    return {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        screenX,
        screenY,
        movementX,
        movementY,
        button: 0,
        buttons: type === "mousedown" ? 1 : 0,
        detail: type === "mousemove" ? 0 : 1,
    };
}

/** A whole left-click as the synthetic events to dispatch, in order: pointer/mouse move, then
 *  pointer/mouse down, then pointer/mouse up, then click — the same sequence the browser produces
 *  from a CDP click. `movementX/Y` is the delta from `prior` (the move into the point; the events at
 *  the point itself have none). */
export function syntheticClickPlan(
    x: number,
    y: number,
    screenX: number,
    screenY: number,
    prior?: { x: number; y: number },
): Array<{ type: string; init: MouseEventInit | PointerEventInit; pointer?: boolean }> {
    const dx = prior ? x - prior.x : 0;
    const dy = prior ? y - prior.y : 0;
    return [
        { type: "pointermove", init: pointerInit("pointermove", x, y, screenX, screenY, dx, dy), pointer: true },
        { type: "mousemove", init: mouseInit("mousemove", x, y, screenX, screenY, dx, dy) },
        { type: "pointerdown", init: pointerInit("pointerdown", x, y, screenX, screenY, 0, 0), pointer: true },
        { type: "mousedown", init: mouseInit("mousedown", x, y, screenX, screenY, 0, 0) },
        { type: "pointerup", init: pointerInit("pointerup", x, y, screenX, screenY, 0, 0), pointer: true },
        { type: "mouseup", init: mouseInit("mouseup", x, y, screenX, screenY, 0, 0) },
        { type: "click", init: mouseInit("click", x, y, screenX, screenY, 0, 0) },
    ];
}

/** The KeyboardEvent init for a press or release of `spec` (the cdp-off path; the event type is the
 *  caller's). The legacy `keyCode`/`which` ride along because the constructor drops them and a
 *  listener still reads them; copy them onto the event with `Object.defineProperty` after construction. */
export function keyInit(
    spec: KeySpec,
    mods: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {},
): KeyboardEventInit & { keyCode: number; which: number } {
    return {
        bubbles: true,
        cancelable: true,
        composed: true,
        key: spec.key,
        code: spec.code,
        location: spec.location,
        repeat: false,
        ...mods,
        keyCode: spec.keyCode,
        which: spec.keyCode,
    };
}
