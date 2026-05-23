require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 4000;

// DB + Redis
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));

// ── PII Redaction ────────────────────────────────────────────────────────────
const PII_PATTERNS = [
  { name: 'email', re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replace: '[EMAIL]' },
  { name: 'phone', re: /(\+?\d[\s.-]?)?(\(?\d{3}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}/g, replace: '[PHONE]' },
  { name: 'ssn',   re: /\b\d{3}-\d{2}-\d{4}\b/g, replace: '[SSN]' },
  { name: 'card',  re: /\b(?:\d[ -]?){13,16}\b/g, replace: '[CARD]' },
  { name: 'apikey',re: /\b(sk-|pk-|api-)[A-Za-z0-9_-]{20,}/g, replace: '[API_KEY]' },
];

function redactPII(text) {
  if (!text) return text;
  let result = text;
  for (const p of PII_PATTERNS) {
    result = result.replace(p.re, p.replace);
  }
  return result;
}

// ── Validation Schema ────────────────────────────────────────────────────────
const InferenceLogSchema = z.object({
  conversation_id: z.string().uuid().optional(),
  message_id: z.string().uuid().optional(),
  provider: z.string().min(1).max(50),
  model: z.string().min(1).max(100),
  request_timestamp: z.string().datetime(),
  response_timestamp: z.string().datetime().optional(),
  latency_ms: z.number().int().nonnegative().optional(),
  time_to_first_token_ms: z.number().int().nonnegative().optional(),
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
  status: z.enum(['success', 'error', 'cancelled', 'timeout']).default('success'),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
  http_status: z.number().int().optional(),
  input_preview: z.string().optional(),
  output_preview: z.string().optional(),
  is_streaming: z.boolean().default(false),
  stream_chunks: z.number().int().nonnegative().optional(),
  extra_metadata: z.record(z.unknown()).optional(),
});

// ── Cost Estimation ──────────────────────────────────────────────────────────
const PRICING = {
  'anthropic:claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },   // per 1M tokens
  'anthropic:claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
  'anthropic:claude-opus-4-20250514': { input: 15.0, output: 75.0 },
  'openai:gpt-4.1': { input: 2.0, output: 8.0 },
  'openai:gpt-4o': { input: 2.5, output: 10.0 },
  'google:gemini-2.0-flash': { input: 0.1, output: 0.4 },
};

function estimateCost(provider, model, inputTokens, outputTokens) {
  const key = `${provider}:${model}`;
  const pricing = PRICING[key] || { input: 1.0, output: 3.0 };
  return ((inputTokens || 0) * pricing.input + (outputTokens || 0) * pricing.output) / 1_000_000;
}

// ── Event emission ───────────────────────────────────────────────────────────
async function emitEvent(client, eventType, entityType, entityId, payload) {
  await client.query(
    `INSERT INTO events (event_type, entity_type, entity_id, payload) VALUES ($1,$2,$3,$4)`,
    [eventType, entityType, entityId, JSON.stringify(payload)]
  );
  // Publish to Redis pub/sub for real-time consumers
  await redis.publish('inference_events', JSON.stringify({ eventType, entityType, entityId, payload, ts: new Date().toISOString() }));
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Health
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.json({ status: 'ok', ts: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'degraded', error: e.message });
  }
});

// Ingest a single log
app.post('/ingest', async (req, res) => {
  const parse = InferenceLogSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: 'Validation failed', details: parse.error.flatten() });
  }

  const data = parse.data;
  const logId = uuidv4();

  // Redact PII from previews
  const inputPreview = redactPII(data.input_preview);
  const outputPreview = redactPII(data.output_preview);

  // Estimate cost
  const cost = estimateCost(data.provider, data.model, data.input_tokens, data.output_tokens);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO inference_logs (
        id, conversation_id, message_id, provider, model,
        request_timestamp, response_timestamp, latency_ms, time_to_first_token_ms,
        input_tokens, output_tokens, total_tokens, estimated_cost_usd,
        status, error_code, error_message, http_status,
        input_preview, output_preview,
        is_streaming, stream_chunks, extra_metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        logId, data.conversation_id || null, data.message_id || null,
        data.provider, data.model,
        data.request_timestamp, data.response_timestamp || null,
        data.latency_ms || null, data.time_to_first_token_ms || null,
        data.input_tokens || null, data.output_tokens || null,
        (data.input_tokens || 0) + (data.output_tokens || 0),
        cost,
        data.status, data.error_code || null, data.error_message || null, data.http_status || null,
        inputPreview, outputPreview,
        data.is_streaming, data.stream_chunks || null,
        JSON.stringify(data.extra_metadata || {})
      ]
    );

    await emitEvent(client, 'inference_logged', 'inference_log', logId, {
      provider: data.provider, model: data.model, status: data.status,
      latency_ms: data.latency_ms, total_tokens: data.total_tokens
    });

    await client.query('COMMIT');

    // Cache recent stats in Redis (TTL 60s)
    const statsKey = `stats:${data.provider}:${data.model}`;
    await redis.hincrby(statsKey, 'total', 1);
    if (data.status === 'error') await redis.hincrby(statsKey, 'errors', 1);
    if (data.latency_ms) await redis.hset(statsKey, 'last_latency', data.latency_ms);
    await redis.expire(statsKey, 300);

    res.status(201).json({ id: logId, cost_usd: cost });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Ingest error:', e);
    res.status(500).json({ error: 'Failed to store log' });
  } finally {
    client.release();
  }
});

