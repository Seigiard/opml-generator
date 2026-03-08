FROM oven/bun:1-alpine AS base
RUN apk add --no-cache imagemagick imagemagick-jpeg inotify-tools nginx openssl ffmpeg \
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
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV FILES=/audiobooks
ENV DATA=/data
ENV PORT=3000

# nginx listens on port 80
EXPOSE 80

VOLUME ["/audiobooks", "/data"]

ENTRYPOINT []
CMD ["/bin/sh", "/app/entrypoint.sh"]
