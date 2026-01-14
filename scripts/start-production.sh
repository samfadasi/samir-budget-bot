#!/usr/bin/env bash

set -e

echo "🚀 Starting production environment..."

echo "🤖 Starting minimal polling bot..."
exec node index.js
