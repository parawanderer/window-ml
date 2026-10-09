// run-lane.tsx — the entry a run's own page (run.md.html) loads: its event lane, drawn from the events the harness put
// in the page as inert JSON (`#wml-lane-data`), with the component the bench's sweep timeline uses.

import { render } from "preact";
import { RunLane } from "./lane-view";

const data = document.getElementById("wml-lane-data");
const mount = document.getElementById("wml-lane");
if (data && mount) {
    try {
        const { events, now } = JSON.parse(data.textContent || "{}");
        render(<RunLane events={events || []} now={now} />, mount);
    } catch { /* a page whose data did not parse keeps its transcript; the lane is extra */ }
}
