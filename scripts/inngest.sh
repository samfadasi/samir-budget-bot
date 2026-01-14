#!/usr/bin/env bash

set -e

echo "🤖 Starting unified bot server (dev mode)..."
export PORT=3000
exec npx tsx src/server.ts
