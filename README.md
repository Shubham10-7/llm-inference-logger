# LLM Inference Logger

A production-grade inference logging and ingestion system for LLM applications. Multi-turn chatbot with streaming, real-time metrics dashboard, PII redaction, and a full observability pipeline.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                               │
│  ┌──────────────┐      ┌───────────────────────────────────┐ │
│  │   Sidebar    │      │  Chat (SSE streaming)             │ │
│  │ Conversations│      │  Dashboard (metrics, live events) │ │
│  └──────────────┘      └───────────────────────────────────┘ │
└───────────────────┬─────────────────────┬───────────────────┘
                    │ REST/SSE            │ REST/SSE
         ┌──────────▼──────────┐ ┌───────▼──────────────────┐
         │   Chatbot Service   │ │   Ingestion Service      │
         │   (Node/Express)    │ │   (Node/Express)         │
         │   :3001             │ │   :4000                  │
         │                     │ │                          │
         │  - Conversation mgmt│ │  - Zod validation        │
         │  - Claude streaming │ │  - PII redaction         │
         │  - SDK wrapper      │ │  - Cost estimation       │
         │  - Per-call logging │ │  - Event emission        │
         └──────┬──────────────┘ └───────┬──────────────────┘
                │                        │
         ┌──────▼────────────────────────▼──────────────────┐
         │              PostgreSQL 16                        │
         │  conversations · messages · inference_logs        │
         │  events (event-sourcing log)                      │
         └───────────────────────────────────────────────────┘
                        │
         ┌──────────────▼──────────────────────────────────┐
         │              Redis 7                             │
         │  Pub/Sub: inference_events channel               │
         │  Cache: per-model stats (TTL 5m)                 │
         └──────────────────────────────────────────────────┘
```

### Ingestion Flow

1. **Chatbot** receives user message → saves to `messages` table
2. **SDK wrapper** fires SSE stream from Anthropic Claude
3. Stream chunks forwarded to browser in real time via SSE
4. On stream complete: SDK sends log payload to `/ingest`
5. **Ingestion service** validates (Zod), redacts PII, estimates cost, persists to `inference_logs`
6. Emits event to `events` table AND Redis pub/sub channel
7. Dashboard SSE clients receive live event via Redis → updates in real time

## Features

- **Streaming responses** — Claude streams tokens to browser via SSE
- **Multi-turn conversations** — full history maintained, last 20 messages sent as context
- **Conversation management** — list, resume, cancel conversations
- **PII redaction** — email, phone, SSN, credit card, API keys stripped from previews before storage
- **Real-time dashboard** — throughput, latency (avg/p95/p99), error rate, cost, per-model breakdown
- **Live events feed** — SSE stream from Redis pub/sub
- **Event sourcing** — every state change appended to `events` table
- **Cost estimation** — per-model pricing table, stored in microdollars
- **Docker Compose** — one command setup
- **Kubernetes manifests** — HPA, liveness/readiness probes, secrets

## Setup

### Prerequisites
- Docker + Docker Compose
- An Anthropic API key

### One-Command Start

```bash
git clone <repo>
cd llm-inference-logger
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY=sk-ant-...
docker compose up --build
```

- Frontend: http://localhost:3000
- Chatbot API: http://localhost:3001
- Ingestion API: http://localhost:4000
- Metrics: http://localhost:4000/metrics

### Local Dev (no Docker)

```bash
# Terminal 1: Postgres + Redis
docker compose up postgres redis

# Terminal 2: Ingestion
cd backend/ingestion
DATABASE_URL=postgresql://admin:secret@localhost:5432/inference_logs \
REDIS_URL=redis://localhost:6379 \
node index.js

# Terminal 3: Chatbot
cd backend/chatbot
ANTHROPIC_API_KEY=sk-ant-... \
DATABASE_URL=postgresql://admin:secret@localhost:5432/inference_logs \
REDIS_URL=redis://localhost:6379 \
INGESTION_URL=http://localhost:4000 \
node index.js

