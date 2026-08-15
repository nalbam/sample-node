# sample-node

[![build](https://img.shields.io/github/actions/workflow/status/nalbam/sample-node/push.yml?branch=main&style=for-the-badge&logo=github)](https://github.com/nalbam/sample-node/actions/workflows/push.yml)
[![release](https://img.shields.io/github/v/release/nalbam/sample-node?style=for-the-badge&logo=github)](https://github.com/nalbam/sample-node/releases)

[![Docker Image Version (latest by date)](https://img.shields.io/docker/v/nalbam/sample-node?label=Docker%20Hub&style=for-the-badge&logo=docker)](https://hub.docker.com/r/nalbam/sample-node)
[![Docker Image Size (latest by date)](https://img.shields.io/docker/image-size/nalbam/sample-node?style=for-the-badge&logo=docker)](https://hub.docker.com/r/nalbam/sample-node)
[![Docker Pulls](https://img.shields.io/docker/pulls/nalbam/sample-node?style=for-the-badge&logo=docker)](https://hub.docker.com/r/nalbam/sample-node)

<!-- [![DockerHub Badge](http://dockeri.co/image/nalbam/sample-node)](https://hub.docker.com/r/nalbam/sample-node/) -->

## Docker

```bash
docker pull nalbam/sample-node
```

## Development

Requires Node.js 24 or later.

```bash
npm install
npm start          # http://localhost:3000
npm run lint
npm test
```

## Endpoints

| Method | Path             | Description                                            |
| ------ | ---------------- | ------------------------------------------------------ |
| GET    | `/`              | Info page (host, date, cluster, profile, message, version) |
| GET    | `/drop`          | Traffic visualization page, `/drop/:rate` sets the rate |
| GET    | `/read`          | Readiness probe                                         |
| GET    | `/live`          | Liveness probe                                          |
| GET    | `/health`        | Health check, fails at `FAULT_RATE` percent             |
| GET    | `/metrics`       | Prometheus metrics                                      |
| GET    | `/node`          | Calls `/health` of a remote sample service              |
| GET    | `/spring`        | Calls `/health` of a remote sample service              |
| GET    | `/tomcat`        | Calls `/health` of a remote sample service              |
| GET    | `/loop/:count`   | Calls `LOOP_HOST` recursively `count` times             |
| GET    | `/stress`        | Burns CPU                                               |
| GET    | `/success/:rate` | Returns 200 at `rate` percent                           |
| GET    | `/fault/:rate`   | Returns 500 at `rate` percent                           |
| GET    | `/delay/:sec`    | Responds after `sec` seconds                            |
| GET    | `/cache/:name`   | Reads a JSON value from Redis                           |
| POST   | `/cache/:name`   | Writes the JSON request body to Redis                   |
| GET    | `/counter/:name` | Reads a counter from Redis                              |
| POST   | `/counter/:name` | Increments a counter in Redis                           |
| DELETE | `/counter/:name` | Decrements a counter in Redis                           |

Redis-backed endpoints return `503` while Redis is unreachable.

## Environment

| Variable       | Default                      | Description                             |
| -------------- | ---------------------------- | --------------------------------------- |
| `PORT`         | `3000`                       | Listen port                             |
| `PROFILE`      | `default`                    | Remote service addressing mode          |
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
