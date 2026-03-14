#!/bin/sh
set -e

BUN_PORT="${PORT:-3000}"
export BUN_PORT

echo "[entrypoint] Configuring nginx..."

# Generate htpasswd if auth credentials provided
if [ -n "$ADMIN_USER" ] && [ -n "$ADMIN_TOKEN" ]; then
  echo "[entrypoint] Setting up Basic Auth for /resync"
  echo "$ADMIN_USER:$(openssl passwd -apr1 "$ADMIN_TOKEN")" > /etc/nginx/.htpasswd
  AUTH_ENABLED=1
else
  echo "[entrypoint] No ADMIN_USER/ADMIN_TOKEN - /resync disabled"
  AUTH_ENABLED=0
fi

# Rate limit: MB -> nginx format (0 = disabled)
if [ -n "$RATE_LIMIT_MB" ] && [ "$RATE_LIMIT_MB" != "0" ]; then
  RATE_LIMIT="${RATE_LIMIT_MB}m"
  echo "[entrypoint] Rate limit: ${RATE_LIMIT_MB} MB/s"
else
  RATE_LIMIT="0"
  echo "[entrypoint] Rate limit: disabled"
fi
export RATE_LIMIT

# Generate nginx.conf from template
sed -e "s/\${BUN_PORT}/$BUN_PORT/g" -e "s/\${RATE_LIMIT}/$RATE_LIMIT/g" /app/nginx.conf.template > /tmp/nginx.conf

# Remove auth block if not configured
if [ "$AUTH_ENABLED" = "0" ]; then
  sed -i '/# AUTH_BLOCK_START/,/# AUTH_BLOCK_END/d' /tmp/nginx.conf
fi

cp /tmp/nginx.conf /etc/nginx/nginx.conf

echo "[entrypoint] Starting nginx..."
nginx &
NGINX_PID=$!

echo "[entrypoint] Starting Bun server on port $BUN_PORT..."
if [ "$DEV_MODE" = "true" ]; then
  bun --smol run --watch /app/src/server.ts &
else
  bun --smol run /app/src/server.ts &
fi
BUN_PID=$!

echo "[entrypoint] Starting watcher..."
sh /app/src/watcher.sh &
WATCHER_PID=$!

# Graceful shutdown handler
cleanup() {
  echo "[entrypoint] Shutting down..."
  kill "$WATCHER_PID" 2>/dev/null || true
  kill "$BUN_PID" 2>/dev/null || true
  kill "$NGINX_PID" 2>/dev/null || true
  wait
  exit 0
}

trap cleanup SIGTERM SIGINT

echo "[entrypoint] All processes started. Monitoring..."

while true; do
  kill -0 "$BUN_PID" 2>/dev/null || { echo "[entrypoint] Bun process died"; break; }
  kill -0 "$NGINX_PID" 2>/dev/null || { echo "[entrypoint] nginx process died"; break; }
  sleep 5
done

cleanup
