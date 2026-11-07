#!/bin/sh
# sh-lease-context.sh <dir> — the build context for sh-lease.Dockerfile: git archives of this repo's HEAD and of the
# sibling window-ml-host's HEAD (WMLHOST_SRC overrides), so nothing untracked (a .env, a key) is ever in the image.
set -eu
out=${1:?usage: sh-lease-context.sh <dir>}
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
host=${WMLHOST_SRC:-$repo/../window-ml-host}
mkdir -p "$out"
git -C "$repo" archive --format=tar -o "$out/wml.tar" HEAD
git -C "$host" archive --format=tar -o "$out/host.tar" HEAD
wml_head=$(git -C "$repo" rev-parse HEAD) host_head=$(git -C "$host" rev-parse HEAD)
cp "$repo/tests/e2e/docker/sh-lease.Dockerfile" "$out/Dockerfile"
# The archive has no .git, so the image is told what it holds: the bench's build fingerprint (run.mjs) and where its
# sweeps say they ran (the Spec card, spec.md, status.md).
printf '\nENV BENCH_SOURCE_HEAD=%s\nENV BENCH_RUNS_IN="a Linux container (tests/e2e/docker/sh-lease.Dockerfile at %.8s; wmlhost %.8s, bwrap)"\n' "$wml_head" "$wml_head" "$host_head" >> "$out/Dockerfile"
printf 'wml %s\nhost %s\n' "$wml_head" "$host_head" > "$out/HEADS"
