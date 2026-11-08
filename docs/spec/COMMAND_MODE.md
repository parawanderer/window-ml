# Command mode: a typed cell as the person's turn

Status: IDEA (Shane, 2026-11-08, through the chat-page lane, CONFIRMED by Shane in the coordinator's session the same day; nothing built, nothing scheduled). This file
records the idea, the refinements Shane agreed to, his rulings on the open questions, and what is still open, so that
whoever builds it starts from the decisions rather than from the conversation. It is a sibling of
`docs/spec/AGENT_SKILLS.md`: a REPL-lane idea spec.

## The idea

If the first character typed into the composer is `!`, the composer enters COMMAND MODE. A command runs in one of
three environments, and its result goes to the model as the PERSON's turn, not as a tool result:

| Mode | Where it runs | What it sees |
| --- | --- | --- |
| Python | the run's Python sandbox | the run's one namespace (per worker-hosted run), so a person can set up `df` for the model |
| JS | the isolated-world exec, the same path an approved exec takes | `ml.current`, `@tool:` and `@file:` pointers, the page's DOM; NOT the read-only dialect |
| bash | the process host (`ml.sh`) | offered only while the run has a host connected |

The editor highlights and suggests as a code editor does. Enter runs the cell with a progress indicator and the same
streamed output as a tool cell; then the code, the environment that ran it and the output go to the model, all marked
as the person's. Backspace on an empty editor leaves the mode and keeps a literal `!`.

## Refinements Shane agreed to (2026-11-08)

- **Typing it is the approval.** A command runs with the person's authority, so command mode can be entered only from
  the extension's OWN surfaces (the sidebar, the DevTools panel, the chat page, the phone app). A page can never enter
  it; text the MODEL writes that starts with `!` is text.
- **The model receives** the code, which environment ran it, and the output, marked as the person's. Long output
  follows the file and long-paste rule (FILE_ATTACHMENTS.md, #1492): the head inline, the rest behind a pointer, what
  was held back named.
- **Python shares the run's namespace**, one per worker-hosted run, as the bench's kept variables do.
- **JS runs in the isolated-world exec**, where `ml.current` and pointers already resolve; never in the read-only
  dialect, which exists for UNAPPROVED code and this is approved by construction.
- **Bash is offered only when the run has a host.**
- **The `!` is a chip, not text.** Enter runs; Shift+Enter adds a newline. Modes switch with Ctrl/Cmd+1/2/3, plus a
  pill on the phone, because Tab is needed for indentation. The last mode is a per-device UI preference.
- **Mid-run**, a command arrives like a mid-run message or file (#1492's rule). Esc or Stop cancels it and keeps the
  output so far, marked as cut off.

## Rulings (Shane, 2026-11-08, confirmed)

1. **A typed cell needs no approval**, in `full` Python mode too. Shane's words: "The `!` concept in general would only
   work from isolated surfaces, not from the API. As of right now." A later API form of command mode REOPENS this
   ruling; it is not grandfathered.
2. **Provenance lives in `ml.current.meta`**, so the model can tell the person's cell from its own when it reads the
   run's history later.
3. **A "run, then add a sentence" variant exists** (`!df.describe()` then "why is the max so high?"). Which key does
   which is NOT decided.

## The security property, stated now

The no-approval ruling rests entirely on one boundary, so the property is part of the spec from the first line, and
becomes failing-first rows when the feature is built (AGENTS.md: a new `ml.*` member, tool or page-started message type
gets a red-team pass):

- A `!` arriving in a page-started message, in anything relayed from a page, in a model's text, in a steer the model
  wrote, or through any API form, is TEXT. Nothing it contains runs.
- Command mode is entered only by a keystroke in one of the extension's own surfaces, and the message the composer
  sends names the mode, the code and the run; the worker refuses that message from any sender with `sender.tab` set,
  the way `PYTHON_INTERRUPT` and `MANIFESTS` are refused.
- A command's output reaching the model is marked as the person's and cannot be forged by a page or by the model: the
  marking is set only by the worker on the path from the composer, as the `task` inbox origin is.
- The person's authority is the RUN's: a command cannot reach a run the composer is not attached to, nor another
  principal's Python namespace.

## Ownership if built: split

- **The chat-page lane** owns the composer: the chip, the three modes and their keys, the editor's highlighting and
  suggestions (the Python bench's editor is the candidate to reuse; a guess, not checked), the per-device mode
  preference, the phone pill, the mid-run arrival, and the same palette on the calm view and `mobile/`.
- **The REPL side** (today the async lane) owns the three runtimes behind ONE entry point: the isolated-world exec for
  JS, the run's Python namespace, bash through the host; the output cell's streaming and pointer rule; the
  provenance in `ml.current.meta`; and the worker-side refusal of the message from any page sender.
- **The seam** is one message from the composer to the worker naming `{ mode, code, runId }`, answered with the same
  streamed output a tool cell gets. The red-team pass (e3) covers that message and the marking.

## Open

- Which key runs, and which runs-then-asks (ruling 3).
- Whether a command's cell appears in the transcript as a new event kind (the `agent-task-say` precedent) or as a
  person bubble with a code block; the chat-page lane decides when it builds.
- Whether the JS mode's exec is judged like an approved exec (policies, effects) or runs free as the person's own
  code; the no-approval ruling says free, EFFECTS.md may want the record anyway.
- Cost: nothing new for the prompt until a cell runs; the cell's text is the person's turn and pays as one.

## What is a guess

- That the person's cell can reuse the approved isolated-world exec path unchanged.
- That the Python bench's editor is the one to reuse for highlighting.
- Checked by the chat-page lane: nothing on main mentions a command mode or a `!` prefix.
