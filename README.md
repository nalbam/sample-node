# sample-node

[![CI](https://img.shields.io/github/actions/workflow/status/nalbam/sample-node/push.yml?branch=main&style=for-the-badge&logo=github)](https://github.com/nalbam/sample-node/actions/workflows/push.yml)
[![release](https://img.shields.io/github/v/release/nalbam/sample-node?style=for-the-badge&logo=github)](https://github.com/nalbam/sample-node/releases)

[![Docker Image Version (latest by date)](https://img.shields.io/docker/v/nalbam/sample-node?label=Docker%20Hub&style=for-the-badge&logo=docker)](https://hub.docker.com/r/nalbam/sample-node)
[![Docker Image Size (latest by date)](https://img.shields.io/docker/image-size/nalbam/sample-node?style=for-the-badge&logo=docker)](https://hub.docker.com/r/nalbam/sample-node)
[![Docker Pulls](https://img.shields.io/docker/pulls/nalbam/sample-node?style=for-the-badge&logo=docker)](https://hub.docker.com/r/nalbam/sample-node)

<!-- [![DockerHub Badge](http://dockeri.co/image/nalbam/sample-node)](https://hub.docker.com/r/nalbam/sample-node/) -->

A sample Node.js app for Kubernetes demos. It serves liveness and readiness probes,
exports Prometheus metrics, and offers chaos endpoints that burn CPU, inject faults,
add latency, call sibling services, and kill the pod with an OOM. The info page shows
which pod answered, and `/drop` visualizes a rollout by version.

## Docker

```bash
docker pull nalbam/sample-node

# POST /oom needs a memory limit to be killed by the kernel
docker run -d --name sample-node -m 128m -p 3000:3000 nalbam/sample-node

# wait longer than SHUTDOWN_TIMEOUT_MS (10s by default) before Docker sends SIGKILL
docker stop --time 15 sample-node
docker inspect -f '{{.State.ExitCode}}' sample-node   # 0 after a clean shutdown
docker rm sample-node
```

The image runs `node server.js` directly as the container's main process and sets
`STOPSIGNAL SIGTERM`, so `docker stop` delivers `SIGTERM` to Node itself. The default
`docker stop` wait is 10 seconds, the same as the app's default shutdown timeout,
so pass a longer `--time`. See [Graceful shutdown](#graceful-shutdown).

## Kubernetes

`requests` and `limits` set to the same memory makes the pod Guaranteed, so `POST /oom`
kills that pod alone at exactly its limit. `terminationGracePeriodSeconds` must be
longer than `SHUTDOWN_TIMEOUT_MS` plus any other termination work, such as a
`preStop` hook, because the kubelet sends `SIGKILL` when the grace period ends.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sample-node
spec:
  replicas: 2
  selector:
    matchLabels:
      app: sample-node
  template:
    metadata:
      labels:
        app: sample-node
    spec:
      terminationGracePeriodSeconds: 30   # longer than SHUTDOWN_TIMEOUT_MS (10s)
      containers:
        - name: sample-node
          image: nalbam/sample-node
          ports:
            - containerPort: 3000
          env:
            - name: SHUTDOWN_TIMEOUT_MS
              value: "10000"
          readinessProbe:
            httpGet:
              path: /ready
              port: 3000
          livenessProbe:
            httpGet:
              path: /live
              port: 3000
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 100m
              memory: 128Mi
```

## Graceful shutdown

This section describes builds where `server.js` connects the shutdown coordinator in
[`lib/shutdown.js`](lib/shutdown.js) to the process signals. Builds without that
connection do not handle `SIGTERM` or `SIGINT` this way.

On the first `SIGTERM` or `SIGINT` the app:

1. Stops accepting new connections. Once the listener is closed, new TCP
   connections are refused, including connections to `/live` and `/ready`.
2. Stops the telemetry publisher.
3. Lets requests already in progress finish.
4. Closes the Redis connection.
5. Exits with code `0` when all of these steps succeed.

`SHUTDOWN_TIMEOUT_MS` (default `10000`) is one deadline counted from the first signal
and covers waiting for requests and closing resources together. If shutdown has not
finished by then, the app closes the remaining connections and exits with code `1`.
A step that fails is reported, the remaining steps still run, and the app exits with
code `1`. A second signal, `SIGTERM` or `SIGINT`, while shutdown is running does not
start the steps again or extend the deadline.

While shutting down, requests that still arrive on already open connections get
`503` from `/ready` (not ready for new traffic) and `200` from `/live` (the process
is still alive). Kubernetes probes open new connections, so once the listener is
closed they are refused rather than answered; do not rely on reaching `/live` over a
new connection during shutdown.

Set the outer wait longer than `SHUTDOWN_TIMEOUT_MS`: `terminationGracePeriodSeconds`
in Kubernetes (see [Kubernetes](#kubernetes)) and `docker stop --time` in Docker (see
[Docker](#docker)). Otherwise `SIGKILL` can end the process before it finishes.

To reproduce it locally, start `node` directly rather than through `npm start`, so
the signal reaches the Node process:

```bash
REDIS_ENABLED=false node server.js &
pid=$!
sleep 1
curl -s localhost:3000/delay/3 &      # a request in progress
sleep 1
kill -TERM "$pid"
curl -s localhost:3000/live || echo "new connection refused"
wait "$pid"; echo "exit code: $?"    # the /delay/3 response prints first, then exit code: 0
```

With `SHUTDOWN_TIMEOUT_MS=2000` and `/delay/5` instead, the request cannot finish
before the deadline and the exit code is `1`.

## Development

Requires Node.js 26 or later. The live dashboard needs Redis 6.2 or later for shared
telemetry history. Set `REDIS_ENABLED=false` to run without Redis. This disables
Redis connections and telemetry publishing, and makes `/cache/*` and `/telemetry`
return `404`.
The dashboard reads CPU and memory from `/status` every second while visible.
It samples whichever pod answers each request and keeps five minutes of history
in the current tab; reloads clear this history. CPU load and OOM controls, probes,
and metrics still work. When Redis is enabled but unreachable, the page uses the
same direct sampling; Redis-backed endpoints answer `503`.
Reload after Redis recovers to restore shared telemetry history.

```bash
npm ci                     # install exactly what package-lock.json records
npm run lint
npm test -- --runInBand
npm start                  # http://localhost:3000
```

`npm run smoke -- <base-url> <version>` checks a running app that was started with
`REDIS_ENABLED=false`. It waits up to 30 seconds for `/live`, then checks the status,
`Content-Type` and key values of `/`, `/live`, `/ready`, `/read`, `/health`, `/version`
and `/metrics`, the `404` from `/telemetry` and `/cache/*`, and the `X-Request-Id` echo.
It prints one line per path and exits `1` when the app does not start or a response
differs. Pass the same version as `VERSION`:

```bash
REDIS_ENABLED=false VERSION=v0.0.0-smoke npm start &
npm run smoke -- http://localhost:3000 v0.0.0-smoke
kill %1

docker build --pull -t sample-node:local .
docker run -d --name sample-node-smoke -e REDIS_ENABLED=false -e VERSION=v0.0.0-smoke \
  -p 3000:3000 sample-node:local
npm run smoke -- http://localhost:3000 v0.0.0-smoke
docker rm -f sample-node-smoke
```

### Logging

The app writes one JSON object per line: `debug` and `info` records go to stdout,
`warn` and `error` records to stderr. Every record has `time` (ISO 8601 UTC),
`level` and `message`. Records written while handling a request also have
`request_id`, the same value as the response's `X-Request-Id` header. This includes
records from awaited work such as Redis connection failures and remote calls, and
the `POST /oom` fill timer. Other fields depend on the event; `event` names a
record kind for filtering.

```json
{"time":"2026-11-02T12:00:00.123Z","level":"info","message":"request completed","request_id":"3f0c9a52-6f6e-4f7e-9d1e-2b8f0f4f8c11","event":"http.request.completed","method":"GET","path":"/health","status":200,"duration_ms":0.412}
{"time":"2026-11-02T12:00:01.456Z","level":"error","message":"failed to connect redis","request_id":"checkout-42","event":"redis.connect_failed","error":{"name":"Error","message":"connect ECONNREFUSED 10.0.0.5:6379","code":"ECONNREFUSED","stack":["at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1637:16)"]}}
```

To follow one request, send your own id (1-128 letters, digits, `-` or `_`) or read
the generated one from the response header. Then filter the logs by that value:

```bash
curl -si -H 'X-Request-Id: checkout-42' localhost:3000/cache/foo | grep -i x-request-id
docker logs sample-node 2>&1 | grep '"request_id":"checkout-42"'
```

Each request writes exactly one of these records when it ends:

- `http.request.completed` (`info`): the whole response was sent. It includes
  `method`, `path` without the query string, the actual `status`, and `duration_ms`
  from a monotonic clock. Every path is covered, including static files, 404s,
  rejected JSON bodies, `/status` and `/work/:ms`.
- `http.request.aborted` (`warn`): the client closed the connection before the
  response was sent. It has the same fields; `status` is the status the app had set
  at that moment.

Route handlers also write `debug` records such as `get /ready`. Errors that reach
Express, such as a malformed JSON body, are logged as `http.request.error`: client
errors (4xx) at `warn` with only the error name and type, others at `error`. The
response status and body are the ones Express would send anyway.

`LOG_LEVEL` sets the lowest level written: `debug`, `info` (default), `warn` or
`error`, case-insensitive. Unset or empty means `info`. Any other value runs at
`info` and writes one `logger.invalid_level` warning at startup; the warning does
not repeat the value. Completion records are `info`, so `LOG_LEVEL=warn` or `error`
drops them along with the rest of the request traffic, for example when the load
switch sends many `/work` requests. Aborted requests and errors are still written.
Redis client events (`redis.connected`, `redis.error`), the telemetry publisher
(`telemetry.publish_failed`) and startup records belong to the process and never
have `request_id`.

Sensitive values are kept out of the logs:

- Request headers, bodies, query strings and request objects are never logged.
  `Authorization` and `Cookie` values are not written.
- Each request's `Authorization`, `Proxy-Authorization` and `Cookie` values are
  replaced by `[REDACTED]` in every record of that request, including error
  messages and stack frames, and in records written later for it (completion,
  OOM fill). The whole header value is always removed, and so are the
  credential after the auth scheme and each cookie value of 4 or more
  characters.
- The value of `REDIS_PASS` is replaced by `[REDACTED]` wherever it appears,
  including error messages and stack frames. So are credentials in URLs
  (`//user:pass@`) and values under keys such as `password`, `token`, `secret`,
  `authorization` or `cookie`.
- Errors are reduced to `name`, `message`, `code`, `type`, `status` and the stack
  frames. Other properties, such as the raw body that a JSON parse error carries,
  are dropped. Messages of 4xx errors, which can quote the request body, are not
  logged.
- Newlines in messages or values are escaped, so input cannot start a new record.
- `event` is a fixed name set by the app and is never redacted, so a header that
  repeats it (for example `Authorization: Bearer http.request.completed`) cannot
  hide a request from event-based filtering.

## Release

Pull requests and pushes to `main` or `master` run `npm ci`, lint and tests on
Node.js 26, build the Docker image with `--pull`, and run `scripts/smoke.mjs` against
the container with `REDIS_ENABLED=false`. A failed check fails the `verify` job; the
container logs are printed and the container is removed in every case. The
`platforms` job builds `linux/amd64` and `linux/arm64` without pushing. Branch pushes only run CI; versions are released by pushing a `v*`
SemVer tag such as `v0.16.10` or `v0.17.0-rc.1`.
Tags must fit Docker's 128-character limit and omit `+build` metadata so the Git,
image, and deployment versions stay identical.

```bash
git tag v0.16.10
git push origin v0.16.10
```

These commands tag the local `HEAD`. To tag a commit whose CI you checked, use the
SHA form in [Verify a release](#verify-a-release).

The [release workflow](.github/workflows/release.yml) runs the same checks, then:

1. Builds and pushes `nalbam/sample-node:<tag>` for `linux/amd64` and `linux/arm64`.
   Stable versions also update `latest`; prereleases only publish their version tag.
2. Creates a GitHub Release with commit notes since the previous reachable version
   tag, excluding merge commits and `chore: release` commits. Reruns update the
   existing release. Tags with a prerelease suffix create GitHub prereleases.
3. Sends a GitOps dispatch to `opspresso/argocd-env-demo` for the `sample-node`
   project's `app` container in `alpha`.
4. For stable tags, sends the same version to `prod` through the GitHub `prod`
   environment, with `auto_merge=true` so GitOps updates its main branch directly.
   Prereleases stop at alpha. Configure required reviewers on the `prod`
   environment if production deployment requires manual approval.

Each stage requires the previous stage to succeed. Release runs are serialized
because they share `latest` and the deployment targets. A successful alpha dispatch
allows the prod job to proceed; it does not wait for the alpha rollout to finish.
GitOps dispatches request deployment; their success does not confirm that the
rollouts have completed.

Repository secrets: `DOCKER_USERNAME` and `DOCKER_PASSWORD` must allow pushing to
`nalbam/sample-node`; `GHP_TOKEN` must allow repository dispatches to
`opspresso/argocd-env-demo`. The workflow's `GITHUB_TOKEN` has write access only in
the GitHub Release job. Git tags are the release version source; the legacy
`VERSION` file is not used by this workflow.

### Verify a release

The image tag does not set the `VERSION` environment variable. A container started
without `VERSION` reports `v0.0.0`; the deployment must pass the tag as `VERSION`.

Before tagging, pick the commit and confirm that CI succeeded on it. Tag that
exact SHA: `git tag "$tag"` without a commit argument tags the local `HEAD`,
which `git fetch` does not move.

```bash
git fetch origin
sha=$(git rev-parse origin/main)   # or the full SHA of the commit you chose
gh run list --workflow push.yml --commit "$sha" --json databaseId,status,conclusion
# continue only when the run shows status "completed" and conclusion "success"

tag=v0.16.10
git tag "$tag" "$sha"
git push origin "$tag"
git rev-parse "$tag^{commit}"      # must print $sha
```

Then check each stage for that tag:

```bash
gh run list --workflow release.yml --branch "$tag" --limit 1
gh run view <run-id>                    # every job succeeded; prod is skipped for prereleases
gh release view "$tag" --json tagName,isPrerelease,targetCommitish,body
docker buildx imagetools inspect "nalbam/sample-node:$tag"   # lists linux/amd64 and linux/arm64

docker run -d --name sample-node-release -e REDIS_ENABLED=false -e VERSION="$tag" \
  -p 3000:3000 "nalbam/sample-node:$tag"
npm run smoke -- http://localhost:3000 "$tag"
docker rm -f sample-node-release
```

For a stable tag, also confirm that `docker buildx imagetools inspect nalbam/sample-node:latest`
shows the same digest as `nalbam/sample-node:$tag`.

## Endpoints

Every response carries an `X-Request-Id` header. The request's `X-Request-Id` value is echoed
back only when the whole value is 1 to 128 ASCII letters, digits, hyphens (`-`) or underscores
(`_`). A missing, empty or otherwise invalid value (longer than 128 characters, containing
whitespace or any other character) is never echoed, trimmed or reused; a new UUID is generated
for that request instead. Every log record written for the request carries the same value as
`request_id`; see [Logging](#logging).

### Pages

| Method | Path           | Description                                                  |
| ------ | -------------- | ------------------------------------------------------------ |
| GET    | `/`            | Info page: host, date, cluster, profile, message, version, and the kill switch |
| GET    | `/drop`        | Rollout visualization, `/drop/:rate` sets the success rate    |

`/` renders the pod that answered, and shows the local time in the reader's own zone.
The dashboard fills the viewport, with CPU and the HPA load test on the left and
memory and the OOM/alert test on the right. Pod and event panels scroll internally.
When Redis is available, each app process records its own `/status` snapshot in Redis every
second, independently of browser requests and load balancing. The dashboard reads
`/telemetry` with a stream cursor, so a different responding replica still returns
the next records from every pod. With no pod selected, the dashboard shows the
per-pod average across fresh recordings. Average history aligns each pod's latest
fresh sample on a common one-second timeline. Click a pod to inspect it; click the chart or an
empty area, press Escape, or choose "All pods · average" to clear the selection.
Chart controls preserve the selection. The readouts show app-container CPU in
millicores, memory in MiB, usage against its limits,
and process uptime. Redis retains five minutes of observations; choose a
1/3/5-minute window, freeze the charts, or scrub through individual samples.
Freezing charts keeps collection running. Background tabs pause browser reads;
each pod keeps recording. Returning to the tab or reloading backfills the retained
history. Genuine recording gaps and process restarts remain marked as breaks.

The kill switch automatically selects the pod that accepted `POST /oom`. Its
trace retains the memory climb, peak, 90% warning, and process restart. A new
process identity under the same pod name confirms a restart, even if it happened
between polls. The switch re-arms when that target responds after restarting.
Red chart markers show kill requests and green markers show recovery observations.
The HPA test records load start/stop markers, concurrent request intensity, remaining
time, and observed pod counts. These are pods publishing fresh telemetry, not
the HPA controller's desired replica count. OOM tests track the process lifecycle;
alert delivery must be checked in the connected monitoring system.

Pods are discovered from their recordings rather than by sampling load-balancer
responses. Previously seen pods remain visible with their last values and a stale
indicator after 10 seconds without a recording; this is not proof of an outage.
Redis failures are shown as telemetry unavailable, while existing charts remain
visible. The UI observes restarts rather than asserting their cause.
Confirm `OOMKilled` and the restart count in Kubernetes:

```bash
kubectl --context eks-demo -n sample get pods -l app.kubernetes.io/name=sample-node
kubectl --context eks-demo -n sample get pod <pod-name> -o jsonpath='{.status.containerStatuses[?(@.name=="app")].lastState.terminated.reason}'
```

The controls under it are the two switches: a load selector for 1, 5 or 10 minutes —
long enough to watch an HPA scale up, hold and scale back down — at 1x, 4x or 8x for
how hard, and the kill switch. The load switch sends traffic rather than burning CPU
in place; see *Chaos* below.

`/drop` polls `/success/:rate` every 100ms and drops a colored dot per response. Each
`VERSION` that answers gets its own color, and the bar at the bottom shows how the
responses split between them — so during a rollout you watch one color take over from
another. Failures fall in red, which makes `/drop/50` a quick way to see a partial
outage. It is a browser page, so open it rather than curl it.

### Probes and metrics

| Method | Path        | Description                                 |
| ------ | ----------- | ------------------------------------------- |
| GET    | `/read`     | Readiness probe                             |
| GET    | `/ready`    | Readiness check, returns `{"ready": true}` as JSON; `503` during [graceful shutdown](#graceful-shutdown) |
| GET    | `/live`     | Liveness probe, returns `{"live": true}` as JSON |
| GET    | `/version`  | Running version and Node.js version as JSON |
| GET    | `/runtime`  | Node.js version and platform as JSON        |
| GET    | `/uptime`   | Process uptime in seconds as JSON           |
| GET    | `/ping`     | Health check, returns `{"pong": true}` as JSON |
| GET    | `/echo`     | Returns the `msg` query as `{"echo": msg}`; 400 with `{"error": "msg is required"}` if `msg` is missing, empty, or not a single string |
| GET    | `/time`     | Current time in ISO 8601 as `{"time": ...}` |
| GET    | `/random`   | Random number in [0, 1) as `{"value": ...}` |
| GET    | `/uuid`     | Random UUID v4 as `{"uuid": ...}` |
| GET    | `/hostname` | Host name of the answering pod as `{"hostname": ...}` |
| GET    | `/health`   | Health check with `result`, `version` and `uptime` (integer seconds); fails at `FAULT_RATE` percent |
| GET    | `/status`   | Process identity, uptime, app-container CPU/memory, limits, and OOM allocation state |
| GET    | `/telemetry` | Shared pod history; use the returned `cursor` as `?after=<cursor>` for subsequent records |
| GET    | `/metrics`  | Prometheus metrics                          |

`/status` is not affected by `FAULT_RATE` and sends `Cache-Control: no-store`.
`/health` is the probe and fails at `FAULT_RATE`. Both the 200 and the 500 response include `uptime` in integer seconds. On Linux, cgroup v2/v1 counters
measure the app container rather than the whole node or its sidecars. Memory usage
includes cgroup-charged cache; `memory.rss` separately reports process RSS. CPU is
the change in cumulative CPU time over a monotonic sample interval (at least 500ms).
Outside cgroups the endpoint explicitly reports process scope; unknown limits and
CPU percentages without a limit are `null`. CPU usage is `null` until a rate can
be measured. `instanceId` changes on every process start, and `oom` reports whether
the kill switch is allocating, its start time, allocated bytes, and safety-cap state.

`/telemetry` returns at most 500 records per response and sets `more` when the next
page should be requested immediately. Stream IDs order recordings across pods;
the UI uses recording times, not fetch arrival times, to draw the chart. Storage
uses the `sample-node:telemetry:<cluster>:<profile>` stream as an index. Each sample
payload is stored under its own `:sample:<id>` key, expiring exactly 300 seconds
after its capture time, even if a write is delayed or every publisher stops.
Index entries older than five minutes are
trimmed on publish; the index itself expires after five minutes without a publisher.

### Chaos

| Method | Path             | Description                                            |
| ------ | ---------------- | ------------------------------------------------------ |
| GET    | `/work/:ms`      | Burns `ms` milliseconds of CPU answering this one request, up to 1000 |
| POST   | `/oom`           | Kill switch, allocates memory at a 30s fill target until the kernel OOM kills it (exit 137) |
| GET    | `/delay/:sec`    | Responds after `sec` seconds                           |
| GET    | `/success/:rate` | Returns 200 at `rate` percent                          |
| GET    | `/fault/:rate`   | Returns 500 at `rate` percent                          |
| GET    | `/loop/:count`   | Calls `LOOP_HOST` recursively `count` times            |

`POST /oom` reads the memory limit and sizes each 500ms allocation from the gap
between current RSS and 110% of the limit, using a 30-second fill target. Actual
OOM timing also depends on cgroup accounting, memory reclaim, and CPU throttling.
Without a memory limit there is
nothing to trigger the kernel, so it stops at a 1.2Gi cap and keeps running. It is
`POST` so a prefetch, crawler or probe cannot trip it.

`GET /work/:ms` is the target for load rather than a switch that turns load on. The
switch on `/` keeps a set number of requests in flight at 100ms of work each, so its
level marks — 1x, 4x, 8x — are about that many cores of work, and the load balancer
decides which pod answers each request. Because the total stays put as pods come and
go, an HPA scaling up cuts the per-pod share instead of being handed more work, and
the CPU meters in the pod list settle at the new level. That is the behavior to
watch; a self-inflicted burn on one pod would only move the average by its share. A
single request is capped at a second because the burn blocks the event loop, and the
liveness probe has to keep answering.

Each response starts the next request, rather than a timer doing it, so the load
holds while you watch `kubectl` in another window — a hidden tab throttles timers to
once a second, and to once a minute after five minutes, which used to gut it. The
deadline is checked on the same refill, so a throttled tab stops on time too.

Two things still bound it. A browser opens about six connections per host over
HTTP/1.1, so 8x only lands in full over HTTP/2 and the rest waits in the browser.
And the round trip counts against the 100ms, so a distant cluster delivers somewhat
less than the mark says. For a run that outlives the tab, drive `/work` from a shell.

```bash
while true; do curl -s localhost:3000/work/50 >/dev/null; done
curl -X POST localhost:3000/oom
curl localhost:3000/status
curl localhost:3000/delay/3
curl localhost:3000/fault/50
```

### Remote services

| Method | Path      | Description                                |
| ------ | --------- | ------------------------------------------ |
| GET    | `/node`   | Calls `/health` of a remote sample service |
| GET    | `/spring` | Calls `/health` of a remote sample service |
| GET    | `/tomcat` | Calls `/health` of a remote sample service |

`PROFILE` decides how those services are addressed — see [Environment](#environment).

### Redis

| Method | Path             | Description                           |
| ------ | ---------------- | ------------------------------------- |
| GET    | `/cache/:name`   | Reads a JSON value from Redis         |
| PUT    | `/cache/:name`   | Writes the JSON request body to Redis |

```bash
curl -X PUT localhost:3000/cache/foo -H 'Content-Type: application/json' -d '{"a":1}'
curl localhost:3000/cache/foo
```

## Environment

| Variable       | Default                      | Description                             |
| -------------- | ---------------------------- | --------------------------------------- |
| `PORT`         | `3000`                       | Listen port                             |
| `PROFILE`      | `default`                    | `default` calls `http://sample-<name>`, anything else calls `<PROTOCOL>://sample-<name>.<HOSTNAME>` |
| `PROTOCOL`     | `http`                       | Protocol for non-default profiles       |
| `HOSTNAME`     | `default.svc.cluster.local`  | Domain suffix for non-default profiles  |
| `CLUSTER_NAME` | `local`                      | Cluster name shown on the info page      |
| `MESSAGE`      | -                            | Message shown on the info page           |
| `VERSION`      | `v0.0.0`                     | Version reported in responses            |
| `FAULT_RATE`   | `0`                          | Percentage of `/health` calls that fail  |
| `LOOP_HOST`    | `http://sample-node`         | Target of `/loop/:count`                 |
| `REDIS_ENABLED` | `true`                     | Set to `false` to disable Redis features and connections |
| `REDIS_HOST`   | `redis`                      | Redis host                               |
| `REDIS_PORT`   | `6379`                       | Redis port                               |
| `REDIS_PASS`   | -                            | Redis password; redacted from logs       |
| `LOG_LEVEL`    | `info`                       | Lowest log level written: `debug`, `info`, `warn` or `error`; other values fall back to `info` with one warning. See [Logging](#logging) |
| `SHUTDOWN_TIMEOUT_MS` | `10000`               | Deadline in milliseconds from the first `SIGTERM`/`SIGINT` for finishing requests and closing resources; exceeding it exits with code `1`. Must be a whole number from `1` to `2147483647` (digits only, surrounding spaces allowed); unset, empty, `0`, negative, fractional, exponent, unit-suffixed (`5s`) or out-of-range values use `10000`. See [Graceful shutdown](#graceful-shutdown) |

## License

GPL-3.0. See [LICENSE](LICENSE).
