#!/usr/bin/env bash
# Builds the ready-to-upload folders from the shared site.
#   dist/demo/            – click-through demo (no server; data stays in the browser)
#   dist/godaddy/orders/  – upload this folder into public_html on GoDaddy  (+ dist/godaddy-orders.zip)
# The Cloudflare version needs no build: it serves site/public directly (see cloudflare/README.md).
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist/demo dist/godaddy/orders

cp -R site/public/. dist/demo/
echo "window.ORDER_SITE = { demo: true };" > dist/demo/js/config.js

if [ -f godaddy/api.php ]; then
  cp -R site/public/. dist/godaddy/orders/
  rm -f dist/godaddy/orders/js/demo.js
  echo "window.ORDER_SITE = { api: 'api.php?r=' };" > dist/godaddy/orders/js/config.js
  rsync -a --exclude tests --exclude 'data/*.sqlite' --exclude config.php --exclude .gitignore godaddy/ dist/godaddy/orders/
  (cd dist/godaddy && zip -qr ../godaddy-orders.zip orders)
  echo "Built dist/godaddy-orders.zip"
fi
echo "Built dist/demo"
