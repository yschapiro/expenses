#!/usr/bin/env bash
# Builds the click-through demo (no server; data stays in the browser):  dist/demo/
# The real site (Cloudflare) needs no build: it serves site/public directly (see cloudflare/README.md).
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist/demo
cp -R site/public/. dist/demo/
echo "window.ORDER_SITE = { demo: true };" > dist/demo/js/config.js
echo "Built dist/demo"
