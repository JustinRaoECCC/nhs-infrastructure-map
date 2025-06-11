#!/usr/bin/env bash
set -e

# 1) Ensure Node.js & npm are installed
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js not found. Please install from https://nodejs.org/"
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "✗ npm not found. Please reinstall Node.js (it includes npm)."
  exit 1
fi

# 2) Install JS dependencies
echo "→ Installing dependencies…"
npm install

# 3) Prepare data folder for ExcelJS
echo "→ Creating data directory…"
mkdir -p data

echo "✔ Setup complete!"
echo "→ Run the app with: npm start"