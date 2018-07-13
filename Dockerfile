# Dockerfile

FROM node:latest

ENV TZ=Asia/Seoul
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

EXPOSE 3000

WORKDIR data

COPY server.js /data/
COPY package.json /data/
COPY views/* /data/views/

RUN npm install -s

CMD ["node", "server.js"]
