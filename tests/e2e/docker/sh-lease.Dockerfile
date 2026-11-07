# sh-lease.Dockerfile — the ml.sh lease bench in one Linux container: Chromium, the built extension, a real wmlhost and
# the task scripts, so every ml.sh call reads the container's files and never the person's home. Only model calls leave.
# Context: `tests/e2e/docker/sh-lease-context.sh <dir>` (git archives of this repo's HEAD and the host's, never a .env).
# bwrap needs user namespaces and a fresh /proc in its PID namespace, so run with `--security-opt seccomp=unconfined
# --security-opt apparmor=unconfined --security-opt systempaths=unconfined` (without the last, the host's probe fails with
# "Can't mount proc on /newroot/proc" and every call runs host-plain).

FROM rust:1-bookworm AS host
COPY host.tar /src/host.tar
RUN mkdir /h && tar -xf /src/host.tar -C /h && cd /h && cargo build --release --locked

FROM node:26-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap && rm -rf /var/lib/apt/lists/*
COPY wml.tar /src/wml.tar
WORKDIR /w/window-ml
RUN tar -xf /src/wml.tar && npm ci --no-audit --no-fund && npx playwright install --with-deps chromium && npm run build
COPY --from=host /h/target/release/wmlhost /w/window-ml-host/target/release/wmlhost
RUN useradd -m bench && chown -R bench /w && mkdir -p /home/bench/.cache && cp -r /root/.cache/ms-playwright /home/bench/.cache/ && chown -R bench /home/bench
USER bench
# The canary row's file (sh-lease-canary.bench.ts): one random line, made at build time, in the container's home only.
RUN mkdir -m 700 /home/bench/.ssh && printf 'Host canary-%s\n' "$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')" > /home/bench/.ssh/config && chmod 600 /home/bench/.ssh/config
