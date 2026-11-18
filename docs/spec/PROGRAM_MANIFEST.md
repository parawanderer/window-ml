# Spec (WIP): program manifests, what a shell call is described by

**Status: draft, nothing built.** Split out of [`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md) on
2026-10-15, because the shell's free tier ([`SHELL.md`](SHELL.md)) needs a much smaller thing than the library manifest
and should not wait on its cost model. A program manifest describes a PROGRAM the way a library manifest describes a
function; it never decides anything ([`POLICIES.md`](POLICIES.md) decides).

## What a program manifest says

Per program, subcommand and flag:

| Field | What | Why |
| --- | --- | --- |
| `effects` | in the shared algebra ([`EFFECTS.md`](EFFECTS.md)): `read(fs)`, `write(fs)`, `write-names(fs)` (the program creates, removes or renames an ENTRY at the path rather than writing bytes into it in place: `mkdir`, `rm`, `mv`, and every editor that writes a temp file and renames it over the target, `sed -i`, `perl -i`, npm's `write-file-atomic`; added 2026-10-19 so that the atomic-rename rule in [`SHELL.md`](SHELL.md) is claimable), `exec(process)`, `read(net(host))` or `write(net(host))`; `unknown` for a flag it does not know | the free tier and every policy read it |
| `paths` | which arguments are paths, so the host can `realpath` them and judge `inRoot` and `secret` | an argument the manifest does not mark is not a path the host can vouch for, and the call asks |
| `writtenOperands` | `"last"` on a command whose operands are paths: only the last path operand is written (`cp a b dir`), the others read; absent, a command whose effects write writes EVERY path operand, which fails closed (2026-11-13, [`FILE_ATTACHMENTS.md`](FILE_ATTACHMENTS.md) H9) | each path argument's `role` says read or write, so the host can refuse a write into `attached/` at `spawn` while a copy out of it runs |
| `operands` | where the program's operands start, and whether it honours `--` or `--end-of-options` | a value from a variable that starts with `-` is an option to the program; the host puts the terminator there |
| `runner` | the flags that start other programs (`find -exec`, `xargs`, `git -c core.pager`, `npm run`, `env`) | never free on the program's own word |
| `echoes` | whether it prints its environment or its inputs (`env`, `printenv`, `set`, `curl -v`) | a secret in the env reaches stdout; refused with a secret present, scrubbed otherwise |
| `okCodes` | exit codes that are answers, not failures (`grep` 1, `diff` 1) | `ok` and pipefail |
| `env` | environment variables that change what it does (`PAGER`, `GIT_EXTERNAL_DIFF`, `LD_PRELOAD`) | the REFUSED list, and the forced values the host sets for this program (`git`: `core.fsmonitor=false` and `core.pager=cat` through `GIT_CONFIG_COUNT`; never an empty `diff.external`, which makes every `git diff` fail; the external diff is suppressed by the `harden` flags, `--no-ext-diff`) |
| `recursive` | whether a directory argument means everything beneath it (`rg`, `grep -r`, `find`, `ls -R`, `tar`, `du`) | the host computes `containsSecret` for such an argument ([`SHELL.md`](SHELL.md)) |
| `configRunsCode` | for a program whose own config can make a read run code (`git`), the keys to look for | the `repoConfigRunsCode` fact |
| `credential` + `network` | top level, a SHIPPED manifest only: `credential: { provider }` names a credential the process host holds and injects (`CREDENTIAL_PROVIDERS` in `program-manifest.ts`, window-ml-host `src/credential.rs`; v1 `github`, gh's alone) and `network: { ports, hosts? }` the ports and host names its call may reach, each a subset of the provider's (`[443]`; GitHub's six hosts), `hosts` absent meaning all of them; no path or env name comes from the manifest (2026-11-08; `hosts` 2026-11-09) | the credentialed profile of host-sandbox: the host honours it only for manifest bytes it pinned, and the call always asks. A stored or proposed manifest naming either is refused (`shippedOnlyRefusal`), and only the shipped object itself is sent a credential. The pinned bytes' sha256 and the host commit holding them are `src/shell/credential-pins.json`: an edit to such a manifest fails `tests/gh-manifest.test.mjs` until a host release carries it |

**No cost tiers.** A process is metered by the host's time limit and output cap, not by a survey's step budget: a
survey that calls `ml.sh` waits on a promise, and the dialect's steps measure interpreter work, not the person or the
host. (The earlier sentence in `SHELL.md` charging a process to the step budget was wrong for that reason.)

### The delete family (`rm`, `mv`, `rmdir`, `unlink`, `git rm`, `git mv`; 2026-10-22)

A delete, a rename and a create of a directory entry are `write-names` on the operand: `rm`, `rmdir`, `unlink` on each operand, `mv` on EVERY operand (the sources, and the destination operand itself: the narrow reading, since a manifest cannot know that `mv a dir` creates `dir/a`). A recursive flag (`rm -r`, `-R`) walks the operand, so the host answers `containsSecret`; `mv` and `git mv` are `recursive` at the command level, since moving a directory renames everything beneath it with no flag (the same red-team pass: `mv src/keep src/keep2` renamed `src/keep/.env` free). Flags that exist on one platform only (`rm -I -P -W -x`, GNU long options, `mv -t -T -b -S -u`, `rmdir -p`) are not listed, so the call is `unknown`. Four command keys carry what `cat` and `ls` never needed:

- `optionsFirst`: GNU permutes options and operands (`rm a -r` is recursive), BSD stops at the first operand (`rm a -r` removes two files; `rm a -- -b` removes a file named `--` as well). An argument starting with `-` after an operand, `--` included, makes the call `unknown`. Which parser stops is the program's, not the platform's: macOS `cat`, `head`, `tail`, `wc`, `ls`, `sed` stop, while macOS `grep` and `sort` permute (measured 2026-11-17). **The rule:** a command without `optionsFirst` must name a parser MEASURED to permute on every supported platform (rg, jq, git and gh parse their own argv; `find` has its own grammar), or a flag after an operand is described as a flag while the program reads a file the host never resolved (`cat f -n`, with `-n` a symlink to `.env`, printed it free on main; cat, head, tail, wc and ls carry `optionsFirst` since). `AFTER_OPERAND` in `tests/program-manifest.test.mjs` holds one row per shipped manifest and fails for a new one that does neither.
- `dashIsPath`: a lone `-` is a file name (`rm -` removes the file `-`), so it stays a path operand instead of meaning stdin. macOS `head`, `tail`, `wc` and `ls` open a file named `-` too (measured by the red-team pass on #1951, 2026-11-18), so they carry it; `cat` reads stdin for `-` on both platforms and does not.
- `repoWide` (git): the command's effects also fall on the directory it acts in (`-C`, else the cwd) and on the repository's root (`resolve({ arg: "repo" })`, the host's `repo.root`; the cwd when none was found). `git rm` removes the parent directories it empties, so `git rm src/gen/only.ts` can remove the top-level `src`; a claim on the operand alone would be free under the sandbox. With `-C` and operands it is `unknown`: git resolves the operands against the `-C` directory (composing a repeated `-C`), the host against the cwd, so the host would walk the wrong path (review of #990, 2026-10-22).
- `pathspecs` (git): an operand starting with `:` is pathspec magic (`:/x` is relative to the repository root), and one holding `*`, `?`, `[` or `\` is a glob git expands to every match (or an escape: `a\*` names `a*`); neither is one path the host can resolve: `unknown`. Found by the red-team pass on #990 (2026-10-22): `git rm *.ts` removed a secret among its matches under a claim that named only `*.ts`. `--icase-pathspecs` is `unknown` for the same reason: on a case-sensitive host `Secret.ts` matches `secret.ts`, a name the host never resolved (red-team recheck, 2026-10-22). A repository with `core.ignoreCase=true` does the same without the flag; that is not caught yet.

A nested `rm` inside a root stays free under `host-sandbox` (ruled 2026-10-22): the built-in default is one algebra over effects, as it is for `find -delete` and for overwriting a file with `>`, never a per-program exception, so deleting a top-level name, a root, a secret or anything outside the roots asks and a nested delete does not; a person who wants stricter or wider writes a policy, and stored policies are judged before the built-in.

### `cp` (2026-11-13)

`src/shell/manifests/cp.json`: `read` of the sources and `write` plus `write-names` of the destination (`writtenOperands: "last"`; it overwrites in place or creates the entry), with the flags GNU and BSD share (`-f -i -n -p -v`, `-R`/`-r` walking the sources). `-a`, `-t`, `-L`/`-P`/`-H` and every long option differ between the two or change what is copied, so they are not listed and the call is `unknown`. `mv` keeps no `writtenOperands`: its sources are removed, so every operand is written, and an `mv` out of `attached/` stays refused ([`FILE_ATTACHMENTS.md`](FILE_ATTACHMENTS.md) H9).

### `gh` (the GitHub CLI; 2026-11-08)

`src/shell/manifests/gh.json`, written against `gh >=2.40.0 <3` (measured on 2.103.0). The read-only subcommands (`pr view/list/diff/checks/status`, `issue view/list`, `run view/list`, `release view/list`, `repo view`, `label list`, `search *`, `auth status`, `api` with no method, body, header or input flag) are `read` of the repository plus `read(net(*))`. Every writer says what it writes: GitHub is `write(net(*))`, a checkout, clone, merge or download adds `write` on the directory and `runs-code` (`gh` starts `git`), and a body or notes file is a read path.

- **Credentials.** The vocabulary has no term for "this request carries the person's token", and a program has no `use(secret)` (only `ml.fetch` does, `fromFetch`). So `gh`'s reads are `read(net(*))`, the same description as an anonymous `curl`; the person's identity is stated here and in the manifest's file, not in the effects. Calls that print the token (`auth token`, `auth status --show-token`/`-t`), write gh's config or credentials (`auth login/logout/refresh/setup-git`, `config set`, `alias set`, `extension install`), or send a file named inside a value (`api -F key=@path`) are `unknown`: a `write` with no path operand projects to no resource at all, so a config write cannot be declared as one. There is no way to REFUSE a call in a manifest, only to make it ask. On the plain host any authenticated `gh` call may also rewrite the credential store: gh renews and persists an expiring token (`ActiveTokenWithRefresh`, `internal/config/config.go`, used by the API client), so a described read such as `gh pr view 12` (`read(net(*))`, no path) can rewrite `~/.config/gh/hosts.yml`, a write the effects do not show. `auth status --no-refresh` is the one read that provably does not. Under host-sandbox it cannot: the stores are masked and the network is denied.
- **A flag's value is not read.** `api -X GET` cannot be told from `api -X DELETE`, so `-X`/`--method` always carries `write(net(*))`; `api graphql` needs `-f` and so asks. `--hostname`, `--web` and `--editor` are `unknown`.
- **Not free by default.** `net(*)` is covered by a bound only when the sandbox's network allowlist holds `"*"`, and `boundFor` pairs an allowlisted host with BOTH ops: with `"*"`, a write to GitHub is as free as a read (pinned as a finding in `tests/gh-manifest.test.mjs`).
- **Under the host's ordinary sandbox `gh` cannot run at all**: the profile denies the network and reads under `.config/gh` and the Keychains (gh fails reading its config); `GH_TOKEN` is not on the host's environment whitelist, and `XDG_CONFIG_HOME` is denied.
- **The credentialed profile (2026-11-08).** The manifest names `credential: { provider: "github" }` and `network: { ports: [443], hosts: [...] }`. A host whose `hello.credentials` lists `github` is sent `spawn.credential: { provider, manifest: <sha256 of this file> }` by a sandboxed session (`credentialFor`); it injects the person's token as `GH_TOKEN`, with a throwaway `GH_CONFIG_DIR`, under a profile that runs program-only (gh, git, git's https helpers) and reaches one address, a CONNECT proxy the host runs for that call, which admits only the manifest's `hosts` on its `ports` (window-ml-host 0.8.0; `HTTPS_PROXY` routes gh and git to it). The card's Sandbox line names those hosts (`ShFacts.credential.hosts`, the host's grant); a host built before the proxy names none, and the card then says any host on port 443. Such a call ALWAYS asks: `judgeCall` lets no allow policy and no free tier answer a call whose facts say `credential.held` (`ShFacts.credential`), and the card says "Sends: your GitHub token". An older host, Linux, or a gh.json newer than the host's pinned copy (`CredentialRefused`) gets none, and the card says nothing is sent. Every edit of this file therefore needs a host release that copies it before credentialed gh works again. A token gh prints (`auth token`, an approved `unknown` call) is scrubbed by its shape before the model reads it (`secret-scrub.ts`).

### `sed` and `awk`: a program inside an argument (2026-11-18)

`src/shell/manifests/sed.json` and `awk.json`. A sed script and an awk program are a second language in one argument,
and what writes a file or starts a program lives there (`w`, `r`, `e`, `s///w`, `s///e`; `system()`, `print > f`,
`cmd | getline`), never in the argv. So a command may name `script: "sed" | "awk"`: its first operand is the program
(`paths: {operandsFrom: 1}`), unless a flag marked `script` gave it (`sed -e`, with `pathsFrom: 0`, so every operand is
then a file; several `-e` are joined by newlines), and the text is checked by a narrow grammar
(`src/shell/script-grammar.ts`). Text outside the grammar makes the call `unknown`, so it asks; nothing is interpreted.

- **sed** (`sedScriptRefusal`). Only the commands `s y p P d D n N q = h H g G x { } !`, separated by `;` or newlines;
  an address is a line number (not 0), `$` or `/re/`, or a range of two; `s` flags are `g`, `p`, `i`, `I` and a number;
  `q` with an exit code under a detected GNU only. Everything else is refused, whichever sed would accept it: `w`, `W`,
  `r`, `R`, `e`, `F` and the `s` flags `w`, `e`, `m`, `M`; labels and branches; `a`, `i`, `c`; comments (`#n`
  included); GNU's address forms (`0,/re/`, `first~step`, `addr,+N`) and `\cREc`. A newline inside an `s` or `y` part
  is refused, since macOS sed reads the script line by line and GNU does not.
- **Where a regular expression ends.** Both seds skip a bracket expression whole when they look for the delimiter
  (`s/[/]/x/` is one regex to both), but by different rules: GNU's `snarf_char_class` (sed/compile.c) lets a `[` after
  a class's closing `:` keep it closing, and macOS's `compile_ccl` (Apple text_cmds) needs `:]` exactly, so
  `s/[[:a:[]/]/Q/w F` is a `w F` to GNU and unbalanced to macOS. `script-grammar.ts` ports both scanners and describes a
  regular expression only when the two end it at the same character. Measured (2026-11-18, gsed 4.10 and macOS 26.7):
  over 1,735 random bracket-heavy regexes, `s/<r>/Q/w F` created the file `F` exactly when each port said the
  replacement and flags fall where they do; no disagreement for either. GNU opens and truncates a `w` file while it
  parses, even when the script then fails to compile, so a script a sed rejects is not one that did nothing.
- **awk** (`awkProgramRefusal`). Checked WITHOUT a lexer, by substrings, so no string, regular expression or comment
  hides anything: the program holds none of `system`, `getline`, `ENVIRON`, `ARGV`, `ARGC`, `PROCINFO` and `@` (gawk's
  `@include`, `@load` and indirect calls), no `|` outside `||`, and no `>` after its first `print` (every output
  redirection needs a `print` or `printf` before its `>`). A program that compares with `>` after a print, or prints
  the word `system`, is refused too: that only asks. Only `-F`, `-v` and `--` are listed; an operand of the form
  `name=value` (`AWK_ASSIGNMENT`) is an assignment awk never opens, so it is no path.
- **Flavours.** sed declares both: `-i` is GNU's attached suffix (`attachedValue`, `values: [""]`: `-i` and `-ni`
  described, `-i.bak` and `-in` not) and BSD's separate one (`value`, `values: [""]`: `-i ''` described, `-i -e …`,
  where `-e` is the suffix, not); `-l` takes a value in GNU only; GNU permutes and is hardened with `--sandbox` (4.3+:
  the program itself refuses `e`, `r` and `w`), BSD stops at the first operand. An undetected sed reads the core alone,
  so `-i` is `unknown` there. awk declares `bsd` alone, hardened with `-safe` (measured: macOS awk refuses `system` and
  `print >` at parse time and empties `ENVIRON`): gawk and mawk are installed under their own names (`/usr/bin/awk`
  links to `gawk` or `mawk`), so they are `other` and a Linux awk asks.
