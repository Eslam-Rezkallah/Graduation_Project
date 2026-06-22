#!/usr/bin/env bash
# Start all REM AI microservices for local development.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AI_DIR="$ROOT/ai-services"
VENV="$AI_DIR/.venv"

if [[ ! -d "$VENV" ]]; then
  echo "Creating Python venv and installing dependencies…"
  python3 -m venv "$VENV"
  source "$VENV/bin/activate"
  pip install --upgrade pip wheel
  pip install -r "$AI_DIR/requirements.txt"
else
  source "$VENV/bin/activate"
fi

if [[ -f "$ROOT/src/config/.env.dev" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/src/config/.env.dev"
  set +a
  export MONGO_URI="${DB_URI:-mongodb://localhost:27017}"
  export MONGO_DB="${MONGO_DB:-test}"
  export MONGO_COLLECTION="${MONGO_COLLECTION:-files}"
fi

start_one() {
  local name="$1" port="$2" module="$3"
  if lsof -i ":$port" -P -n >/dev/null 2>&1; then
    echo "✓ $name already listening on :$port"
    return
  fi
  echo "→ Starting $name on :$port"
  uvicorn "$module:app" --host 0.0.0.0 --port "$port" &
}

start_one "AI Screenshot" 8001 screenshot_analysis_api
start_one "AI Chat"       8002 chat_summarizer_api
start_one "AI Report"     8003 report_intelligence_api

echo ""
echo "Waiting for health checks…"
sleep 2
curl -sf "http://localhost:8001/healthz" >/dev/null && echo "✓ Screenshot :8001" || echo "✗ Screenshot :8001"
curl -sf "http://localhost:8002/healthz" >/dev/null && echo "✓ Chat       :8002" || echo "✗ Chat       :8002"
curl -sf "http://localhost:8003/healthz" >/dev/null && echo "✓ Report     :8003" || echo "✗ Report     :8003"
echo ""
echo "Restart the Node backend (npm run dev) if you changed .env.dev."
echo "Verify all services: curl http://localhost:3000/ai/healthz"
