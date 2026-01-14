#!/usr/bin/env bash

set -e

echo "🚀 Starting production environment..."

export PORT="${PORT:-5000}"
echo "📡 Using PORT: $PORT"

echo "🤖 Starting Telegram polling bot..."
node dist/bot.js &
BOT_PID=$!
echo "✅ Bot started with PID: $BOT_PID"

echo "🌐 Starting Mastra API server..."
cd .mastra/output
exec node index.mjs