- **A lone `-`** is a file to macOS sed and stdin to GNU (measured), so sed claims it as a path (`dashIsPath`); every
  awk reads stdin.

## Pinning

A library manifest is pinned to a content hash of one build. A program cannot be, in general: `git` is whatever the
machine has. A program manifest names the program and a version range, the host records the RESOLVED path and the
version it reports with every call, and a program outside the range is `unknown`. A container image can pin exactly.
The BSD coreutils on macOS (`ls`, `cat`, `wc`, `head`, `tail`, `find`) report no version at all: such a manifest has
`range: "*"`, takes no version arguments, and lists only flags with the same meaning in GNU and BSD (2026-10-15).

**When the version is learned** (ruled 2026-10-15, lane 4 of the plan). Learning a version means RUNNING the program,
and the host spawns nothing without an explicit start, so the probe is not an exception to that rule but an ordinary
call: the shipped manifest carries a `version` entry (the arguments, the output pattern, effects empty, no runner, no
paths, a 2 s limit, stdin closed, output capped at 4 KiB), the worker judges it with the default policy like any call,
and the host spawns it on a start. Under the sandbox its effects are inside what the sandbox bounds, so it is free and
no card is raised; on the plain host nothing is bounded, so the worker does not raise the probe at all and the program
stays `unknown` there, which costs nothing since every plain-host call asks anyway. Two refusals in the worker: a
program whose resolved path is inside a workspace root is never probed (it arrived with the repository), and only a
SHIPPED manifest's probe entry is used, never arguments from a script. The result is cached per binary for the session
(realpath, device, inode, size, mtime), reported in the facts as `program.version` (`null` when unreadable), shown on
the card and written to the log. A sweep of every manifest's program at configure time was rejected: it runs binaries the
person may never call.

