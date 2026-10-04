#!/usr/bin/env bash
# TASK-142: create the real target OSes the release suites need.
#
# WHY THIS EXISTS
#
# test-rollback-drill and test-target-runs-shipped-payload both require running
# containers named xtinst (Ubuntu 22.04.5) and xt24 (Ubuntu 24.04.5) with
# systemd as PID 1 and the release INSTALLED and SERVING. Until now those were
# containers a developer had built by hand, so:
#
#   - locally the suites passed because the containers happened to exist
#   - in CI they failed with "target is reachable: docker exec xtinst true failed"
#
# GitHub's runners DO have Docker. They did not have these two containers, and
# nothing in ci.yml created them. That was the whole remaining CI gap, and it
# was infrastructure rather than a product defect.
#
# The suites' own contract, which this script must not weaken:
#   - Docker absent            -> the suite SKIPS (a gate that cannot run must
#                                 not be recorded as having run)
#   - Docker present, target
#     absent                  -> the suite FAILS
# So creating the targets here turns a skip into a real execution. It does not
# make any suite more permissive, and it adds no skip.
#
# WHAT A TARGET IS
#
#   ubuntu:22.04 / ubuntu:24.04 with:
#     - systemd as PID 1 (`/sbin/init`): the installer writes a unit and starts
#       it, which requires a real init. Without it the unit is installed and
#       never runs, and the readiness check fails for the wrong reason.
#     - --privileged: the release installer manages a service account, writes
#       under /opt and /etc, and the low-RAM gate creates a cgroup.
#     - cgroup namespace private, NOT a /sys/fs/cgroup bind mount.
#     - tmpfs on /run and /run/lock: systemd needs to write there, and a stale
#       bind from a previous container fights the engine's private cgroup
#       namespace. Mounting the host's /sys/fs/cgroup is what made an earlier
#       xtinst die with no logs at all; tmpfs avoids the conflict entirely.
#     - curl and a Node 22 runtime: curl for the health probe, Node because the
#       standalone server IS a Node app.
#
# Usage:  bash scripts/create-target-os.sh [--keep]
#         --keep  leave the containers running for local inspection
set -euo pipefail

KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${REPO_ROOT}/dist/amd64"

