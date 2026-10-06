#!/bin/sh
set -e

BOOKS_DIR="${FILES:-/audiobooks}"
DATA_DIR="${DATA:-/data}"
BUN_PORT="${PORT:-3000}"
SERVER_URL="http://127.0.0.1:$BUN_PORT"

# Each pipeline has a separate process group, including an in-flight wget.
if [ "${1:-}" = worker ]; then
  directory=$2
  endpoint=$3
  set -- --no-dereference
  if [ "$endpoint" = data ]; then
    set -- --exclude '(feed\.xml|feed\.opml|events\.jsonl|errors\.jsonl)$'
  fi
  inotifywait -m -r -e close_write -e delete -e moved_from -e moved_to -e create -e Q_OVERFLOW \
    "$@" \
    --no-newline --format '%w%0%f%0%e%0' \
    "$directory" 2>/dev/null | bun /app/src/watcher-events.ts "$SERVER_URL" "$endpoint" "$$"
  exit
fi

BOOKS_PID=
DATA_PID=
STOPPING=0
stop() {
  STOPPING=1
  echo "[watcher] Shutting down..."
  for pid in "$BOOKS_PID" "$DATA_PID"; do
    [ -z "$pid" ] || kill -TERM "-$pid" 2>/dev/null || true
  done
}
trap stop TERM INT

echo "[watcher] Waiting for Bun server on port $BUN_PORT..."
while [ "$STOPPING" = 0 ] && ! nc -z 127.0.0.1 "$BUN_PORT" 2>/dev/null; do
  sleep 0.2 &
  TICK_PID=$!
  wait "$TICK_PID" || true
done

if [ "$STOPPING" = 0 ]; then
  setsid sh /app/src/watcher.sh worker "$BOOKS_DIR" books &
  BOOKS_PID=$!
  [ "$STOPPING" = 0 ] || stop
fi
if [ "$STOPPING" = 0 ]; then
  setsid sh /app/src/watcher.sh worker "$DATA_DIR" data &
  DATA_PID=$!
  [ "$STOPPING" = 0 ] || stop
fi

STATUS=0
while [ "$STOPPING" = 0 ]; do
  for pid in "$BOOKS_PID" "$DATA_PID"; do
    if ! kill -0 "$pid" 2>/dev/null; then STATUS=1; stop; break; fi
  done
  sleep 0.2 &
  TICK_PID=$!
  wait "$TICK_PID" || true
done
trap '' TERM INT
[ -z "${TICK_PID:-}" ] || kill "$TICK_PID" 2>/dev/null || true
[ -z "${TICK_PID:-}" ] || wait "$TICK_PID" 2>/dev/null || true
for pid in "$BOOKS_PID" "$DATA_PID"; do
  [ -z "$pid" ] || wait "$pid" 2>/dev/null || true
done
exit "$STATUS"
