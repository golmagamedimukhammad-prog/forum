FROM node:22-alpine

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
