# sample-node

[![build](https://img.shields.io/github/actions/workflow/status/nalbam/sample-node/push.yml?branch=main&style=for-the-badge&logo=github)](https://github.com/nalbam/sample-node/actions/workflows/push.yml)
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

## Endpoints

### Pages

| Method | Path           | Description                                                  |
| ------ | -------------- | ------------------------------------------------------------ |
| GET    | `/`            | Info page: host, date, cluster, profile, message, version, and the kill switch |
| GET    | `/drop`        | Rollout visualization, `/drop/:rate` sets the success rate    |

`/` renders the pod that answered, and shows the local time in the reader's own zone.
It also samples `/status` every couple of seconds and lists the pods that reply, with
each one's uptime, memory and CPU against its limits — enough to watch a rollout or a
load test without leaving the page. Only pods that answer appear, so a `Pending` or
`CrashLoopBackOff` pod shows up as a smaller count rather than a row.

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
| GET    | `/status`   | Uptime, memory and CPU against this pod's limits |
| GET    | `/metrics`  | Prometheus metrics                          |

`/status` is the observation endpoint and always succeeds; `/health` is the probe and
fails at `FAULT_RATE`. Memory comes from `process.constrainedMemory()` and the CPU
limit from cgroup, so both report `null` limits outside a container.

### Chaos

| Method | Path             | Description                                            |
| ------ | ---------------- | ------------------------------------------------------ |
| POST   | `/stress/:sec`   | Holds CPU at ~90% for `sec` seconds, `/stress` defaults to 60 |
| DELETE | `/stress`        | Stops the burn early                                   |
| POST   | `/oom`           | Kill switch, fills the container memory limit over ~60s until the kernel OOM kills it (exit 137) |
| GET    | `/delay/:sec`    | Responds after `sec` seconds                           |
| GET    | `/success/:rate` | Returns 200 at `rate` percent                          |
| GET    | `/fault/:rate`   | Returns 500 at `rate` percent                          |
| GET    | `/loop/:count`   | Calls `LOOP_HOST` recursively `count` times            |

`POST /oom` reads the memory limit and sizes its allocations to reach 110% of it over
about 60 seconds, so it dies at the same pace on a 128Mi pod and a 4Gi one — slow
enough for a metrics scrape to catch the climb. Without a memory limit there is
nothing to trigger the kernel, so it stops at a 1.2Gi cap and keeps running.

`POST /stress/:sec` burns in short slices instead of one long loop, yielding just
enough for the liveness probe to keep answering. Under a small `limits.cpu` the kernel
throttles on top of that and the probe may still time out — the pod restarting is then
part of what you are demonstrating.

Both are `POST` so a prefetch, crawler or probe cannot trip them. Which pod picks up
the request is the load balancer's choice, including the `DELETE` that stops a burn —
the pod list on `/` is what shows where it actually landed.

```bash
curl -X POST localhost:3000/stress/60
curl -X DELETE localhost:3000/stress
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
