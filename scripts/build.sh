#!/usr/bin/env bash

set -e

export NODE_OPTIONS='--max-old-space-size=1536'

echo "📦 Building Mastra..."
mastra build

echo "📦 Building unified bot server..."
mkdir -p dist
npx esbuild src/server.ts --bundle --platform=node --outfile=dist/server.js --format=esm --target=node20 --packages=external

echo "✅ Build complete!"
