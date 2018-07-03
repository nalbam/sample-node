# Dockerfile

FROM node:latest

MAINTAINER me@nalbam.com

ENV TZ=Asia/Seoul
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

EXPOSE 3000

WORKDIR data

COPY server.js .
COPY package.json .

RUN npm install -s

CMD ["node", "server.js"]
