// code-morph-demo.tsx — the packed-to-reformatted code transition (code-morph.ts) on a baked script, run on a click, with
// the approval card that arrives beside it and leaves when answered. The calm chat's motion, so it draws its own `.chat.calm`.

import { useRef, useState } from "preact/hooks";
import { Code } from "../ui-kit";
import { noteLiveGlyphs } from "./code-morph";

const BAKED = `const out = [];
for (const argv of [["uname", "-a"], ["pwd"], ["ls", "-la"], ["git", "status", "--short", "--branch"]]) {
  try {
    const r = await ml.sh.run(argv, { expectMs: 8000 });
    out.push({ argv: argv.join(" "), ok: r.ok, code: r.code });
  } catch (e) { out.push({ argv: argv.join(" "), error: e.code + ": " + e.message }); }
}
return out;`;

/**
 * A script as the model streams it (packed), and on "Run" the reformatted block taking over with its characters flying
 * to their places while the approval card fades in over the same beat, as when an approval opens on a call that was
 * just typed. "Approve" sends the card away; "Again" puts the packed text back.
 *
 * @gallery-flow unfold tests/gallery-flows/CodeMorphDemo.mjs
 * @group transcript
 */
export function CodeMorphDemo({ code = BAKED }: { code?: string }) {
    const [done, setDone] = useState(false);
    const [leaving, setLeaving] = useState(false);
    const [gone, setGone] = useState(false);
    const live = useRef<HTMLDivElement>(null);
    const toggle = (): void => {
        if (!done && live.current) noteLiveGlyphs(live.current);   // what the live call does as it unmounts
        setLeaving(false); setGone(false);
        setDone(!done);
    };
    const answer = (): void => { setLeaving(true); setTimeout(() => setGone(true), 340); };
    return (
        <div class="chat calm" style={{ maxWidth: "560px", background: "transparent" }}>
            <button class="code-morph-run" onClick={toggle}>{done ? "Again" : "Run"}</button>
            {done
                ? <Code key="fmt" text={code} lang="javascript" format />
                : <div key="live" ref={live}><Code text={code} lang="javascript" /></div>}
            {done && !gone ? (
                <div class={`astep-approve ask${leaving ? " leaving" : ""}`}>
                    <div class="appr-ask">Agent wants to <b>run</b> the JavaScript on the page.</div>
                    <div class="appr-row"><button class="code-morph-deny" onClick={answer}>Deny</button><button class="code-morph-approve" onClick={answer}>Approve</button></div>
                </div>
            ) : null}
        </div>
    );
}
