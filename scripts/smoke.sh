#!/usr/bin/env bash
#
# Smoke test for the sample-node image. CI and Jenkins run it after the build.
#
#   scripts/smoke.sh IMAGE [VERSION]
#
# Starts IMAGE with VERSION and checks it from a curl container in the same
# network namespace, so the host needs only docker and jq. Exits non-zero and
# prints the container log when a check fails. The helpers above the
# "sample-node checks" line are the same in every sample-* repository.

# Each repository uses a subset of the shared helpers, may replace some of them,
# and may call check_port without arguments.
# shellcheck disable=SC2119,SC2120,SC2317,SC2329

set -euo pipefail

IMAGE="${1:?usage: scripts/smoke.sh IMAGE [VERSION]}"
VERSION="${2:-v0.0.0-smoke}"
PORT=3000
TIMEOUT="${SMOKE_TIMEOUT:-90}"
CURL_IMAGE=curlimages/curl:8.23.0
NAME="smoke-$$-$RANDOM"

cleanup() { docker rm -f "$NAME" > /dev/null 2>&1 || true; }
trap cleanup EXIT

# Pull once, so a pull error shows here instead of as a failed health check.
docker pull -q "$CURL_IMAGE" > /dev/null

fail() {
  echo "FAIL: $*" >&2
  docker logs "$NAME" >&2 || true
  exit 1
}

# http CURL_ARGS... runs curl in the network namespace of the container.
http() { docker run --rm --network "container:$NAME" "$CURL_IMAGE" -sS --max-time 10 "$@"; }

# ready succeeds when the app answers its health check. sample-grpc replaces it.
ready() { http -f -o /dev/null "http://localhost:$PORT/health" 2> /dev/null; }

# start [DOCKER_RUN_ARGS...] starts the image and waits until it is ready.
start() {
  cleanup
  docker run -d --name "$NAME" -e VERSION="$VERSION" "$@" "$IMAGE" > /dev/null
  local deadline=$((SECONDS + TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || fail "container exited"
    ready && return 0
    sleep 1
  done
  fail "the health check did not pass in ${TIMEOUT}s"
}

# check_health checks the /health contract: HTTP 200, result "ok" and VERSION.
# sample-grpc replaces it.
check_health() {
  local body
  body="$(http -f "http://localhost:$PORT/health")" || fail "GET /health"
  jq -e --arg version "$VERSION" '.result == "ok" and .version == $version' <<< "$body" > /dev/null ||
    fail "GET /health returned $body, expected result ok and version $VERSION"
  echo "ok: GET /health $body"
}

# check_get PATH [TEXT] checks HTTP 200 and, when TEXT is given, that the body contains it.
check_get() {
  if [ -z "${2:-}" ]; then
    http -f -o /dev/null "http://localhost:$PORT$1" || fail "GET $1"
    echo "ok: GET $1"
  else
    http -f "http://localhost:$PORT$1" | grep -F -- "$2" > /dev/null || fail "GET $1 does not contain: $2"
    echo "ok: GET $1 contains: $2"
  fi
}

# check_status PATH CODE checks the HTTP status code.
check_status() {
  local code
  code="$(http -o /dev/null -w '%{http_code}' "http://localhost:$PORT$1")" || fail "GET $1"
  [ "$code" = "$2" ] || fail "GET $1 returned HTTP $code, expected $2"
  echo "ok: GET $1 HTTP $code"
}

# check_non_root checks that the main process does not run as root.
check_non_root() {
  local uid
  uid="$(docker exec "$NAME" id -u)"
  [ "$uid" != 0 ] || fail "the container runs as root"
  echo "ok: runs as uid $uid"
}

# check_port checks that the image listens on another PORT.
check_port() {
  PORT=18080
  start -e PORT="$PORT" "$@"
  check_health
  echo "ok: listens on PORT=$PORT"
}

# --- sample-node checks ----------------------------------------------------------

start -e REDIS_ENABLED=false
check_health
health="$(http -f "http://localhost:$PORT/health")" || fail "GET /health"
jq -e '.service == "sample-node"' <<< "$health" > /dev/null ||
  fail "GET /health returned $health, expected service sample-node"
echo "ok: GET /health service is sample-node"
check_get / "$VERSION"
check_get /live '"live":true'
check_get /ready '"ready":true'
check_get /read '"result":"read"'
check_get /version "\"version\":\"$VERSION\""
check_get /metrics 'nodejs_version_info{'
check_status /telemetry 404
check_status /cache/smoke 404

request_id="$(http -f -o /dev/null -D - -H 'X-Request-Id: smoke' "http://localhost:$PORT/live" |
  tr -d '\r' | sed -n 's/^[Xx]-[Rr]equest-[Ii]d: //p')"
[ "$request_id" = smoke ] || fail "X-Request-Id is not echoed (got '$request_id')"
echo "ok: X-Request-Id is echoed"

check_non_root

# SIGTERM shuts the server down cleanly within SHUTDOWN_TIMEOUT_MS (10 s).
docker stop --time 15 "$NAME" > /dev/null
code="$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
[ "$code" = 0 ] || fail "exit code $code after docker stop, expected 0"
echo "ok: docker stop exits with code 0"

check_port -e REDIS_ENABLED=false

echo "smoke test passed: $IMAGE $VERSION"
