#!/bin/sh
set -e

NGINX_PID=
BUN_PID=
WATCHER_PID=
STOPPING=0
forward_stop() {
  STOPPING=1
  echo "[entrypoint] Shutting down..."
  for pid in "$BUN_PID" "$WATCHER_PID" "$NGINX_PID"; do
    [ -z "$pid" ] || kill -TERM "$pid" 2>/dev/null || true
  done
}
trap forward_stop TERM INT

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
[ "$STOPPING" = 0 ] || exit 0

echo "[entrypoint] Starting nginx..."
nginx &
NGINX_PID=$!
[ "$STOPPING" = 0 ] || forward_stop

echo "[entrypoint] Starting Bun server on port $BUN_PORT..."
if [ "$DEV_MODE" = "true" ]; then
  bun --smol run --watch "${SERVER_MODULE:-/app/src/server.ts}" &
else
  bun --smol run "${SERVER_MODULE:-/app/src/server.ts}" &
fi
BUN_PID=$!
[ "$STOPPING" = 0 ] || forward_stop

echo "[entrypoint] Starting watcher..."
sh /app/src/watcher.sh &
WATCHER_PID=$!
[ "$STOPPING" = 0 ] || forward_stop

echo "[entrypoint] All processes started. Monitoring..."
STATUS=0
while [ "$STOPPING" = 0 ]; do
  for pid in "$BUN_PID" "$WATCHER_PID" "$NGINX_PID"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[entrypoint] Child $pid exited unexpectedly"
      STATUS=1
      forward_stop
      break
    fi
  done
  sleep 0.2 &
  TICK_PID=$!
  wait "$TICK_PID" || true
done

# Repeated signals must not interrupt the owned child waits.
trap '' TERM INT
kill "$TICK_PID" 2>/dev/null || true
wait "$TICK_PID" 2>/dev/null || true
# The application has 8 seconds. Helpers have an additional 3 seconds.
# The disposable watchdog and its sleep have one owned process group.
setsid sh -c '
  sleep 11
  echo "[entrypoint] Child shutdown deadline expired" >&2
  kill -KILL "$@" 2>/dev/null || true
' watchdog "$BUN_PID" "$WATCHER_PID" "$NGINX_PID" &
DEADLINE_PID=$!
# Confirm setsid has created the group before a fast child exit can cancel it.
while ! kill -0 "-$DEADLINE_PID" 2>/dev/null; do
  if ! kill -0 "$DEADLINE_PID" 2>/dev/null; then STATUS=1; break; fi
  sleep 0.01
done
trap '' TERM INT
for pid in "$BUN_PID" "$WATCHER_PID" "$NGINX_PID"; do
  child_status=0
  wait "$pid" || child_status=$?
  echo "[entrypoint] Reaped $pid status=$child_status"
  [ "$child_status" = 0 ] || STATUS=1
done
kill -KILL "-$DEADLINE_PID" 2>/dev/null || true
wait "$DEADLINE_PID" 2>/dev/null || true
exit "$STATUS"
