#!/usr/bin/env bash
# Starts the AI service and the web server.
cd "$(dirname "$0")"
[ -d backend/node_modules ] || (cd backend && npm install)
(cd ai-service && python3 app.py) &
(cd backend && npm start) &
wait
