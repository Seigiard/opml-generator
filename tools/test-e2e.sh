#!/bin/sh
set -eu

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if docker compose -f docker-compose.e2e.yml down; then
    exit "$status"
  fi
  if [ "$status" -ne 0 ]; then
    exit "$status"
  fi
  exit 1
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

docker compose -f docker-compose.e2e.yml up -d --build --wait
bun test test/e2e
