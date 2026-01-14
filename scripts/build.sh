#!/usr/bin/env bash

set -e

export NODE_OPTIONS='--max-old-space-size=1536'

echo "📦 Building Mastra..."
mastra build

echo "📦 Building Telegram bot (bundled with dependencies)..."
mkdir -p dist
npx esbuild src/bot.ts --bundle --platform=node --outfile=dist/bot.js --format=esm --target=node20 --packages=external

echo "✅ Build complete!"
