FROM node:20-alpine

LABEL maintainer="Pennderin"
LABEL description="Media Companion — mobile PWA frontend for Media Manager"

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY public/ ./public/

ENV PORT=3000
ENV CONFIG_DIR=/config
ENV MANAGER_URL=http://media-manager:9876

RUN mkdir -p /config

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/ping || exit 1

CMD ["node", "server.js"]
