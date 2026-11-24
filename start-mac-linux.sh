#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js نسخه ۱۸ یا بالاتر نصب نیست."
  exit 1
fi
if [ ! -d node_modules/socket.io ] || [ ! -d node_modules/pg ]; then
  npm install
fi
npm start
