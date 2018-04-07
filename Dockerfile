# Dockerfile

FROM node:latest

MAINTAINER me@nalbam.com

ENV TZ=Asia/Seoul
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

EXPOSE 3000

COPY server.js .
COPY package.json .

RUN npm install

CMD ["node", "server.js"]
