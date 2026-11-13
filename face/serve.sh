#!/bin/sh
# Serves this site locally via the Vercel dev server, which runs the /api/*
# serverless functions too (auth, uploads, admin, notifications) alongside the
# static files, so this is the one URL for all local testing.
# Always on the same port. Open http://face.localhost:8791.
#
# Node version matters here: this machine's default Node (24.x) breaks
# vercel dev's internal request forwarding (every /api/* call fails with
# "TypeError: fetch failed" before any handler code runs), while Node 20 is
# too old for @supabase/supabase-js's realtime client (needs native
# WebSocket, Node 22+). Node 22 is the one that works with both -- see
# .nvmrc.
PORT=8791
pkill -f "vercel dev" 2>/dev/null
cd "$(dirname "$0")"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
  nvm use 22 >/dev/null
fi
exec vercel dev --listen "$PORT" --yes
