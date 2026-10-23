FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY bot.js ./

ENV NODE_ENV=production \
    DB_PATH=/app/data/bot.db
VOLUME ["/app/data"]

USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "bot.js"]
