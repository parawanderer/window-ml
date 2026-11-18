// secret-input.tsx — a text box for a secret (an API key, a passphrase) with an eye that shows or hides what was typed.

import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { IconEye, IconEyeOff } from "./icons";
import { cursorTipOn } from "./ui-kit";

/**
 * A SECRET'S TEXT BOX: hidden as dots until the eye is pressed, and hidden again on the next press. Every field that takes
 * an API key or a passphrase uses it, so a mistyped one can be checked before it is saved, the same way on every page.
 * Takes an `<input>`'s own props; `type` is the one it decides. It is not a `label`: the caller's own label wraps it. A value that
 * changes from OUTSIDE (a key the popup saved while this panel was open) hides the text again, whatever the eye was; what the
 * person types here is the input's own report and never does.
 * @group settings
 * @gallery {"value": "sk-example-1234", "placeholder": "API key"}
 */
export function SecretInput(p: JSX.InputHTMLAttributes<HTMLInputElement>) {
    const [shown, setShown] = useState(false);
    const typed = useRef(p.value);   // state: ui — the last value this input reported, to tell a keystroke from a change made elsewhere
    useEffect(() => { if (p.value !== typed.current) { typed.current = p.value; setShown(false); } }, [p.value]);
    const onInput = (e: JSX.TargetedInputEvent<HTMLInputElement>): void => {
        typed.current = e.currentTarget.value;
        if (typeof p.onInput === "function") p.onInput.call(e.currentTarget, e);
    };
    const tip = shown ? "Hide" : "Show";
    return (
        <span class="secret-input">
            <input {...p} onInput={onInput} type={shown ? "text" : "password"} />
            <button type="button" class="icon-btn secret-eye" aria-label={`${tip} what is typed`} aria-pressed={shown} disabled={p.disabled}
                {...cursorTipOn("Show or hide what is typed")} onClick={() => setShown((v) => !v)}>
                {shown ? <IconEyeOff /> : <IconEye />}
            </button>
        </span>
    );
}
