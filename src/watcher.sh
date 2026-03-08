#!/bin/sh
set -e

BOOKS_DIR="${FILES:-/audiobooks}"
DATA_DIR="${DATA:-/data}"
BUN_PORT="${PORT:-3000}"
SERVER_URL="http://127.0.0.1:$BUN_PORT"

echo "[watcher] Waiting for Bun server on port $BUN_PORT..."
until nc -z 127.0.0.1 "$BUN_PORT" 2>/dev/null; do
  sleep 0.5
done
echo "[watcher] Bun server is up"

echo "[watcher] Starting /books watcher..."
inotifywait -m -r \
  -e close_write -e delete -e moved_from -e moved_to -e create \
  --format '{"parent":"%w","name":"%f","events":"%e"}' \
  "$BOOKS_DIR" 2>/dev/null | \
  while read -r line; do
    case "$line" in
      *IN_Q_OVERFLOW*)
        echo "[watcher] inotify queue overflow detected, triggering resync"
        wget -q --post-data='' -O /dev/null "$SERVER_URL/resync" 2>/dev/null || true
        ;;
      *)
        wget -q --post-data="$line" --header="Content-Type: application/json" -O /dev/null "$SERVER_URL/events/books" 2>/dev/null || true
        ;;
    esac
  done &
BOOKS_WATCHER_PID=$!

echo "[watcher] Starting /data watcher..."
inotifywait -m -r \
  -e close_write -e moved_to \
  --exclude '(events\.jsonl|errors\.jsonl)$' \
  --format '{"parent":"%w","name":"%f","events":"%e"}' \
  "$DATA_DIR" 2>/dev/null | \
  while read -r line; do
    wget -q --post-data="$line" --header="Content-Type: application/json" -O /dev/null "$SERVER_URL/events/data" 2>/dev/null || true
  done &
DATA_WATCHER_PID=$!

cleanup() {
  echo "[watcher] Shutting down..."
  kill $BOOKS_WATCHER_PID $DATA_WATCHER_PID 2>/dev/null || true
  exit 0
}

trap cleanup SIGTERM SIGINT

echo "[watcher] All watchers started. Waiting..."
wait
