#!/usr/bin/env bash

set -e

echo "🚀 Starting production environment..."

BOT_PORT="${PORT:-5000}"
MASTRA_PORT=5001

echo "🤖 Starting unified bot server on port ${BOT_PORT}..."
PORT="${BOT_PORT}" NODE_ENV=production node dist/server.js &
BOT_PID=$!
echo "✅ Bot server started with PID: $BOT_PID"

sleep 2

echo "🌐 Starting Mastra API server on port ${MASTRA_PORT}..."
cd .mastra/output
PORT="${MASTRA_PORT}" exec node index.mjs
