# Dockerfile

FROM node:6.9.2

MAINTAINER me@nalbam.com

EXPOSE 8080

COPY server.js .

CMD node server.js