# Terminal 4: Frontend
cd frontend
VITE_CHATBOT_URL=http://localhost:3001 \
VITE_INGESTION_URL=http://localhost:4000 \
npm run dev
```

## Schema Design

### `conversations`
Tracks session state. `status` enum (`active | cancelled | completed`) drives UI behavior. `title` auto-populated from first message slice.

### `messages`
Append-only, ordered by `sequence_number`. `content_preview` is a generated column (first 200 chars) for quick listing without loading full content.

### `inference_logs`
One row per LLM API call. Nullable FKs to `conversations` and `messages` so logs survive conversation deletion. `estimated_cost_usd` stored as `NUMERIC(10,6)` — sufficient for sub-cent granularity. `input_preview` / `output_preview` are PII-redacted at write time.

### `events`
Event-sourcing audit log. Every state mutation (inference_logged, conversation_cancelled) appended here. Enables replay and audit without modifying primary tables.

### Key Tradeoffs

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Streaming logs | Fire-and-forget after stream | Queue + worker | Lower ops overhead; acceptable for moderate throughput |
| PII redaction | Regex at ingest | ML model | Fast, predictable, zero latency cost |
| Cost storage | NUMERIC(10,6) | Separate pricing table | Denormalized for query speed; pricing rarely changes |
| Dashboard refresh | 15s polling + SSE for events | Full SSE | SSE for events, polling for aggregates (cheaper query) |
| Materialized view | Created, refresh manual | Cron refresh | Needs `pg_cron` extension in prod for auto-refresh |
| Event bus | Redis pub/sub | Kafka / NATS | Zero extra infra; Kafka for >10k events/sec |

## API Reference

### Chatbot (`:3001`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/conversations` | List all conversations |
| POST | `/conversations` | Create new conversation |
| GET | `/conversations/:id` | Get conversation + messages |
| POST | `/conversations/:id/cancel` | Cancel a conversation |
| POST | `/chat` | Send message (SSE stream) |

### Ingestion (`:4000`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/ingest` | Log a single inference call |
| POST | `/ingest/batch` | Batch ingest (max 100) |
| GET | `/metrics?hours=24` | Aggregated metrics |
| GET | `/logs?limit=50` | Recent inference logs |
| GET | `/events/stream` | SSE live event stream |

## What I'd Improve With More Time

1. **Authentication** — JWT/session auth for multi-user support
2. **pg_cron** — auto-refresh the `dashboard_metrics` materialized view every minute
3. **OpenTelemetry** — export traces/metrics to Grafana/Jaeger instead of custom dashboard
4. **Multi-provider SDK** — abstract OpenAI, Gemini, DeepSeek behind common interface
5. **Proper message queue** — replace Redis pub/sub with NATS JetStream or Kafka for durability
6. **Token budget alerts** — configurable thresholds with webhook notifications
7. **Conversation search** — full-text search over messages with pgvector for semantic search
8. **Rate limiting** — per-IP / per-user limits with Redis sliding window
9. **Retry logic** — exponential backoff in SDK when ingestion endpoint is down
10. **Test coverage** — unit tests for PII redaction, cost estimation, validation schemas

## Kubernetes Deployment

```bash
kubectl apply -f k8s/namespace.yaml

# Create secrets
kubectl create secret generic pg-secret \
  --from-literal=password=secret -n llm-logger
kubectl create secret generic app-secrets \
  --from-literal=database-url=postgresql://admin:secret@postgres:5432/inference_logs \
  --from-literal=redis-url=redis://redis:6379 \
  -n llm-logger

kubectl apply -f k8s/
```

The ingestion deployment includes an HPA that scales 2→10 replicas at 70% CPU.

## Scaling Considerations

- **Ingestion service** is stateless — scale horizontally behind a load balancer
- **Redis pub/sub** works across multiple ingestion instances; all subscribers receive events
- **PostgreSQL** — add read replicas for dashboard queries; primary for writes only
- **Connection pooling** — add PgBouncer in front of Postgres at scale
- **Buffer in SDK** — if ingestion is down, SDK buffers up to 500 logs in memory and retries on next flush cycle
