#!/usr/bin/env bash

set -e

INNGEST_CONFIG=".config/inngest/inngest.yaml"

# Start Telegram polling bot in background
echo "🤖 Starting Telegram polling bot..."
npx tsx src/bot.ts &
BOT_PID=$!
echo "✅ Bot started with PID: $BOT_PID"

# Try to store Inngest data in Postgres if it's available. Otherwise, put it in SQLite.
if [[ ! -f  "${INNGEST_CONFIG}" ]]; then
    mkdir -p "$(dirname "${INNGEST_CONFIG}")"
    if [[ -z "${DATABASE_URL}" ]]; then
        printf 'postgres-uri: "%s"' "${DATABASE_URL}" > "${INNGEST_CONFIG}"
    else
        printf 'sqlite-dir: "/home/runner/workspace/.local/share/inngest"' > "${INNGEST_CONFIG}"
    fi
fi
exec inngest-cli dev -u http://localhost:5000/api/inngest --host 127.0.0.1 --port 3000 --config "${INNGEST_CONFIG}"
