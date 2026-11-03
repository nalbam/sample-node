# Dockerfile

FROM node:26-alpine

LABEL maintainer="me@nalbam.com" \
      org.opencontainers.image.description="A Sample Docker image for Nodejs App" \
      org.opencontainers.image.authors="Jungyoul Yu, me@nalbam.com, https://www.nalbam.com/" \
      org.opencontainers.image.source="https://github.com/nalbam/sample-node" \
      org.opencontainers.image.title="sample-node"

# node:26-alpine is a multi-platform image (linux/amd64, linux/arm64) and the
# app has no native modules, so the same Dockerfile builds for both.
ENV NODE_ENV=production \
    PORT=3000

# The server listens on PORT; override it together with the published port.
EXPOSE 3000

WORKDIR /usr/src/app

COPY --chown=node:node package*.json ./

RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .

USER node

# Node runs as PID 1 through the exec-form CMD, so it receives this signal directly.
STOPSIGNAL SIGTERM

CMD ["node", "server.js"]
