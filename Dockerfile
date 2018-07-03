# Dockerfile

FROM node:latest

MAINTAINER me@nalbam.com

ENV TZ=Asia/Seoul
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

EXPOSE 3000

WORKDIR data

COPY app.js /data/
COPY favicon.ico /data/
COPY package.json /data/
COPY views/* /data/views/

RUN npm install -s

CMD ["node", "app.js"]