## Flavours: which implementation runs (BSD and GNU, ruled 2026-11-17)

A flag can mean one thing to GNU and another to BSD, or exist in only one of them (GNU `sed -i` takes an attached
suffix, BSD `sed -i` a separate one; `ln -T` is GNU's alone), and the order of options and operands is the PROGRAM's
choice, not the platform's (macOS `grep` and `sort` permute, macOS `sed` and `ls` stop at the first operand). A manifest
that declares `flavours` describes each implementation it can tell apart; one without them is read exactly as before,
whatever the facts say (the upgrade: every vector under `tests/fixtures/program-calls/` describes identically under
every flavour, `tests/program-manifest.test.mjs`).

**Which flavour runs** (`flavourOf`, `src/shell/program-manifest.ts`; pure, read from the host's facts), in this order:

1. A program inside a workspace root is never flavoured: it is undetected and never probed. (Main already refuses a
   shipped manifest for such a program, `shFacts`, ruled 2026-10-22; only the workspace's own stored manifest can
   describe one, and it then reads the core alone.)
2. A program whose resolved file has another name than the manifest's `program` (busybox, mawk behind an alternatives
   link, `gsed` behind Homebrew's `gnubin`, a multicall binary) is `other`: there is positive evidence of an
   implementation nobody described, so nothing of the manifest applies, not even the core, and the card warns.
3. On `hello.platform` `macos`, a program whose resolved file is in `/bin`, `/usr/bin`, `/sbin` or `/usr/sbin` (the
   sealed system volume) is `bsd` when the manifest declares it. Nothing runs, so this is the one detection that also holds on the plain host.
4. For a SHIPPED manifest only, a `gnu` flavour is detected by its probe: an ordinary call of `flavours.gnu.probe.args`, judged and run exactly as
   the version probe above is (under the OS sandbox only, never for an in-root program, cached by fingerprint), whose
   stdout on exit 0 matches `pattern` with group 1 inside `range`. The pattern must start with `^` (the validator
   refuses one that does not), and it is matched per line (`m`), so busybox's "This is not GNU sed" fails `^sed \(GNU
   sed\)`. What it is matched against is the version probe's bound: the first 4 KiB of stdout (`PROBE_BYTES`), read only
   on exit 0 within 2 s and only when it is not binary. On the plain host the probe is never raised, so a GNU-only flag
   is never free there. A stored or proposed manifest's probe is never run (ruled 2026-11-18, red-team #1963): its
   author chose both the probe's arguments and the program, so what it prints is the author's claim, not a measurement
   of the program. Filtering the output instead (dropping a line that equals or contains a probe argument) does not
   hold: `printf '\164ool (GNU tool) 4.9\n'` prints `tool (GNU tool) 4.9` from octal escapes, a line no argument
   contains (`tests/program-manifest.test.mjs`). Such a manifest's flavour comes only from the facts above, which its
   author does not choose; `flavours` stays allowed in it.
5. Anything else is undetected.

**The shape.** At the top level, `flavours: { gnu: { probe: { args, pattern, range } }, bsd: { system: "macos" } }`
(either or both), only with `version.range` `"*"`: the command's own `flags` are the CORE, flags with the same arity
and effects in every flavour that accepts them, with the union of the effects where they differ. A command may add
`flavour: { gnu: {…}, bsd: {…} }`, one overlay per declared flavour:

- `flags`: flags only that flavour accepts with that meaning. Overlays only ADD: a flag in both the core and an overlay
  is a validator error, so no rule decides which entry wins.
- `argOrder`: `"permute"` reads an argument starting with `-` after an operand as a flag; `"stop"` reads it, and
  everything after the first operand, `--` included, as an operand (BSD getopt). Absent, the core's `optionsFirst`.
  Under `stop`, an argument after the first operand that spells a declared flag (core or overlay; `--name`,
  `--name=v`, a whole `-name`, or any letter of a `-abc` cluster) whose meaning is more than a read (an effect other
  than `read`, a written path value, a directory value, a runner, an echo, a walk, a `pathsFrom`) makes the call ask
  (`stopShadow`): read as a file name it would drop the write the manifest declares for it, so a misread argument order
  would run a writer free. This holds for every manifest, and both describers apply it: window-ml and window-ml-host's
  `manifest.rs` agree that `tool f.txt --write-all` is not described. A cluster asks when any of its letters is such a
  flag, declared or not the rest (`-xw` with `-w` writing). After an operand, `--` is itself a file name under `stop`,
  so `tool f.txt -- --write-all` asks too; a `--` the command honours, given BEFORE any operand, ends the options for
  every implementation, so what follows it stays an operand (`tool -- f.txt --write-all` reads two files). A read-only
  flag after an operand stays a file name. The
  approval card of a flavoured draft states each overlay's `argOrder` in words, per flavour and subcommand, whatever is
  detected (`argOrderText`). A subcommand's name is the manifest's own text, so the card quotes it only when it is a
  plain word (`^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`); any other name, and what lies beneath it, is counted ("2
  subcommands whose name is not a plain word, not described here"), so a name cannot write a sentence the person reads
  as the card's, or break its line (red-team #1963). At most six readings are listed, then "and N more".
- `harden`: that flavour's hardening, after the core's (GNU `--sandbox`; `-safe` passed to gawk would parse as other
  options, so hardening cannot be shared). Each argument is a flag of the core or of that overlay.

A detected flavour reads the core and its overlay; undetected reads the core with `optionsFirst` forced; `other` reads
nothing. No two overlays are ever merged, so no read-only reading is the union of two flavours'.

**Where hardening is inserted.** `planSpawn` plans the call before any facts exist, so it hardens with the core alone.
Once the facts arrive the worker reads the version probe and the flavour (`factsFlavour`); when that flavour's plan
sends something else (its hardening, or an overlay flag whose value is a path the host must resolve),
`flavourReplan` returns it, the worker DISCARDS the first call, spawns the new plan, requires the same program file
(fingerprint; a file that changed in between is refused, not run) and describes the NEW facts. So the argv the card
shows (`facts.argv`) is the hardened one and is what starts (`tests/ml-sh.test.mjs`, condition b). A draft's evidence
run does the same (`sw-manifest-proposal.ts`).

**The facts and the card.** `ShFacts.flavour` is `{ name, how }` (`name` null when undetected), or null for a manifest
without flavours; the card's Program line adds `how` ("/usr/bin/sed, BSD (the macOS system program)").

**The process host.** window-ml-host's `manifest.rs` refuses unknown fields, so it reads no manifest that carries
`flavours` until its reader is ported (a PR labelled `@host-compat`, with its window-ml-host twin). No shipped manifest
declares flavours in this change; a vector that does is copied to the host only after the host's port has merged.

**Considered and not done.** A metadata-only walk: `du` and `ls -R` read only names and sizes beneath a directory, so a
secret file beneath it is not read, and they could skip the walk's secret check (`du -sh .` in a repository with a
`.env` asks today). Kept strict (ruled 2026-11-17, Q3): every walking reader takes the same check. The per-program
opt-in for programs that reveal other processes (`ps`, `lsof`, `top`, ruling 31) is its own change.

## Trust

As for library manifests: shipped with the extension or installed by the person; never from a page, never from the
program. A first set covers `git` (the read subcommands without their writing flags, and `rm`/`mv`), `rg`, `ls`, `cat`, `wc`, `head`,
`tail`, `find` without its effectful flags, `jq`, `rm`, `mv`, `rmdir`, `unlink`, `gh`.

## Registering a program (2026-10-15)

People have their own CLIs, and a manifest shipped with the extension cannot know them. Three things make registration
safe without making it a trust decision the person has to get right.

**The baseline needs no registration.** An unregistered program is `unknown`: it runs, and every call asks. A manifest
buys the free tier and better facts on the card (which arguments are paths, where the operands start). Registration is
about DESCRIBING a program, never about permission for it to exist.

**Under the sandbox, the description is the envelope.** A manifest's claims are not believed; they are enforced. A
call the manifest describes as `read` with no `runner` is spawned under a profile derived from that claim: writes
denied, network denied, `process-exec` of anything but the program itself denied. A wrong manifest then degrades to a
FAILING command, never to an effect, which is the same fail-closed shape as everything else here. So the two claims that
matter (`effects`, `runner`) need no one's word while the sandbox is on; the descriptive fields (`echoes`, `okCodes`,
`operands`) are low-risk, and `echoes` has the output scrubber as its belt regardless ([`SECRET_HANDLES.md`](SECRET_HANDLES.md)).
On the plain host there is no envelope: a person's own manifest is trusted on their word, and a manifest a MODEL
drafted is run in the sandbox first, over the calls it claims are reads, before it may make anything free. Evidence
before trust, the rule model-proposed policies already follow ([`POLICIES.md`](POLICIES.md)). `describeCall` stays pure
over the manifest's data so the profile is derived from the same source as the facts.

**How a program is registered.**

- The person names it. The host resolves it, and a tool the person owns is pinned: a script by its `sha256`, a binary
  (this round, B4 below) by the host's fingerprint and resolved path, both better pins than `git` can have; a changed
  script or binary drops back to `unknown`.
- A draft manifest is generated from the program's `--help`, its man page, its shell completion files (which encode
  the flags and whether they take file arguments), or—for a script in the workspace—directly from its source and
  argument parser (`parseArgs`, `argparse`, `process.argv` walk). A model with `ml.sh` enabled can draft the manifest
  for a CLI or repo script it just wrote or inspected, and it is safe because the draft reaches the person as a card
  with its evidence (`propose_manifest`, parallel to `propose_policy` in [`POLICIES.md`](POLICIES.md)) and, under the
  sandbox, is enforced rather than believed.
- Manifests have SCOPES, as policies do. A repository-local tool (`./scripts/<name>` or `node scripts/<name>.mjs`)
  arrived with the repository, so it is untrusted content, and its manifest belongs to the workspace, approved by the
  person. A tool on the person's own `PATH` may be global. A page never registers anything.
- One page lists them, like the policy page: shipped, installed, proposed, each with its source, its pin and the
  measured evidence (calls run under it, failures under its envelope). It lives in DevTools Settings, the superset.
  Built in root K slice d (Settings, "Program manifests (ml.sh)"): the person writes the manifest as JSON and picks
  every workspace or one root; the host pins it, as it pins a draft, and nothing runs.

**The store, ruled 2026-10-23** (coordinator, on the `[window-ml root-k]` session's reading before its PR; root 2(a), the
host's `exec: program-only` and the `(program, entrypoint)` prefix, was found already on main from K1 and K3, with the
plain-host import-closure hash unbuilt and K1's "applies only when `sandboxed: true`" standing in its place).

- B1. Two keys in `chrome.storage.local`, never `sync`: `manifests.global` and `manifests.workspace` (the latter keyed by
  the root's realpath), each declared in the state registry from the first commit. An entry is `{ id, scope, root?,
  manifest, origin: "person" | "proposed", created }`; `manifestFor` reads shipped and stored.
- B2. SHIPPED WINS this round. A stored entry whose key (`program`, or `program` + `entrypoint`) a shipped manifest
  already describes is refused at store time with the shipped file named, on both placements: the same key is then
  never read differently by placement, and the delete family cannot be made free on a person's word through the store.
  Person-wins is a widening, Shane's later on a number. Among stored entries, workspace beats global.
- B3. A program that resolves inside a workspace root is describable by workspace scope only, and only pinned; a global
  entry for an in-root program is refused at store time, mirroring the shipped rule above.
- B4. A binary is pinned by the host's `program.fingerprint` (`dev:ino:size:mtime`), plus the `version` string when the
  program reports one; any change drops it to `unknown`. A content hash of a binary (past the 16 MiB path-argument cap;
  `node` is about 100 MB) is a host change, on a need, not this round.
- B5. `origin: "proposed"` (from `propose_manifest`) applies only when the call is sandboxed, until the tool's evidence
  run marks it; `origin: "person"` applies on both placements.
- The store's message types get the red-team pass from the red team's lane: a page cannot store, list or delete a
  manifest, and a stored manifest never reaches a page.

As built (`src/sw/sw-manifests.ts`, the storage; `src/shell/stored-manifests.ts`, the rules, pure; mechanics in
`docs/dev/shell.md`), on top of the ruling: a workspace's entries describe a call only while that root is configured;
another workspace's entry for an in-root program misses at call time as well as being refused when stored; a script's
manifest (`entrypoint`) is workspace scope always, since it arrived with the repository; B2 is checked at store, load
and call time; a pin that no longer matches leaves the call `unknown` with the reason on the card. `MANIFESTS` is
answered for extension pages only, and what it adds is `origin: "person"`.

**`propose_manifest` (ruled 2026-10-23, root K slice c).** The model drafts a manifest for a program it read the
`--help` or the source of; the person stores it or not on a card. Nothing executes before the person's word: the host
only resolves the draft (`spawn`, then `discard`), which pins it (B4, or a script's `sha256` as the host read it) and
applies B3 (a program inside a root, and any script, is forced to its workspace, and the card says why). The card is
DERIVED only, and says so: the host's resolve-and-discard facts, and this run's calls of that program that ran, each
resolved again with the draft and read by it (its effects, and whether it would go without a card). Nothing measured
is mixed in. Approved, the entry is stored with `origin: "proposed"` and describes sandboxed calls only (B5). The
evidence run follows approval, on a sandboxed host only: this run's ran calls of the program that the entry makes
free, at most eight, the latest first, each re-run under the envelope derived from the draft (write none, exec the
program only) with the version probe's 2 s limit. Each must exit within its `okCodes`, with the envelope applied as
asked and no protected name changed. A program that swallows its refused write and exits 0 would pass that, so the
recorded call is checked too: an undescribed `ml.sh` call's arguments are read as paths by the host just before its
start and after its done (resolved and discarded, nothing run), and a draft calling it a reader fails if it created,
modified (by sha256) or removed any of them; a recorded call without that record is no evidence. A write inside a
directory operand, or to a file no argument names, is not seen. If all pass, the entry gets `evidence {calls, at}` and
from then on describes plain-host calls too; the first failure is stored on the entry (`evidenceFailure`) and it stays sandbox-only. With no
call to re-run there is no evidence, which the card says beforehand; a synthetic call is never made. Offered only to
a run the worker built while the settings turn ml.sh on; a page's start never carries it. Built in
`src/shell/manifest-proposal.ts` (pure) and `src/sw/sw-manifest-proposal.ts`.

### Interpreted script tools (`node scripts/<name>.mjs`, `python3 <script>.py`)

In LLM agent workflows, almost every repository-specific CLI utility (`node scripts/index.mjs`,
`node scripts/test-cover.mjs`, `python3 tools/check.py`) is invoked through a general language interpreter rather than
compiled to a standalone binary. Keying a manifest solely on `argv[0]` fails on this pattern: `argv[0]` is `"node"` or
`"python3"`, which as a bare binary is an un-describable universal code runner (`effects: ["unknown"]`, `runner: true`).

A program manifest therefore matches a **command prefix** `(program, entrypoint?)` rather than `argv[0]` alone:

**A shipped manifest never describes a program inside a workspace root** (ruled 2026-10-22): when the host reports `program.inRoot` for the resolved file, `shFacts` leaves the call `unknown` and undescribed, whatever `argv[0]` is spelled (`./cat`, `bin/ls`); a workspace-registered entrypoint manifest is unaffected.

| Field | For a standalone binary (`rg`, `git`) | For an interpreted script (`node scripts/index.mjs`) |
| --- | --- | --- |
| `program` | `"rg"` (`argv[0]` basename, resolved on `PATH`) | `"node"` or `"python3"` (`argv[0]` resolved on `PATH`) |
| `entrypoint` | absent | `"scripts/index.mjs"` (workspace-relative path; must match `argv[1]` after `realpath`, with **no interpreter flags** between `argv[0]` and `argv[1]`) |
| Option parsing | starts at `argv[1]` | starts at `argv[2]` |
| Pin (`sha256` / `version`) | `version` range probed once per binary inode | `sha256` of the entrypoint script (or its static local import closure, computed the way `scripts/imports.mjs` walks local specifiers); no `--version` subprocess is needed |
| Sandbox `exec` envelope (`exec: program-only`) | `process-exec` restricted to `{ resolved(program) }` | `process-exec` restricted to `{ resolved(program) }` (plus `/usr/bin/env` when invoked via a `#!` shebang on `./scripts/<name>.mjs`), with interpreter injection variables (`NODE_OPTIONS`, `PYTHONPATH`, `PYTHONSTARTUP`) already in `REFUSED_ENV` |

Two invariants keep an interpreted-script manifest sound:

1. **No interpreter flags before the entrypoint.** A call `["node", "--import", "./evil.mjs", "scripts/index.mjs"]` or
   `["node", "-e", "..."]` has an option at `argv[1]`, so it does not match `(program: "node", entrypoint: "scripts/index.mjs")`
   and falls back to `unknown` (asks).
2. **Transitive imports vs. the sandbox envelope.** Unlike a static binary, `scripts/index.mjs` may import local modules.
   Under the OS sandbox (Seatbelt / Landlock+bubblewrap), the kernel enforces the manifest's claimed effect envelope
   (`write: none`, `net: deny`, `exec: program-only`, secret paths denied) across the entire process regardless of what
   files `scripts/index.mjs` imports. On the plain host (where there is no kernel envelope), pinning must hash the
   entrypoint's transitive local import closure, or the manifest applies only when `sandboxed: true`.

**Two kinds of command, two kinds of manifest — and how ad-hoc scripts graduate.** A registered command is either a
PROCESS, described by a program manifest (standalone binary or `(program, entrypoint)` script) and bounded by the kernel
envelope above, or an IN-PROCESS FUNCTION exposed in `exec` / `python_exec`, written in JavaScript or Python and
described by a library manifest ([`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md)). A function written in
the read-only dialect of either language needs no effect or cost trust at all: tier 3 (`@cost interpret`) proves its
effects and step bound by construction ([`PYTHON_DIALECT.md`](PYTHON_DIALECT.md)).

When an agent works with Python (or Node) on a desktop runtime, three execution modes therefore coexist without
overlapping:

| Mode | Invocation | Gate & Pin | Why |
| --- | --- | --- | --- |
| **1. Local kernel (`python_exec` cell or `import` inside it)** | In-process cell or pure helper module | **In-interpreter `CO_RESTRICTED` gate** (step budget, `heap(owned)` write barrier + rollback, [`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md)). No `open()`, `os`, `sys`, `argparse`. | Shares one persistent per-run heap (`dict`); must halt and never mutate unowned state. |
| **2. Ad-hoc script written & edited mid-run (`python3 tmp/scratch.py`)** | `ml.sh.run(["python3", "tmp/scratch.py", ...])` while the agent iterates on `tmp/scratch.py` | **OS sandbox** (Seatbelt / Landlock confines writes to roots, denies `~/.ssh` and network) + Root L process-group memory/time cap + **run-scoped policy** (`propose_policy`, [`POLICIES.md`](POLICIES.md)). | A CLI script imports `sys`/`os`/`pathlib`/`open` (which `CO_RESTRICTED` refuses), and its `sha256` changes on every edit, so a hash-pinned manifest would invalidate on each turn. |
| **3. Stabilized repo CLI (`python3 scripts/tool.py`, `node scripts/index.mjs`)** | `ml.sh.run(["python3", "scripts/tool.py", ...])` | **`ProgramManifest` `(program, entrypoint)` pinned by `sha256`** (`propose_manifest`) + **manifest-derived sandbox envelope** (`write: none`, `net: deny`, `exec: program-only`). | Once stationary, its flag grammar is described once and enforced as a tight read-only kernel envelope across runs without needing a run policy. |

**What this adds, later (Root K):** `(program, entrypoint)` prefix matching in `describeCall`, profile derivation from a
manifest's effects, `sha256` pinning of a resolved binary or script closure, a manifests store with workspace and global
scope, `propose_manifest` (drafting from `--help` or script source into an approval card with sandbox evidence), and the
registration page. None of it blocks the host's first slices; it is a root of its own in
[`docs/plan/repl/`](../plan/repl/README.md).

## Editing a manifest: the JSON Schema

[`program-manifest.schema.json`](program-manifest.schema.json) gives an editor validation and a hint for every field (VS Code picks
it up for `src/shell/manifests/*.json` through `.vscode/settings.json`; a manifest of your own may name it in a top-level
`"$schema"` string). It is GENERATED from the types and their JSDoc in `src/shell/program-manifest.ts` by
`node scripts/gen-export-schema.mjs` (the rules the types cannot state are laid over it in
`scripts/manifest-schema-overlay.mjs`), and `tests/manifest-schemas.test.mjs` fails when it is stale. `validateManifest` is the
authority, not the schema: the test holds the two to the same verdict on every shipped manifest and on one invalid manifest
per rule, and names the rules JSON Schema cannot state (a `version.pattern` that compiles; a `harden` argument that is a flag
of the same command). `"$schema"` is the only key beyond the types in `program-manifest.ts`, and it changes nothing about how a call is
described. The manifests shipped here carry none (their bytes are pinned and copied to the host), and the host's reader
rejects unknown fields, so a manifest with one is for this extension only.

## Known limits

- **A lone `-` for `head`, `tail` and `wc` is judged as a path on every platform** (2026-11-18). macOS opens a file named
  `-`; GNU reads stdin. Claiming the path is the stricter reading: on GNU a call such as `head -` asks or names a path
  that does not exist, where reading stdin needs neither. Flavours (above) can now tell the implementations apart; it
  stays so until `head`, `tail` and `wc` declare them, when the GNU reading moves into the `gnu` overlay.
- **A stored or proposed manifest's version probe is still run** (2026-11-18). Its `version.args` are spawned as the
  version probe for a ranged manifest, as a shipped one's are (the probe rules above: sandbox only, never in-root,
  judged), so its author chooses the argv and can steer what it prints into the range, which is the reason the
  `gnu` probe is shipped-only. The sentence under "When the version is learned" that only a shipped manifest's probe
  entry is used holds for flavours, not yet for `version`. The follow-up gives `version` the same rule: a stored
  manifest's version comes from its pin (B4) and its probe is never run.

## Related

- [`SHELL.md`](SHELL.md): the consumer; what a call gives a policy; the host that resolves the facts.
- [`EFFECTS.md`](EFFECTS.md): the vocabulary.
- [`SECRET_HANDLES.md`](SECRET_HANDLES.md): why `echoes` exists.
