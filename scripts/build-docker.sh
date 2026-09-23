#!/usr/bin/env bash
# Build the Docker test images in layer order.
#
# The tmux image does `FROM pocketshell-test:ssh` and the helper image does
# `FROM pocketshell-test:tmux`, so the tags must exist in that order — compose
# `up --build` would otherwise try to build tmux before ssh is tagged.
#
# The tags are shared with pocketshell-desktop and the Android project: each
# repo keeps a byte-identical copy of the fleet (see tests-docker/
# docker-compose.yml), so building here or there yields the same images.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_DIR="$DIR/tests-docker"

echo "==> Building pocketshell-test:ssh"
docker build -t pocketshell-test:ssh -f "$DOCKER_DIR/Dockerfile.ssh" "$DOCKER_DIR"

echo "==> Building pocketshell-test:tmux"
docker build -t pocketshell-test:tmux -f "$DOCKER_DIR/Dockerfile.tmux" "$DOCKER_DIR"

echo "==> Building pocketshell-test:helper"
# The generic fleet tag is shared with Android and desktop, whose helper pins
# can differ. Keep a core-owned alias so a parallel build in another checkout
# cannot silently replace the CLI image used by core's HostCliCore tests.
# Pin the release already used by pocketshell-cli: a CI build must not depend
# on an unauthenticated GitHub "latest" API request or drift between runs.
docker build -t pocketshell-test:helper -t pocketshell-core-test:helper \
  --build-arg APLEXER_VERSION=0.1.8 \
  -f "$DOCKER_DIR/Dockerfile.helper" "$DOCKER_DIR"

echo "==> Done. Images:"
docker images --filter=reference='pocketshell-test:*' --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}'
echo "Core-isolated HostCliCore target: pocketshell-core-test:helper"
