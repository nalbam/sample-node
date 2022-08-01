# Dockerfile

FROM node:16-alpine

LABEL maintainer="me@nalbam.com" \
      org.opencontainers.image.description="A Sample Docker image for Nodejs App" \
      org.opencontainers.image.authors="Jungyoul Yu, me@nalbam.com, https://www.nalbam.com/" \
      org.opencontainers.image.source="https://github.com/nalbam/sample-node" \
      org.opencontainers.image.title="sample-node"

EXPOSE 3000

WORKDIR /usr/src/app

COPY . .

RUN npm install

CMD ["node", "server.js"]
