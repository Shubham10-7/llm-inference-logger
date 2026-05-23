require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const { InferenceLogger } = require('../sdk/logger');

const app = express();
const PORT = process.env.PORT || 3001;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-20250514';
const PROVIDER = 'anthropic';

const logger = new InferenceLogger({
  ingestionUrl: process.env.INGESTION_URL || 'http://localhost:4000',
  provider: PROVIDER,
  model: MODEL,
  flushInterval: 2000,
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── Conversation helpers ─────────────────────────────────────────────────────

async function getOrCreateConversation(conversationId, model) {
  if (conversationId) {
    const { rows } = await pool.query(
      'SELECT * FROM conversations WHERE id=$1 AND status != $2',
      [conversationId, 'cancelled']
    );
    if (rows[0]) return rows[0];
  }
  const id = uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO conversations (id, provider, model, status) VALUES ($1,$2,$3,'active') RETURNING *`,
    [id, PROVIDER, model || MODEL]
  );
  return rows[0];
}

async function getConversationMessages(conversationId) {
  const { rows } = await pool.query(
    `SELECT role, content FROM messages WHERE conversation_id=$1 ORDER BY sequence_number ASC`,
    [conversationId]
  );
  return rows;
}

async function saveMessage(conversationId, role, content, tokenCount) {
  const { rows: [{ max }] } = await pool.query(
    'SELECT MAX(sequence_number) as max FROM messages WHERE conversation_id=$1',
    [conversationId]
  );
  const seq = (max || 0) + 1;
  const { rows } = await pool.query(
    `INSERT INTO messages (id, conversation_id, role, content, token_count, sequence_number)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [uuidv4(), conversationId, role, content, tokenCount || null, seq]
  );
  // Auto-title after first user message
  if (seq === 1) {
    const title = content.slice(0, 60) + (content.length > 60 ? '…' : '');
    await pool.query('UPDATE conversations SET title=$1 WHERE id=$2', [title, conversationId]);
  }
  return rows[0].id;
}

// ── Routes ───────────────────────────────────────────────────────────────────

// List conversations
app.get('/conversations', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*,
        COUNT(m.id) AS message_count,
        MAX(m.created_at) AS last_message_at
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      GROUP BY c.id
      ORDER BY c.updated_at DESC
      LIMIT 50
    `);
    res.json({ conversations: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get single conversation with messages
app.get('/conversations/:id', async (req, res) => {
  try {
    const { rows: [conv] } = await pool.query(
      'SELECT * FROM conversations WHERE id=$1', [req.params.id]
    );
    if (!conv) return res.status(404).json({ error: 'Not found' });
    const messages = await getConversationMessages(req.params.id);
    res.json({ conversation: conv, messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cancel a conversation
app.post('/conversations/:id/cancel', async (req, res) => {
  try {
    const { rows: [conv] } = await pool.query(
      `UPDATE conversations SET status='cancelled', cancelled_at=NOW()
       WHERE id=$1 AND status='active' RETURNING *`,
      [req.params.id]
    );
    if (!conv) return res.status(404).json({ error: 'Not found or already cancelled' });

    // Publish cancel event
    await redis.publish('inference_events', JSON.stringify({
      eventType: 'conversation_cancelled',
      entityType: 'conversation',
      entityId: req.params.id,
      payload: {},
      ts: new Date().toISOString()
    }));

    res.json({ conversation: conv });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// New conversation
app.post('/conversations', async (req, res) => {
  try {
    const conv = await getOrCreateConversation(null, req.body.model);
    res.status(201).json({ conversation: conv });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send message — streaming
app.post('/chat', async (req, res) => {
  const { message, conversation_id } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  let conv;
  try {
    conv = await getOrCreateConversation(conversation_id, MODEL);
  } catch (e) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    return res.end();
  }

  // Check not cancelled
  if (conv.status === 'cancelled') {
    res.write(`event: error\ndata: ${JSON.stringify({ error: 'Conversation is cancelled' })}\n\n`);
    return res.end();
  }

  // Save user message
  const userMsgId = await saveMessage(conv.id, 'user', message);
  res.write(`event: start\ndata: ${JSON.stringify({ conversation_id: conv.id, message_id: userMsgId })}\n\n`);

  // Build context (keep last 10 turns)
  const history = await getConversationMessages(conv.id);
  const messages = history.slice(-20).map(m => ({ role: m.role, content: m.content }));

  let fullResponse = '';
  let aborted = false;

  req.on('close', () => { aborted = true; });

  const requestTs = new Date().toISOString();
  const startTime = Date.now();
  let firstTokenTime = null;
  let chunkCount = 0;

  try {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 1024,
      system: 'You are a helpful, concise assistant. Be direct and useful.',
      messages,
    });

    for await (const event of stream) {
      if (aborted) break;
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        if (firstTokenTime === null) firstTokenTime = Date.now() - startTime;
        const text = event.delta.text;
        fullResponse += text;
        chunkCount++;
        res.write(`event: chunk\ndata: ${JSON.stringify({ text })}\n\n`);
      }
    }

    const final = await stream.finalMessage();
    const responseTs = new Date().toISOString();
    const latency = Date.now() - startTime;

    // Save assistant message
    const asstMsgId = await saveMessage(conv.id, 'assistant', fullResponse, final.usage?.output_tokens);

    // Send log to ingestion service
    logger._send({
      conversation_id: conv.id,
      message_id: asstMsgId,
      provider: PROVIDER,
      model: MODEL,
      request_timestamp: requestTs,
      response_timestamp: responseTs,
      latency_ms: latency,
      time_to_first_token_ms: firstTokenTime,
      input_tokens: final.usage?.input_tokens,
      output_tokens: final.usage?.output_tokens,
      status: aborted ? 'cancelled' : 'success',
      input_preview: message.slice(0, 200),
      output_preview: fullResponse.slice(0, 200),
      is_streaming: true,
      stream_chunks: chunkCount,
      extra_metadata: { stop_reason: final.stop_reason },
    });

    res.write(`event: done\ndata: ${JSON.stringify({
      conversation_id: conv.id,
      message_id: asstMsgId,
      input_tokens: final.usage?.input_tokens,
      output_tokens: final.usage?.output_tokens,
      latency_ms: latency,
    })}\n\n`);

  } catch (e) {
    const responseTs = new Date().toISOString();
    logger._send({
      conversation_id: conv.id,
      provider: PROVIDER,
      model: MODEL,
      request_timestamp: requestTs,
      response_timestamp: responseTs,
      latency_ms: Date.now() - startTime,
      status: 'error',
      error_message: e.message,
      error_code: e.error?.type,
      http_status: e.status,
      is_streaming: true,
    });
    res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
  }

  res.end();
});

// Health
app.get('/health', async (req, res) => {
  res.json({ status: 'ok', model: MODEL, provider: PROVIDER });
});

app.listen(PORT, () => console.log(`Chatbot service on :${PORT}`));
