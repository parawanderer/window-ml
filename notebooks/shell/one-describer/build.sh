#!/bin/sh
# build.sh — builds build/describe-{z,s,3}.wasm from a window-ml-host checkout's describer, unmodified.
# usage: WML_HOST=<window-ml-host checkout> sh build.sh   (needs: rustup target add wasm32-unknown-unknown)
set -e
here=$(cd "$(dirname "$0")" && pwd)
: "${WML_HOST:?set WML_HOST to a window-ml-host checkout}"
ln -sfn "$(cd "$WML_HOST" && pwd)" "$here/wrapper/host"
mkdir -p "$here/build" "$here/out"
cd "$here/wrapper"
for o in z s 3; do
  CARGO_PROFILE_RELEASE_OPT_LEVEL=$o cargo build --release --target wasm32-unknown-unknown --target-dir "target-$o" 2>&1 | tail -1
  cp "target-$o/wasm32-unknown-unknown/release/describe_wasm.wasm" "../build/describe-$o.wasm"
done
printf '{"host":"%s","rustc":"%s"}\n' "$(git -C "$WML_HOST" rev-parse HEAD)" "$(rustc --version)" > "$here/out/build.json"
