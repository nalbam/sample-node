# Dockerfile

FROM node:12-alpine
RUN apk add --no-cache bash curl
EXPOSE 3000
WORKDIR /data
# RUN npm run build
ADD . /data
CMD ["node", "server.js"]
