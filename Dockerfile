FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_DIR=/app/storage

WORKDIR /app

# Tidak ada dependency npm: cukup salin source
COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/storage && chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "src/server.js"]
