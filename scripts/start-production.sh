#!/usr/bin/env bash

set -e

echo "🚀 Starting production environment..."

export NODE_ENV=production
export PORT="${PORT:-5000}"

echo "🤖 Starting unified bot server on port ${PORT}..."
exec npx tsx src/server.ts
