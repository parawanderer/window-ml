// secret-input.tsx — a text box for a secret (an API key, a passphrase) with an eye that shows or hides what was typed.

import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { IconEye, IconEyeOff } from "./icons";
import { cursorTipOn } from "./ui-kit";

/**
 * A SECRET'S TEXT BOX: hidden as dots until the eye is pressed, and hidden again on the next press. Every field that takes
 * an API key or a passphrase uses it, so a mistyped one can be checked before it is saved, the same way on every page.
 * Takes an `<input>`'s own props; `type` is the one it decides. It is not a `label`: the caller's own label wraps it.
 * @group settings
 * @gallery {"value": "sk-example-1234", "placeholder": "API key"}
 */
export function SecretInput(p: JSX.InputHTMLAttributes<HTMLInputElement>) {
    const [shown, setShown] = useState(false);
    const tip = shown ? "Hide" : "Show";
    return (
        <span class="secret-input">
            <input {...p} type={shown ? "text" : "password"} />
            <button type="button" class="icon-btn secret-eye" aria-label={`${tip} what is typed`} aria-pressed={shown} disabled={p.disabled}
                {...cursorTipOn("Show or hide what is typed")} onClick={() => setShown((v) => !v)}>
                {shown ? <IconEyeOff /> : <IconEye />}
            </button>
        </span>
    );
}
