#!/usr/bin/env bash

set -e

INNGEST_CONFIG=".config/inngest/inngest.yaml"

echo "🤖 Starting unified bot server on port 3000..."
PORT=3000 npx tsx src/server.ts &
BOT_PID=$!
echo "✅ Bot server started with PID: $BOT_PID"

sleep 2

if [[ ! -f  "${INNGEST_CONFIG}" ]]; then
    mkdir -p "$(dirname "${INNGEST_CONFIG}")"
    if [[ -n "${DATABASE_URL}" ]]; then
        printf 'postgres-uri: "%s"' "${DATABASE_URL}" > "${INNGEST_CONFIG}"
    else
        printf 'sqlite-dir: "/home/runner/workspace/.local/share/inngest"' > "${INNGEST_CONFIG}"
    fi
fi
exec inngest-cli dev -u http://localhost:5000/api/inngest --host 127.0.0.1 --port 8289 --config "${INNGEST_CONFIG}"
