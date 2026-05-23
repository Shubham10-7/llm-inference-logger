#!/bin/bash
echo "🔍 Checking services..."

check() {
  local name=$1 url=$2
  if curl -sf "$url" > /dev/null 2>&1; then
    echo "  ✅ $name — $url"
  else
    echo "  ❌ $name — $url (not reachable)"
  fi
}

check "Frontend"  "http://localhost:3000"
check "Chatbot"   "http://localhost:3001/health"
check "Ingestion" "http://localhost:4000/health"
echo ""
echo "📊 Metrics: http://localhost:4000/metrics"
echo "💬 App:     http://localhost:3000"
