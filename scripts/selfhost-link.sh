#!/usr/bin/env bash
# Prints the public link of the self-hosted server (compose.yaml).
#
# The Cloudflare quick tunnel announces its *.trycloudflare.com address in its
# log when it starts, and gets a new one every time it restarts, so the last
# address in the log is the live one.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "$(docker compose ps --status running --quiet tunnel 2>/dev/null)" ]; then
    echo "The tunnel isn't running. Start everything with: docker compose up -d --build" >&2
    echo "If it's starting, check progress with: docker compose ps" >&2
    exit 1
fi

# The tunnel takes a few seconds to register after its container starts.
for _ in $(seq 30); do
    link=$(docker compose logs --no-color tunnel 2>&1 |
        grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -n 1 || true)
    if [ -n "$link" ]; then
        echo "$link"
        exit 0
    fi
    sleep 2
done

echo "The tunnel is running but hasn't announced a link after 60s." >&2
echo "See what it says with: docker compose logs tunnel" >&2
exit 1