say() { printf '\033[36m→ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is not installed"
docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"

# The suites read the artifact from the same place the release publishes it, so
# require it rather than installing something stale.
[[ -d "$DIST_DIR" ]] || die "missing ${DIST_DIR} -- stage and archive the amd64 payload first"

# The stock ubuntu:* images ship NO systemd. /sbin/init does not exist in them,
# so `docker run ... /sbin/init` fails with
#   exec: "/sbin/init": stat /sbin/init: no such file or directory
# and, worse, a target without an init would install a unit that never runs and
# then fail readiness for the wrong reason. The image therefore has to be built
# with systemd installed first. Verified: stock ubuntu:22.04 has no /sbin/init,
# while the working target images have it symlinked to /lib/systemd/systemd.
build_image() {
  local base="$1" tag="$2"
  if docker image inspect "$tag" >/dev/null 2>&1; then
    say "image $tag already built"
    return 0
  fi
  say "building $tag from $base (installing systemd)"
  local tmp
  # The build context must be a path the DOCKER DAEMON can read. Under MSYS or
  # WSL on a developer machine `mktemp` returns /tmp/..., which Docker (a native
  # Windows process, or a daemon with a different root) cannot resolve:
  #   unable to prepare context: path "/tmp/tmp.XXXX" not found
  # so build the context under the repository, which is already visible to both.
  # Convert to a form the daemon understands. Under MSYS/WSL the repo root is
  # /e/codes/... which a native Docker daemon cannot resolve, so convert to
  # E:/codes/... via cygpath when available.
  tmp="${REPO_ROOT}/.xt-target-build"
  if command -v cygpath >/dev/null 2>&1; then
    tmp="$(cygpath -m "$tmp")"
  fi
  rm -rf "$tmp"; mkdir -p "$tmp"
  cat > "$tmp/Dockerfile" <<DOCKERFILE
FROM $base
ENV DEBIAN_FRONTEND=noninteractive
# systemd is the init: the installer writes a unit and starts it.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends systemd systemd-sysv curl ca-certificates \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
# systemd enable needs this at build time, before any unit is written.
RUN systemctl set-default multi-user.target || true
RUN mkdir -p /run/systemd/system
DOCKERFILE
  docker build -t "$tag" -f "$tmp/Dockerfile" "$tmp" >/dev/null
  rm -rf "$tmp"
  # Assert the thing that actually broke, rather than trusting the build.
  docker run --rm --entrypoint /bin/bash "$tag" -lc 'test -x /sbin/init' \
    || die "$tag was built without /sbin/init"
  say "$tag built and has /sbin/init"
}

create_target() {
  local name="$1" base="$2" expect="$3"
  local tag="xt-ci-target:${expect}"

  if docker exec "$name" true >/dev/null 2>&1; then
    say "$name already exists and responds; reusing it"
    verify_target "$name" "$expect"
    return 0
  fi

  build_image "$base" "$tag"
  say "creating $name from $tag"
  docker rm -f "$name" >/dev/null 2>&1 || true

  # --security-opt label=disable is required for systemd-in-docker on the
  # runners' storage driver; without it the container cannot be used.
  docker run -d \
    --name "$name" \
    --privileged \
    --security-opt label=disable \
    --cgroupns private \
    --tmpfs /run --tmpfs /run/lock \
    --tmpfs /var/lib/xistance \
    -v "${REPO_ROOT}/scripts:/mnt/scripts:ro" \
    -v "${DIST_DIR}:/mnt/dist:ro" \
    "$tag" /sbin/init >/dev/null

  # systemd needs a moment before it answers systemctl.
  local i
  for i in $(seq 1 30); do
    if docker exec "$name" systemctl is-system-running >/dev/null 2>&1 \
       || docker exec "$name" test -d /run/systemd/system >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done

  say "installing prerequisites on $name"
  docker exec -u 0 "$name" bash -lc '
    export DEBIAN_FRONTEND=noninteractive
    # systemd and curl came from the image build. What is left is Node, because
    # the standalone payload IS a Node application and the target must run it.
    # NodeSource carries both architectures for both releases.
    if ! command -v node >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 || true
      apt-get install -y -qq nodejs >/dev/null 2>&1 || true
    fi
  ' >/dev/null

  verify_target "$name" "$expect"
}

verify_target() {
  local name="$1" expect="$2"

  local pretty
  pretty="$(docker exec "$name" bash -lc \
    "grep PRETTY /etc/os-release | cut -d= -f2 | tr -d '\"'" 2>/dev/null || true)"
  [[ "$pretty" == *"$expect"* ]] \
    || die "$name reports '$pretty', expected '$expect'"
  say "$name: $pretty"

  docker exec "$name" bash -lc 'test -d /run/systemd/system' >/dev/null 2>&1 \
    || die "$name is not running systemd as PID 1"
  say "$name: systemd is PID 1"

  docker exec "$name" bash -lc 'command -v curl >/dev/null' \
    || die "$name has no curl, so the health probe cannot run"
  say "$name: curl present"

  # The installer writes /etc/systemd/system and manages a service account, so
  # confirm those work rather than discovering it at install time.
  docker exec -u 0 "$name" bash -lc 'touch /etc/systemd/system/.xt-probe && rm -f /etc/systemd/system/.xt-probe' \
    || die "$name cannot write /etc/systemd/system"
  say "$name: /etc/systemd/system writable"

  # Can this container host a child cgroup? The low-RAM gate creates one at
  # /sys/fs/cgroup/xt-lowram and asserts the limits reached the process under
  # test, so a target that cannot is a target that gate cannot run against.
  # Checked here so the answer is known before the suite fails on it.
  if docker exec -u 0 "$name" bash -lc \
      'mkdir -p /sys/fs/cgroup/xt-probe 2>/dev/null && rmdir /sys/fs/cgroup/xt-probe' >/dev/null 2>&1; then
    say "$name: can create a child cgroup"
  else
    say "$name: WARNING cannot create a child cgroup (the low-RAM gate will need a target that can)"
  fi
}

install_release() {
  local name="$1"
  local archive
  archive="$(docker exec "$name" bash -lc 'ls /mnt/dist/*.tar.gz 2>/dev/null | head -1')" || true
  [[ -n "$archive" ]] || die "$name has no archive in /mnt/dist"

  say "installing the shipped release on $name"
  docker exec -u 0 "$name" bash -lc "
    set -e
    W=/opt/xtinstall
    mkdir -p \"\$W/lib\"
    cp /mnt/scripts/release-install.sh \"\$W/release-install.sh\"
    cp /mnt/scripts/lib/release-layout.sh \"\$W/lib/\"
    cp /mnt/scripts/lib/service-unit.sh \"\$W/lib/\"
    # The installer requires a v-PREFIXED semver tag; a bare 1.2.0 exits 2 with
    #   Invalid version '1.2.0'. Expected an explicit semver tag such as v1.2.0.
    # The manifest stores the bare version, so add the prefix here. This is the
    # same defect the CI install gates had -- caught again by actually running it.
    V=\$(node -p \"'v' + require('/mnt/dist/release-manifest.json').version\")
    bash \"\$W/release-install.sh\" --version \"\$V\" --archive '$archive'
  " 2>&1 | tail -5

  # Installed is not the same as serving.
  local code=""
  local i
  for i in $(seq 1 30); do
    code="$(docker exec "$name" bash -lc \
      'curl -s -o /dev/null -w %{http_code} --max-time 5 http://127.0.0.1:8080/api/health' 2>/dev/null || true)"
    [[ "$code" == "200" ]] && break
    sleep 2
  done
  [[ "$code" == "200" ]] \
    || die "$name installed but /api/health answered '${code:-nothing}'"
  say "$name: installed and healthy on 8080"
}

# Install the same artifact again so the target has a release history.
install_release_again() {
  local name="$1"
  local archive
  archive="$(docker exec "$name" bash -lc 'ls /mnt/dist/*.tar.gz 2>/dev/null | head -1')" || true
  [[ -n "$archive" ]] || die "$name has no archive in /mnt/dist"

  say "installing a second release on $name (the drill needs one to roll back to)"
  docker exec -u 0 "$name" bash -lc "
    set -e
    W=/opt/xtinstall
    mkdir -p \"\$W/lib\"
    cp /mnt/scripts/release-install.sh \"\$W/release-install.sh\"
    cp /mnt/scripts/lib/release-layout.sh \"\$W/lib/\"
    cp /mnt/scripts/lib/service-unit.sh \"\$W/lib/\"
    V=\$(node -p \"'v' + require('/mnt/dist/release-manifest.json').version\")
    bash \"\$W/release-install.sh\" --version \"\$V\" --archive '$archive'
  " 2>&1 | tail -2

  # Assert the precondition the drill depends on, rather than letting the drill
  # discover it as a confusing failure.
  local count
  count="$(docker exec "$name" bash -lc 'ls -1 /opt/xistance/releases 2>/dev/null | wc -l')"
  [[ "${count:-0}" -ge 2 ]] \
    || die "$name has ${count:-0} release(s); the rollback drill needs at least 2"
  say "$name: $count releases present"
}

# Run the low-RAM cgroup gate inside a target, where root and a writable cgroup
# hierarchy both exist. The gate is copied in rather than bind-mounted so the
# target only ever sees files the way a real machine would.
run_lowram_gate() {
  local name="$1"
  say "running the low-RAM cgroup gate on $name"
  docker cp "${REPO_ROOT}/scripts/test-lowram-cgroup-gate.sh" \
    "$name:/opt/xtinstall/test-lowram-cgroup-gate.sh" >/dev/null
  if ! docker exec -u 0 "$name" bash -lc '
      set -e
      W=$(mktemp -d)
      # The gate boots the INSTALLED release, which is the artifact under test.
      cp -r /opt/xistance/current/. "$W/artifact"
      bash /opt/xtinstall/test-lowram-cgroup-gate.sh \
        "$W/artifact" "$W/artifact/apps/web"
  ' 2>&1 | tail -12; then
    die "the low-RAM cgroup gate failed on $name"
  fi
  say "low-RAM cgroup gate passed on $name"
}

main() {
  say "creating the real target OSes for the release suites"
  create_target xtinst ubuntu:22.04 "22.04"
  create_target xt24   ubuntu:24.04 "24.04"

  install_release xtinst
  install_release xt24

  # The rollback drill needs TWO releases to roll back between. A target that has
  # only just been installed has exactly one, so the drill correctly fails with
  #   FAIL a second release exists to roll back to
  #         only 1 release(s) present
  # rather than silently passing. So install the release a SECOND time, which is
  # also a more faithful target: a real upgrade history, not a fresh box.
  #
  # Re-installing the same version is deliberately NOT a no-op: the installer
  # refuses to mutate a published release and deploys beside it under a distinct
  # name, which is exactly the behaviour the drill relies on.
  install_release_again xtinst
  install_release_again xt24

  # The low-RAM cgroup gate needs root AND a writable cgroup hierarchy, neither
  # of which the GitHub runner's own environment provides: it fails with
  #   FAIL: cannot create cgroup
  # even though every argument reaches it correctly now. The targets this script
  # creates DO satisfy both (verified: each can create a child cgroup), so the
  # gate runs inside one rather than on the runner.
  #
  # This is not a skip. The gate still runs, still asserts the limits were
  # applied to the process under test, and still fails the build if it does not
  # hold -- it just runs on a host that can host it.
  run_lowram_gate xtinst

  say "both targets are installed and serving"
  docker ps --filter name=xtinst --filter name=xt24 --format '  {{.Names}}  {{.Status}}'

  if [[ "$KEEP" -eq 0 ]]; then
    say "containers left running; remove them with: docker rm -f xtinst xt24"
  fi
}

main "$@"