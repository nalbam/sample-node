# syntax=docker/dockerfile:1

# build: lints and tests on the build platform, then keeps the production
# dependencies. The app has no native modules, so the same node_modules runs on
# linux/amd64 and linux/arm64.
FROM --platform=$BUILDPLATFORM node:26-alpine AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY eslint.config.js server.js ./
COPY lib lib
COPY public public
COPY views views
COPY test test
RUN npm run lint && npm test -- --runInBand
RUN npm ci --omit=dev && npm cache clean --force \
 && mkdir /out && cp -R package.json package-lock.json server.js lib public views node_modules /out/

# artifact: the release artifact, exported by scripts/release.sh artifact.
FROM scratch AS artifact
COPY --from=build /out /

FROM node:26-alpine

LABEL org.opencontainers.image.title="sample-node" \
      org.opencontainers.image.description="A sample Node.js app for Kubernetes demos" \
      org.opencontainers.image.source="https://github.com/nalbam/sample-node"

ARG VERSION=v0.0.0-dev

ENV NODE_ENV=production \
    PORT=3000 \
    VERSION=${VERSION}

WORKDIR /usr/src/app

COPY --from=artifact / ./

USER node

EXPOSE 3000

# Node runs as PID 1 through the exec-form CMD, so it receives this signal directly.
STOPSIGNAL SIGTERM

CMD ["node", "server.js"]