// Batch ingest
app.post('/ingest/batch', async (req, res) => {
  const { logs } = req.body;
  if (!Array.isArray(logs) || logs.length === 0) {
    return res.status(400).json({ error: 'logs must be a non-empty array' });
  }
  if (logs.length > 100) {
    return res.status(400).json({ error: 'Batch size limit is 100' });
  }

  const results = [];
  for (const log of logs) {
    try {
      const r = await fetch(`http://localhost:${PORT}/ingest`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(log)
      });
      results.push({ ok: r.ok, status: r.status });
    } catch (e) {
      results.push({ ok: false, error: e.message });
    }
  }
  res.json({ processed: results.length, results });
});

// Dashboard metrics
app.get('/metrics', async (req, res) => {
  const { hours = 24, provider, model } = req.query;
  try {
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

    const [overview, byHour, byModel, errorBreakdown] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status='success') AS successful,
          COUNT(*) FILTER (WHERE status='error') AS errors,
          ROUND(AVG(latency_ms) FILTER (WHERE status='success'))::int AS avg_latency_ms,
          ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status='success'))::int AS p95_latency_ms,
          SUM(total_tokens) AS total_tokens,
          ROUND(SUM(estimated_cost_usd)::numeric, 4) AS total_cost_usd,
          ROUND(COUNT(*) FILTER (WHERE status='error') * 100.0 / NULLIF(COUNT(*),0), 2) AS error_rate_pct
        FROM inference_logs
        WHERE created_at >= $1
        ${provider ? "AND provider=$2" : ""}
      `, provider ? [since, provider] : [since]),

      pool.query(`
        SELECT
          DATE_TRUNC('hour', created_at) AS hour,
          COUNT(*) AS requests,
          COUNT(*) FILTER (WHERE status='error') AS errors,
          ROUND(AVG(latency_ms) FILTER (WHERE status='success'))::int AS avg_latency_ms,
          SUM(total_tokens) AS tokens
        FROM inference_logs
        WHERE created_at >= $1
        GROUP BY DATE_TRUNC('hour', created_at)
        ORDER BY hour ASC
      `, [since]),

      pool.query(`
        SELECT provider, model,
          COUNT(*) AS requests,
          ROUND(AVG(latency_ms))::int AS avg_latency_ms,
          SUM(total_tokens) AS total_tokens,
          ROUND(SUM(estimated_cost_usd)::numeric, 4) AS cost_usd
        FROM inference_logs
        WHERE created_at >= $1
        GROUP BY provider, model
        ORDER BY requests DESC
      `, [since]),

      pool.query(`
        SELECT error_code, COUNT(*) AS count
        FROM inference_logs
        WHERE status='error' AND created_at >= $1
        GROUP BY error_code
        ORDER BY count DESC
        LIMIT 10
      `, [since]),
    ]);

    res.json({
      overview: overview.rows[0],
      by_hour: byHour.rows,
      by_model: byModel.rows,
      error_breakdown: errorBreakdown.rows,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Recent logs
app.get('/logs', async (req, res) => {
  const { limit = 50, offset = 0, conversation_id, status, provider } = req.query;
  try {
    let where = [];
    let params = [];
    if (conversation_id) { params.push(conversation_id); where.push(`conversation_id=$${params.length}`); }
    if (status) { params.push(status); where.push(`status=$${params.length}`); }
    if (provider) { params.push(provider); where.push(`provider=$${params.length}`); }
    
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Math.min(parseInt(limit), 200), parseInt(offset));
    
    const { rows } = await pool.query(
      `SELECT * FROM inference_logs ${whereClause} ORDER BY created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    res.json({ logs: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SSE endpoint for real-time events
app.get('/events/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const sub = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  sub.subscribe('inference_events');

  sub.on('message', (channel, message) => {
    res.write(`data: ${message}\n\n`);
  });

  // Keepalive
  const ka = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(ka);
    sub.quit();
  });
});

app.listen(PORT, () => console.log(`Ingestion service on :${PORT}`));
