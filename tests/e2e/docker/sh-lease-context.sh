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
cp "$repo/tests/e2e/docker/sh-lease.Dockerfile" "$out/Dockerfile"
printf 'wml %s\nhost %s\n' "$(git -C "$repo" rev-parse HEAD)" "$(git -C "$host" rev-parse HEAD)" > "$out/HEADS"
