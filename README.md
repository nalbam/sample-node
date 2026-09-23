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
docker run -m 128m -p 3000:3000 nalbam/sample-node
```

## Kubernetes

`requests` and `limits` set to the same memory makes the pod Guaranteed, so `POST /oom`
kills that pod alone at exactly its limit.

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
      containers:
        - name: sample-node
          image: nalbam/sample-node
          ports:
            - containerPort: 3000
          readinessProbe:
            httpGet:
              path: /read
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

## Development

Requires Node.js 24 or later. Redis is optional — the app starts without it and the
Redis-backed endpoints answer `503` until it is reachable.

```bash
npm install
npm start          # http://localhost:3000
npm run lint
npm test
```

## Release

Pull requests and pushes to `main` or `master` run `npm ci`, lint, and tests on
Node.js 24. Branch pushes only run CI; versions are released by pushing a `v*`
SemVer tag such as `v0.16.10` or `v0.17.0-rc.1`.
Tags must fit Docker's 128-character limit and omit `+build` metadata so the Git,
image, and deployment versions stay identical.

```bash
git tag v0.16.10
git push origin v0.16.10
```

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

## Endpoints

### Pages

| Method | Path           | Description                                                  |
| ------ | -------------- | ------------------------------------------------------------ |
| GET    | `/`            | Info page: host, date, cluster, profile, message, version, and the kill switch |
| GET    | `/drop`        | Rollout visualization, `/drop/:rate` sets the success rate    |

`/` renders the pod that answered, and shows the local time in the reader's own zone.
The dashboard fills the viewport, with CPU and the HPA load test on the left and
memory and the OOM/alert test on the right. Pod and event panels scroll internally.
The live dashboard samples `/status` about once a second. Select a responding pod
to see app-container CPU in millicores, memory in MiB, usage against its limits,
and process uptime. The charts retain five minutes of observations; choose a
1/3/5-minute window, freeze the charts, or scrub through individual samples.
Freezing charts keeps collection running. Background tabs pause collection.

The kill switch automatically selects the pod that accepted `POST /oom`. Its
trace retains the memory climb, peak, 90% warning, and process restart. A new
process identity under the same pod name confirms a restart, even if it happened
between polls. The switch re-arms when that target responds after restarting.
Red chart markers show kill requests and green markers show recovery observations.
The HPA test records load start/stop markers, concurrent request intensity, remaining
time, and observed pod counts. These are responding pods seen by the browser, not
the HPA controller's desired replica count. OOM tests track the process lifecycle;
alert delivery must be checked in the connected monitoring system.

Only responding pods are discovered through the service. Previously seen pods
remain visible with their last values and a stale indicator after 10 seconds
without a sample; this is not proof of an outage. The UI observes restarts rather
than asserting their cause. Confirm `OOMKilled` and the restart count in Kubernetes:

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
| GET    | `/live`     | Liveness probe                              |
| GET    | `/health`   | Health check, fails at `FAULT_RATE` percent |
| GET    | `/status`   | Process identity, uptime, app-container CPU/memory, limits, and OOM allocation state |
| GET    | `/metrics`  | Prometheus metrics                          |

`/status` is not affected by `FAULT_RATE` and sends `Cache-Control: no-store`.
`/health` is the probe and fails at `FAULT_RATE`. On Linux, cgroup v2/v1 counters
measure the app container rather than the whole node or its sidecars. Memory usage
includes cgroup-charged cache; `memory.rss` separately reports process RSS. CPU is
the change in cumulative CPU time over a monotonic sample interval (at least 500ms).
Outside cgroups the endpoint explicitly reports process scope; unknown limits and
CPU percentages without a limit are `null`. CPU usage is `null` until a rate can
be measured. `instanceId` changes on every process start, and `oom` reports whether
the kill switch is allocating, its start time, allocated bytes, and safety-cap state.

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
| GET    | `/counter/:name` | Reads a counter from Redis            |
| POST   | `/counter/:name` | Increments a counter in Redis         |
| DELETE | `/counter/:name` | Deletes a counter in Redis            |

```bash
curl -X PUT localhost:3000/cache/foo -H 'Content-Type: application/json' -d '{"a":1}'
curl localhost:3000/cache/foo

curl -X POST localhost:3000/counter/hits
curl localhost:3000/counter/hits
curl -X DELETE localhost:3000/counter/hits
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
| `REDIS_HOST`   | `redis`                      | Redis host                               |
| `REDIS_PORT`   | `6379`                       | Redis port                               |
| `REDIS_PASS`   | -                            | Redis password                           |

## License

GPL-3.0. See [LICENSE](LICENSE).
