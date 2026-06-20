#!/usr/bin/env bash
# Start the Little Slate House website preview server.
# Builds the site and serves it on port 4321, accessible via Tailscale.
# Run once after reboot; the process stays in the background.
#
# Usage:  ./start-preview.sh
# Stop:   kill $(lsof -ti :4321)

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST="$SCRIPT_DIR/dist"

export PATH="/opt/homebrew/bin:$PATH"

echo "Building site…"
cd "$SCRIPT_DIR"
npm run build

echo "Starting preview server on port 4321…"
nohup serve -l 4321 "$DIST" > /tmp/little-slate-house-preview.log 2>&1 &
echo "Preview server PID: $!"
echo "Preview URL (tailnet): https://gs-mac-mini.tail54a913.ts.net/"
echo "Log: /tmp/little-slate-house-preview.log"
