FROM oven/bun:1-alpine AS base
RUN apk add --no-cache inotify-tools nginx nginx-mod-http-js openssl ffmpeg \
    && addgroup nginx bun
WORKDIR /app

FROM base AS development
COPY package.json bun.lock* ./
RUN bun install

FROM base AS production
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY static ./static
COPY nginx.conf.template /app/nginx.conf.template
COPY nginx-opml.js /app/nginx-opml.js
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV FILES=/audiobooks
ENV DATA=/data
ENV PORT=3000

# nginx listens on port 80
EXPOSE 80

VOLUME ["/audiobooks", "/data"]

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=60s \
  CMD wget -q --spider http://127.0.0.1/feed.opml || exit 1

ENTRYPOINT []
CMD ["/bin/sh", "/app/entrypoint.sh"]
